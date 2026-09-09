import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { CliUsageError } from './errors.ts';
import { RERANK_VOYAGE_PACKAGE } from './net/policy.ts';
import { ENFORCEMENT_MODES } from './hooks/guard-core.ts';
import type { EnforcementMode } from './hooks/guard-core.ts';
import { isStrategy, STRATEGIES } from './plan/planners.ts';
import type { Strategy } from './plan/planners.ts';

import { CLI_NAME } from './cli/shell.ts';

/**
 * `smelt.config.json` — CLI defaults, and nothing more.
 *
 * This file exists so `smelt` can be run without retyping the same flags, and it is
 * deliberately a *CLI* concern: the programmatic API never reads it. A library that
 * reads config files off the caller's disk is a library whose behaviour depends on
 * where it was invoked from, which is exactly the class of invisible input smelt
 * refuses. `createSmelter()` takes explicit arguments; the CLI translates this file
 * into those arguments, and explicit flags always win over it.
 *
 * The schema is versioned (`"smeltConfig": 1`) for the same reason the marker and the
 * `--json` envelope are: files outlive the binaries that wrote them, and a mismatch
 * must be identifiable rather than half-understood. Parsing is strict — an unknown
 * key, a wrong type, or an unknown version is a {@link CliUsageError}, never a shrug.
 * A config the CLI silently ignored would be a budget the user *thought* they set.
 */

/** The file name looked for, from the working directory upward. */
export const CONFIG_FILE_NAME = 'smelt.config.json';

/** The schema version this build reads and writes. */
export const CONFIG_VERSION = 1;

/** Where the CLI's elision store lives between runs. */
export type SmeltConfigStore =
  | { readonly kind: 'memory' }
  | {
      readonly kind: 'directory';
      /** Resolved relative to the directory holding the config file, not the cwd. */
      readonly path: string;
    };

/**
 * The `hooks` block — settings for the harness guard (`smelt hooks install`).
 *
 * Parsed strictly here, like every other key: the CLI refuses a malformed config.
 * The guard core (`src/hooks/guard-core.ts`) reads the same file with its own
 * *tolerant* reader — a guard running inside somebody's session fails open where the
 * CLI correctly refuses — and `test/hooks-guard-core.test.ts` pins the two readers to
 * the same key names and defaults so they cannot drift apart.
 */
export interface SmeltConfigHooks {
  /** Reads at or under this many bytes pass the guard untouched. Default 8192. */
  readonly thresholdBytes?: number;
  /**
   * `'deny'` (default): oversized raw reads are refused with a reason naming the
   * exact replacement command. `'rewrite'`: on harnesses whose hooks can modify tool
   * input, the command is substituted instead (never silently — the reason says so).
   */
  readonly enforcement?: EnforcementMode;
}

/**
 * The `agents` block — settings for `smelt agents lint`.
 *
 * One key, and it is the user's number: how many UTF-8 bytes of instruction file this
 * project is willing to pay on every request. **There is no default and there never
 * will be** — the same ruling as `--budget`, for the same reason. A budget smelt
 * invented would be smelt deciding how much of somebody's context window their own
 * house rules deserve, at a number nobody chose. The guide's cited "~150-200
 * instructions" figure is printed by the lint as a citation and compared to nothing.
 */
export interface SmeltConfigAgents {
  /**
   * The merged set's byte ceiling — every `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` in the
   * tree, summed. Absent means unbudgeted: the lint measures and reports, and no
   * number can fail.
   */
  readonly budgetBytes?: number;
}

/**
 * The `rerank` block — the **explicit opt-in** to a relevance reranker (ADR-0004).
 *
 * smelt's default graph is still network-free and always will be: with no `rerank` key
 * nothing is loaded, nothing is imported and nothing is called. What this key adds is a
 * way for a consumer to say *yes, with this adapter, under this key* in a file they
 * wrote, so the outbound call is a line in their own repository rather than a default
 * they would find out about from a changelog. Law 1 is unchanged; the guard still walks
 * the real import graph and still refuses a transport in it.
 *
 * Two kinds, and the difference between them is who wrote the adapter:
 *
 * - `module` — an ESM file of the consumer's own, resolved against the config file (not
 *   the cwd — the same rule `store.path` follows), default-exporting a `RerankStage`.
 *   `smelt init` writes the stub it points at.
 * - `voyage` — the {@link RERANK_VOYAGE_PACKAGE} adapter package, which the consumer installs
 *   themselves. It is not a dependency of `@smeltjs/core` and never will be: core loads
 *   it by a computed specifier at runtime, so it is absent from the import graph the
 *   zero-network guard walks, and a config naming it without the package installed is a
 *   usage error naming the install command.
 *
 * `smeltConfig` does **not** bump for this key. The schema version exists so a *mismatch*
 * is visible rather than half-understood (ADR-0003), and an additive optional key is not
 * a mismatch: a config written by this build is still read by an older one — which
 * refuses the unknown key loudly, which is exactly the behaviour that makes the strict
 * parse worth having. A bump would break every config in the field to announce a key
 * nobody set.
 */
