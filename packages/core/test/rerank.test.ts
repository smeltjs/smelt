import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUsageError, RerankStageError } from '../src/errors.ts';
import { formatReport } from '../src/cli/report.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import { loadRerankStage } from '../src/rerank/load.ts';
import { applyRerank } from '../src/rerank/protect.ts';
import { createSmelter } from '../src/smelter.ts';
import { markerPricing } from '../src/apply.ts';
import { planLexical } from '../src/plan/lexical.ts';
import { predictOutputBytes, savingBytes } from '../src/plan/budget.ts';
import type { ElisionPlan, RerankCandidate, RerankStage, RerankedCandidate } from '../src/types.ts';

/**
 * The rerank seam: the slot, the loader, and what a run reports about both.
 *
 * The adapter's own wire behaviour lives in `packages/rerank-voyage` — this file is
 * about smelt's half: which regions a stage is offered, what it may do with them, what
 * comes back as attribution, and every way a `rerank` config block can name something
 * that is not there.
 *
 * No test here reaches the network, and none can: every stage below is a literal.
 */

/** A stage that spares whichever candidate ids it was told to, and records its query. */
function spares(ids: readonly string[], model?: string) {
  const seen: { query?: string; candidates?: readonly RerankCandidate[] } = {};
  const stage: RerankStage = {
    id: 'test-ranker',
    ...(model === undefined ? {} : { model }),
    rerank(candidates: readonly RerankCandidate[], query: string) {
      seen.query = query;
      seen.candidates = candidates;
      return Promise.resolve(
        candidates
          .filter((candidate) => ids.includes(candidate.id))
          .map((candidate, index) => ({ ...candidate, score: 1 - index / 100 })),
      );
    },
  };
  return { stage, seen };
}

/** A stage that returns exactly these candidate ids, best first. */
function ranks(ids: readonly string[]): RerankStage {
  return {
    id: 'ranker',
    rerank: (candidates: readonly RerankCandidate[]) =>
      Promise.resolve(
        ids.map((id, position) => ({
          ...candidates.find((candidate) => candidate.id === id)!,
          score: 1 - position / 1000,
        })),
      ),
  };
}

const TEXT = Array.from({ length: 60 }, (_unused, i) => `line ${String(i)} filler filler`).join(
  '\n',
);

/** The pricing every test here plans and spares with — one seam, as a run has one. */
const PRICING = markerPricing('unknown');

/**
 * The slot, with the two facts the smelter carries across the seam. The default budget
 * is larger than the whole input, so a test that is not about the budget rung reads
 * exactly as it did before the rung existed and cannot be bound by it.
 */
function slot(
  request: Omit<Parameters<typeof applyRerank>[0], 'budgetBytes' | 'pricing'> &
    Partial<Pick<Parameters<typeof applyRerank>[0], 'budgetBytes' | 'pricing'>>,
): ReturnType<typeof applyRerank> {
  return applyRerank({ budgetBytes: 1_000_000, pricing: PRICING, ...request });
}

/** A real lexical plan over `TEXT`, so the candidates are the ones a run would see. */
function realPlan(budgetBytes = 300): ElisionPlan {
  return planLexical({
    text: TEXT,
    language: 'unknown',
    budgetBytes,
    focus: ['line 30'],
    pricing: PRICING,
  });
}

