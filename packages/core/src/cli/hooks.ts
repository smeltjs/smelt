import { unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CliUsageError } from '../errors.ts';
import { detectedHarnesses, planInstall, planRemove } from '../harness/plan.ts';
import type { HooksChoices } from '../harness/plan.ts';
import { TIER_HONESTY } from '../harness/profile.ts';
import type { HarnessProfile } from '../harness/profile.ts';
import { HARNESSES, harnessById, harnessNames, lifecycleHarnesses } from '../harness/registry.ts';
import { resolveScope, scopeRoot } from '../harness/scope.ts';
import type { InstallScope } from '../harness/scope.ts';
import { DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import { presetToggles, withToggleFlags } from './installed.ts';
import type { PresetToggles, ToggleFlags } from './installed.ts';
import { countedFiles, doneBlock, palette } from './lava.ts';
import type { Palette } from './lava.ts';
import { applyPlanFiles } from './merge-policy.ts';
import type { AppliedFile } from './merge-policy.ts';
import { confirmLoop, confirmYesNo, listPlannedFiles, walkSteps, wizardAsk } from './wizard.ts';
import type { Ask } from './wizard.ts';
import { CLI_NAME } from './shell.ts';
import type { AnswerStream } from './shell.ts';
import { CONFIG_FILE_NAME } from '../config.ts';

/**
 * `smelt hooks install` / `smelt hooks remove` — the wizard over the guard preset.
 *
 * The design behind the verb: one zero-dependency guard core
 * (`src/hooks/guard-core.ts`), thin per-harness shims mapping each harness's native
 * hook schema onto it, and an installer that writes the harness config wiring a shim
 * in — plus an instruction-file snippet as belt and braces, because the snippet is
 * also what teaches the model to run `smelt retrieve` after a deny.
 *
 * What is left in this module is the **wizard**, and only the wizard: the steps, the
 * confirm, the prose. The three things it used to hold as well now sit where their
 * other caller can reach them without importing a wizard —
 *
 *  - `harness/plan.ts` — what a run would write, and what `remove` takes back out.
 *  - `cli/merge-policy.ts` — whether an existing file may be written, and the one
 *    apply loop both verbs drive.
 *  - `cli/installed.ts` — the toggles a re-run reads back off what is installed.
 *
 * `smelt setup` imports those three and nothing from here, which is the seam
 * `test/guards/module-seams.test.ts` pins: the two verbs share a plan and a policy,
 * not a wizard.
 *
 * Harnesses come in three honesty tiers (docs/research/2026-09-02-harness-capability-matrix.md),
 * and which harness sits at which is `HarnessProfile.tier` — read through
 * `harnessesByTier()`, never listed again here:
 *
 *  - **verified** — schemas verified against primary docs and exercised against
 *    recorded fixtures; first-class targets.
 *  - **experimental** — hook schemas mapped from the capability matrix but not yet
 *    smoke-tested green against the real binary. Labelled as such in code, docs, and
 *    this installer's output.
 *  - **advisory** — no usable hook API, so what ships is instructions (and, for
 *    KiloCode, a permissions/MCP sketch). Nothing enforces them, and the output says
 *    so rather than implying a guard exists.
 *
 * The wizard discipline is `smelt init`'s, verbatim: every step accepts `back`,
 * nothing is written until a final confirm that lists every file, and an existing
 * file is never overwritten without an explicit per-file `yes` — the rule itself is
 * `cli/merge-policy.ts`'s `wizard` consent, guarded by
 * `test/guards/hooks-preset.test.ts`, with mutation `hooks-install-overwrite-without-consent`
 * proving the guard goes red.
 */

/** Where the wizard's bytes come from and go. Injected so `runHooks` tests in-process. */
export interface HooksIo {
  /**
   * Scripted answers in, one line at a time. Structural on purpose; see
   * {@link AnswerStream}. Required only for the interactive path — `--yes` never asks.
   */
  readonly input?: AnswerStream;
  readonly output: (text: string) => void;
  /** Project directory: detection, config discovery, and every write are relative to it. */
  readonly cwd: string;
  /**
   * Home directory: harness detection, and — at user scope — where every file goes.
   * Tests point it at a temp dir, which is the only way a user-scope install is
   * testable without writing into the developer's own home.
   */
  readonly home?: string;
  /**
   * This project or this machine. Absent means detect: `user` when {@link cwd} *is*
   * {@link home}, `project` otherwise. The wizard states what it found and, where it
   * found `user`, offers to flip it.
   */
  readonly scope?: InstallScope;
  /**
   * The release running the install — stamped into the instruction block so
   * `smelt doctor` can tell what wrote it. Absent (legacy callers) writes no stamp.
   */
  readonly version?: string;
  /**
   * Answer every question from the flags and the installed state, and apply without
   * a confirm — the non-interactive interface `--yes` is. The apply loop is the same
   * one the wizard drives; only who consents differs (`Consent`, `cli/merge-policy.ts`).
   */
  readonly yes?: boolean;
  /**
   * The four toggles as flags answered them. An absent one is *not* `off`: it means
   * leave it as the install found it, which is what {@link presetToggles} reads.
   */
  readonly toggles?: ToggleFlags;
  /**
   * Whether the terminal's locale said it can render more than ASCII. The glyph set
   * (`✓ ✗ ⚠`), the closing block's rule and the banner's bar fall back to `+ x !` and
   * `-` where it did not. Absent means yes, which is what this wizard has always
   * printed. Computed once by `bin.ts`; see `lava.ts`'s `supportsUnicode`.
   */
  readonly unicode?: boolean;
}

/* ------------------------------------------------------------------------------------
 * The wizard
 * ---------------------------------------------------------------------------------- */

type Asker = Ask;

/**
 * `smelt hooks <install|remove>`, start to finish. The same testability pattern as
 * `runInit`: a pure function over an input/output pair, exit code returned. The ask
 * adapter, the step machine and the confirms are the wizard kit's (`cli/wizard.ts`) —
 * this file holds what is hooks' own: the steps, the plan, the per-file consent.
 */
export async function runHooks(
  action: 'install' | 'remove',
  harnessFlag: string | undefined,
  io: HooksIo,
): Promise<number> {
  if (io.yes !== true && io.input === undefined) throw noInteractiveInput(action);
  const wizard =
    io.yes === true || io.input === undefined
      ? undefined
      : wizardAsk(
          io.input,
          io.output,
          `${CLI_NAME} hooks: input ended before the wizard finished. ` +
            `Files already confirmed and written stay; nothing further was written.`,
        );
  const ask: Ask =
    wizard?.ask ??
    (async () => {
      // --yes never asks; a question reached with no stream is a bug in the flow,
      // not an answer the user owes.
      throw new CliUsageError(
        `${CLI_NAME} hooks: a question was reached with no interactive input — ` +
          `this is a bug in the flow, not an answer you owe.`,
      );
    });
  try {
    return action === 'install'
      ? await installFlow(io, ask, harnessFlag)
      : await removeFlow(io, ask, harnessFlag);
  } finally {
    await wizard?.release();
  }
}

/**
 * The refusal for "no `--yes`, and no stream to ask on" — one sentence, thrown by the
 * verb before the flow starts *and* by the flow itself, because they are the same
 * fact. A non-null assertion in the flow would have been the flow trusting the verb to
 * have checked, which is exactly the kind of promise nothing enforces.
 */
export function noInteractiveInput(action: 'install' | 'remove'): CliUsageError {
  return new CliUsageError(
    `${CLI_NAME}: hooks ${action} is interactive unless you answer it up front, and ` +
      `this invocation has no interactive input stream. Non-interactive:\n` +
      `  ${CLI_NAME} hooks ${action} --yes [--harness <id>] [--scope <where>]` +
      (action === 'install'
        ? ` [--guard on|off] [--stats on|off] [--map on|off] [--lint on|off]`
        : ''),
  );
}

function resolveHarnessFlag(flag: string): HarnessProfile {
  const profile = harnessById(flag);
  if (profile === undefined) {
    throw new CliUsageError(
      `${CLI_NAME} hooks: unknown harness "${flag}". ` +
        `Known: ${HARNESSES.map((h) => h.id).join(', ')}.`,
    );
  }
  return profile;
}

function tierLabel(profile: HarnessProfile): string {
  return `${profile.id.padEnd(12)} ${profile.name.padEnd(14)} [${profile.tier}] — ${TIER_HONESTY[profile.tier]}`;
}

async function installFlow(
  io: HooksIo,
  ask: Asker,
  harnessFlag: string | undefined,
): Promise<number> {
  const home = io.home ?? homedir();
  const detected = detectedHarnesses(io.cwd, home);
  const detectedScope = resolveScope(io.scope, { cwd: io.cwd, home });

  // The toggles a run starts from, whichever path it takes: the wizard's defaults,
  // overridden by what is installed for these harnesses, overridden by the flags.
  // Under --yes that is the whole answer; in the wizard it is what Enter accepts.
  const choices: HooksChoices = {
    harnesses: harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...detected],
    ...(io.version === undefined ? {} : { writtenBy: io.version }),
    ...withToggleFlags(presetToggles(io.cwd, { scope: detectedScope, home }), io.toggles ?? {}),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    scope: detectedScope,
    home,
  };

  // Everything above is what both paths decide from; --yes needs nothing more, and
  // the banner below is the wizard's, not its.
  if (io.yes === true) return applyWithoutAsking(io, choices, home);

  io.output(
    `${CLI_NAME} hooks install — wires the smelt guard into agent-harness hooks.\n` +
      `Answer \`back\` at any step to return to the previous one. Nothing is written ` +
      `until you confirm at the end.\n\n`,
  );

  /**
   * Take a scope, and re-read the toggles **that scope's** files carry.
   *
   * A re-run edits rather than resets, and what it edits is what is installed *at the
   * scope being installed to*. Reading the machine's toggles and then writing the
   * project's spellings is the reset this reading exists to prevent, one directory
   * over: the user answers "project", and the project's own guard/stats/map/lint
   * settings are replaced by the machine's. Unchanged when the answer is the scope
   * already settled on, so going `back` past this question does not discard toggles
   * the user typed after it.
   *
   * The flags are re-applied on top, for the same reason they were applied above: a
   * `--map on` the user typed is an answer, and a scope flip is not a reason to
   * forget it. Absent flags leave the new scope's own reading standing.
   */
  const useScope = (next: InstallScope): void => {
    if (choices.scope === next) return;
    choices.scope = next;
    Object.assign(
      choices,
      withToggleFlags(presetToggles(io.cwd, { scope: next, home }), io.toggles ?? {}),
    );
  };

  // With --harness the selection step is skipped, so the tier label — and its one
  // line of honesty about what the tier means — is printed here instead.
  if (harnessFlag !== undefined) {
    for (const profile of choices.harnesses) io.output(`  ${tierLabel(profile)}\n`);
  }

  const steps: readonly ((io_: HooksIo, ask_: Asker) => Promise<'ok' | 'back'>)[] = [
    // Asked only where detection said `user` — from any other directory `project` is
    // the only reading that makes sense, and a question with one possible answer is a
    // question that trains people to hit Enter.
    async (io_, ask_) =>
      io.scope !== undefined || detectedScope === 'project'
        ? 'ok'
        : stepScope(io_, ask_, useScope, home),
    async (io_, ask_) =>
      harnessFlag !== undefined ? 'ok' : stepHarnesses(io_, ask_, choices, detected),
    async (io_, ask_) =>
      stepToggle(io_, ask_, 'PreToolUse size-guard', guardCopy(), choices.guard, (on) => {
        choices.guard = on;
      }),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'stats on Stop',
        `\`smelt stats\` runs when a session ends — the honest signal (expansion rate) ` +
          `surfaced where the turn ends. Observation only; never blocks. Wired for the ` +
          `harnesses whose hooks carry session events (${harnessNames(lifecycleHarnesses())}).`,
        choices.statsOnStop,
        (on) => {
          choices.statsOnStop = on;
        },
      ),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'repo map on SessionStart',
        `\`smelt map . --budget …\` runs at session start and its output opens the ` +
          `context — the agent starts oriented. Costs one map build per session. ` +
          `Wired for the harnesses whose hooks carry session events ` +
          `(${harnessNames(lifecycleHarnesses())}).`,
        choices.mapOnStart,
        (on) => {
          choices.mapOnStart = on;
        },
      ),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'instruction-file lint on SessionStart',
        `\`smelt agents lint .\` runs at session start and reports on the AGENTS.md, ` +
          `CLAUDE.md and GEMINI.md this session is about to load on every request — ` +
          `bytes per level, and any path or link in them that no longer resolves. ` +
          `Advisory: it never blocks, and it exits 0 unless you set ` +
          `agents.budgetBytes in ${CONFIG_FILE_NAME}. Wired for verified-tier ` +
          `harnesses (Claude Code, Codex).`,
        choices.lintOnStart,
        (on) => {
          choices.lintOnStart = on;
        },
      ),
    async (io_, ask_) => stepEnforcement(io_, ask_, choices),
    async (io_, ask_) => stepThreshold(io_, ask_, choices),
  ];

  const machine = steps.map((step) => (a: Ask) => step(io, a));
  for (;;) {
    await walkSteps(machine, ask, io.output);
    if (choices.harnesses.length === 0) {
      io.output(`No harness selected. Nothing to do; nothing was written.\n`);
      return 0;
    }
    const verdict = await confirmAndInstall(io, ask, choices);
    if (verdict !== 'back') return 0;
    await walkSteps(machine, ask, io.output, machine.length - 1);
  }
}

