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

/* ------------------------------------------------------------------------------------
 * The budget law — stated once, here, for every door and both library entry points
 * ---------------------------------------------------------------------------------- */

/** How one front door spells the budget it is refusing, and what it points at next. */
export interface BudgetNaming {
  /** The knob, as this surface spells it: `--budget`, `"budgetBytes"`. */
  readonly knob: string;
  /**
   * What a budget smelt invented would silently decide — the back half of the
   * no-default sentence. `'your context to throw away'` for a blob run, `'the map to
   * leave out'` for a tree.
   */
  readonly stake: string;
  /**
   * Anything this surface adds after the law: where else the value can come from, and
   * an example. Appended after a single space. The CLI names `defaultBudgetBytes` and
   * `smelt init` here; a tool whose schema already says `required` adds nothing.
   */
  readonly advice?: string;
}

/**
 * Law: **a budget is required, and there is no default.**
 *
 * The reasoning is the whole point of the sentence, so it is stated once here rather
 * than paraphrased per surface: a budget smelt invented would silently decide how much
 * of the caller's context to throw away, which is a number nobody measured making a
 * decision nobody made.
 */
export function budgetRequired(naming: BudgetNaming): string {
  return (
    `${naming.knob} is required, in UTF-8 bytes. There is no default, because a budget ` +
    `smelt invented would silently decide how much of ${naming.stake}.` +
    (naming.advice === undefined ? '' : ` ${naming.advice}`)
  );
}

/** The two ways a budget that *was* given can still be wrong. See {@link budgetFault}. */
export type BudgetFault = 'not-an-integer' | 'not-positive';

/**
 * Law: **a budget is a whole number of UTF-8 bytes greater than zero.**
 *
 * The numeric half only. Getting a candidate *number* out of a surface is that
 * surface's own lexing and stays there: argv carries strings (`--budget 4kb` is a
 * malformed number, and `-1` never reaches here because a leading `-` is not a
 * budget at all), while a JSON tool argument carries whatever type the model sent.
 * Both then ask this function the same question about the same rule.
 */
export function budgetFault(value: number): BudgetFault | undefined {
  if (!Number.isInteger(value)) return 'not-an-integer';
  if (value <= 0) return 'not-positive';
  return undefined;
}

/**
 * The sentence for a {@link BudgetFault}, naming the value it rejected.
 *
 * `got` is rendered with `JSON.stringify`, which is what both front doors already
 * printed: a CLI passes the raw argv word and gets it back quoted (`"4kb"`), a tool
 * passes the raw JSON value and gets numbers bare (`0`) and strings quoted. One
 * renderer, because a value echoed back in a different shape than it was written is a
 * value the author has to translate before they can see their own typo.
 */
export function budgetMalformed(fault: BudgetFault, knob: string, got: unknown): string {
  return fault === 'not-an-integer'
    ? `${knob} must be a whole number of bytes, got ${JSON.stringify(got)}.`
    : `${knob} must be greater than zero, got ${JSON.stringify(got)}.`;
}

/** A budget the law accepted, or the sentence for the one it did not. */
export type LawfulBudget =
  | { readonly ok: true; readonly budgetBytes: number }
  | { readonly ok: false; readonly refusal: string };

/**
 * The law, applied: a budget that is absent, not a whole number, or not positive comes
 * back as its refusal; a lawful one comes back as a number the caller can use. Data,
 * not a thrown error, for the same reason the ops seam's laws return a `Ruling`: each
 * entry point wraps the refusal in its own error type. `createSmelter` and
 * `buildRepoMap` refuse in the seam's own words rather than their own; the front doors
 * keep their lexing ("is it a number at all") and then ask the same three functions.
 */
export function lawfulBudget(budgetBytes: number | undefined, naming: BudgetNaming): LawfulBudget {
  if (budgetBytes === undefined) return { ok: false, refusal: budgetRequired(naming) };
  const fault = budgetFault(budgetBytes);
  if (fault !== undefined) {
    return { ok: false, refusal: budgetMalformed(fault, naming.knob, budgetBytes) };
  }
  return { ok: true, budgetBytes };
}

/**
 * The ladder's selection rule: the first attempt whose predicted output fits the budget,
 * else the tightest — returned over budget, as it came back, because a plan that fits
 * nowhere is still a plan and overrunning is reported, never hidden. The lexical and
 * diff planners each wrote these three lines; the structural planner's budget rung is
 * a different shape (an incremental escalation over refused runs) and keeps its own.
 */
export function chooseUnderBudget<T extends readonly PlannedElision[]>(
  inputBytes: number,
  attempts: readonly T[],
  budgetBytes: number,
  pricing: MarkerPricing,
): T {
  return (
    attempts.find((elisions) => predictOutputBytes(inputBytes, elisions, pricing) <= budgetBytes) ??
    attempts[attempts.length - 1]!
  );
}
