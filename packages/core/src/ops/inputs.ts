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

/**
 * The budget law — required, a whole number, greater than zero — lives beside the
 * budget arithmetic in `plan/budget.ts` since review IV (REP-54): it is a fact about
 * Budgets, not about argv, and the two library entry points a consumer calls
 * (`createSmelter`, `buildRepoMap`) state it from there too. Re-exported here so the
 * front doors keep reaching it through the seam.
 */
export { budgetFault, budgetMalformed, budgetRequired } from '../plan/budget.ts';
export type { BudgetFault, BudgetNaming } from '../plan/budget.ts';

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
