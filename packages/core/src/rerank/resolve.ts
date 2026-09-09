import { createRequire } from 'node:module';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CONFIG_FILE_NAME } from '../config.ts';

/**
 * WHICH DIRECTORY AN OPT-IN ADAPTER IS LOOKED FOR IN — and the whole of what this
 * module decides.
 *
 * An adapter package (ADR-0004) is installed by the consumer, never by smelt, so the
 * only question that matters is *where they could have installed it*. The answer used
 * to be "wherever smelt's own code happens to live", which is right for a project-local
 * `npm install` and wrong for every other shape smelt ships in: a `smelt.config.json`
 * in `$HOME` (InstallScope `user`) with a global `smelt` resolved the package out of a
 * Homebrew keg or an `npm -g` prefix — directories nobody installs into, so the refusal
 * named a command that could not have worked.
 *
 * So the config file's own directory is asked first. `createRequire(configPath)` starts
 * Node's ordinary `node_modules` walk beside the file the consumer wrote, which covers
 * `~/node_modules/…` beside `~/smelt.config.json` and a project's own `node_modules`
 * with one rule rather than two. Smelt's own install is the fallback, unchanged, for
 * the project-local case where the two are the same place anyway.
 *
 * Three properties this module owns, and the reasons they live here rather than in
 * `load.ts`:
 *
 * - **It resolves, it never imports.** What comes back is a `file:` URL, and the caller
 *   hands *that* to `import()`. The specifier at every call site therefore stays a
 *   value, so the Law 1 walk (which follows literal specifiers) finds no edge to an
 *   adapter — the arrangement `net/policy.ts` writes down, kept intact by a seam that
 *   could have quietly broken it.
 * - **It refuses without throwing.** `smelt doctor` asks the same question as the
 *   loader and must answer it in a report line, not an exception; the loader turns the
 *   same value into its own usage refusal. One resolution, two front doors, no second
 *   opinion about where an adapter lives.
 * - **One refusal names both places and the command.** A refusal naming only smelt's
 *   own install is the bug this module exists for; a refusal naming only the config
 *   directory would hide that the fallback was tried at all.
 */

/**
 * The one member of `require` this module uses.
 *
 * Structural, for the reason `LocalResource` in `net/policy.ts` is:
 * `NodeRequire` is a type only a compilation that pulled in `@types/node` has, and
 * naming it in an exported signature puts an error into the shipped `.d.ts` for every
 * consumer building without them. It is also the seam — a test hands over a resolver
 * rooted in a temp directory instead of installing anything.
 */
export interface SpecifierResolver {
  resolve(specifier: string): string;
}

/** Which of the two places answered. */
export type AdapterOrigin = 'config' | 'core';

/** The adapter, found. */
export interface ResolvedAdapter {
  readonly found: true;
  /** The `file:` URL of the resolved entry — what `import()` takes, verbatim. */
  readonly url: string;
  /** `'config'` for the config file's directory, `'core'` for smelt's own install. */
  readonly from: AdapterOrigin;
}

/** The adapter, in neither place — with everything a refusal needs to name. */
export interface UnresolvedAdapter {
  readonly found: false;
  /** The directory holding the config file: the first place tried. */
  readonly configDir: string;
  /** Smelt's own package directory: the second place tried. */
  readonly ownDir: string;
  /** The command that puts the adapter where {@link configDir} can see it. */
  readonly install: string;
  /** One sentence naming both places and the command. Rendered as-is by both doors. */
  readonly why: string;
}

/** What {@link resolveAdapter} answers. `found` discriminates. */
export type AdapterResolution = ResolvedAdapter | UnresolvedAdapter;

/** The seam, as an argument. Empty in production; a test supplies the fallback. */
export interface AdapterResolverIo {
  /**
   * How smelt's *own* install resolves a package. Defaults to this module's `require`,
   * which is `@smeltjs/core`'s own `node_modules` walk.
   */
  readonly ownRequire?: SpecifierResolver;
}

