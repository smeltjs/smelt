import { describe, expect, it } from 'vitest';

import { NotImplementedError, SmeltError } from '../src/errors.ts';
import { createSmelter } from '../src/index.ts';
import { unconfiguredDistillStage, unconfiguredRerankStage } from '../src/stages.ts';

/**
 * Every unbuilt stage throws. This test exists because the tempting alternative —
 * returning `[]`, or the input unchanged, or falling back to a planner that does work —
 * is indistinguishable from a correct implementation with nothing to say. A caller
 * would ship it, and find out months later that the stage never ran.
 *
 * The structural planner used to live here; it is real now, and its refusals
 * — a language it has not mapped, a grammar that will not load — are guarded in
 * `test/guards/structural.test.ts` instead. The stage stubs in `src/stages.ts` remain
 * stubs by design.
 */
describe('stubs throw instead of returning a plausible wrong answer', () => {
  it('the rerank stage refuses, and points at the interface to implement', () => {
    expect(() => unconfiguredRerankStage.rerank([], 'query')).toThrow(/implement `RerankStage`/);
  });

  it('the distill stage refuses', () => {
    expect(() => unconfiguredDistillStage.distill('text', 10)).toThrow(NotImplementedError);
  });

  it('a smelter with no budget refuses to invent one', async () => {
    const smelter = createSmelter();
    await expect(smelter.smelt('some text')).rejects.toThrow(SmeltError);
    await expect(smelter.smelt('some text')).rejects.toThrow(/is required, in UTF-8 bytes/);
  });

  it('every stub error is a SmeltError, so callers can tell "we said no" from "it broke"', () => {
    expect(new NotImplementedError('x', 'y')).toBeInstanceOf(SmeltError);
  });
});
