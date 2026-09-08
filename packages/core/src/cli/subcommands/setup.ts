import process from 'node:process';

import { CliUsageError } from '../../errors.ts';
import { HARNESSES, harnessById } from '../../harness/registry.ts';
import { SETUP_RECIPE } from '../../setup/recipe.ts';
import { runSetup } from '../setup.ts';
import { colorize } from '../lava.ts';
import { CLI_NAME } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import { parseScope } from './flags.ts';
import type { FlagValues } from './flags.ts';
import type { Subcommand } from './subcommand.ts';
import type { InstallScope } from '../../harness/scope.ts';

/**
 * `smelt setup` — the one-command front door for the whole recipe. The flow itself is
 * `cli/setup.ts`, a pure function over an injected input/output pair; this file is
 * only the verb.
 *
 * Interactive from a terminal, like `init` and `hooks`; for an agent, the flags are
 * the whole interface — `--yes` answers everything from the recipe, `--harness`
 * (repeatable) picks the harnesses, `--no-mcp` skips the registration step, and
 * `--json` (with `--yes`) turns the run into a machine-readable receipt. The refusal
 * below is how an agent with no TTY learns that interface, which is the same trick
 * `init`'s refusal uses.
 */

/** `smelt setup [--harness <id>]... [--yes] [--no-mcp] [--json]` — parsed. */
export interface SetupInvocation {
  readonly mode: 'setup';
  readonly harnessIds: readonly string[];
  readonly yes: boolean;
  readonly noMcp: boolean;
  readonly json: boolean;
  /** Absent means detect — see `harness/scope.ts`. */
  readonly scope?: InstallScope;
}

export const setupCommand: Subcommand<SetupInvocation, SetupInvocation> = {
  name: 'setup',
  flags: ['harness', 'scope', 'yes', 'no-mcp', 'json'],
  refusal: `setup applies the recipe; answer it with --yes (and --harness, --no-mcp, --json) or let it ask.`,
  usage: {
    synopsis: [],
    occasional: ['setup [--harness <id>]... [--scope <where>] [--yes] [--no-mcp] [--json]'],
    section: {
      heading: 'SETUP',
      body:
        `  ${CLI_NAME} setup applies the whole recipe in one command: smelt.config.json, the\n` +
        `  hooks preset for the harnesses you name, the MCP registration step, and a real\n` +
        `  smelt → retrieve round trip to prove the loop. Interactive from a terminal; for\n` +
        `  an agent, answer everything up front:\n\n` +
        `    ${CLI_NAME} setup --yes [--harness <id>]... [--scope <where>] [--no-mcp] [--json]\n\n` +
        `  The defaults are the recipe's: budget ${SETUP_RECIPE.recommendedBudgetBytes} bytes\n` +
        `  (written only when the config carries none), a directory store at\n` +
        `  ${SETUP_RECIPE.store.defaultDir} (only when the config carries none). Existing\n` +
        `  files are never overwritten — they are skipped with a note; hooks install edits\n` +
        `  them, and it asks per file. Re-running on a current machine writes nothing and\n` +
        `  exits 0. --json prints a receipt: every file, every check, the exit's meaning.`,
    },
  },

  parse(values: FlagValues, positionals: readonly string[]): SetupInvocation {
    if (positionals.length > 1) {
      throw new CliUsageError(
        `${CLI_NAME}: setup takes no further arguments, got ` +
          `${positionals.slice(1).join(', ')}.`,
      );
    }
    const harnessIds = (values.harness ?? []).map((id) => {
      if (harnessById(id) === undefined) {
        throw new CliUsageError(
          `${CLI_NAME} setup: unknown harness "${id}". ` +
            `Known: ${HARNESSES.map((harness) => harness.id).join(', ')}.`,
        );
      }
      return id;
    });
    const yes = values.yes === true;
    const json = values.json === true;
    if (json && !yes) {
      throw new CliUsageError(
        `${CLI_NAME}: --json prints a machine receipt — pair it with --yes. ` +
          `The interactive flow's output is for humans.`,
      );
    }
    const scope = parseScope(values.scope);
    return {
      mode: 'setup',
      harnessIds,
      yes,
      noMcp: values['no-mcp'] === true,
      json,
      ...(scope === undefined ? {} : { scope }),
    };
  },

  /**
   * Nothing to merge: the flow reads `smelt.config.json` itself. A *missing* config
   * is the thing setup writes; a *malformed* one is a loud refusal — doctor names it,
   * the user fixes it, and setup never guesses around bytes it cannot parse.
   */
  resolve(invocation: SetupInvocation): SetupInvocation {
    return invocation;
  },

  /**
   * Interactive unless `--yes` answered everything, so it needs the wizard stream —
   * and the refusal below is the agent-facing interface documentation.
   */
  async run(resolved: SetupInvocation, io: CliIo): Promise<number> {
    if (!resolved.yes && io.initInput === undefined) {
      throw new CliUsageError(
        `${CLI_NAME}: setup is interactive unless you answer it up front. ` +
          `Non-interactive:\n` +
          `  ${CLI_NAME} setup --yes [--harness <id>]... [--no-mcp] [--json]`,
      );
    }
    return await runSetup(resolved, {
      // `input` stays absent for `--yes` — exactOptionalPropertyTypes means "absent"
      // is a decision, not a field carrying undefined.
      ...(io.initInput === undefined ? {} : { input: io.initInput }),
      output: (text) =>
        io.stdout(colorize(text, io.color === true && !resolved.yes && !resolved.json)),
      cwd: io.cwd ?? process.cwd(),
      ...(io.home === undefined ? {} : { home: io.home }),
      version: io.version,
      // The lava renderer is for the human at a terminal: --yes and --json are the
      // machine paths, and their bytes stay plain however pretty the screen is.
      ...(io.color === true && !resolved.yes && !resolved.json ? { color: true } : {}),
    });
  },
};
