import { isAbsolute, relative, sep } from 'node:path';

import { stableBinPath, stableGuardCorePath, stableShimPath } from '../hooks/invocation.ts';

import type { ShimmedHarnessProfile } from './profile.ts';

/**
 * Where the scripts a harness config points at actually live, and how a profile names
 * one. Path facts only — nothing here reads or writes a file.
 *
 * The script paths themselves are `hooks/invocation.ts`'s, not this file's: "where is
 * the shipped `dist`" and "which spelling of it survives an upgrade" are the same
 * fact, and it has to be answerable from the guard's own zero-import module (the deny
 * reason quotes a command too). What stays here is what only a *writer* needs — the
 * profile-to-script mapping, and how a config file spells a command.
 */

/**
 * The shim script a harness's hook command runs. Takes a profile rather than an id,
 * because only a profile that carries a hook schema (or a hand-written adapter) has a
 * shim script on disk: a path for a harness that ships none would name a file the
 * build never produced.
 */
export function shimScriptPath(profile: ShimmedHarnessProfile, distDir?: string): string {
  return distDir === undefined ? stableShimPath(profile.id) : stableShimPath(profile.id, distDir);
}

/** The guard core as a module: what the opencode plugin imports at hook time. */
export function guardCoreScriptPath(distDir?: string): string {
  return distDir === undefined ? stableGuardCorePath() : stableGuardCorePath(distDir);
}

/** The `smelt` binary — quoted into the stats and map hook commands. */
export function smeltBinPath(distDir?: string): string {
  return distDir === undefined ? stableBinPath() : stableBinPath(distDir);
}

/**
 * Inside the project, a project-relative path travels with the repo; outside,
 * absolute. `undefined` is the user scope's root — there is none, because a
 * machine-level config travels with nothing and its hooks run from whatever project
 * the agent opened, so every path it names is absolute (`renderRoot` in
 * `harness/scope.ts` is what hands this `undefined`).
 */
export function portablePath(root: string | undefined, absolute: string): string {
  if (root === undefined) return absolute;
  const rel = relative(root, absolute);
  return rel.startsWith('..') || isAbsolute(rel) ? absolute : rel.split(sep).join('/');
}

/** `node "<script>"` — how every harness config invokes something of smelt's. */
export function nodeCommand(root: string | undefined, script: string, args = ''): string {
  return `node "${portablePath(root, script)}"${args === '' ? '' : ` ${args}`}`;
}
