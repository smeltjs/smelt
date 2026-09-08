import process from 'node:process';

import { CliUsageError } from '../../errors.ts';
import { runDoctor } from '../doctor.ts';
import { colorize } from '../lava.ts';
import { CLI_NAME } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import { parseScope } from './flags.ts';
import type { FlagValues } from './flags.ts';
import type { Subcommand } from './subcommand.ts';
import type { InstallScope } from '../../harness/scope.ts';

/**
 * `smelt doctor` — the read-only half of the install seam. The flow is
 * `cli/doctor.ts`; this file is only the verb. It owns one flag: `--json` turns the
 * report into a receipt an agent can read. It needs no interactive stream, because a
 * reader never asks — that is the whole difference between doctor and setup
 * (ADR-0003: doctor reports; setup repairs).
 */

/** `smelt doctor [--json]` — parsed. */
export interface DoctorInvocation {
  readonly mode: 'doctor';
  readonly json: boolean;
  /** Which install to read. Absent means detect — see `harness/scope.ts`. */
  readonly scope?: InstallScope;
}

export const doctorCommand: Subcommand<DoctorInvocation, DoctorInvocation> = {
  name: 'doctor',
  flags: ['scope', 'json'],
  refusal: `doctor reads installed state and reports; it writes nothing, so there is nothing to answer.`,
  usage: {
    synopsis: ['doctor [--scope <where>] [--json]'],
    section: {
      heading: 'DOCTOR',
      body:
        `  ${CLI_NAME} doctor reads installed state and compares it with the binary running:\n` +
        `  which release wrote the instruction blocks, whether the config parses and its\n` +
        `  store directory exists, whether the MCP registration is intact, and which pieces\n` +
        `  are orphans. Exit 0 when current (or nothing installed), the refused exit when\n` +
        `  something is behind — and the report names the exact repair command:\n` +
        `  ${CLI_NAME} setup, per harness where a block is behind. Doctor never writes.\n` +
        `  The update loop is:\n\n` +
        `    upgrade → ${CLI_NAME} doctor → ${CLI_NAME} setup\n`,
    },
  },

  parse(values: FlagValues, positionals: readonly string[]): DoctorInvocation {
    if (positionals.length > 1) {
      throw new CliUsageError(
        `${CLI_NAME}: doctor takes no further arguments, got ` +
          `${positionals.slice(1).join(', ')}.`,
      );
    }
    const scope = parseScope(values.scope);
    return {
      mode: 'doctor',
      json: values.json === true,
      ...(scope === undefined ? {} : { scope }),
    };
  },

  /** Nothing to merge: doctor reads everything it reports. */
  resolve(invocation: DoctorInvocation): DoctorInvocation {
    return invocation;
  },

  async run(resolved: DoctorInvocation, io: CliIo): Promise<number> {
    return runDoctor(
      { json: resolved.json, ...(resolved.scope === undefined ? {} : { scope: resolved.scope }) },
      {
        output: (text) => io.stdout(colorize(text, io.color === true && !resolved.json)),
        cwd: io.cwd ?? process.cwd(),
        ...(io.home === undefined ? {} : { home: io.home }),
        version: io.version,
      },
    );
  },
};
