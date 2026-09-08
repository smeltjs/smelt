import { realpathSync } from 'node:fs';
import { join } from 'node:path';

import type { HarnessInstallStep, HarnessProfile, HarnessUserLocation } from './profile.ts';

/**
 * Where an install goes: this project, or this machine.
 *
 * Every artefact `hooks install` writes used to be a bare relative path joined to
 * `cwd` — at write time and, separately, at read time. That is right for a project
 * install and wrong for the only way to get one config and one store for every project
 * on a machine, which is to run setup from `$HOME`: config discovery walks up, so a
 * config at `~` is found from anywhere below it. Run from there, the old installer
 * wrote `~/CLAUDE.md`, `~/.mcp.json`, `~/AGENTS.md`, `~/GEMINI.md`, `~/opencode.json`
 * — files no harness reads at that level. Claude Code reads `~/.claude/CLAUDE.md`,
 * Codex reads `~/.codex/AGENTS.md`, Gemini reads `~/.gemini/GEMINI.md`, opencode reads
 * `~/.config/opencode/opencode.json`. Doctor read from the same wrong places, so both
 * agreed the install was healthy.
 *
 * So the user-level location is a **per-harness fact**, declared on the profile beside
 * the project path ({@link HarnessUserLocation}), and this module is the one resolver
 * every writer and every reader goes through: {@link locateStep}. A harness that
 * documents no user-level location for an artefact is *skipped with a reason* — never
 * silently written to `cwd`, which would be the same defect one directory over.
 *
 * Nothing here writes. Paths in, paths out — the one read is the `realpath` pair
 * {@link detectScope} compares, and it is injectable.
 */

/** This project, or this machine. */
export type InstallScope = 'project' | 'user';

/** Both scopes, in the order every rendered list and every refusal walks them. */
export const INSTALL_SCOPES: readonly InstallScope[] = ['project', 'user'];

/**
 * What an install step or the instruction layer is, for the sentence that says a
 * harness documents no user-level home for it.
 */
export type ArtefactKind = HarnessInstallStep['kind'] | 'instructions';

/** One artefact, at whatever scope it is being located: its two possible homes. */
export interface ScopedArtefact {
  readonly kind: ArtefactKind;
  /** Project-relative path — exactly what {@link HarnessInstallStep.file} carries. */
  readonly file: string;
  /** The documented user-level home, or absent for an artefact that has none. */
  readonly user?: HarnessUserLocation;
}

/** The two roots a scope chooses between, and how a refusal names the harness. */
export interface ScopeRoots {
  /** The project directory. */
  readonly cwd: string;
  /** The user's home directory. Injected in tests; never the real one there. */
  readonly home: string;
  /** The harness's own name, for the skip reason. */
  readonly harness?: string;
}

/**
 * Where one artefact lives at one scope.
 *
 * `path` is **absent exactly when** `skipped` is set, and that is load-bearing: a
 * caller cannot fall back to `join(cwd, step.file)` at user scope by forgetting a
 * check, because there is no path to write and the compiler says so. Silently writing
 * the project spelling into the home directory is the defect this module exists to
 * end, not a degraded mode to keep available.
 */
export interface LocatedStep {
  /** Absolute path, at this scope. Absent when {@link skipped} says why there is none. */
  readonly path?: string;
  /** The display spelling, relative to the scope's own root. Absent with {@link path}. */
  readonly name?: string;
  /** Why this artefact has no home at this scope — a sentence, shown to the user. */
  readonly skipped?: string;
  /**
   * Present when the location exists but is **not ours to write**: the harness owns
   * and rewrites that file. The value is the exact command a human runs instead;
   * setup prints it, and doctor reads the file back and nothing more.
   */
  readonly manual?: string;
}

/** How the skip reason names each kind of artefact. */
const KIND_LABEL: Readonly<Record<ArtefactKind, string>> = {
  'json-hooks': 'hook file',
  'marker-block': 'config file',
  'own-file': 'hook file',
  'mcp-registration': 'MCP registration',
  'toml-mcp-registration': 'MCP registration',
  instructions: 'instruction file',
};

/**
 * The one resolver: where does this artefact go at this scope?
 *
 * Project scope returns exactly what the installer has always computed —
 * `join(cwd, step.file)` — so a project install is byte-identical to before this
 * module existed. User scope returns `join(home, step.user.file)`, the location that
 * harness's own documentation names, or a skip reason when it documents none.
 */
export function locateStep(
  step: ScopedArtefact,
  scope: InstallScope,
  roots: ScopeRoots,
): LocatedStep {
  if (scope === 'project') return { path: join(roots.cwd, step.file), name: step.file };
  const user = step.user;
  if (user === undefined) {
    return {
      skipped: `${roots.harness ?? 'this harness'} has no documented user-level ${KIND_LABEL[step.kind]}`,
    };
  }
  return {
    path: join(roots.home, user.file),
    name: user.file,
    ...(user.manual === undefined ? {} : { manual: user.manual }),
  };
}

/**
 * The instruction layer as an artefact {@link locateStep} can answer for. The
 * standing-instructions file is not an install step — it is its own field on the
 * profile — but it is located by the same rule, so it is spelled as one here rather
 * than resolved a second way in the installer.
 */
export function instructionArtefact(profile: HarnessProfile): ScopedArtefact {
  return {
    kind: 'instructions',
    file: profile.instructionFile,
    ...(profile.userInstructionFile === undefined
      ? {}
      : { user: { file: profile.userInstructionFile } }),
  };
}

/**
 * The directory a scope's paths are relative to: the project, or the home directory.
 * Display names and the config's own location are spelled against it.
 */
export function scopeRoot(
  scope: InstallScope,
  roots: { readonly cwd: string; readonly home: string },
): string {
  return scope === 'user' ? roots.home : roots.cwd;
}

/**
 * The root a path *embedded in a written command* is spelled relative to — and
 * `undefined` at user scope, meaning "absolute, always".
 *
 * A project-relative script path travels with the repo, which is why it is the
 * project spelling. A user-scope hook has no repo to travel with and runs with its
 * cwd set to whatever project the agent opened, so a relative path there would name a
 * file that is not here. Two different questions, two different roots: this one, and
 * {@link scopeRoot}.
 */
export function renderRoot(
  scope: InstallScope,
  roots: { readonly cwd: string },
): string | undefined {
  return scope === 'user' ? undefined : roots.cwd;
}

/**
 * The scope a run gets when nobody named one: `user` when the working directory *is*
 * the home directory, `project` everywhere else.
 *
 * Compared through `realpath`, because `/home/me` and a symlinked `/Users/me` are the
 * same directory and a string compare would say otherwise — the same reason
 * `isSameFile` exists one module over. A path that cannot be realpath'd (it does not
 * exist) falls back to its own spelling rather than throwing: detection is a default,
 * and a default that crashes is worse than a default that is wrong.
 */
export function detectScope(
  roots: { readonly cwd: string; readonly home: string },
  realpath: (path: string) => string = defaultRealpath,
): InstallScope {
  return realpath(roots.cwd) === realpath(roots.home) ? 'user' : 'project';
}

/** The scope this run uses: what the caller asked for, else what detection found. */
export function resolveScope(
  flag: InstallScope | undefined,
  roots: { readonly cwd: string; readonly home: string },
  realpath?: (path: string) => string,
): InstallScope {
  return flag ?? detectScope(roots, realpath);
}

function defaultRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
