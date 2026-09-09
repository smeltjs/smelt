import { applyPlan, markerForLanguage, markerPricing, reconstruct } from './apply.ts';
import type { ApplyOptions, MarkerBuilder } from './apply.ts';
import { detectLanguage } from './detect.ts';
import { SmeltError } from './errors.ts';
import type { DiffPlannerOptions } from './plan/diff.ts';
import type { JsonPlannerOptions } from './plan/json.ts';
import type { LexicalPlannerOptions } from './plan/lexical.ts';
import { DEFAULT_STRATEGY, PLANNERS } from './plan/planners.ts';
import type { Strategy } from './plan/planners.ts';
import type { StructuralPlannerOptions } from './plan/structural.ts';
import { applyRerank } from './rerank/protect.ts';
import { createRetrieveTool } from './retrieve.ts';
import { MemoryElisionStore } from './store.ts';
import type {
  DetectedLanguage,
  ElisionStore,
  Measure,
  PlanInput,
  Planner,
  RerankStage,
  RetrieveStats,
  RetrieveTool,
  SmeltResult,
} from './types.ts';

/**
 * `createSmelter()` and the three types it is spelled in.
 *
 * It lives here rather than in `index.ts` so that nothing under `src/` has to import
 * the package barrel to build a smelter. `cli/subcommands/smelt.ts` does exactly that,
 * and while `index.ts` re-exports the CLI, a barrel that imports the CLI which imports
 * the barrel is a cycle whose only symptom is a registry that evaluates to `undefined`
 * in whichever module the loader happens to enter first. `index.ts` re-exports every
 * name below, so the published surface is unchanged.
 */

export interface SmelterConfig {
  /** Where elided bytes live. Defaults to a fresh {@link MemoryElisionStore}. */
  readonly store?: ElisionStore;
  /** Used when a `smelt()` call omits `budgetBytes`. No global default is assumed. */
  readonly defaultBudgetBytes?: number;
  /**
   * A constructed planner instance. Wins over `strategy`: the registry is a
   * convenience for the shipped planners, and an instance you built yourself is
   * always more specific than a name.
   */
  readonly planner?: Planner;
  readonly strategy?: Strategy;
  readonly marker?: MarkerBuilder;
  /**
   * Your own counter, so results carry a number in your unit as well as in bytes.
   * The budget stays in bytes — see {@link Measure} and `docs/ARCHITECTURE.md` § "Decision 1".
   */
  readonly measure?: Measure;
  /**
   * A relevance reranker of your own, or one loaded from a `rerank` block in
   * `smelt.config.json` (`loadRerankStage` in `rerank/load.ts`). Absent by default and
   * absent on every run that did not ask for one: this is the config opt-in ADR-0004
   * describes, never a default.
   *
   * It is asked which of the planner's proposed elisions to spare, and can only spare —
   * see `rerank/protect.ts`. Supplying one means your process makes the stage's outbound
   * call; `result.rerank` reports which stage ran and what it did.
   */
  readonly rerank?: RerankStage;
  readonly lexical?: LexicalPlannerOptions;
  readonly structural?: StructuralPlannerOptions;
  readonly json?: JsonPlannerOptions;
  readonly diff?: DiffPlannerOptions;
}

/** Options for one `smelt()` call. `budgetBytes` may come from the smelter instead. */
export interface SmeltCallOptions {
  readonly budgetBytes?: number;
  readonly path?: string;
  readonly language?: DetectedLanguage;
  readonly focus?: readonly string[];
}

/**
 * One smelter, one store, one set of counters. The store is the reason this is an
 * object rather than a free function: elisions are only reversible for as long as
 * something holds them, so the thing that cuts and the thing that remembers have the
 * same lifetime by construction.
 */
export interface Smelter {
  /** Shrink one blob of text. Never mutates its input. */
  smelt(text: string, options?: SmeltCallOptions): Promise<SmeltResult>;
  /**
   * The exact original text of a previous result. Uncounted.
   * @throws {UnknownHashError} @throws {EvictedHashError} @throws {StoreCorruptionError}
   */
  reconstruct(result: SmeltResult): string;
  /**
   * One elided run, counted as a retrieval.
   * @throws {UnknownHashError} @throws {EvictedHashError} @throws {StoreCorruptionError}
   */
  retrieve(hash: string): string;
  /** The tool to expose to your model. See {@link RetrieveTool}. */
  readonly tool: RetrieveTool;
  /** Live counters, including the expansion rate. See {@link RetrieveStats}. */
  stats(): RetrieveStats;
  /** The underlying store, for consumers that persist or inspect it. */
  readonly store: ElisionStore;
}

