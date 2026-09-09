import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_FILE_NAME, findConfigFile, parseConfig } from './config.ts';
import type { SmeltConfig } from './config.ts';
import { jsonHooksContainOurs, parseHookEntries } from '../harness/hook-command.ts';
import type { HookEntry } from '../harness/hook-command.ts';
import type { HarnessInstallStep, HarnessProfile } from '../harness/profile.ts';
import { HARNESS_PROFILES, JSON_HOOK_FILE_NAMES } from '../harness/registry.ts';
import { instructionArtefact, locateStep } from '../harness/scope.ts';
import type { InstallScope, ScopeRoots } from '../harness/scope.ts';
import { OURS_TOKEN, SNIPPET_START_MD, snippetStampVersion } from '../harness/snippet.ts';
import { hasTomlEntry } from '../text/toml-edit.ts';

/**
 * The one reader of InstalledState (CONTEXT.md): everything smelt has written to a
 * project, as data. The write side has been one seam since the profiles —
 * `planInstall`/`planRemove` fold over `HarnessProfile.install` — but the read side
 * grew three shallow readers (doctor, the hooks preset's toggle reading, setup's
 * repair policy), and one had already drifted: doctor's text-level token search
 * could not see a guard-only install, because the guard command carries no token.
 * `jsonHooksContainOurs` fixed that instance; this module is the structural fix —
 * the disk facts live once, and the consumers bring only their verdicts.
 *
 * Reads only. Nothing here writes, and nothing here decides: "behind" is a verdict
 * against a binary version (doctor's), "repair" is a policy (setup's) — the reader
 * states what is on disk and stops there. The recogniser it reads *with* is
 * `harness/hook-command.ts`, not `cli/hooks.ts`: the parser has no writer in it, so
 * the reader no longer has to import the installer to know what an entry says.
 */

/** One instruction block found on disk, with the release that wrote it. */
export interface InstalledBlock {
  readonly file: string;
  /** The harness profiles whose instruction file this is (often exactly one). */
  readonly harnesses: readonly string[];
  /** The release that wrote it, or `undefined` when it predates stamping. */
  readonly installedBy?: string;
  /** False for whole-owned files that carry the token but no marker block. */
  readonly stampable: boolean;
}

/** One MCP registration a profile declares, checked on disk. */
export interface InstalledMcp {
  readonly file: string;
  readonly server: string;
  readonly registered: boolean;
  /**
   * The command that performs this registration where the file is the harness's own
   * to rewrite and not smelt's to edit — Claude Code's `~/.claude.json` at user scope.
   * Absent for a registration smelt writes itself, which is every project-scope one.
   */
  readonly manual?: string;
}

/** The config as it sits: present, parseable, or malformed (a finding, not a crash). */
export interface InstalledConfig {
  readonly present: boolean;
  readonly malformed?: boolean;
  /** The parse failure's own message, when the config is malformed. */
  readonly malformedWhy?: string;
  readonly parsed?: SmeltConfig;
  readonly path?: string;
}

/**
 * One JSON hook file of a harness's, with the commands of ours it carries — read as
 * {@link HookEntry} values, not as text.
 *
 * Guard-only files (Cline's executable hook, Hermes's YAML, the opencode plugin) are
 * deliberately absent: they are files smelt owns *whole*, not event-to-entry tables,
 * so there is no event to name and inventing one would be a fact nobody read. They
 * still appear in {@link InstalledState.hookFiles}, exactly as before.
 */
export interface InstalledHookFile {
  readonly file: string;
  /** The harness whose file this is — each JSON hook file belongs to exactly one. */
  readonly harness: string;
  readonly entries: readonly HookEntry[];
}

/** Everything the readers need, in one reading. */
export interface InstalledState {
  readonly blocks: readonly InstalledBlock[];
  /**
   * The names of every hook file carrying entries of ours. A `string[]` on purpose:
   * it is what the `smelt.doctor.v1` receipt has always carried, and a receipt field
   * may gain a sibling but never change shape.
   */
  readonly hookFiles: readonly string[];
  /** The same wiring, read as commands — {@link hookFiles}'s structured sibling. */
  readonly hooks: readonly InstalledHookFile[];
  readonly mcp: readonly InstalledMcp[];
  readonly config: InstalledConfig;
}

/**
 * Whether a file's current bytes already carry entries of smelt's — the one
 * "ours" predicate for a file by name: the entry-level check for JSON hook files
 * (the guard command carries only a shim path), the token for everything else.
 */
export function fileIsOurs(name: string, text: string): boolean {
  return JSON_HOOK_FILE_NAMES.includes(name)
    ? jsonHooksContainOurs(text)
    : text.includes(OURS_TOKEN);
}

/**
 * Everything installed, read once. Pure reads; safe to call on any directory.
 *
 * Every path goes through `locateStep` — the same resolver the installer wrote with —
 * so a user-scope reading looks at `~/.claude/settings.json` and a project-scope one
 * is unchanged. Reading from the project spellings while the writer used the user ones
 * is how doctor and setup would agree an install is healthy while nothing is wired.
 */
