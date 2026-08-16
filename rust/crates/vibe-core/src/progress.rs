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
//! abandoned just because nobody calls `complete_task` on them. A node that
//! stops spinning also swaps to a `{msg}`-only style (`closed_style`), because
//! `indicatif` renders `{spinner}` on a finished bar as the last `tick_strings`
//! entry and would otherwise stamp a running glyph in front of every outcome.
//!
//! SECURITY/contract: the live renderer draws to `ProgressDrawTarget::stderr()`
//! so stdout stays clean for the eval'd `cd` line. Node labels and error texts
//! are attacker-influenced (hook command strings and copy patterns come from
//! `.vibe.toml`, file names come from the repository), so both are neutralized
//! with [`crate::output::sanitize_for_display`] before they reach the terminal.
//! A label reaches the terminal by *two* routes and each has its own chokepoint:
//! `IndicatifTracker::push_bar` sanitizes the spinner message (drawn as soon as
//! the node is added and redrawn on every steady tick, i.e. long before any
//! outcome is known) and stores that sanitized text, and the pure
//! [`render_line`] sanitizes the label and the error again when it paints the
//! closing line. Why both and not one: `render_line` alone never covers the live
//! message, and `push_bar` alone never covers `fail_task`'s error text or the
//! `NullTracker`-free direct `render_line` callers. Sanitizing at these two
//! points rather than at the `add_task` / `fail_task` call sites means a new
//! caller cannot reintroduce the hole by forgetting to.
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
    /// Mark a task as never-run: it was queued but an earlier step aborted the
    /// sequence. Distinct from [`ProgressTracker::complete_task`] because
    /// [`ProgressTracker::finish`] closes every still-open bar with the success
    /// glyph, which would render a hook that never executed as if it had.
    fn skip_task(&self, id: NodeId);
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
    fn skip_task(&self, id: NodeId) {
        (**self).skip_task(id)
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
    fn skip_task(&self, _id: NodeId) {}
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
    /// Why not `☒`/`✗`: the node neither succeeded nor reported an error, so
    /// borrowing either glyph would state something the run never observed. It
    /// gets a marker of its own so "we gave up on this" is legible at a glance.
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
///
/// Sanitizing `label` here is deliberately redundant with
/// [`IndicatifTracker::push_bar`] (which stores an already-sanitized label):
/// `sanitize_for_display` is idempotent, and keeping it means a direct
/// `render_line` caller is safe on its own. The `error` has no such upstream
/// gate — this is its only one.
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

    /// Sanitizes the label at the single point where a node enters the tracker,
    /// so both the live spinner message and the stored label used by every later
    /// [`render_line`] are already neutralized.
    fn push_bar(&self, label: &str, prefix: &str, kind: NodeKind) -> NodeId {
        // Why here and not only in `render_line`: `indicatif` draws this message
        // the moment it is set and redraws it every steady tick for as long as
        // the task spins, which is long before any outcome line is rendered.
        let label = sanitize_for_display(label);
        let bar = self.multi.add(indicatif::ProgressBar::new_spinner());
        let style = indicatif::ProgressStyle::with_template("{prefix}{spinner} {msg}")
            .expect("static progress template must be valid")
            .tick_strings(&["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
        bar.set_style(style);
        bar.set_prefix(prefix.to_string());
        bar.set_message(label.clone());
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        let id = NodeId(bars.len());
        bars.push(BarNode {
            bar,
            kind,
            prefix: prefix.to_string(),
            label,
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

/// The style a node wears once it stops spinning: the whole line is already
/// baked by [`render_line`], so the template must emit `{msg}` and nothing else.
///
/// Why not keep the spinner template and only clear the prefix: `indicatif`
/// expands `{spinner}` on a finished bar to the *last* `tick_strings` entry
/// (`ProgressStyle::get_final_tick_str`), so a closed node would keep a stray
/// `⠏ ` in front of its outcome glyph and read as still-running — exactly the
/// success/failure ambiguity this rendering exists to remove.
/// The empty `tick_strings` are belt-and-braces: the template already drops
/// `{spinner}`, but blanking the ticks makes "a closed bar renders no spinner"
/// an assertable property (`ProgressStyle::get_final_tick_str`) instead of one
/// that can only be eyeballed in the template string.
fn closed_style() -> indicatif::ProgressStyle {
    indicatif::ProgressStyle::with_template("{msg}")
        .expect("static progress template must be valid")
        .tick_strings(&["", ""])
}

/// Paint a node's final line: style first, so the finished bar never redraws
/// through the spinner template.
fn close_bar(node: &mut BarNode, outcome: TaskOutcome<'_>, color: bool) {
    node.done = true;
    node.bar.set_style(closed_style());
    node.bar.set_prefix("");
    let line = render_line(outcome, &node.prefix, &node.label, color);
    match outcome {
        TaskOutcome::Completed => node.bar.finish_with_message(line),
        // `abandon_with_message` leaves the line in place without the
        // "finished successfully" semantics indicatif attaches to `finish`.
        _ => node.bar.abandon_with_message(line),
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
            close_bar(node, TaskOutcome::Completed, color);
        });
    }
    fn fail_task(&self, id: NodeId, err: &str) {
        let color = self.color;
        self.with_bar(id, |node| {
            close_bar(node, TaskOutcome::Failed { error: err }, color);
        });
    }
    fn skip_task(&self, id: NodeId) {
        // `☐` (empty box), not the `☒` the other two terminal states share: a
        // skipped task is the one case where nothing ran, and `finish` would
        // otherwise close the bar with the completed glyph.
        self.with_bar(id, |node| {
            node.done = true;
            node.bar.set_prefix("");
            node.bar
                .abandon_with_message(format!("{}☐ {} (skipped)", node.prefix, node.label));
        });
    }
    fn start(&self) {}
    fn finish(&self) {
        let color = self.color;
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        let outcomes = closing_outcomes(&bars);
        for (node, outcome) in bars.iter_mut().zip(outcomes) {
            // A phase header is not a unit of work: `closing_outcomes` gives it
            // `Completed` once nothing under it is still pending, so an all-green
            // run keeps rendering `☒ <phase>` as the README documents. Why not
            // finish a still-pending *task* as completed: it never succeeded, and
            // painting it `☒` is the ambiguity this rendering exists to remove.
            let Some(outcome) = outcome else { continue };
            close_bar(node, outcome, color);
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
        Skip(NodeId),
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
        fn skip_task(&self, id: NodeId) {
            self.push(TrackerEvent::Skip(id));
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
        t.skip_task(task);
        t.finish();
        // No panic, no state — the point is it does nothing.
    }

    /// A skipped task is recorded as its own event, so a never-run task can be
    /// told apart from a completed one.
    #[test]
    fn recording_tracker_records_skip() {
        let t = RecordingTracker::new();
        let phase = t.add_phase("p");
        let task = t.add_task(phase, "t");
        t.skip_task(task);
        assert!(t.events().contains(&TrackerEvent::Skip(task)));
        assert!(!t.events().contains(&TrackerEvent::Complete(task)));
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

    /// Guarantees an abandoned line borrows no other state's marker: the README
    /// legend gives `⠋` to pending/running, `☒` to success and `✗` to failure,
    /// so reusing any of them would report something the run never observed.
    #[test]
    fn abandoned_reuses_no_other_states_glyph() {
        let abandoned = render_line(TaskOutcome::Abandoned, "   ┗ ", "node_modules/", false);
        for claimed in ['⠋', '☒', '✗', '☐'] {
            assert!(
                !abandoned.contains(claimed),
                "glyph clash on {claimed:?} in {abandoned:?}"
            );
        }
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

    /// Drives the real tracker's `add_phase`/`add_task`/… sequence, calls the
    /// real `finish()`, and reads back the message each bar actually ended up
    /// with, so the outcome selection is asserted through the tracker rather
    /// than by re-running `closing_outcomes` in the test.
    ///
    /// A node already closed by `complete_task`/`fail_task` is reported as
    /// `<kept:…>` carrying its own line, which is what proves `finish()` does
    /// not overwrite a `✗` with a phase-level marker.
    fn finish_lines(build: impl FnOnce(&IndicatifTracker)) -> Vec<String> {
        let tracker = IndicatifTracker::with_color(false);
        build(&tracker);
        let closed_before: Vec<bool> = tracker
            .bars
            .lock()
            .unwrap()
            .iter()
            .map(|node| node.done)
            .collect();
        tracker.finish();
        let bars = tracker.bars.lock().unwrap();
        bars.iter()
            .zip(closed_before)
            .map(|(node, was_closed)| {
                let line = node.bar.message();
                if was_closed {
                    format!("<kept:{line}>")
                } else {
                    line
                }
            })
            .collect()
    }

    /// Guarantees `finish()` closes every node it touches, so a second
    /// `finish()` is a no-op rather than a repaint.
    #[test]
    fn finish_marks_every_node_done() {
        let tracker = IndicatifTracker::with_color(false);
        let phase = tracker.add_phase("Copying files");
        tracker.add_task(phase, "node_modules/");
        tracker.finish();

        let bars = tracker.bars.lock().unwrap();
        assert!(bars.iter().all(|node| node.done));
        assert!(closing_outcomes(&bars).iter().all(Option::is_none));
    }

    /// Guarantees the *spinning* style really would stamp a glyph on a finished
    /// bar, so `closed_nodes_stop_rendering_the_spinner` below is testing a live
    /// hazard rather than a hypothetical one. `indicatif` expands `{spinner}` on
    /// a finished bar to the last `tick_strings` entry, not to nothing.
    #[test]
    fn the_spinning_style_would_stamp_a_glyph_on_a_finished_bar() {
        let tracker = IndicatifTracker::with_color(false);
        tracker.add_phase("Copying files");

        let bars = tracker.bars.lock().unwrap();
        let spinning = bars[0].bar.style();
        assert_eq!(
            spinning.get_final_tick_str(),
            "⠏",
            "the running style must be the one whose final tick has to be escaped"
        );
    }

    /// Guarantees every node closed by `complete_task`, `fail_task` or `finish`
    /// swaps to a style that renders `{msg}` alone: its final tick string must
    /// be empty, otherwise the outcome line is drawn as `⠏ ┗ ✗ …` and a failed
    /// task reads as still running.
    #[test]
    fn closed_nodes_stop_rendering_the_spinner() {
        let tracker = IndicatifTracker::with_color(false);
        let phase = tracker.add_phase("Post-start hooks");
        let ok = tracker.add_task(phase, "echo hi");
        tracker.complete_task(ok);
        let bad = tracker.add_task(phase, "sh -c 'exit 3'");
        tracker.fail_task(bad, "Exit code 3");
        // Left pending on purpose: finish() closes it, and it must be styled
        // the same way as the two the callers closed.
        tracker.add_task(phase, "node_modules/");
        tracker.finish();

        let bars = tracker.bars.lock().unwrap();
        assert_eq!(bars.len(), 4);
        for node in bars.iter() {
            assert_eq!(
                node.bar.style().get_final_tick_str(),
                "",
                "closed node {:?} still renders a spinner glyph",
                node.label
            );
        }
    }

    #[test]
    fn finish_leaves_a_successful_phase_marked_done_not_abandoned() {
        let lines = finish_lines(|t| {
            let phase = t.add_phase("Pre-start hooks");
            let task = t.add_task(phase, "npm install");
            t.start_task(task);
            t.complete_task(task);
        });

        assert_eq!(
            lines,
            vec!["┗ ☒ Pre-start hooks", "<kept:   ┗ ☒ npm install>"]
        );
    }

    #[test]
    fn finish_keeps_a_failed_task_and_still_closes_its_phase() {
        let lines = finish_lines(|t| {
            let phase = t.add_phase("Post-start hooks");
            let task = t.add_task(phase, "sh -c 'exit 3'");
            t.start_task(task);
            t.fail_task(task, "Exit code 3");
        });

        // The phase header must not steal the failure marker, and finish() must
        // not repaint over the ✗ line fail_task already produced.
        assert_eq!(
            lines,
            vec![
                "┗ ☒ Post-start hooks",
                "<kept:   ┗ ✗ sh -c 'exit 3' (failed: Exit code 3)>",
            ]
        );
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
            vec![
                "┗ ⊘ Copying files",
                "<kept:   ┗ ☒ .env>",
                "   ┗ ⊘ node_modules/",
            ]
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
                "<kept:   ┗ ☒ echo hi>",
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

    /// Guarantees the *live* spinner line is neutralized, not just the closing
    /// line: `indicatif` draws the message when the node is added and redraws it
    /// on every steady tick, so a hostile hook name would reach the terminal for
    /// the whole time the task spins if only `render_line` sanitized.
    #[test]
    fn live_spinner_message_and_stored_label_carry_no_control_sequences() {
        let hostile = "npm install\x1b[2K\x1b[A\u{202e}gnitsurt";
        let sanitized = "npm install\u{fffd}[2K\u{fffd}[A\u{fffd}gnitsurt";

        let tracker = IndicatifTracker::with_color(false);
        let phase = tracker.add_phase(hostile);
        let task = tracker.add_task(phase, hostile);
        tracker.start_task(task);

        let bars = tracker.bars.lock().unwrap();
        for node in bars.iter() {
            assert_eq!(node.label, sanitized, "stored label was not neutralized");
            assert_eq!(
                node.bar.message(),
                sanitized,
                "live spinner message was not neutralized"
            );
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
