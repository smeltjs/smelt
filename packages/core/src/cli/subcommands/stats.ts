import { CliUsageError } from '../../errors.ts';
import { surveyStore } from '../../ops/verbs.ts';
import { retrieveStats } from '../../stats.ts';
import { DirectoryElisionStore } from '../../store-dir.ts';
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
 * Reading stats does NOT count as a retrieval: the store folds the journal and scans
 * the blobs, journaling nothing, so watching the expansion rate can never move it —
 * an observer that inflated its own metric would make the honest signal dishonest.
 *
 * It reads the store **once**. The three things this report is made of — the counters,
 * the ledger and the store's own size on disk — used to be three separate walks of the
 * same two files, which is a whole traversal of somebody's store per line of output,
 * paid at the end of every session because the Stop hook runs this command. `survey()`
 * answers all three from one pass; nothing about the numbers moved.
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
    // Constructed here rather than through `openStore`, for the reason `store prune`
    // gives: a survey is a DirectoryElisionStore capability, not an ElisionStore one.
    // `resolveStoreRun` has already refused everything that is not a directory.
    const store = new DirectoryElisionStore(resolved.store.storePath);
    // One traversal, three answers. `retrieveStats` derives the honesty arithmetic
    // from the counters, exactly as the store's own `stats()` does — the derivation
    // has one home and this verb is not it.
    const survey = surveyStore({ store });
    const stats = retrieveStats(survey.counters);
    const ledger = survey.ledger;

    if (resolved.json) {
      const statsEnvelope: CliStatsJsonEnvelope = { format: CLI_STATS_JSON_FORMAT, stats, ledger };
      io.stdout(`${JSON.stringify(statsEnvelope, null, 2)}\n`);
      return EXIT.ok;
    }

    // The store's own size, off the same scan that produced the counters — two
    // numbers about the disk beside the counters, and `bytesStored` (the counter)
    // stays the counter. `blobs` is what is there now; `elisionsStored` is everything
    // ever put, evicted included, and the report shows both.
    io.stdout(
      formatStatsReport(
        {
          stats,
          ledger,
          storePath: resolved.store.storePath,
          size: survey.size,
        },
        stdoutPalette(io),
      ),
    );
    return EXIT.ok;
  },
};
