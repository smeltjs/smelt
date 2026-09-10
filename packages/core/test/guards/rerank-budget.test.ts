import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { markerPricing } from '@guard/apply';
import { predictOutputBytes } from '@guard/plan/budget';
import { planLexical } from '@guard/plan/lexical';
import { applyRerank } from '@guard/rerank/protect';
import { createSmelter } from '@guard/smelter';
import type { ElisionPlan, RerankCandidate, RerankStage } from '@guard/types';

import type { GuardMutation } from './_mutations.ts';

/**
 * THE RERANK BUDGET GUARD — a stage's opinion does not outrank the caller's ceiling.
 *
 * The rerank slot is the one place in the pipeline where something outside this
 * repository gets to decide how much of a caller's context survives. It may only
 * *spare*, never cut, which bounds the damage in direction but not in size: before the
 * budget rung, a stage that asked for every region got every region, and a `topK` the
 * user wrote in a config file — or a hosted ranker having a generous day — decided the
 * output size instead of the `--budget` they typed.
 *
 * Two properties keep that honest, and both are here because both fail *quietly*:
 *
 *  1. **A plan that fitted still fits.** The slot walks the stage's ranking best-first
 *     and spares while the predicted output holds, stopping at the first region that
 *     would not. A slot that skipped the check would produce a larger, better-looking
 *     output and a green exit — the failure is a number nobody reads until their
 *     context window overflows somewhere else.
 *  2. **The reason it stopped is the measured one.** `kept` below `returned` is only
 *     readable beside the reason for the gap, and a `stopped` that always said `cap`
 *     would blame the user's own `topK` for a refusal smelt made. That is a Law 2
 *     failure with a plausible cover story, which is the kind that survives review.
 *
 *  3. **A run that can spare nothing asks nobody.** When the planner's own plan is
 *     already over budget, every spare is refused in advance — so the stage is not
 *     called at all. This is the one cost of a rerank that is not measured in bytes: the
 *     call itself sends the caller's source to a third party, and doing that for an
 *     answer that cannot be used is a Law 1-shaped failure a byte count never shows.
 *
 * The mutations at the bottom are exactly those three breaks.
 */

const TEXT = Array.from({ length: 60 }, (_unused, i) => `line ${String(i)} filler filler`).join(
  '\n',
);
const FOCUS = ['line 30'];
const PRICING = markerPricing('unknown');
const INPUT_BYTES = Buffer.byteLength(TEXT, 'utf8');

function plan(budgetBytes: number): ElisionPlan {
  return planLexical({
    text: TEXT,
    language: 'unknown',
    budgetBytes,
    focus: FOCUS,
    pricing: PRICING,
  });
}

/** A stage that asks for every region it is offered — the worst honest answer. */
const KEEPS_EVERYTHING: RerankStage = {
  id: 'keeps-all',
  rerank: (candidates: readonly RerankCandidate[]) =>
    Promise.resolve(candidates.map((candidate, i) => ({ ...candidate, score: 1 - i / 1000 }))),
};

describe('a stage cannot spend past the budget the caller typed', () => {
  it('leaves a plan that fitted still fitting, over every budget that fits one', async () => {
    // Every budget from "the planner's own output, exactly" upwards. At the bottom of
    // the range nothing can be spared at all; at the top everything can; in between the
    // walk stops partway. All three must land inside the ceiling.
    for (let budgetBytes = 400; budgetBytes <= 1400; budgetBytes += 25) {
      const plain = await createSmelter({ strategy: 'lexical' }).smelt(TEXT, {
        budgetBytes,
        focus: FOCUS,
      });
      if (plain.outputBytes > budgetBytes) continue;
      const reranked = await createSmelter({
        strategy: 'lexical',
        rerank: KEEPS_EVERYTHING,
      }).smelt(TEXT, { budgetBytes, focus: FOCUS });
      expect(reranked.outputBytes, `budget ${String(budgetBytes)}`).toBeLessThanOrEqual(
        budgetBytes,
      );
      // Not vacuous by being a no-op: the slot really did run and really was asked for
      // everything, so a green line here is the rung working rather than absent.
      expect(reranked.rerank?.returned, `budget ${String(budgetBytes)}`).toBe(
        plain.elisions.length,
      );
    }
  });

  it('does not call the stage at all when the plan itself is already over budget', async () => {
    // The check must be taken BEFORE the call, not inside the walk. Inside, the walk
    // would still spare nothing and the byte counts would look identical — and the
    // caller's source would have left the machine to produce that identical number.
    const proposed = plan(300);
    const predicted = predictOutputBytes(INPUT_BYTES, proposed.elisions, PRICING);
    let called = false;
    const watched: RerankStage = {
      id: 'watched',
      rerank: (candidates: readonly RerankCandidate[]) => {
        called = true;
        return Promise.resolve(candidates.map((candidate) => ({ ...candidate, score: 1 })));
      },
    };
    const outcome = await applyRerank({
      stage: watched,
      plan: proposed,
      text: TEXT,
      query: 'line 30',
      budgetBytes: predicted - 1,
      pricing: PRICING,
    });
    expect(called).toBe(false);
    expect(outcome.plan).toBe(proposed);
    // A skip, not a stop: nothing only a run can measure is reported beside it.
    expect(outcome.attribution.skipped).toBe('plan-over-budget');
    expect(outcome.attribution.returned).toBeUndefined();
    expect(outcome.attribution.sparedBytes).toBeUndefined();
    expect(outcome.attribution.stopped).toBeUndefined();
  });

  it('spares nothing at all when the best region alone breaks the budget', async () => {
    const proposed = plan(300);
    const predicted = predictOutputBytes(INPUT_BYTES, proposed.elisions, PRICING);
    const outcome = await applyRerank({
      stage: KEEPS_EVERYTHING,
      plan: proposed,
      text: TEXT,
      query: 'line 30',
      // Exactly the plan's own size: there is no headroom at all, so the first spare
      // breaks it and the walk must give up rather than take one anyway.
      budgetBytes: predicted,
      pricing: PRICING,
    });
    expect(outcome.attribution.kept).toBe(0);
    expect(outcome.attribution.sparedBytes).toBe(0);
    expect(outcome.plan.elisions).toEqual(proposed.elisions);
  });
});

