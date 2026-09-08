import type { RerankCandidate, RerankStage, RerankedCandidate } from '@smeltjs/core';

/**
 * ⚠️ **THIS PACKAGE REACHES THE NETWORK. It is the only one in the smelt workspace that
 * does, and that is its entire reason for existing.**
 *
 * `@smeltjs/core` and `@smeltjs/mcp` make zero external calls, and their Law 1 guards
 * walk the real import graph to prove it — including a ruling that classifies *this
 * package's name* as a forbidden import, so neither of them can ever depend on it. The
 * only way a byte of your source reaches Voyage is that you installed this package
 * yourself and wrote a `rerank` block into your own `smelt.config.json` (ADR-0004). No
 * default, no `SMELT_*` environment variable, no bundled key handling.
 *
 * What it sends, exactly: the **query** (your focus terms) and the **text of the regions
 * the planner had already decided to remove** — never the whole file, never the regions
 * that survive. What it gets back is a relevance score per region, and smelt uses it to
 * spare the top ones from the cut. Nothing is written anywhere by this package.
 *
 * The wire contract (`POST https://api.voyageai.com/v1/rerank`, `Authorization: Bearer`,
 * `{query, documents, model, top_k}` in, `{data: [{index, relevance_score}], model,
 * usage}` out) was verified against the live API on 2026-09-08 and against
 * https://docs.voyageai.com/reference/reranker-api.
 */

/** Where the requests go. Stated once so a test can assert the exact URL. */
export const VOYAGE_RERANK_URL = 'https://api.voyageai.com/v1/rerank';

/**
 * Documents per request, from Voyage's own reranker documentation ("strict constraints
 * on the number of documents (maximum 1,000)", https://docs.voyageai.com/docs/reranker,
 * read 2026-09-08). Larger candidate sets are split into batches of this size.
 *
 * It is a documented API constraint, not a tuning knob, so it is not configurable: a
 * consumer who lowered it would only make more requests, and one who raised it would
 * get a 400 from Voyage with smelt's name on it.
 */
export const VOYAGE_MAX_DOCUMENTS = 1000;

/** How long one request may take before it is aborted, in milliseconds. */
export const VOYAGE_DEFAULT_TIMEOUT_MS = 30_000;

/**
 * The slice of `fetch` this adapter uses, stated structurally.
 *
 * Structural for the reason `AnswerStream` and `LocalResource` are structural in the
 * core: a `.d.ts` that names a global type only compiles inside a consumer's
 * compilation that happened to include the same lib. These are the four members
 * actually read, and the real `globalThis.fetch` satisfies them.
 */
export interface VoyageResponse {
  readonly ok: boolean;
  readonly status: number;
  text(): Promise<string>;
}

/** The request shape this adapter issues. A test passes a function; production passes `fetch`. */
export type VoyageFetch = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly signal: AbortSignal;
  },
) => Promise<VoyageResponse>;

/** Options for {@link createVoyageRerankStage}. */
export interface VoyageRerankOptions {
  /**
   * The API key. Read by the *caller* out of the environment variable its own config
   * named — this package reads no environment variable of its own, so there is no name
   * it could pick up by accident.
   */
  readonly apiKey: string;
  /** The Voyage rerank model, e.g. `rerank-2.5`. Required: a model smelt chose would be a claim. */
  readonly model: string;
  /**
   * How many of the ranked candidates come back — Voyage's `top_k`, and therefore how
   * many regions smelt spares from the cut. Required for the same reason `--budget` is:
   * a number invented here would silently decide how much of a caller's context
   * survives.
   */
  readonly topK: number;
  /** Milliseconds before a request is aborted. Defaults to {@link VOYAGE_DEFAULT_TIMEOUT_MS}. */
  readonly timeoutMs?: number;
  /** Injected for tests. Defaults to the runtime's own `fetch`. */
  readonly fetch?: VoyageFetch;
}

/** One entry of Voyage's `data` array. */
interface VoyageResult {
  readonly index: number;
  readonly relevance_score: number;
}

/**
 * Build the stage. Nothing happens until `rerank()` is called — constructing it makes
 * no request, so a misconfigured run fails at the moment it would have sent something.
 */
