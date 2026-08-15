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
//! failed copy indistinguishable from a successful one). Which outcome each
//! node gets at `finish()` is likewise decided by the pure `closing_outcomes`,
//! because phases are headers rather than units of work and must not be
//! abandoned just because nobody calls `complete_task` on them.
//!
//! SECURITY/contract: the live renderer draws to `ProgressDrawTarget::stderr()`
//! so stdout stays clean for the eval'd `cd` line. Node labels and error texts
//! are attacker-influenced (hook command strings and copy patterns come from
//! `.vibe.toml`, file names come from the repository), so [`render_line`]
//! neutralizes both with [`crate::output::sanitize_for_display`] before they
//! reach the terminal. Why there and not at the call sites: sanitizing in the
//! one function every rendered line passes through means a new `add_task` /
//! `fail_task` caller cannot reintroduce the hole by forgetting to.
//!
//! Why the callers in `copy_runner` still sanitize too: the same strings also
//! go to plain stderr through `warn_log`/`log_dry_run`, which do not render
//! through `render_line`. `sanitize_for_display` maps unsafe characters to
//! U+FFFD, which is itself safe, so passing an already-sanitized label through
//! it again is a no-op (asserted by `sanitize_is_idempotent`).

use crate::ansi::{colorize, DIM, RED};
use crate::output::sanitize_for_display;

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
///
/// [`TaskOutcome::Failed`] carries its reason so a failed line cannot be built
/// without one (the pairing is unrepresentable rather than merely documented).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskOutcome<'a> {
    /// Ran to completion — `☒`.
    Completed,
    /// Errored — a red `✗`, plus the error in parentheses.
    Failed { error: &'a str },
    /// Still pending when the run ended — a dim `⊘`.
    ///
    /// Why not `☐`: the docs already use `☐` for "queued, will still run"
    /// (README "Progress display" legend), so reusing it would make "gave up"
    /// and "not started yet" the same glyph.
    Abandoned,
}

impl TaskOutcome<'_> {
    fn glyph(self) -> &'static str {
        match self {
            TaskOutcome::Completed => "☒",
            TaskOutcome::Failed { .. } => "✗",
            TaskOutcome::Abandoned => "⊘",
        }
    }
}

