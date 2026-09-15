import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { CliUsageError } from '../errors.ts';
import { answerReader } from './shell.ts';
import type { AnswerStream } from './shell.ts';

/**
 * The wizard kit — the stream machinery every interactive verb shares, extracted
 * once because its third copy was the one that raced: `setup` re-typed the ask
 * adapter without awaiting a step, and two prompts were on screen at once. A kit is
 * not an abstraction here; it is the deletion of two copies of a thing that had
 * already drifted (review II, KOT-255).
 *
 * What lives here, and nothing else:
 *
 *  - {@link wizardAsk}: the ask adapter — `answerReader`, the prompt echo, the trim,
 *    and the EOF refusal, whose message is each verb's own (init, hooks and setup
 *    owe the reader different last sentences).
 *  - {@link walkSteps}: the step machine with real back-navigation — the loop
 *    `hooks` always had, `init` mirrored, and `setup` faked with "lands on the last
 *    question". A step is `(ask) => 'ok' | 'back'`; back at the first step is
 *    answered, not ignored.
 *  - {@link confirmLoop} / {@link confirmYesNo}: the confirm prompts, retry copy
 *    included, because two verbs spelling "yes to…" differently is drift.
 *  - {@link listPlannedFiles} / {@link fileFate} / {@link writePlannedFile}: the plan
 *    listing (padded to its own longest name), the fate each listed file is given
 *    under the verb's consent policy, and the one file-write mechanic (mkdir, write,
 *    chmod) every apply loop performs.
 *  - {@link askOverwrite}: the per-file consent question — one wording, and only a
 *    literal `yes` satisfies it. Three copies used to exist — init's, agents split's
 *    and merge-policy's (which hooks and setup shared) — every one with a comment
 *    saying it had one home (review IV, REP-55). This is the home.
 *
 * Pure IO plumbing: no verb knowledge, no domain facts, no rendering opinions — the
 * lava adapter stays outside, at the verb boundary, where one switch styles them all.
 */

/** One question at a time, each answered by a line. What every wizard's `ask` is. */
export type Ask = (prompt: string) => Promise<string>;

/** One wizard step: `'ok'` advances, `'back'` returns to the previous step. */
export type Step = (ask: Ask) => Promise<'ok' | 'back'>;

/**
 * The ask adapter over an injected stream. `eofMessage` is the refusal's tail — the
 * one sentence that differs per verb, and the only one allowed to: setup's teaches
 * the non-interactive flags, hooks' says what happens to already-confirmed writes,
 * init's states the plain fact.
 */
export function wizardAsk(
  input: AnswerStream,
  output: (text: string) => void,
  eofMessage: string,
): { ask: Ask; release: () => Promise<void> } {
  const lines = answerReader(input);
  const ask: Ask = async (prompt) => {
    output(prompt);
    const next = await lines.next();
    if (next === undefined) throw new CliUsageError(eofMessage);
    return next.trim();
  };
  return { ask, release: () => lines.release() };
}

/** How {@link walkSteps} begins, and what `back` at the first step does. */
export interface WalkOptions {
  /** Where to start: a confirm's `back` lands on the last step, not the first. */
  readonly startAt?: number;
  /**
   * `back` at the first step. `'say'` (the default) answers it where the user can read
   * it — there is nothing before it, and pretending otherwise is how a wizard eats an
   * answer. `'exit'` returns `'exited'` instead, for a caller that has a question of
   * its own before the first step (init's directory question) to walk back into.
   */
  readonly firstBack?: 'say' | 'exit';
}

/**
 * The step machine: steps in order, `back` moving one step back. Returns `'done'` when
 * the last step advanced, `'exited'` when `back` walked off the front under
 * `firstBack: 'exit'`.
 */
export async function walkSteps(
  steps: readonly Step[],
  ask: Ask,
  say: (text: string) => void,
  options: WalkOptions = {},
): Promise<'done' | 'exited'> {
  let index = options.startAt ?? 0;
  while (index < steps.length) {
    const outcome = await steps[index]!(ask);
    if (outcome === 'back') {
      if (index > 0) index -= 1;
      else if (options.firstBack === 'exit') return 'exited';
      else say(`This is the first step — there is nothing before it.\n`);
    } else {
      index += 1;
    }
  }
  return 'done';
}

