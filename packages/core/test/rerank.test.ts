import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUsageError, RerankStageError } from '../src/errors.ts';
import { loadRerankStage } from '../src/rerank/load.ts';
import { applyRerank } from '../src/rerank/protect.ts';
import { createSmelter } from '../src/smelter.ts';
import { markerPricing } from '../src/apply.ts';
import { planLexical } from '../src/plan/lexical.ts';
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

const TEXT = Array.from({ length: 60 }, (_unused, i) => `line ${String(i)} filler filler`).join(
  '\n',
);

/** A real lexical plan over `TEXT`, so the candidates are the ones a run would see. */
function realPlan(budgetBytes = 300): ElisionPlan {
  return planLexical({
    text: TEXT,
    language: 'unknown',
    budgetBytes,
    focus: ['line 30'],
    pricing: markerPricing('unknown'),
  });
}

describe('the slot: what a stage is offered, and what it may do with it', () => {
  it('offers exactly the regions the planner proposed to remove, in plan order', async () => {
    const plan = realPlan();
    expect(plan.elisions.length).toBeGreaterThan(0);
    const { stage, seen } = spares([]);

    await applyRerank({ stage, plan, text: TEXT, query: 'line 30' });

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

    const outcome = await applyRerank({ stage, plan, text: TEXT, query: 'q' });

    expect(outcome.plan.elisions).toEqual(plan.elisions.slice(1));
    expect(outcome.attribution).toEqual({
      adapter: 'test-ranker',
      candidates: plan.elisions.length,
      kept: 1,
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
    const outcome = await applyRerank({ stage: greedy, plan, text: TEXT, query: 'q' });
    expect(outcome.plan.elisions).toEqual([]);
    expect(outcome.attribution.kept).toBe(plan.elisions.length);
    for (const elision of outcome.plan.elisions) expect(plan.elisions).toContain(elision);
  });

  it('does not call the stage when there is no query to rank against', async () => {
    // A ranker with no query would be scoring against the empty string and calling the
    // result relevance. The attribution says 0/0 — a measurement, not a silence.
    const plan = realPlan();
    let called = false;
    const stage: RerankStage = {
      id: 'never',
      rerank: () => {
        called = true;
        return Promise.resolve([]);
      },
    };
    const outcome = await applyRerank({ stage, plan, text: TEXT, query: '   ' });
    expect(called).toBe(false);
    expect(outcome.plan).toBe(plan);
    expect(outcome.attribution).toEqual({ adapter: 'never', candidates: 0, kept: 0 });
  });

  it('does not call the stage when the planner proposed nothing', async () => {
    const empty: ElisionPlan = { planner: 'lexical/v1', language: 'unknown', elisions: [] };
    const { stage, seen } = spares([]);
    const outcome = await applyRerank({ stage, plan: empty, text: TEXT, query: 'q' });
    expect(seen.candidates).toBeUndefined();
    expect(outcome.attribution.candidates).toBe(0);
  });

  it('carries the stage’s model into the attribution when it names one', async () => {
    const { stage } = spares([], 'rerank-2.5');
    const outcome = await applyRerank({ stage, plan: realPlan(), text: TEXT, query: 'q' });
    expect(outcome.attribution.model).toBe('rerank-2.5');
  });

  it('refuses an id it never sent, rather than filtering the answer down', async () => {
    const rogue: RerankStage = {
      id: 'rogue',
      rerank: () => Promise.resolve([{ id: 'nope', text: '', score: 1 }]),
    };
    await expect(
      applyRerank({ stage: rogue, plan: realPlan(), text: TEXT, query: 'q' }),
    ).rejects.toThrow(RerankStageError);
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
      applyRerank({ stage: doubled, plan: realPlan(), text: TEXT, query: 'q' }),
    ).rejects.toThrow(/twice/);
  });
});

describe('a smelter with a stage wired in', () => {
  it('reports the attribution on the result, and leaves it absent without a stage', async () => {
    const plain = await createSmelter({ strategy: 'lexical' }).smelt(TEXT, {
      budgetBytes: 300,
      focus: ['line 30'],
    });
    expect(plain.rerank).toBeUndefined();

    const { stage } = spares(['0'], 'v1');
    const reranked = await createSmelter({ strategy: 'lexical', rerank: stage }).smelt(TEXT, {
      budgetBytes: 300,
      focus: ['line 30'],
    });
    expect(reranked.rerank).toEqual({
      adapter: 'test-ranker',
      model: 'v1',
      candidates: plain.elisions.length,
      kept: 1,
    });
    // One fewer cut, and the spared bytes are back in the output.
    expect(reranked.elisions.length).toBe(plain.elisions.length - 1);
    expect(reranked.outputBytes).toBeGreaterThan(plain.outputBytes);
  });

  it('stays byte-for-byte reversible over the smaller plan (Law 3 is untouched)', async () => {
    const { stage } = spares(['0']);
    const smelter = createSmelter({ strategy: 'lexical', rerank: stage });
    const result = await smelter.smelt(TEXT, { budgetBytes: 300, focus: ['line 30'] });
    expect(smelter.reconstruct(result)).toBe(TEXT);
  });
});

describe('loading a stage from a config block', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smelt-rerank-'));
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

  it('names the install command when the adapter package is absent', async () => {
    // Resolved from this test file's own directory, where @smeltjs/rerank-voyage is not
    // a dependency — which is the whole point: the core does not depend on it.
    await expect(load({ kind: 'voyage', topK: 4 }, { VOYAGE_API_KEY: 'k' })).rejects.toThrow(
      /install @smeltjs\/rerank-voyage to use rerank\.kind "voyage"/,
    );
  });

  it('every refusal is a usage error, so a front door exits 2 rather than crashing', async () => {
    await expect(load({ kind: 'module', path: './nope.mjs' })).rejects.toBeInstanceOf(
      CliUsageError,
    );
  });
});
