import type { ElisionPlan, PlanInput, Planner } from '../types.ts';

import { planDiff } from './diff.ts';
import type { DiffPlannerOptions } from './diff.ts';
import { planJson } from './json.ts';
import type { JsonPlannerOptions } from './json.ts';
import { probeKind } from './kind.ts';
import { planLexical } from './lexical.ts';
import type { LexicalPlannerOptions } from './lexical.ts';
import { isStructuralLanguage, planStructural } from './structural.ts';
import type { StructuralPlannerOptions } from './structural.ts';

/**
 * The id of the *selector*, never of a plan.
 *
 * Every plan `auto` returns carries the id of the planner that actually ran —
 * `lexical/v1` or `structural/v1` — because a caller reading `result.planner` is
 * asking what happened to their bytes, not which name they typed. This constant
 * exists so `PLANNERS.auto({}).id` says something true about the object it is on, and
 * `test/guards/auto-strategy.test.ts` pins that it never reaches an `ElisionPlan`.
 */
export const AUTO_PLANNER_ID = 'auto/v1';

export interface AutoPlannerOptions {
  /** Passed through when auto picks the lexical planner. */
  readonly lexical?: LexicalPlannerOptions;
  /** Passed through when auto picks the structural planner. */
  readonly structural?: StructuralPlannerOptions;
  /** Passed through when the content kind is JSON. */
  readonly json?: JsonPlannerOptions;
  /** Passed through when the content kind is a diff. */
  readonly diff?: DiffPlannerOptions;
}

/**
 * The strategy that picks a strategy: **kind first, then language — json for a JSON
 * document, diff for a unified diff, structural where a grammar is bundled, lexical
 * everywhere else — and the result says which one ran.**
 *
 * It exists because the choice it makes is one a caller cannot make once. A consumer
 * smelting whatever a tool handed it — a `.ts` file this call, a build log the next —
 * has to name a strategy per call or accept the wrong one every other call, and the
 * two wrong answers are not symmetric: `lexical` on TypeScript is a working planner
 * doing a weak job, while `structural` on a build log is a `GrammarUnavailableError`.
 * So the honest default for a *mixed* stream was neither name, and callers picked one
 * anyway.
 *
 * **This is a selector, not a fallback, and the distinction is the whole design.**
 *
 *   - It decides on a *fact*: whether the language carries a bundled grammar
 *     ({@link STRUCTURAL_LANGUAGES}). That is knowable before a byte is parsed, so
 *     the decision is made up front and stated in the result's `planner` field.
 *   - It never decides on an *accident*. A grammar that fails to load on a language
 *     smelt claims to support is a broken install, and `GrammarUnavailableError`
 *     travels straight out of here exactly as it does under `strategy: 'structural'`.
 *     Catching it and answering with line windows would turn a loud environment fault
 *     into quietly worse output — the failure mode Law 2's no-silent-downgrade
 *     reasoning is about, wearing a friendlier name.
 *   - It changes nothing about an explicit `strategy: 'structural'`. That still
 *     refuses an unsupported language, because a caller who named the planner asked
 *     for *its* guarantees, and a refusal is the only answer that does not fabricate
 *     them. `auto` is a different request — "pick for me" — and answers it in the
 *     open.
 *
 * `DEFAULT_STRATEGY` stays `lexical`: auto is opt-in, and a default that changed
 * which planner ran would change what existing callers' results are labelled without
 * anyone asking for it.
 */
export class AutoPlanner implements Planner {
  readonly id = AUTO_PLANNER_ID;
  readonly #options: AutoPlannerOptions;

  constructor(options: AutoPlannerOptions = {}) {
    this.#options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return planAuto(input, this.#options);
  }
}

/**
 * The selector as a function, exported like {@link planLexical} and
 * {@link planStructural} so it can be tested and reused directly. Deterministic: the
 * choice is a lookup in {@link STRUCTURAL_LANGUAGES}, and each planner it delegates to
 * is deterministic in turn.
 *
 * @throws {GrammarUnavailableError} when the language *is* one smelt claims to parse
 *   and its grammar cannot be loaded. Never caught here — see {@link AutoPlanner}.
 */
export function planAuto(input: PlanInput, options: AutoPlannerOptions = {}): Promise<ElisionPlan> {
  // The content kind is the first fact — a parse, a header shape (`plan/kind.ts`) —
  // because a diff is path-less and a JSON tool result detects `unknown`, and both
  // used to fall to line windows. Only what the probe *proved* is routed by kind.
  const kind = probeKind(input.text);
  if (kind === 'json') return Promise.resolve(planJson(input, options.json ?? {}));
  if (kind === 'diff') return Promise.resolve(planDiff(input, options.diff ?? {}));
  return isStructuralLanguage(input.language)
    ? planStructural(input, options.structural ?? {})
    : Promise.resolve(planLexical(input, options.lexical ?? {}));
}
