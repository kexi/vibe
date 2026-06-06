//! Injected wall-clock and randomness for the `scratch` timestamp + trash names.
//!
//! The TS read `Date.now()` and `crypto.randomUUID()` directly inside the
//! command, which made the collision-retry path and trash-name generation
//! impossible to test deterministically. These two traits push those side
//! effects to the edge so `scratch`/`fast_remove` take a [`Clock`] / a
//! [`RandomSource`] and tests drive them with a [`FakeClock`] / [`FakeRandom`].

use crate::timestamp::LocalTime;

/// Wall-clock source: epoch milliseconds and broken-down LOCAL time.
pub trait Clock {
    /// Milliseconds since the Unix epoch (TS `Date.now()`).
    fn now_ms(&self) -> i64;

    /// Current local time, broken down for [`crate::timestamp::format_local_timestamp`].
    fn local_time(&self) -> LocalTime;
}

/// A source of short random tokens for unique trash directory names.
pub trait RandomSource {
    /// An 8-hex-char token, matching the TS `crypto.randomUUID().slice(0, 8)`.
    fn token(&self) -> String;
}

/// Forward through a reference so `&dyn Clock` / `&dyn RandomSource` satisfy the
/// traits (lets `fast_remove_directory` take the commands' `&dyn` seams).
impl<T: Clock + ?Sized> Clock for &T {
    fn now_ms(&self) -> i64 {
        (**self).now_ms()
    }
    fn local_time(&self) -> LocalTime {
        (**self).local_time()
    }
}

impl<T: RandomSource + ?Sized> RandomSource for &T {
    fn token(&self) -> String {
        (**self).token()
    }
}

/// Production [`Clock`] over the system clock.
pub struct RealClock;

impl Clock for RealClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    fn local_time(&self) -> LocalTime {
        local_time_now()
    }
}

/// Compute broken-down LOCAL time for "now" via `localtime_r`.
#[cfg(unix)]
fn local_time_now() -> LocalTime {
    // SAFETY: `time(NULL)` returns the current epoch seconds; `localtime_r`
    // fills a caller-owned `tm` from it (thread-safe variant, no shared static).
    let secs = unsafe { libc::time(std::ptr::null_mut()) };
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    unsafe {
        libc::localtime_r(&secs, &mut tm);
    }
    LocalTime {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32, // tm_mon is 0-11; TS uses getMonth()+1.
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

#[cfg(not(unix))]
fn local_time_now() -> LocalTime {
    // Non-unix fallback: UTC from SystemTime (the dev/CI matrix is unix, so this
    // path is only a compile safety net, not a parity-critical branch).
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    LocalTime {
        year: 1970,
        month: 1,
        day: (days + 1) as u32,
        hour: (rem / 3600) as u32,
        minute: ((rem % 3600) / 60) as u32,
        second: (rem % 60) as u32,
    }
}

/// Production [`RandomSource`] using a v4 UUID's first 8 hex chars.
pub struct RealRandom;

impl RandomSource for RealRandom {
    fn token(&self) -> String {
        // TS: `crypto.randomUUID().slice(0, 8)` — the first 8 hex of the UUID,
        // which are the leading bytes of `time_low`. `simple()` drops dashes.
        let uuid = uuid::Uuid::new_v4().simple().to_string();
        uuid[..8].to_string()
    }
}

#[cfg(any(test, feature = "test-util"))]
pub use fake::{FakeClock, FakeRandom};

#[cfg(any(test, feature = "test-util"))]
mod fake {
    use super::{Clock, LocalTime, RandomSource};
    use std::cell::Cell;

    /// A deterministic [`Clock`]: fixed `now_ms` and `local_time`.
    pub struct FakeClock {
        now_ms: i64,
        local: LocalTime,
    }

    impl FakeClock {
        pub fn new(now_ms: i64, local: LocalTime) -> Self {
            FakeClock { now_ms, local }
        }
    }

    impl Clock for FakeClock {
        fn now_ms(&self) -> i64 {
            self.now_ms
        }
        fn local_time(&self) -> LocalTime {
            self.local
        }
    }

    /// A scripted [`RandomSource`]: returns a fixed token, or a counter-derived
    /// sequence so collision-retry tests get distinct names.
    pub struct FakeRandom {
        fixed: Option<String>,
        counter: Cell<u32>,
    }

    impl FakeRandom {
        /// Always returns `token`.
        pub fn fixed(token: &str) -> Self {
            FakeRandom {
                fixed: Some(token.to_string()),
                counter: Cell::new(0),
            }
        }

        /// Returns `tok00000`, `tok00001`, ... (8 chars) on each call.
        pub fn sequence() -> Self {
            FakeRandom {
                fixed: None,
                counter: Cell::new(0),
            }
        }
    }

    impl RandomSource for FakeRandom {
        fn token(&self) -> String {
            if let Some(t) = &self.fixed {
                return t.clone();
            }
            let n = self.counter.get();
            self.counter.set(n + 1);
            format!("tok{n:05}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timestamp::format_local_timestamp;

    #[test]
    fn real_clock_now_ms_is_positive() {
        assert!(RealClock.now_ms() > 0);
    }

    #[test]
    fn real_clock_local_time_is_plausible() {
        let t = RealClock.local_time();
        assert!(t.year >= 2024 && t.year < 3000, "year: {}", t.year);
        assert!((1..=12).contains(&t.month));
        assert!((1..=31).contains(&t.day));
        assert!(t.hour < 24 && t.minute < 60 && t.second < 60);
    }

    #[test]
    fn real_random_token_is_8_hex_chars() {
        let t = RealRandom.token();
        assert_eq!(t.len(), 8);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        // Two tokens should (with overwhelming probability) differ.
        assert_ne!(RealRandom.token(), RealRandom.token());
    }

    #[test]
    fn fake_clock_formats_through_timestamp() {
        let t = LocalTime {
            year: 2026,
            month: 6,
            day: 6,
            hour: 9,
            minute: 5,
            second: 3,
        };
        let clock = FakeClock::new(1000, t);
        assert_eq!(clock.now_ms(), 1000);
        assert_eq!(
            format_local_timestamp(clock.local_time()),
            "20260606-090503"
        );
    }

    #[test]
    fn fake_random_fixed_and_sequence() {
        assert_eq!(FakeRandom::fixed("abcd1234").token(), "abcd1234");
        let seq = FakeRandom::sequence();
        assert_eq!(seq.token(), "tok00000");
        assert_eq!(seq.token(), "tok00001");
    }
}
