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
 * A **version-bearing** run in a path: a directory whose *name* carries a release, so
 * installing the next release writes a different directory and removes this one.
 *
 * Recognised shapes, each one a real install layout smelt is distributed through:
 *
 *  - `…/.pnpm/<name>@<version>/…` — pnpm's content-addressed store, which a global
 *    `pnpm add -g` installs into. `pnpm update` writes a new store entry and prunes
 *    the old.
 *  - `…/versions/node/<v>/…` — nvm's and volta's per-Node-version trees. A global
 *    install lives under the Node it was installed with; `nvm uninstall` and volta's
 *    pruning both take the whole subtree.
 *
 * A Homebrew keg is version-bearing too, but it is handled separately in
 * {@link pathStability} because it is the one shape with a **repair**: the `opt`
 * alias. This list is what smelt can *recognise*; it is not a claim that anything
 * else is permanent, which is exactly what the stable verdict's wording says.
 */
function versionedSegment(path: string): string | undefined {
  const segments = path.split('/');
  const pnpmAt = segments.indexOf('.pnpm');
  if (pnpmAt >= 0 && pnpmAt + 1 < segments.length) {
    return `the pnpm store entry ${segments.slice(0, pnpmAt + 2).join('/')}, whose directory name carries the version`;
  }
  for (let at = 0; at + 2 < segments.length; at += 1) {
    if (segments[at] === 'versions' && segments[at + 1] === 'node') {
      return `the version-pinned Node tree ${segments.slice(0, at + 3).join('/')}`;
    }
  }
  return undefined;
}

/**
 * Whether a path smelt is about to write into somebody's config file will still be
 * there after an upgrade — and the spelling to write.
 *
 * The one derivation of that verdict, because it is asked about **every** script the
 * installer names, not only the CLI binary: the guard shim (the security-relevant
 * one), the guard core the opencode plugin imports, and `cli/bin.js`. An earlier cut
 * of this checked the invocation *value* instead, which is stable whenever `smelt` is
 * on PATH — so on a keg with a broken alias the lifecycle hooks were reported fine
 * while the guard hook was written as a bare Cellar path with nothing said.
 *
 * Homebrew keeps each release in its own versioned keg and points one alias at the
 * current one: `<prefix>/opt/<name>` → `<prefix>/Cellar/<name>/<version>`. A config
 * file holding the keg spelling names a directory `brew upgrade` deletes; the alias
 * is re-pointed instead. So when the path runs through a keg, the sibling alias
 * exists, and the alias resolves to *this* keg, the alias spelling is returned and the
 * verdict is stable. An alias that is missing, or has already moved to another
 * version, proves nothing about this path — the input is returned unchanged and the
 * verdict is **unstable**, which is the whole reason this function exists.
 *
 * The prefix is derived from the path, so `/opt/homebrew`, `/usr/local` and
 * `/home/linuxbrew/.linuxbrew` all work without any of them being written down.
 *
 * `stable: true` is deliberately **not** a promise that an upgrade keeps the path —
 * nothing here can know a packaging manager's policy. It means only that this module
 * recognises nothing in the path that says otherwise, and `why` says exactly that.
 */
export function pathStability(path: string, fs: InvocationFs = NODE_FS): PathStability {
  const keg = kegPath(path);
  if (keg !== undefined) {
    const alias = `${keg.prefix}/opt/${keg.name}`;
    if (fs.existsSync(alias) && isSameFile(alias, keg.keg, fs)) {
      const aliased = [alias, ...keg.rest].join('/');
      return {
        path: aliased,
        stable: true,
        why: `${alias} is the alias Homebrew re-points on upgrade, so ${aliased} outlives this release`,
      };
    }
    return {
      path,
      stable: false,
      why:
        `${path} is a versioned Homebrew keg and no ${alias} alias resolves to ` +
        `${keg.keg} — the next \`brew upgrade\` deletes it`,
    };
  }
  const versioned = versionedSegment(path);
  if (versioned !== undefined) {
    return {
      path,
      stable: false,
      why: `${path} runs through ${versioned} — installing the next release writes a different directory and removes this one`,
    };
  }
  return {
    path,
    stable: true,
    why: `nothing in ${path} names a version, so nothing here proves an upgrade moves it — nor that it keeps it`,
  };
}

/** {@link pathStability}'s answer: the spelling to write, and what is known about it. */
export interface PathStability {
  /** The spelling to write down — the proven alias, or the input unchanged. */
  readonly path: string;
  /** False only where this module recognises a version-bearing segment. */
  readonly stable: boolean;
  /** Why, in words a receipt can print — honest about what it cannot prove. */
  readonly why: string;
}

/**
 * The spelling of `realPath` that survives an upgrade — {@link pathStability}'s path
 * half, for the callers that want the string and not the verdict.
 */
export function stableScriptPath(realPath: string, fs: InvocationFs = NODE_FS): string {
  return pathStability(realPath, fs).path;
}

/**
 * The bare name a `kind: 'path'` invocation runs, and the one spelling of it.
 *
 * Written into hook commands by `harness/hook-command.ts` and read back by the same
 * module's parser, so the name the ranking chose and the name a config file carries
 * cannot come apart. (On Windows the *file* is `smelt.cmd`/`smelt.exe`; the name a
 * shell resolves is still this one.)
 */
export const SMELT_COMMAND_NAME = 'smelt';

