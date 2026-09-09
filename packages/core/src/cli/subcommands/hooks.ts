import process from 'node:process';

import { CliUsageError } from '../../errors.ts';
import { harnessesByTier, harnessNames } from '../../harness/registry.ts';
import type { HarnessTier } from '../../harness/profile.ts';
import { colorize, stdoutPalette } from '../lava.ts';
import { noInteractiveInput, runHooks } from '../hooks.ts';
import { CLI_NAME, refusingSink } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import { parseScope, parseToggle } from './flags.ts';
import type { FlagValues } from './flags.ts';
import type { Subcommand } from './subcommand.ts';
import type { InstallScope } from '../../harness/scope.ts';
import type { ToggleFlags } from '../installed.ts';

/**
 * `smelt hooks install` / `smelt hooks remove` — the harness-hooks installer's front
 * door. The installer itself is `cli/hooks.ts`; this file is only the verb.
 *
 * Interactive from a terminal — the wizard asks everything except which harness — and
 * answerable up front for an agent: `--yes` applies without a question, with the four
 * toggles (`--guard`, `--stats`, `--map`, `--lint`) each `on|off`. Without `--yes` the
 * same four pre-answer their wizard questions. The ids are validated in `cli/hooks.ts`
 * against the harness registry in `src/harness/`, which is also where the `--harness`
 * help list comes from.
 */

/** `smelt hooks <install|remove> [--harness <id>] [--yes] [--guard on|off]…` — parsed. */
export interface HooksInvocation {
  readonly mode: 'hooks';
  readonly action: 'install' | 'remove';
  readonly harness?: string;
  /** Which install to write or take back out. Absent means detect. */
  readonly scope?: InstallScope;
  /** Apply without asking: the flags and the installed state answer everything. */
  readonly yes: boolean;
  /** The four toggles as flags answered them; absent means "as installed". */
  readonly toggles: ToggleFlags;
}

/**
 * The harnesses at one tier, as the HOOKS paragraph spells them — from
 * `HarnessProfile.tier`, never a second list. A tier no profile claims renders empty
 * rather than naming a harness that moved.
 *
 * The line breaks around these are still hand-placed, and deliberately: this body is
 * byte-pinned by `test/__snapshots__/cli-usage.help.txt`, its paragraph is wrapped by
 * hand at no single width, and a generic wrapper would rewrite every line of the help
 * to derive three lists. The *membership* is what drifted — a promoted harness stayed
 * under its old tier — and membership is what this derives.
 */
function tierNames(tier: HarnessTier): string {
  const group = harnessesByTier().find((candidate) => candidate.tier === tier);
  return group === undefined ? '' : harnessNames(group.harnesses);
}

