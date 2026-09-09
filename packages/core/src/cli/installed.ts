import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CONFIG_FILE_NAME, findConfigFile, parseConfig } from '../config.ts';
import type { SmeltConfig } from '../config.ts';
import {
  hookEntryCommands,
  isOursEntry,
  jsonHooksContainOurs,
  ownFileEntry,
  parseHookCommand,
  parseHookEntries,
} from '../harness/hook-command.ts';
import type { HookCommand, HookEntry } from '../harness/hook-command.ts';
import type {
  HarnessInstallStep,
  HarnessOwnFileProbe,
  HarnessProfile,
} from '../harness/profile.ts';
import {
  GUARD_EVENTS,
  HARNESS_PROFILES,
  HARNESSES,
  JSON_HOOK_FILE_NAMES,
  LIFECYCLE_EVENTS,
  MANAGED_EVENTS,
} from '../harness/registry.ts';
import { readIfExists } from '../harness/plan.ts';
import { instructionArtefact, locateFormer, locateStep } from '../harness/scope.ts';
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
 * One hook file of a harness's, with the commands of ours it carries — read as
 * {@link HookEntry} values, not as text.
 *
 * Two shapes, one reading. A JSON hook file carries an event-to-entry table and yields
 * one entry per command of ours in it. A file smelt owns **whole** — Cline's executable
 * wrapper, Hermes's YAML, the opencode plugin — carries no table, so its profile
 * declares what it runs and how to ask it (`HarnessOwnFileProbe`), and it yields exactly
 * one entry under the event that harness calls it for. Those three used to be absent
 * here, which is the whole reason `smelt doctor` could say no more than a plain `wired`
 * about them: nothing had been read, so there was nothing to run.
 */
export interface InstalledHookFile {
  readonly file: string;
  /** The harness whose file this is — each hook file belongs to exactly one. */
  readonly harness: string;
  readonly entries: readonly HookEntry[];
  /**
   * Present for a file smelt owns whole: how to verify it, and where it is. The reader
   * resolved that path once — this scope's spelling, or the former one when that is
   * what is on disk — so nothing downstream resolves it a second way.
   */
  readonly own?: { readonly probe: HarnessOwnFileProbe; readonly path: string };
}

/**
 * A file of ours still sitting at an artefact's **former** name while today's name is
 * there too — what an upgrade leaves behind when a harness renames the directory it
 * loads from.
 *
 * It is a separate list rather than a second {@link InstalledHookFile} because it is a
 * different fact: not "this is how the guard is wired" but "this is a file smelt wrote
 * that nothing reads any more". Doctor reports it as an orphan; `remove` takes it out.
 */