export function readInstalledState(
  cwd: string,
  where: { readonly scope?: InstallScope; readonly home?: string } = {},
): InstalledState {
  const scope: InstallScope = where.scope ?? 'project';
  const home = where.home ?? homedir();
  const rootsFor = (harness: string): ScopeRoots => ({ cwd, home, harness });

  // ── instruction blocks: every profile's instruction file that exists and is ours ──
  const owners = new Map<string, { name: string; harnesses: string[] }>();
  for (const profile of Object.values(HARNESS_PROFILES)) {
    const located = locateStep(instructionArtefact(profile), scope, rootsFor(profile.name));
    if (located.path === undefined || located.name === undefined) continue;
    const entry = owners.get(located.path) ?? { name: located.name, harnesses: [] };
    entry.harnesses.push(profile.id);
    owners.set(located.path, entry);
  }
  const blocks: InstalledBlock[] = [];
  for (const [path, { name, harnesses }] of owners) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(OURS_TOKEN)) continue;
    const installedBy = snippetStampVersion(text);
    blocks.push({
      file: name,
      harnesses,
      ...(installedBy === undefined ? {} : { installedBy }),
      stampable: text.includes(SNIPPET_START_MD),
    });
  }

  // ── hook wiring: JSON hook files and guard-only shims that carry our entries ──
  //
  // **Two passes, in this order**, and it is not incidental: `hookFiles` is what
  // `smelt.doctor.v1` carries and what doctor's prose lists, and it has always been
  // every JSON hook file followed by every guard-only file (the shape of the old
  // `[...JSON_HOOK_FILES, ...GUARD_ONLY_FILES]` walk). A single profile-by-profile fold
  // reads the same set but interleaves them — `.hermes/hooks.yaml` ahead of
  // `.cursor/hooks.json` — which is a receipt field changing shape for a reason that has
  // nothing to do with what is installed.
  const hookFiles: string[] = [];
  const hooks: InstalledHookFile[] = [];
  const seenHookPaths = new Set<string>();
  const readHookStep = (
    profile: HarnessProfile,
    step: HarnessInstallStep,
    isJson: boolean,
  ): void => {
    const located = locateStep(step, scope, rootsFor(profile.name));
    if (located.path === undefined || located.name === undefined) return;
    if (seenHookPaths.has(located.path)) return;
    seenHookPaths.add(located.path);
    if (!existsSync(located.path)) return;
    const text = readFileSync(located.path, 'utf8');
    if (isJson ? !jsonHooksContainOurs(text) : !text.includes(OURS_TOKEN)) return;
    hookFiles.push(located.name);
    if (isJson) {
      hooks.push({ file: located.name, harness: profile.id, entries: parseHookEntries(text) });
    }
  };
  for (const profile of Object.values(HARNESS_PROFILES)) {
    for (const step of profile.install) {
      if (step.kind === 'json-hooks') readHookStep(profile, step, true);
    }
  }
  for (const profile of Object.values(HARNESS_PROFILES)) {
    for (const step of profile.install) {
      if (step.kind === 'own-file' && step.guardOnly) readHookStep(profile, step, false);
    }
  }

  // ── MCP registrations: every profile's declared step, checked on disk ──
  const mcp = new Map<string, InstalledMcp>();
  for (const profile of Object.values(HARNESS_PROFILES)) {
    for (const step of profile.install) {
      if (step.kind !== 'mcp-registration' && step.kind !== 'toml-mcp-registration') continue;
      const located = locateStep(step, scope, rootsFor(profile.name));
      if (located.path === undefined || located.name === undefined) continue;
      const key = `${located.path}·${step.path[1]}`;
      if (mcp.has(key)) continue;
      // A `manual` registration is read exactly like any other — the file is the
      // harness's to write, not ours, and doctor's job is to say whether the entry is
      // there. Reading is never writing (ADR-0003).
      mcp.set(key, {
        file: located.name,
        server: step.path[1],
        registered:
          step.kind === 'mcp-registration'
            ? mcpEntryRegistered(located.path, step.path)
            : tomlMcpEntryRegistered(located.path, step.path),
        ...(located.manual === undefined ? {} : { manual: located.manual }),
      });
    }
  }

  // ── the config ──
  // At user scope the config is `~/smelt.config.json`, decided rather than discovered:
  // that one file is what every project below the home directory finds by walking up,
  // and walking up from `~` looking for somebody else's would defeat the point.
  const configPath =
    scope === 'user' ? existingOrUndefined(join(home, CONFIG_FILE_NAME)) : findConfigFile(cwd);
  let config: InstalledConfig = { present: false };
  if (configPath !== undefined) {
    try {
      config = {
        present: true,
        path: configPath,
        parsed: parseConfig(readFileSync(configPath, 'utf8'), configPath),
      };
    } catch (error) {
      config = {
        present: true,
        malformed: true,
        malformedWhy: error instanceof Error ? error.message : String(error),
        path: configPath,
      };
    }
  }

  return { blocks, hookFiles, hooks, mcp: [...mcp.values()], config };
}

/** A path when it exists, `undefined` when it does not — the config's own presence. */
function existingOrUndefined(path: string): string | undefined {
  return existsSync(path) ? path : undefined;
}

/** The server entry a profile declares, present and parseable on disk or not. */
function mcpEntryRegistered(full: string, path: readonly [string, string]): boolean {
  if (!existsSync(full)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(full, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return false;
    const container = (parsed as Record<string, unknown>)[path[0]];
    if (typeof container !== 'object' || container === null) return false;
    return (container as Record<string, unknown>)[path[1]] !== undefined;
  } catch {
    return false;
  }
}

/** {@link mcpEntryRegistered}'s TOML sibling — table form or dotted form, either counts. */
function tomlMcpEntryRegistered(full: string, path: readonly [string, string]): boolean {
  if (!existsSync(full)) return false;
  return hasTomlEntry(readFileSync(full, 'utf8'), path);
}
