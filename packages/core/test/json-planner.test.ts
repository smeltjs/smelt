import { describe, expect, it } from 'vitest';

import { applyPlan, markerPricing, reconstruct } from '../src/apply.ts';
import { ContentKindError } from '../src/errors.ts';
import { JSON_PLANNER_ID, JsonPlanner, planJson } from '../src/plan/json.ts';
import { MemoryElisionStore } from '../src/store.ts';
import type { PlanInput } from '../src/types.ts';

/** A tier-4-log-shaped document: scalars, two big containers, one small one. */
const LOG = JSON.stringify(
  {
    format: 'smelt-bench-tier4-log/v2',
    case: 'java-classes',
    model: 'claude-opus-5',
    raw: {
      transcript: [
        { role: 'user', content: `Answer the question. ${'padding '.repeat(60)}` },
        { role: 'assistant', content: `The class does things. ${'more '.repeat(60)}` },
      ],
      usage: { input_tokens: 500, output_tokens: 40 },
    },
    smelted: {
      transcript: [
        { role: 'user', content: `Answer the question. ${'smelted '.repeat(60)}` },
        { role: 'assistant', content: `The class does things. ${'less '.repeat(60)}` },
      ],
      usage: { input_tokens: 200, output_tokens: 40 },
    },
    judge: { verdict: 'smelted', reasons: 'the second is complete' },
  },
  null,
  2,
);

function inputFor(text: string, focus: readonly string[], budgetBytes = 600): PlanInput {
  return { text, language: 'unknown', budgetBytes, focus, pricing: markerPricing('unknown') };
}

describe('the json planner cuts members, not lines', () => {
  it('keeps the member the focus names and collapses its unmatched siblings, named', () => {
    const plan = planJson(inputFor(LOG, ['verdict']));
    expect(plan.planner).toBe(JSON_PLANNER_ID);
    expect(plan.language).toBe('unknown');
    const result = applyPlan(LOG, plan, new MemoryElisionStore());
    expect(result.text).toContain('"verdict": "smelted"');
    expect(result.text).not.toContain('padding padding');
    // The outline names what each marker hid — the keys — in source order.
    expect(plan.elisions.map((e) => e.names)).toEqual([
      ['format', 'case', 'model', 'raw', 'smelted'],
    ]);
    expect(plan.elisions[0]!.reason.rule).toBe('member-collapse');
    expect(plan.elisions[0]!.reason.explanation).toBe('collapsed 5 sibling members');
    expect(result.outputBytes).toBeLessThan(inputFor(LOG, []).budgetBytes);
  });

  it('descends into a matched container and cuts inside it', () => {
    const plan = planJson(inputFor(LOG, ['smelted '], 1200));
    const result = applyPlan(LOG, plan, new MemoryElisionStore());
    // The smelted transcript's user turn matches; its assistant sibling does not.
    expect(result.text).toContain('smelted smelted');
    expect(result.text).not.toContain('less less less');
    expect(result.text).not.toContain('padding padding');
    const names = plan.elisions.flatMap((e) => e.names ?? []);
    expect(names).toContain('raw');
    expect(names).toContain('[1]');
  });

  it('with no focus keeps the root skeleton and collapses each container to one marker', () => {
    const plan = planJson(inputFor(LOG, []));
    const result = applyPlan(LOG, plan, new MemoryElisionStore());
    expect(result.text).toContain('"format": "smelt-bench-tier4-log/v2"');
    expect(result.text).toContain('"judge": {');
    expect(result.text).not.toContain('padding padding');
    const explanations = plan.elisions.map((e) => e.reason.explanation);
    expect(explanations).toContain('collapsed 2 sibling members');
    expect(plan.elisions.map((e) => e.names)).toContainEqual(['transcript', 'usage']);
  });

  it('never cuts a run whose marker would cost more than it removes', () => {
    const small = JSON.stringify({ a: 1, b: 2, c: 3, d: { e: 4 } }, null, 2);
    const plan = planJson(inputFor(small, ['zzz']));
    expect(plan.elisions).toEqual([]);
  });

  it('is reversible byte for byte', () => {
    const store = new MemoryElisionStore();
    const result = applyPlan(LOG, planJson(inputFor(LOG, ['verdict'])), store);
    expect(reconstruct(result, store)).toBe(LOG);
  });

  it('refuses text that is not JSON rather than approximating', () => {
    expect(() => planJson(inputFor('not json at all\n', ['x']))).toThrow(ContentKindError);
    expect(() => planJson(inputFor('{"a": 1,', ['x']))).toThrow(/json/);
    expect(new JsonPlanner().id).toBe(JSON_PLANNER_ID);
  });

  it('is deterministic: same input, byte-identical plan', () => {
    const a = planJson(inputFor(LOG, ['verdict']));
    const b = planJson(inputFor(LOG, ['verdict']));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
