import { NotImplementedError } from './errors.ts';
import type { RerankCandidate, RerankStage, RerankedCandidate } from './types.ts';

/**
 * The reranker that ships with smelt: one that refuses.
 *
 * It exists so that "reranking is a seam, not a feature" is enforced rather than
 * promised. Wire this in and you get an exception naming the interface you were
 * supposed to implement. There is no default hosted reranker, no bundled key handling,
 * and no `SMELT_RERANK_API_KEY` — the first of those to appear breaks Law 1 for every
 * consumer at once, including the ones who never read the changelog.
 */
export const unconfiguredRerankStage: RerankStage = {
  id: 'rerank/unconfigured',
  rerank(
    _candidates: readonly RerankCandidate[],
    _query: string,
  ): Promise<readonly RerankedCandidate[]> {
    throw new NotImplementedError(
      'reranking',
      'docs/ARCHITECTURE.md § "Explicitly out of scope" — implement `RerankStage` in your own ' +
        'code, with your own key, so the network call is visible in your source',
    );
  },
};
