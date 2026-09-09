import process from 'node:process';

import { CliUsageError, SmeltError } from '../errors.ts';

import { loadNearestConfig } from './config.ts';
import { EXIT } from './shell.ts';
import type { CliIo } from './shell.ts';
import { commandFor } from './subcommands/registry.ts';
import { cliUsage } from './usage.ts';

import { parseSmeltArgs } from './args.ts';

export { CLI_NAME, closedSinkCode, EXIT } from './shell.ts';
export type { AnswerStream, CliIo } from './shell.ts';
export { cliUsage } from './usage.ts';
export { parseSmeltArgs } from './args.ts';
export type {
  AgentsInvocation,
  CliInvocation,
  HooksInvocation,
  InitInvocation,
  MapInvocation,
  RetrieveInvocation,
  SmeltInvocation,
  StatsInvocation,
} from './args.ts';
export { formatAgentsReport, formatMapReport, formatReport } from './report.ts';
export type { AgentsReportInput, MapReportInput, ReportInput } from './report.ts';
export { CLI_JSON_FORMAT, resolveRun } from './subcommands/smelt.ts';
export type { CliJsonEnvelope, ResolvedRun } from './subcommands/smelt.ts';
export { CLI_MAP_JSON_FORMAT, resolveMapRun } from './subcommands/map.ts';
export type { CliMapJsonEnvelope, ResolvedMapRun } from './subcommands/map.ts';
export { resolveStoreRun } from './subcommands/retrieve.ts';
export type { ResolvedStoreRun } from './subcommands/retrieve.ts';
export { CLI_STATS_JSON_FORMAT } from './subcommands/stats.ts';
export type { CliStatsJsonEnvelope } from './subcommands/stats.ts';
export { CLI_AGENTS_JSON_FORMAT, resolveAgentsRun } from './subcommands/agents.ts';
export type { CliAgentsJsonEnvelope, ResolvedAgentsRun } from './subcommands/agents.ts';

/**
 * The whole CLI, as a function that returns an exit code instead of calling `exit`.
 *
 * Smelted text goes to stdout and the report goes to stderr, so `smelt big.log
 * --budget 4000 > small.log` leaves the human-readable part on the terminal and the
 * payload in the file.
 *
 * It is a lookup and a dispatch, and nothing else: this function used to hold a
 * `switch` over seven modes and seven `run*` functions beneath it, so adding a verb
 * meant editing it. Now the verb that parsed an invocation is the verb that resolves
 * and runs it — `SUBCOMMANDS` in `subcommands/registry.ts` — and the only decisions
 * left here are the two global flags and the mapping from a thrown error to an exit
 * code.
 *
 * The config is passed as a thunk, not a value: `init` and `hooks` read
 * `smelt.config.json` themselves with their own tolerance, and loading it eagerly here
 * would make a wizard you run to *fix* a malformed config refuse to start.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    const invocation = parseSmeltArgs(argv);

    if (invocation.mode === 'help') {
      io.stdout(cliUsage());
      return EXIT.ok;
    }
    if (invocation.mode === 'version') {
      io.stdout(`${io.version}\n`);
      return EXIT.ok;
    }

    const command = commandFor(invocation.mode);
    const config = () => loadNearestConfig(io.cwd ?? process.cwd());
    return await command.run(command.resolve(invocation, config), io);
  } catch (error) {
    if (error instanceof CliUsageError) {
      io.stderr(`${error.message}\n`);
      return EXIT.usage;
    }
    if (error instanceof SmeltError) {
      io.stderr(`${error.name}: ${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
