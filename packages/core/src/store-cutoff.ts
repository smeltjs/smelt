/**
 * The **age cut-off** grammar, and its one reader.
 *
 * A cut-off is how a user names the age at which their elided bytes stop being worth
 * the disk: `30d`, `12h`, `2w`. It is the single input to the only thing in smelt that
 * deletes an elision, so this module exists for the same reason `hook-command.ts`
 * exists — the spelling had one writer and was about to gain a second reader.
 * `--older-than` parsed it in `cli/subcommands/store.ts`; `store.retention.olderThan`
 * in `smelt.config.json` needs exactly the same three units, the same "at least 1", and
 * the same representable-range bound, and a second copy of that arithmetic is a second
 * answer to "how old is old enough" that could drift by a factor of 24 or 168.
 *
 * The seam is deliberately narrow: this module reads a spelling and answers what it is
 * worth in milliseconds, or *why* it is not readable. It never words a refusal, because
 * the two callers do not refuse alike — a flag names the flag, a config file names the
 * key and the file it is in — and flattening them into one sentence would put
 * `--older-than` in a message about a JSON key. The grammar is shared; the register is
 * each caller's own.
 */

/**
 * The duration grammar, whole: `<n>d`, `<n>h`, `<n>w`, with `n` a whole number of at
 * least 1. Three units and no more, because every extra unit is another spelling to
 * refuse — and no bare number, because `30` cannot be read without guessing which unit
 * the user meant, and guessing wrong deletes bytes at 24× or 168× the age they meant.
 */
const DURATION = /^(\d+)([dhw])$/;

/** What each unit is worth in milliseconds. `Record`, so a fourth unit is a compile error. */
const UNIT_MS: Readonly<Record<'h' | 'd' | 'w', number>> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/**
 * How the grammar is spelled to whoever got it wrong. Written once here, shown by every
 * surface that refuses a cut-off — the flag, and the config key.
 */
export const CUTOFF_HELP = `<n>d, <n>h or <n>w — a whole number of at least 1 and a unit, e.g. 30d, 12h, 2w`;

/**
 * ECMAScript's time-value limit: the furthest a `Date` can reach either side of the
 * epoch, in milliseconds. Beyond it `new Date(...)` is an *Invalid Date*, whose
 * `getTime()` is `NaN` — and every `mtimeMs >= NaN` comparison is false, which a
 * scanner reads as "every blob is old enough". So an age that lands outside this range
 * is refused here rather than turned into a cut-off nothing can compare against.
 * `DirectoryElisionStore.prune()` refuses it a second time, at the point of deletion;
 * see its doc for why one check in one place is not enough for the only code in smelt
 * that unlinks a blob.
 */
const MAX_TIME_VALUE = 8_640_000_000_000_000;

/**
 * What one spelling of a cut-off is worth, or why it is worth nothing.
 *
 * A union rather than a throw, because the caller words the refusal: `'grammar'` is
 * "that is not an age", `'unreachable'` is "that age is further back than a date can
 * go", and the two need different sentences from a flag and from a config key.
 * `furthest` is the largest whole number of the *same unit* that is still a date, so a
 * refusal can state a real limit instead of a number smelt invented.
 */
export type CutoffReading =
  | { readonly ok: true; readonly milliseconds: number }
  | { readonly ok: false; readonly why: 'grammar' }
  | { readonly ok: false; readonly why: 'unreachable'; readonly furthest: string };

/**
 * Read one cut-off. `now` is passed in rather than read here for the same reason
 * `prune()` takes an instant rather than an age: nothing in this library asks what time
 * it is to decide what is old, so every age comparison is the caller's arithmetic and
 * every one of them is testable.
 */
export function readCutoff(raw: string, now: number): CutoffReading {
  const match = DURATION.exec(raw);
  const value = match === null ? 0 : Number(match[1]);
  if (match === null || value < 1) return { ok: false, why: 'grammar' };
  const unit = match[2] as 'h' | 'd' | 'w';
  const milliseconds = value * UNIT_MS[unit];
  if (now - milliseconds < -MAX_TIME_VALUE) {
    const furthest = Math.floor((now + MAX_TIME_VALUE) / UNIT_MS[unit]);
    return { ok: false, why: 'unreachable', furthest: `${String(furthest)}${unit}` };
  }
  return { ok: true, milliseconds };
}
