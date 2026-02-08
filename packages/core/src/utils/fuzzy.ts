/** Word boundary characters used for scoring bonuses */
const WORD_BOUNDARY_CHARS = new Set(["/", "-", "_"]);

/** Minimum search length required for fuzzy matching */
export const FUZZY_MATCH_MIN_LENGTH = 3;

export interface FuzzyMatchResult {
  score: number;
  matchPositions: number[];
}

/**
 * Perform fuzzy (subsequence) matching of search characters within target string.
 * Each character of search must appear in target in order, but not necessarily contiguously.
 *
 * Returns a scored result if all characters match, or null if no match.
 *
 * Scoring:
 * - Consecutive match bonus: square of consecutive length (3 consecutive = +9)
 * - Word boundary bonus: +10 when matching immediately after /, -, _
 * - Start bonus: +15 when first match is at position 0
 * - Gap penalty: -1 per skipped character between matches
 * - Tail penalty: -0.5 per unused character after last match
 */
export function fuzzyMatch(target: string, search: string): FuzzyMatchResult | null {
  const isSearchLongerThanTarget = search.length > target.length;
  if (isSearchLongerThanTarget) return null;

  const isSearchEmpty = search.length === 0;
  if (isSearchEmpty) return null;

  const lowerTarget = target.toLowerCase();
  const lowerSearch = search.toLowerCase();

  const matchPositions: number[] = [];
  let targetIndex = 0;

  for (let searchIndex = 0; searchIndex < lowerSearch.length; searchIndex++) {
    const searchChar = lowerSearch[searchIndex];
    let found = false;

    while (targetIndex < lowerTarget.length) {
      const isMatch = lowerTarget[targetIndex] === searchChar;
      if (isMatch) {
        matchPositions.push(targetIndex);
        targetIndex++;
        found = true;
        break;
      }
      targetIndex++;
    }

    if (!found) return null;
  }

  const score = calculateScore(target, matchPositions);
  return { score, matchPositions };
}

/**
 * Calculate a score for a fuzzy match based on match quality.
 */
function calculateScore(target: string, matchPositions: number[]): number {
  let score = 0;

  // Start bonus: first match at position 0
  const isStartMatch = matchPositions[0] === 0;
  if (isStartMatch) {
    score += 15;
  }

  // Consecutive match bonus and word boundary bonus
  let consecutiveLength = 1;

  for (let i = 0; i < matchPositions.length; i++) {
    const position = matchPositions[i];

    // Word boundary bonus
    const isAtWordBoundary = position === 0 || WORD_BOUNDARY_CHARS.has(target[position - 1]);
    if (isAtWordBoundary) {
      score += 10;
    }

    // Consecutive match tracking
    const isConsecutive = i > 0 && position === matchPositions[i - 1] + 1;
    if (isConsecutive) {
      consecutiveLength++;
    } else {
      // Apply bonus for previous consecutive run
      if (i > 0) {
        score += consecutiveLength * consecutiveLength;
      }
      consecutiveLength = 1;
    }

    // Gap penalty
    if (i > 0) {
      const gap = position - matchPositions[i - 1] - 1;
      score -= gap;
    }
  }

  // Apply bonus for final consecutive run
  score += consecutiveLength * consecutiveLength;

  // Tail penalty: unused characters after last match
  const lastMatchPosition = matchPositions[matchPositions.length - 1];
  const tailLength = target.length - lastMatchPosition - 1;
  score -= tailLength * 0.5;

  return score;
}
