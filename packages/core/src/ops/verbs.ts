import { buildRepoMap } from '../repomap/map.ts';
import type { RepoMap } from '../repomap/map.ts';
import { retrieveEach } from '../retrieve.ts';
import { createSmelter } from '../smelter.ts';
import type { Strategy } from '../plan/planners.ts';
import type {
  DetectedLanguage,
  ElisionStore,
  RetrievedBlock,
  RetrieveStats,
  SmeltResult,
} from '../types.ts';

/**
 * The four verbs, as library functions over already-resolved inputs.
 *
 * This is the seam that sits **below both front doors**. The `smelt` CLI and the
 * `@smeltjs/mcp` server are the same four operations wearing two different coats, and
 * before this file existed each of them owned a full copy of the middle: build a
 * smelter from a strategy and a store, call it, hand the totals to a report; stat a
 * directory, build a map, render its warnings; retrieve one hash; read the counters.
 * The library exported the pieces, so both copies were *correct* — and both had to be
 * edited, in two packages, for one change to how a verb runs.
 *
 * What an op takes is already resolved: a budget that survived its law, a strategy
 * that won its precedence, a store that has been opened, text that has been read. What
 * an op returns is data — the smelted text and the values a report needs, a
 * {@link RepoMap}, bytes, counters. An op never sees argv, never writes to a stream,
 * never returns an exit code, and knows nothing about `CallToolResult`. Those are the
 * adapters' four jobs, and keeping them out here is what makes the same operation
 * testable once instead of twice.
 *
 * The division of labour, in one line: **a front door parses and resolves, an op runs,
 * a front door renders.**
 */

/** One blob to smelt, fully resolved. */
export interface SmeltBlobOp {
  /** The text itself. Reading a file into it is the front door's job (`readBlob`). */
  readonly text: string;
  /** What to call the input in a report: a path, `'<stdin>'`, `'<text>'`. */
  readonly source: string;
  /** UTF-8 bytes. Already past the budget law — see `ops/inputs.ts`. */
  readonly budgetBytes: number;
  /** Already past its precedence — see `resolveStrategy` in `ops/inputs.ts`. */
  readonly strategy: Strategy;
  /**
   * Where elided bytes go. Optional only so a caller with nothing to persist gets the
   * library's own default (a fresh {@link MemoryElisionStore}); a front door that read
   * a config opens the store it decided on and passes it.
   */
  readonly store?: ElisionStore;
  /** The path the text came from, for language detection. Absent for a pasted blob. */
  readonly path?: string;
  /** Overrides detection entirely, when a surface offers that. */
  readonly language?: DetectedLanguage;
  /** What the task is about. Empty and absent mean the same thing to every planner. */
  readonly focus?: readonly string[];
}

/**
 * What one smelt run produced.
 *
 * The fields a report needs are the fields `formatReport` takes, deliberately: an op
 * returns exactly the values the render step reads off, so no front door assembles a
 * report input by hand and no front door counts a byte itself. (`formatReport(outcome)`
 * typechecks as written.) The store comes back too, because the `--json` envelope has
 * to `peek` at the bytes the run just stored, and a caller that passed no store never
 * had a handle on the one the library made.
 */
export interface SmeltBlobOutcome {
  readonly result: SmeltResult;
  /** What the input was called. Echoed back so a report never re-derives it. */
  readonly source: string;
  /** The budget the run was given, so a report can say when it was missed. */
  readonly budgetBytes: number;
  /** The exact text that was smelted. */
  readonly inputText: string;
  /** The store the run actually used — the one passed in, or the library's default. */
  readonly store: ElisionStore;
}

/**
 * Verb: **cut one blob to a budget.**
 *
 * Every refusal the library can raise passes straight through — a `structural` run on
 * a language with no bundled grammar throws `GrammarUnavailableError` here exactly as
 * it does anywhere else, because a planner that quietly fell back to line windows
 * would be undetectable from outside. Coming back *over budget* is not a refusal and
 * not an error: the plan is returned as it came back, and whether that deserves a
 * non-zero exit code is a question only a front door can answer.
 */
export async function smeltBlob(op: SmeltBlobOp): Promise<SmeltBlobOutcome> {
  const smelter = createSmelter({
    strategy: op.strategy,
    ...(op.store === undefined ? {} : { store: op.store }),
  });
  const result = await smelter.smelt(op.text, {
    budgetBytes: op.budgetBytes,
    ...(op.path === undefined ? {} : { path: op.path }),
    ...(op.language === undefined ? {} : { language: op.language }),
    ...(op.focus === undefined || op.focus.length === 0 ? {} : { focus: op.focus }),
  });
  return {
    result,
    source: op.source,
    budgetBytes: op.budgetBytes,
    inputText: op.text,
    store: smelter.store,
  };
}

