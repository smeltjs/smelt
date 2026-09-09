import process from 'node:process';

import { CliUsageError, SmeltError } from '../errors.ts';

import { loadNearestConfig } from '../config.ts';
import { stderrPalette, stdoutPalette } from './lava.ts';
import { EXIT } from './shell.ts';
import type { CliIo } from './shell.ts';
import { commandFor } from './subcommands/registry.ts';
import { cliUsage, frontDoor } from './usage.ts';

import { parseSmeltArgs, refusesColor } from './args.ts';

export { CLI_NAME, closedSinkCode, EXIT } from './shell.ts';
export type { AnswerStream, CliIo } from './shell.ts';
export { cliUsage, frontDoor } from './usage.ts';
export {
  BAR_WIDTH,
  colorAllowed,
  colorize,
  palette,
  percent,
  PLAIN,
  stderrPalette,
  stdoutPalette,
  supportsUnicode,
} from './lava.ts';
export type { Column, Glyph, KvRow, Palette, Role, TableSpec } from './lava.ts';
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
export {
  formatAgentsReport,
  formatMapReport,
  formatPruneReport,
  formatReport,
  formatStoreSize,
} from './report.ts';
export type { AgentsReportInput, MapReportInput, PruneReportInput, ReportInput } from './report.ts';
export { CLI_JSON_FORMAT, resolveRun } from './subcommands/smelt.ts';
export type { CliJsonEnvelope, ResolvedRun } from './subcommands/smelt.ts';
export { CLI_MAP_JSON_FORMAT, resolveMapRun } from './subcommands/map.ts';
export type { CliMapJsonEnvelope, ResolvedMapRun } from './subcommands/map.ts';
export { resolveStoreRun } from './subcommands/retrieve.ts';
export type { ResolvedStoreRun } from './subcommands/retrieve.ts';
export { CLI_STATS_JSON_FORMAT } from './subcommands/stats.ts';
export type { CliStatsJsonEnvelope } from './subcommands/stats.ts';
export { CLI_PRUNE_JSON_FORMAT } from './subcommands/store.ts';
export type {
  CliPruneJsonEnvelope,
  CutoffSource,
  KeepRetrievedSource,
  StoreInvocation,
} from './subcommands/store.ts';
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
/**
 * The io a *machine* reads: stderr unpainted, because `--json` means bytes for
 * something that parses them and `2>&1` puts the report beside the envelope.
 *
 * Every verb already prints its envelope through `PLAIN`, so stdout needs nothing
 * here; what was left was the report on the other stream — and the refusal, which is
 * printed from `runCli`'s own catch, where no verb's `--json` flag is in reach.
 */
function machineIo(io: CliIo): CliIo {
  return Object.create(io, { colorErr: { value: false, enumerable: true } }) as CliIo;
}

/**
 * The same io with its colour switched off — and **not** `{ ...io, color: false }`.
 *
 * A spread reads every own property, and `bin.ts` deliberately hands `initInput` over
 * as a *getter*: merely touching `process.stdin` flips fd 0 into non-blocking mode and
 * breaks the one-shot `readFileSync(0)` every non-wizard verb reads its input with.
 * Spreading would evaluate that getter on the way past, so `smelt --no-color --budget
 * 4000 < big.log` would start failing with `EAGAIN` on a slow producer — a pipe bug
 * caused by a colour flag. Deriving through the prototype leaves every property,
 * getters included, exactly as lazy as it was, and keeps working if `CliIo` gains a
 * field tomorrow.
 */
function plainIo(io: CliIo): CliIo {
  return Object.create(io, {
    color: { value: false, enumerable: true },
    colorErr: { value: false, enumerable: true },
  }) as CliIo;
}

export async function runCli(argv: readonly string[], rawIo: CliIo): Promise<number> {
  // `--no-color` is answered before anything else, because it changes how the very
  // refusal for a mistyped command line is printed. Every palette below is built off
  // this one io, so a verb cannot re-derive colour and disagree with the flag.
  const io: CliIo = refusesColor(argv)
    ? plainIo(rawIo)
    : argv.includes('--json')
      ? machineIo(rawIo)
      : rawIo;
  try {
    // Bare `smelt` at a terminal is a person who has not read anything yet: the front
    // door, not a refusal about stdin. A pipe (`cat log | smelt`) is not that person
    // and keeps every byte of its old behaviour — `io.tty` is only ever true when
    // stdout is a terminal *and* stdin is not redirected.
    if (argv.length === 0 && io.tty === true) {
      io.stdout(frontDoor(stdoutPalette(io)));
      return EXIT.ok;
    }

    const invocation = parseSmeltArgs(argv);

    if (invocation.mode === 'help') {
      io.stdout(cliUsage(stdoutPalette(io)));
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
    // The refusals are painted at the sink, like every other line smelt writes: the
    // words are the error's, the colour is the palette's, and with colour off both
    // messages are the exact bytes they have always been.
    const lava = stderrPalette(io);
    if (error instanceof CliUsageError) {
      io.stderr(`${lava.paint('warn', error.message)}\n`);
      return EXIT.usage;
    }
    if (error instanceof SmeltError) {
      io.stderr(`${lava.paint('bad', error.name)}: ${error.message}\n`);
      return EXIT.refused;
    }
    throw error;
  }
}
