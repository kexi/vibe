//! Fuzzy (subsequence) branch-name matching for `vibe jump`.
//!
//! Ported from `packages/core/src/utils/fuzzy.ts`. Each search character must
//! appear in the target in order (not necessarily contiguous); a matching run is
//! scored so better matches sort first. The score uses `f64` because the TS tail
//! penalty is `* 0.5`, and the relative ordering of scores is what `jump` relies
//! on, so the arithmetic must match exactly.
//!
//! Indices are over `char`s. Branch names are effectively ASCII here, so this
//! matches the TS string indexing while staying correct for any single-`char`
//! code points.

/// Word-boundary characters that earn a scoring bonus.
const WORD_BOUNDARY_CHARS: [char; 3] = ['/', '-', '_'];

/// Minimum search length required before `jump` applies fuzzy matching.
pub const FUZZY_MATCH_MIN_LENGTH: usize = 3;

/// A successful fuzzy match: its score and the matched positions in the target.
#[derive(Debug, Clone, PartialEq)]
pub struct FuzzyMatch {
    pub score: f64,
    pub match_positions: Vec<usize>,
}

/// Fuzzy-match `search` against `target`, returning `None` if not all search
/// characters appear in order. Case-insensitive.
pub fn fuzzy_match(target: &str, search: &str) -> Option<FuzzyMatch> {
    let target_chars: Vec<char> = target.chars().collect();
    let search_chars: Vec<char> = search.chars().collect();

    if search_chars.len() > target_chars.len() {
        return None;
    }
    if search_chars.is_empty() {
        return None;
    }

    let lower_target: Vec<char> = target.to_lowercase().chars().collect();
    let lower_search: Vec<char> = search.to_lowercase().chars().collect();
    // Lowercasing can change length for some scripts; guard so indexing stays
    // valid. Branch names won't hit this, but it keeps the port total.
    if lower_target.len() != target_chars.len() || lower_search.len() != search_chars.len() {
        return None;
    }

    let mut match_positions = Vec::with_capacity(lower_search.len());
    let mut target_index = 0usize;

    for &search_char in &lower_search {
        let mut found = false;
        while target_index < lower_target.len() {
            if lower_target[target_index] == search_char {
                match_positions.push(target_index);
                target_index += 1;
                found = true;
                break;
            }
            target_index += 1;
        }
        if !found {
            return None;
        }
    }

    let score = calculate_score(&target_chars, &match_positions);
    Some(FuzzyMatch {
        score,
        match_positions,
    })
}

/// Score a match. Mirrors `calculateScore` in fuzzy.ts exactly.
fn calculate_score(target: &[char], match_positions: &[usize]) -> f64 {
    let mut score: f64 = 0.0;

    // Start bonus: first match at position 0.
    if match_positions[0] == 0 {
        score += 15.0;
    }

    let mut consecutive_length: i64 = 1;

    for i in 0..match_positions.len() {
        let position = match_positions[i];

        // Word boundary bonus.
        let is_at_word_boundary =
            position == 0 || WORD_BOUNDARY_CHARS.contains(&target[position - 1]);
        if is_at_word_boundary {
            score += 10.0;
        }

        // Consecutive run tracking.
        let is_consecutive = i > 0 && position == match_positions[i - 1] + 1;
        if is_consecutive {
            consecutive_length += 1;
        } else {
            if i > 0 {
                score += (consecutive_length * consecutive_length) as f64;
            }
            consecutive_length = 1;
        }

        // Gap penalty.
        if i > 0 {
            let gap = position as i64 - match_positions[i - 1] as i64 - 1;
            score -= gap as f64;
        }
    }

    // Final consecutive run bonus.
    score += (consecutive_length * consecutive_length) as f64;

    // Tail penalty: unused characters after the last match.
    let last = match_positions[match_positions.len() - 1];
    let tail_length = target.len() as i64 - last as i64 - 1;
    score -= tail_length as f64 * 0.5;

    score
}

#[cfg(test)]
mod tests {
    use super::*;

    fn positions(target: &str, search: &str) -> Vec<usize> {
        fuzzy_match(target, search).unwrap().match_positions
    }
    fn score(target: &str, search: &str) -> f64 {
        fuzzy_match(target, search).unwrap().score
    }

    #[test]
    fn matches_basic_subsequence() {
        assert_eq!(positions("feat/login", "feli"), vec![0, 1, 5, 8]);
    }

    #[test]
    fn returns_none_when_out_of_order() {
        assert!(fuzzy_match("feat/login", "xyz").is_none());
    }

    #[test]
    fn returns_none_when_search_longer_than_target() {
        assert!(fuzzy_match("feat", "feat/login").is_none());
    }

    #[test]
    fn returns_none_for_empty_search() {
        assert!(fuzzy_match("feat/login", "").is_none());
    }

    #[test]
    fn is_case_insensitive() {
        assert_eq!(positions("feat/login", "FELI"), vec![0, 1, 5, 8]);
    }

    #[test]
    fn consecutive_scores_higher_than_scattered() {
        assert!(score("abcdef", "abc") > score("abcdef", "ace"));
    }

    #[test]
    fn word_boundary_bonus() {
        assert!(score("feat/login", "log") > score("fallowing", "log"));
    }

    #[test]
    fn start_bonus() {
        assert!(score("feat/login", "feat") > score("xfeat/login", "feat"));
    }

    #[test]
    fn exact_subsequence_matches_all() {
        assert_eq!(positions("abc", "abc"), vec![0, 1, 2]);
    }

    #[test]
    fn single_character_search() {
        assert_eq!(positions("feat/login", "f"), vec![0]);
    }

    #[test]
    fn hyphen_and_underscore_are_boundaries() {
        assert_eq!(score("feat-login", "log"), score("feat_login", "log"));
    }

    #[test]
    fn min_length_is_3() {
        assert_eq!(FUZZY_MATCH_MIN_LENGTH, 3);
    }

    #[test]
    fn penalizes_long_tails() {
        assert!(score("feat/login", "feat") > score("feat/login-page-extra-long", "feat"));
    }

    #[test]
    fn penalizes_gaps() {
        assert!(score("f-login", "fl") > score("f----login", "fl"));
    }
}
