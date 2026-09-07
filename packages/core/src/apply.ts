import { OverlappingElisionError, RangeOutOfBoundsError, UnknownHashError } from './errors.ts';
import { HASH_LENGTH } from './hash.ts';
import { LANGUAGE_PROFILES } from './lang/registry.ts';
import type {
  AppliedElision,
  ByteRange,
  DetectedLanguage,
  ElisionPlan,
  ElisionStore,
  MarkerPricing,
  Measure,
  SmeltResult,
} from './types.ts';

/** Everything the marker text is allowed to depend on. */
export interface MarkerInfo {
  readonly hash: string;
  readonly bytes: number;
  readonly rule: string;
  readonly explanation: string;
}

export type MarkerBuilder = (info: MarkerInfo) => string;

/**
 * The version of the marker format itself, carried **in band** in every marker.
 *
 * The marker is the one part of smelt a *model* sees, and it goes into prompts.
 * Changing its shape changes model behaviour downstream and shows up as worse output
 * with no error anywhere — this project's signature failure mode, shipped as a patch
 * release. So the wire surface is frozen from 0.1 and treated as 1.0
 * (`CONTRIBUTING.md` § "Two promises, not one"), and a future format is *additive and
 * identifiable*: `smelt/v2` markers can coexist with `smelt/v1` ones, and a consumer
 * parsing markers can tell which it is holding. A format that changed silently would
 * be a substitution; this makes it a declaration.
 *
 * `test/guards/marker-format.test.ts` pins the rendered marker per version and fails if
 * the format moves without the version moving.
 */
export const MARKER_FORMAT_VERSION = 'v1';

/**
 * The default marker.
 *
 * Its shape is the user-facing form of Laws 2 and 3, in one line the model reads:
 * *which format this is* (the version), *what was removed* (the explanation), *how
 * much* (the byte count), and *how to get it back* (the hash). Anything that cannot
 * fill in all of those is not allowed to be an elision.
 *
 * `<<…>>` rather than a Unicode bracket because it survives every tokenizer, terminal,
 * and diff tool without becoming three tokens of nothing.
 */
export const defaultMarker: MarkerBuilder = ({ explanation, bytes, hash }) =>
  `<<smelt/${MARKER_FORMAT_VERSION}: ${explanation} (${String(bytes)}B) — retrieve("${hash}")>>`;

/**
 * Line-comment leaders per language: the marker always lands as a comment in the
 * survivor's own syntax, because a bare marker line breaks the syntax of what remains
 * around it — in **every** grammar this was tested against, not just the indented ones.
 *
 * The failure classes, each verified by reparsing a bare-marker survivor:
 *
 *   - **python** — significant indentation means a parse error does not stay local.
 *     The ERROR node swallows the *neighbouring definitions too* — the survivor stops
 *     being Python at all, not just at the marker line.
 *   - **ruby** and **bash** — the marker *begins with* `<<`, which both languages read
 *     as a heredoc operator. A bare marker line opens a heredoc whose terminator never
 *     arrives, and everything after it — every kept declaration — is swallowed into a
 *     string literal.
 *   - **php** — `<<` is an operator here too: the kept function after a bare marker is
 *     re-typed into an anonymous-function operand inside the marker's binary
 *     expression. The kept declaration is no longer a declaration in the survivor.
 *   - **kotlin**, **swift**, and the rest of the brace-delimited set (typescript, tsx,
 *     javascript, rust, go, java, c, cpp, c_sharp) — the folk claim that braces keep a
 *     parse error local is **empirically false**: reparsing each language's fixture
 *     survivor with its own bundled grammar shows ERROR nodes spanning the kept
 *     declarations (a C function's signature absorbed into an ERROR, fifteen cascading
 *     ERRORs in swift, and so on). The survivor-reparse guard in
 *     `test/guards/structural.test.ts` now asserts the opposite property for every
 *     structural language: the survivor reparses with no new issues.
 *
 * Only `'unknown'` keeps the bare marker — lexical text has no syntax to break.
 *
 * This does **not** move the frozen wire surface. The `<<smelt/v1: … >>` core is
 * rendered by {@link defaultMarker}, byte-identical and still versioned in band; the
 * leader is part of the substituted marker text, so `outputRange` covers it and
 * reconstruction stays byte-exact. A comment leader in the survivor's own syntax is
 * the one wrapping that cannot change what a model reads out of the marker.
 *
 * A derived view: each leader is the `markerLeader` fact on the language's
 * {@link LanguageProfile} (`src/lang/`), collected here so marker construction keeps
 * one lookup table.
 */