describe('the report of what happened is the measurement, not a story', () => {
  it('says `budget` when the budget stopped the walk, never the stage’s own cut-off', async () => {
    const proposed = plan(300);
    const predicted = predictOutputBytes(INPUT_BYTES, proposed.elisions, PRICING);
    const outcome = await applyRerank({
      stage: KEEPS_EVERYTHING,
      plan: proposed,
      text: TEXT,
      query: 'line 30',
      budgetBytes: predicted,
      pricing: PRICING,
    });
    // The stage asked for all of them and got none: the only truthful reason is the
    // budget. `cap` here would blame the caller's own configuration for smelt's ruling.
    expect(outcome.attribution.returned).toBe(proposed.elisions.length);
    expect(outcome.attribution.stopped).toBe('budget');
  });

  it('says `exhausted` only when every offered region really was spared', async () => {
    const proposed = plan(300);
    const outcome = await applyRerank({
      stage: KEEPS_EVERYTHING,
      plan: proposed,
      text: TEXT,
      query: 'line 30',
      budgetBytes: INPUT_BYTES,
      pricing: PRICING,
    });
    expect(outcome.attribution.kept).toBe(proposed.elisions.length);
    expect(outcome.attribution.stopped).toBe('exhausted');
  });

  it('never reports keeping more than the stage asked for', async () => {
    const first: RerankStage = {
      id: 'one',
      rerank: (candidates: readonly RerankCandidate[]) =>
        Promise.resolve([{ ...candidates[0]!, score: 1 }]),
    };
    const outcome = await applyRerank({
      stage: first,
      plan: plan(300),
      text: TEXT,
      query: 'line 30',
      budgetBytes: INPUT_BYTES,
      pricing: PRICING,
    });
    expect(outcome.attribution.kept).toBeLessThanOrEqual(outcome.attribution.returned!);
    expect(outcome.attribution.stopped).toBe('cap');
  });

  it('counts sparedBytes as exactly the distance the output moved', async () => {
    const proposed = plan(300);
    const outcome = await applyRerank({
      stage: KEEPS_EVERYTHING,
      plan: proposed,
      text: TEXT,
      query: 'line 30',
      budgetBytes: INPUT_BYTES,
      pricing: PRICING,
    });
    expect(outcome.attribution.sparedBytes).toBe(
      predictOutputBytes(INPUT_BYTES, outcome.plan.elisions, PRICING) -
        predictOutputBytes(INPUT_BYTES, proposed.elisions, PRICING),
    );
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'rerank-slot-ignores-the-budget',
    file: 'rerank/protect.ts',
    find:
      '    if (predicted + back > budgetBytes) {\n' +
      "      return { spared, sparedBytes, stopped: 'budget' };\n" +
      '    }\n',
    replace: '',
    why: 'the slot spares every region a stage asks for and never looks at the ceiling the caller typed — the output grows past --budget, the exit stays 0, and a topK written in a config file has quietly become the thing that decides how much context survives',
  },
  {
    id: 'rerank-calls-the-stage-over-budget',
    file: 'rerank/protect.ts',
    find:
      '  if (predicted > budgetBytes) {\n' +
      '    return {\n' +
      '      plan,\n' +
      '      attribution: {\n' +
      '        ...identity,\n' +
      '        candidates: candidates.length,\n' +
      '        kept: 0,\n' +
      "        skipped: 'plan-over-budget',\n" +
      '      },\n' +
      '    };\n' +
      '  }\n',
    replace: '',
    why: "the stage is asked even when the plan cannot afford a single spare — the byte counts come back identical, so nothing in the receipt changes, and the only difference is that the caller's source was sent to a third party for an answer that was refused before it arrived",
  },
  {
    id: 'rerank-stop-reason-fabricated',
    file: 'rerank/protect.ts',
    find: "      return { spared, sparedBytes, stopped: 'budget' };",
    replace: "      return { spared, sparedBytes, stopped: 'cap' };",
    why: 'the budget is still honoured but the receipt blames the stage for it: every refused spare reads as "your topK ended the walk", so a reader raising their K to get more back would change nothing and have no way to find out why',
  },
];