/**
 * Smelt's own package directory.
 *
 * `../../` from `src/rerank/resolve.ts` in a checkout and from `dist/rerank/resolve.js`
 * in the tarball is the same directory both times — `@smeltjs/core`'s root, the same
 * arithmetic `plan/grammar.ts` uses to find the bundled grammars. It is named in the
 * refusal because a reader who has been told "and not in smelt's own install either"
 * deserves to know which directory that was.
 */
const OWN_PACKAGE_DIR = fileURLToPath(new URL('../../', import.meta.url));

/** `@smeltjs/core`'s own `node_modules` walk. Built once; it holds a resolution cache. */
const ownRequireDefault: SpecifierResolver = createRequire(import.meta.url);

/**
 * Resolve an adapter package to a `file:` URL, from the config file's directory first.
 *
 * @param name the package specifier, as data — this module never spells one.
 * @param configPath the `smelt.config.json` the opt-in was written in. Its *directory*
 *   is where the walk starts, which is what makes `npm install --prefix <that>` the
 *   command the refusal can honestly print.
 */
export function resolveAdapter(
  name: string,
  configPath: string,
  io: AdapterResolverIo = {},
): AdapterResolution {
  const configDir = dirname(resolvePath(configPath));

  const beside = tryResolve(createRequire(resolvePath(configPath)), name);
  if (beside !== undefined) return { found: true, url: pathToFileURL(beside).href, from: 'config' };

  const own = tryResolve(io.ownRequire ?? ownRequireDefault, name);
  if (own !== undefined) return { found: true, url: pathToFileURL(own).href, from: 'core' };

  const install = installCommand(name, configDir);
  return {
    found: false,
    configDir,
    ownDir: OWN_PACKAGE_DIR,
    install,
    why:
      `${name} is not installed. smelt looked beside ${CONFIG_FILE_NAME} (${configDir}) ` +
      `and in its own install (${OWN_PACKAGE_DIR}), and it is in neither. Install it ` +
      `where the config can see it: \`${install}\`.`,
  };
}

/**
 * The command that installs `name` into `<dir>/node_modules`.
 *
 * `--prefix` short-circuits npm's own walk up from the cwd and sets the local prefix
 * outright, and a local install puts its packages in `node_modules` under the prefix —
 * so this creates `<dir>/node_modules/<name>`, which is exactly the directory
 * {@link resolveAdapter} asks first. Checked against npm's own `config` and `folders`
 * documentation, and run once against a scratch directory, rather than assumed.
 */
export function installCommand(name: string, dir: string): string {
  return `npm install --prefix ${dir} ${name}`;
}

/**
 * Whether a `rerank.path` is a package specifier rather than a file path.
 *
 * Node's own rule, and deliberately only Node's: `./x`, `../x`, an absolute path and a
 * `file:` URL are paths; everything else is a package. The `module` kind still resolves
 * a path against the config file's directory first — that is the documented meaning of
 * the key and existing configs keep it — so this only decides whether a specifier that
 * names *no file there* is worth asking the resolver about.
 */
export function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return false;
  if (specifier.startsWith('/') || specifier.startsWith('\\')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(specifier)) return false; // C:\… — a Windows absolute path
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(specifier)) return false; // file:… and any other URL
  return true;
}

/** A resolver's "no" is an exception; this module's is a value. */
function tryResolve(resolver: SpecifierResolver, name: string): string | undefined {
  try {
    return resolver.resolve(name);
  } catch {
    return undefined;
  }
}

/**
 * Where an adapter resolved from, in the words a report line uses.
 *
 * One spelling for both front doors: `smelt doctor` prints it on the rerank line and a
 * loader refusal quotes it, so "from config dir" cannot come to mean two things.
 */
export function originLabel(from: AdapterOrigin): string {
  return from === 'config' ? 'from config dir' : "from smelt's own install";
}
