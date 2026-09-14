import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GUIDE_URL } from '../agents/guide.ts';
import { readInstructionSet } from '../agents/instructions.ts';
import type { InstructionFile } from '../agents/instructions.ts';
import { planSplit, refactorPrompt, splitSeamNotice } from '../agents/split.ts';
import type { SplitPlan } from '../agents/split.ts';
import { CliUsageError } from '../errors.ts';
import { readTree } from '../ops/inputs.ts';

import { CLI_NAME } from './shell.ts';
import type { AnswerStream } from './shell.ts';
import {
  askOverwrite,
  confirmYesNo,
  fileFate,
  listPlannedFiles,
  wizardAsk,
  writePlannedFile,
} from './wizard.ts';
import type { Ask, PlannedFileLike } from './wizard.ts';

/**
 * `smelt agents split` — the wizard, and nothing else.
 *
 * The partition, the link rewrite and the refactor prompt are `src/agents/split.ts`,
 * which is strings in, strings out and knows nothing about a terminal. What lives here
 * is the half that touches disk, and it is `smelt init`'s discipline verbatim, for the
 * reason stated in `cli/hooks.ts`: this command rewrites a file somebody wrote by hand,
 * and a hand-written AGENTS.md clobbered by a tool is somebody's day gone.
 *
 *   - every file listed, with `new` / `exists` / `unchanged`, before anything is written;
 *   - one final `yes`;
 *   - an existing file overwritten only after its **own** literal `yes` — not `y`, not
 *     Enter;
 *   - the guide's refactor prompt printed either way, because the judgment half is
 *     what the user actually came for and refusing the writes does not change that.
 */

/** Where the split wizard's bytes come from and go. Injected, so it tests in-process. */
export interface AgentsSplitIo {
  /** Scripted answers in, one line at a time. See {@link AnswerStream}. */
  readonly input: AnswerStream;
  readonly output: (text: string) => void;
  /** The working directory; every write is relative to `dir` resolved against it. */
  readonly cwd: string;
  /** The directory to split, as typed. `'.'` by default. */
  readonly dir: string;
}

/**
 * One `smelt agents split` run, start to finish. Returns an exit code, never calls
 * `exit` — the same testability shape as `runInit` and `runHooks`.
 *
 * @throws {CliUsageError} when the directory cannot be read, when there is no
 *   instruction file to split, or when input ends mid-wizard. A refusal, never a guess:
 *   splitting a file smelt had to invent would be the auto-generation the guide rules
 *   out, and a missing directory reported as an internal error would be smelt blaming
 *   itself for a typo.
 */
export async function runAgentsSplit(io: AgentsSplitIo): Promise<number> {
  // `resolve`, not `join`: an absolute `dir` is the user's answer, and concatenating
  // the working directory onto it invents a path nobody named. Then the same tree
  // ruling `agents lint` uses — a directory that is not there is a refusal naming it,
  // not an ENOENT escaping as "unexpected internal error" with a stack trace.
  const root = resolve(io.cwd, io.dir);
  const tree = readTree(root, io.dir, { tree: 'agents split', file: `\`${CLI_NAME} <file>\`` });
  if (!tree.ok) throw new CliUsageError(`${CLI_NAME}: ${tree.refusal}`);

  const set = readInstructionSet({ root });
  const rootLevel = set.levels.find((level) => level.dir === '');

  if (rootLevel === undefined) {
    throw new CliUsageError(
      `${CLI_NAME} agents split: no AGENTS.md, CLAUDE.md or GEMINI.md at ${io.dir}. ` +
        `There is nothing to split, and ${CLI_NAME} will not write one for you — ` +
        `the guide it follows says never to auto-generate an AGENTS.md (${GUIDE_URL}).`,
    );
  }

  const file: InstructionFile = rootLevel.primary;
  const plan = planSplit(file);

  io.output(
    `${CLI_NAME} agents split — the mechanical half of the guide's refactor.\n` +
      `Nothing is written until you confirm, and an existing file is never overwritten\n` +
      `without its own yes.\n\n`,
  );

  if (plan.refusal !== undefined) {
    io.output(`  ${plan.refusal}\n\n`);
    return 0;
  }

  io.output(
    `${plan.source}: ${String(plan.beforeBytes)} bytes, ` +
      `${String(plan.sections.length)} \`##\` section${plan.sections.length === 1 ? '' : 's'}.\n` +
      `The root file would become ${String(plan.afterBytes)} bytes — everything above the\n` +
      `first heading, plus a link to each moved section.\n\n`,
  );

  const { ask, release } = wizardAsk(
    io.input,
    io.output,
    `${CLI_NAME} agents split: input ended before the wizard finished. ` +
      `Files already confirmed and written stay; nothing further was written.`,
  );

  try {
    await confirmAndWrite(io, ask, root, plan);
  } finally {
    await release();
  }

  // Printed whether or not anything was written: the prompt is the half of the
  // refactor smelt refused to do, and refusing the writes does not make it less true.
  io.output(`\n${refactorPrompt(plan)}\n`);
  io.output(`${splitSeamNotice()}\n`);
  return 0;
}

/** A file the split would write, checked against what is on disk right now. */
/** One file the split would write — the kit's planned-file shape, checked against disk. */
type PlannedSplitFile = PlannedFileLike;

function planned(root: string, name: string, content: string): PlannedSplitFile {
  const path = join(root, name);
  const exists = existsSync(path);
  return {
    name,
    path,
    content,
    exists,
    unchanged: exists && readFileSync(path, 'utf8') === content,
  };
}

async function confirmAndWrite(
  io: AgentsSplitIo,
  ask: Ask,
  root: string,
  plan: SplitPlan,
): Promise<void> {
  const files = plan.files.map((file) => planned(root, file.path, file.content));

  io.output(`About to write, into ${root}:\n`);
  listPlannedFiles(io.output, files, [], (file) => fileFate(file, 'ask'));
  io.output(`Nothing has been written yet.\n`);

  if (
    (await confirmYesNo(ask, io.output, 'yes to write, no to leave everything untouched.')) === 'no'
  ) {
    io.output(`Nothing was written.\n`);
    return;
  }

  for (const file of files) {
    if (file.unchanged) {
      io.output(`  ${file.name} — unchanged, not rewritten\n`);
      continue;
    }
    // The one hard rule, shared through the kit with `smelt init` and `smelt hooks`:
    // an existing file is never touched without an explicit per-file yes. The root
    // instruction file is *always* on this branch, by construction.
    if (file.exists && !(await askOverwrite(file.name, ask))) {
      io.output(`  skipped ${file.name} — the existing file was not touched\n`);
      continue;
    }
    writePlannedFile(file);
    io.output(`  wrote ${file.name}\n`);
  }
}
