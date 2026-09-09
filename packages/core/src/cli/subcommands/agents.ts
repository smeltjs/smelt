import process from 'node:process';

import { lintAgents, overBudgetBytes } from '../../agents/lint.ts';
import type { AgentsLintReport } from '../../agents/lint.ts';
import { CliUsageError } from '../../errors.ts';
import { readTree } from '../../ops/inputs.ts';
import { colorize, stdoutPalette } from '../lava.ts';
import { runAgentsSplit } from '../agents.ts';
import { CONFIG_FILE_NAME } from '../config.ts';
import type { LoadedConfig } from '../config.ts';
import { formatAgentsReport } from '../report.ts';
import { CLI_NAME, EXIT } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import type { FlagValues } from './flags.ts';
import type { ConfigSource, Subcommand } from './subcommand.ts';

/**
 * `smelt agents` — the instruction files an agent loads on **every** request.
 *
 * The verb exists because `AGENTS.md` is the one blob in a repository that is paid for
 * on every single request, relevant or not, and nothing measures it. That is smelt's
 * own subject, so the fit is exact — and the two actions divide along the line smelt
 * divides everything else along:
 *
 *  - **`lint`** measures and explains. It never edits.
 *  - **`split`** edits, mechanically, under `smelt init`'s consent discipline — and
 *    says plainly which half of the refactor it refused to do.
 *
 * There is no `smelt agents init`, and there will not be one: the guide this verb
 * lints against says in as many words never to auto-generate an AGENTS.md, and a tool
 * that built the thing its own source warns against would be worth less than no tool
 * (ruling R1).
 */

/** `smelt agents <lint|split> [path]` — parsed. */
export interface AgentsInvocation {
  readonly mode: 'agents';
  readonly action: 'lint' | 'split';
  /** The directory to read. Defaults to `.`; always a directory, never a file. */
  readonly dir: string;
  /** `lint` only: any finding exits 1. */
  readonly strict: boolean;
  /** `lint` only: the versioned envelope instead of the text report. */
  readonly json: boolean;
}

/** Everything one `smelt agents lint` run needs, fully merged. */
export interface ResolvedAgentsRun {
  readonly action: 'lint' | 'split';
  readonly dir: string;
  readonly strict: boolean;
  readonly json: boolean;
  /**
   * The user's byte ceiling for the merged set, from `smelt.config.json`.
   *
   * **Absent means unbudgeted, and there is no built-in fallback** (ruling R2). This
   * field carries no `budgetSource`, unlike {@link ResolvedRun}'s, precisely because
   * there is only one source it can have come from: a budget here is always the
   * user's, never a flag and never smelt's.
   */
  readonly budgetBytes?: number;
}

/**
 * The `smelt agents lint --json` envelope format. Its own version line, like the map
 * and stats envelopes: a lint report carries rule ids and byte counts per level, a
 * structure that has to be able to move without dragging the other two with it.
 */
export const CLI_AGENTS_JSON_FORMAT = 'smelt-agents-cli/v1';

/** What `smelt agents lint --json` prints. */
export interface CliAgentsJsonEnvelope {
  readonly format: string;
  /** The {@link AgentsLintReport} exactly as `lintAgents` returned it. */
  readonly report: AgentsLintReport;
}