/**
 * `--yes`: no questions, and every answer said out loud before it is applied. The
 * plan and the apply loop are the wizard's own — what differs is only who consents
 * (`{kind:'policy'}`, the merge policy above), because a second apply loop for the
 * path nobody watches is how the two would drift.
 *
 * @throws {CliUsageError} when nothing was detected and nothing was named — the one
 *   question `--yes` cannot answer from the machine, so it names the flag that does.
 */
async function applyWithoutAsking(
  io: HooksIo,
  choices: HooksChoices,
  home: string,
): Promise<number> {
  if (choices.harnesses.length === 0) {
    throw new CliUsageError(
      `${CLI_NAME} hooks install --yes: no harness config directory found in ${io.cwd} ` +
        `or ${home}, and none named. Name one with --harness <id>. ` +
        `Known: ${HARNESSES.map((profile) => profile.id).join(', ')}.`,
    );
  }
  const scope = choices.scope ?? 'project';
  const root = scopeRoot(scope, { cwd: io.cwd, home });
  io.output(
    `${CLI_NAME} hooks install --yes — applying, into ${root}:\n` +
      choices.harnesses.map((profile) => `  ${tierLabel(profile)}\n`).join('') +
      `  toggles: ${toggleLine(choices)}\n` +
      `  an existing file is merged, never overwritten; a file smelt writes whole is ` +
      `left alone unless it is already smelt's\n`,
  );

  const plan = planInstall(io.cwd, choices);
  const applied = await applyPlanFiles(plan.files, { kind: 'policy' });
  for (const one of applied) io.output(sayApplied(one));
  for (const skip of plan.skipped) io.output(`  skipped ${skip.name} — ${skip.why}\n`);
  for (const step of plan.manual) {
    io.output(
      `  ${step.name} is ${step.harness}'s own file — run this yourself:\n    ${step.command}\n`,
    );
  }
  for (const note of plan.notes) io.output(`note: ${note}\n`);
  const lava = palette({ unicode: io.unicode !== false });
  io.output(
    doneBlock(
      {
        ok: true,
        what: `${CLI_NAME} hooks install`,
        // The skips count too: a harness whose file this preset will not write is a
        // file this run did not write, and a verdict that named only what was applied
        // would quietly round four-of-six up to four-of-four.
        summary: countedFiles(
          [...applied.map((one) => one.action), ...plan.skipped.map(() => 'skipped' as const)],
          lava,
        ),
        note:
          `Re-run with different toggles to edit them; ` +
          `\`${CLI_NAME} hooks remove --yes\` takes it all back out.`,
        next: installedNext(lava),
      },
      lava,
    ),
  );
  return 0;
}