export type SmeltConfigRerank =
  | {
      readonly kind: 'module';
      /** Resolved relative to the directory holding the config file, not the cwd. */
      readonly path: string;
    }
  | {
      readonly kind: 'voyage';
      /** Voyage's rerank model. Defaults to {@link VOYAGE_DEFAULT_MODEL}. */
      readonly model?: string;
      /**
       * The environment variable holding the key — the *name*, never the value; smelt
       * reads a config file, not a secret store. Defaults to
       * {@link VOYAGE_DEFAULT_KEY_ENV}.
       */
      readonly apiKeyEnv?: string;
      /**
       * How many of the ranked candidates the stage returns, and therefore how many
       * regions survive the cut. Optional in the schema because it is meaningless for
       * the `module` kind; **required at load time** for this one, with the same
       * reasoning `--budget` gives for having no default — a K smelt invented would
       * silently decide how much of your context survives.
       */
      readonly topK?: number;
    };

/** Voyage's current rerank model, and the one the wizard writes. */
export const VOYAGE_DEFAULT_MODEL = 'rerank-2.5';

/** The environment variable `kind: "voyage"` reads its key from unless told otherwise. */
export const VOYAGE_DEFAULT_KEY_ENV = 'VOYAGE_API_KEY';

/** The parsed shape of `smelt.config.json`. Every field beyond the version is optional. */
export interface SmeltConfig {
  readonly smeltConfig: typeof CONFIG_VERSION;
  /** Used when a `smelt` run omits `--budget`. UTF-8 bytes, like every smelt budget. */
  readonly defaultBudgetBytes?: number;
  /** Used when a run omits `--strategy`. Validated against the {@link PLANNERS} registry. */
  readonly strategy?: Strategy;
  /** Used for every run; there is no store flag. Defaults to memory when absent. */
  readonly store?: SmeltConfigStore;
  /** Settings for the harness guard. See {@link SmeltConfigHooks}. */
  readonly hooks?: SmeltConfigHooks;
  /** Settings for `smelt agents lint`. See {@link SmeltConfigAgents}. */
  readonly agents?: SmeltConfigAgents;
  /**
   * The reranker opt-in. Absent on every default config, and absent means *nothing
   * happens*. See {@link SmeltConfigRerank}.
   */
  readonly rerank?: SmeltConfigRerank;
}

/** A config plus where it was found — the path matters for resolving `store.path`. */
export interface LoadedConfig {
  readonly path: string;
  readonly config: SmeltConfig;
}

/**
 * The nearest `smelt.config.json`, walking up from `cwd` to the filesystem root —
 * the same discovery shape as `package.json`, so a config at a repo root covers the
 * whole tree. `undefined` when there is none, which is not an error: flags alone are
 * a complete interface.
 */
