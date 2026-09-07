import { describe, expect, it, vi } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { markerPricing } from '@guard/apply';
import { GrammarUnavailableError } from '@guard/errors';
import { AUTO_PLANNER_ID, planAuto } from '@guard/plan/auto';
import { DIFF_PLANNER_ID } from '@guard/plan/diff';
import { JSON_PLANNER_ID } from '@guard/plan/json';
import { LEXICAL_PLANNER_ID } from '@guard/plan/lexical';
import { PLANNERS } from '@guard/plan/planners';
import { STRUCTURAL_LANGUAGES, STRUCTURAL_PLANNER_ID } from '@guard/plan/structural';
import { createSmelter } from '@guard/smelter';
import type { PlanInput } from '@guard/types';

import { FUNCTIONS_RS, FUNCTIONS_TS } from '../structural-fixtures.ts';

import type { GuardMutation } from './_mutations.ts';

/**
 * AUTO-STRATEGY GUARD — the two things `auto` is not allowed to become.
 *
 * `auto` exists so a caller smelting a mixed stream does not have to name a planner
 * per call. The cost of that convenience is that the caller no longer knows which
 * planner ran, and there are exactly two ways to make that cost unpayable:
 *
 *  1. **A plan that does not say what ran.** Every plan `auto` returns must carry the
 *     id of the planner that produced it — `structural/v1` or `lexical/v1`. A plan
 *     labelled `auto/v1` would tell a reader the strategy and hide the mechanism, and
 *     `result.planner` is the only place the mechanism is ever stated.
 *  2. **A silent downgrade.** `auto` decides on a *fact* — whether the language has a
 *     bundled grammar — before it parses anything. It must never decide on an
 *     *accident*: a grammar that fails to load on a language smelt claims to support
 *     is a broken install, and answering it with line windows turns a loud
 *     environment fault into quietly worse output. That is Law 2's no-silent-downgrade
 *     reasoning arriving through a friendlier door, and it is the reason the third
 *     property below is here too: an explicit `strategy: 'structural'` must refuse an
 *     unsupported language exactly as it always has. `auto` is a different request.
 *
 * The mutations at the bottom are those two failures, written out.
 */

function inputFor(
  text: string,
  language: PlanInput['language'],
  focus: readonly string[],
): PlanInput {
  return { text, language, budgetBytes: 400, focus, pricing: markerPricing(language) };
}

describe('auto labels the planner that actually ran', () => {
  it('answers a structural language with a structural plan, never an auto one', async () => {
    const plan = await planAuto(inputFor(FUNCTIONS_TS, 'typescript', ['handleRequest']));
    expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(plan.planner).not.toBe(AUTO_PLANNER_ID);
    expect(plan.elisions.length, 'no elisions — the label check is vacuous').toBeGreaterThan(0);
  });

  it('answers everything else with a lexical plan, never an auto one', async () => {
    const plan = await planAuto(
      inputFor(`${'noise\n'.repeat(60)}TypeError here\n`, 'unknown', ['TypeError']),
    );
    expect(plan.planner).toBe(LEXICAL_PLANNER_ID);
    expect(plan.planner).not.toBe(AUTO_PLANNER_ID);
    expect(plan.elisions.length, 'no elisions — the label check is vacuous').toBeGreaterThan(0);
  });

  it('decides on the content kind first — a diff or JSON blob never reaches lexical', async () => {
    // A piped diff is path-less and detects `unknown`; before the kind probe it could
    // only ever reach the lexical planner, which sees lines and not hunks. The probe
    // is a fact (a parse, a header shape) and the plan says which planner ran.
    const diff =
      'diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n' +
      `@@ -1,3 +1,3 @@\n-a\n+b\n${' filler\n'.repeat(30)}@@ -50,3 +50,3 @@\n-c\n+TypeError\n${' filler\n'.repeat(30)}`;
    const diffPlan = await planAuto(inputFor(diff, 'unknown', ['TypeError']));
    expect(diffPlan.planner).toBe(DIFF_PLANNER_ID);
    expect(diffPlan.elisions.length, 'no elisions — the label check is vacuous').toBeGreaterThan(0);

    const json = JSON.stringify(
      { a: 'x'.repeat(200), b: 'y'.repeat(200), c: { TypeError: 1 } },
      null,
      2,
    );
    const jsonPlan = await planAuto(inputFor(json, 'unknown', ['TypeError']));
    expect(jsonPlan.planner).toBe(JSON_PLANNER_ID);
    expect(jsonPlan.elisions.length, 'no elisions — the label check is vacuous').toBeGreaterThan(0);
  });

  it('never lets its own id reach a plan, on any structural language', async () => {
    for (const language of STRUCTURAL_LANGUAGES) {
      const plan = await planAuto(inputFor(FUNCTIONS_TS, language, ['handleRequest']));
      expect(plan.planner, language).toBe(STRUCTURAL_PLANNER_ID);
    }
    // The id is real and belongs to the selector object, which is the only thing it
    // may ever name — so the assertions above are about a value that exists.
    expect(PLANNERS.auto({}).id).toBe(AUTO_PLANNER_ID);
  });

  it('reaches a caller: result.planner names the mechanism, not the strategy', async () => {
    const smelter = createSmelter({ strategy: 'auto' });
    const result = await smelter.smelt(FUNCTIONS_TS, {
      path: 'handlers.ts',
      budgetBytes: 400,
      focus: ['handleRequest'],
    });
    expect(result.planner).toBe(STRUCTURAL_PLANNER_ID);
  });
});

