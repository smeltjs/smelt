import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { applyPlan, markerPricing, reconstruct } from '../src/apply.ts';
import { ContentKindError } from '../src/errors.ts';
import { DIFF_PLANNER_ID, DiffPlanner, planDiff } from '../src/plan/diff.ts';
import { MemoryElisionStore } from '../src/store.ts';
import type { PlanInput } from '../src/types.ts';

const REAL_DIFF = readFileSync(new URL('../bench/corpus/bench-argv.diff', import.meta.url), 'utf8');

function inputFor(text: string, focus: readonly string[], budgetBytes = 1200): PlanInput {
  return { text, language: 'unknown', budgetBytes, focus, pricing: markerPricing('unknown') };
}

describe('the diff planner cuts files and hunks, not lines', () => {
  it('collapses whole files the focus never touches, naming them', () => {
    // `BenchLib` is only in the test file's hunk; lib.mjs and run.mjs never mention it.
    const plan = planDiff(inputFor(REAL_DIFF, ['BenchLib']));
    expect(plan.planner).toBe(DIFF_PLANNER_ID);
    const result = applyPlan(REAL_DIFF, plan, new MemoryElisionStore());
    expect(result.text).toContain('interface BenchLib');
    expect(result.text).toContain('diff --git a/packages/core/test/bench.test.ts');
    expect(result.text).not.toContain('export function parseBenchArgs(argv)');
    const fileCollapses = plan.elisions.filter((e) => e.reason.rule === 'file-collapse');
    expect(fileCollapses).toHaveLength(1);
    expect(fileCollapses[0]!.names).toEqual([
      'packages/core/bench/lib.mjs',
      'packages/core/bench/run.mjs',
    ]);
    expect(fileCollapses[0]!.reason.explanation).toBe('collapsed 2 files (3 hunks)');
  });

  it('keeps a matched file’s header and collapses the hunks inside it that do not match', () => {
    const twoHunks =
      'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n' +
      `@@ -1,3 +1,3 @@\n-alpha one\n+alpha two\n context\n${' filler line\n'.repeat(12)}` +
      `@@ -40,3 +40,3 @@\n-beta one\n+beta two\n context\n${' filler line\n'.repeat(12)}`;
    const plan = planDiff(inputFor(twoHunks, ['beta']));
    const result = applyPlan(twoHunks, plan, new MemoryElisionStore());
    expect(result.text).toContain('+++ b/x.txt');
    expect(result.text).toContain('+beta two');
    expect(result.text).not.toContain('+alpha two');
    const hunkCollapses = plan.elisions.filter((e) => e.reason.rule === 'hunk-collapse');
    expect(hunkCollapses).toHaveLength(1);
    expect(hunkCollapses[0]!.reason.explanation).toBe('collapsed 1 hunk of x.txt');
    expect(hunkCollapses[0]!.names).toEqual(['@@ -1,3 +1,3 @@']);
    // The matched hunk keeps its header and the match; its filler collapses as a window.
    expect(plan.elisions.filter((e) => e.reason.rule === 'hunk-window')).toHaveLength(1);
    expect(result.text).toContain('@@ -40,3 +40,3 @@');
  });

  it('inside a matched hunk, lines far from any match collapse as a window — header kept', () => {
    const oneHunk =
      'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n' +
      `@@ -1,40 +1,40 @@\n${' filler line\n'.repeat(14)}-beta one\n+beta two\n context\n${' filler line\n'.repeat(14)}`;
    const plan = planDiff(inputFor(oneHunk, ['beta'], 600));
    const result = applyPlan(oneHunk, plan, new MemoryElisionStore());
    expect(result.text).toContain('@@ -1,40 +1,40 @@');
    expect(result.text).toContain('+beta two');
    expect(plan.elisions.length).toBe(2);
    for (const elision of plan.elisions) {
      expect(elision.reason.rule).toBe('hunk-window');
      expect(elision.reason.explanation).toMatch(/^collapsed \d+ lines of a hunk of x\.txt$/);
    }
    expect(result.outputBytes).toBeLessThan(600);
  });

  it('never leaves a real diff uncut when every hunk matches — the window rule takes over', () => {
    // Every file and every hunk of this diff mentions parseBenchArgs; before the window
    // rule the planner kept all 4132 bytes and cut nothing, which lexical beat.
    const plan = planDiff(inputFor(REAL_DIFF, ['parseBenchArgs']));
    const result = applyPlan(REAL_DIFF, plan, new MemoryElisionStore());
    expect(plan.elisions.length).toBeGreaterThan(0);
    expect(plan.elisions.every((e) => e.reason.rule === 'hunk-window')).toBe(true);
    // At least a third of the bytes go; what stays is the diff's structure — every file
    // header and every hunk header — around the matches. The lexical planner cuts
    // further on the same bytes (1516 B at the same budget on the bench) by cutting
    // across those headers, which is the trade this planner makes on purpose.
    expect(result.outputBytes).toBeLessThan(REAL_DIFF.length * 0.7);
    for (const line of REAL_DIFF.split('\n').filter((l) => /^(diff --git|@@ )/.test(l))) {
      expect(result.text).toContain(line);
    }
    expect(result.text).toContain('export function parseBenchArgs(argv)');
  });

  it('with no focus keeps every file header and collapses each file’s hunks to one marker', () => {
    const plan = planDiff(inputFor(REAL_DIFF, []));
    const result = applyPlan(REAL_DIFF, plan, new MemoryElisionStore());
    for (const line of REAL_DIFF.split('\n').filter((l) => l.startsWith('diff --git'))) {
      expect(result.text).toContain(line);
    }
    expect(result.text).not.toContain('export function parseBenchArgs(argv)');
    expect(plan.elisions.every((e) => e.reason.rule === 'hunk-collapse')).toBe(true);
  });

  it('is reversible byte for byte', () => {
    const store = new MemoryElisionStore();
    const result = applyPlan(REAL_DIFF, planDiff(inputFor(REAL_DIFF, ['parseBenchArgs'])), store);
    expect(reconstruct(result, store)).toBe(REAL_DIFF);
  });

  it('refuses text that is not a diff rather than approximating', () => {
    expect(() => planDiff(inputFor('just some text\nmore text\n', ['x']))).toThrow(
      ContentKindError,
    );
    expect(() => planDiff(inputFor('--- a heading\n', ['x']))).toThrow(/diff/);
    expect(new DiffPlanner().id).toBe(DIFF_PLANNER_ID);
  });
});
