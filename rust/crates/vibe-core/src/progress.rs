//! Progress UI seam, rendered to stderr only.
//!
//! Ported from `packages/core/src/utils/progress.ts` (the `ProgressTracker`
//! class). The TS rendered a live spinner tree; here the seam is a
//! [`ProgressTracker`] trait so the live UI ([`IndicatifTracker`], stderr only)
//! is swappable for a [`NullTracker`] (quiet / non-TTY / Claude-hook / unit
//! tests) and a [`RecordingTracker`] (asserts the event sequence). Live spinner
//! glyph parity is intentionally NOT tested — only the event protocol is.
//!
//! SECURITY/contract: the live renderer draws to `ProgressDrawTarget::stderr()`
//! so stdout stays clean for the eval'd `cd` line.

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

/// Live progress tracker backed by `indicatif`, drawing to STDERR only.
pub struct IndicatifTracker {
    multi: indicatif::MultiProgress,
    bars: std::sync::Mutex<Vec<indicatif::ProgressBar>>,
}

impl Default for IndicatifTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl IndicatifTracker {
    /// Create a tracker drawing to stderr (keeps stdout clean for the `cd` line).
    pub fn new() -> Self {
        let multi =
            indicatif::MultiProgress::with_draw_target(indicatif::ProgressDrawTarget::stderr());
        IndicatifTracker {
            multi,
            bars: std::sync::Mutex::new(Vec::new()),
        }
    }

    fn push_bar(&self, label: &str) -> NodeId {
        let bar = self.multi.add(indicatif::ProgressBar::new_spinner());
        bar.set_message(label.to_string());
        let mut bars = self.bars.lock().expect("progress mutex poisoned");
        let id = NodeId(bars.len());
        bars.push(bar);
        id
    }

    fn with_bar(&self, id: NodeId, f: impl FnOnce(&indicatif::ProgressBar)) {
        let bars = self.bars.lock().expect("progress mutex poisoned");
        if let Some(bar) = bars.get(id.0) {
            f(bar);
        }
    }
}

impl ProgressTracker for IndicatifTracker {
    fn add_phase(&self, label: &str) -> NodeId {
        self.push_bar(label)
    }
    fn add_task(&self, _phase: NodeId, label: &str) -> NodeId {
        self.push_bar(label)
    }
    fn start_task(&self, id: NodeId) {
        self.with_bar(id, |b| {
            b.enable_steady_tick(std::time::Duration::from_millis(80))
        });
    }
    fn complete_task(&self, id: NodeId) {
        self.with_bar(id, |b| b.finish());
    }
    fn fail_task(&self, id: NodeId, err: &str) {
        let msg = format!("failed: {err}");
        self.with_bar(id, |b| b.abandon_with_message(msg));
    }
    fn start(&self) {}
    fn finish(&self) {
        let bars = self.bars.lock().expect("progress mutex poisoned");
        for bar in bars.iter() {
            if !bar.is_finished() {
                bar.finish_and_clear();
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
