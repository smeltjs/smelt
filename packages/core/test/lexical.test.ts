import { describe, expect, it } from 'vitest';

import { applyPlan, markerForLanguage, markerPricing } from '../src/apply.ts';
import { LEXICAL_PLANNER_ID, planLexical } from '../src/plan/lexical.ts';
import { MemoryElisionStore } from '../src/store.ts';

const lines = (count: number, prefix = 'noise'): string =>
  Array.from({ length: count }, (_, i) => `${prefix} ${String(i)} ....................`).join('\n');

describe('the lexical planner', () => {
  it('keeps the focus match and a window of context around it', () => {
    const text = `${lines(80)}\nthe NEEDLE is here\n${lines(80, 'after')}`;
    const plan = planLexical({
      text,
      language: 'unknown',
      pricing: markerPricing('unknown'),
      budgetBytes: 600,
      focus: ['needle'],
    });

    expect(plan.planner).toBe(LEXICAL_PLANNER_ID);
    expect(plan.elisions.length).toBe(2);

    const kept = applied(text, plan.elisions);
    expect(kept).toContain('the NEEDLE is here');
    expect(kept).toContain('noise 79');
    expect(kept).toContain('after 0');
    expect(kept).not.toContain('noise 10');
  });

  it('falls back to head and tail when there is nothing to focus on', () => {
    const text = lines(400);
    const plan = planLexical({
      text,
      language: 'unknown',
      pricing: markerPricing('unknown'),
      budgetBytes: 2_000,
    });
    expect(plan.elisions.length).toBe(1);
    expect(plan.elisions[0]!.reason.rule).toBe('head-tail');
    expect(plan.elisions[0]!.reason.explanation).toMatch(/^collapsed \d+ lines from the middle$/);

    const kept = applied(text, plan.elisions);
    expect(kept).toContain('noise 0 ');
    expect(kept).toContain('noise 399');
  });

  it('squeezes harder when the budget is tight, and gives up honestly rather than cutting the match', () => {
    const text = `${lines(400)}\nthe NEEDLE is here\n${lines(400, 'after')}`;
    const generous = planLexical({
      text,
      language: 'unknown',
      pricing: markerPricing('unknown'),
      budgetBytes: 100_000,
      focus: ['needle'],
    });
    const tight = planLexical({
      text,
      language: 'unknown',
      pricing: markerPricing('unknown'),
      budgetBytes: 200,
      focus: ['needle'],
    });

    expect(removed(tight.elisions)).toBeGreaterThan(removed(generous.elisions));
    // 200 bytes is not achievable without dropping the match. It keeps the match.
    expect(applied(text, tight.elisions)).toContain('the NEEDLE is here');
  });

  it('leaves short runs alone — a marker costs more than the lines it replaces', () => {
    const text = ['keep NEEDLE', 'a', 'b', 'keep NEEDLE too'].join('\n');
    const plan = planLexical({
      text,
      language: 'unknown',
      pricing: markerPricing('unknown'),
      budgetBytes: 10,
      focus: ['needle'],
    });
    expect(plan.elisions).toEqual([]);
  });

  it('is deterministic', () => {
    const text = `${lines(200)}\nNEEDLE\n${lines(200, 'z')}`;
    const input = {
      text,
      language: 'unknown' as const,
      pricing: markerPricing('unknown'),
      budgetBytes: 900,
      focus: ['needle'],
    };
    expect(JSON.stringify(planLexical(input))).toBe(JSON.stringify(planLexical(input)));
  });

  it('handles an empty input without inventing an elision', () => {
    expect(
      planLexical({
        text: '',
        language: 'unknown',
        pricing: markerPricing('unknown'),
        budgetBytes: 10,
      }).elisions,
    ).toEqual([]);
  });

  it('ignores empty focus terms rather than matching everything', () => {
    const text = lines(300);
    const withEmpty = planLexical({
      text,
      language: 'unknown',
      pricing: markerPricing('unknown'),
      budgetBytes: 2_000,
      focus: ['', ''],
    });
    expect(withEmpty.elisions[0]!.reason.rule).toBe('head-tail');
  });

  it('measures marker cost from the real rendered marker, so no elision can grow the output', () => {
    // Real markers run ~103–108 bytes (leader included); the old fixed estimate said
    // 64. Every planned elision must remove strictly more bytes than the exact marker
    // it earns — in a language with a comment leader too, where the marker is widest.
    for (const language of ['unknown', 'python'] as const) {
      const build = markerForLanguage(language);
      const text = `${lines(40)}\nthe NEEDLE is here\n${lines(40, 'after')}`;
      const plan = planLexical({
        text,
        language,
        pricing: markerPricing(language),
        budgetBytes: 300,
        focus: ['needle'],
      });
      expect(plan.elisions.length).toBeGreaterThan(0);
      for (const elision of plan.elisions) {
        const cut = elision.range.end - elision.range.start;
        const marker = build({
          hash: '0123456789abcdef',
          bytes: cut,
          rule: elision.reason.rule,
          explanation: elision.reason.explanation,
        });
        expect(
          Buffer.byteLength(marker, 'utf8'),
          `a ${language} elision's marker costs as much as it removes`,
        ).toBeLessThan(cut);
      }
    }
  });

  it('predicts output bytes from real markers, so a chosen rung actually fits its budget', () => {
    // Derive the regression budget instead of hardcoding it: apply the widest-rung
    // plan, then re-plan with a budget one byte under that output. The old 64-byte
    // estimate under-counted every marker, judged the widest rung as fitting, and
    // returned a plan that came back OVER the budget once real markers landed. An
    // honest predictor steps down a rung and fits.
    const text = `${lines(120)}\nthe NEEDLE is here\n${lines(120, 'after')}`;
    const input = {
      text,
      language: 'unknown' as const,
      pricing: markerPricing('unknown'),
      focus: ['needle'],
    };

    const widest = planLexical({ ...input, budgetBytes: 1_000_000 });
    expect(widest.elisions.length).toBeGreaterThan(0);
    const widestOut = applyPlan(text, widest, new MemoryElisionStore()).outputBytes;

    const budgetBytes = widestOut - 1;
    const squeezed = planLexical({ ...input, budgetBytes });
    const squeezedOut = applyPlan(text, squeezed, new MemoryElisionStore()).outputBytes;
    expect(
      squeezedOut,
      'the planner chose a rung whose real output overruns the budget it claimed to fit',
    ).toBeLessThanOrEqual(budgetBytes);
    // And the squeeze still never cut the match itself.
    expect(applied(text, squeezed.elisions)).toContain('the NEEDLE is here');
  });
});

function applied(text: string, elisions: readonly { range: { start: number; end: number } }[]) {
  const buffer = Buffer.from(text, 'utf8');
  const pieces: Buffer[] = [];
  let cursor = 0;
  for (const { range } of elisions) {
    pieces.push(buffer.subarray(cursor, range.start));
    cursor = range.end;
  }
  pieces.push(buffer.subarray(cursor));
  return Buffer.concat(pieces).toString('utf8');
}

function removed(elisions: readonly { range: { start: number; end: number } }[]) {
  return elisions.reduce((sum, e) => sum + (e.range.end - e.range.start), 0);
}
