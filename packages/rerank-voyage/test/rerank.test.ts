import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { RerankCandidate } from '@smeltjs/core';

import {
  createVoyageRerankStage,
  VOYAGE_DEFAULT_TIMEOUT_MS,
  VOYAGE_MAX_DOCUMENTS,
  VOYAGE_RERANK_URL,
} from '../src/index.ts';
import type { VoyageFetch, VoyageResponse } from '../src/index.ts';

/**
 * The adapter, against a **transcribed fixture** and never against Voyage.
 *
 * `fetch` is a constructor option for exactly this reason: the one package in the
 * workspace that can reach the network must still have a suite that cannot. Every case
 * below asserts something a live call would otherwise be the only witness to — the
 * request body's exact shape, the index-to-candidate mapping, batching at Voyage's
 * documented ceiling, tie stability, and each refusal.
 *
 * **What the fixture is, exactly (Law 4).** `fixtures/rerank-2.5-response.json` is
 * hand-written from the response shape published at
 * https://docs.voyageai.com/reference/reranker-api (read 2026-09-08), including that
 * page's own quantised scores — two of the three tie, which is what makes the stability
 * case real rather than contrived. It is **not a recording**: no request has been made
 * to Voyage from this repository, so these tests prove the adapter matches the
 * *documented* contract and cannot prove the documented contract matches the live one.
 */

const FIXTURE = readFileSync(
  join(import.meta.dirname, 'fixtures/rerank-2.5-response.json'),
  'utf8',
);

/** One recorded call: what went out, so a test can assert on it. */
interface Recorded {
  readonly url: string;
  readonly init: Parameters<VoyageFetch>[1];
}

function ok(body: string): VoyageResponse {
  return { ok: true, status: 200, text: () => Promise.resolve(body) };
}

/** A `fetch` that answers from a script and records every request it was given. */
function recorder(bodies: readonly string[]): {
  readonly calls: Recorded[];
  readonly fetch: VoyageFetch;
} {
  const calls: Recorded[] = [];
  const fetch: VoyageFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(ok(bodies[calls.length - 1] ?? bodies[0]!));
  };
  return { calls, fetch };
}

const candidates = (count: number): readonly RerankCandidate[] =>
  Array.from({ length: count }, (_unused, index) => ({
    id: String(index),
    text: `region ${String(index)}`,
  }));

function stage(fetch: VoyageFetch, topK = 3) {
  return createVoyageRerankStage({ apiKey: 'sk-test-key', model: 'rerank-2.5', topK, fetch });
}

/** Never answers; the AbortController is the only thing that ends it. */
const hangs: VoyageFetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => void reject(new Error('aborted')));
  });

/** Answers with a status and a body, so a refusal has something real to carry through. */
const answers =
  (status: number, body: string): VoyageFetch =>
  () =>
    Promise.resolve({ ok: false, status, text: () => Promise.resolve(body) });

