//! `<count><unit>` duration parsing for the `--recent` / `--stale` filters.
//!
//! Hand-written rather than pulled from a crate (`humantime` and friends): the
//! accepted grammar here is *deliberately* a single count and a single unit, and
//! every general-purpose parser accepts strictly more than that — compound forms
//! (`1h30m`), fractional counts (`1.5d`), and month/year units whose length is a
//! guess. A filter written against an approximate month would silently disagree
//! with the calendar, so those units are not accepted at all even though the AGE
//! column *displays* `mo` and `y`. That asymmetry is intentional and documented
//! for users; a dependency would have made it unenforceable.
//!
//! The error strings are user-facing: clap prints them verbatim as the reason a
//! `--recent`/`--stale` value was rejected (exit 2).

use std::time::Duration;

/// Seconds in each accepted unit.
///
/// Only units with a fixed length are here. `mo`/`y` are absent on purpose (see
/// the module header), and the single-letter spellings are exhaustive so an
/// unknown suffix is always an error rather than a silent reinterpretation.
const UNITS: &[(char, u64)] = &[
    ('s', 1),
    ('m', 60),
    ('h', 3_600),
    ('d', 86_400),
    ('w', 7 * 86_400),
];

/// Parse `<positive integer><s|m|h|d|w>` into a [`Duration`].
///
/// Rejected, each with its own message: an empty string, a missing unit, a
/// missing count, a non-digit count, an unknown unit, `0` (a zero-length window
/// is never what a user means by "recent" — `--recent 0s` matching nothing and
/// `--stale 0s` matching everything are both traps), and any value whose second
/// count overflows `u64`.
pub fn parse_duration(s: &str) -> std::result::Result<Duration, String> {
    if s.is_empty() {
        return Err("duration must not be empty (expected e.g. `30m`, `2d`, `1w`)".to_string());
    }

    // Split on the LAST character rather than scanning for the first non-digit:
    // every accepted unit is exactly one char, so this also gives a precise
    // error for `2dd` ("count `2d` is not a number") instead of a vague one.
    let mut chars = s.chars();
    let unit = chars
        .next_back()
        .expect("checked non-empty above, so there is a last character");
    let count = chars.as_str();

    let Some((_, seconds_per_unit)) = UNITS.iter().find(|(u, _)| *u == unit) else {
        return Err(format!(
            "unknown duration unit `{unit}` in `{s}` (expected one of s, m, h, d, w)"
        ));
    };

    if count.is_empty() {
        return Err(format!(
            "duration `{s}` is missing a count (expected e.g. `30{unit}`)"
        ));
    }

    // `str::parse::<u64>` accepts a leading `+` and unicode digits are rejected
    // by it, but an explicit ASCII check keeps the accepted set exactly the one
    // the docs state.
    if !count.bytes().all(|b| b.is_ascii_digit()) {
        return Err(format!(
            "duration count `{count}` in `{s}` is not a number (expected e.g. `30{unit}`)"
        ));
    }

    let value: u64 = count
        .parse()
        .map_err(|_| format!("duration `{s}` is out of range"))?;

    if value == 0 {
        return Err(format!("duration `{s}` must be greater than zero"));
    }

    let seconds = value
        .checked_mul(*seconds_per_unit)
        .ok_or_else(|| format!("duration `{s}` is out of range"))?;

    Ok(Duration::from_secs(seconds))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What it guarantees: every accepted unit maps to its documented number of
    /// seconds, so `--stale 1w` and `--stale 7d` are the same window.
    #[test]
    fn every_unit_converts_to_its_documented_length() {
        let cases: &[(&str, u64)] = &[
            ("1s", 1),
            ("90s", 90),
            ("1m", 60),
            ("30m", 1_800),
            ("1h", 3_600),
            ("24h", 86_400),
            ("1d", 86_400),
            ("7d", 7 * 86_400),
            ("1w", 7 * 86_400),
            ("26w", 26 * 7 * 86_400),
        ];
        for (input, expected) in cases {
            assert_eq!(
                parse_duration(input).unwrap(),
                Duration::from_secs(*expected),
                "input {input}"
            );
        }
    }

    /// What it guarantees: multi-digit counts are read whole, not just the
    /// first digit.
    #[test]
    fn multi_digit_counts_are_read_whole() {
        assert_eq!(parse_duration("120m").unwrap(), Duration::from_secs(7_200));
        assert_eq!(
            parse_duration("0090s").unwrap(),
            Duration::from_secs(90),
            "leading zeros are digits like any other"
        );
    }

    /// What it guarantees: an empty argument is reported as such rather than
    /// panicking on the missing last character.
    #[test]
    fn an_empty_duration_is_rejected() {
        let err = parse_duration("").unwrap_err();
        assert!(err.contains("must not be empty"), "got: {err}");
    }

    /// What it guarantees: a bare number is not silently taken as seconds. The
    /// unit is the thing that makes `--stale 30` unambiguous.
    #[test]
    fn a_bare_number_is_rejected_for_having_no_unit() {
        let err = parse_duration("30").unwrap_err();
        assert!(err.contains("unknown duration unit `0`"), "got: {err}");
    }

    /// What it guarantees: the display-only `mo`/`y` units of the AGE column are
    /// NOT accepted as filter input, and the error names the accepted set.
    #[test]
    fn display_only_units_are_not_accepted_as_input() {
        for input in ["6mo", "1y", "2M", "3W"] {
            let err = parse_duration(input).unwrap_err();
            assert!(
                err.contains("expected one of s, m, h, d, w"),
                "input {input} got: {err}"
            );
        }
    }

    /// What it guarantees: a unit with nothing in front of it is an error, not
    /// a zero- or one-length duration.
    #[test]
    fn a_unit_without_a_count_is_rejected() {
        let err = parse_duration("d").unwrap_err();
        assert!(err.contains("missing a count"), "got: {err}");
    }

    /// What it guarantees: compound and fractional forms other parsers accept
    /// are rejected here, so the grammar the docs state is the grammar enforced.
    #[test]
    fn compound_and_fractional_forms_are_rejected() {
        for input in ["1h30m", "1.5d", "-1d", "+1d", " 1d", "1 d"] {
            assert!(
                parse_duration(input).is_err(),
                "input {input} must be rejected"
            );
        }
    }

    /// What it guarantees: `0` is rejected in every unit. A zero window is a
    /// trap in both directions (`--recent 0s` matches nothing, `--stale 0s`
    /// matches everything), so it is never accepted as written.
    #[test]
    fn a_zero_duration_is_rejected_in_every_unit() {
        for input in ["0s", "0m", "0h", "0d", "0w", "00d"] {
            let err = parse_duration(input).unwrap_err();
            assert!(
                err.contains("greater than zero"),
                "input {input} got: {err}"
            );
        }
    }

    /// What it guarantees: the multiplication cannot wrap. `u64::MAX` weeks is
    /// reported as out of range instead of becoming a small duration.
    #[test]
    fn an_overflowing_duration_is_rejected_not_wrapped() {
        let err = parse_duration(&format!("{}w", u64::MAX)).unwrap_err();
        assert!(err.contains("out of range"), "got: {err}");

        // Just past the largest representable week count.
        let max_weeks = u64::MAX / (7 * 86_400);
        assert!(parse_duration(&format!("{max_weeks}w")).is_ok());
        let err = parse_duration(&format!("{}w", max_weeks + 1)).unwrap_err();
        assert!(err.contains("out of range"), "got: {err}");
    }

    /// What it guarantees: a count too large for `u64` at all (not just after
    /// multiplication) is also an out-of-range error, not a parse panic.
    #[test]
    fn a_count_wider_than_u64_is_rejected() {
        let err = parse_duration("99999999999999999999999s").unwrap_err();
        assert!(err.contains("out of range"), "got: {err}");
    }
}
