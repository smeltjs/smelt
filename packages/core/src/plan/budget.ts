import { MissingMarkerPricingError } from '../errors.ts';
import type { MarkerPricing, PlanInput, PlannedElision } from '../types.ts';

/**
 * What a plan will cost once its markers land — the arithmetic both planners do.
 *
 * Two planners now read `budgetBytes`, and both answer the same question with it:
 * *given these elisions, how big is the output?* The lexical planner asks it to pick a
 * ladder rung; the structural planner asks it to decide whether its budget rung is
 * needed at all. Written twice it would be two answers to one question, which is how
 * one planner ends up believing a marker costs something the other does not — the
 * exact fork the {@link MarkerPricing} seam exists to prevent, one level up.
 *
 * Nothing here estimates. Every byte comes from `pricing.costBytes`, the seam
 * `apply.ts` builds from the exact builder `applyPlan` will use.
 */

/** The exact UTF-8 cost of the marker this elision would earn. Asked, not guessed. */
export function markerBytes(elision: PlannedElision, pricing: MarkerPricing): number {
  return pricing.costBytes(elision.reason, elision.range.end - elision.range.start);
}

/** What one elision saves: the bytes it removes, less the marker that replaces them. */
export function savingBytes(elision: PlannedElision, pricing: MarkerPricing): number {
  return elision.range.end - elision.range.start - markerBytes(elision, pricing);
}

/** The output size these elisions predict, markers included. */
export function predictOutputBytes(
  inputBytes: number,
  elisions: readonly PlannedElision[],
  pricing: MarkerPricing,
): number {
  return elisions.reduce((bytes, elision) => bytes - savingBytes(elision, pricing), inputBytes);
}

/**
 * The runtime backstop for `PlanInput.pricing`, which TypeScript already requires: a
 * JS caller who omits it gets {@link MissingMarkerPricingError} naming the planner,
 * never a guessed cost. One function, since review IV (REP-53) — every shipped planner
 * used to carry its own copy of these three lines.
 */
export function requirePricing(input: PlanInput, plannerId: string): MarkerPricing {
  const pricing: MarkerPricing | undefined = input.pricing;
  if (pricing === undefined) throw new MissingMarkerPricingError(plannerId);
  return pricing;
}
