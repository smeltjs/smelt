import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Language, Parser } from 'web-tree-sitter';

import { GrammarUnavailableError, SmeltError } from '../errors.ts';
import { LANGUAGE_PROFILES } from '../lang/registry.ts';
import { assertLocalResource } from '../net/policy.ts';
import type { LanguageId } from '../types.ts';

/**
 * Grammar file for each language smelt claims to parse — the registry's `wasm`
 * facts, as a map. Derived from `LANGUAGE_PROFILES` (which is
 * `Record<LanguageId, LanguageProfile>`, so adding a `LanguageId` without a profile —
 * and its grammar — is a type error and the two cannot drift). It stays exported
 * because `scripts/bundle-grammars.mjs` and the attribution generator both read it —
 * a hand-written second list of grammar filenames would be exactly the drift the
 * registry exists to prevent.
 */
export const WASM_BY_LANGUAGE: Readonly<Record<LanguageId, string>> = Object.fromEntries(
  Object.values(LANGUAGE_PROFILES).map((profile) => [profile.id, profile.wasm]),
) as Record<LanguageId, string>;

/**
 * Where the bundled grammars live, relative to this module.
 *
 * From `dist/plan/grammar.js` and from `src/plan/grammar.ts` alike, `../../grammars/`
 * is this package's own `grammars/` directory — filled by `pnpm build` and shipped
 * inside the npm tarball. That is what makes "zero native compilation, works offline"
 * true rather than aspirational: whoever installs the package has the parsers, with no
 * post-install download and no optional peer dependency to remember. It is also
 * redistribution, which is why `THIRD-PARTY.md` exists and is generated.
 */
const BUNDLED_GRAMMAR_DIR = new URL('../../grammars/', import.meta.url);

const require = createRequire(import.meta.url);
const cache = new Map<LanguageId, Language>();
let runtimeReady: Promise<void> | undefined;

/**
 * Resolve a grammar to a path on this machine.
 *
 * The copy bundled in this package wins; `tree-sitter-wasms` is the fallback, for a
 * source checkout that has not run `pnpm build` yet. Note what this function does *not*
 * do: it never constructs a URL from a version string, a CDN base, or anything else.
 * Grammars come off disk — either the ones shipped here or the ones a package manager
 * already installed. A "fetch the grammar on first use" cache is the most natural way
 * to break Law 1 without noticing, because it works perfectly on the machine that
 * wrote it.
 */
export function grammarPath(language: LanguageId): string {
  const file = WASM_BY_LANGUAGE[language];

  const bundled = fileURLToPath(new URL(file, BUNDLED_GRAMMAR_DIR));
  if (existsSync(bundled)) return bundled;

  try {
    return require.resolve(`tree-sitter-wasms/out/${file}`);
  } catch {
    throw new GrammarUnavailableError(
      `smelt: no grammar for "${language}". The bundled copy is missing (run ` +
        `\`pnpm build\` in a source checkout) and \`tree-sitter-wasms\` is not installed ` +
        `either. Pass \`language: 'unknown'\` to use the lexical planner.`,
    );
  }
}

/**
 * Load a grammar, from disk, once.
 *
 * The bytes are read here and handed to tree-sitter as a `Uint8Array` rather than
 * passing it a path. `Language.load()` accepts `string | URL`, and a `URL` with an
 * `https:` scheme would make it fetch — inside the elision path, from a dependency's
 * ordinary happy path. Reading the file ourselves removes that capability instead of
 * documenting it, and {@link assertLocalResource} rejects a remote path before we get
 * that far.
 *
 * **Every failure here is a `GrammarUnavailableError`.** The consumer contract makes
 * exactly one promise about errors — every error smelt throws is an `instanceof
 * SmeltError` — and this function is on the path of both `smelt()` and
 * `buildRepoMap()`, for every file in a language smelt claims to parse. Only
 * *resolution* used to be inside the contract: `grammarPath` throws for a grammar it
 * cannot find, and {@link existsSync} then reports a file's **presence**, never its
 * readability. So a grammar that resolved and then would not load leaked the raw
 * error — `EACCES` from an unreadable `.wasm`, a V8 `CompileError` or `RangeError`
 * from a truncated one, a half-extracted tarball — straight past a caller's
 * documented `catch`. Each step is wrapped instead, naming the language and the path
 * and keeping the original as `cause`: bringing the failure inside the contract, not
 * hiding what Node or V8 said. A promise with one undocumented exception is no
 * promise at all.
 */
export async function loadGrammar(language: LanguageId): Promise<Language> {
  const cached = cache.get(language);
  if (cached !== undefined) return cached;

  const path = fileURLToPath(assertLocalResource(grammarPath(language)).href);

  const ready = (runtimeReady ??= Parser.init());
  await inContract(
    () => ready,
    `smelt: the tree-sitter WASM runtime would not start, so no grammar can be loaded`,
  );
  const bytes = await inContract(
    () => readFile(path),
    `smelt: the grammar for "${language}" could not be read from "${path}"`,
  );
  const grammar = await inContract(
    () => Language.load(new Uint8Array(bytes)),
    `smelt: the file at "${path}" is not a loadable tree-sitter grammar for "${language}"`,
  );
  cache.set(language, grammar);
  return grammar;
}

/**
 * Run one step of the load and keep its failure inside the consumer contract.
 *
 * A {@link SmeltError} passes through untouched — `assertLocalResource` and
 * `grammarPath` already refuse in smelt's own currency, and rewrapping would bury a
 * sentence written deliberately under a generic one.
 */
async function inContract<T>(run: () => Promise<T>, what: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SmeltError) throw error;
    throw new GrammarUnavailableError(`${what}: ${describeFailure(error)}.`, { cause: error });
  }
}

/**
 * What Node or V8 actually said. Never invented, never swallowed — the wasm cases
 * (`CompileError`, `RangeError`) carry no `errno`, and their message is the whole
 * diagnosis.
 */
function describeFailure(cause: unknown): string {
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return String(cause);
}
