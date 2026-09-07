import { describe, expect, it } from 'vitest';

import { applyPlan, markerPricing } from '../src/apply.ts';
import { GrammarUnavailableError } from '../src/errors.ts';
import { createSmelter } from '../src/index.ts';
import {
  planStructural,
  STRUCTURAL_PLANNER_ID,
  StructuralPlanner,
} from '../src/plan/structural.ts';
import { MemoryElisionStore } from '../src/store.ts';
import type { MarkerPricing, PlanInput } from '../src/types.ts';

import {
  BOUNDARY_TS,
  BUDGET_RUNG_BUDGET,
  BUDGET_RUNG_CUT_BYTES,
  BUDGET_RUNG_MARKER_BYTES,
  BUDGET_RUNG_PY,
  FIXTURE_BY_LANGUAGE,
  FUNCTIONS_TS,
  LONG_DOC_TS,
} from './structural-fixtures.ts';

/**
 * One snapshot fixture per structural language — driven by the same registry the
 * totality guard checks, so a language cannot gain a planner entry without gaining a
 * snapshot here — plus the TypeScript special cases (a forty-line doc comment,
 * multi-byte boundaries, and the no-focus form).
 */
const FIXTURES: readonly {
  readonly name: string;
  readonly text: string;
  readonly language: PlanInput['language'];
  readonly focus: readonly string[];
}[] = [
  ...Object.entries(FIXTURE_BY_LANGUAGE).map(([language, fixture]) => ({
    name: fixture.name,
    text: fixture.text,
    language: language as PlanInput['language'],
    focus: fixture.focus,
  })),
  { name: 'long-doc.ts', text: LONG_DOC_TS, language: 'typescript', focus: ['retryWithBackoff'] },
  { name: 'boundary.ts', text: BOUNDARY_TS, language: 'typescript', focus: ['greetTarget'] },
  { name: 'functions.ts, no focus', text: FUNCTIONS_TS, language: 'typescript', focus: [] },
];

function inputFor(fixture: (typeof FIXTURES)[number]): PlanInput {
  return {
    text: fixture.text,
    language: fixture.language,
    budgetBytes: 600,
    focus: fixture.focus,
    pricing: markerPricing(fixture.language),
  };
}

const TS_FIXTURE = FIXTURES.find((fixture) => fixture.name === 'functions.ts')!;
const TSX_FIXTURE = FIXTURES.find((fixture) => fixture.name === 'mixed.tsx')!;

