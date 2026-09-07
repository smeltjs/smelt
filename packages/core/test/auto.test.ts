import { describe, expect, it } from 'vitest';

import { markerPricing } from '../src/apply.ts';
import { GrammarUnavailableError } from '../src/errors.ts';
import { createSmelter } from '../src/index.ts';
import { AUTO_PLANNER_ID, AutoPlanner, planAuto } from '../src/plan/auto.ts';
import { DIFF_PLANNER_ID } from '../src/plan/diff.ts';
import { JSON_PLANNER_ID } from '../src/plan/json.ts';
import { LEXICAL_PLANNER_ID } from '../src/plan/lexical.ts';
import { PLANNERS, STRATEGIES } from '../src/plan/planners.ts';
import { STRUCTURAL_LANGUAGES, STRUCTURAL_PLANNER_ID } from '../src/plan/structural.ts';
import type { PlanInput } from '../src/types.ts';

import { FUNCTIONS_TS } from './structural-fixtures.ts';

/** A log file: text with no grammar anywhere, which is the point of the lexical leg. */
const BUILD_LOG = `${'compiling module\n'.repeat(40)}error: TypeError in handleRequest\n${'linking\n'.repeat(40)}`;

function inputFor(
  text: string,
  language: PlanInput['language'],
  focus: readonly string[],
): PlanInput {
  return { text, language, budgetBytes: 400, focus, pricing: markerPricing(language) };
}

describe('the auto strategy picks a planner and says which one ran', () => {
  it('is a member of the registry, like any other strategy', () => {
    expect(STRATEGIES).toContain('auto');
    expect(PLANNERS.auto({}).id).toBe(AUTO_PLANNER_ID);
  });

  it('runs structural on a language with a bundled grammar, and labels it structural', async () => {
    const plan = await planAuto(inputFor(FUNCTIONS_TS, 'typescript', ['handleRequest']));
    expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(plan.elisions.length).toBeGreaterThan(0);
    expect(plan.elisions[0]!.reason.rule).toBe('sibling-collapse');
  });

  it('runs lexical on a language without one, and labels it lexical', async () => {
    const plan = await planAuto(inputFor(BUILD_LOG, 'unknown', ['TypeError']));
    expect(plan.planner).toBe(LEXICAL_PLANNER_ID);
    expect(plan.elisions.length).toBeGreaterThan(0);
    expect(plan.elisions[0]!.reason.rule).toBe('focus-window');
  });

  it('routes by content kind before language: a diff and a JSON blob reach their planners', async () => {
    const diff =
      'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n' +
      `@@ -1,3 +1,3 @@\n-a\n+b\n${' filler\n'.repeat(30)}@@ -50,3 +50,3 @@\n-c\n+TypeError\n${' filler\n'.repeat(30)}`;
    const diffPlan = await planAuto(inputFor(diff, 'unknown', ['TypeError']));
    expect(diffPlan.planner).toBe(DIFF_PLANNER_ID);
    expect(diffPlan.elisions.length).toBeGreaterThan(0);

    const json = JSON.stringify(
      { a: 'x'.repeat(200), b: 'y'.repeat(200), c: { TypeError: 'here' } },
      null,
      2,
    );
    const jsonPlan = await planAuto(inputFor(json, 'unknown', ['TypeError']));
    expect(jsonPlan.planner).toBe(JSON_PLANNER_ID);
    expect(jsonPlan.elisions.length).toBeGreaterThan(0);
  });

  it('covers every structural language: each one routes to the structural planner', async () => {
    for (const language of STRUCTURAL_LANGUAGES) {
      const plan = await planAuto(inputFor(FUNCTIONS_TS, language, ['handleRequest']));
      expect(plan.planner, language).toBe(STRUCTURAL_PLANNER_ID);
    }
  });

  it('is deterministic on both legs: same input, byte-identical plan', async () => {
    for (const [text, language, focus] of [
      [FUNCTIONS_TS, 'typescript', ['handleRequest']],
      [BUILD_LOG, 'unknown', ['TypeError']],
    ] as const) {
      const first = await planAuto(inputFor(text, language, focus));
      const second = await planAuto(inputFor(text, language, focus));
      const third = await new AutoPlanner().plan(inputFor(text, language, focus));
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    }
  });

  it('passes each planner its own option bag', async () => {
    // minSiblings is a structural-only knob: set it past the fixture's run lengths and
    // the structural leg must come back with nothing, which proves auto handed the bag
    // over rather than constructing a default planner.
    const plan = await planAuto(inputFor(FUNCTIONS_TS, 'typescript', ['handleRequest']), {
      structural: { minSiblings: 99 },
    });
    expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(plan.elisions).toEqual([]);
  });

  it('smelts end to end through createSmelter, and the result round-trips', async () => {
    const smelter = createSmelter({ strategy: 'auto' });
    const structural = await smelter.smelt(FUNCTIONS_TS, {
      path: 'handlers.ts',
      budgetBytes: 400,
      focus: ['handleRequest'],
    });
    expect(structural.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(smelter.reconstruct(structural)).toBe(FUNCTIONS_TS);

    const lexical = await smelter.smelt(BUILD_LOG, {
      path: 'build.log',
      budgetBytes: 400,
      focus: ['TypeError'],
    });
    expect(lexical.planner).toBe(LEXICAL_PLANNER_ID);
    expect(smelter.reconstruct(lexical)).toBe(BUILD_LOG);
  });

  it('does not soften the explicit structural refusal', async () => {
    // The whole point of auto being opt-in: naming `structural` still means "these
    // guarantees or an error", on exactly the languages it always did.
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(
      smelter.smelt(BUILD_LOG, { path: 'build.log', budgetBytes: 400, focus: ['TypeError'] }),
    ).rejects.toThrow(GrammarUnavailableError);
  });
});