export const agentsCommand: Subcommand<AgentsInvocation, ResolvedAgentsRun> = {
  name: 'agents',
  flags: ['strict', 'json'],
  refusal:
    `agents reads the instruction files in a tree and reports on them — it plans no ` +
    `elisions, stores nothing, and has no budget of its own to take: the only budget ` +
    `it honours is agents.budgetBytes in ${CONFIG_FILE_NAME}, which is yours.`,
  usage: {
    synopsis: ['agents lint [dir] [--strict] [--json]'],
    occasional: ['agents split [dir]'],
    section: {
      heading: 'AGENTS',
      body:
        `  ${CLI_NAME} agents lint audits the instruction files an agent loads on every\n` +
        `  request — every AGENTS.md, CLAUDE.md and GEMINI.md in the tree, because a\n` +
        `  nested one merges with the root. A merge runs up the tree and never across\n` +
        `  it, so it reports bytes per level, the per-request worst case (the heaviest\n` +
        `  level plus its ancestors — what one agent actually loads) and the whole-tree\n` +
        `  surface, plus an imperative count labelled a heuristic. Then eight advisory\n` +
        `  rules: dead-path and dead-link (path-like tokens and links resolved against\n` +
        `  the real tree — the check nobody else makes, and the reason to run this in\n` +
        `  CI), forcing-language, structure-dump, generated-boilerplate, language-rule,\n` +
        `  mirror-drift and restated-at-level. Every finding carries a stable rule id\n` +
        `  and a sentence citing the guide it applies\n` +
        `  (aihero.dev/a-complete-guide-to-agents-md). Findings exit 0; --strict makes\n` +
        `  any finding exit 1. There is no built-in size limit: set agents.budgetBytes\n` +
        `  in ${CONFIG_FILE_NAME} and exceeding it exits 1, as every other ${CLI_NAME}\n` +
        `  budget does. The guide's own "~150-200 instructions" figure is printed as a\n` +
        `  citation and compared to nothing.\n` +
        `\n` +
        `  ${CLI_NAME} agents split does the MECHANICAL half of the guide's refactor:\n` +
        `  partition the root file by ## heading into one Markdown file per section\n` +
        `  under docs/, rewrite the relative links that moved a directory deeper, and\n` +
        `  leave a link list behind. Same discipline as init and hooks — every file\n` +
        `  listed, one confirm, an existing file never overwritten without a per-file\n` +
        `  yes. It does NOT decide which sections are essential: that is a reading of\n` +
        `  your project, so it needs a model, and ${CLI_NAME} has none by law. Instead it\n` +
        `  prints the guide's own refactor prompt with your real section headings filled\n` +
        `  in, for you to hand to your own agent. That seam is the point, not an\n` +
        `  omission. There is no \`${CLI_NAME} agents init\`: the guide says never to\n` +
        `  auto-generate an AGENTS.md.`,
    },
  },

  /**
   * An action, and at most one directory. `lint` defaults to `.` because the everyday
   * invocation is "lint here" — unlike `map`, which is always aimed somewhere.
   */
  parse(values: FlagValues, positionals: readonly string[]): AgentsInvocation {
    const action = positionals[1];
    if (action !== 'lint' && action !== 'split') {
      throw new CliUsageError(
        `${CLI_NAME}: agents needs an action — lint or split.\n` +
          `  ${CLI_NAME} agents lint [dir] [--strict] [--json]\n` +
          `  ${CLI_NAME} agents split [dir]`,
      );
    }
    if (positionals.length > 3) {
      throw new CliUsageError(
        `${CLI_NAME}: agents ${action} takes at most one directory, got ` +
          `${String(positionals.length - 2)} (${positionals.slice(2).join(', ')}).`,
      );
    }
    if (action === 'split' && (values.strict === true || values.json === true)) {
      throw new CliUsageError(
        `${CLI_NAME}: --strict and --json belong to \`${CLI_NAME} agents lint\`. ` +
          `split is interactive and writes files; a report format and a CI exit code ` +
          `have nothing to act on there.`,
      );
    }
    return {
      mode: 'agents',
      action,
      dir: positionals[2] ?? '.',
      strict: values.strict === true,
      json: values.json === true,
    };
  },

  resolve(invocation: AgentsInvocation, config: ConfigSource): ResolvedAgentsRun {
    return resolveAgentsRun(invocation, config());
  },

  run(resolved: ResolvedAgentsRun, io: CliIo): number | Promise<number> {
    return resolved.action === 'lint' ? runLint(resolved, io) : runSplit(resolved, io);
  },
};

/**
 * Merge one `'agents'` invocation with the loaded config.
 *
 * The whole merge is one key, and it has **no flag** on purpose. A `--budget` here
 * would be a ceiling typed on the command line, which is a ceiling nobody in the
 * repository has agreed to; the number that matters is the one committed in
 * `smelt.config.json` where CI and every contributor read the same value. So unlike
 * every other verb with a budget, this one cannot refuse for a missing budget: absent
 * is a legitimate state, and it means "measure, do not fail".
 */
export function resolveAgentsRun(
  invocation: AgentsInvocation,
  config: LoadedConfig | undefined,
): ResolvedAgentsRun {
  const budgetBytes = config?.config.agents?.budgetBytes;
  return {
    action: invocation.action,
    dir: invocation.dir,
    strict: invocation.strict,
    json: invocation.json,
    ...(budgetBytes === undefined ? {} : { budgetBytes }),
  };
}

/**
 * One `smelt agents lint` run: prove the target is a tree, lint it, render, exit.
 *
 * Three exit codes, and the reasoning for each:
 *
 *  - **1 over the user's budget.** Identical to a `smelt` run that did not fit, and
 *    identical for the same reason: not an error, not a success, and a script must be
 *    able to tell without parsing prose. It applies with or without `--strict`,
 *    because the number came from the repository rather than from smelt.
 *  - **1 with `--strict` and any finding.** The CI switch. Off by default because the
 *    rules are advisory heuristics.
 *  - **0** otherwise, findings and all.
 */
function runLint(run: ResolvedAgentsRun, io: CliIo): number {
  const tree = readTree(run.dir, run.dir, {
    tree: 'agents lint',
    file: `\`${CLI_NAME} <file>\``,
  });
  if (!tree.ok) throw new CliUsageError(`${CLI_NAME}: ${tree.refusal}`);

  const report = lintAgents({
    root: tree.value,
    ...(run.budgetBytes === undefined ? {} : { budgetBytes: run.budgetBytes }),
  });

  if (run.json) {
    const envelope: CliAgentsJsonEnvelope = { format: CLI_AGENTS_JSON_FORMAT, report };
    io.stdout(`${JSON.stringify(envelope, null, 2)}\n`);
  } else {
    io.stdout(
      formatAgentsReport(report, { source: run.dir, strict: run.strict }, stdoutPalette(io)),
    );
  }

  if (overBudgetBytes(report) !== undefined) return EXIT.overBudget;
  if (run.strict && report.findings.length > 0) return EXIT.overBudget;
  return EXIT.ok;
}

/** `smelt agents split` is interactive like `init` and `hooks`, and refuses without a stream. */
async function runSplit(run: ResolvedAgentsRun, io: CliIo): Promise<number> {
  if (io.initInput === undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: agents split is interactive — it lists every file it would write ` +
        `and asks before each one — and this invocation has no interactive input ` +
        `stream. Run \`${CLI_NAME} agents split\` from a terminal.`,
    );
  }
  return await runAgentsSplit({
    input: io.initInput,
    output: (text) => io.stdout(colorize(text, io.color === true)),
    cwd: io.cwd ?? process.cwd(),
    dir: run.dir,
  });
}
