import type { Planner } from '../types.ts';

import { AutoPlanner } from './auto.ts';
import { DiffPlanner } from './diff.ts';
import type { DiffPlannerOptions } from './diff.ts';
import { JsonPlanner } from './json.ts';
import type { JsonPlannerOptions } from './json.ts';
import { LexicalPlanner } from './lexical.ts';
import type { LexicalPlannerOptions } from './lexical.ts';
import { StructuralPlanner } from './structural.ts';
import type { StructuralPlannerOptions } from './structural.ts';

/**
 * The option bags a strategy factory may draw from — the same fields
 * `SmelterConfig` carries, so the config object itself can be handed to a factory.
 * `auto` draws from both, because it may run either planner.
 */
export interface PlannerFactoryOptions {
  readonly lexical?: LexicalPlannerOptions;
  readonly structural?: StructuralPlannerOptions;
  readonly json?: JsonPlannerOptions;
  readonly diff?: DiffPlannerOptions;
}

/**
 * The one registry of planner strategies — string in, constructed {@link Planner} out.
 *
 * This object is the single place the strategy names live. `createSmelter` builds from
 * it, `--strategy` and `smelt.config.json` validation accept exactly its keys, the
 * `--help` text and the `init` wizard render its keys, and the `smelt_file` tool's
 * JSON Schema enumerates them — so a strategy cannot exist in one of those faces and
 * be missing from another. Before this registry the pair was restated in three places,
 * which is how help text rots.
 *
 * `'structural'` parses every language named in {@link STRUCTURAL_LANGUAGES} with a
 * bundled grammar and throws {@link GrammarUnavailableError} for anything else — never
 * a silent lexical fallback. See {@link StructuralPlanner}.
 *
 * `'json'` and `'diff'` plan by content kind — members and elements, files and hunks —
 * and refuse anything that is not that kind with {@link ContentKindError}, for the
 * structural planner's reason. See {@link JsonPlanner} and {@link DiffPlanner}.
 *
 * `'auto'` picks among them — content kind first, then language — and **labels what
 * ran**: its plans come back as `json/v1`, `diff/v1`, `lexical/v1` or `structural/v1`,
 * never as `auto`. It is a selector, not a fallback — an explicit `'structural'` on an
 * unsupported language still refuses, because a caller who named the planner asked for
 * its guarantees. See {@link AutoPlanner}, whose doc comment carries the reasoning.
 *
 * Key order is the order every rendered list uses, so append rather than reorder.
 */
export const PLANNERS = {
  lexical: (options: PlannerFactoryOptions): Planner => new LexicalPlanner(options.lexical ?? {}),
  structural: (options: PlannerFactoryOptions): Planner =>
    new StructuralPlanner(options.structural ?? {}),
  auto: (options: PlannerFactoryOptions): Planner => new AutoPlanner(options),
  json: (options: PlannerFactoryOptions): Planner => new JsonPlanner(options.json ?? {}),
  diff: (options: PlannerFactoryOptions): Planner => new DiffPlanner(options.diff ?? {}),
} as const satisfies Record<string, (options: PlannerFactoryOptions) => Planner>;

/** Which planner a smelter uses, named by string. Exactly the keys of {@link PLANNERS}. */
export type Strategy = keyof typeof PLANNERS;

/** The registry's keys, in declaration order, for help text and error messages. */
export const STRATEGIES = Object.keys(PLANNERS) as readonly Strategy[];

/**
 * The strategy a caller who names none gets — the registry's own default, beside the
 * names it defaults among.
 *
 * Every `?? 'lexical'` in this repository reads this constant instead: `createSmelter`,
 * the `smelt` verb's merge, the `init` wizard's starting choice, and the MCP server's
 * `smelt_file`. The names were already derived from {@link PLANNERS} while the default
 * stayed hand-typed in four places across two packages — so the one fact every caller
 * needs was the one the registry did not carry, and a changed default would have moved
 * on some faces and not others.
 *
 * `'lexical'` is the default because it works on any text: `'structural'` refuses a
 * language it has no grammar for rather than approximating (see {@link StructuralPlanner}),
 * which is right when a caller asked for it and wrong as the answer to "no preference".
 *
 * `'auto'` refuses nothing either, and is the better answer for a caller smelting a
 * mixed stream — but it stays **opt-in**. Promoting it would change which planner runs,
 * and therefore what `result.planner` says, for every existing caller who never named a
 * strategy: a behaviour change delivered to people who asked for nothing. A caller who
 * wants it says so, in a flag, a config, or a tool argument.
 */
export const DEFAULT_STRATEGY: Strategy = 'lexical';

/** The one membership test `--strategy` and config validation both use. */
export function isStrategy(value: string): value is Strategy {
  return Object.hasOwn(PLANNERS, value);
}
