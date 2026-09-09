import { RerankStageError } from '../errors.ts';
import { predictOutputBytes, savingBytes } from '../plan/budget.ts';
import type {
  ElisionPlan,
  MarkerPricing,
  PlannedElision,
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
 * and a bad answer from it would be undetectable. A bad answer here costs bytes.
 *
 * **And it preserves only as far as the budget reaches.** This is the module's second
 * job and the reason it takes `budgetBytes` and a {@link MarkerPricing} across the seam
 * at all: the stage returns a *ranking*, and this slot walks it best-first, sparing
 * while the predicted output still fits, and stopping at the first region that would
 * not. The prediction is `plan/budget.ts`'s — the same arithmetic the lexical planner
 * picks a ladder rung with and the structural planner runs its own budget rung on — so
 * the slot and the planners cannot come to different conclusions about what a marker
 * costs.
 *
 * The doctrine in one line: **a K smelt invents is refused; a budget the user typed is
 * honoured.** They are not the same kind of number. `topK` is a cap the caller wrote in
 * their own config and it stays a cap — smelt never fills it, never raises it, and adds
 * no ceiling of its own on top. The budget is a *ceiling the caller also wrote*, on the
 * one number this whole library exists to control, and a stage's opinion does not
 * outrank it.
 *
 * **If the best region alone breaks the budget, nothing is spared.** Not "spare it
 * anyway and report the overrun": a plan that fits beats a plan that does not, the stage
 * cannot cut, so the only lever left is not sparing — and it is pulled all the way. What
 * happened is a measurement either way. {@link RerankAttribution.stopped} names which of
 * the three walls the walk hit and `sparedBytes` says what the spares put back, so a
 * `topK` of 8 that yielded 3 reads as a budget decision rather than as a mystery.
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
  /**
   * The run's byte ceiling, exactly as the caller typed it — the same number the
   * planner already planned against. The slot spares up to it and not past it.
   */
  readonly budgetBytes: number;
  /**
   * The pricing seam the plan was made with, so the slot prices a spared marker's
   * disappearance the way `applyPlan` will price its arrival. Handed across the seam
   * rather than rebuilt here: a slot that built its own would be the second opinion on
   * marker cost the {@link MarkerPricing} seam exists to prevent.
   */
  readonly pricing: MarkerPricing;
}

/** The plan after the stage had its say, and the attribution every surface renders. */
export interface RerankOutcome {
  readonly plan: ElisionPlan;
  readonly attribution: RerankAttribution;
}

/**
 * Ask the stage which of the planner's proposed elisions to spare, and spare as many of
 * them as the budget affords — best first, stopping at the first one that would not fit.
 *
 * @throws {RerankStageError} for **every** way the stage can fail: it threw (a timeout,
 *   a 401, an unreachable host, an unimplemented stub), it answered with an id it was
 *   never sent, or it answered with the same id twice. A stage talks to another machine,
 *   so its failures are expected rather than exceptional — and a plain `Error` escaping
 *   here would reach a CLI that calls it an internal bug and an MCP handler that crashes
 *   past its envelope. See {@link RerankStageError}.
 */
