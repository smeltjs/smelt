import { CliUsageError } from '../../errors.ts';
import { DirectoryElisionStore } from '../../store-dir.ts';
import type { PruneReport } from '../../store-dir.ts';
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
 * It is a **verb**, not a policy, and that is the whole design. One global store shared
 * by every session accumulates blobs forever, which is a real problem; the answers that
 * would have solved it quietly — a size cap, an LRU, a TTL applied on open — all solve
 * it by having smelt decide which of someone else's elisions stopped mattering, at a
 * moment they did not choose, with no record of what went. Law 3 says every elision is
 * reversible and counted; "reversible until a background rule got to it" is a different,
 * smaller promise.
 *
 * So the deletion happens only when a user types it, only against a cut-off that user
 * named (`--older-than`, no default), and it leaves a receipt: the store journals
 * `evict "<hash>" "<date>"` before it unlinks, and a later `smelt retrieve` of an
 * evicted hash exits 3 with {@link EvictedHashError} — "you pruned it on <date>", never
 * "it was never elided". `--dry-run` is the same measurement with none of the deleting,
 * and it comes first in the help for that reason.
 *
 * It refuses a memory store exactly as `retrieve` and `stats` do, through the same
 * {@link resolveStoreRun}: pruning a store that dies with its own process is a deletion
 * with nothing to delete.
 */

/**
 * The duration grammar, whole: `<n>d`, `<n>h`, `<n>w`, with `n` a whole number of at
 * least 1. Three units and no more, because every extra unit is another spelling to
 * refuse — and no bare number, because `--older-than 30` cannot be read without
 * guessing which unit the user meant.
 */
const DURATION = /^(\d+)([dhw])$/;

/** What each unit is worth in milliseconds. `Record`, so a fourth unit is a compile error. */
const UNIT_MS: Readonly<Record<'h' | 'd' | 'w', number>> = {
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

/** How the grammar is spelled to a user who got it wrong. Written once, shown twice. */
const DURATION_HELP = `<n>d, <n>h or <n>w — a whole number of at least 1 and a unit, e.g. 30d, 12h, 2w`;

/**
 * ECMAScript's time-value limit: the furthest a `Date` can reach either side of the
 * epoch, in milliseconds. Beyond it `new Date(...)` is an *Invalid Date*, whose
 * `getTime()` is `NaN` — and every `mtimeMs >= NaN` comparison is false, which a
 * scanner reads as "every blob is old enough". So an age that lands outside this range
 * is refused here rather than turned into a cut-off nothing can compare against.
 * `prune()` refuses it a second time, at the point of deletion; see its doc for why one
 * check in one place is not enough for the only code in smelt that unlinks a blob.
 */
const MAX_TIME_VALUE = 8_640_000_000_000_000;

/** `smelt store prune --older-than <age> [flags]` — parsed. */
export interface StoreInvocation {
  readonly mode: 'store';
  /** The only action today. A union so a second one is a compile error, not a string. */
  readonly action: 'prune';
  /** The cut-off exactly as typed, e.g. `30d` — echoed in the report, not re-derived. */
  readonly olderThan: string;
  /** Milliseconds the cut-off is worth, parsed once here against {@link DURATION}. */
  readonly olderThanMs: number;
  readonly keepRetrieved: boolean;
  readonly dryRun: boolean;
  readonly json: boolean;
}

/** What `store prune` runs on: the shared store leg, plus what this invocation asked for. */
export interface ResolvedStorePruneRun {
  readonly store: ResolvedStoreRun;
  readonly olderThan: string;
  readonly olderThanMs: number;
  readonly keepRetrieved: boolean;
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
  readonly keepRetrieved: boolean;
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
    synopsis: ['store prune --older-than <age> [--keep-retrieved] [--dry-run] [--json]'],
    section: {
      heading: 'STORE',
      body:
        `  ${CLI_NAME} store prune is the only command that deletes an elision, and the only\n` +
        `  eviction ${CLI_NAME} has: nothing prunes on a timer, on a size cap, or when a\n` +
        `  store is opened. You name the age cut — --older-than 30d, 12h or 2w, no\n` +
        `  default — and every blob last written before it is evicted, unless\n` +
        `  --keep-retrieved spares the hashes the journal shows were asked for back.\n` +
        `  --dry-run prints the same report and frees nothing.\n` +
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
    const raw = values['older-than'];
    if (raw === undefined) {
      throw new CliUsageError(
        `${CLI_NAME}: store prune needs --older-than. There is no default, because a ` +
          `cut-off ${CLI_NAME} invented would decide which of your elisions stop being ` +
          `reversible, at an age nobody chose.\n  ${DURATION_HELP}`,
      );
    }
    return {
      mode: 'store',
      action,
      olderThan: raw,
      olderThanMs: parseDuration(raw),
      keepRetrieved: values['keep-retrieved'] === true,
      dryRun: values['dry-run'] === true,
      json: values.json === true,
    };
  },

  resolve(invocation: StoreInvocation, config: ConfigSource): ResolvedStorePruneRun {
    return {
      store: resolveStoreRun('store prune', config()),
      olderThan: invocation.olderThan,
      olderThanMs: invocation.olderThanMs,
      keepRetrieved: invocation.keepRetrieved,
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
        keepRetrieved: resolved.keepRetrieved,
        prune: report,
      };
      io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      return EXIT.ok;
    }

    io.stdout(
      formatPruneReport({
        report,
        storePath: resolved.store.storePath,
        olderThan: resolved.olderThan,
        keepRetrieved: resolved.keepRetrieved,
      }),
    );
    return EXIT.ok;
  },
};

/**
 * `30d` → milliseconds. Anything else is a usage error that shows the grammar.
 *
 * Refusing beats guessing here for the same reason it does everywhere else in this
 * CLI: `--older-than 30` could mean days, hours or weeks, and a prune that guessed
 * wrong deletes bytes at 24× or 168× the age the user meant.
 *
 * **The number is bounded as well as the unit**, and the bound is not cosmetic.
 * `--older-than 200000000d` parsed cleanly here until it did not: the product overflows
 * {@link MAX_TIME_VALUE}, `new Date(Date.now() - ms)` becomes an Invalid Date, every
 * `mtimeMs >= NaN` comparison in the scan is false, and a prune meant to reclaim last
 * decade's disk emptied a store written seconds earlier. The ceiling is *derived* from
 * the representable range rather than picked, so the refusal states a real limit and
 * not a number smelt invented.
 *
 * @throws {CliUsageError} naming what was typed and the grammar it did not match, or
 *   the furthest age that is still a date.
 */
function parseDuration(raw: string): number {
  const match = DURATION.exec(raw);
  const value = match === null ? 0 : Number(match[1]);
  if (match === null || value < 1) {
    throw new CliUsageError(
      `${CLI_NAME}: --older-than ${JSON.stringify(raw)} is not an age smelt can read.\n` +
        `  ${DURATION_HELP}`,
    );
  }
  const unit = match[2] as 'h' | 'd' | 'w';
  const milliseconds = value * UNIT_MS[unit];
  if (Date.now() - milliseconds < -MAX_TIME_VALUE) {
    const furthest = Math.floor((Date.now() + MAX_TIME_VALUE) / UNIT_MS[unit]);
    throw new CliUsageError(
      `${CLI_NAME}: --older-than ${JSON.stringify(raw)} reaches further back than a date ` +
        `can go, so there is no instant to compare a blob against. At most ` +
        `${String(furthest)}${unit}.\n  ${DURATION_HELP}`,
    );
  }
  return milliseconds;
}
