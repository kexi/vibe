//! Progress UI seam, rendered to stderr only.
//!
//! Ported from `packages/core/src/utils/progress.ts` (the `ProgressTracker`
//! class). The TS rendered a live spinner tree; here the seam is a
//! [`ProgressTracker`] trait so the live UI ([`IndicatifTracker`], stderr only)
//! is swappable for a [`NullTracker`] (quiet / non-TTY / Claude-hook / unit
//! tests) and a [`RecordingTracker`] (asserts the event sequence).
//!
//! The terminal glyphs are produced by the pure [`render_line`] so the
//! success / failure / abandoned renderings can be asserted without a tty: the
//! three outcomes must stay visually distinct (the TS `TreeFormatter` used
//! `☒` for success and a red `✗` for failure; rendering all three as `☒` made a
//! failed copy indistinguishable from a successful one).
//!
//! SECURITY/contract: the live renderer draws to `ProgressDrawTarget::stderr()`
//! so stdout stays clean for the eval'd `cd` line.

use crate::ansi::{colorize, DIM, RED};

/// Opaque handle to a phase or task node.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NodeId(pub usize);

/// A hierarchical progress reporter: phases contain tasks.
pub trait ProgressTracker {
    /// Add a top-level phase, returning its id.
    fn add_phase(&self, label: &str) -> NodeId;
    /// Add a task under `phase`, returning its id.
    fn add_task(&self, phase: NodeId, label: &str) -> NodeId;
    /// Mark a task running.
    fn start_task(&self, id: NodeId);
    /// Mark a task completed.
    fn complete_task(&self, id: NodeId);
    /// Mark a task failed with an error message.
    fn fail_task(&self, id: NodeId, err: &str);
    /// Begin rendering (no-op for non-live trackers).
    fn start(&self);
    /// Finish rendering and restore the terminal (no-op for non-live trackers).
    fn finish(&self);
}

/// Forward through a reference so `&dyn ProgressTracker` satisfies
/// `impl ProgressTracker` (lets generic copy helpers take the `&dyn` seam).
impl<T: ProgressTracker + ?Sized> ProgressTracker for &T {
    fn add_phase(&self, label: &str) -> NodeId {
        (**self).add_phase(label)
    }
    fn add_task(&self, phase: NodeId, label: &str) -> NodeId {
        (**self).add_task(phase, label)
    }
    fn start_task(&self, id: NodeId) {
        (**self).start_task(id)
    }
    fn complete_task(&self, id: NodeId) {
        (**self).complete_task(id)
    }
    fn fail_task(&self, id: NodeId, err: &str) {
        (**self).fail_task(id, err)
    }
    fn start(&self) {
        (**self).start()
    }
    fn finish(&self) {
        (**self).finish()
    }
}

/// A no-op tracker: records nothing, renders nothing. Used in quiet / non-TTY /
/// Claude-hook modes and in unit tests that don't assert on progress.
pub struct NullTracker;

impl ProgressTracker for NullTracker {
    fn add_phase(&self, _label: &str) -> NodeId {
        NodeId(0)
    }
    fn add_task(&self, _phase: NodeId, _label: &str) -> NodeId {
        NodeId(0)
    }
    fn start_task(&self, _id: NodeId) {}
    fn complete_task(&self, _id: NodeId) {}
    fn fail_task(&self, _id: NodeId, _err: &str) {}
    fn start(&self) {}
    fn finish(&self) {}
}

/// How a node's line is rendered once it stops spinning.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome {
    /// Ran to completion — `☒`.
    Completed,
    /// Errored — a red `✗`, plus the error in parentheses.
    Failed,
    /// Still pending when the run ended — a dim `☐`.
    Abandoned,
}

impl TaskOutcome {
    fn glyph(self) -> &'static str {
        match self {
            TaskOutcome::Completed => "☒",
            TaskOutcome::Failed => "✗",
            TaskOutcome::Abandoned => "☐",
        }
    }
}

/// Render the final line of a progress node.
///
/// Pure so glyph regressions are caught by a unit test; the live renderer only
/// hands the result to `indicatif`. `error` is rendered only for
/// [`TaskOutcome::Failed`], for which it is always present in practice.
pub fn render_line(
    outcome: TaskOutcome,
    prefix: &str,
    label: &str,
    error: Option<&str>,
    color: bool,
) -> String {
    let body = match (outcome, error) {
        (TaskOutcome::Failed, Some(err)) => format!("{} {label} (failed: {err})", outcome.glyph()),
        _ => format!("{} {label}", outcome.glyph()),
    };
    let painted = match outcome {
        TaskOutcome::Completed => body,
        TaskOutcome::Failed => colorize(RED, &body, color),
        TaskOutcome::Abandoned => colorize(DIM, &body, color),
    };
    format!("{prefix}{painted}")
}

