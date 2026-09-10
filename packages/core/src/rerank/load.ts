import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { CliUsageError } from '../errors.ts';
import { RERANK_VOYAGE_PACKAGE } from '../net/policy.ts';
import type { RerankCandidate, RerankStage } from '../types.ts';
import { CLI_NAME } from '../cli/shell.ts';
import { CONFIG_FILE_NAME, VOYAGE_DEFAULT_KEY_ENV, VOYAGE_DEFAULT_MODEL } from '../config.ts';
import type { SmeltConfigRerank } from '../config.ts';

import { isBareSpecifier, originLabel, resolveAdapter } from './resolve.ts';

/**
 * TURNING A `rerank` CONFIG BLOCK INTO A LIVE STAGE — and the one place in smelt that
 * knows an opt-in reranker can exist.
 *
 * ADR-0004 reopened exactly one thing: a consumer may name a reranker **in a config
 * file they wrote**. Everything about Law 1 that made a bundled reranker wrong is
 * unchanged, and this module is where that stays true rather than becoming a promise:
 *
 * - **No stage is ever the default.** `undefined` in, `undefined` out. A tree with no
 *   `rerank` key never reaches a line below the first `if`.
 * - **The adapter is never in smelt's import graph.** {@link RERANK_VOYAGE_PACKAGE} is
 *   a *value*, owned by `net/policy.ts` where Law 1 is written down; `resolve.ts` turns
 *   it into a `file:` URL and the `import()` below takes *that* — so the zero-network
 *   walk (which follows literal specifiers) sees data, not an edge, and the guard's
 *   ruling classifies any import of that name as *forbidden*. That is the honest
 *   arrangement rather than a hidden one, and `test/guards/no-network.test.ts` pins
 *   both halves with mutations: a static import of the package must go red, and so must
 *   spelling the `import()` below with a literal.
 * - **Where the adapter is looked for belongs to `resolve.ts`.** Both kinds go through
 *   it, so a config in `$HOME` and a config in a project get the same rule and the same
 *   refusal — see that module for why smelt's own location was the wrong place to ask.
 * - **Every refusal names the thing to fix.** A missing module names the path a config
 *   line points at; a missing package names the install command; a missing key names
 *   the *variable*, never its value; a missing `topK` names the key. None of them
 *   silently falls back to unranked output, because a reranker that quietly did nothing
 *   is a setting the user believed was in force.
 *
 * The environment arrives as an argument rather than being read off `process` here, for
 * the reason every seam in this repository takes its inputs: the front doors pass their
 * own env, and a test passes a literal.
 */

