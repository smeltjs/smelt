import type { ApplyOptions, MarkerBuilder, MarkerInfo } from './apply.ts';

/**
 * The public surface: a barrel over the modules that hold the reasoning.
 *
 * `createSmelter()` itself lives in `./smelter.ts` so that nothing inside `src/` has
 * to import this file to build a smelter — the CLI's default verb does exactly that,
 * and a barrel that imports the CLI which imports the barrel is a cycle whose only
 * symptom is a registry evaluating to `undefined` in whichever module the loader
 * entered first. Every name is re-exported here, so consumers see no difference.
 */

export type { ApplyOptions, MarkerBuilder, MarkerInfo };
export {
  applyPlan,
  defaultMarker,
  MARKER_FORMAT_VERSION,
  markerPricing,
  reconstruct,
} from './apply.ts';
export { detectLanguage, SUPPORTED_LANGUAGES } from './detect.ts';
export * from './errors.ts';
export { contentHash, HASH_LENGTH } from './hash.ts';
export {
  ALLOWED_NODE_BUILTINS,
  ALLOWED_PACKAGES,
  ALLOWED_URL_SCHEMES,
  assertLocalResource,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_NODE_MODULES,
  FORBIDDEN_PACKAGES,
  OPT_IN_RERANK_PACKAGES,
  RERANK_VOYAGE_PACKAGE,
} from './net/policy.ts';
export type { LocalResource } from './net/policy.ts';
export { clearGrammarCache, grammarPath, loadGrammar, WASM_BY_LANGUAGE } from './plan/grammar.ts';
export { AUTO_PLANNER_ID, AutoPlanner, planAuto } from './plan/auto.ts';
export type { AutoPlannerOptions } from './plan/auto.ts';
export { LEXICAL_PLANNER_ID, LexicalPlanner, planLexical } from './plan/lexical.ts';
export type { LexicalPlannerOptions } from './plan/lexical.ts';
export { DEFAULT_STRATEGY, isStrategy, PLANNERS, STRATEGIES } from './plan/planners.ts';
export type { PlannerFactoryOptions } from './plan/planners.ts';
export {
  isStructuralLanguage,
  planStructural,
  STRUCTURAL_LANGUAGES,
  STRUCTURAL_PLANNER_ID,
  StructuralPlanner,
} from './plan/structural.ts';
export type { StructuralLanguage, StructuralPlannerOptions } from './plan/structural.ts';
export {
  createRetrieveBatchTool,
  createRetrieveTool,
  RETRIEVE_BATCH_TOOL_NAME,
  RETRIEVE_TOOL_NAME,
} from './retrieve.ts';
export { loadRerankStage } from './rerank/load.ts';
export type { RerankLoad } from './rerank/load.ts';
export { applyRerank } from './rerank/protect.ts';
export type { RerankOutcome, RerankRequest } from './rerank/protect.ts';
export { unconfiguredDistillStage, unconfiguredRerankStage } from './stages.ts';
export { MemoryElisionStore } from './store.ts';
export {
  DIRECTORY_STORE_FORMAT,
  DIRECTORY_STORE_VERSION,
  DirectoryElisionStore,
  readStoreSize,
} from './store-dir.ts';
export type {
  DirectoryElisionStoreOptions,
  PrunedBlob,
  PruneOptions,
  PruneReport,
  StoreSurvey,
} from './store-dir.ts';
export { CUTOFF_HELP, readCutoff } from './store-cutoff.ts';
export type { CutoffReading } from './store-cutoff.ts';
export * from './types.ts';
export {
  CLI_JSON_FORMAT,
  CLI_NAME,
  cliUsage,
  EXIT,
  formatReport,
  parseSmeltArgs,
  runCli,
} from './cli/run.ts';
export type { AnswerStream, CliIo, CliJsonEnvelope, SmeltInvocation } from './cli/run.ts';
export {
  ANTHROPIC_PROMPT_CACHE_FACTS,
  CACHE_BREAKER_RULES,
  detectCacheBreakers,
  findPrefixDivergence,
} from './cache/prefix.ts';
export type {
  CacheWarning,
  PrefixDivergence,
  PromptStructure,
  PromptTool,
} from './cache/prefix.ts';
export { MARKER_LINE_COMMENT_LEADERS, markerForLanguage } from './apply.ts';
export {
  buildRepoMap,
  DEFAULT_REPO_IGNORE,
  REPO_MAP_CACHE_CORRUPT_RULE,
  REPO_MAP_ID,
  REPO_MAP_PATH_ONLY_RULE,
  REPO_MAP_RANKED_RULE,
  REPO_MAP_UNREFERENCED_RULE,
} from './repomap/map.ts';
export type {
  RepoMap,
  RepoMapCacheCounts,
  RepoMapEntry,
  RepoMapOptions,
  RepoMapPathEntry,
  RepoMapReason,
  RepoMapWarning,
} from './repomap/map.ts';
export { PAGERANK_DAMPING, PAGERANK_ITERATIONS, rankDefinitions } from './repomap/rank.ts';
export type { FileTagsEntry, RankedDefinition } from './repomap/rank.ts';
export { extractTags } from './repomap/tags.ts';
export type { DefinitionTag, FileTags, ReferenceTag } from './repomap/tags.ts';
export { TAGS_CACHE_FORMAT, TAGS_CACHE_VERSION, tagsCacheKey } from './repomap/cache.ts';
export { nodeFsReader } from './repomap/reader.ts';
export type { DirEntry, FileStat, RepoReader } from './repomap/reader.ts';
export {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  configuredStore,
  findConfigFile,
  loadNearestConfig,
  parseConfig,
  renderConfig,
  resolveStorePath,
  VOYAGE_DEFAULT_KEY_ENV,
  VOYAGE_DEFAULT_MODEL,
} from './config.ts';
export type {
  ConfiguredStore,
  LoadedConfig,
  SmeltConfig,
  SmeltConfigRerank,
  SmeltConfigRetention,
  SmeltConfigStore,
} from './config.ts';
export {
  MEASURE_STUB_FILE,
  measureStubSource,
  RERANK_STUB_FILE,
  rerankStubSource,
  runInit,
} from './cli/init.ts';
export type { InitIo } from './cli/init.ts';
export { runSetup } from './cli/setup.ts';
export type {
  SetupCheck,
  SetupFileAction,
  SetupIo,
  SetupOptions,
  SetupReceipt,
} from './cli/setup.ts';
export { runDoctor } from './cli/doctor.ts';
export type {
  DoctorBlock,
  DoctorConfig,
  DoctorHookEntry,
  DoctorHookFile,
  DoctorIo,
  DoctorMcp,
  DoctorOptions,
  DoctorReceipt,
  DoctorRerank,
} from './cli/doctor.ts';
export { retrieveStats, ruleLedger } from './stats.ts';
export type { RawRetrieveCounters } from './stats.ts';