/// Live progress tracker backed by `indicatif`, drawing to STDERR only.
pub struct IndicatifTracker {
    multi: indicatif::MultiProgress,
    bars: std::sync::Mutex<Vec<BarNode>>,
    color: bool,
}

struct BarNode {
    bar: indicatif::ProgressBar,
    prefix: String,
    label: String,
    done: bool,
}

impl Default for IndicatifTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl IndicatifTracker {
    /// Create a tracker drawing to stderr (keeps stdout clean for the `cd` line).
    ///
    /// Colors the failure/abandoned glyphs; the live tracker is only ever built
    /// for an interactive stderr, but callers that have already resolved
    /// `NO_COLOR`/`FORCE_COLOR` should use [`IndicatifTracker::with_color`].
    pub fn new() -> Self {
        Self::with_color(true)
    }

    /// Same, with the caller's resolved [`crate::ansi::is_color_enabled`] value.
    pub fn with_color(color: bool) -> Self {
        let multi =
            indicatif::MultiProgress::with_draw_target(indicatif::ProgressDrawTarget::stderr());
        IndicatifTracker {
            multi,
            bars: std::sync::Mutex::new(Vec::new()),
            color,
        }
    }

    fn push_bar(&self, label: &str, prefix: &str) -> NodeId {
        let bar = self.multi.add(indicatif::ProgressBar::new_spinner());
        let style = indicatif::ProgressStyle::with_template("{prefix}{spinner} {msg}")
            .expect("static progress template must be valid")
            .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
        bar.set_style(style);
        bar.set_prefix(prefix.to_string());
        bar.set_message(label.to_string());
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        let id = NodeId(bars.len());
        bars.push(BarNode {
            bar,
            prefix: prefix.to_string(),
            label: label.to_string(),
            done: false,
        });
        id
    }

    fn with_bar(&self, id: NodeId, f: impl FnOnce(&mut BarNode)) {
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        if let Some(node) = bars.get_mut(id.0) {
            f(node);
        }
    }
}

