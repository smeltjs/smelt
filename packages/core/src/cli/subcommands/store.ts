import { CONFIG_FILE_NAME } from '../../config.ts';
import type { SmeltConfigRetention, SmeltConfigStore } from '../../config.ts';
import { CliUsageError } from '../../errors.ts';
import { SETUP_RECIPE } from '../../setup/recipe.ts';
import { CUTOFF_HELP, readCutoff } from '../../store-cutoff.ts';
import { DirectoryElisionStore } from '../../store-dir.ts';
import type { PruneReport } from '../../store-dir.ts';
import { stdoutPalette } from '../lava.ts';
import { formatPruneReport } from '../report.ts';
import { CLI_NAME, EXIT } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues } from './flags.ts';
import { resolveStoreRun } from './retrieve.ts';
import type { ResolvedStoreRun } from './retrieve.ts';
import type { ConfigSource, Subcommand } from './subcommand.ts';

/**
 * `smelt store prune` — the only thing in smelt that deletes an elision.
 *
 * **The deletion stays explicit; the number may be written down.** One global store
 * shared by every session accumulates blobs forever, which is a real problem; the
 * answers that would have solved it quietly — a size cap, an LRU, a TTL applied on open
 * — all solve it by having smelt decide which of someone else's elisions stopped
 * mattering, at a moment they did not choose, with no record of what went. Law 3 says
 * every elision is reversible and counted; "reversible until a background rule got to
 * it" is a different, smaller promise.
 *
 * So the deletion happens only when a user types this verb — nothing here runs on a
 * timer, on a size cap, or when a store is opened — and it leaves a receipt: the store
 * journals `evict "<hash>" "<date>"` before it unlinks, and a later `smelt retrieve` of
 * an evicted hash exits 3 with {@link EvictedHashError} — "you pruned it on <date>",
 * never "it was never elided". `--dry-run` is the same measurement with none of the
 * deleting, and it comes first in the help for that reason.
 *
 * What *is* allowed to be a default is the **cut-off**, because a cut-off is a number
 * and not a deletion. `store.retention.olderThan` in `smelt.config.json` is a user
 * writing down the age they always mean, in a file they own, and reading it costs
 * nobody a byte until they type the verb again. `--older-than` still wins over it, and
 * with neither present the verb refuses and names both — a cut-off *smelt* invented
 * would be the thing this doctrine actually forbids. The receipt says which one won.
 *
 * It refuses a memory store exactly as `retrieve` and `stats` do, through the same
 * {@link resolveStoreRun}: pruning a store that dies with its own process is a deletion
 * with nothing to delete.
 */

/** `smelt store prune --older-than <age> [flags]` — parsed. */
export interface StoreInvocation {
  readonly mode: 'store';
  /** The only action today. A union so a second one is a compile error, not a string. */
  readonly action: 'prune';
  /**
   * The cut-off exactly as typed, e.g. `30d` — echoed in the report, not re-derived.
   * `undefined` when the flag was not given, which is no longer an error on its own:
   * {@link resolveRetention} may find one written down in `smelt.config.json`.
   */
  readonly olderThan?: string;
  /**
   * Milliseconds the cut-off is worth, read once here through {@link readCutoff} so a
   * malformed `--older-than` is refused at parse time, beside every other flag.
   * Present exactly when {@link olderThan} is.
   */
  readonly olderThanMs?: number;
  readonly keepRetrieved: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}

/**
 * Which of the two places a cut-off may be written won this run — the same
 * flag-over-config provenance shape `ResolvedRun.strategySource` carries, minus
 * `'builtin'`, because there is no built-in cut-off and there will not be one.
 */
export type CutoffSource = 'flag' | 'config';

/**
 * Where the sparing came from — `--keep-retrieved`, `store.retention.keepRetrieved`, or
 * both, or nothing.
 *
 * Its own type rather than a reuse of {@link CutoffSource}, because the two merge
 * differently and saying so in the type is cheaper than a comment. A cut-off has one
 * winner; sparing is a **union**, so `'both'` is a real answer and not a hedge — and
 * `'none'` is what a prune that spared nothing reports, distinct from a prune that
 * spared on the flag alone. A user asking "why did this keep blobs I did not name" is
 * asking exactly this question.
 */
export type KeepRetrievedSource = 'flag' | 'config' | 'both' | 'none';

/** What `store prune` runs on: the shared store leg, plus what this invocation asked for. */
export interface ResolvedStorePruneRun {
  readonly store: ResolvedStoreRun;
  readonly olderThan: string;
  readonly olderThanMs: number;
  /** Which spelling of the cut-off won. Printed on the receipt; see {@link CutoffSource}. */
  readonly olderThanSource: CutoffSource;
  readonly keepRetrieved: boolean;
  /** What spared the retrieved hashes, if anything. See {@link KeepRetrievedSource}. */
  readonly keepRetrievedSource: KeepRetrievedSource;
  readonly dryRun: boolean;
  readonly json: boolean;
}

