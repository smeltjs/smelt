import { parseArgs } from 'node:util';

import { CliUsageError } from '../errors.ts';

import { CLI_NAME } from './shell.ts';
import { CLI_FLAGS } from './subcommands/flags.ts';
import { refuseForeignFlags, subcommandFor } from './subcommands/registry.ts';

export { CLI_NAME } from './shell.ts';
export { cliUsage } from './usage.ts';
export type { CliInvocation } from './subcommands/registry.ts';
export type { AgentsInvocation } from './subcommands/agents.ts';
export type { HooksInvocation } from './subcommands/hooks.ts';
export type { InitInvocation } from './subcommands/init.ts';
export type { MapInvocation } from './subcommands/map.ts';
export type { RetrieveInvocation } from './subcommands/retrieve.ts';
export type { SmeltInvocation } from './subcommands/smelt.ts';
export type { StatsInvocation } from './subcommands/stats.ts';

import type { CliInvocation } from './subcommands/registry.ts';

/**
 * Argument parsing on `node:util.parseArgs` — stable since Node 20, which `engines`
 * already requires.
 *
 * The CLI ships as a `bin` on the library rather than as a second package, and this
 * import is the reason that is free: it adds no dependency, so the argument the second
 * package existed to win — keeping the library's dependency tree small — is already won.
 *
 * The shape of this function is the shape of the subcommand seam: split the argv into
 * flags and positionals, answer the two global flags, **look the verb up in
 * `SUBCOMMANDS`**, refuse every flag that verb does not own with one generated
 * message, and let the verb do its own validation. There is no per-verb branching left
 * here — a seventh verb is a seventh file, not a seventh `if`.
 *
 * @throws {CliUsageError} on anything the user got wrong. Never guesses.
 */
export function parseSmeltArgs(argv: readonly string[]): CliInvocation {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: CLI_FLAGS,
    });
  } catch (cause) {
    throw new CliUsageError(
      `${CLI_NAME}: ${cause instanceof Error ? cause.message : String(cause)}\n` +
        `Run \`${CLI_NAME} --help\`.`,
    );
  }

  const { values, positionals } = parsed;

  // Answered before any verb, so `smelt map --help` prints the help rather than being
  // refused for a flag `map` does not own. No verb may claim these — `--no-color` is
  // the third, and it is read straight off argv by {@link refusesColor}, because it
  // has to be known before a *refusal* is printed, which is before there is an
  // invocation to carry it.
  if (values.help === true) return { mode: 'help', focus: [], json: false };
  if (values.version === true) return { mode: 'version', focus: [], json: false };

  const command = subcommandFor(positionals);
  refuseForeignFlags(command, values);
  return command.parse(values, positionals);
}

/**
 * Whether this command line asked for plain bytes.
 *
 * Read from argv rather than from the parsed values because `runCli` needs the answer
 * *before* parsing: a mistyped command line throws out of `parseSmeltArgs`, and the
 * refusal it prints is itself a thing `--no-color` promises not to paint. The flag is
 * still in `CLI_FLAGS` and still in `GLOBAL_FLAGS`, so the parser accepts it, the help
 * documents it, and no verb may claim it.
 */
export function refusesColor(argv: readonly string[]): boolean {
  return argv.includes('--no-color');
}
