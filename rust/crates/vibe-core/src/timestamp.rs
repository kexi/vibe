//! Local timestamp formatting for `vibe scratch` branch names.
//!
//! Ported from `packages/core/src/utils/timestamp.ts`. The format is
//! `YYYYMMDD-HHMMSS` (zero-padded), producing sortable, collision-resistant
//! scratch branch names. The formatter is kept pure (it takes broken-down local
//! time) so it is testable without a clock; the actual "now" source is wired in
//! when the `scratch` command is ported.

/// Broken-down local time components, as the TS code reads from `Date`.
#[derive(Debug, Clone, Copy)]
pub struct LocalTime {
    pub year: i32,
    /// 1-12 (the TS uses `getMonth() + 1`).
    pub month: u32,
    /// 1-31.
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// Format local time as `YYYYMMDD-HHMMSS`.
pub fn format_local_timestamp(t: LocalTime) -> String {
    format!(
        "{:04}{:02}{:02}-{:02}{:02}{:02}",
        t.year, t.month, t.day, t.hour, t.minute, t.second
    )
}

/// Convert Unix epoch SECONDS (UTC) into broken-down [`LocalTime`].
///
/// Used by the non-Unix [`crate::clock`] fallback, which has no `localtime_r`:
/// the date is UTC, not local, but it is a *correct* calendar date (leap years
/// and month lengths handled), unlike a naive `secs / 86_400` day count.
///
/// The civil-from-days math is Howard Hinnant's public-domain algorithm
/// (`http://howardhinnant.github.io/date_algorithms.html`), shifted to a March-
/// based year so the leap day falls at the end of the cycle and the month/day
/// arithmetic carries no per-month table.
pub fn local_time_from_epoch_secs(secs: u64) -> LocalTime {
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;

    // Shift the epoch so day 0 is 0000-03-01 (era-based, leap day last).
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11] (March = 0)
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    let year = (y + i64::from(month <= 2)) as i32;

    LocalTime {
        year,
        month,
        day,
        hour: (rem / 3600) as u32,
        minute: ((rem % 3600) / 60) as u32,
        second: (rem % 60) as u32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_with_zero_padding() {
        let t = LocalTime {
            year: 2026,
            month: 6,
            day: 6,
            hour: 9,
            minute: 5,
            second: 3,
        };
        assert_eq!(format_local_timestamp(t), "20260606-090503");
    }

    #[test]
    fn formats_double_digit_components() {
        let t = LocalTime {
            year: 2026,
            month: 12,
            day: 25,
            hour: 23,
            minute: 59,
            second: 59,
        };
        assert_eq!(format_local_timestamp(t), "20261225-235959");
    }

    /// Render an epoch-seconds conversion as the scratch-name string so each
    /// case asserts the full broken-down result in one line.
    fn at(secs: u64) -> String {
        format_local_timestamp(local_time_from_epoch_secs(secs))
    }

    #[test]
    fn epoch_zero_is_unix_birthday() {
        assert_eq!(at(0), "19700101-000000");
    }

    #[test]
    fn one_day_rolls_the_date() {
        assert_eq!(at(86_400), "19700102-000000");
    }

    #[test]
    fn carries_time_of_day() {
        // 86400 + 13:37:42 worth of seconds.
        assert_eq!(at(86_400 + 13 * 3600 + 37 * 60 + 42), "19700102-133742");
    }

    #[test]
    fn handles_leap_day_2024() {
        // 2024-02-29T00:00:00Z = 1709164800 (a real leap day a naive count misses).
        assert_eq!(at(1_709_164_800), "20240229-000000");
    }

    #[test]
    fn handles_post_february_month_rollover() {
        // 2024-03-01T12:00:00Z = 1709251200 (day after the leap day).
        assert_eq!(at(1_709_251_200 + 12 * 3600), "20240301-120000");
    }

    #[test]
    fn handles_non_leap_year_boundary() {
        // 2023-12-31T23:59:59Z = 1704067199.
        assert_eq!(at(1_704_067_199), "20231231-235959");
    }
}
