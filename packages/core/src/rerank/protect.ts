import { RerankStageError } from '../errors.ts';
import type {
  ElisionPlan,
  RerankAttribution,
  RerankCandidate,
  RerankStage,
  RerankedCandidate,
} from '../types.ts';

/**
 * WHERE A RERANKER ACTUALLY BITES — the stage's slot in the pipeline, implemented.
 *
 * `RerankStage` has been an interface with no slot since v1: the type said what a
 * reranker *is* and nothing in the pipeline said what it *does*. This module is the
 * slot, and it is deliberately the smallest honest one.
 *
 * **The candidates are the planner's own proposed elisions.** A planner returns a plan
 * — a list of ranges it decided to remove — before a byte of the text is touched. Those
 * ranges are exactly the regions at stake, so they are exactly what a relevance ranker
 * should be asked about: *of the things this planner is about to hide, which ones does
 * the task actually need?* Nothing else in the file needs an opinion, and chunking the
 * input into invented windows to have something to rank would be smelt manufacturing
 * candidates the pipeline never had.
 *
 * **A reranker can only preserve, never cut.** The top-ranked candidates are dropped
 * from the plan, so the regions the stage thought relevant survive into the output as
 * if a focus term had matched them; every other elision is made exactly as planned.
 * That direction is not a limitation, it is the safety property: a stage that could
 * *add* elisions would be a network service deciding what leaves a caller's context,
 * and a bad answer from it would be undetectable. A bad answer here costs bytes, and
 * bytes are reported — the run can come back over budget, and the report says so in the
 * same words it uses for a focus window that would not fit.
 *
 * **Nothing is invented when there is nothing to do.** No candidates, or no query to
 * rank them against, and the stage is not called at all — the attribution says `0
 * candidates, 0 kept`, which is a measurement rather than a silence.
 */

/** The query and the plan one stage is asked about, already resolved. */
export interface RerankRequest {
  /** The stage the caller configured. */
  readonly stage: RerankStage;
  /** The plan as the planner returned it. Never mutated. */
  readonly plan: ElisionPlan;
  /** The exact text the plan's ranges index into, for slicing candidate bytes. */
  readonly text: string;
  /**
   * What the task is about, as one string — the focus terms joined. Empty means the run
   * named nothing to rank against, and the stage is not called: a ranker with no query
   * would be scoring against the empty string and calling the result relevance.
   */
  readonly query: string;
}

/** The plan after the stage had its say, and the attribution every surface renders. */
export interface RerankOutcome {
  readonly plan: ElisionPlan;
  readonly attribution: RerankAttribution;
}

/**
 * Ask the stage which of the planner's proposed elisions to spare, and spare them.
 *
 * @throws {RerankStageError} for **every** way the stage can fail: it threw (a timeout,
 *   a 401, an unreachable host, an unimplemented stub), it answered with an id it was
 *   never sent, or it answered with the same id twice. A stage talks to another machine,
 *   so its failures are expected rather than exceptional — and a plain `Error` escaping
 *   here would reach a CLI that calls it an internal bug and an MCP handler that crashes
 *   past its envelope. See {@link RerankStageError}.
 */
export async function applyRerank(request: RerankRequest): Promise<RerankOutcome> {
  const { stage, plan, text, query } = request;
  const identity = {
    adapter: stage.id,
    ...(stage.model === undefined ? {} : { model: stage.model }),
  };

  const candidates = buildCandidates(plan, text);
  // Two preconditions the stage cannot supply, each reported as the fact it is rather
  // than as a zero. `candidates` stays the measured size of the candidate set either
  // way — the planner really did propose that many — and `skipped` says why nothing was
  // asked, so a receipt never carries a count nobody took.
  if (candidates.length === 0) {
    return {
      plan,
      attribution: { ...identity, candidates: 0, kept: 0, skipped: 'no-candidates' },
    };
  }
  if (query.trim() === '') {
    return {
      plan,
      attribution: {
        ...identity,
        candidates: candidates.length,
        kept: 0,
        skipped: 'no-query',
      },
    };
  }

  let ranked: readonly RerankedCandidate[];
  try {
    ranked = await stage.rerank(candidates, query);
  } catch (cause) {
    throw new RerankStageError(
      stage.id,
      `failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const spared = sparedIndices(stage.id, candidates, ranked);

  return {
    plan: {
      ...plan,
      elisions: plan.elisions.filter((_elision, index) => !spared.has(index)),
    },
    attribution: { ...identity, candidates: candidates.length, kept: spared.size },
  };
}

/**
 * One candidate per proposed elision, in plan order. The id is the elision's index as a
 * string — an opaque token to the stage, and the only thing the answer is read back
 * through, so a stage that reorders or drops entries costs nothing.
 */
function buildCandidates(plan: ElisionPlan, text: string): readonly RerankCandidate[] {
  const bytes = Buffer.from(text, 'utf8');
  return plan.elisions.map((elision, index) => ({
    id: String(index),
    text: bytes.subarray(elision.range.start, elision.range.end).toString('utf8'),
  }));
}

/**
 * The indices the stage asked to spare — **every candidate it returned**, because the
 * returned list is a selection, not a ranking of everything (see
 * {@link RerankStage.rerank}). The stage owns its own cut-off: Voyage's `top_k`, a
 * consumer's own slice. smelt applies no ceiling on top, because a K smelt invented
 * would silently decide how much of the caller's context survives — Decision 4's ruling
 * wearing a different hat.
 *
 * The consequence a stage author must know, and which the doc comment on `rerank` states
 * in so many words: returning *all* the candidates spares all of them, so the run emits
 * its input unchanged and exits 0. That is the one implementation mistake here that
 * fails silently, which is why it is written down in three places rather than one.
 */
function sparedIndices(
  stageId: string,
  candidates: readonly RerankCandidate[],
  ranked: readonly RerankedCandidate[],
): ReadonlySet<number> {
  const known = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const spared = new Set<number>();
  for (const entry of ranked) {
    const index = known.get(entry.id);
    if (index === undefined) {
      throw new RerankStageError(
        stageId,
        `returned the candidate id ${JSON.stringify(entry.id)}, which it was never sent. ` +
          `smelt sent ${String(candidates.length)} candidates, ids "0" to ` +
          `"${String(candidates.length - 1)}".`,
      );
    }
    if (spared.has(index)) {
      throw new RerankStageError(
        stageId,
        `returned the candidate id ${JSON.stringify(entry.id)} twice. One candidate ranks ` +
          `once; a duplicate makes "how many were kept" a number nobody can read.`,
      );
    }
    spared.add(index);
  }
  return spared;
}
