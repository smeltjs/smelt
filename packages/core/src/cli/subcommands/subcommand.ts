import type { LoadedConfig } from '../../config.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues, VerbFlag } from './flags.ts';

/**
 * The verbs `smelt` answers to. `'smelt'` is the default verb — the bare
 * `smelt <file>` / `smelt < input` run — and is the only one with no word on the
 * command line, which is why a file literally named `map` needs `./map`.
 *
 * Order is meaningful: it is the order `--help` renders every derived list in, and the
 * order a refusal names owners in. Keep it stable and append new verbs at the end.
 */
export type Verb =
  | 'smelt'
  | 'init'
  | 'map'
  | 'retrieve'
  | 'stats'
  | 'hooks'
  | 'agents'
  | 'setup'
  | 'doctor'
  | 'store';

/** The verb a bare invocation selects — a file or stdin, with no subcommand word. */
export const DEFAULT_VERB = 'smelt' satisfies Verb;

/**
 * The nearest `smelt.config.json`, loaded on demand.
 *
 * A thunk rather than a value, because two verbs must **not** load it: `init` and
 * `hooks` read the config file themselves, with their own tolerance, and a wizard you
 * run to *fix* a malformed config cannot be a wizard that refuses to start because the
 * config is malformed. Loading eagerly in the dispatcher would quietly turn that into
 * a usage error.
 */
export type ConfigSource = () => LoadedConfig | undefined;

/** What one verb contributes to `--help`. See `cli/usage.ts` for the rendering. */
export interface SubcommandUsage {
  /**
   * The command's everyday forms, rendered in the first block of USAGE in registry
   * order. Each entry is the text *after* the CLI name.
   */
  readonly synopsis: readonly string[];
  /**
   * Forms rendered in the second block, after every command's everyday forms: the
   * round trip (`--reconstruct`) and the one-time setup (`init`) — jobs you do
   * occasionally rather than the shape of a normal run. It keeps USAGE reading
   * top-to-bottom by how often you type a thing without anyone arranging the list.
   */
  readonly occasional?: readonly string[];
  /**
   * The verb's own section of the help — a heading and its body, already indented.
   * Two verbs may declare the same heading (`retrieve` and `stats` share RETRIEVE &
   * STATS, because the loop is one story); their bodies are joined under it in
   * registry order.
   */
  readonly section?: { readonly heading: string; readonly body: string };
}

/**
 * One subcommand: everything the CLI knows about one verb, in one place.
 *
 * This is the seam the CLI was missing. A verb used to be a *shape* restated in four
 * modules — an `*Invocation` interface and a `parse*Args` in `cli/args.ts`, a
 * `Resolved*Run` and a `resolve*` in `cli/resolve.ts`, a `case` and a `run*` in
 * `cli/run.ts`, plus a hand-written help block and a hand-written refusal for every
 * flag it did not want. The refusals were the compounding cost: because no verb owned
 * its flags, every verb refused every other verb's flags by hand, so an eleventh flag
 * edited five messages.
 *
 * Now a verb is one file exporting one of these, and `SUBCOMMANDS` in `./registry.ts`
 * is `Record<Verb, …>` — the {@link LANGUAGE_PROFILES} / {@link HARNESS_PROFILES}
 * pattern, so totality is a compile error and every rendered list (USAGE, the sections,
 * the `map only.` prefixes in OPTIONS) is a derived view.
 *
 * The type parameters are the verb's own two shapes, and they never merge:
 *
 * @typeParam I - what the verb's `parse` returns, e.g. `MapInvocation`. Pure data, so
 *   the parse is testable on its own.
 * @typeParam R - what its `resolve` returns, e.g. `ResolvedMapRun`. The verb's single
 *   merge of flags + config + built-ins, each value carrying its provenance. Deliberately
 *   one type per verb: `map` has no store, no strategy and no stdin, and a shared struct
 *   whose fields are lies for half its users is not a seam, it is a coincidence.
 */
export interface Subcommand<I, R> {
  /** The word on the command line — and the registry key. `'smelt'` has no word. */
  readonly name: Verb;
  /**
   * The flags this verb owns. **The whole point.** Every flag outside this list is
   * refused by one generated message (`refuseForeignFlags` in `./registry.ts`) rather
   * than by prose the next verb has to write again. A flag silently ignored would be a
   * setting the user believed was in force.
   */
  readonly flags: readonly VerbFlag[];
  /**
   * What this verb *is*, as one sentence — the tail of the generated refusal, and the
   * only part of it a verb writes. It answers "why not here?", which is the half of
   * the old hand-written messages worth keeping; the offending flag, this verb's name
   * and the verb the flag does belong to are all derived from the registry.
   */
  readonly refusal: string;
  /** What this verb contributes to `--help`. Rendered, never hand-arranged. */
  readonly usage: SubcommandUsage;
  /**
   * The verb's own validation, over the flags it owns and the positionals it was
   * given (index 0 is the verb word itself, except for the default verb).
   *
   * @throws {CliUsageError} on anything the user got wrong. Never guesses.
   */
  parse(values: FlagValues, positionals: readonly string[]): I;
  /**
   * The verb's single merge of flags + config + built-ins. Precedence for this verb
   * lives here and nowhere else, so a precedence question is answered by one function
   * instead of by reading two files.
   *
   * @throws {CliUsageError} when a required value has no source — the budget, for the
   *   two verbs that need one.
   */
  resolve(invocation: I, config: ConfigSource): R;
  /** Execute the resolved run straight-line, and return the exit code. */
  run(resolved: R, io: CliIo): number | Promise<number>;
}