describe('the structural planner', () => {
  for (const fixture of FIXTURES) {
    it(`plans ${fixture.name} (snapshot)`, async () => {
      const plan = await planStructural(inputFor(fixture));
      expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
      expect(plan).toMatchSnapshot();
    });
  }

  it('names the kind and the count of what it collapsed, from the parse tree', async () => {
    const plan = await planStructural(inputFor(TS_FIXTURE));
    expect(plan.elisions.length).toBeGreaterThan(0);
    for (const elision of plan.elisions) {
      expect(elision.reason.rule).toBe('sibling-collapse');
      expect(elision.reason.explanation).toMatch(/^collapsed \d+ sibling functions?$/);
    }
  });

  it('names each kind in a mixed collapse', async () => {
    const plan = await planStructural(inputFor(TSX_FIXTURE));
    const explanations = plan.elisions.map((e) => e.reason.explanation);
    expect(
      explanations.some((text) => /^collapsed \d+ sibling declarations \(.+\)$/.test(text)),
      `expected a mixed-kind explanation among: ${explanations.join(' | ')}`,
    ).toBe(true);
  });

  it('keeps the focused declaration whole — signature, doc comment, body', async () => {
    const plan = await planStructural(inputFor(TS_FIXTURE));
    const result = applyPlan(TS_FIXTURE.text, plan, new MemoryElisionStore());
    expect(result.text).toContain('export function handleRequest(path: string, raw: string)');
    expect(result.text).toContain('/** The entry point every request goes through');
    expect(result.text).toContain('return renderResponse(normalisePath(path), config);');
  });

  it('is deterministic: same file, same focus, byte-identical plan', async () => {
    for (const fixture of FIXTURES) {
      const first = await planStructural(inputFor(fixture));
      const second = await planStructural(inputFor(fixture));
      const third = await new StructuralPlanner().plan(inputFor(fixture));
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(JSON.stringify(third)).toBe(JSON.stringify(first));
    }
  });

  it('refuses every language it has not mapped, naming the ones it has', async () => {
    const attempt = planStructural({ ...inputFor(TS_FIXTURE), language: 'unknown' });
    await expect(attempt).rejects.toThrow(GrammarUnavailableError);
    await expect(attempt).rejects.toThrow(
      /typescript, tsx, javascript, rust, python, go, java, c, cpp, c_sharp, ruby, php, kotlin, swift and bash/,
    );
  });

  it('smelts end to end through createSmelter, and the result round-trips', async () => {
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(FUNCTIONS_TS, {
      language: 'typescript',
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    expect(result.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(result.elisions.length).toBeGreaterThan(0);
    expect(smelter.reconstruct(result)).toBe(FUNCTIONS_TS);
  });
});

/** The review's case as a `PlanInput`, at whatever budget is being squeezed. */
const budgetInput = (budgetBytes: number): PlanInput => ({
  text: BUDGET_RUNG_PY,
  language: 'python',
  budgetBytes,
  focus: ['alpha_gate'],
  pricing: markerPricing('python'),
});

/**
 * THE BUDGET RUNG — `planStructural` reading `input.budgetBytes`, which for four
 * versions it did not.
 *
 * The review's case, reproduced byte for byte: 158 bytes in, a budget of 120, and a
 * first pass that comes back having elided nothing because the one maximal run it
 * found prices a 106-byte marker against a 105-byte cut. Three of that run's four
 * siblings are worth 92 bytes against an 82-byte marker, and nobody was offered them.
 */
describe('the elision outline — names ride beside the marker, never inside it', () => {
  it('lists the collapsed declarations by name, in source order', async () => {
    const plan = await planStructural(inputFor(TS_FIXTURE));
    const outlines = plan.elisions.map((elision) => elision.names);
    expect(outlines).toEqual([
      ['parseConfig', 'normalisePath'],
      ['renderResponse', 'logLine'],
    ]);
  });

  it('names only what the elided bytes actually hold, in every structural language', async () => {
    for (const fixture of FIXTURES) {
      const plan = await planStructural(inputFor(fixture));
      const bytes = Buffer.from(fixture.text, 'utf8');
      let named = 0;
      for (const elision of plan.elisions) {
        if (elision.names === undefined) continue;
        expect(
          elision.names.length,
          `${fixture.name}: an empty names list is an absent one`,
        ).toBeGreaterThan(0);
        named += 1;
        const slice = bytes.subarray(elision.range.start, elision.range.end).toString('utf8');
        for (const name of elision.names) {
          expect(
            slice,
            `${fixture.name}: "${name}" is not inside the bytes it claims to outline`,
          ).toContain(name);
        }
      }
      expect(named, `${fixture.name}: no elision carried an outline`).toBeGreaterThan(0);
    }
  });
});

describe("the structural planner's budget rung", () => {
  it("the fixture is the review's case: 158 bytes, over a budget of 120", () => {
    expect(Buffer.byteLength(BUDGET_RUNG_PY, 'utf8')).toBe(158);
    expect(BUDGET_RUNG_BUDGET).toBe(120);
  });

  it('finds the profitable cut the maximal run hid, at the reviewed prices', async () => {
    const plan = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    expect(plan.elisions).toHaveLength(1);
    const [elision] = plan.elisions;
    const cut = elision!.range.end - elision!.range.start;
    expect(cut).toBe(BUDGET_RUNG_CUT_BYTES);
    expect(markerPricing('python').costBytes(elision!.reason, cut)).toBe(BUDGET_RUNG_MARKER_BYTES);
    expect(elision!.reason.explanation).toBe('collapsed 3 sibling classes');
  });

  it('shrinks the output by exactly the saving it priced, and never grows it', async () => {
    const store = new MemoryElisionStore();
    const plan = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    const result = applyPlan(BUDGET_RUNG_PY, plan, store);
    expect(result.inputBytes).toBe(158);
    expect(result.outputBytes).toBe(158 - BUDGET_RUNG_CUT_BYTES + BUDGET_RUNG_MARKER_BYTES);
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
  });

  it('never cuts the focus-matched declaration, even under budget pressure', async () => {
    const plan = await planStructural(budgetInput(1));
    const result = applyPlan(BUDGET_RUNG_PY, plan, new MemoryElisionStore());
    expect(result.text).toContain('def alpha_gate(flag):');
    expect(result.text).toContain('return 1 if flag else -1');
  });

  it('leaves the plan alone when the first pass already fits', async () => {
    const plan = await planStructural(budgetInput(10_000));
    expect(plan.elisions).toEqual([]);
  });

  it('is deterministic: same file, same budget, byte-identical plan', async () => {
    const first = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    const second = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    const third = await new StructuralPlanner().plan(budgetInput(BUDGET_RUNG_BUDGET));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(third)).toBe(JSON.stringify(first));
  });

  it('stays reversible: the round trip closes byte for byte', async () => {
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(BUDGET_RUNG_PY, {
      language: 'python',
      budgetBytes: BUDGET_RUNG_BUDGET,
      focus: ['alpha_gate'],
    });
    expect(result.elisions).toHaveLength(1);
    expect(smelter.reconstruct(result)).toBe(BUDGET_RUNG_PY);
  });
});

/**
 * A generated bash script whose *only* maximal run is the whole file: `n` `echo`
 * commands, then a last line holding two top-level commands, the second of which the
 * focus matches. The run ends mid-line, so the first pass refuses it on the
 * line-comment rule rather than on price — and a run refused that way is as large as
 * the file, which is what makes it the budget rung's worst case.
 */
function wholeFileRefusedBash(lines: number): string {
  const echoes: string[] = [];
  for (let i = 0; i < lines; i += 1)
    echoes.push(`echo "line ${String(i)} of the generated script"`);
  return `${[...echoes, 'cleanup_tmp; deploy_release --now'].join('\n')}\n`;
}

/** A {@link MarkerPricing} that answers exactly as the real one and counts the asking. */
function countingPricing(): { readonly pricing: MarkerPricing; calls: () => number } {
  const real = markerPricing('bash');
  let calls = 0;
  return {
    pricing: {
      costBytes: (reason, elidedBytes) => {
        calls += 1;
        return real.costBytes(reason, elidedBytes);
      },
    },
    calls: () => calls,
  };
}

async function pricedCandidates(lines: number, budgetBytes: number): Promise<number> {
  const counter = countingPricing();
  await planStructural({
    text: wholeFileRefusedBash(lines),
    language: 'bash',
    budgetBytes,
    focus: ['deploy_release'],
    pricing: counter.pricing,
  });
  return counter.calls();
}

/**
 * THE BUDGET RUNG'S WORK IS BOUNDED — the property that keeps the rung off the CPU.
 *
 * A run refused on the mid-line rule can be the whole file, and the rung fires
 * precisely when the caller is over budget, which is the normal case. Sweeping every
 * `(from, to)` sub-run of such a run — slicing, explaining and pricing each — was
 * cubic: 19.5 KB in 373 ms, 159 KB in 131 s, on input a tool controls. So the count of
 * candidates the rung actually prices is pinned here, not the wall clock: it must not
 * grow with the file. Measured against the sweep this replaced, 202 units priced
 * 39,801 candidates.
 */
describe("the structural planner's budget rung, bounded", () => {
  it('prices a bounded number of candidates however large the refused run is', async () => {
    const small = await pricedCandidates(100, 200);
    const large = await pricedCandidates(800, 200);
    expect(large).toBe(small);
    expect(large).toBeLessThan(64);
  });

  it('stays bounded when no sub-run can reach the budget at all', async () => {
    const small = await pricedCandidates(100, 1);
    const large = await pricedCandidates(800, 1);
    expect(large).toBe(small);
    expect(large).toBeLessThan(64);
  });

  it('still finds the whole-file cut the mid-line refusal hid', async () => {
    const text = wholeFileRefusedBash(200);
    const plan = await planStructural({
      text,
      language: 'bash',
      budgetBytes: 200,
      focus: ['deploy_release'],
      pricing: markerPricing('bash'),
    });
    expect(plan.elisions).toHaveLength(1);
    expect(plan.elisions[0]!.reason.explanation).toBe('collapsed 200 sibling commands');
    const result = applyPlan(text, plan, new MemoryElisionStore());
    expect(result.text).toContain('cleanup_tmp; deploy_release --now');
    expect(result.outputBytes).toBeLessThan(result.inputBytes);
  });
});