describe('auto is a selector, not a fallback', () => {
  it('lets a failed grammar load out, rather than answering with line windows', async () => {
    // The language IS one smelt claims to parse; the wasm will not load. `structural`
    // raises here, and so must `auto` — the alternative is a broken install producing
    // plausible lexical output nobody asked for and nobody can see. Two languages, so
    // the rule holds per grammar rather than for whichever one is checked first.
    vi.resetModules();
    vi.doMock('@guard/plan/grammar', () => ({
      loadGrammar: () =>
        Promise.reject(
          new GrammarUnavailableError('smelt: induced grammar-load failure, for this guard'),
        ),
    }));
    try {
      const fresh = (await import('@guard/plan/auto')) as typeof import('@guard/plan/auto');
      await expect(
        fresh.planAuto(inputFor(FUNCTIONS_TS, 'typescript', ['handleRequest'])),
      ).rejects.toThrow(GrammarUnavailableError);
      await expect(
        fresh.planAuto(inputFor(FUNCTIONS_RS, 'rust', ['resolve_target'])),
      ).rejects.toThrow(GrammarUnavailableError);
    } finally {
      vi.doUnmock('@guard/plan/grammar');
      vi.resetModules();
    }
  });

  it('leaves the explicit structural refusal exactly where it was', async () => {
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(
      smelter.smelt('just some prose, no language at all', { budgetBytes: 100 }),
    ).rejects.toThrow(GrammarUnavailableError);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'auto-ignores-the-content-kind',
    file: 'plan/auto.ts',
    find: '  const kind = probeKind(input.text);',
    replace: '  const kind = undefined;',
    why: 'the selector stops asking what the bytes are — a diff and a JSON blob fall back to line windows under a lexical label, the exact silent under-service the kind probe was measured to fix (bench rows git-diff and json-tool-result)',
  },
  {
    id: 'auto-silent-grammar-fallback',
    file: 'plan/auto.ts',
    find:
      '  return isStructuralLanguage(input.language)\n' +
      '    ? planStructural(input, options.structural ?? {})\n' +
      '    : Promise.resolve(planLexical(input, options.lexical ?? {}));',
    replace:
      '  if (!isStructuralLanguage(input.language)) {\n' +
      '    return Promise.resolve(planLexical(input, options.lexical ?? {}));\n' +
      '  }\n' +
      '  return planStructural(input, options.structural ?? {}).catch(() =>\n' +
      '    planLexical(input, options.lexical ?? {}),\n' +
      '  );',
    why: 'auto degraded from a selector into a fallback: a grammar that will not load answered with line windows instead of raising, so a broken install ships quietly worse context and the only symptom is a model that is wrong',
  },
  {
    id: 'auto-relabels-the-plan-it-delegated',
    file: 'plan/auto.ts',
    find: '    ? planStructural(input, options.structural ?? {})',
    replace:
      '    ? planStructural(input, options.structural ?? {}).then((plan) => ({\n' +
      '        ...plan,\n' +
      '        planner: AUTO_PLANNER_ID,\n' +
      '      }))',
    why: "the selector stamping its own name over the planner's — result.planner is the only place the mechanism is stated, and a caller reading `auto/v1` cannot tell whether their file was parsed or line-windowed",
  },
];
