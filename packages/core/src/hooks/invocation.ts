import { existsSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

/**
 * Invocation — the one module that answers "how is smelt re-invoked on this machine".
 *
 * Everything smelt writes into somebody else's config file is, ultimately, a command
 * that has to still work tomorrow: a hook entry, a plugin's absolute import, the deny
 * reason's replacement command. Before this module three different files derived that
 * command three different ways from `import.meta.url`, and each was wrong in the same
 * place — a global install through Homebrew:
 *
 *  - Node realpaths the ESM main entry, so `pathToFileURL(process.argv[1]).href ===
 *    import.meta.url` is **false** whenever the script was reached through a symlink.
 *    Every shim's `isMainModule` said no, `runShimMain` never ran, and the guard
 *    exited 0 with empty stdout: silently inert, every oversized read passing.
 *  - `import.meta.url` under Homebrew names the *versioned keg*
 *    (`<prefix>/Cellar/smelt/<version>/libexec/…`), which `brew upgrade` deletes.
 *    Every installed hook then dies with "Cannot find module" until setup is re-run.
 *
 * Both are the same missing idea, so this module owns it and nothing else derives it:
 * {@link isSameFile} answers identity through symlinks, {@link stableScriptPath}
 * answers "the spelling of this script that survives an upgrade", and
 * {@link smeltInvocation} answers the writers' whole question in one value.
 *
 * Like its sibling `guard-core.ts` — which imports it — this file is **node builtins
 * only**. It ships as `dist/hooks/invocation.js`, is loaded on the always-on guard
 * path before any decision is made, and a library import here would spend the guard's
 * whole millisecond budget on the allow case.
 */

/** The filesystem facts this module needs, as an injectable seam. */
export interface InvocationFs {
  readonly existsSync: (path: string) => boolean;
  /** Resolves every symlink in `path`. Throws (ENOENT, ELOOP, …) like node's. */
  readonly realpathSync: (path: string) => string;
  /** Throws when the path is not there — the cheap "is it here" probe. */
  readonly statSync: (path: string) => InvocationStat;
}

/** The slice of a stat this module reads: a file, and whether anyone may execute it. */
export interface InvocationStat {
  readonly isFile: () => boolean;
  readonly mode: number;
}

/** The environment slice `smeltOnPath` reads. Stated structurally, never `NodeJS.*`. */
export type InvocationEnv = Readonly<Record<string, string | undefined>>;

/** The real machine — the default for every seam below. */
export const NODE_FS: InvocationFs = {
  existsSync: (path) => existsSync(path),
  realpathSync: (path) => realpathSync(path),
  statSync: (path) => statSync(path),
};

/**
 * True when two paths name the same file on disk, symlinks resolved.
 *
 * Realpath both sides; when realpath throws (the path is gone, a broken link, a
 * permission wall) fall back to the raw spelling for that side. Falling back rather
 * than throwing is what keeps `isMainModule` from turning a missing file into an
 * exception on the guard's hot path — a wrong answer here is an allow, never a crash.
 */
export function isSameFile(a: string, b: string, fs: InvocationFs = NODE_FS): boolean {
  if (a === b) return true;
  return resolvedPath(a, fs) === resolvedPath(b, fs);
}

function resolvedPath(path: string, fs: InvocationFs): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * A Homebrew keg path taken apart: `<prefix>/Cellar/<name>/<version>/<rest…>`.
 * `undefined` for every other path, which is what makes the rewrite below a no-op
 * everywhere except the one install shape that needs it.
 */
interface KegPath {
  /** Everything left of `Cellar` — `/opt/homebrew`, `/usr/local`, … Never hard-coded. */
  readonly prefix: string;
  readonly name: string;
  /** The keg directory itself: `<prefix>/Cellar/<name>/<version>`. */
  readonly keg: string;
  /** The path below the keg, as segments. */
  readonly rest: readonly string[];
}

function kegPath(path: string): KegPath | undefined {
  const segments = path.split('/');
  const at = segments.lastIndexOf('Cellar');
  if (at < 1) return undefined; // no `Cellar`, or nothing to the left of it
  const name = segments[at + 1];
  const version = segments[at + 2];
  if (name === undefined || version === undefined) return undefined;
  const rest = segments.slice(at + 3);
  if (rest.length === 0) return undefined; // the keg root, not a script inside one
  return {
    prefix: segments.slice(0, at).join('/'),
    name,
    keg: segments.slice(0, at + 3).join('/'),
    rest,
  };
}

/**
 * The spelling of `realPath` that survives an upgrade.
 *
 * Homebrew keeps every release in its own versioned keg and points one alias at the
 * current one: `<prefix>/opt/<name>` → `<prefix>/Cellar/<name>/<version>`. A config
 * file holding the keg spelling names a directory `brew upgrade` deletes; the alias
 * spelling is re-pointed instead. So: when the path runs through a keg, and the
 * sibling alias exists, and the alias resolves to *this* keg, return the alias
 * spelling. Otherwise return the input unchanged — an alias that is missing, or that
 * has already moved on to another version, tells us nothing about this path.
 *
 * The prefix is derived from the path, so `/opt/homebrew`, `/usr/local` and
 * `/home/linuxbrew/.linuxbrew` all work without any of them being written down.
 */
export function stableScriptPath(realPath: string, fs: InvocationFs = NODE_FS): string {
  const keg = kegPath(realPath);
  if (keg === undefined) return realPath;
  const alias = `${keg.prefix}/opt/${keg.name}`;
  if (!fs.existsSync(alias)) return realPath;
  if (!isSameFile(alias, keg.keg, fs)) return realPath;
  return [alias, ...keg.rest].join('/');
}

/** `smelt.cmd`/`smelt.exe` on Windows, `smelt` everywhere else. */
function executableNames(): readonly string[] {
  return process.platform === 'win32' ? ['smelt.cmd', 'smelt.exe'] : ['smelt'];
}

/**
 * The absolute path of an executable `smelt` on PATH, or `undefined`.
 *
 * One stat per PATH directory, no spawn: this runs on the guard's hot path, and
 * `which smelt` would cost a process to learn a filesystem fact. A non-Windows
 * candidate must carry an execute bit — a `smelt` that nobody may run is not on PATH
 * in the only sense a written command cares about.
 */
export function smeltOnPath(
  env: InvocationEnv = process.env,
  fs: InvocationFs = NODE_FS,
): string | undefined {
  const search = env['PATH'] ?? env['Path'] ?? env['path'];
  if (search === undefined || search === '') return undefined;
  for (const dir of search.split(delimiter)) {
    if (dir === '') continue;
    for (const name of executableNames()) {
      const candidate = join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) continue;
        return candidate;
      } catch {
        // not in this directory — the ordinary case, and the reason this is a stat
      }
    }
  }
  return undefined;
}