export interface InstalledSuperseded {
  /** The former spelling, as the user sees it. */
  readonly file: string;
  /** The harness whose artefact it was, for the sentence and the repair command. */
  readonly harness: string;
  /** That harness's own name, as its makers spell it. */
  readonly harnessName: string;
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
  /** Files of ours left at a former name, with today's name written too. */
  readonly superseded: readonly InstalledSuperseded[];
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
  const superseded: InstalledSuperseded[] = [];
  const seenHookPaths = new Set<string>();
  const readHookStep = (
    profile: HarnessProfile,
    step: HarnessInstallStep,
    isJson: boolean,
  ): void => {
    const roots = rootsFor(profile.name);
    // Today's spelling, or — only when nothing is there — the one an earlier release
    // wrote (`locateFormer`). Falling back rather than reading both is what keeps an
    // existing install from being reported twice: one artefact, one file, whichever
    // name it is under. `remove` still takes both out.
    const here = locateStep(step, scope, roots);
    const former = locateFormer(step, scope, roots);
    const current = here.path !== undefined && existsSync(here.path);
    // Both names on disk: today's is the wiring, and the other one is a file smelt
    // wrote that nothing reads any more. It is *reported*, not silently preferred and
    // not silently forgotten — an upgrade leaves exactly this state behind.
    if (current && former?.path !== undefined && former.name !== undefined) {
      const stale = readIfExists(former.path);
      if (stale !== undefined && stale.includes(OURS_TOKEN)) {
        superseded.push({ file: former.name, harness: profile.id, harnessName: profile.name });
      }
    }
    const located = current ? here : (former ?? here);
    if (located.path === undefined || located.name === undefined) return;
    if (seenHookPaths.has(located.path)) return;
    seenHookPaths.add(located.path);
    if (!existsSync(located.path)) return;
    const text = readFileSync(located.path, 'utf8');
    if (isJson ? !jsonHooksContainOurs(text) : !text.includes(OURS_TOKEN)) return;
    hookFiles.push(located.name);
    if (isJson) {
      hooks.push({ file: located.name, harness: profile.id, entries: parseHookEntries(text) });
      return;
    }
    // A file smelt owns whole: its profile says what it runs and how to ask it, so the
    // reading yields the one entry it carries instead of stopping at the file's name.
    const probe = step.kind === 'own-file' ? step.probe : undefined;
    if (probe === undefined) return;
    hooks.push({
      file: located.name,
      harness: profile.id,
      entries: [ownFileEntry(probe, located.path, text)],
      own: { probe, path: located.path },
    });
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

  return { blocks, hookFiles, hooks, superseded, mcp: [...mcp.values()], config };
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

/* ------------------------------------------------------------------------------------
 * The four toggles, as installed
 * ---------------------------------------------------------------------------------- */

/** The four toggles this preset installs, as a value. */
export interface PresetToggles {
  readonly guard: boolean;
  readonly statsOnStop: boolean;
  readonly mapOnStart: boolean;
  readonly lintOnStart: boolean;
}

/**
 * The same four, as *flags* answered them: absent means "not named", which is a third
 * answer beside on and off — the install's own current state, read off disk.
 */
export type ToggleFlags = { readonly [K in keyof PresetToggles]?: boolean };

/**
 * The toggles a run installs: the wizard's defaults, overridden by whatever is
 * already installed for these harnesses, overridden by the flags. One derivation,
 * because `smelt setup --yes --map on` and `smelt hooks install --yes --map on` must
 * wire the same hook — and because a re-run that reset a toggle the user had set is
 * the toggle reader's standing failure mode, one layer up.
 */
export function withToggleFlags(base: PresetToggles, flags: ToggleFlags): PresetToggles {
  return {
    guard: flags.guard ?? base.guard,
    statsOnStop: flags.statsOnStop ?? base.statsOnStop,
    mapOnStart: flags.mapOnStart ?? base.mapOnStart,
    lintOnStart: flags.lintOnStart ?? base.lintOnStart,
  };
}

/**
 * A re-run reads the toggles back off what is actually installed — every JSON hook
 * file this installer writes, plus the guard-only shim files, both derived from the
 * registry — so it edits instead of resetting. Harnesses that only wire the guard
 * (gemini, grok, cursor, hermes, opencode, cline) persist no stats/map entries, so
 * after a re-run scoped to them those toggles read back as off; the defaults below
 * apply only when nothing of smelt's is installed at all.
 *
 * The two `SessionStart` toggles share one event, so they are told apart by **the
 * command each entry runs**, not by the key it sits under. Reading `SessionStart` as
 * one boolean would make a re-run with the map on and the lint off write both back —
 * or neither — which is a toggle the user believed they had set.
 *
 * Exported for `smelt setup`, which applies the preset's *current* state the same way
 * — read off what is installed — rather than keeping a second copy of the defaults.
 */
export function presetToggles(
  cwd: string,
  where: { readonly scope?: InstallScope; readonly home?: string } = {},
): PresetToggles {
  const defaults = { guard: true, statsOnStop: true, mapOnStart: false, lintOnStart: false };
  let anyOurs = false;
  let guard = false;
  let statsOnStop = false;
  let mapOnStart = false;
  let lintOnStart = false;

  const scope: InstallScope = where.scope ?? 'project';
  const home = where.home ?? homedir();
  // The files to read are derived from the registry through the same resolver the
  // installer wrote them with — never from a second list of names, which at user scope
  // would be the project spellings and would read every toggle back as off.
  const installedFiles = (kind: 'json-hooks' | 'guard-only'): readonly string[] => {
    const paths = new Set<string>();
    for (const profile of HARNESSES) {
      const roots: ScopeRoots = { cwd, home, harness: profile.name };
      for (const step of profile.install) {
        const wanted =
          kind === 'json-hooks'
            ? step.kind === 'json-hooks'
            : step.kind === 'own-file' && step.guardOnly;
        if (!wanted) continue;
        const located = locateStep(step, scope, roots);
        if (located.path !== undefined && located.manual === undefined) paths.add(located.path);
        // A former spelling counts as installed too: a re-run that read the toggles
        // back off today's name alone would see nothing on a machine set up by an
        // earlier release, and reset a guard the user has had on for months.
        const former = locateFormer(step, scope, roots);
        if (former?.path !== undefined) paths.add(former.path);
      }
    }
    return [...paths];
  };

  for (const path of installedFiles('json-hooks')) {
    const text = readIfExists(path);
    if (text === undefined) continue;
    let hooks: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(text);
      const hooksValue =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)['hooks']
          : undefined;
      hooks =
        typeof hooksValue === 'object' && hooksValue !== null && !Array.isArray(hooksValue)
          ? (hooksValue as Record<string, unknown>)
          : undefined;
    } catch {
      hooks = undefined;
    }
    if (hooks === undefined) continue;
    const installed = hooks;
    const oursUnder = (event: string): readonly unknown[] =>
      Array.isArray(installed[event])
        ? (installed[event] as unknown[]).filter((entry) => isOursEntry(entry))
        : [];
    const hasOurs = (event: string): boolean => oursUnder(event).length > 0;
    /**
     * One of ours under `event` that runs this kind of command. Read through the
     * parser, not through a substring: `map` and `lint` share the `SessionStart` key,
     * so what tells them apart is the command each entry runs — and the two spellings
     * that command can take (`smelt map .` and `node "<bin>" map .`) are exactly what
     * one recogniser owning both directions exists to keep straight.
     */
    const hasOursRunning = (event: string, kind: HookCommand['kind']): boolean =>
      oursUnder(event).some((entry) =>
        hookEntryCommands(entry).some((command) => parseHookCommand(command)?.kind === kind),
      );
    if (!MANAGED_EVENTS.some((event) => hasOurs(event))) continue;
    anyOurs = true;
    guard ||= GUARD_EVENTS.some((event) => hasOurs(event));
    statsOnStop ||= hasOurs(LIFECYCLE_EVENTS.stats);
    mapOnStart ||= hasOursRunning(LIFECYCLE_EVENTS.map, 'map');
    lintOnStart ||= hasOursRunning(LIFECYCLE_EVENTS.lint, 'lint');
  }

  for (const path of installedFiles('guard-only')) {
    const text = readIfExists(path);
    if (text !== undefined && text.includes(OURS_TOKEN)) {
      anyOurs = true;
      guard = true;
    }
  }

  return anyOurs ? { guard, statsOnStop, mapOnStart, lintOnStart } : defaults;
}
