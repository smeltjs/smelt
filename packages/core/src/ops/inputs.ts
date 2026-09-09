import { readFileSync, statSync } from 'node:fs';

import type { ConfiguredStore } from '../config.ts';
import { DEFAULT_STRATEGY } from '../plan/planners.ts';
import type { Strategy } from '../plan/planners.ts';
import { MemoryElisionStore } from '../store.ts';
import { DirectoryElisionStore } from '../store-dir.ts';
import type { ElisionStore } from '../types.ts';

/**
 * The laws an operation's input must satisfy — stated once, for every front door.
 *
 * Each rule here was, until this seam existed, written twice: once in a
 * `cli/subcommands/*` verb and once in the MCP server's tool handlers. Two copies of a
 * law is two laws, and the copies had already begun to differ — the `smelt` CLI and
 * the `smelt_file` tool refuse a missing budget with the same reasoning in two
 * separately-maintained sentences, and only one of them was ever edited at a time.
 *
 * **What is shared and what is not.** A law has two halves, and only one of them can
 * be shared honestly:
 *
 *   - the **rule and its reasoning** — that a budget is a whole number of bytes
 *     greater than zero, that there is no default and why, that a tree-reader refuses
 *     a file, that a strategy falls back to `lexical` last. That half lives here.
 *   - the **naming** — a CLI spells its budget `--budget` and points at
 *     `smelt.config.json`; a tool spells it `"budgetBytes"` and points at nothing.
 *     That half is the front door's own, and every function here takes it as an
 *     argument rather than guessing.
 *
 * Nothing here throws. The two front doors refuse in different currencies — the CLI
 * with a {@link CliUsageError} that exits 2, the MCP server with a tool-level error
 * carrying `isError: true` — and a shared law that threw would force one of them to
 * catch and re-wrap the other's error type, which is how an exit code changes by
 * accident. So a law that can refuse returns a {@link Ruling}: the value, or the one
 * sentence that refuses it, for the caller to throw in its own currency.
 *
 * Nothing here *finds* a `smelt.config.json` either. Config discovery is a CLI
 * concern by design (see `config.ts`); {@link openStore} takes a decision that
 * has already been made and opens it, so no library call's behaviour depends on the
 * directory it was invoked from.
 */

/**
 * The answer to a law that can refuse: the value, or the one sentence refusing it.
 *
 * Deliberately not an exception — see the module comment. The refusal is the
 * complete sentence *minus* whatever prefix the front door puts on its own errors
 * (`smelt: ` for the CLI, the tool name for MCP), because that prefix is naming, and
 * naming belongs to the caller.
 */
export type Ruling<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly refusal: string };

/** How one front door spells the budget it is refusing, and what it points at next. */
export interface BudgetNaming {
  /** The knob, as this surface spells it: `--budget`, `"budgetBytes"`. */
  readonly knob: string;
  /**
   * What a budget smelt invented would silently decide — the back half of the
   * no-default sentence. `'your context to throw away'` for a blob run, `'the map to
   * leave out'` for a tree.
   */
  readonly stake: string;
  /**
   * Anything this surface adds after the law: where else the value can come from, and
   * an example. Appended after a single space. The CLI names `defaultBudgetBytes` and
   * `smelt init` here; a tool whose schema already says `required` adds nothing.
   */
  readonly advice?: string;
}

/**
 * Law: **a budget is required, and there is no default.**
 *
 * The reasoning is the whole point of the sentence, so it is stated once here rather
 * than paraphrased per surface: a budget smelt invented would silently decide how much
 * of the caller's context to throw away, which is a number nobody measured making a
 * decision nobody made.
 */
export function budgetRequired(naming: BudgetNaming): string {
  return (
    `${naming.knob} is required, in UTF-8 bytes. There is no default, because a budget ` +
    `smelt invented would silently decide how much of ${naming.stake}.` +
    (naming.advice === undefined ? '' : ` ${naming.advice}`)
  );
}

/** The two ways a budget that *was* given can still be wrong. See {@link budgetFault}. */
export type BudgetFault = 'not-an-integer' | 'not-positive';

/**
 * Law: **a budget is a whole number of UTF-8 bytes greater than zero.**
 *
 * The numeric half only. Getting a candidate *number* out of a surface is that
 * surface's own lexing and stays there: argv carries strings (`--budget 4kb` is a
 * malformed number, and `-1` never reaches here because a leading `-` is not a
 * budget at all), while a JSON tool argument carries whatever type the model sent.
 * Both then ask this function the same question about the same rule.
 */
export function budgetFault(value: number): BudgetFault | undefined {
  if (!Number.isInteger(value)) return 'not-an-integer';
  if (value <= 0) return 'not-positive';
  return undefined;
}

/**
 * The sentence for a {@link BudgetFault}, naming the value it rejected.
 *
 * `got` is rendered with `JSON.stringify`, which is what both front doors already
 * printed: a CLI passes the raw argv word and gets it back quoted (`"4kb"`), a tool
 * passes the raw JSON value and gets numbers bare (`0`) and strings quoted. One
 * renderer, because a value echoed back in a different shape than it was written is a
 * value the author has to translate before they can see their own typo.
 */
