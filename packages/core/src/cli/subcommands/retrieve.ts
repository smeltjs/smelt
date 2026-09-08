import { CliUsageError } from '../../errors.ts';
import { openStore } from '../../ops/inputs.ts';
import { retrieveBytes } from '../../ops/verbs.ts';
import { CONFIG_FILE_NAME, configuredStore } from '../config.ts';
import type { LoadedConfig } from '../config.ts';
import { CLI_NAME, EXIT } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues } from './flags.ts';
import type { ConfigSource, Subcommand } from './subcommand.ts';

/**
 * `smelt retrieve <hash>` — the marker's `retrieve("hash")`, as a real command.
 *
 * The exact original bytes go to stdout and **nothing else does**: no report, no
 * trailing newline the store did not hold, no re-encoding. Trailing-newline fidelity
 * is not pedantry — the retrieved bytes get spliced back into reasoning about the
 * original, and an almost-right blob is the silent wrong answer this project refuses.
 *
 * The retrieval IS counted — that is the point. `store.retrieve()` journals the hit,
 * so an agent working from pure shell moves the same `expansionRate` a tool-calling
 * consumer moves, and over-pruning stays visible whichever loop is in use. Errors are
 * the store's own, verbatim: `UnknownHashError` for a hash never elided,
 * `StoreCorruptionError` for bytes that no longer hash to their name — distinct
 * texts, both exiting {@link EXIT.refused}.
 */

/**
 * `smelt retrieve <hash>` — parsed. A sibling shape, not a field on somebody else's:
 * nothing but the hash, because the command's whole contract is "hash in, exact bytes
 * out" — the same contract as the `smelt_retrieve` tool, reachable from a shell.
 */
export interface RetrieveInvocation {
  readonly mode: 'retrieve';
  /** The hash exactly as the marker printed it. Validated by the store, not here. */
  readonly hash: string;
}

/**
 * Everything `smelt retrieve` and `smelt stats` need from the config, fully merged:
 * the persistent store's directory, already resolved against the config file. The
 * third `Resolved*Run`, and the only one two verbs share — because they share the
 * whole of it: no budget, no strategy, no file leg at all, only the store leg, which
 * is config-only. `stats` resolves through {@link resolveStoreRun} rather than
 * restating it.
 */
export interface ResolvedStoreRun {
  /** Absolute path of the directory store, resolved against the config file. */
  readonly storePath: string;
}

/**
 * What `retrieve` runs on: the shared store leg, plus the hash this invocation named.
 * A composition rather than a wider {@link ResolvedStoreRun}, because `stats` shares
 * the store leg and has no hash — a field that is meaningless for half its users is
 * how a shared struct starts lying.
 */
export interface ResolvedRetrieveRun {
  readonly store: ResolvedStoreRun;
  readonly hash: string;
}

export const retrieveCommand: Subcommand<RetrieveInvocation, ResolvedRetrieveRun> = {
  name: 'retrieve',
  flags: [],
  refusal:
    `retrieve prints the exact original bytes for one hash, nothing else — even ` +
    `--json would wrap what must come back verbatim.`,
  usage: {
    synopsis: ['retrieve <hash>'],
    section: {
      heading: 'RETRIEVE & STATS',
      body:
        `  Every marker carries the hash of the bytes it replaced — <<smelt/v1: … —\n` +
        `  retrieve("hash")>> — and the marker's retrieve("hash") is this command:\n` +
        `  ${CLI_NAME} retrieve <hash> prints the exact original bytes on stdout, byte for\n` +
        `  byte, nothing else. That closes the loop from pure shell: an agent that got a\n` +
        `  marker asks for the bytes back with a command instead of a tool call, and the\n` +
        `  retrieval is counted — asking for material back is exactly what the expansion\n` +
        `  rate measures. An unknown hash and damaged bytes are distinct refusals (exit 3):\n` +
        `  "never elided" and "the store was corrupted" call for different responses.`,
    },
  },

  /**
   * The hash and nothing else. Every flag is refused by the registry's one generated
   * message rather than ignored — the command prints the exact original bytes on
   * stdout and nothing more, so a flag that changed the output would break the one
   * contract it has, and a flag silently dropped would be a setting the user believed
   * was in force.
   */
  parse(_values: FlagValues, positionals: readonly string[]): RetrieveInvocation {
    if (positionals.length !== 2) {
      throw new CliUsageError(
        `${CLI_NAME}: retrieve needs exactly one hash — the one a marker printed.\n` +
          `  ${CLI_NAME} retrieve 84998967370f38bc`,
      );
    }
    return { mode: 'retrieve', hash: positionals[1]! };
  },

  resolve(invocation: RetrieveInvocation, config: ConfigSource): ResolvedRetrieveRun {
    return { store: resolveStoreRun('retrieve', config()), hash: invocation.hash };
  },

  run(resolved: ResolvedRetrieveRun, io: CliIo): number {
    const store = openStore({ kind: 'directory', path: resolved.store.storePath });
    io.stdout(retrieveBytes({ store, hash: resolved.hash }));
    return EXIT.ok;
  },
};

/**
 * The store leg alone, for the three commands whose entire job is the store between
 * runs. The refusal is the point: `retrieve` exists so the marker's
 * `retrieve("hash")` works from a later shell — cross-run retrieval — and a memory
 * store dies with the process that filled it, so with a memory store (or no config
 * at all) there is nothing those commands could honestly read. Answering with
 * `UnknownHashError` or all-zero stats instead would be the quiet wrong answer this
 * project refuses everywhere: the hash *was* elided, the counters *did* move — in a
 * store that no longer exists.
 *
 * **This is a policy, not a law, which is why it stays here and is not exported.** The
 * shared half — a config's store decision (`configuredStore`) and opening it
 * (`openStore` in `ops/inputs.ts`) — is what every consumer needs and now what every
 * consumer imports. This function is the CLI's ruling *on top of* that decision, and
 * the MCP server deliberately rules the other way: it accepts a memory store, serves
 * the whole session from it, and says how to get persistence at the moment an unknown
 * hash makes the difference visible. Exporting this would offer that server the CLI's
 * refusal wearing the name of a shared law — the fork this seam exists to end, running
 * in the other direction.
 *
 * @throws {CliUsageError} when no config exists, or the configured store is memory.
 */
export function resolveStoreRun(
  command: 'retrieve' | 'stats' | 'store prune',
  config: LoadedConfig | undefined,
): ResolvedStoreRun {
  const store = configuredStore(config);
  if (store.kind !== 'directory') {
    const state =
      config === undefined
        ? `there is no ${CONFIG_FILE_NAME} here`
        : `the ${CONFIG_FILE_NAME} at ${config.path} uses a memory store`;
    throw new CliUsageError(
      `${CLI_NAME}: ${command} needs a persistent store, and ${state}. Cross-run ` +
        `retrieval is the point of the store: a memory store dies with the process ` +
        `that made it, so a marker's hash from an earlier run names bytes this run ` +
        `never held. Configure {"store": {"kind": "directory", "path": …}} in ` +
        `${CONFIG_FILE_NAME} — \`${CLI_NAME} init\` writes one.`,
    );
  }
  return { storePath: store.path };
}
