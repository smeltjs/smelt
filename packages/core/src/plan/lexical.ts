import type { ElisionPlan, MarkerPricing, PlanInput, PlannedElision, Planner } from '../types.ts';
import { focusMatcher } from './focus.ts';
import type { FocusMatcher, FocusOptions } from './focus.ts';

import { chooseUnderBudget, markerBytes, requirePricing } from './budget.ts';

export const LEXICAL_PLANNER_ID = 'lexical/v1';

/** How hard the head/tail strategy squeezes, in order, when the budget is not met. */
const HEAD_TAIL_LADDER: readonly number[] = [1, 0.5, 0.25, 0.1, 0.05];

export interface LexicalPlannerOptions extends FocusOptions {
  /** Lines of context kept either side of a focus match. Shrinks under budget pressure. */
  readonly contextLines?: number;
  /** Never collapse a run shorter than this, however tempting. */
  readonly minRunLines?: number;
  /** With no focus terms: lines kept at the top. */
  readonly headLines?: number;
  /** With no focus terms: lines kept at the bottom. */
  readonly tailLines?: number;
}

interface Line {
  /** Byte offset of the first byte of the line. */
  readonly start: number;
  /** Byte offset one past the last byte of the line, *excluding* its newline. */
  readonly end: number;
  readonly text: string;
}

/**
 * The fallback planner, and the reference implementation of the whole pipeline.
 *
 * It knows nothing about syntax: it keeps the lines you were looking for plus a window
 * of context, and collapses the runs in between. That is a weak strategy on code and a
 * perfectly good one on log files, stack traces, JSON dumps and every other thing a
 * coding agent shovels into a prompt — which is why it is the fallback rather than an
 * embarrassment. It also runs on languages smelt has no grammar for, so
 * `language: 'unknown'` is never a dead end.
 *
 * Everything here is deterministic and rule-named. Same input, same plan, and every
 * elision can say which rule produced it.
 */
export class LexicalPlanner implements Planner {
  readonly id = LEXICAL_PLANNER_ID;
  readonly #options: LexicalPlannerOptions;

  constructor(options: LexicalPlannerOptions = {}) {
    this.#options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return Promise.resolve(planLexical(input, this.#options));
  }
}

/**
 * The synchronous core, exported because it is worth testing and reusing directly.
 *
 * `budgetBytes` is a target, not a guarantee. If the smallest context window still
 * exceeds it, the plan comes back over budget rather than eliding the matches the
 * caller asked to keep — an optimizer that silently drops the thing you searched for is
 * the exact failure this design is built to prevent. Callers who need a hard ceiling
 * check `outputBytes` and decide; smelt will not decide for them.
 *
 * Profitability and budget prediction are **measured, not estimated**: every candidate
 * elision is priced through the input's {@link MarkerPricing} — the seam `apply.ts`
 * builds from the exact builder `applyPlan` will use, comment leader and custom
 * builder included. A guessed constant here once under-counted real ~105-byte markers
 * as 64, so a plan could be "chosen as fitting" and then come back over budget after
 * the markers landed.
 */
export function planLexical(input: PlanInput, options: LexicalPlannerOptions = {}): ElisionPlan {
  const pricing = requirePricing(input, LEXICAL_PLANNER_ID);
  const lines = splitLines(input.text);
  const focus = focusMatcher(input.focus, options);
  const minRunLines = options.minRunLines ?? 3;

  const attempts: readonly (readonly PlannedElision[])[] = !focus.empty
    ? ladder(options.contextLines ?? 4).map((context) =>
        collapse(lines, keepByFocus(lines, focus, context), {
          minRunLines,
          rule: 'focus-window',
          pricing,
        }),
      )
    : HEAD_TAIL_LADDER.map((shrink) =>
        collapse(
          lines,
          keepByHeadTail(
            lines,
            Math.max(3, Math.round((options.headLines ?? 40) * shrink)),
            Math.max(3, Math.round((options.tailLines ?? 20) * shrink)),
          ),
          { minRunLines, rule: 'head-tail', pricing },
        ),
      );

  const inputBytes = Buffer.byteLength(input.text, 'utf8');
  const chosen = chooseUnderBudget(inputBytes, attempts, input.budgetBytes, pricing);

  return {
    planner: LEXICAL_PLANNER_ID,
    language: input.language,
    elisions: chosen,
  };
}

/** Context-window sizes to try, largest first. */
function ladder(start: number): readonly number[] {
  const sizes: number[] = [];
  for (let n = start; n >= 0; n -= 1) sizes.push(n);
  if (sizes.length === 0) sizes.push(0);
  return sizes;
}

function splitLines(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;
  let byte = 0;
  const raw = text.split('\n');
  for (let i = 0; i < raw.length; i += 1) {
    const content = raw[i]!;
    const contentBytes = Buffer.byteLength(content, 'utf8');
    byte = start + contentBytes;
    lines.push({ start, end: byte, text: content });
    // +1 for the '\n' we split on; the final fragment has none.
    start = byte + 1;
  }
  return lines;
}

function keepByFocus(lines: readonly Line[], focus: FocusMatcher, contextLines: number): boolean[] {
  const keep: boolean[] = Array.from({ length: lines.length }, () => false);

  for (let i = 0; i < lines.length; i += 1) {
    if (!focus.matches(lines[i]!.text)) continue;
    const from = Math.max(0, i - contextLines);
    const to = Math.min(lines.length - 1, i + contextLines);
    for (let j = from; j <= to; j += 1) keep[j] = true;
  }
  return keep;
}

function keepByHeadTail(lines: readonly Line[], head: number, tail: number): boolean[] {
  const keep: boolean[] = Array.from({ length: lines.length }, () => false);
  for (let i = 0; i < Math.min(head, lines.length); i += 1) keep[i] = true;
  for (let i = Math.max(0, lines.length - tail); i < lines.length; i += 1) keep[i] = true;
  return keep;
}

function collapse(
  lines: readonly Line[],
  keep: readonly boolean[],
  config: { readonly minRunLines: number; readonly rule: string; readonly pricing: MarkerPricing },
): readonly PlannedElision[] {
  const elisions: PlannedElision[] = [];
  let runStart = -1;

  const flush = (endExclusive: number): void => {
    if (runStart < 0) return;
    const count = endExclusive - runStart;
    const range = { start: lines[runStart]!.start, end: lines[endExclusive - 1]!.end };
    runStart = -1;
    if (count < config.minRunLines) return;
    const candidate: PlannedElision = {
      range,
      reason: {
        rule: config.rule,
        explanation: `collapsed ${String(count)} ${count === 1 ? 'line' : 'lines'}${describe(
          config.rule,
        )}`,
      },
    };
    // Profitability, measured rather than estimated: a marker that costs at least as
    // many bytes as it removes grows the output — same rule, same seam, as the
    // structural planner.
    if (range.end - range.start <= markerBytes(candidate, config.pricing)) return;
    elisions.push(candidate);
  };

  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i] === true) {
      flush(i);
    } else if (runStart < 0) {
      runStart = i;
    }
  }
  flush(lines.length);
  return elisions;
}

function describe(rule: string): string {
  return rule === 'focus-window' ? ' with no match for the focus terms' : ' from the middle';
}