impl ProgressTracker for IndicatifTracker {
    fn add_phase(&self, label: &str) -> NodeId {
        self.push_bar(label, "┗ ")
    }
    fn add_task(&self, _phase: NodeId, label: &str) -> NodeId {
        self.push_bar(label, "   ┗ ")
    }
    fn start_task(&self, id: NodeId) {
        self.with_bar(id, |node| {
            node.bar
                .enable_steady_tick(std::time::Duration::from_millis(80))
        });
    }
    fn complete_task(&self, id: NodeId) {
        let color = self.color;
        self.with_bar(id, |node| {
            node.done = true;
            node.bar.set_prefix("");
            node.bar.finish_with_message(render_line(
                TaskOutcome::Completed,
                &node.prefix,
                &node.label,
                None,
                color,
            ));
        });
    }
    fn fail_task(&self, id: NodeId, err: &str) {
        let color = self.color;
        self.with_bar(id, |node| {
            node.done = true;
            node.bar.set_prefix("");
            node.bar.abandon_with_message(render_line(
                TaskOutcome::Failed,
                &node.prefix,
                &node.label,
                Some(err),
                color,
            ));
        });
    }
    fn start(&self) {}
    fn finish(&self) {
        let color = self.color;
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        for node in bars.iter_mut() {
            let is_unfinished = !node.done;
            if is_unfinished {
                node.done = true;
                node.bar.set_prefix("");
                // Why not finish these as completed: a node still pending when
                // the run ends never succeeded, and painting it `☒` is exactly
                // the ambiguity this rendering is meant to remove.
                node.bar.abandon_with_message(render_line(
                    TaskOutcome::Abandoned,
                    &node.prefix,
                    &node.label,
                    None,
                    color,
                ));
            }
        }
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use recording::{RecordingTracker, TrackerEvent};

#[cfg(any(test, feature = "test-util"))]
mod recording {
    use super::{NodeId, ProgressTracker};
    use std::sync::Mutex;

    /// A single observable progress event (for assertions on ordering).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum TrackerEvent {
        Phase(String),
        Task(String),
        Start(NodeId),
        Complete(NodeId),
        Fail(NodeId, String),
        Started,
        Finished,
    }

    /// Records the full event sequence so tests can assert the protocol.
    ///
    /// Uses `Mutex` (not `RefCell`) so it is `Sync` — `start`/`scratch` thread it
    /// through `StartDeps` whose tracker field is `+ Sync` (copy_directories fans
    /// it across worker threads).
    #[derive(Default)]
    pub struct RecordingTracker {
        events: Mutex<Vec<TrackerEvent>>,
        next: Mutex<usize>,
    }

    impl RecordingTracker {
        pub fn new() -> Self {
            RecordingTracker::default()
        }

        /// A snapshot of recorded events (clone, so the lock is not held).
        pub fn events(&self) -> Vec<TrackerEvent> {
            self.events.lock().unwrap().clone()
        }

        fn push(&self, e: TrackerEvent) {
            self.events.lock().unwrap().push(e);
        }

        fn fresh_id(&self) -> NodeId {
            let mut n = self.next.lock().unwrap();
            let id = NodeId(*n);
            *n += 1;
            id
        }
    }

    impl ProgressTracker for RecordingTracker {
        fn add_phase(&self, label: &str) -> NodeId {
            self.push(TrackerEvent::Phase(label.to_string()));
            self.fresh_id()
        }
        fn add_task(&self, _phase: NodeId, label: &str) -> NodeId {
            self.push(TrackerEvent::Task(label.to_string()));
            self.fresh_id()
        }
        fn start_task(&self, id: NodeId) {
            self.push(TrackerEvent::Start(id));
        }
        fn complete_task(&self, id: NodeId) {
            self.push(TrackerEvent::Complete(id));
        }
        fn fail_task(&self, id: NodeId, err: &str) {
            self.push(TrackerEvent::Fail(id, err.to_string()));
        }
        fn start(&self) {
            self.push(TrackerEvent::Started);
        }
        fn finish(&self) {
            self.push(TrackerEvent::Finished);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ansi::RESET;

    #[test]
    fn null_tracker_is_a_noop() {
        let t = NullTracker;
        let phase = t.add_phase("p");
        let task = t.add_task(phase, "t");
        t.start();
        t.start_task(task);
        t.complete_task(task);
        t.fail_task(task, "x");
        t.finish();
        // No panic, no state — the point is it does nothing.
    }

    #[test]
    fn recording_tracker_captures_event_order() {
        let t = RecordingTracker::new();
        t.start();
        let phase = t.add_phase("Pre-start hooks");
        let task = t.add_task(phase, "echo hi");
        t.start_task(task);
        t.complete_task(task);
        t.finish();

        let events = t.events();
        assert_eq!(
            events,
            vec![
                TrackerEvent::Started,
                TrackerEvent::Phase("Pre-start hooks".into()),
                TrackerEvent::Task("echo hi".into()),
                TrackerEvent::Start(task),
                TrackerEvent::Complete(task),
                TrackerEvent::Finished,
            ]
        );
    }

    #[test]
    fn success_failure_and_abandon_render_distinct_glyphs() {
        let done = render_line(TaskOutcome::Completed, "   ┗ ", "npm install", None, false);
        let failed = render_line(
            TaskOutcome::Failed,
            "   ┗ ",
            "npm install",
            Some("Exit code 1"),
            false,
        );
        let abandoned = render_line(TaskOutcome::Abandoned, "   ┗ ", "npm install", None, false);

        assert_eq!(done, "   ┗ ☒ npm install");
        assert_eq!(failed, "   ┗ ✗ npm install (failed: Exit code 1)");
        assert_eq!(abandoned, "   ┗ ☐ npm install");
        assert_ne!(done, failed);
        assert_ne!(done, abandoned);
        assert_ne!(failed, abandoned);
    }

    #[test]
    fn failure_is_red_and_abandon_is_dim_when_color_is_enabled() {
        assert_eq!(
            render_line(TaskOutcome::Failed, "┗ ", "copy", Some("denied"), true),
            format!("┗ {RED}✗ copy (failed: denied){RESET}")
        );
        assert_eq!(
            render_line(TaskOutcome::Abandoned, "┗ ", "copy", None, true),
            format!("┗ {DIM}☐ copy{RESET}")
        );
    }

    #[test]
    fn success_is_never_colored() {
        assert_eq!(
            render_line(TaskOutcome::Completed, "┗ ", "copy", None, true),
            "┗ ☒ copy"
        );
    }

    #[test]
    fn color_is_suppressed_when_disabled() {
        for outcome in [
            TaskOutcome::Completed,
            TaskOutcome::Failed,
            TaskOutcome::Abandoned,
        ] {
            let line = render_line(outcome, "┗ ", "copy", Some("boom"), false);
            assert!(!line.contains('\x1b'), "unexpected escape in {line:?}");
        }
    }

    #[test]
    fn prefix_and_tree_shape_are_preserved() {
        assert_eq!(
            render_line(TaskOutcome::Completed, "┗ ", "Pre-start hooks", None, false),
            "┗ ☒ Pre-start hooks"
        );
    }

    #[test]
    fn recording_tracker_records_failure() {
        let t = RecordingTracker::new();
        let phase = t.add_phase("p");
        let task = t.add_task(phase, "t");
        t.fail_task(task, "Exit code 1");
        assert!(t
            .events()
            .contains(&TrackerEvent::Fail(task, "Exit code 1".into())));
    }
}