export function findConfigFile(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Find and parse the nearest config. `undefined` when no file exists; a file that
 * exists but is malformed **throws** — see {@link parseConfig}. The distinction is the
 * point: "no config" is a fine state, "a config you cannot have meant" is not.
 *
 * @throws {CliUsageError} when a config file exists and is malformed.
 */
export function loadNearestConfig(cwd: string): LoadedConfig | undefined {
  const path = findConfigFile(cwd);
  if (path === undefined) return undefined;
  return { path, config: parseConfig(readFileSync(path, 'utf8'), path) };
}

/**
 * Parse and validate one config file, strictly.
 *
 * Strict means: unknown keys are refused, not skipped. A typo'd `defaultBudgetByte`
 * that parsed cleanly would leave the user believing a default was set while every
 * run ignored it — a config error whose failure mode is *silence*, which is the one
 * failure shape this project refuses everywhere else too.
 *
 * @throws {CliUsageError} naming the file and the exact problem.
 */
export function parseConfig(text: string, path: string): SmeltConfig {
  const bad = (why: string): CliUsageError =>
    new CliUsageError(
      `${CLI_NAME}: malformed ${CONFIG_FILE_NAME} at ${path}: ${why}\n` +
        `Fix it or delete it — a config smelt cannot read is never silently ignored. ` +
        `\`${CLI_NAME} init\` can rewrite it.`,
    );

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw bad(`not JSON (${cause instanceof Error ? cause.message : String(cause)}).`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad('expected a JSON object at the top level.');
  }
  const fields = value as Record<string, unknown>;

  if (fields['smeltConfig'] !== CONFIG_VERSION) {
    throw bad(
      `"smeltConfig" is ${JSON.stringify(fields['smeltConfig'])}; this build reads version ` +
        `${String(CONFIG_VERSION)}. The schema is versioned so a mismatch is visible ` +
        `instead of half-understood.`,
    );
  }

  const known = [
    'smeltConfig',
    'defaultBudgetBytes',
    'strategy',
    'store',
    'hooks',
    'agents',
    'rerank',
  ];
  const unknown = Object.keys(fields).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw bad(
      `unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((k) => `"${k}"`).join(', ')}. ` +
        `Known keys: ${known.join(', ')}. Unknown keys are refused because a typo that ` +
        `parsed cleanly would be a setting you believed was set.`,
    );
  }

  const budget = fields['defaultBudgetBytes'];
  if (budget !== undefined && (typeof budget !== 'number' || !Number.isInteger(budget))) {
    throw bad(`"defaultBudgetBytes" must be a whole number of UTF-8 bytes.`);
  }
  if (typeof budget === 'number' && budget <= 0) {
    throw bad(`"defaultBudgetBytes" must be greater than zero, got ${String(budget)}.`);
  }

  const strategy = fields['strategy'];
  if (strategy !== undefined && (typeof strategy !== 'string' || !isStrategy(strategy))) {
    throw bad(
      `"strategy" must be ${STRATEGIES.map((s) => `"${s}"`).join(' or ')}, ` +
        `got ${JSON.stringify(strategy)}.`,
    );
  }

  const store = parseStore(fields['store'], bad);
  const hooks = parseHooks(fields['hooks'], bad);
  const agents = parseAgents(fields['agents'], bad);
  const rerank = parseRerank(fields['rerank'], bad);

  return {
    smeltConfig: CONFIG_VERSION,
    ...(budget === undefined ? {} : { defaultBudgetBytes: budget }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(store === undefined ? {} : { store }),
    ...(hooks === undefined ? {} : { hooks }),
    ...(agents === undefined ? {} : { agents }),
    ...(rerank === undefined ? {} : { rerank }),
  };
}

/**
 * Serialize a config back to the bytes of a `smelt.config.json` — {@link parseConfig}'s
 * inverse, and the **only** writer of this file.
 *
 * The module that owns the schema owns both directions. It used to own only the read:
 * two modules hand-built a config object and stringified it — the `init` wizard and
 * `hooks install` — and they had already drifted, one always emitting `strategy` and
 * the other only when it was carried. A sixth key would have been written by whichever
 * module its author was editing and silently dropped by the other, which is the
 * "setting the user believed was in force" failure this file refuses everywhere else.
 *
 * Key order is fixed here — the reader's own key order, top level and inside `store`
 * and `hooks` — so a re-run diffs cleanly no matter which verb wrote the file, and two
 * writers can never disagree about shape. What goes *into* the config stays each
 * verb's policy: the wizard's choices, and `hooks install`'s directory-store injection.
 * Absent keys are omitted rather than written as `null`, so
 * `parseConfig(renderConfig(c))` returns `c` field for field —
 * `test/guards/config-writer.test.ts` pins that round trip.
 */
export function renderConfig(config: SmeltConfig): string {
  const ordered: SmeltConfig = {
    smeltConfig: CONFIG_VERSION,
    ...(config.defaultBudgetBytes === undefined
      ? {}
      : { defaultBudgetBytes: config.defaultBudgetBytes }),
    ...(config.strategy === undefined ? {} : { strategy: config.strategy }),
    ...(config.store === undefined ? {} : { store: renderStore(config.store) }),
    ...(config.hooks === undefined ? {} : { hooks: renderHooks(config.hooks) }),
    ...(config.agents === undefined ? {} : { agents: renderAgents(config.agents) }),
    ...(config.rerank === undefined ? {} : { rerank: renderRerank(config.rerank) }),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function renderStore(store: SmeltConfigStore): SmeltConfigStore {
  return store.kind === 'memory' ? { kind: 'memory' } : { kind: 'directory', path: store.path };
}

function renderHooks(hooks: SmeltConfigHooks): SmeltConfigHooks {
  return {
    ...(hooks.thresholdBytes === undefined ? {} : { thresholdBytes: hooks.thresholdBytes }),
    ...(hooks.enforcement === undefined ? {} : { enforcement: hooks.enforcement }),
  };
}

function renderAgents(agents: SmeltConfigAgents): SmeltConfigAgents {
  return agents.budgetBytes === undefined ? {} : { budgetBytes: agents.budgetBytes };
}

/** Key order inside the block, like `store` and `hooks`: kind first, then its settings. */
function renderRerank(rerank: SmeltConfigRerank): SmeltConfigRerank {
  if (rerank.kind === 'module') return { kind: 'module', path: rerank.path };
  return {
    kind: 'voyage',
    ...(rerank.model === undefined ? {} : { model: rerank.model }),
    ...(rerank.apiKeyEnv === undefined ? {} : { apiKeyEnv: rerank.apiKeyEnv }),
    ...(rerank.topK === undefined ? {} : { topK: rerank.topK }),
  };
}

function parseStore(
  value: unknown,
  bad: (why: string) => CliUsageError,
): SmeltConfigStore | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`"store" must be an object like {"kind":"memory"} or {"kind":"directory","path":…}.`);
  }
  const fields = value as Record<string, unknown>;
  const kind = fields['kind'];
  if (kind === 'memory') {
    const extra = Object.keys(fields).filter((key) => key !== 'kind');
    if (extra.length > 0) throw bad(`"store" of kind "memory" takes no other keys.`);
    return { kind: 'memory' };
  }
  if (kind === 'directory') {
    const path = fields['path'];
    if (typeof path !== 'string' || path === '') {
      throw bad(`"store" of kind "directory" needs a non-empty "path".`);
    }
    const extra = Object.keys(fields).filter((key) => key !== 'kind' && key !== 'path');
    if (extra.length > 0) throw bad(`"store" of kind "directory" takes only "kind" and "path".`);
    return { kind: 'directory', path };
  }
  throw bad(`"store".kind must be "memory" or "directory", got ${JSON.stringify(kind)}.`);
}