describe('the slot: what a stage is offered, and what it may do with it', () => {
  it('offers exactly the regions the planner proposed to remove, in plan order', async () => {
    const plan = realPlan();
    expect(plan.elisions.length).toBeGreaterThan(0);
    const { stage, seen } = spares([]);

    await slot({ stage, plan, text: TEXT, query: 'line 30' });

    expect(seen.candidates?.map((candidate) => candidate.id)).toEqual(
      plan.elisions.map((_elision, index) => String(index)),
    );
    // The candidate text is the exact bytes of the range — nothing summarised, nothing
    // else from the file.
    const bytes = Buffer.from(TEXT, 'utf8');
    for (const [index, elision] of plan.elisions.entries()) {
      expect(seen.candidates?.[index]?.text).toBe(
        bytes.subarray(elision.range.start, elision.range.end).toString('utf8'),
      );
    }
    expect(seen.query).toBe('line 30');
  });

  it('spares the candidates the stage returned and cuts every other one', async () => {
    const plan = realPlan();
    const { stage } = spares(['0']);

    const outcome = await slot({ stage, plan, text: TEXT, query: 'q' });

    expect(outcome.plan.elisions).toEqual(plan.elisions.slice(1));
    expect(outcome.attribution).toEqual({
      adapter: 'test-ranker',
      candidates: plan.elisions.length,
      returned: 1,
      kept: 1,
      sparedBytes: savingBytes(plan.elisions[0]!, PRICING),
      // The stage asked for one of many: its own cut-off ended the walk, not the budget.
      stopped: 'cap',
    });
  });

  it('can only spare — a stage never adds an elision the planner did not propose', async () => {
    // The safety property, asserted as one: whatever comes back, the surviving plan is
    // a subset of what the planner decided. A stage that could *add* a cut would be a
    // network service deciding what leaves a caller's context.
    const plan = realPlan();
    const greedy: RerankStage = {
      id: 'greedy',
      rerank: (candidates) =>
        Promise.resolve(candidates.map((candidate, i) => ({ ...candidate, score: i }))),
    };
    const outcome = await slot({ stage: greedy, plan, text: TEXT, query: 'q' });
    expect(outcome.plan.elisions).toEqual([]);
    expect(outcome.attribution.kept).toBe(plan.elisions.length);
    expect(outcome.attribution.stopped).toBe('exhausted');
    for (const elision of outcome.plan.elisions) expect(plan.elisions).toContain(elision);
  });

  it('does not call the stage when there is no query, and says so rather than reporting a zero', async () => {
    // A ranker with no query would be scoring against the empty string and calling the
    // result relevance. The candidate count stays the MEASURED size of the set the
    // planner proposed — reporting 0 because nothing was sent would be a count nobody
    // took — and `skipped` carries the reason.
    const plan = realPlan();
    let called = false;
    const stage: RerankStage = {
      id: 'never',
      rerank: () => {
        called = true;
        return Promise.resolve([]);
      },
    };
    const outcome = await slot({ stage, plan, text: TEXT, query: '   ' });
    expect(called).toBe(false);
    expect(outcome.plan).toBe(plan);
    // Nothing ran, so nothing that only a run can measure is reported: no `returned`,
    // no `sparedBytes`, no `stopped`. A zero here would be a count nobody took.
    expect(outcome.attribution).toEqual({
      adapter: 'never',
      candidates: plan.elisions.length,
      kept: 0,
      skipped: 'no-query',
    });
    expect(plan.elisions.length).toBeGreaterThan(0);
  });

  it('does not call the stage when the planner proposed nothing, and names that reason', () => {
    const empty: ElisionPlan = { planner: 'lexical/v1', language: 'unknown', elisions: [] };
    const { stage, seen } = spares([]);
    return slot({ stage, plan: empty, text: TEXT, query: 'q' }).then((outcome) => {
      expect(seen.candidates).toBeUndefined();
      expect(outcome.attribution.candidates).toBe(0);
      expect(outcome.attribution.skipped).toBe('no-candidates');
    });
  });

  it('reports no `skipped` at all when the stage actually ran', () => {
    const { stage } = spares(['0']);
    return slot({ stage, plan: realPlan(), text: TEXT, query: 'q' }).then((outcome) => {
      expect(outcome.attribution.skipped).toBeUndefined();
    });
  });

  it('wraps whatever the stage throws in a RerankStageError, keeping the cause', async () => {
    // The failure this catch exists for: a stage is the one part of a run that talks to
    // another machine, so a timeout or a 401 is an ordinary outcome. Left unwrapped it
    // reaches a CLI that calls it an internal bug and an MCP handler that crashes past
    // its envelope — see the CLI and MCP cases in cli-config.test.ts / tools.test.ts.
    const upstream = new Error('api.voyageai.com did not answer within 30000ms');
    const failing: RerankStage = {
      id: 'voyage',
      rerank: () => Promise.reject(upstream),
    };
    const thrown = await slot({ stage: failing, plan: realPlan(), text: TEXT, query: 'q' })
      .then(() => undefined)
      .catch((cause: unknown) => cause);
    expect(thrown).toBeInstanceOf(RerankStageError);
    expect((thrown as Error).message).toContain('did not answer within 30000ms');
    expect((thrown as Error).message).toContain('voyage');
    expect((thrown as { cause?: unknown }).cause).toBe(upstream);
  });

  it('wraps a stage that throws synchronously too', async () => {
    const failing: RerankStage = {
      id: 'sync-thrower',
      rerank: () => {
        throw new Error('not implemented yet');
      },
    };
    await expect(
      slot({ stage: failing, plan: realPlan(), text: TEXT, query: 'q' }),
    ).rejects.toBeInstanceOf(RerankStageError);
  });

  it('carries the stage’s model into the attribution when it names one', async () => {
    const { stage } = spares([], 'rerank-2.5');
    const outcome = await slot({ stage, plan: realPlan(), text: TEXT, query: 'q' });
    expect(outcome.attribution.model).toBe('rerank-2.5');
  });

  it('refuses an id it never sent, rather than filtering the answer down', async () => {
    const rogue: RerankStage = {
      id: 'rogue',
      rerank: () => Promise.resolve([{ id: 'nope', text: '', score: 1 }]),
    };
    await expect(slot({ stage: rogue, plan: realPlan(), text: TEXT, query: 'q' })).rejects.toThrow(
      RerankStageError,
    );
  });

  it('refuses a score that is not a finite number — the order would be undefined', async () => {
    // `score` orders the selection, so it decides which regions survive a tight budget.
    // NaN compares false against everything: left in, the "ranking" would be whatever
    // the engine's sort happened to do with it, silently and differently per engine.
    for (const score of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const wild: RerankStage = {
        id: 'wild',
        rerank: (candidates: readonly RerankCandidate[]) =>
          Promise.resolve([{ ...candidates[0]!, score }]),
      };
      await expect(slot({ stage: wild, plan: realPlan(), text: TEXT, query: 'q' })).rejects.toThrow(
        RerankStageError,
      );
    }
  });

  it('refuses the same id twice — "how many were kept" must be readable', async () => {
    const doubled: RerankStage = {
      id: 'doubled',
      rerank: (candidates: readonly RerankCandidate[]): Promise<readonly RerankedCandidate[]> =>
        Promise.resolve([
          { ...candidates[0]!, score: 1 },
          { ...candidates[0]!, score: 0.5 },
        ]),
    };
    await expect(
      slot({ stage: doubled, plan: realPlan(), text: TEXT, query: 'q' }),
    ).rejects.toThrow(/twice/);
  });
});