/**
 * The SetupRecipe: the one true way to put smelt on a machine, as data. Public for the
 * same reason the harness views are — something outside this package renders it (the
 * site's fact generator), and the docs and skill are pinned to it rather than retyping
 * it. See `src/setup/recipe.ts`.
 */
export { SETUP_RECIPE, SETUP_STEPS } from './setup/recipe.ts';
export type { SetupRecipe, SetupStep } from './setup/recipe.ts';
export {
  LANGUAGE_PROFILES,
  profileFor,
  profileForPath,
  structuralLanguages,
} from './lang/registry.ts';
export type { LanguageProfile, LanguageStructure, RepoMapFacts } from './lang/profile.ts';
/**
 * The harness registry's rendered views. Public for the same reason the ops seam is:
 * something outside this package renders them — the site's `facts.json` generator —
 * and the alternative is a second copy of the tier table typed into a React component,
 * which is exactly the drift `harnessesByTier()` exists to end.
 */
export { harnessesByTier, harnessNames, HARNESSES, HARNESS_IDS } from './harness/registry.ts';
export type { HarnessTierGroup } from './harness/registry.ts';
export { harnessLabel, HARNESS_TIERS, TIER_HONESTY } from './harness/profile.ts';
export type { HarnessId, HarnessTier } from './harness/profile.ts';
export { resolveRun } from './cli/subcommands/smelt.ts';
export type { ResolvedRun } from './cli/subcommands/smelt.ts';
export { REPO_MAP_FOCUS_RULE } from './repomap/map.ts';
export { CLI_MAP_JSON_FORMAT, formatMapReport, resolveMapRun } from './cli/run.ts';
export type { CliInvocation, CliMapJsonEnvelope, MapInvocation } from './cli/run.ts';
export type { MapReportInput } from './cli/report.ts';
export type { ResolvedMapRun } from './cli/subcommands/map.ts';

/**
 * The operations seam — the four verbs and the laws their inputs must satisfy, below
 * every front door. `@smeltjs/mcp` consumes these as an ordinary dependency, so the
 * `smelt` CLI and the MCP tools run the same middle instead of two copies of it. See
 * `src/ops/index.ts` for what belongs here and what stays in an adapter.
 */
export {
  budgetFault,
  budgetMalformed,
  budgetRequired,
  mapTree,
  openStore,
  readBlob,
  readCounters,
  readLedger,
  readTree,
  resolveStrategy,
  retrieveBytes,
  retrieveMany,
  smeltBlob,
} from './ops/index.ts';
export type {
  BudgetFault,
  BudgetNaming,
  FocusSource,
  MapTreeOp,
  ReadCountersOp,
  ReadLedgerOp,
  ResolvedFocus,
  ResolvedStrategy,
  RetrieveBytesOp,
  RetrieveManyOp,
  Ruling,
  SmeltBlobOp,
  SmeltBlobOutcome,
  StrategySource,
  TreeNaming,
} from './ops/index.ts';

/**
 * Which planner a smelter uses, named by string. The names, their factories, and this
 * type all come from the one {@link PLANNERS} registry in `src/plan/planners.ts`, so
 * the CLI's validation and help text cannot drift from what `createSmelter` builds.
 */
export type { Strategy } from './plan/planners.ts';

export { createSmelter } from './smelter.ts';
export type { Smelter, SmelterConfig, SmeltCallOptions } from './smelter.ts';