export const hooksCommand: Subcommand<HooksInvocation, HooksInvocation> = {
  name: 'hooks',
  flags: ['harness', 'scope', 'yes', 'guard', 'stats', 'map', 'lint'],
  refusal: `hooks takes --yes and the four toggles, or asks in the wizard.`,
  usage: {
    synopsis: [
      'hooks install [--harness <id>] [--scope <where>] [--yes] [--<toggle> on|off]...',
      'hooks remove [--harness <id>] [--scope <where>] [--yes]',
    ],
    section: {
      heading: 'HOOKS',
      body:
        `  ${CLI_NAME} hooks install wires the smelt guard into agent-harness hooks: a\n` +
        `  PreToolUse size-guard that refuses oversized raw reads with the exact ${CLI_NAME}\n` +
        `  replacement command (default on), \`${CLI_NAME} stats\` at session end (default\n` +
        `  on), and an opening \`${CLI_NAME} map\` at session start (opt-in) — plus an\n` +
        `  instruction-file snippet that teaches \`${CLI_NAME} retrieve\` after a deny.\n` +
        `  Harnesses are tiered honestly: verified (${tierNames('verified')}), experimental\n` +
        `  (${tierNames('experimental')} — schemas from the capability\n` +
        `  matrix, not yet smoke-tested), advisory (${tierNames('advisory')} — instructions only,\n` +
        `  nothing enforced). Same discipline as init: every file listed before a final\n` +
        `  confirm, nothing overwritten without a per-file yes in the wizard, re-runs\n` +
        `  edit toggles. For an agent, answer it up front:\n\n` +
        `    ${CLI_NAME} hooks install --yes [--harness <id>] [--scope <where>]\n` +
        `      [--guard on|off] [--stats on|off] [--map on|off] [--lint on|off]\n\n` +
        `  A toggle you do not name keeps whatever is already installed; nothing is,\n` +
        `  and the defaults are guard on, stats on, map off, lint off. Under --yes an\n` +
        `  existing file is merged byte-faithfully rather than overwritten, and a file\n` +
        `  smelt writes whole is left alone unless it is already smelt's.\n` +
        `  ${CLI_NAME} hooks remove takes it back out. Guard settings live in\n` +
        `  smelt.config.json ("hooks": {"thresholdBytes", "enforcement": "deny"|"rewrite"});\n` +
        `  deny is the default — rewrite substitutes commands in-flight only where a\n` +
        `  harness supports it, and never silently.`,
    },
  },

  parse(values: FlagValues, positionals: readonly string[]): HooksInvocation {
    const action = positionals[1];
    if (action !== 'install' && action !== 'remove') {
      throw new CliUsageError(
        `${CLI_NAME}: hooks needs an action — install or remove.\n` +
          `  ${CLI_NAME} hooks install [--harness <id>]\n` +
          `  ${CLI_NAME} hooks remove [--harness <id>]`,
      );
    }
    if (positionals.length > 2) {
      throw new CliUsageError(
        `${CLI_NAME}: hooks ${action} takes no further arguments, got ` +
          `${positionals.slice(2).join(', ')}.`,
      );
    }
    // `--harness` is repeatable for setup; this verb wires one action per run, and a
    // second id would be a second install the user believed had happened.
    if (values.harness !== undefined && values.harness.length > 1) {
      throw new CliUsageError(
        `${CLI_NAME}: hooks takes one --harness per run — repeat the command for ` +
          `each harness.`,
      );
    }
    const scope = parseScope(values.scope);
    // The four toggles, each `on|off`. `undefined` is a third answer — "as installed"
    // — so the object carries only the ones somebody typed.
    const toggles: ToggleFlags = {
      ...maybe('guard', parseToggle('guard', values.guard)),
      ...maybe('statsOnStop', parseToggle('stats', values.stats)),
      ...maybe('mapOnStart', parseToggle('map', values.map)),
      ...maybe('lintOnStart', parseToggle('lint', values.lint)),
    };
    return {
      mode: 'hooks',
      action,
      yes: values.yes === true,
      toggles,
      ...(values.harness === undefined ? {} : { harness: values.harness[0] }),
      ...(scope === undefined ? {} : { scope }),
    };
  },

  /** Nothing to merge: the wizard asks, and reads `smelt.config.json` itself. */
  resolve(invocation: HooksInvocation): HooksInvocation {
    return invocation;
  },

  /**
   * Interactive unless `--yes` answered everything, so it needs the wizard stream —
   * and the refusal below is the agent-facing interface documentation, the same trick
   * `init`'s and `setup`'s refusals use.
   */
  async run(resolved: HooksInvocation, io: CliIo): Promise<number> {
    // The same sentence the flow itself throws — one refusal, not two spellings of it.
    if (!resolved.yes && io.initInput === undefined) throw noInteractiveInput(resolved.action);
    return await runHooks(resolved.action, resolved.harness, {
      // `input` stays absent under --yes — exactOptionalPropertyTypes means "absent"
      // is a decision, not a field carrying undefined.
      ...(io.initInput === undefined ? {} : { input: io.initInput }),
      // The lava renderer is for the human at a terminal; --yes is the machine path,
      // and its bytes stay plain however pretty the screen is.
      // Wrapped, because a wizard writes its prompt *before* it reads an answer:
      // `smelt hooks install | head` and `yes | smelt hooks install` both leave it
      // writing into a stream nobody is reading, and unwrapped that is a stack trace
      // and exit 4 — "unexpected internal error" — for two ordinary shell moves.
      output: refusingSink(
        (text) => io.stdout(colorize(text, io.color === true && !resolved.yes, stdoutPalette(io))),
        (why) => closedSink(`hooks ${resolved.action}`, why),
      ),
      cwd: io.cwd ?? process.cwd(),
      ...(io.home === undefined ? {} : { home: io.home }),
      version: io.version,
      ...(resolved.scope === undefined ? {} : { scope: resolved.scope }),
      yes: resolved.yes,
      toggles: resolved.toggles,
      // See setup's: the glyph set is the terminal's fact, not this run's.
      ...(io.unicode === undefined ? {} : { unicode: io.unicode }),
    });
  },
};

/**
 * The refusal a wizard gets when its output has nowhere to go. One line and the usage
 * exit, because that is what it is: a wizard driven by something that is not reading.
 */
function closedSink(what: string, why: string): CliUsageError {
  return new CliUsageError(
    `${CLI_NAME}: ${what} could not write its prompt — the output stream is closed ` +
      `(${why}). It is interactive; answer it up front with --yes instead.`,
  );
}

/** `{key: value}` when the flag was typed, `{}` when it was not. */
function maybe<K extends string>(key: K, value: boolean | undefined): Partial<Record<K, boolean>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, boolean>);
}