/**
 * Which machine this is, as data rather than as a global read.
 *
 * The values `process.platform` can take, written out rather than spelled `NodeJS.Platform`
 * — this module states every type it needs structurally (see {@link InvocationEnv}) and
 * imports nothing but node builtins. Closed on purpose: a `string` here would take a
 * mistyped `'win-32'` without complaint and quietly answer it on the posix branch, which
 * is the failure this parameter exists to make visible. `process.platform` is assignable
 * to it, so the default costs no cast.
 *
 * It is injectable because the Windows branch below is real behaviour that no run of
 * this suite on any developer's machine or in CI would ever execute, and an untested
 * branch in the module that decides what gets written into somebody's config file is
 * the wrong branch to leave unwatched.
 */
export type InvocationPlatform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32';

/** `smelt.cmd`/`smelt.exe` on Windows, `smelt` everywhere else. */
function executableNames(platform: InvocationPlatform): readonly string[] {
  return platform === 'win32'
    ? [`${SMELT_COMMAND_NAME}.cmd`, `${SMELT_COMMAND_NAME}.exe`]
    : [SMELT_COMMAND_NAME];
}

/**
 * The absolute path of an executable `smelt` on PATH, or `undefined`.
 *
 * One stat per PATH directory, no spawn: this runs on the guard's hot path, and
 * `which smelt` would cost a process to learn a filesystem fact. A non-Windows
 * candidate must carry an execute bit — a `smelt` that nobody may run is not on PATH
 * in the only sense a written command cares about. On Windows there is no execute bit
 * to read (`stat.mode`'s permission bits are the read-only flag and nothing else), so
 * the check is skipped rather than answered wrongly: every candidate there would fail
 * it, and `smelt` would be reported as not on PATH on every Windows machine.
 */
export function smeltOnPath(
  env: InvocationEnv = process.env,
  fs: InvocationFs = NODE_FS,
  platform: InvocationPlatform = process.platform,
): string | undefined {
  const search = env['PATH'] ?? env['Path'] ?? env['path'];
  if (search === undefined || search === '') return undefined;
  for (const dir of search.split(delimiter)) {
    if (dir === '') continue;
    for (const name of executableNames(platform)) {
      const candidate = join(dir, name);
      try {
        const stat = fs.statSync(candidate);
        if (!stat.isFile()) continue;
        if (platform !== 'win32' && (stat.mode & 0o111) === 0) continue;
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
export function stableShimPath(
  profileId: string,
  distDir: string = packageDistDir(),
  fs: InvocationFs = NODE_FS,
): string {
  return stableScriptPath(join(distDir, 'hooks', 'shims', `${profileId}.js`), fs);
}

/** The guard core as a module — what the opencode plugin imports at hook time. */
export function stableGuardCorePath(
  distDir: string = packageDistDir(),
  fs: InvocationFs = NODE_FS,
): string {
  return stableScriptPath(join(distDir, 'hooks', 'guard-core.js'), fs);
}

/** The `smelt` binary, in the spelling that survives an upgrade. */
export function stableBinPath(
  distDir: string = packageDistDir(),
  fs: InvocationFs = NODE_FS,
): string {
  return stableScriptPath(join(distDir, 'cli', 'bin.js'), fs);
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
  /**
   * False where a version-bearing segment is recognised in the path this command
   * names. True is the weaker statement it sounds like: nothing recognised says the
   * path moves. See {@link pathStability} — nothing here can know a packaging
   * manager's policy, and `why` never claims to.
   */
  readonly stable: boolean;
  /** Why this rung was chosen, and — when unstable — what that costs. */
  readonly why: string;
  /**
   * One line worth printing even though the command works: today, that the `smelt`
   * on PATH is not the install that wrote it. The ranking does not change — a name on
   * PATH is still the spelling that survives most — but a receipt that stayed silent
   * would let a machine with two smelts look like a machine with one.
   */
  readonly caveat?: string;
}

/** Every seam {@link smeltInvocation} reads, so a test never touches the real machine. */
export interface SmeltInvocationOptions {
  readonly env?: InvocationEnv;
  readonly fs?: InvocationFs;
  /** The package `dist` directory to derive script paths from. */
  readonly distDir?: string;
  /** Which machine this is. Defaults to the running one; a test names the other. */
  readonly platform?: InvocationPlatform;
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
  const distDir = options.distDir ?? packageDistDir();
  const bin = join(distDir, 'cli', 'bin.js');
  const onPath = smeltOnPath(options.env ?? process.env, fs, options.platform ?? process.platform);
  if (onPath !== undefined) {
    // Which smelt is it? A `smelt` on PATH normally links straight into this very
    // package (npm's bin shim, Homebrew's `bin/smelt`), and then there is nothing to
    // say. When it resolves somewhere else it is another install — or a wrapper
    // script this module cannot see through — and either way the commands written
    // here will run *that* one. The ranking does not move; the receipt gains a line.
    const sameInstall = isSameFile(onPath, bin, fs);
    return {
      kind: 'path',
      command: SMELT_COMMAND_NAME,
      bin: onPath,
      stable: true,
      why: `\`smelt\` is on PATH (${onPath}) — a name no upgrade moves`,
      ...(sameInstall
        ? {}
        : {
            caveat:
              `the \`smelt\` on PATH (${onPath}) does not resolve to this install's ` +
              `${bin} — it is either another copy or a wrapper script, and it is the one ` +
              `these commands will run`,
          }),
    };
  }
  const stability = pathStability(bin, fs);
  const script = stability.path;
  return {
    kind: 'node',
    command: `node "${script}"`,
    script,
    bin: script,
    stable: stability.stable,
    why: `no \`smelt\` on PATH — naming ${script}: ${stability.why}`,
  };
}
