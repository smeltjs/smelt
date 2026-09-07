import { describe, expect, it } from 'vitest';

import { applyPlan, markerPricing } from '../src/apply.ts';
import { formatReport } from '../src/cli/report.ts';
import { planStructural } from '../src/plan/structural.ts';
import { MemoryElisionStore } from '../src/store.ts';
import type { ElisionPlan } from '../src/types.ts';

import { FUNCTIONS_TS } from './structural-fixtures.ts';

/**
 * The outline is out-of-band by design: a planner may attach the names of what it
 * collapsed, `applyPlan` carries them onto the applied elision untouched, and the
 * report renders them beneath the row — while the marker, its byte cost and the
 * wire surface do not move by one byte. The marker-format guard pins the last half.
 */
describe('the elision outline travels from plan to report', () => {
  async function smelted(): Promise<ReturnType<typeof applyPlan>> {
    const plan = await planStructural({
      text: FUNCTIONS_TS,
      language: 'typescript',
      budgetBytes: 600,
      focus: ['handleRequest'],
      pricing: markerPricing('typescript'),
    });
    return applyPlan(FUNCTIONS_TS, plan, new MemoryElisionStore());
  }

  it('applyPlan carries the planner’s names onto the applied elision, verbatim', async () => {
    const result = await smelted();
    expect(result.elisions.map((elision) => elision.names)).toEqual([
      ['parseConfig', 'normalisePath'],
      ['renderResponse', 'logLine'],
    ]);
  });

  it('applyPlan adds no names key when the plan carried none', () => {
    const text = 'a\nb\nc\nd\ne\nf\ng\nh\n';
    const plan: ElisionPlan = {
      planner: 'test/v1',
      language: 'unknown',
      elisions: [{ range: { start: 0, end: 8 }, reason: { rule: 'r', explanation: 'e' } }],
    };
    const result = applyPlan(text, plan, new MemoryElisionStore());
    expect(Object.keys(result.elisions[0]!)).not.toContain('names');
  });

  it('the report prints the outline beneath the elision’s row', async () => {
    const result = await smelted();
    const report = formatReport({
      result,
      source: 'functions.ts',
      budgetBytes: 600,
      inputText: FUNCTIONS_TS,
    });
    const lines = report.split('\n');
    const rowIndex = lines.findIndex((line) => line.includes(result.elisions[0]!.hash));
    expect(rowIndex).toBeGreaterThan(0);
    expect(lines[rowIndex + 1]).toContain('parseConfig, normalisePath');
    const secondRow = lines.findIndex((line) => line.includes(result.elisions[1]!.hash));
    expect(lines[secondRow + 1]).toContain('renderResponse, logLine');
  });
});