/**
 * The `smelt store prune --json` envelope format. Its own version line, like every
 * other machine-read surface here: a prune report is a list of deletions, a structure
 * that has to be able to move without dragging the stats or map envelopes with it.
 */
export const CLI_PRUNE_JSON_FORMAT = 'smelt-store-prune-cli/v1';

/** What `smelt store prune --json` prints. */
export interface CliPruneJsonEnvelope {
  readonly format: string;
  /** The store directory the prune ran against, absolute. */
  readonly storePath: string;
  /** The cut-off as typed — `30d` — so a receipt records what was asked, not only what happened. */
  readonly olderThan: string;
  /**
   * Where that cut-off came from: `"flag"` for `--older-than`, `"config"` for
   * `store.retention.olderThan`. Additive to `smelt-store-prune-cli/v1` — an envelope
   * gains optional fields, it never loses one — and it is here because a receipt for a
   * deletion has to answer "who chose this number" as well as "what went".
   */
  readonly olderThanSource: CutoffSource;
  readonly keepRetrieved: boolean;
  /**
   * What spared the retrieved hashes. Additive to `smelt-store-prune-cli/v1`, like
   * {@link olderThanSource}, and separate from it because the age has one winner while
   * the sparing is a union — `"both"` is a receipt a reader will actually see.
   */
  readonly keepRetrievedSource: KeepRetrievedSource;
  /** The {@link PruneReport} exactly as the store's `prune()` returned it. */
  readonly prune: PruneReport;
}