function parseHooks(
  value: unknown,
  bad: (why: string) => CliUsageError,
): SmeltConfigHooks | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`"hooks" must be an object like {"thresholdBytes":8192,"enforcement":"deny"}.`);
  }
  const fields = value as Record<string, unknown>;
  const extra = Object.keys(fields).filter(
    (key) => key !== 'thresholdBytes' && key !== 'enforcement',
  );
  if (extra.length > 0) {
    throw bad(
      `"hooks" takes only "thresholdBytes" and "enforcement", ` +
        `got ${extra.map((k) => `"${k}"`).join(', ')}.`,
    );
  }
  const threshold = fields['thresholdBytes'];
  if (
    threshold !== undefined &&
    (typeof threshold !== 'number' || !Number.isInteger(threshold) || threshold <= 0)
  ) {
    throw bad(`"hooks".thresholdBytes must be a whole number of bytes greater than zero.`);
  }
  const enforcement = fields['enforcement'];
  if (
    enforcement !== undefined &&
    !(ENFORCEMENT_MODES as readonly unknown[]).includes(enforcement)
  ) {
    throw bad(
      `"hooks".enforcement must be ${ENFORCEMENT_MODES.map((m) => `"${m}"`).join(' or ')}, ` +
        `got ${JSON.stringify(enforcement)}.`,
    );
  }
  return {
    ...(threshold === undefined ? {} : { thresholdBytes: threshold as number }),
    ...(enforcement === undefined ? {} : { enforcement: enforcement as EnforcementMode }),
  };
}

/**
 * The `agents` block, parsed as strictly as every other: one key, a whole number of
 * bytes greater than zero.
 *
 * A malformed `agents.budgetBytes` is refused rather than ignored for the reason the
 * whole file is parsed strictly — an ignored budget is a ceiling the user believed was
 * in force. And there is no coercion from a string: `"budgetBytes": "4kb"` is a
 * mistake with a right answer, and guessing it would be smelt inventing a number.
 */
function parseAgents(
  value: unknown,
  bad: (why: string) => CliUsageError,
): SmeltConfigAgents | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(`"agents" must be an object like {"budgetBytes":2000}.`);
  }
  const fields = value as Record<string, unknown>;
  const extra = Object.keys(fields).filter((key) => key !== 'budgetBytes');
  if (extra.length > 0) {
    throw bad(`"agents" takes only "budgetBytes", got ${extra.map((k) => `"${k}"`).join(', ')}.`);
  }
  const budget = fields['budgetBytes'];
  if (
    budget !== undefined &&
    (typeof budget !== 'number' || !Number.isInteger(budget) || budget <= 0)
  ) {
    throw bad(`"agents".budgetBytes must be a whole number of bytes greater than zero.`);
  }
  return budget === undefined ? {} : { budgetBytes: budget as number };
}