/**
 * What to run after a hooks install, in the order a person needs it: prove the wiring
 * fires, then use it. Shared by the `--yes` path and the wizard, because two closing
 * blocks that disagree about the next command is exactly the drift the block exists to
 * end.
 */
function installedNext(lava: Palette): readonly (readonly [string, string])[] {
  return [
    [`${CLI_NAME} doctor`, 'prove the wiring fires, and what is behind'],
    [`${CLI_NAME} <file> --budget 4000`, `smelt one file ${lava.dash()} the report says what went`],
  ];
}

/** One toggle, as both the wizard prompt and the --yes summary spell it. */
const onOff = (on: boolean): string => (on ? 'on' : 'off');

/** `guard on, stats on, map off, lint off` — what a --yes run is about to wire. */
function toggleLine(toggles: PresetToggles): string {
  return (
    `guard ${onOff(toggles.guard)}, stats ${onOff(toggles.statsOnStop)}, ` +
    `map ${onOff(toggles.mapOnStart)}, lint ${onOff(toggles.lintOnStart)}`
  );
}

function guardCopy(): string {
  return (
    `Denies raw Reads (and simple \`cat\`s) of files over the size threshold, with a ` +
    `reason naming the exact \`smelt\` replacement — the model still sees everything: ` +
    `smelted first, \`smelt retrieve\` for the rest. Windowed reads (offset/limit) ` +
    `always pass.`
  );
}