/**
 * THE BUDGET RUNG — the slot reads the number the caller typed.
 *
 * The stage returns a ranking of regions it wants back; this walk decides how many of
 * them the run can afford. `topK` stays the cap the user named, and the budget stays the
 * ceiling the user named — the slot invents neither. The three ways the walk can end are
 * each asserted below, because "3 of 8 kept" is only readable when the reason is beside
 * it.
 *
 * `realPlan()` is two elisions worth 521 B and 509 B off a 1,309 B input, predicting a
 * 279 B output. Every budget in this block is chosen against those measured numbers, so
 * a change in the fixture is a red test rather than a silently vacuous one.
 */
describe('the budget rung: the slot spares only as far as the budget reaches', () => {
  const PREDICTED = 279;
  const FIRST_SAVING = 521;

  it('the fixture is the one these budgets are chosen against', () => {
    const plan = realPlan();
    const inputBytes = Buffer.byteLength(TEXT, 'utf8');
    expect(plan.elisions.length).toBe(2);
    expect(plan.elisions.map((elision) => savingBytes(elision, PRICING))).toEqual([521, 509]);
    expect(predictOutputBytes(inputBytes, plan.elisions, PRICING)).toBe(PREDICTED);
    expect(inputBytes).toBe(1309);
  });

  it('stops the moment the next region would not fit, and names the budget as the reason', async () => {
    // 279 + 521 lands exactly on 800; the second region would take it to 1,309.
    const plan = realPlan();
    const outcome = await slot({
      stage: ranks(['0', '1']),
      plan,
      text: TEXT,
      query: 'q',
      budgetBytes: PREDICTED + FIRST_SAVING,
    });
    expect(outcome.attribution).toEqual({
      adapter: 'ranker',
      candidates: 2,
      returned: 2,
      kept: 1,
      sparedBytes: FIRST_SAVING,
      stopped: 'budget',
    });
    expect(outcome.plan.elisions).toEqual([plan.elisions[1]]);
    expect(
      predictOutputBytes(Buffer.byteLength(TEXT, 'utf8'), outcome.plan.elisions, PRICING),
    ).toBe(PREDICTED + FIRST_SAVING);
  });

  it('spares nothing at all when the best region alone breaks the budget', async () => {
    // The ruling, asserted: a plan that fits beats a plan that does not. The stage
    // cannot cut, so the only lever left is not sparing — and it is pulled all the way.
    const plan = realPlan();
    const outcome = await slot({
      stage: ranks(['0', '1']),
      plan,
      text: TEXT,
      query: 'q',
      budgetBytes: PREDICTED + FIRST_SAVING - 1,
    });
    expect(outcome.attribution.kept).toBe(0);
    expect(outcome.attribution.sparedBytes).toBe(0);
    expect(outcome.attribution.stopped).toBe('budget');
    expect(outcome.plan.elisions).toEqual(plan.elisions);
  });

  it('walks the stage’s ranking, not the order it happened to list them in', async () => {
    // Listed 0 then 1, scored the other way round. Only the second region fits this
    // budget; a slot that walked the list as given would spare nothing at all.
    const outOfOrder: RerankStage = {
      id: 'out-of-order',
      rerank: (candidates: readonly RerankCandidate[]) =>
        Promise.resolve([
          { ...candidates[0]!, score: 0.1 },
          { ...candidates[1]!, score: 0.9 },
        ]),
    };
    const plan = realPlan();
    const outcome = await slot({
      stage: outOfOrder,
      plan,
      text: TEXT,
      query: 'q',
      budgetBytes: 790,
    });
    expect(outcome.attribution.kept).toBe(1);
    expect(outcome.plan.elisions).toEqual([plan.elisions[0]]);
  });

  it('breaks a tie by the order the candidates were sent, so the walk is deterministic', async () => {
    // Equal scores, listed second-first. The tie goes to the earlier candidate, so a
    // budget with room for exactly one spares region 0 — every time, on every machine.
    const tied: RerankStage = {
      id: 'tied',
      rerank: (candidates: readonly RerankCandidate[]) =>
        Promise.resolve([
          { ...candidates[1]!, score: 0.5 },
          { ...candidates[0]!, score: 0.5 },
        ]),
    };
    const plan = realPlan();
    const outcome = await slot({
      stage: tied,
      plan,
      text: TEXT,
      query: 'q',
      budgetBytes: PREDICTED + FIRST_SAVING,
    });
    expect(outcome.plan.elisions).toEqual([plan.elisions[1]]);
    expect(outcome.attribution.kept).toBe(1);
  });

  it('does not call the stage at all when the planner’s own plan is over budget', async () => {
    // The cost a rerank has that is not measured in bytes: the call itself. A plan that
    // does not fit affords no spare, so every answer is refused in advance — and asking
    // anyway would ship the caller's source to a third party for a result that could not
    // be used. This is a SKIP, not a stop: the stage never ran, so nothing only a run can
    // measure is reported.
    const proposed = realPlan();
    let called = false;
    const stage: RerankStage = {
      id: 'never',
      rerank: (candidates: readonly RerankCandidate[]) => {
        called = true;
        return Promise.resolve(candidates.map((c) => ({ ...c, score: 1 })));
      },
    };
    const outcome = await slot({
      stage,
      plan: proposed,
      text: TEXT,
      query: 'q',
      budgetBytes: PREDICTED - 1,
    });
    expect(called).toBe(false);
    expect(outcome.plan).toBe(proposed);
    expect(outcome.attribution).toEqual({
      adapter: 'never',
      candidates: proposed.elisions.length,
      kept: 0,
      skipped: 'plan-over-budget',
    });
  });

  it('still calls the stage when the plan lands exactly on the budget', async () => {
    // The boundary the skip must not swallow: a plan that fits *exactly* affords no
    // spare either, but it is the ordinary in-budget case and the stage's answer is a
    // real refusal at the rung rather than a question never asked.
    const outcome = await slot({
      stage: ranks(['0', '1']),
      plan: realPlan(),
      text: TEXT,
      query: 'q',
      budgetBytes: PREDICTED,
    });
    expect(outcome.attribution.skipped).toBeUndefined();
    expect(outcome.attribution.returned).toBe(2);
    expect(outcome.attribution.kept).toBe(0);
    expect(outcome.attribution.stopped).toBe('budget');
  });

  it('says `exhausted` when the stage returned nothing, never `cap`', async () => {
    // A list that ran out at zero has no cut-off to blame, and `cap` would tell a reader
    // to raise a `topK` that was never reached.
    const { stage } = spares([]);
    const outcome = await slot({ stage, plan: realPlan(), text: TEXT, query: 'q' });
    expect(outcome.attribution.returned).toBe(0);
    expect(outcome.attribution.kept).toBe(0);
    expect(outcome.attribution.stopped).toBe('exhausted');
  });

  it('says `cap` when the stage’s own cut-off ended the walk, not the budget', async () => {
    // K is the user's number and smelt honours it as a cap: one of two came back, both
    // would have fitted, and the run kept exactly what was asked for.
    const outcome = await slot({ stage: ranks(['1']), plan: realPlan(), text: TEXT, query: 'q' });
    expect(outcome.attribution.returned).toBe(1);
    expect(outcome.attribution.kept).toBe(1);
    expect(outcome.attribution.stopped).toBe('cap');
  });

  it('says `exhausted` when every candidate offered came back and every one fitted', async () => {
    const outcome = await slot({
      stage: ranks(['0', '1']),
      plan: realPlan(),
      text: TEXT,
      query: 'q',
    });
    expect(outcome.attribution.kept).toBe(2);
    expect(outcome.attribution.returned).toBe(2);
    expect(outcome.attribution.stopped).toBe('exhausted');
  });

  it('counts the spared bytes through the same pricing the planner used', async () => {
    const plan = realPlan();
    const outcome = await slot({ stage: ranks(['1', '0']), plan, text: TEXT, query: 'q' });
    expect(outcome.attribution.sparedBytes).toBe(
      savingBytes(plan.elisions[0]!, PRICING) + savingBytes(plan.elisions[1]!, PRICING),
    );
    // Not a second tally: it is exactly the distance the output moved.
    const inputBytes = Buffer.byteLength(TEXT, 'utf8');
    expect(
      predictOutputBytes(inputBytes, outcome.plan.elisions, PRICING) -
        predictOutputBytes(inputBytes, plan.elisions, PRICING),
    ).toBe(outcome.attribution.sparedBytes);
  });

  it('never pushes a plan that fitted past the budget — over many rankings and budgets', async () => {
    // The property, end to end and offline: an arbitrary stage answer, an arbitrary
    // budget, and the real `smelt()` path. The prediction the rung spares against is
    // exact rather than an estimate — the placeholder hash it prices with is the real
    // hash's length — so the assertion is `<=` and not `<= budget + slack`.
    const focus = ['line 10', 'line 30', 'line 50'];
    let seed = 0x5eed;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let round = 0; round < 120; round += 1) {
      const budgetBytes = 400 + Math.floor(next() * 900);
      const stage: RerankStage = {
        id: 'arbitrary',
        rerank: (candidates: readonly RerankCandidate[]) =>
          Promise.resolve(
            candidates
              .filter(() => next() > 0.3)
              .map((candidate) => ({ ...candidate, score: next() })),
          ),
      };
      const plain = await createSmelter({ strategy: 'lexical' }).smelt(TEXT, {
        budgetBytes,
        focus,
      });
      const reranked = await createSmelter({ strategy: 'lexical', rerank: stage }).smelt(TEXT, {
        budgetBytes,
        focus,
      });
      // A stage can only spare, so it can never beat the planner...
      expect(reranked.outputBytes, `round ${String(round)}`).toBeGreaterThanOrEqual(
        plain.outputBytes,
      );
      // ...and it never spares past the ceiling, so a plan that fitted still fits.
      if (plain.outputBytes <= budgetBytes) {
        expect(reranked.outputBytes, `round ${String(round)}`).toBeLessThanOrEqual(budgetBytes);
      }
      const attribution = reranked.rerank!;
      if (attribution.skipped === undefined) {
        expect(attribution.kept).toBeLessThanOrEqual(attribution.returned!);
        expect(attribution.stopped).toBeDefined();
      }
    }
  });
});

