import process from 'node:process';

import { CliUsageError } from '../../errors.ts';
import { runInit } from '../init.ts';
import { colorize, stdoutPalette } from '../lava.ts';
import { CLI_NAME } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues } from './flags.ts';
import type { Subcommand } from './subcommand.ts';

/**
 * `smelt init` — the setup wizard's front door. The wizard itself is `cli/init.ts`,
 * a pure function over an input/output pair; this file is only the verb.
 *
 * It owns no flags at all, and that is the whole design: the wizard asks one question
 * at a time and writes nothing until a final confirm, so a flag would be an answer
 * given twice. It also merges nothing — it reads `smelt.config.json` itself, with its
 * own tolerance, because a wizard you run to *fix* a malformed config must not refuse
 * to start because the config is malformed.
 */

/** `smelt init` — no flags, no arguments, nothing but the word. */
export interface InitInvocation {
  readonly mode: 'init';
  readonly focus: readonly string[];
  readonly json: boolean;
}

export const initCommand: Subcommand<InitInvocation, InitInvocation> = {
  name: 'init',
  flags: [],
  refusal: `init is interactive: it asks instead.`,
  usage: {
    synopsis: [],
    occasional: ['init'],
    section: {
      heading: 'CONFIG',
      body:
        `  ${CLI_NAME} init walks you through writing a smelt.config.json (and optional typed\n` +
        `  stubs), one question at a time; nothing is written until a final confirm. Runs read\n` +
        `  the nearest smelt.config.json, walking up from the working directory, for DEFAULTS\n` +
        `  only — budget, strategy, store. An explicit flag always wins, and a malformed config\n` +
        `  is a usage error, never silently ignored.`,
    },
  },

  parse(_values: FlagValues, positionals: readonly string[]): InitInvocation {
    // `smelt init` is a subcommand, so a file literally named `init` needs `./init`.
    if (positionals.length > 1) {
      throw new CliUsageError(`${CLI_NAME}: init takes no further arguments.`);
    }
    return { mode: 'init', focus: [], json: false };
  },

  /** Nothing to merge: every answer is asked for, and the config is read by the wizard. */
  resolve(invocation: InitInvocation): InitInvocation {
    return invocation;
  },

  async run(_resolved: InitInvocation, io: CliIo): Promise<number> {
    if (io.initInput === undefined) {
      throw new CliUsageError(
        `${CLI_NAME}: init is interactive, and this invocation has no interactive ` +
          `input stream. Run \`${CLI_NAME} init\` from a terminal.`,
      );
    }
    return await runInit({
      input: io.initInput,
      output: (text) => io.stdout(colorize(text, io.color === true, stdoutPalette(io))),
      cwd: io.cwd ?? process.cwd(),
      ...(io.unicode === undefined ? {} : { unicode: io.unicode }),
    });
  },
};