/**
 * `confirm (yes / no / back)> ` — the three-way confirm. `retryCopy` completes the
 * "yes to …, no to …, back to …" sentence, which is verb knowledge.
 */
export async function confirmLoop(
  ask: Ask,
  say: (text: string) => void,
  retryCopy: string,
): Promise<'yes' | 'no' | 'back'> {
  for (;;) {
    const answer = await ask(`confirm (yes / no / back)> `);
    if (answer === 'back') return 'back';
    if (answer === 'no') return 'no';
    if (answer === 'yes') return 'yes';
    // Said, never asked: an `ask` reads a line, and a retry printed through one
    // swallowed the very `yes` typed next — so `hooks` and `setup` needed it twice
    // (review IV, REP-55). The two verbs that re-typed this loop had it right; the fix
    // is here so all four do.
    say(`${retryCopy}\n`);
  }
}

/** `confirm (yes / no)> ` — the two-way confirm, for flows with no step to return to. */
export async function confirmYesNo(
  ask: Ask,
  say: (text: string) => void,
  retryCopy: string,
): Promise<'yes' | 'no'> {
  for (;;) {
    const answer = await ask(`confirm (yes / no)> `);
    if (answer === 'no') return 'no';
    if (answer === 'yes') return 'yes';
    say(`${retryCopy}\n`);
  }
}

/** One planned file, as the listing and the write mechanic both see it. */
export interface PlannedFileLike {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  readonly unchanged: boolean;
  readonly mode?: number;
}

/** One skipped file, with the reason the plan refused it. */
export interface PlannedSkipLike {
  readonly name: string;
  readonly why: string;
}

/**
 * The `  name (fate)` listing every confirm prints, the fates aligned on the longest
 * name in the plan. The width is the listing's own: four verbs used to pick four
 * (20, 32, 40, and one more 32), and none of them was a fact about the files.
 */
export function listPlannedFiles(
  say: (text: string) => void,
  files: readonly PlannedFileLike[],
  skipped: readonly PlannedSkipLike[],
  fate: (file: PlannedFileLike) => string,
  alignWith: readonly string[] = [],
): void {
  const width = plannedNameWidth([
    ...files.map((f) => f.name),
    ...skipped.map((s) => s.name),
    ...alignWith,
  ]);
  for (const file of files) {
    say(`  ${file.name.padEnd(width)} (${fate(file)})\n`);
  }
  for (const skip of skipped) {
    say(`  ${skip.name.padEnd(width)} (SKIPPED: ${skip.why})\n`);
  }
}

/**
 * The column the listing pads names to: the longest of them. Exported for the one
 * caller (`setup`) that prints a row of its own above the listing and must line up
 * with it — pass the same names to both.
 */
export function plannedNameWidth(names: readonly string[]): number {
  return Math.max(0, ...names.map((name) => name.length));
}

/**
 * What the listing says will happen to a file, under the verb's consent policy.
 * `'ask'` is the interactive verbs' rule — an existing file gets its own question.
 * `'skip'` is `setup`'s: it consents by policy (`merge-policy.ts`) and asks nothing
 * per file — an existing file smelt does not own is skipped, one it owns is repaired
 * or merged — so the honest listing label is that no question is coming. The one word
 * that differs is the reason this is a parameter and not a fourth copy.
 */
export function fileFate(
  file: { readonly exists: boolean; readonly unchanged: boolean },
  policy: 'ask' | 'skip',
): string {
  if (file.unchanged) return 'unchanged — nothing to write';
  if (!file.exists) return 'new';
  return policy === 'ask'
    ? 'exists — will ask before overwriting'
    : 'exists — will be skipped, not overwritten';
}

/**
 * The per-file consent question. The one hard rule every writing verb shares: an
 * existing file is never touched without an explicit per-file yes — not `y`, not
 * Enter, a literal `yes`. `test/guards/init-wizard.test.ts` and
 * `test/guards/agents-lint.test.ts` each break their verb's path to this question and
 * watch their guard go red; `test/wizard.test.ts` pins the literal.
 */
export async function askOverwrite(name: string, ask: Ask): Promise<boolean> {
  const answer = await ask(`  ${name} exists — overwrite it? (yes/no)> `);
  return answer === 'yes';
}

/** The one write mechanic: mkdir, write, chmod — in that order, everywhere. */
export function writePlannedFile(file: PlannedFileLike): void {
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content);
  if (file.mode !== undefined) chmodSync(file.path, file.mode);
}