export const storeCommand: Subcommand<StoreInvocation, ResolvedStorePruneRun> = {
  name: 'store',
  flags: ['older-than', 'keep-retrieved', 'dry-run', 'json'],
  refusal:
    `store prune deletes elided bytes you named a cut-off for; it plans nothing, cuts ` +
    `nothing and has no budget or focus to take.`,
  usage: {
    synopsis: ['store prune [--older-than <age>] [--keep-retrieved] [--dry-run] [--json]'],
    section: {
      heading: 'STORE',
      body:
        `  ${CLI_NAME} store prune is the only command that deletes an elision, and the only\n` +
        `  eviction ${CLI_NAME} has: nothing prunes on a timer, on a size cap, or when a\n` +
        `  store is opened. You name the age cut — --older-than 30d, 12h or 2w — and\n` +
        `  every blob last written before it is evicted, unless --keep-retrieved spares\n` +
        `  the hashes the journal shows were asked for back. --dry-run prints the same\n` +
        `  report and frees nothing.\n` +
        `\n` +
        `  The age may be written down instead of typed every time:\n` +
        `  "store": { "kind": "directory", "path": "${SETUP_RECIPE.store.defaultDir}",\n` +
        `             "retention": { "olderThan": "30d", "keepRetrieved": true } }\n` +
        `  --older-than wins over it, the report names which one it used, and with\n` +
        `  neither present the verb refuses: the deletion stays explicit, only the\n` +
        `  number may be written down. There is no built-in age, because an age\n` +
        `  ${CLI_NAME} invented would decide which of your elisions stop being\n` +
        `  reversible.\n` +
        `\n` +
        `  Each eviction is journalled first and deleted second, so nothing goes\n` +
        `  unrecorded: a later ${CLI_NAME} retrieve of an evicted hash exits 3 with\n` +
        `  EvictedHashError naming the date it went — never "it was never elided". The\n` +
        `  counters do not move either. elisionsStored still counts what was evicted, so\n` +
        `  a prune cannot raise the expansion rate by shrinking its own denominator, and\n` +
        `  the per-rule ledger is untouched: the rule did make that cut. Only\n` +
        `  bytesStored falls, because only bytesStored measures the disk.\n` +
        `\n` +
        `  Like retrieve and stats it needs a directory store in ${CLI_NAME}.config.json:\n` +
        `  a memory store has already forgotten everything by the time you could prune it.`,
    },
  },

  /**
   * An action, then that action's own validation. `store` alone is a usage error naming
   * `prune` rather than a default action: the only action this verb has deletes things,
   * and a bare verb that deletes is how someone loses bytes to a typo.
   */
  parse(values: FlagValues, positionals: readonly string[]): StoreInvocation {
    const action = positionals[1];
    if (action !== 'prune') {
      throw new CliUsageError(
        `${CLI_NAME}: store needs an action — prune is the only one${
          action === undefined ? '' : `, and ${JSON.stringify(action)} is not it`
        }.\n` +
          `  ${CLI_NAME} store prune --older-than 30d [--keep-retrieved] [--dry-run] [--json]`,
      );
    }
    if (positionals.length > 2) {
      throw new CliUsageError(
        `${CLI_NAME}: store prune takes no further arguments, got ` +
          `${positionals.slice(2).join(', ')}. It prunes the one configured store.`,
      );
    }
    // A cut-off is read here when it was typed — a malformed `--older-than` is a flag
    // error and belongs beside every other flag error — but its *absence* is not
    // refused here. Whether this run has a cut-off at all is a merge of flag and
    // config, and a parse that has never seen the config cannot answer it.
    const raw = values['older-than'];
    return {
      mode: 'store',
      action,
      ...(raw === undefined ? {} : { olderThan: raw, olderThanMs: parseDuration(raw) }),
      keepRetrieved: values['keep-retrieved'] === true,
      dryRun: values['dry-run'] === true,
      json: values.json === true,
    };
  },

  resolve(invocation: StoreInvocation, config: ConfigSource): ResolvedStorePruneRun {
    const loaded = config();
    // The store leg first, deliberately: "there is nothing here that can be pruned"
    // outranks "you did not say how old", and asking a user for a cut-off before
    // telling them their store dies with its own process is two refusals in a row.
    const store = resolveStoreRun('store prune', loaded);
    const retention = resolveRetention(invocation, loaded?.config.store);
    return {
      store,
      olderThan: retention.olderThan,
      olderThanMs: retention.olderThanMs,
      olderThanSource: retention.source,
      keepRetrieved: retention.keepRetrieved,
      keepRetrievedSource: retention.keepRetrievedSource,
      dryRun: invocation.dryRun,
      json: invocation.json,
    };
  },

  run(resolved: ResolvedStorePruneRun, io: CliIo): number {
    // Constructed here rather than through `openStore`, because prune is a
    // DirectoryElisionStore capability and not an ElisionStore one — deliberately.
    // A memory store has nothing to prune, and putting eviction on the interface would
    // offer it to every adapter, including one an MCP tool could reach.
    const store = new DirectoryElisionStore(resolved.store.storePath);
    // The clock is read once, here, and turned into the instant the store compares
    // against: the store never asks what time it is, so an age cut is always the
    // caller's arithmetic and always testable.
    const report = store.prune({
      olderThan: new Date(Date.now() - resolved.olderThanMs),
      keepRetrieved: resolved.keepRetrieved,
      dryRun: resolved.dryRun,
    });

    if (resolved.json) {
      const envelope: CliPruneJsonEnvelope = {
        format: CLI_PRUNE_JSON_FORMAT,
        storePath: resolved.store.storePath,
        olderThan: resolved.olderThan,
        olderThanSource: resolved.olderThanSource,
        keepRetrieved: resolved.keepRetrieved,
        keepRetrievedSource: resolved.keepRetrievedSource,
        prune: report,
      };
      io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      return EXIT.ok;
    }

    io.stdout(
      formatPruneReport(
        {
          report,
          storePath: resolved.store.storePath,
          olderThan: resolved.olderThan,
          olderThanSource: resolved.olderThanSource,
          keepRetrieved: resolved.keepRetrieved,
          keepRetrievedSource: resolved.keepRetrievedSource,
        },
        stdoutPalette(io),
      ),
    );
    return EXIT.ok;
  },
};

/**
 * `30d` → milliseconds. Anything else is a usage error that shows the grammar.
 *
 * The grammar itself lives in `store-cutoff.ts`, because `store.retention.olderThan`
 * has to read exactly the same spellings; what stays here is the *register* — a
 * refusal that names `--older-than`, which is the thing the user typed.
 *
 * Refusing beats guessing for the same reason it does everywhere else in this CLI:
 * `--older-than 30` could mean days, hours or weeks, and a prune that guessed wrong
 * deletes bytes at 24× or 168× the age the user meant. The number is bounded as well as
 * the unit: `--older-than 200000000d` parsed cleanly until it did not, because the
 * product overflows the representable time range, `new Date(Date.now() - ms)` becomes
 * an Invalid Date, every `mtimeMs >= NaN` comparison in the scan is false, and a prune
 * meant to reclaim last decade's disk emptied a store written seconds earlier.
 *
 * @throws {CliUsageError} naming what was typed and the grammar it did not match, or
 *   the furthest age that is still a date.
 */