describe('a smelter with a stage wired in', () => {
  it('reports the attribution on the result, and leaves it absent without a stage', async () => {
    // 900 B, with room for one of the two regions to come back — so the attribution
    // under test is the ordinary one, not a budget refusal wearing its clothes.
    const budgetBytes = 900;
    const plain = await createSmelter({ strategy: 'lexical' }).smelt(TEXT, {
      budgetBytes,
      focus: ['line 30'],
    });
    expect(plain.rerank).toBeUndefined();

    const { stage } = spares(['0'], 'v1');
    const reranked = await createSmelter({ strategy: 'lexical', rerank: stage }).smelt(TEXT, {
      budgetBytes,
      focus: ['line 30'],
    });
    expect(reranked.rerank).toEqual({
      adapter: 'test-ranker',
      model: 'v1',
      candidates: plain.elisions.length,
      returned: 1,
      kept: 1,
      sparedBytes: reranked.outputBytes - plain.outputBytes,
      stopped: 'cap',
    });
    // One fewer cut, and the spared bytes are back in the output.
    expect(reranked.elisions.length).toBe(plain.elisions.length - 1);
    expect(reranked.outputBytes).toBeGreaterThan(plain.outputBytes);
  });

  it('cannot turn an in-budget run into an over-budget one, and the report says where it stopped', async () => {
    // The old consequence of spare-only, now bounded: a stage that asks for everything
    // gets as much of it as the budget affords and no more. Nothing was cut to make the
    // number look right — the regions the budget refused were never spared in the first
    // place, and the line says which wall the walk hit.
    const budgetBytes = 900;
    const plain = await createSmelter({ strategy: 'lexical' }).smelt(TEXT, {
      budgetBytes,
      focus: ['line 30'],
    });
    expect(plain.outputBytes).toBeLessThanOrEqual(budgetBytes);

    const keepEverything: RerankStage = {
      id: 'keeps-all',
      rerank: (given) => Promise.resolve(given.map((c, i) => ({ ...c, score: 1 - i / 100 }))),
    };
    const reranked = await createSmelter({ strategy: 'lexical', rerank: keepEverything }).smelt(
      TEXT,
      { budgetBytes, focus: ['line 30'] },
    );
    expect(reranked.outputBytes).toBeLessThanOrEqual(budgetBytes);
    expect(reranked.rerank?.stopped).toBe('budget');
    expect(reranked.rerank?.returned).toBe(plain.elisions.length);
    expect(reranked.rerank?.kept).toBe(1);
    expect(reranked.rerank?.kept).toBeLessThan(plain.elisions.length);
    expect(reranked.outputBytes).toBeGreaterThan(plain.outputBytes);
    const report = formatReport({ result: reranked, source: 'x', budgetBytes, inputText: TEXT });
    expect(report).not.toContain('OVER BUDGET');
    expect(report).toContain('stopped at the budget');
  });

  it('never reaches the stage when the run is already over budget, and says so', async () => {
    // Through the real `smelt()` path: a budget the planner could not meet means the
    // stage is not asked, so no bytes of this input leave the machine. The report says
    // "not run" with the reason, which is the difference between a reranker that had
    // nothing to do and one that was never wired up.
    const budgetBytes = 60;
    let called = false;
    const stage: RerankStage = {
      id: 'never',
      rerank: (candidates) => {
        called = true;
        return Promise.resolve(candidates.map((c) => ({ ...c, score: 1 })));
      },
    };
    const result = await createSmelter({ strategy: 'lexical', rerank: stage }).smelt(TEXT, {
      budgetBytes,
      focus: ['line 30'],
    });
    expect(called).toBe(false);
    expect(result.outputBytes).toBeGreaterThan(budgetBytes);
    expect(result.rerank).toEqual({
      adapter: 'never',
      candidates: result.elisions.length,
      kept: 0,
      skipped: 'plan-over-budget',
    });
    expect(formatReport({ result, source: 'x', budgetBytes, inputText: TEXT })).toContain(
      'not run: the planner’s own plan is over budget, so nothing could be spared',
    );
  });

  it('stays byte-for-byte reversible over the smaller plan (Law 3 is untouched)', async () => {
    const { stage } = spares(['0']);
    const smelter = createSmelter({ strategy: 'lexical', rerank: stage });
    const result = await smelter.smelt(TEXT, { budgetBytes: 300, focus: ['line 30'] });
    expect(smelter.reconstruct(result)).toBe(TEXT);
  });
});