/**
 * Build a smelter.
 *
 * ```ts
 * const smelter = createSmelter();
 * const result = await smelter.smelt(toolOutput, {
 *   path: 'src/server.ts',
 *   budgetBytes: 4_000,
 *   focus: ['handleRequest'],
 * });
 * // result.text goes to the model; smelter.tool lets it ask for the rest back.
 * // smelter.stats().expansionRate tells you whether you cut too much.
 * ```
 */
export function createSmelter(config: SmelterConfig = {}): Smelter {
  const store = config.store ?? new MemoryElisionStore();
  // A constructed instance wins over a strategy name; the registry serves the names.
  const planner: Planner = config.planner ?? PLANNERS[config.strategy ?? DEFAULT_STRATEGY](config);
  const applyOptions: ApplyOptions = {
    ...(config.marker === undefined ? {} : { marker: config.marker }),
    ...(config.measure === undefined ? {} : { measure: config.measure }),
  };

  return {
    store,
    tool: createRetrieveTool(store),
    stats: () => store.stats(),
    retrieve: (hash) => store.retrieve(hash),
    reconstruct: (result) => reconstruct(result, store),
    async smelt(text, options = {}) {
      const budgetBytes = options.budgetBytes ?? config.defaultBudgetBytes;
      if (budgetBytes === undefined) {
        throw new SmeltError(
          'smelt: no budget. Pass `budgetBytes` to smelt() or `defaultBudgetBytes` to ' +
            'createSmelter(). There is no built-in default, because a budget smelt ' +
            'invented would silently decide how much of your context to throw away.',
        );
      }
      const language = options.language ?? detectLanguage(options.path);
      const input: PlanInput = {
        text,
        language,
        budgetBytes,
        // The MarkerPricing seam, constructed centrally — here, and nowhere else in
        // the shipped pipeline — from the exact builder the applyPlan call below will
        // use: a caller-supplied `config.marker` prices with its own rendering (a
        // longer custom marker makes small cuts unprofitable, and the planner must
        // see that), otherwise the language's leader-wrapped default.
        pricing: markerPricing(language, config.marker),
        ...(options.focus === undefined ? {} : { focus: options.focus }),
        // The ledger, the same way: read off the store this smelter cuts into, here and
        // nowhere else, when the store keeps one. Opt-in data for a planner that wants
        // the feedback loop; the shipped planners leave it unread (Decision 4).
        ...(store.ledger === undefined ? {} : { ruleHistory: store.ledger() }),
      };
      const planned = await planner.plan(input);
      // The rerank slot, and the only place it exists: between the decision and the
      // cut. A configured stage is asked which of `planned.elisions` the task actually
      // needs and those are spared, best first and only as far as `budgetBytes` reaches
      // — it can never add one, and it can never spend past the ceiling the caller
      // typed (`rerank/protect.ts` carries the reasoning). The budget and the pricing
      // cross the seam from here because this is where they were resolved: the slot
      // prices a spared marker's disappearance with the exact seam the plan was made
      // with, so the two cannot disagree about what a marker costs. With no stage
      // configured nothing is called, nothing is awaited, and `result.rerank` is absent
      // rather than an invented "none".
      const reranked =
        config.rerank === undefined
          ? undefined
          : await applyRerank({
              stage: config.rerank,
              plan: planned,
              text,
              query: (options.focus ?? []).join(' '),
              budgetBytes,
              pricing: input.pricing,
            });
      const plan = reranked?.plan ?? planned;
      // The marker follows the *result's* language: it lands behind the language's
      // line-comment leader (see MARKER_LINE_COMMENT_LEADERS), because a bare marker
      // line breaks the survivor's syntax in every grammar tested. A caller-supplied
      // marker builder always wins.
      const marker = config.marker ?? markerForLanguage(plan.language);
      const result = applyPlan(text, plan, store, { ...applyOptions, marker });
      return reranked === undefined ? result : { ...result, rerank: reranked.attribution };
    },
  };
}