export const MARKER_LINE_COMMENT_LEADERS: Readonly<Partial<Record<DetectedLanguage, string>>> =
  Object.fromEntries(
    Object.values(LANGUAGE_PROFILES)
      .filter((profile) => profile.markerLeader !== undefined)
      .map((profile) => [profile.id, profile.markerLeader]),
  );

/**
 * The marker builder for a language: {@link defaultMarker}, wrapped in the language's
 * line-comment leader when {@link MARKER_LINE_COMMENT_LEADERS} names one — so a Python
 * survivor still parses as Python. Everything else gets `base` unchanged.
 */
export function markerForLanguage(
  language: DetectedLanguage,
  base: MarkerBuilder = defaultMarker,
): MarkerBuilder {
  const leader = MARKER_LINE_COMMENT_LEADERS[language];
  if (leader === undefined) return base;
  return (info) => `${leader}${base(info)}`;
}

/**
 * A stand-in hash of the real length, so a marker can be priced before the cut that
 * would earn it exists. Marker cost depends on the hash's *length*, never its value.
 */
const PLACEHOLDER_HASH = '0'.repeat(HASH_LENGTH);

/**
 * The one adapter behind the {@link MarkerPricing} seam.
 *
 * Marker cost is this module's fact: `applyPlan` renders the marker, so only this
 * module can price it without guessing. The pricing is built from the **exact builder
 * `applyPlan` will use** — the same resolution, in the same order: a caller-supplied
 * builder (`SmelterConfig.marker` / `ApplyOptions.marker`) wins wholesale, otherwise
 * the language's leader-wrapped default via {@link markerForLanguage}.
 *
 * The custom-builder leg is load-bearing, not a convenience: a caller who installs a
 * longer `MarkerBuilder` changes what every elision costs, and a planner still pricing
 * the *default* marker would keep planning elisions the real marker makes
 * unprofitable — cuts that grow the output, silently. Pricing with the builder's own
 * rendering closes that hole: `costBytes` measures the marker *that builder* would
 * emit, byte for byte.
 *
 * `createSmelter` (and through it, the CLI) calls this centrally, once per smelt call;
 * a caller driving `planLexical`/`planStructural` directly builds its own and puts it
 * on the {@link PlanInput}.
 */
export function markerPricing(
  language: DetectedLanguage = 'unknown',
  markerBuilder?: MarkerBuilder,
): MarkerPricing {
  // The same resolution applyPlan performs: a supplied builder wins wholesale.
  const build = markerBuilder ?? markerForLanguage(language);
  return {
    costBytes: (reason, elidedBytes) =>
      Buffer.byteLength(
        build({
          hash: PLACEHOLDER_HASH,
          bytes: elidedBytes,
          rule: reason.rule,
          explanation: reason.explanation,
        }),
        'utf8',
      ),
  };
}

export interface ApplyOptions {
  /**
   * Overrides the marker builder. The default follows the *plan's* language —
   * {@link markerForLanguage} — so the documented composition
   * `planStructural → applyPlan` lands a `# `-led marker in python without the caller
   * wiring it, the same as `createSmelter` does. A bare {@link defaultMarker} in a
   * python survivor is exactly the parse-breaking failure the leader exists to prevent.
   */
  readonly marker?: MarkerBuilder;
  /** A consumer-supplied counter. See {@link Measure}; the budget stays in bytes. */
  readonly measure?: Measure;
}

/**
 * Turn a plan into text.
 *
 * This is the only function in smelt that removes anything, and it contains no
 * judgement at all: it validates the plan, stores every removed run, substitutes
 * markers, and records where each marker landed. All the deciding happens in a
 * {@link Planner}, which is why a plan can be reviewed before a byte moves.
 *
 * @throws {RangeOutOfBoundsError} if a range falls outside the input's UTF-8 bytes.
 * @throws {OverlappingElisionError} if two ranges overlap — applying both would
 *   corrupt the output, and picking a winner would be a silent guess.
 */