/**
 * THE SAME RULING, FROM THE OUTSIDE — a reranker named in a config file honours the
 * budget the command line typed.
 *
 * `applyRerank`'s budget rung is pinned above at the seam; this is the consequence a
 * person meets. A reranker is the one config key that can make smelt talk to another
 * machine, and before the rung it was also the one that could make a run that fitted
 * stop fitting. Now `--budget` outranks the stage: the spares stop at the ceiling, the
 * run still exits 0, and the report names both the stage and the wall it hit. Exit 0 is
 * how a script finds out, so it is asserted through the CLI rather than inferred from
 * `outputBytes`.
 */
describe('a configured reranker through the CLI', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smelt-rerank-cli-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // Room for one of the two regions the planner proposes to come back, and not both —
  // so the run below exercises the rung rather than either of its edges.
  const BUDGET = 900;

  async function smelt(): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['--budget', String(BUDGET), '--focus', 'line 30'], {
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
      stdin: () => `${TEXT}\n`,
      version: '9.9.9-test',
      cwd: dir,
    });
    return { code, stdout, stderr };
  }

  /** A config in `dir`, with the `rerank` block when one is given. */
  function config(rerank?: Record<string, unknown>): void {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, strategy: 'lexical', ...(rerank === undefined ? {} : { rerank }) })}\n`,
    );
  }

  it('keeps the run inside --budget, and the report says which stage stopped where', async () => {
    config();
    const plain = await smelt();
    expect(plain.code, plain.stderr).toBe(EXIT.ok);

    // The same run, with a stage that asks to keep every region the planner proposed.
    // It is a real file, loaded through the real loader: the seam under test is the
    // config block reaching a run, not a stage handed to a smelter by a test.
    writeFileSync(
      join(dir, 'keep-everything.mjs'),
      `export default {\n` +
        `  id: 'keeps-all',\n` +
        `  rerank: async (candidates) => candidates.map((c, i) => ({ ...c, score: 1 - i / 100 })),\n` +
        `};\n`,
    );
    config({ kind: 'module', path: './keep-everything.mjs' });

    const reranked = await smelt();
    expect(reranked.code, reranked.stderr).toBe(EXIT.ok);
    expect(reranked.stderr).not.toContain('OVER BUDGET');
    expect(Buffer.byteLength(reranked.stdout, 'utf8')).toBeLessThanOrEqual(BUDGET + 1);
    // Attributed, not anonymous: the path the config named is what the report prints,
    // beside the reason the sparing stopped where it did.
    expect(reranked.stderr).toContain('module/./keep-everything.mjs');
    expect(reranked.stderr).toContain('stopped at the budget');
    // More survived than a run with no reranker at all — the stage did do something.
    expect(reranked.stdout.length).toBeGreaterThan(plain.stdout.length);
  });
});

describe('loading a stage from a config block', () => {
  let dir: string;
  beforeEach(() => {
    // `realpathSync`: `require.resolve` answers in real paths, and macOS hands out a
    // `/var/folders/...` symlink for `/private/var/folders/...`.
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-rerank-')));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const load = (rerank: Parameters<typeof loadRerankStage>[0]['rerank'], env = {}) =>
    loadRerankStage({ rerank, configDir: dir, env });

  it('loads nothing at all when the config names no reranker', async () => {
    expect(await load(undefined)).toBeUndefined();
  });

  it('loads a module’s default export and attributes it by the configured path', async () => {
    writeFileSync(
      join(dir, 'mine.mjs'),
      `export default { id: 'mine/v1', rerank: async () => [] };\n`,
    );
    const stage = await load({ kind: 'module', path: './mine.mjs' });
    expect(stage?.id).toBe('module/./mine.mjs');
    expect(await stage?.rerank([], 'q')).toEqual([]);
  });

  it('accepts the `rerank` export the init stub writes', async () => {
    writeFileSync(
      join(dir, 'stub.mjs'),
      `export const rerank = { id: 'x', rerank: async () => [] };\n`,
    );
    expect((await load({ kind: 'module', path: './stub.mjs' }))?.id).toBe('module/./stub.mjs');
  });

  it('names the path when the file is not there', async () => {
    await expect(load({ kind: 'module', path: './missing.mjs' })).rejects.toThrow(
      /rerank.path to "\.\/missing\.mjs".*relative to the config file/s,
    );
  });

  it('names the file when it exports no stage', async () => {
    writeFileSync(join(dir, 'empty.mjs'), `export const somethingElse = 1;\n`);
    await expect(load({ kind: 'module', path: './empty.mjs' })).rejects.toThrow(
      /exports no RerankStage/,
    );
  });

  it('refuses a voyage block with no topK, and says why there is no default', async () => {
    await expect(load({ kind: 'voyage' }, { VOYAGE_API_KEY: 'k' })).rejects.toThrow(
      /without a "topK".*no default/s,
    );
  });

  it('names the environment VARIABLE when the key is unset, and never falls back', async () => {
    // The failure mode this refusal exists for is the silent one: a reranker you
    // configured, did not get, and were never told about.
    await expect(load({ kind: 'voyage', topK: 4 }, {})).rejects.toThrow(
      /VOYAGE_API_KEY environment variable, and VOYAGE_API_KEY is not set/,
    );
    await expect(load({ kind: 'voyage', topK: 4, apiKeyEnv: 'MY_KEY' }, {})).rejects.toThrow(
      /MY_KEY is not set/,
    );
  });

  // Where the *voyage* refusal is asserted, and why it is not here: pnpm runs this
  // process with a `NODE_PATH` aimed at the workspace's virtual store, which holds
  // every package in the repository — the adapter included — so `require.resolve`
  // answers yes from any directory at all and an "it is not installed" assertion in
  // this file would be about the developer's shell. `cli-bin.test.ts` spawns the built
  // binary with an empty `NODE_PATH`, which is the environment a consumer has.

  it('loads the adapter installed beside the config file, not one beside smelt', async () => {
    // The bug this seam exists for, at the loader: a config in a directory of its own
    // (a `$HOME` config, InstallScope `user`) with the adapter installed beside it.
    // `voyage` cannot be exercised without the real package, so the `module` kind
    // carries it — the two kinds share one resolver, which is the property under test.
    const home = join(dir, 'node_modules', 'my-reranker');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'package.json'),
      `${JSON.stringify({ name: 'my-reranker', version: '1.0.0', type: 'module', main: 'i.js' })}\n`,
    );
    writeFileSync(join(home, 'i.js'), `export default { id: 'p/v1', rerank: async () => [] };\n`);

    const stage = await load({ kind: 'module', path: 'my-reranker' });

    expect(stage?.id).toBe('module/my-reranker');
  });

  it('a file beside the config still wins over a package of the same name', async () => {
    // The path rule is what the schema promises and what every config written so far
    // means; the package search is what happens when there is no file there.
    const home = join(dir, 'node_modules', 'ranker.mjs');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'package.json'),
      `${JSON.stringify({ name: 'ranker.mjs', version: '1.0.0', type: 'module', main: 'i.js' })}\n`,
    );
    writeFileSync(join(home, 'i.js'), `export default { id: 'pkg', rerank: async () => [] };\n`);
    writeFileSync(
      join(dir, 'ranker.mjs'),
      `export default { id: 'file', rerank: async () => [] };\n`,
    );

    expect((await load({ kind: 'module', path: 'ranker.mjs' }))?.id).toBe('module/ranker.mjs');
  });

  it('a bare path that is neither a file nor a package names both, and the "./" fix', async () => {
    await expect(load({ kind: 'module', path: 'nowhere' })).rejects.toThrow(
      /There is no file at .*nowhere, and nowhere is not installed.*Write "\.\/nowhere"/s,
    );
  });

  it('every refusal is a usage error, so a front door exits 2 rather than crashing', async () => {
    await expect(load({ kind: 'module', path: './nope.mjs' })).rejects.toBeInstanceOf(
      CliUsageError,
    );
  });
});
