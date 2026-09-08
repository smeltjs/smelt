import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { findConfigFile, parseConfig } from './config.ts';
import type { SmeltConfig } from './config.ts';
import { jsonHooksContainOurs, parseHookEntries } from '../harness/hook-command.ts';
import type { HookEntry } from '../harness/hook-command.ts';
import { GUARD_ONLY_FILES, HARNESS_PROFILES, JSON_HOOK_FILES } from '../harness/registry.ts';
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
  return JSON_HOOK_FILES.includes(name) ? jsonHooksContainOurs(text) : text.includes(OURS_TOKEN);
}

/** Everything installed, read once. Pure reads; safe to call on any directory. */
export function readInstalledState(cwd: string): InstalledState {
  // ── instruction blocks: every profile's instruction file that exists and is ours ──
  const owners = new Map<string, string[]>();
  for (const profile of Object.values(HARNESS_PROFILES)) {
    const list = owners.get(profile.instructionFile) ?? [];
    list.push(profile.id);
    owners.set(profile.instructionFile, list);
  }
  const blocks: InstalledBlock[] = [];
  for (const [file, harnesses] of owners) {
    const path = join(cwd, file);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!text.includes(OURS_TOKEN)) continue;
    const installedBy = snippetStampVersion(text);
    blocks.push({
      file,
      harnesses,
      ...(installedBy === undefined ? {} : { installedBy }),
      stampable: text.includes(SNIPPET_START_MD),
    });
  }

  // ── hook wiring: JSON hook files and guard-only shims that carry our entries ──
  const hookFiles: string[] = [];
  const hooks: InstalledHookFile[] = [];
  for (const name of [...JSON_HOOK_FILES, ...GUARD_ONLY_FILES]) {
    const path = join(cwd, name);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    if (!fileIsOurs(name, text)) continue;
    hookFiles.push(name);
    const harness = jsonHookFileOwner(name);
    if (harness !== undefined) {
      hooks.push({ file: name, harness, entries: parseHookEntries(text) });
    }
  }

  // ── MCP registrations: every profile's declared step, checked on disk ──
  const mcp = new Map<string, InstalledMcp>();
  for (const profile of Object.values(HARNESS_PROFILES)) {
    for (const step of profile.install) {
      if (step.kind !== 'mcp-registration' && step.kind !== 'toml-mcp-registration') continue;
      const key = `${step.file}·${step.path[1]}`;
      if (mcp.has(key)) continue;
      mcp.set(key, {
        file: step.file,
        server: step.path[1],
        registered:
          step.kind === 'mcp-registration'
            ? mcpEntryRegistered(cwd, step.file, step.path)
            : tomlMcpEntryRegistered(cwd, step.file, step.path),
      });
    }
  }

  // ── the config ──
  const configPath = findConfigFile(cwd);
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

/**
 * The harness whose `json-hooks` step declares this file, or `undefined` when no step
 * does (a guard-only file, which is nobody's event table). Derived from the registry:
 * a harness that starts writing a new settings file is read back by existing.
 */
function jsonHookFileOwner(file: string): string | undefined {
  for (const profile of Object.values(HARNESS_PROFILES)) {
    for (const step of profile.install) {
      if (step.kind === 'json-hooks' && step.file === file) return profile.id;
    }
  }
  return undefined;
}

/** The server entry a profile declares, present and parseable on disk or not. */
function mcpEntryRegistered(cwd: string, file: string, path: readonly [string, string]): boolean {
  const full = join(cwd, file);
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
function tomlMcpEntryRegistered(
  cwd: string,
  file: string,
  path: readonly [string, string],
): boolean {
  const full = join(cwd, file);
  if (!existsSync(full)) return false;
  return hasTomlEntry(readFileSync(full, 'utf8'), path);
}