export function budgetMalformed(fault: BudgetFault, knob: string, got: unknown): string {
  return fault === 'not-an-integer'
    ? `${knob} must be a whole number of bytes, got ${JSON.stringify(got)}.`
    : `${knob} must be greater than zero, got ${JSON.stringify(got)}.`;
}

/**
 * The strategy a run falls back to when neither the caller nor a config names one.
 *
 * Re-exported rather than restated: {@link DEFAULT_STRATEGY} is the planner registry's
 * own fact, and a second spelling here would be the fork this seam exists to close.
 */
export { DEFAULT_STRATEGY } from '../plan/planners.ts';

/** Where a resolved strategy came from — the receipt {@link resolveStrategy} returns. */
export type StrategySource = 'flag' | 'config' | 'builtin';

/** A strategy, with the provenance that explains it. */
export interface ResolvedStrategy {
  readonly strategy: Strategy;
  readonly source: StrategySource;
}

/**
 * Law: **an explicit strategy wins over a configured one, and `lexical` fills last.**
 *
 * Both front doors had this precedence written out, and both spelled the built-in
 * `'lexical'` inline — so a sixth planner promoted to the default would have been a
 * two-package edit with no compiler and no test to notice half of it. `chosen` is
 * whatever the caller said explicitly (a `--strategy` flag, a `"strategy"` argument);
 * `configured` is what the nearest `smelt.config.json` says. Validating the name is
 * *not* part of this law — membership in the `PLANNERS` registry (`isStrategy`) is
 * that, already shared, and the sentence each surface refuses an unknown name with is
 * its own register: a flag and a JSON argument do not read alike.
 */
export function resolveStrategy(
  chosen: Strategy | undefined,
  configured: Strategy | undefined,
): ResolvedStrategy {
  if (chosen !== undefined) return { strategy: chosen, source: 'flag' };
  if (configured !== undefined) return { strategy: configured, source: 'config' };
  return { strategy: DEFAULT_STRATEGY, source: 'builtin' };
}

/**
 * Law: **read a path, or fail naming it.**
 *
 * `shownAs` is the path as its author wrote it, which is not always the path opened:
 * a tool resolves a relative argument against the server's working directory, and
 * echoing back the absolute result would answer a question nobody asked. The cause is
 * carried through verbatim — an `EACCES` and an `ENOENT` call for different
 * responses, and flattening them to "could not read" throws that away.
 */
export function readBlob(fullPath: string, shownAs: string): Ruling<string> {
  try {
    return { ok: true, value: readFileSync(fullPath, 'utf8') };
  } catch (cause) {
    return { ok: false, refusal: `cannot read "${shownAs}": ${describe(cause)}` };
  }
}

/** How one front door names the tree verb and its single-file sibling. */
export interface TreeNaming {
  /** The whole-tree reader, as this surface spells it: `map`, `repo_map`. */
  readonly tree: string;
  /** Where to go for one file instead: `` `smelt <file>` ``, `smelt_file`. */
  readonly file: string;
}

/**
 * Law: **a tree reader reads a directory, and says so when handed a file.**
 *
 * Two distinct refusals, kept distinct: a path that cannot be statted at all
 * (misspelled, unreadable) and a path that is a perfectly good *file*. The second is
 * the interesting one — it is a caller who wanted the other verb, so the refusal
 * names the other verb instead of leaving them to guess which of their two options
 * was wrong.
 */
export function readTree(fullPath: string, shownAs: string, naming: TreeNaming): Ruling<string> {
  let isDirectory: boolean;
  try {
    isDirectory = statSync(fullPath).isDirectory();
  } catch (cause) {
    return { ok: false, refusal: `cannot read directory "${shownAs}": ${describe(cause)}` };
  }
  if (!isDirectory) {
    return {
      ok: false,
      refusal:
        `"${shownAs}" is not a directory. ${naming.tree} reads a whole tree; for one ` +
        `file, use ${naming.file}.`,
    };
  }
  return { ok: true, value: fullPath };
}

/**
 * Law: **a store decision, opened.**
 *
 * The *decision* — which kind, and where — is `configuredStore()` in `config.ts`,
 * one reading of one config key. This is the other half: turning that decision into a
 * live {@link ElisionStore}. It was the missing half. The MCP package needed exactly
 * this and could not import it, so it re-derived the decision *and* the construction
 * from the config keys directly, and a second reading of `store.kind` came into
 * existence in another package.
 *
 * What each front door does with a memory store stays the front door's: `smelt
 * retrieve` and `smelt stats` refuse one (a marker's hash from an earlier run names
 * bytes no memory store ever held), while the MCP server accepts one and says so at
 * the moment it bites. That divergence is deliberate and documented; it is a policy
 * about a store, not a fact about opening one.
 */
export function openStore(decision: ConfiguredStore): ElisionStore {
  return decision.kind === 'memory'
    ? new MemoryElisionStore()
    : new DirectoryElisionStore(decision.path);
}

/** A thrown cause as one line, without pretending an unknown throw was an Error. */
function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