/**
 * The `rerank` block, parsed as strictly as every other — and strictly *because* of
 * what it turns on.
 *
 * Every other key in this file decides how bytes are cut on the machine that runs
 * smelt. This one can decide that regions of the caller's source are sent to a third
 * party. A typo that parsed cleanly is bad everywhere in this file; here it is either a
 * reranker the user believed was running and never was, or — with an unknown `kind`
 * shrugged off — an opt-in nobody can audit by reading the file. So an unknown kind, a
 * missing path and a malformed `topK` are all refusals, in the same shape as the rest.
 */
function parseRerank(
  value: unknown,
  bad: (why: string) => CliUsageError,
): SmeltConfigRerank | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw bad(
      `"rerank" must be an object like {"kind":"module","path":"./smelt.rerank.ts"} or ` +
        `{"kind":"voyage","topK":8}.`,
    );
  }
  const fields = value as Record<string, unknown>;
  const kind = fields['kind'];

  if (kind === 'module') {
    const path = fields['path'];
    if (typeof path !== 'string' || path === '') {
      throw bad(
        `"rerank" of kind "module" needs a non-empty "path" to an ESM file exporting a ` +
          `RerankStage, relative to ${CONFIG_FILE_NAME}.`,
      );
    }
    const extra = Object.keys(fields).filter((key) => key !== 'kind' && key !== 'path');
    if (extra.length > 0) throw bad(`"rerank" of kind "module" takes only "kind" and "path".`);
    return { kind: 'module', path };
  }

  if (kind === 'voyage') {
    const extra = Object.keys(fields).filter(
      (key) => !['kind', 'model', 'apiKeyEnv', 'topK'].includes(key),
    );
    if (extra.length > 0) {
      throw bad(
        `"rerank" of kind "voyage" takes only "kind", "model", "apiKeyEnv" and "topK", ` +
          `got ${extra.map((k) => `"${k}"`).join(', ')}.`,
      );
    }
    const model = fields['model'];
    if (model !== undefined && (typeof model !== 'string' || model === '')) {
      throw bad(`"rerank".model must be a non-empty string, e.g. "${VOYAGE_DEFAULT_MODEL}".`);
    }
    const apiKeyEnv = fields['apiKeyEnv'];
    if (apiKeyEnv !== undefined && (typeof apiKeyEnv !== 'string' || apiKeyEnv === '')) {
      throw bad(
        `"rerank".apiKeyEnv must be the NAME of an environment variable, e.g. ` +
          `"${VOYAGE_DEFAULT_KEY_ENV}" — never the key itself.`,
      );
    }
    const topK = fields['topK'];
    if (topK !== undefined && (typeof topK !== 'number' || !Number.isInteger(topK) || topK <= 0)) {
      throw bad(`"rerank".topK must be a whole number of candidates greater than zero.`);
    }
    return {
      kind: 'voyage',
      ...(model === undefined ? {} : { model: model as string }),
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv: apiKeyEnv as string }),
      ...(topK === undefined ? {} : { topK: topK as number }),
    };
  }

  throw bad(
    `"rerank".kind must be "module" or "voyage", got ${JSON.stringify(kind)}. ` +
      `"module" loads a RerankStage you wrote; "voyage" loads ${RERANK_VOYAGE_PACKAGE}, ` +
      `which you install yourself. There is no third kind and no default — a reranker ` +
      `smelt turned on for you would send your code somewhere you never named.`,
  );
}

/** `store.path` is relative to the config file, so the config works from any cwd. */
export function resolveStorePath(loaded: LoadedConfig, path: string): string {
  return resolve(dirname(loaded.path), path);
}
/**
 * The store decision a config carries, with `path` already resolved against the config
 * file's directory — one config serves every subdirectory it covers without scattering
 * store roots. `'memory'` is the built-in default: a fresh in-memory store per run.
 */
export type ConfiguredStore =
  { readonly kind: 'memory' } | { readonly kind: 'directory'; readonly path: string };

/**
 * The store leg of every merge, read once here rather than in each verb that needs it.
 *
 * There is no store flag, so this leg is config-or-built-in only — which is exactly
 * why it belongs to the config module and not to a verb: `smelt` builds a store from
 * it, and `retrieve`/`stats` refuse when it is not a directory (see `resolveStoreRun`
 * in `subcommands/retrieve.ts`). Three verbs, one reading of the same key.
 */
export function configuredStore(config: LoadedConfig | undefined): ConfiguredStore {
  if (config?.config.store === undefined || config.config.store.kind === 'memory') {
    return { kind: 'memory' };
  }
  return { kind: 'directory', path: resolveStorePath(config, config.config.store.path) };
}