function parseDuration(raw: string): number {
  const reading = readCutoff(raw, Date.now());
  if (reading.ok) return reading.milliseconds;
  if (reading.why === 'grammar') {
    throw new CliUsageError(
      `${CLI_NAME}: --older-than ${JSON.stringify(raw)} is not an age smelt can read.\n` +
        `  ${CUTOFF_HELP}`,
    );
  }
  throw new CliUsageError(
    `${CLI_NAME}: --older-than ${JSON.stringify(raw)} reaches further back than a date ` +
      `can go, so there is no instant to compare a blob against. At most ` +
      `${reading.furthest}.\n  ${CUTOFF_HELP}`,
  );
}

/**
 * Law: **a typed cut-off wins over a written-down one, and there is no third source.**
 *
 * The one merge this verb has, and the only code allowed to look at `--older-than` and
 * `store.retention` side by side — the same discipline `resolveRun` states for a smelt
 * run's budget and strategy, so a precedence question is answered by reading one
 * function rather than two files.
 *
 * Three outcomes, and the third is the doctrine. A flag wins. Failing that, a
 * configured `olderThan` is used and the receipt says so. Failing both, the verb
 * refuses and names **both** places a cut-off can be written, because the alternative
 * is an age smelt invented — and an age smelt invented decides which of somebody's
 * elisions stop being reversible, at a moment they did not choose. Note what is *not*
 * defaulted: the deletion. `store.retention` cannot make anything happen; it can only
 * supply the number to the verb the user still has to type.
 *
 * **`keepRetrieved` is the union of the two, never the winner's alone.** There is no
 * `--no-keep-retrieved`, so a flag can only ever add sparing; letting the flag leg's
 * absent boolean overrule a configured `true` would mean typing `--older-than 30d`
 * silently deleted *more* than the config asked for. For the only verb in smelt that
 * unlinks bytes, the union is the direction that keeps them.
 *
 * @throws {CliUsageError} when neither spelling carries a cut-off.
 */
function resolveRetention(
  invocation: StoreInvocation,
  configured: SmeltConfigStore | undefined,
): {
  olderThan: string;
  olderThanMs: number;
  source: CutoffSource;
  keepRetrieved: boolean;
  keepRetrievedSource: KeepRetrievedSource;
} {
  const retention: SmeltConfigRetention | undefined =
    configured?.kind === 'directory' ? configured.retention : undefined;
  // Sparing is additive: the flag turns it on, the config turns it on, and neither can
  // turn the other off. See the doc above. Both halves are carried onto the receipt,
  // because "the config kept blobs the flag never mentioned" is the surprising case and
  // a header that only ever said "keeping retrieved" could not tell a user which.
  const byFlag = invocation.keepRetrieved;
  const byConfig = retention?.keepRetrieved === true;
  const keepRetrieved = byFlag || byConfig;
  const keepRetrievedSource: KeepRetrievedSource =
    byFlag && byConfig ? 'both' : byFlag ? 'flag' : byConfig ? 'config' : 'none';

  if (invocation.olderThan !== undefined && invocation.olderThanMs !== undefined) {
    return {
      olderThan: invocation.olderThan,
      olderThanMs: invocation.olderThanMs,
      source: 'flag',
      keepRetrieved,
      keepRetrievedSource,
    };
  }
  if (retention !== undefined) {
    // Already read once by `parseConfig`, which refuses a malformed one with the file
    // and the key named. Reading it again here rather than carrying the milliseconds
    // through the config type keeps the config a record of what the user wrote.
    const reading = readCutoff(retention.olderThan, Date.now());
    /* c8 ignore next 3 -- unreachable: parseConfig refuses a cut-off this cannot read. */
    if (!reading.ok) {
      throw new CliUsageError(
        `${CLI_NAME}: store.retention.olderThan ${JSON.stringify(retention.olderThan)} in ` +
          `${CONFIG_FILE_NAME} is not an age smelt can read.\n  ${CUTOFF_HELP}`,
      );
    }
    return {
      olderThan: retention.olderThan,
      olderThanMs: reading.milliseconds,
      source: 'config',
      keepRetrieved,
      keepRetrievedSource,
    };
  }
  throw new CliUsageError(
    `${CLI_NAME}: store prune needs an age to cut at, and this run has none. Either ` +
      `pass --older-than, or write one down as store.retention.olderThan in ` +
      `${CONFIG_FILE_NAME}:\n` +
      `  "store": { "kind": "directory", "path": "${SETUP_RECIPE.store.defaultDir}", ` +
      `"retention": { "olderThan": "30d" } }\n` +
      `There is no built-in default, because a cut-off ${CLI_NAME} invented would decide ` +
      `which of your elisions stop being reversible, at an age nobody chose. The flag ` +
      `wins when both are present.\n  ${CUTOFF_HELP}`,
  );
}
