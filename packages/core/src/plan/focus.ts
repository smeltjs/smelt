/**
 * Focus, matched — the one implementation of "does this text match the Focus?".
 *
 * `hooks/focus-terms.ts` is where a focus term *comes from* (a producer's command
 * pattern); this is what a term *matches*. Until review IV (REP-52) the match was
 * written five times — once in each of the four planners and once in the repo map —
 * and the repo map's copy had already diverged: it ignored case sensitivity and always
 * lowercased. Five copies of a CONTEXT.md term with one meaning is how the meaning
 * drifts, one helpful edit at a time.
 *
 * The rule, once: terms are the caller's, empty ones dropped; matching is substring,
 * case-insensitive unless `caseSensitive` says otherwise, folding both the term and the
 * text the same way. A matcher over no terms matches nothing — a planner with nothing
 * to keep by falls back to its own no-focus rule, and the repo map promotes nothing.
 */

/** The one focus option every planner and the repo map share. */
export interface FocusOptions {
  /** Focus matching is substring, case-insensitive by default. */
  readonly caseSensitive?: boolean;
}

/** A Focus, ready to ask. */
export interface FocusMatcher {
  /** The terms as the caller spelled them, empty ones dropped — what a receipt names. */
  readonly terms: readonly string[];
  /** No terms at all: nothing can match, and callers fall back to their no-focus rule. */
  readonly empty: boolean;
  /** Does any term occur in this text? */
  matches(text: string): boolean;
  /** The index in {@link terms} of the first term that occurs, in caller order, or -1. */
  firstMatch(text: string): number;
}

/** Build the matcher for a focus. Pure; the same terms and options give the same answers. */
export function focusMatcher(
  focus: readonly string[] | undefined,
  options: FocusOptions = {},
): FocusMatcher {
  const caseSensitive = options.caseSensitive ?? false;
  const terms = (focus ?? []).filter((term) => term.length > 0);
  const fold = (text: string): string => (caseSensitive ? text : text.toLowerCase());
  const needles = terms.map(fold);
  const firstMatch = (text: string): number => {
    if (needles.length === 0) return -1;
    const haystack = fold(text);
    return needles.findIndex((needle) => haystack.includes(needle));
  };
  return {
    terms,
    empty: needles.length === 0,
    matches: (text) => firstMatch(text) !== -1,
    firstMatch,
  };
}
