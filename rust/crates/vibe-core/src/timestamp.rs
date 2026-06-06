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
}