/**
 * The one scope question, asked only where detection said `user`. It states what was
 * found and what each answer writes; Enter takes the detected answer.
 */
async function stepScope(
  io: HooksIo,
  ask: Asker,
  useScope: (scope: InstallScope) => void,
  home: string,
): Promise<'ok' | 'back'> {
  io.output(
    `\nYou are in your home directory, so this looks like a machine-wide install:\n` +
      `  every harness file goes to its own documented user-level location under ` +
      `${home}, and ${CONFIG_FILE_NAME} to ${join(home, CONFIG_FILE_NAME)} — which ` +
      `every project below it finds, because config discovery walks up.\n` +
      `  A project install writes into ${io.cwd} instead, and only that project sees it.\n` +
      `  A harness that documents no user-level location for a file is listed as ` +
      `skipped, never guessed into ${home}.\n`,
  );
  for (;;) {
    const answer = await ask(`scope (1 machine / 2 project) [1]> `);
    if (answer === 'back') return 'back';
    if (answer === '' || answer === '1') {
      useScope('user');
      return 'ok';
    }
    if (answer === '2') {
      useScope('project');
      return 'ok';
    }
    io.output(`1 for this machine, 2 for this project.\n`);
  }
}

async function stepHarnesses(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
  detected: readonly HarnessProfile[],
): Promise<'ok' | 'back'> {
  io.output(`\nHarnesses — detected by their config directories (project or home):\n`);
  for (const profile of HARNESSES) {
    const mark = detected.includes(profile) ? '*' : ' ';
    io.output(`  ${mark} ${tierLabel(profile)}\n`);
  }
  io.output(`(* = detected here)\n`);
  for (;;) {
    const current = choices.harnesses.map((profile) => profile.id).join(',') || '(none)';
    const answer = await ask(
      `install for which? (comma-separated ids, Enter = ${current}, or back)\n> `,
    );
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    const ids = answer
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const chosen: HarnessProfile[] = [];
    let bad: string | undefined;
    for (const id of ids) {
      const profile = harnessById(id);
      if (profile === undefined) bad = id;
      else if (!chosen.includes(profile)) chosen.push(profile);
    }
    if (bad !== undefined) {
      io.output(`Unknown harness "${bad}". Known: ${HARNESSES.map((h) => h.id).join(', ')}.\n`);
      continue;
    }
    choices.harnesses = chosen;
    return 'ok';
  }
}