/** What a front door hands this module: the block, where it was written, and the env. */
export interface RerankLoad {
  /** The parsed `rerank` block, or `undefined` when the config named none. */
  readonly rerank: SmeltConfigRerank | undefined;
  /** The directory holding `smelt.config.json` — `module.path` resolves against it. */
  readonly configDir: string;
  /** The process environment, passed in. Only the *named* variable is ever read. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** The shape the `voyage` adapter package must export. Structural, so no import is needed. */
interface VoyageModule {
  createVoyageRerankStage(options: {
    readonly apiKey: string;
    readonly model: string;
    readonly topK: number;
  }): RerankStage;
}

/**
 * Load the configured stage, or nothing.
 *
 * @throws {CliUsageError} for every way a `rerank` block can name something that is not
 *   there: a module file that does not exist or exports no stage, a `topK` the voyage
 *   kind requires, an unset API-key variable, or the adapter package not being
 *   installed. A front door renders these as its own usage refusal, exit 2 in the CLI.
 */
export async function loadRerankStage(load: RerankLoad): Promise<RerankStage | undefined> {
  const { rerank } = load;
  if (rerank === undefined) return undefined;
  return rerank.kind === 'module'
    ? loadModuleStage(rerank.path, load)
    : loadVoyageStage(rerank, load);
}

/**
 * A `RerankStage` out of the consumer's own file.
 *
 * Three export names are accepted, in order: `default`, `rerankStage`, `rerank`. The
 * third is there because `smelt init` writes a stub that exports `rerank`, and a loader
 * that refused the file its own wizard writes would be a joke; the stub default-exports
 * as well, so a hand-written file only needs the first.
 *
 * The stage comes back wrapped, and the wrapper's only job is its `id`: attribution says
 * `module/<path as the config wrote it>`, because the path is what the reader configured
 * and what they would edit — a stage's own `id` names the ranker, not which file smelt
 * found it in.
 */
async function loadModuleStage(path: string, load: RerankLoad): Promise<RerankStage> {
  const url = moduleUrl(path, load);

  let loaded: Record<string, unknown>;
  try {
    loaded = (await import(url)) as Record<string, unknown>;
  } catch (cause) {
    throw usage(
      `${CONFIG_FILE_NAME} sets rerank.path to "${path}" and ${url} could not be ` +
        `imported: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const exported = loaded['default'] ?? loaded['rerankStage'] ?? loaded['rerank'];
  if (!isRerankStage(exported)) {
    throw usage(
      `${url} exports no RerankStage. It must \`export default\` (or export as ` +
        `\`rerankStage\`) an object with a string \`id\` and an async \`rerank(candidates, ` +
        `query)\`. Found: ${Object.keys(loaded).join(', ') || '(no exports)'}.`,
    );
  }

  return wrap(exported, `module/${path}`, undefined);
}

/**
 * The `file:` URL a `module` block names — a file beside the config, or a package.
 *
 * The path rule comes first and is unchanged, because that is what the key's schema
 * promises and what every config written so far means by it. Only when there is no file
 * there does a **bare** specifier get the same two-directory search the `voyage` kind
 * gets: `{"kind":"module","path":"my-reranker"}` is a legal package name, and refusing
 * it while resolving the identical string for the other kind would be smelt's own
 * inconsistency showing through. A relative or absolute path is never a package, so it
 * refuses exactly as before.
 */
function moduleUrl(path: string, load: RerankLoad): string {
  const resolved = isAbsolute(path) ? path : resolve(load.configDir, path);
  if (existsSync(resolved)) return pathToFileURL(resolved).href;

  if (isBareSpecifier(path)) {
    const adapter = resolveAdapter(path, configFile(load));
    if (adapter.found) return adapter.url;
    throw usage(
      `${CONFIG_FILE_NAME} sets rerank.path to "${path}". There is no file at ${resolved}, ` +
        `and ${adapter.why} Write "./${path}" if you meant a file beside the config.`,
    );
  }

  throw usage(
    `${CONFIG_FILE_NAME} sets rerank.path to "${path}", which resolves to ${resolved} — ` +
      `and there is no file there. The path is relative to the config file, not to the ` +
      `directory you ran from. \`${CLI_NAME} init\` writes the stub it points at.`,
  );
}

/**
 * A `RerankStage` out of {@link RERANK_VOYAGE_PACKAGE} — the opt-in adapter package.
 *
 * Three refusals before a byte can leave the machine, and each names its own fix: the
 * `topK` this kind requires, the environment variable that holds the key, and the
 * package itself. The key's *value* never appears in a message, a receipt or a report;
 * only whether the named variable is set (`smelt doctor` prints exactly that).
 */
async function loadVoyageStage(
  rerank: Extract<SmeltConfigRerank, { kind: 'voyage' }>,
  load: RerankLoad,
): Promise<RerankStage> {
  const model = rerank.model ?? VOYAGE_DEFAULT_MODEL;
  const keyEnv = rerank.apiKeyEnv ?? VOYAGE_DEFAULT_KEY_ENV;

  if (rerank.topK === undefined) {
    throw usage(
      `${CONFIG_FILE_NAME} sets rerank.kind to "voyage" without a "topK". This kind needs ` +
        `one: topK is how many of the ranked regions survive the cut, and there is no ` +
        `default because a number smelt invented would silently decide how much of your ` +
        `context survives — the same reason --budget has none. Add e.g. "topK": 8.`,
    );
  }

  const apiKey = load.env[keyEnv];
  if (apiKey === undefined || apiKey === '') {
    throw usage(
      `${CONFIG_FILE_NAME} sets rerank.kind to "voyage", which reads its key from the ` +
        `${keyEnv} environment variable, and ${keyEnv} is not set. smelt refuses rather ` +
        `than falling back to unranked output: a reranker you configured and did not get ` +
        `is a setting you believed was in force.`,
    );
  }

  const adapter = resolveAdapter(RERANK_VOYAGE_PACKAGE, configFile(load));
  if (!adapter.found) {
    throw usage(
      `${CONFIG_FILE_NAME} sets rerank.kind to "voyage", and ${adapter.why} It is not a ` +
        `dependency of @smeltjs/core and never will be, because a bundled adapter would ` +
        `put a network client in smelt's own import graph.`,
    );
  }

  let module: VoyageModule;
  try {
    module = (await import(adapter.url)) as VoyageModule;
  } catch (cause) {
    throw usage(
      `${RERANK_VOYAGE_PACKAGE} resolved ${originLabel(adapter.from)} (${adapter.url}) but ` +
        `could not be imported: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return wrap(
    module.createVoyageRerankStage({ apiKey, model, topK: rerank.topK }),
    'voyage',
    model,
  );
}

/**
 * A stage under the id and model the *config* named — the attribution a report prints.
 *
 * Deliberately a wrapper rather than a mutation of the loaded object: the consumer's
 * stage is the consumer's, and rewriting a field on it would be smelt editing somebody
 * else's value to make its own report read nicely.
 */
function wrap(stage: RerankStage, id: string, model: string | undefined): RerankStage {
  return {
    id,
    ...(model === undefined ? {} : { model }),
    rerank: (candidates: readonly RerankCandidate[], query: string) =>
      stage.rerank(candidates, query),
  };
}

/** Structural, because the module came from a file smelt has no type for. */
function isRerankStage(value: unknown): value is RerankStage {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { id?: unknown; rerank?: unknown };
  return typeof candidate.id === 'string' && typeof candidate.rerank === 'function';
}

const usage = (why: string): CliUsageError => new CliUsageError(`${CLI_NAME}: ${why}`);

/**
 * The config file this block was written in — what the resolver starts its walk beside.
 *
 * Composed here rather than added to {@link RerankLoad}, which already carries the
 * directory and is a published type: one more required field on it would be a breaking
 * change to every consumer that builds a `RerankLoad` itself, to say something the
 * directory and {@link CONFIG_FILE_NAME} already say between them.
 */
const configFile = (load: RerankLoad): string => join(load.configDir, CONFIG_FILE_NAME);