/**
 * The `dist` directory of this installed package — where the shipped guard core, the
 * shims and the CLI binary live.
 *
 * Computed from this module's own location, which is `<pkg>/dist/hooks/` in every real
 * run (the CLI executes from `dist`); under the test runner it is `<pkg>/src/hooks/`,
 * and the substitution still points at `dist`, which is where the scripts will exist
 * once built — these paths are written into config files for *node* to execute, never
 * imported.
 */
export function packageDistDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // <pkg>/(dist|src)/hooks
  return join(dirname(dirname(here)), 'dist');
}

/** The shim script for one harness id, in the spelling that survives an upgrade. */
export function stableShimPath(profileId: string, distDir: string = packageDistDir()): string {
  return stableScriptPath(join(distDir, 'hooks', 'shims', `${profileId}.js`));
}

/** The guard core as a module — what the opencode plugin imports at hook time. */
export function stableGuardCorePath(distDir: string = packageDistDir()): string {
  return stableScriptPath(join(distDir, 'hooks', 'guard-core.js'));
}

/** The `smelt` binary, in the spelling that survives an upgrade. */
export function stableBinPath(distDir: string = packageDistDir()): string {
  return stableScriptPath(join(distDir, 'cli', 'bin.js'));
}

/**
 * How smelt is re-invoked on this machine — the value every writer asks for instead
 * of deriving a command of its own.
 *
 * `stable` is the promise the writers relay: this command still works after the
 * package is upgraded. It is false in exactly one shape — a versioned Homebrew keg
 * with no alias resolving to it — and `why` says so in words a receipt can print.
 */
export interface SmeltInvocation {
  /** `'path'`: the bare name on PATH. `'node'`: node running a script by path. */
  readonly kind: 'path' | 'node';
  /** The runnable prefix a command line is built on: `smelt`, or `node "<script>"`. */
  readonly command: string;
  /** The script `node` runs. Present exactly when `kind` is `'node'`. */
  readonly script?: string;
  /** What the command resolves to on disk — the PATH executable, or the script. */
  readonly bin: string;
  /** True when an upgrade of the package leaves this command working. */
  readonly stable: boolean;
  /** Why this rung was chosen, and — when unstable — what that costs. */
  readonly why: string;
}

/** Every seam {@link smeltInvocation} reads, so a test never touches the real machine. */
export interface SmeltInvocationOptions {
  readonly env?: InvocationEnv;
  readonly fs?: InvocationFs;
  /** The package `dist` directory to derive script paths from. */
  readonly distDir?: string;
}

/**
 * The ranking, best first:
 *
 *  1. **`smelt` on PATH.** A name, not a path: nothing an upgrade does can move it.
 *  2. **The stable path of this package's own `dist/cli/bin.js`.** A local (non-global)
 *     `npm install` puts no `smelt` on anyone's PATH, so a written command must name
 *     the script — through the Homebrew `opt` alias where there is one, and otherwise
 *     through a path an upgrade replaces in place rather than deleting.
 *  3. **The versioned keg path.** Reached only when the package lives in a Homebrew
 *     keg whose `opt` alias is missing or already points at another version. It works
 *     now and stops working at the next `brew upgrade`; `stable` is false and `why`
 *     says what to do about it.
 */
export function smeltInvocation(options: SmeltInvocationOptions = {}): SmeltInvocation {
  const fs = options.fs ?? NODE_FS;
  const onPath = smeltOnPath(options.env ?? process.env, fs);
  if (onPath !== undefined) {
    return {
      kind: 'path',
      command: 'smelt',
      bin: onPath,
      stable: true,
      why: `\`smelt\` is on PATH (${onPath}) — a name no upgrade moves`,
    };
  }
  const distDir = options.distDir ?? packageDistDir();
  const bin = join(distDir, 'cli', 'bin.js');
  const script = stableScriptPath(bin, fs);
  const keg = kegPath(script);
  return {
    kind: 'node',
    command: `node "${script}"`,
    script,
    bin: script,
    stable: keg === undefined,
    why:
      keg === undefined
        ? script === bin
          ? `no \`smelt\` on PATH — naming this package's own ${script}, which an ` +
            `upgrade replaces in place`
          : `no \`smelt\` on PATH — naming ${script}, the alias Homebrew re-points on upgrade`
        : `no \`smelt\` on PATH and no \`${keg.prefix}/opt/${keg.name}\` alias resolving to ` +
          `${keg.keg} — ${script} is a versioned path that the next upgrade deletes`,
  };
}