describe('the request smelt actually sends', () => {
  it('posts the documented body to the documented URL, with the key in a header', async () => {
    const { calls, fetch } = recorder([FIXTURE]);
    await stage(fetch).rerank(candidates(3), 'handleRequest');

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(VOYAGE_RERANK_URL);
    expect(call!.init.method).toBe('POST');
    expect(call!.init.headers['authorization']).toBe('Bearer sk-test-key');
    expect(call!.init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(call!.init.body)).toEqual({
      query: 'handleRequest',
      documents: ['region 0', 'region 1', 'region 2'],
      model: 'rerank-2.5',
      top_k: 3,
    });
  });

  it('sends nothing at all for an empty candidate list', async () => {
    // Not an empty request: no request. A ranker asked to rank nothing has nothing to
    // say, and paying for the round trip to be told so would be smelt's mistake.
    const { calls, fetch } = recorder([FIXTURE]);
    expect(await stage(fetch).rerank([], 'anything')).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('never asks for more than the batch holds', async () => {
    const { calls, fetch } = recorder([FIXTURE]);
    await createVoyageRerankStage({
      apiKey: 'sk',
      model: 'rerank-2.5',
      topK: 50,
      fetch,
    }).rerank(candidates(3), 'q');
    expect((JSON.parse(calls[0]!.init.body) as { top_k: number }).top_k).toBe(3);
  });
});

describe('the answer, mapped back onto the candidates', () => {
  it('maps relevance_score onto the candidate at that index', async () => {
    const { fetch } = recorder([FIXTURE]);
    const ranked = await stage(fetch).rerank(candidates(3), 'q');
    expect(ranked).toEqual([
      { id: '2', text: 'region 2', score: 0.7421875 },
      { id: '0', text: 'region 0', score: 0.455078125 },
      { id: '1', text: 'region 1', score: 0.455078125 },
    ]);
  });

  it('breaks ties by original order, so one input gives one output', async () => {
    // The fixture's two 0.455078125 scores arrive as index 0 then index 1. Reverse the
    // order they arrive in and the answer must not move: Voyage's scores are quantised,
    // so ties are ordinary, and a plan that reordered between runs on the same bytes
    // would make every downstream diff untrustworthy.
    const reversed = JSON.stringify({
      data: [
        { index: 1, relevance_score: 0.455078125 },
        { index: 0, relevance_score: 0.455078125 },
        { index: 2, relevance_score: 0.7421875 },
      ],
    });
    const { fetch } = recorder([reversed]);
    const ranked = await stage(fetch).rerank(candidates(3), 'q');
    expect(ranked.map((entry) => entry.id)).toEqual(['2', '0', '1']);
  });

  it('returns at most topK, most relevant first', async () => {
    const { fetch } = recorder([FIXTURE]);
    const ranked = await createVoyageRerankStage({
      apiKey: 'sk',
      model: 'rerank-2.5',
      topK: 1,
      fetch,
    }).rerank(candidates(3), 'q');
    expect(ranked.map((entry) => entry.id)).toEqual(['2']);
  });
});

describe('batching at Voyage’s documented ceiling', () => {
  it(`splits at ${String(VOYAGE_MAX_DOCUMENTS)} documents and keeps ids straight across batches`, async () => {
    // 1,000 is Voyage's stated maximum, so 1,001 candidates is exactly the case a
    // single-request adapter gets a 400 on — with smelt's name on the failure.
    const total = VOYAGE_MAX_DOCUMENTS + 1;
    const first = JSON.stringify({ data: [{ index: 0, relevance_score: 0.5 }] });
    const second = JSON.stringify({ data: [{ index: 0, relevance_score: 0.9 }] });
    const { calls, fetch } = recorder([first, second]);

    const ranked = await createVoyageRerankStage({
      apiKey: 'sk',
      model: 'rerank-2.5',
      topK: 2,
      fetch,
    }).rerank(candidates(total), 'q');

    expect(calls).toHaveLength(2);
    const bodies = calls.map((call) => JSON.parse(call.init.body) as { documents: string[] });
    expect(bodies[0]!.documents).toHaveLength(VOYAGE_MAX_DOCUMENTS);
    expect(bodies[1]!.documents).toHaveLength(1);
    // The second batch's local index 0 is the global candidate 1000 — the mapping the
    // batching must not lose.
    expect(ranked.map((entry) => entry.id)).toEqual([String(VOYAGE_MAX_DOCUMENTS), '0']);
  });
});

describe('every refusal says which thing went wrong', () => {
  it('names the timeout, the duration, and that the request was aborted', async () => {
    await expect(
      createVoyageRerankStage({
        apiKey: 'sk',
        model: 'rerank-2.5',
        topK: 1,
        timeoutMs: 5,
        fetch: hangs,
      }).rerank(candidates(1), 'q'),
    ).rejects.toThrow(/did not answer within 5ms.*aborted/s);
    expect(VOYAGE_DEFAULT_TIMEOUT_MS).toBe(30_000);
  });

  it('passes a non-2xx status and body through rather than returning nothing', async () => {
    const failing = answers(401, '{"detail":"Provided API key is invalid."}');
    await expect(stage(failing).rerank(candidates(1), 'q')).rejects.toThrow(
      /answered 401.*Provided API key is invalid/s,
    );
  });

  it('refuses an answer it cannot read instead of ranking nothing', async () => {
    // An empty list would read as "no region was relevant", and every region would be
    // cut. So a shape this adapter cannot parse is an error naming what came back.
    const { fetch } = recorder(['{"object":"list"}']);
    await expect(stage(fetch).rerank(candidates(1), 'q')).rejects.toThrow(/without a `data` array/);

    const outOfRange = recorder(['{"data":[{"index":9,"relevance_score":0.5}]}']);
    await expect(stage(outOfRange.fetch).rerank(candidates(1), 'q')).rejects.toThrow(
      /`index` is not a position in the 1 documents that were sent/,
    );
  });

  it('refuses a duplicate index, and blames the wire rather than the stage', async () => {
    // Left to reach smelt, a duplicate would surface as a RerankStageError about "the
    // same id twice" — pointing every reader at this adapter's contract with smelt
    // instead of at the response that actually broke.
    const doubled = recorder([
      '{"data":[{"index":0,"relevance_score":0.9},{"index":0,"relevance_score":0.4}]}',
    ]);
    await expect(stage(doubled.fetch).rerank(candidates(2), 'q')).rejects.toThrow(
      /returned index 0 twice in one batch/,
    );
  });

  it('refuses a non-finite relevance_score — a NaN sorts unpredictably', async () => {
    // JSON cannot carry NaN, but a proxy, a gateway or a future field can, and a NaN in
    // the sort would make one input produce different plans on different runs. That is
    // the one property this adapter's sort exists to protect.
    const notANumber = recorder(['{"data":[{"index":0,"relevance_score":null}]}']);
    await expect(stage(notANumber.fetch).rerank(candidates(1), 'q')).rejects.toThrow(
      /`relevance_score` that is not a finite number/,
    );
  });

  it('never puts the API key in an error', async () => {
    const failing = answers(500, 'upstream boom');
    const thrown = await stage(failing)
      .rerank(candidates(1), 'q')
      .then(() => undefined)
      .catch((cause: unknown) => cause as Error);
    expect(
      thrown,
      'the failing request must throw, or this assertion proves nothing',
    ).toBeInstanceOf(Error);
    expect(String(thrown?.message)).not.toContain('sk-test-key');
  });
});

describe('the stage names itself', () => {
  it('reports the adapter and the model, for the report line and the receipt', async () => {
    const { fetch } = recorder([FIXTURE]);
    const built = stage(fetch);
    expect(built.id).toBe('voyage');
    expect(built.model).toBe('rerank-2.5');
  });
});