export function createVoyageRerankStage(options: VoyageRerankOptions): RerankStage {
  const timeoutMs = options.timeoutMs ?? VOYAGE_DEFAULT_TIMEOUT_MS;
  // `globalThis.fetch` is the one network call in this workspace. It is spelled here,
  // in the package whose README, description and docblock all say so.
  const send: VoyageFetch = options.fetch ?? ((url, init) => globalThis.fetch(url, init));

  return {
    id: 'voyage',
    model: options.model,

    async rerank(
      candidates: readonly RerankCandidate[],
      query: string,
    ): Promise<readonly RerankedCandidate[]> {
      if (candidates.length === 0) return [];

      const scored: RerankedCandidate[] = [];
      for (const batch of batches(candidates, VOYAGE_MAX_DOCUMENTS)) {
        const results = await rankBatch(send, options, timeoutMs, batch, query);
        for (const result of results) {
          const candidate = batch[result.index];
          if (candidate === undefined) {
            throw new Error(
              `${VOYAGE_RERANK_URL} returned index ${String(result.index)} for a batch of ` +
                `${String(batch.length)} documents. Refusing to guess which region it meant.`,
            );
          }
          scored.push({ ...candidate, score: result.relevance_score });
        }
      }

      // Most relevant first, and **stable in the original order for ties**: Voyage
      // scores are quantised (0.455078125 is a real value from its own docs), so ties
      // are ordinary rather than exotic, and a sort that broke them by whim would make
      // the same input produce two different outputs across runs. Across batches the
      // original index is also the only ordering the two halves share.
      const order = new Map(candidates.map((candidate, index) => [candidate.id, index]));
      scored.sort((a, b) => b.score - a.score || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
      // One `top_k` per batch means a multi-batch run can come back with more than
      // `topK` in hand; the caller asked for `topK`, so that is what it gets.
      return scored.slice(0, options.topK);
    },
  };
}

/** One request. The `AbortController` is the timeout, and the thrown error says so. */
async function rankBatch(
  send: VoyageFetch,
  options: VoyageRerankOptions,
  timeoutMs: number,
  batch: readonly RerankCandidate[],
  query: string,
): Promise<readonly VoyageResult[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => void controller.abort(), timeoutMs);
  let response: VoyageResponse;
  try {
    response = await send(VOYAGE_RERANK_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        query,
        documents: batch.map((candidate) => candidate.text),
        model: options.model,
        top_k: Math.min(options.topK, batch.length),
      }),
      signal: controller.signal,
    });
  } catch (cause) {
    // An abort and a DNS failure both land here, and they are different problems for
    // whoever has to fix them — so the reason is stated rather than folded into
    // "request failed".
    throw new Error(
      controller.signal.aborted
        ? `${VOYAGE_RERANK_URL} did not answer within ${String(timeoutMs)}ms and the request ` +
            `was aborted. smelt would rather fail than block a cut on somebody else's ` +
            `latency; raise timeoutMs if that is wrong for you.`
        : `${VOYAGE_RERANK_URL} could not be reached: ` +
            `${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await response.text();
  if (!response.ok) {
    // The body is included because Voyage's own error messages are the useful part —
    // a wrong model name, an over-limit request. The key is never in it; it rode in a
    // header, and nothing here echoes headers.
    throw new Error(
      `${VOYAGE_RERANK_URL} answered ${String(response.status)}: ${body.slice(0, 500)}`,
    );
  }
  return parseResults(body, batch.length);
}

/**
 * Voyage's answer, validated rather than trusted.
 *
 * A reranker's answer decides what a caller's model does and does not see, so a shape
 * this adapter cannot read is an error naming what came back — never an empty list,
 * which would read as "nothing was relevant" and silently let every region be cut.
 */
function parseResults(body: string, batchSize: number): readonly VoyageResult[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (cause) {
    throw new Error(
      `${VOYAGE_RERANK_URL} answered with something that is not JSON: ${body.slice(0, 200)}`,
      {
        cause,
      },
    );
  }
  const data = (parsed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) {
    throw new Error(
      `${VOYAGE_RERANK_URL} answered without a \`data\` array: ${body.slice(0, 200)}`,
    );
  }
  return data.map((entry) => {
    const result = entry as { index?: unknown; relevance_score?: unknown };
    if (
      typeof result.index !== 'number' ||
      !Number.isInteger(result.index) ||
      result.index < 0 ||
      result.index >= batchSize ||
      typeof result.relevance_score !== 'number'
    ) {
      throw new Error(
        `${VOYAGE_RERANK_URL} returned an entry smelt cannot read: ${JSON.stringify(entry)}`,
      );
    }
    return { index: result.index, relevance_score: result.relevance_score };
  });
}

/** Fixed-size slices, in order. See {@link VOYAGE_MAX_DOCUMENTS} for the size and its source. */
function* batches<T>(items: readonly T[], size: number): Generator<readonly T[]> {
  for (let start = 0; start < items.length; start += size) {
    yield items.slice(start, start + size);
  }
}