/// Render the final line of a progress node.
///
/// Pure so glyph regressions are caught by a unit test; the live renderer only
/// hands the result to `indicatif`.
///
/// `label` and `error` are neutralized with
/// [`crate::output::sanitize_for_display`], because both carry text a repository
/// controls (hook commands and copy patterns out of `.vibe.toml`, file names out
/// of the working tree) into a line that is wrapped in ANSI codes and drawn onto
/// a live, redrawable display. `prefix` is not sanitized: it is one of this
/// module's two hard-coded tree strings.
pub fn render_line(outcome: TaskOutcome<'_>, prefix: &str, label: &str, color: bool) -> String {
    let glyph = outcome.glyph();
    let label = sanitize_for_display(label);
    let body = match outcome {
        TaskOutcome::Failed { error } => {
            format!("{glyph} {label} (failed: {})", sanitize_for_display(error))
        }
        _ => format!("{glyph} {label}"),
    };
    let painted = match outcome {
        TaskOutcome::Completed => body,
        TaskOutcome::Failed { .. } => colorize(RED, &body, color),
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

/// What a node is, which decides how [`IndicatifTracker::finish`] closes it: a
/// task is closed by its own caller, whereas a phase is only ever a header and
/// is closed from the state of the tasks below it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeKind {
    Phase,
    /// Task under the phase node at this index (an id from another tracker
    /// simply matches nothing, so a bad parent cannot panic).
    Task {
        phase: usize,
    },
}

struct BarNode {
    bar: indicatif::ProgressBar,
    kind: NodeKind,
    prefix: String,
    label: String,
    done: bool,
}

impl IndicatifTracker {
    /// Create a tracker drawing to stderr (keeps stdout clean for the `cd`
    /// line), with the caller's resolved [`crate::ansi::is_color_enabled`]
    /// value.
    ///
    /// Why not a `new()`/`Default`: the color decision must come from the
    /// caller's `NO_COLOR`/`FORCE_COLOR` probe, and a parameterless constructor
    /// could only guess it.
    pub fn with_color(color: bool) -> Self {
        let multi =
            indicatif::MultiProgress::with_draw_target(indicatif::ProgressDrawTarget::stderr());
        IndicatifTracker {
            multi,
            bars: std::sync::Mutex::new(Vec::new()),
            color,
        }
    }

    fn push_bar(&self, label: &str, prefix: &str, kind: NodeKind) -> NodeId {
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
            kind,
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

/// Decide how each still-open node is closed by `finish()`.
///
/// `None` = already closed by its own caller, leave the line alone. Split out
/// of `finish` (and driven by a unit test) because the phase rule is the part
/// that regressed: a phase is a header, so it is `Completed` unless a task
/// under it was still pending when the run ended.
fn closing_outcomes(bars: &[BarNode]) -> Vec<Option<TaskOutcome<'static>>> {
    let mut phase_has_pending_task = vec![false; bars.len()];
    for node in bars.iter() {
        if let (NodeKind::Task { phase }, false) = (node.kind, node.done) {
            if let Some(flag) = phase_has_pending_task.get_mut(phase) {
                *flag = true;
            }
        }
    }
    bars.iter()
        .enumerate()
        .map(|(i, node)| {
            if node.done {
                return None;
            }
            match node.kind {
                NodeKind::Phase if !phase_has_pending_task[i] => Some(TaskOutcome::Completed),
                _ => Some(TaskOutcome::Abandoned),
            }
        })
        .collect()
}

impl ProgressTracker for IndicatifTracker {
    fn add_phase(&self, label: &str) -> NodeId {
        self.push_bar(label, "┗ ", NodeKind::Phase)
    }
    fn add_task(&self, phase: NodeId, label: &str) -> NodeId {
        self.push_bar(label, "   ┗ ", NodeKind::Task { phase: phase.0 })
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
                TaskOutcome::Failed { error: err },
                &node.prefix,
                &node.label,
                color,
            ));
        });
    }
    fn start(&self) {}
    fn finish(&self) {
        let color = self.color;
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        let outcomes = closing_outcomes(&bars);
        for (node, outcome) in bars.iter_mut().zip(outcomes) {
            let Some(outcome) = outcome else { continue };
            node.done = true;
            node.bar.set_prefix("");
            match outcome {
                // A phase header is not a unit of work: it closes as done once
                // nothing under it is still pending, so an all-green run keeps
                // rendering `☒ <phase>` as the README documents.
                TaskOutcome::Completed => node.bar.finish_with_message(render_line(
                    TaskOutcome::Completed,
                    &node.prefix,
                    &node.label,
                    color,
                )),
                // Why not finish these as completed: a node still pending when
                // the run ends never succeeded, and painting it `☒` is exactly
                // the ambiguity this rendering is meant to remove.
                _ => node.bar.abandon_with_message(render_line(
                    TaskOutcome::Abandoned,
                    &node.prefix,
                    &node.label,
                    color,
                )),
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
        let done = render_line(TaskOutcome::Completed, "   ┗ ", "npm install", false);
        let failed = render_line(
            TaskOutcome::Failed {
                error: "Exit code 1",
            },
            "   ┗ ",
            "npm install",
            false,
        );
        let abandoned = render_line(TaskOutcome::Abandoned, "   ┗ ", "npm install", false);

        assert_eq!(done, "   ┗ ☒ npm install");
        assert_eq!(failed, "   ┗ ✗ npm install (failed: Exit code 1)");
        assert_eq!(abandoned, "   ┗ ⊘ npm install");
        assert_ne!(done, failed);
        assert_ne!(done, abandoned);
        assert_ne!(failed, abandoned);
    }

    #[test]
    fn abandoned_does_not_reuse_the_documented_pending_glyph() {
        // README's legend spends `☐` on "queued, will still run".
        let abandoned = render_line(TaskOutcome::Abandoned, "   ┗ ", "node_modules/", false);
        assert!(!abandoned.contains('☐'), "glyph clash in {abandoned:?}");
    }

    #[test]
    fn failure_is_red_and_abandon_is_dim_when_color_is_enabled() {
        assert_eq!(
            render_line(TaskOutcome::Failed { error: "denied" }, "┗ ", "copy", true),
            format!("┗ {RED}✗ copy (failed: denied){RESET}")
        );
        assert_eq!(
            render_line(TaskOutcome::Abandoned, "┗ ", "copy", true),
            format!("┗ {DIM}⊘ copy{RESET}")
        );
    }

    #[test]
    fn success_is_never_colored() {
        assert_eq!(
            render_line(TaskOutcome::Completed, "┗ ", "copy", true),
            "┗ ☒ copy"
        );
    }

    #[test]
    fn color_is_suppressed_when_disabled() {
        for outcome in [
            TaskOutcome::Completed,
            TaskOutcome::Failed { error: "boom" },
            TaskOutcome::Abandoned,
        ] {
            let line = render_line(outcome, "┗ ", "copy", false);
            assert!(!line.contains('\x1b'), "unexpected escape in {line:?}");
        }
    }

    #[test]
    fn prefix_and_tree_shape_are_preserved() {
        assert_eq!(
            render_line(TaskOutcome::Completed, "┗ ", "Pre-start hooks", false),
            "┗ ☒ Pre-start hooks"
        );
    }

    /// Drives the real tracker's `add_phase`/`add_task`/… sequence and reports
    /// what `finish()` would paint on each line, so the outcome selection is
    /// asserted end to end and not just `render_line`'s formatting.
    fn finish_lines(build: impl FnOnce(&IndicatifTracker)) -> Vec<String> {
        let tracker = IndicatifTracker::with_color(false);
        build(&tracker);
        let bars = tracker.bars.lock().unwrap();
        let outcomes = closing_outcomes(&bars);
        bars.iter()
            .zip(outcomes)
            .map(|(node, outcome)| match outcome {
                // Already closed by complete_task/fail_task: finish() leaves it.
                None => format!("{}<kept>", node.prefix),
                Some(outcome) => render_line(outcome, &node.prefix, &node.label, false),
            })
            .collect()
    }

    #[test]
    fn finish_leaves_a_successful_phase_marked_done_not_abandoned() {
        let lines = finish_lines(|t| {
            let phase = t.add_phase("Pre-start hooks");
            let task = t.add_task(phase, "npm install");
            t.start_task(task);
            t.complete_task(task);
        });

        assert_eq!(lines, vec!["┗ ☒ Pre-start hooks", "   ┗ <kept>"]);
    }

    #[test]
    fn finish_keeps_a_failed_task_and_still_closes_its_phase() {
        let lines = finish_lines(|t| {
            let phase = t.add_phase("Post-start hooks");
            let task = t.add_task(phase, "sh -c 'exit 3'");
            t.start_task(task);
            t.fail_task(task, "Exit code 3");
        });

        // The phase header must not steal the failure marker; the ✗ line is the
        // one fail_task already painted.
        assert_eq!(lines, vec!["┗ ☒ Post-start hooks", "   ┗ <kept>"]);
    }

    #[test]
    fn finish_abandons_a_pending_task_and_its_phase() {
        let lines = finish_lines(|t| {
            let phase = t.add_phase("Copying files");
            let done = t.add_task(phase, ".env");
            t.complete_task(done);
            let pending = t.add_task(phase, "node_modules/");
            t.start_task(pending);
        });

        assert_eq!(
            lines,
            vec!["┗ ⊘ Copying files", "   ┗ <kept>", "   ┗ ⊘ node_modules/",]
        );
    }

    #[test]
    fn finish_completes_a_phase_that_never_got_a_task() {
        let lines = finish_lines(|t| {
            t.add_phase("Initializing submodules");
        });

        assert_eq!(lines, vec!["┗ ☒ Initializing submodules"]);
    }

    #[test]
    fn finish_scopes_pending_tasks_to_their_own_phase() {
        let lines = finish_lines(|t| {
            let first = t.add_phase("Pre-start hooks");
            let ok = t.add_task(first, "echo hi");
            t.complete_task(ok);
            let second = t.add_phase("Copying files");
            t.add_task(second, "node_modules/");
        });

        assert_eq!(
            lines,
            vec![
                "┗ ☒ Pre-start hooks",
                "   ┗ <kept>",
                "┗ ⊘ Copying files",
                "   ┗ ⊘ node_modules/",
            ]
        );
    }

    /// Guarantees that no progress line can carry a raw terminal control
    /// sequence or a bidi override out of a label, whatever the outcome: a hook
    /// command from `.vibe.toml` that erases the line above and redraws it
    /// renders as inert U+FFFD text instead of moving the cursor.
    #[test]
    fn labels_cannot_carry_control_sequences_for_any_outcome() {
        let hostile = "npm install\x1b[2K\x1b[A\u{202e}gnitsurt";
        for outcome in [
            TaskOutcome::Completed,
            TaskOutcome::Failed { error: "boom" },
            TaskOutcome::Abandoned,
        ] {
            for color in [false, true] {
                let line = render_line(outcome, "   ┗ ", hostile, color);
                let body = line.trim_start_matches("   ┗ ");
                let body = body
                    .trim_start_matches(RED)
                    .trim_start_matches(DIM)
                    .trim_end_matches(RESET);
                assert!(
                    !body.contains('\u{1b}'),
                    "escape survived in {line:?} ({outcome:?})"
                );
                assert!(
                    !body.contains('\u{202e}'),
                    "bidi override survived in {line:?} ({outcome:?})"
                );
                assert!(
                    body.contains("npm install\u{fffd}[2K\u{fffd}[A\u{fffd}gnitsurt"),
                    "label was dropped instead of neutralized: {line:?}"
                );
            }
        }
    }

    /// Guarantees the failure reason is neutralized too — it is interpolated
    /// into the same line as `(failed: …)`.
    #[test]
    fn failure_reason_cannot_carry_control_sequences() {
        let line = render_line(
            TaskOutcome::Failed {
                error: "Exit code 1\x1b[2K\u{2028}",
            },
            "   ┗ ",
            "npm install",
            false,
        );
        assert_eq!(
            line,
            "   ┗ ✗ npm install (failed: Exit code 1\u{fffd}[2K\u{fffd})"
        );
    }

    /// Guarantees that sanitizing twice equals sanitizing once, which is what
    /// lets `copy_runner` keep sanitizing at its own stderr call sites while
    /// `render_line` also sanitizes centrally.
    #[test]
    fn sanitize_is_idempotent() {
        let once = sanitize_for_display("a\x1b[2Kb\u{202e}c\nd");
        assert_eq!(sanitize_for_display(&once), once);
        assert_eq!(
            render_line(TaskOutcome::Completed, "┗ ", &once, false),
            render_line(TaskOutcome::Completed, "┗ ", "a\x1b[2Kb\u{202e}c\nd", false)
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
