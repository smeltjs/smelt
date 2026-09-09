import { CliUsageError } from '../../errors.ts';
import { openStore } from '../../ops/inputs.ts';
import { readCounters, readLedger } from '../../ops/verbs.ts';
import { readStoreSize } from '../../store-dir.ts';
import type { RetrieveStats, RuleLedgerEntry } from '../../types.ts';
import { stdoutPalette } from '../lava.ts';
import { formatStatsReport } from '../report.ts';
import { CLI_NAME, EXIT } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues } from './flags.ts';
import { resolveStoreRun } from './retrieve.ts';
import type { ResolvedStoreRun } from './retrieve.ts';
import type { ConfigSource, Subcommand } from './subcommand.ts';

/**
 * `smelt stats` — the store's counters, without touching them.
 *
 * Reading stats does NOT count as a retrieval: `stats()` folds the journal and scans
 * the blobs, journaling nothing, so watching the expansion rate can never move it —
 * an observer that inflated its own metric would make the honest signal dishonest.
 *
 * The plain form is a report for a person — the store, the expansion rate with a bar,
 * the counters, and the ledger as a table (`cli/report.ts` renders it, like every other
 * surface here); `--json` emits the {@link RetrieveStats} and the ledger verbatim in
 * their own versioned envelope ({@link CLI_STATS_JSON_FORMAT}), and that is the surface
 * a machine reads. The two are not the same shape on purpose: the text one used to be
 * `name value` lines, which read like a machine surface without being versioned like
 * one.
 *
 * It resolves through `retrieve`'s {@link resolveStoreRun} because the two verbs
 * share one merge — the store leg, and the same refusal when that store cannot
 * outlive a run. Sharing the function is the point; sharing a struct with a hash
 * field `stats` would never read is not.
 */

/** `smelt stats` — the store's counters, read without touching them. */
export interface StatsInvocation {
  readonly mode: 'stats';
  readonly json: boolean;
}

/** What `stats` runs on: the shared store leg, plus how to print it. */
export interface ResolvedStatsRun {
  readonly store: ResolvedStoreRun;
  readonly json: boolean;
}

/**
 * The `smelt stats --json` envelope format. Its own version line for the same reason
 * `smelt map` has one: the two envelopes carry different structures and must move
 * independently.
 */
export const CLI_STATS_JSON_FORMAT = 'smelt-stats-cli/v2';

/**
 * What `smelt stats --json` prints: the {@link RetrieveStats} verbatim, and the
 * ledger beside them, versioned. v2 added `ledger`; v1 carried `stats` alone.
 */
export interface CliStatsJsonEnvelope {
  readonly format: string;
  /** The {@link RetrieveStats} exactly as the store's `stats()` returned them. */
  readonly stats: RetrieveStats;
  /** The store's per-rule ledger, exactly as `ledger()` returned it. */
  readonly ledger: readonly RuleLedgerEntry[];
}

export const statsCommand: Subcommand<StatsInvocation, ResolvedStatsRun> = {
  name: 'stats',
  flags: ['json'],
  refusal: `stats reads counters; there is nothing to budget, focus or plan.`,
  usage: {
    synopsis: ['stats [--json]'],
    section: {
      heading: 'RETRIEVE & STATS',
      body:
        `  ${CLI_NAME} stats reports on the same store: where it is and what it holds on\n` +
        `  disk, the expansion rate with a bar, the counters — elisionsStored,\n` +
        `  bytesStored, retrieveCalls, uniqueRetrieved, misses, expansionRate,\n` +
        `  allElisionsRetrieved — and then the ledger as a table, one row per rule that\n` +
        `  cut anything (stored, retrieved, rate), heaviest first: which rule's cuts get\n` +
        `  asked for back. Reading them is NOT counted as a retrieval. --json emits the\n` +
        `  RetrieveStats and the ledger verbatim in their own versioned envelope, and is\n` +
        `  the surface to parse — the text one is for a person, and it is never coloured\n` +
        `  into a pipe.\n` +
        `\n` +
        `  Both need somewhere for elisions to outlive the run that made them: a\n` +
        `  smelt.config.json with a directory store (\`${CLI_NAME} init\` writes one). With a\n` +
        `  memory store — or no config — every run's store dies with its process, so there\n` +
        `  is nothing to retrieve across runs, and that is a usage error rather than a\n` +
        `  quiet empty answer.`,
    },
  },

  parse(values: FlagValues, positionals: readonly string[]): StatsInvocation {
    if (positionals.length > 1) {
      throw new CliUsageError(
        `${CLI_NAME}: stats takes no further arguments, got ` +
          `${positionals.slice(1).join(', ')}. It reports on the one configured store.`,
      );
    }
    return { mode: 'stats', json: values.json === true };
  },

  resolve(invocation: StatsInvocation, config: ConfigSource): ResolvedStatsRun {
    return { store: resolveStoreRun('stats', config()), json: invocation.json };
  },

  run(resolved: ResolvedStatsRun, io: CliIo): number {
    const store = openStore({ kind: 'directory', path: resolved.store.storePath });
    const stats = readCounters({ store });
    // The directory store always keeps a ledger; the `?? []` is the type's escape
    // hatch for a custom store, never a case this verb reaches.
    const ledger = readLedger({ store }) ?? [];

    if (resolved.json) {
      const statsEnvelope: CliStatsJsonEnvelope = { format: CLI_STATS_JSON_FORMAT, stats, ledger };
      io.stdout(`${JSON.stringify(statsEnvelope, null, 2)}\n`);
      return EXIT.ok;
    }

    // The store's own size, off disk, beside the counters it keeps. Read rather than
    // asked for: `readStoreSize` opens nothing, so the header cannot author the
    // directory it describes — and `bytesStored` (the counter) stays the counter.
    const size = readStoreSize(resolved.store.storePath);
    io.stdout(
      formatStatsReport(
        {
          stats,
          ledger,
          storePath: resolved.store.storePath,
          ...(size === undefined ? {} : { size }),
        },
        stdoutPalette(io),
      ),
    );
    return EXIT.ok;
  },
};