export function applyPlan(
  text: string,
  plan: ElisionPlan,
  store: ElisionStore,
  options: ApplyOptions = {},
): SmeltResult {
  const buildMarker = options.marker ?? markerForLanguage(plan.language);
  const input = Buffer.from(text, 'utf8');

  const ordered = plan.elisions.toSorted((a, b) => a.range.start - b.range.start);
  for (const { range } of ordered) assertInBounds(range, input.length);
  for (let i = 1; i < ordered.length; i += 1) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (current.range.start < previous.range.end) {
      throw new OverlappingElisionError(
        `smelt: plan from "${plan.planner}" elides overlapping ranges ` +
          `[${previous.range.start},${previous.range.end}) and ` +
          `[${current.range.start},${current.range.end}). A plan must be a partition.`,
      );
    }
  }

  const pieces: Buffer[] = [];
  const applied: AppliedElision[] = [];
  let cursor = 0;
  let outputBytes = 0;

  for (const { range, reason, names } of ordered) {
    const kept = input.subarray(cursor, range.start);
    pieces.push(kept);
    outputBytes += kept.length;

    const removed = input.subarray(range.start, range.end);
    const removedText = removed.toString('utf8');
    // Attributed to its rule: this is the one place bytes leave the text, so it is the
    // one place the store learns which rule cut them — the ledger's only source.
    const hash = store.put(removedText, reason);
    const marker = buildMarker({
      hash,
      bytes: removed.length,
      rule: reason.rule,
      explanation: reason.explanation,
    });
    const markerBuffer = Buffer.from(marker, 'utf8');
    pieces.push(markerBuffer);

    applied.push({
      hash,
      range,
      outputRange: { start: outputBytes, end: outputBytes + markerBuffer.length },
      bytes: removed.length,
      reason,
      marker,
      // The outline rides beside the marker, never inside it: `buildMarker` above was
      // handed the reason and nothing else, so the wire surface and its priced cost
      // are the same with or without names.
      ...(names === undefined ? {} : { names }),
    });
    outputBytes += markerBuffer.length;
    cursor = range.end;
  }

  const tail = input.subarray(cursor);
  pieces.push(tail);
  outputBytes += tail.length;

  const output = Buffer.concat(pieces).toString('utf8');
  const measure = options.measure;

  return {
    text: output,
    inputBytes: input.length,
    outputBytes,
    planner: plan.planner,
    language: plan.language,
    elisions: applied,
    ...(measure === undefined
      ? {}
      : {
          measured: {
            measure: measure.id,
            unit: measure.unit,
            input: measure.count(text),
            output: measure.count(output),
          },
        }),
  };
}

/**
 * Put it all back. `reconstruct(smelt(x), store) === x`, byte for byte — this is Law 3
 * expressed as an executable equation, and `test/guards/reversibility.test.ts` asserts
 * it on every input the suite knows about.
 *
 * Reads through `peek`, **not** `retrieve`: `retrieveCalls` and the expansion rate
 * exist to count *the model asking for hidden material back* — the honest signal this
 * whole project sells. A caller reassembling the original (to diff it, to verify a
 * round trip, to write it to disk) is not that, and counting it would inflate the one
 * number that must never flatter. The guard in
 * `test/guards/expansion-counter.test.ts` pins this: reconstruction leaves every
 * counter exactly where it was.
 *
 * @throws {UnknownHashError} if the store no longer holds an elision's bytes.
 */
export function reconstruct(result: SmeltResult, store: ElisionStore): string {
  const output = Buffer.from(result.text, 'utf8');
  const ordered = result.elisions.toSorted((a, b) => a.outputRange.start - b.outputRange.start);
  const pieces: Buffer[] = [];
  let cursor = 0;

  for (const elision of ordered) {
    assertInBounds(elision.outputRange, output.length);
    const content = store.peek(elision.hash);
    if (content === undefined) throw new UnknownHashError(elision.hash);
    pieces.push(output.subarray(cursor, elision.outputRange.start));
    pieces.push(Buffer.from(content, 'utf8'));
    cursor = elision.outputRange.end;
  }
  pieces.push(output.subarray(cursor));

  return Buffer.concat(pieces).toString('utf8');
}

function assertInBounds(range: ByteRange, length: number): void {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end > length ||
    range.start >= range.end
  ) {
    throw new RangeOutOfBoundsError(
      `smelt: range [${range.start},${range.end}) is not a non-empty range inside ` +
        `${String(length)} bytes.`,
    );
  }
}