async function stepToggle(
  io: HooksIo,
  ask: Asker,
  name: string,
  copy: string,
  current: boolean,
  set: (on: boolean) => void,
): Promise<'ok' | 'back'> {
  io.output(`\n${name} — ${copy}\n`);
  for (;;) {
    const answer = await ask(`${name}? (on/off) [${current ? 'on' : 'off'}] (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    if (answer === 'on' || answer === 'off') {
      set(answer === 'on');
      return 'ok';
    }
    io.output(`on, off, or back.\n`);
  }
}

async function stepEnforcement(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'ok' | 'back'> {
  io.output(
    `\nEnforcement — what happens when the guard catches an oversized raw read:\n` +
      `  1. deny     — refuse with a reason naming the exact replacement command. The\n` +
      `                transcript stays truthful; the model runs the replacement itself.\n` +
      `  2. rewrite  — on harnesses whose hooks can modify tool input, substitute the\n` +
      `                replacement in-flight (grep/cat piped through smelt). Never\n` +
      `                silent: the substitution is announced in the decision reason\n` +
      `                where the harness has one, on stderr where it does not.\n` +
      `                Harnesses that cannot rewrite fall back to deny.\n`,
  );
  for (;;) {
    const current = choices.enforcement === 'deny' ? '1' : '2';
    const answer = await ask(`enforcement (1/2) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    if (pick === '1' || pick === '2') {
      choices.enforcement = pick === '1' ? 'deny' : 'rewrite';
      return 'ok';
    }
    io.output(`1 for deny, 2 for rewrite, or back.\n`);
  }
}

async function stepThreshold(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'ok' | 'back'> {
  io.output(
    `\nSize threshold — reads at or under this many bytes always pass. The ${String(
      DEFAULT_THRESHOLD_BYTES,
    )}-byte default comes from the measured validation in ` +
      `docs/research/2026-09-02-agent-enforcement.md § 5.\n`,
  );
  for (;;) {
    const answer = await ask(`threshold in bytes [${String(choices.thresholdBytes)}] (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.thresholdBytes = Number(answer);
      return 'ok';
    }
    io.output(`A whole number of bytes greater than zero, e.g. 8192.\n`);
  }
}

/** One applied file, as this verb's prose spells it. */
function sayApplied(applied: AppliedFile): string {
  if (applied.action === 'unchanged') return `  ${applied.name} — unchanged, not rewritten\n`;
  if (applied.action === 'skipped') {
    return `  skipped ${applied.name} — ${applied.detail ?? 'not written'}\n`;
  }
  return `  wrote ${applied.name}\n`;
}

const fileLabel = (file: { readonly exists: boolean; readonly unchanged: boolean }): string => {
  if (file.unchanged) return 'unchanged — nothing to write';
  return file.exists ? 'exists — will ask before overwriting' : 'new';
};

async function confirmAndInstall(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'done' | 'back'> {
  const plan = planInstall(io.cwd, choices);
  const root = scopeRoot(choices.scope ?? 'project', {
    cwd: io.cwd,
    home: choices.home ?? homedir(),
  });

  io.output(`\nAbout to write, into ${root}:\n`);
  listPlannedFiles(io.output, plan.files, plan.skipped, fileLabel);
  for (const step of plan.manual) {
    io.output(
      `  ${step.name} is ${step.harness}'s own file — run this yourself:\n    ${step.command}\n`,
    );
  }
  io.output(`Nothing has been written yet.\n`);

  const confirmed = await confirmLoop(
    ask,
    'yes to write, no to leave everything untouched, back to change a setting.',
  );
  if (confirmed === 'back') return 'back';
  if (confirmed === 'no') {
    io.output(`Nothing was written.\n`);
    return 'done';
  }

  const applied = await applyPlanFiles(plan.files, { kind: 'wizard', ask });
  for (const one of applied) io.output(sayApplied(one));

  for (const note of plan.notes) io.output(`note: ${note}\n`);
  const lava = palette({ unicode: io.unicode !== false });
  io.output(
    doneBlock(
      {
        ok: true,
        what: `${CLI_NAME} hooks install`,
        summary: countedFiles(
          [...applied.map((one) => one.action), ...plan.skipped.map(() => 'skipped' as const)],
          lava,
        ),
        note:
          `Re-run \`${CLI_NAME} hooks install\` to edit toggles; ` +
          `\`${CLI_NAME} hooks remove\` takes it all back out.`,
        next: installedNext(lava),
      },
      lava,
    ),
  );
  return 'done';
}

async function removeFlow(
  io: HooksIo,
  ask: Asker,
  harnessFlag: string | undefined,
): Promise<number> {
  const harnesses = harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...HARNESSES];
  const home = io.home ?? homedir();
  const scope = resolveScope(io.scope, { cwd: io.cwd, home });
  const root = scopeRoot(scope, { cwd: io.cwd, home });
  const removals = planRemove(io.cwd, harnesses, { scope, home });

  if (removals.length === 0) {
    io.output(`${CLI_NAME} hooks remove: nothing of smelt's found to remove in ${root}.\n`);
    return 0;
  }

  io.output(
    `${CLI_NAME} hooks remove — takes smelt's hook wiring back out.\n\nPlanned:\n` +
      removals
        .map(
          (removal) =>
            `  ${removal.name.padEnd(32)} (${
              removal.action === 'delete' ? 'delete' : 'remove smelt entries, keep the rest'
            })\n`,
        )
        .join('') +
      `${CONFIG_FILE_NAME} is left untouched — its hooks block is your config now; ` +
      `edit or remove it there.\nNothing has been changed yet.\n`,
  );

  // --yes is the consent: the plan above was printed, and taking smelt's own wiring
  // back out loses nothing that was not smelt's — every removal is a strip of our own
  // entries or a file that is entirely ours.
  if (
    io.yes !== true &&
    (await confirmYesNo(ask, 'yes to proceed, no to leave everything untouched.')) === 'no'
  ) {
    io.output(`Nothing was changed.\n`);
    return 0;
  }

  let removed = 0;
  let spared = 0;
  for (const removal of removals) {
    const verb = removal.action === 'delete' ? 'delete' : 'modify';
    if (io.yes !== true && (await ask(`  ${removal.name} — ${verb} it? (yes/no)> `)) !== 'yes') {
      io.output(`  skipped ${removal.name} — not touched\n`);
      spared += 1;
      continue;
    }
    if (removal.action === 'delete') {
      unlinkSync(removal.path);
      io.output(`  deleted ${removal.name}\n`);
    } else {
      writeFileSync(removal.path, removal.content ?? '');
      io.output(`  cleaned ${removal.name}\n`);
    }
    removed += 1;
  }
  const lava = palette({ unicode: io.unicode !== false });
  io.output(
    doneBlock(
      {
        ok: true,
        what: `${CLI_NAME} hooks remove`,
        // Counted off what this loop actually did, not off what `planRemove` found: a
        // wizard run may decline any of them, one file at a time. Its own vocabulary,
        // too — `countedFiles` speaks about writing, and this verb does the opposite.
        summary:
          `took ${String(removed)} ${removed === 1 ? 'file' : 'files'} back out` +
          (spared === 0 ? '' : `, left ${String(spared)} alone`),
        next: [
          [`${CLI_NAME} doctor`, 'read back what is left, and what is behind'],
          [`${CLI_NAME} hooks install`, 'put the guard preset back'],
        ],
      },
      lava,
    ),
  );
  return 0;
}