export async function applyRerank(request: RerankRequest): Promise<RerankOutcome> {
  const { stage, plan, text, query, budgetBytes, pricing } = request;
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
  const selection = rankedSelection(stage.id, candidates, ranked);
  const walk = spareWithinBudget(plan.elisions, selection, text, budgetBytes, pricing);

  return {
    plan: {
      ...plan,
      elisions: plan.elisions.filter((_elision, index) => !walk.spared.has(index)),
    },
    attribution: {
      ...identity,
      candidates: candidates.length,
      returned: selection.length,
      kept: walk.spared.size,
      sparedBytes: walk.sparedBytes,
      stopped: walk.stopped,
    },
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
 * The stage's answer as an ORDER over plan indices — every candidate it returned, best
 * first, ties in the order smelt sent them.
 *
 * Two decisions live here.
 *
 * **smelt adds no cut-off of its own.** The returned list is a selection, not a ranking
 * of everything (see {@link RerankStage.rerank}), and the stage owns where it ends:
 * Voyage's `top_k`, a consumer's own slice, a threshold they chose. A K smelt invented
 * would silently decide how much of the caller's context survives — Decision 4's ruling
 * wearing a different hat — so there is none. What smelt does apply is the caller's own
 * *budget*, one function down: a number the caller typed, on the axis the library
 * exists to control, is not smelt inventing anything.
 *
 * **The sort is smelt's, not the stage's.** `score` is the stage's own scale and this
 * module never compares it across stages; it only orders one stage's answer with it. A
 * stage that returns its selection unsorted is common (the ids came back in request
 * order from an HTTP response) and the walk below decides what survives a tight budget,
 * so leaving the order to whatever arrived would make "which regions were kept" depend
 * on an adapter's serialisation. Ties break on the original candidate index, which is
 * plan order: two regions the stage could not separate are separated by the file.
 */
function rankedSelection(
  stageId: string,
  candidates: readonly RerankCandidate[],
  ranked: readonly RerankedCandidate[],
): readonly number[] {
  const known = new Map(candidates.map((candidate, index) => [candidate.id, index]));
  const seen = new Set<number>();
  const selection: { readonly index: number; readonly score: number }[] = [];
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
    if (seen.has(index)) {
      throw new RerankStageError(
        stageId,
        `returned the candidate id ${JSON.stringify(entry.id)} twice. One candidate ranks ` +
          `once; a duplicate makes "how many were kept" a number nobody can read.`,
      );
    }
    seen.add(index);
    selection.push({ index, score: entry.score });
  }
  return selection
    .toSorted((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.index);
}

/** What the walk did: which elisions were spared, at what cost, and where it stopped. */
interface BudgetWalk {
  readonly spared: ReadonlySet<number>;
  readonly sparedBytes: number;
  readonly stopped: NonNullable<RerankAttribution['stopped']>;
}

/**
 * Walk the stage's ranking and spare while the budget holds — the budget rung, for the
 * rerank slot.
 *
 * The loop is the same shape as the planners' rungs and for the same reason: price the
 * plan as it stands, ask what the next move costs, take it only if the answer still
 * fits. Sparing an elision hands back exactly what that elision would have saved — its
 * bytes, less the marker that will now not land — so the running total is the predicted
 * output and nothing here estimates.
 *
 * It stops at the **first** region that does not fit rather than skipping on to look for
 * a smaller one that would. Skipping would quietly re-rank the stage's answer by size:
 * the caller asked for the most relevant regions back, not the most relevant regions
 * that happen to be small, and a slot that reordered on bytes would be making a
 * relevance decision it has no standing to make. The gap between `returned` and `kept`
 * is then a fact the report can state, instead of a set nobody can reconstruct.
 */
function spareWithinBudget(
  elisions: readonly PlannedElision[],
  selection: readonly number[],
  text: string,
  budgetBytes: number,
  pricing: MarkerPricing,
): BudgetWalk {
  let predicted = predictOutputBytes(Buffer.byteLength(text, 'utf8'), elisions, pricing);
  const spared = new Set<number>();
  let sparedBytes = 0;
  for (const index of selection) {
    const back = savingBytes(elisions[index]!, pricing);
    if (predicted + back > budgetBytes) {
      return { spared, sparedBytes, stopped: 'budget' };
    }
    predicted += back;
    sparedBytes += back;
    spared.add(index);
  }
  // The walk ran to the end of the stage's answer, so the budget is not what bound this
  // run. Which of the other two walls it was, is the difference between "your cut-off
  // ended it" and "there was nothing else to ask for" — a misconfigured `topK` and an
  // input the planner barely touched look identical from a count alone.
  return {
    spared,
    sparedBytes,
    stopped: selection.length === elisions.length ? 'exhausted' : 'cap',
  };
}