/** One tree to map, fully resolved. */
export interface MapTreeOp {
  /** A directory. Proving it is one is the front door's job (`readTree`). */
  readonly root: string;
  /** UTF-8 bytes. The map fits itself to this by construction. */
  readonly budgetBytes: number;
  readonly focus?: readonly string[];
  /** Replaces the built-in ignore list when present. */
  readonly ignore?: readonly string[];
  /** Only when present does the map write anything to disk. */
  readonly cacheDir?: string;
}

/**
 * Verb: **map a whole tree inside a budget.**
 *
 * Returns the {@link RepoMap} itself — the map *is* the data, warnings and cache
 * counts included, and wrapping it in an outcome struct would only give two front
 * doors a second place to disagree about what a map is. Nothing is elided, stored or
 * reversible, so there is nothing here to retrieve and no over-budget case to report.
 */
export function mapTree(op: MapTreeOp): Promise<RepoMap> {
  return buildRepoMap({
    root: op.root,
    budgetBytes: op.budgetBytes,
    ...(op.focus === undefined || op.focus.length === 0 ? {} : { focus: op.focus }),
    ...(op.ignore === undefined || op.ignore.length === 0 ? {} : { ignore: op.ignore }),
    ...(op.cacheDir === undefined ? {} : { cacheDir: op.cacheDir }),
  });
}

/** One hash to turn back into bytes. */
export interface RetrieveBytesOp {
  /** The store holding them — already opened. See `openStore` in `ops/inputs.ts`. */
  readonly store: ElisionStore;
  /** The hash exactly as a marker printed it. Validated by the store, not here. */
  readonly hash: string;
}

/**
 * Verb: **the counted read.**
 *
 * Thin on purpose, and named anyway: this is the expansion rate moving. `retrieve()`
 * journals the hit, so a shell user typing `smelt retrieve` and a model calling
 * `smelt_retrieve` move the same counter through the same call — which is the only
 * reason the number means anything. The exact original bytes come back, nothing
 * appended and nothing re-encoded, and an unknown or damaged hash throws the store's
 * own distinct error rather than an empty string.
 *
 * @throws {UnknownHashError} for a hash the store never held.
 * @throws {StoreCorruptionError} for bytes that no longer hash to their name.
 */
export function retrieveBytes(op: RetrieveBytesOp): string {
  return op.store.retrieve(op.hash);
}

/** Several hashes to turn back into bytes, in one call. */
export interface RetrieveManyOp {
  /** The store holding them — already opened. */
  readonly store: ElisionStore;
  /** The hashes exactly as the markers printed them, in the order the blocks come back. */
  readonly hashes: readonly string[];
}

/**
 * Verb: **the counted read, N at a time.**
 *
 * The batched sibling of {@link retrieveBytes}, and the reason it is a verb of its own
 * is tier 4 of the bench: every retrieval is a new request, input tokens are billed
 * per request, and on five of nine cases the smelted arm's *summed* input exceeded the
 * raw arm's because each one-hash call re-billed the transcript. One call for N blocks
 * changes what an expansion costs, and deliberately nothing about what it *means*:
 * the loop calls `store.retrieve` per hash, so each hit and each miss journals exactly
 * as a single call would, and the expansion rate reads the same either way.
 *
 * A refusal rides inside its block rather than failing the batch — the model that
 * asked for eighteen blobs and typo'd one still gets the seventeen, and the one refusal
 * is the store's own distinct error. An empty list is an empty answer, and moves nothing.
 */
export function retrieveMany(op: RetrieveManyOp): readonly RetrievedBlock[] {
  return retrieveEach(op.store, op.hashes);
}

/** One store to read the counters off. */
export interface ReadCountersOp {
  readonly store: ElisionStore;
}

/**
 * Verb: **the uncounted read.**
 *
 * The sibling of {@link retrieveBytes}, and the asymmetry is the point: `stats()`
 * folds the journal without writing to it, so watching the expansion rate can never
 * move it. An observer that inflated its own metric would make the honest signal
 * dishonest.
 */
export function readCounters(op: ReadCountersOp): RetrieveStats {
  return op.store.stats();
}
