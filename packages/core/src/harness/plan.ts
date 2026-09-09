import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  AGENTS_LINT_ARGS,
  isOursEntry,
  MAP_ON_START_ARGS,
  renderHookCommand,
} from './hook-command.ts';
import type { HookCommand } from './hook-command.ts';
import { guardCoreScriptPath, portablePath, shimScriptPath, smeltBinPath } from './paths.ts';
import { hasShim } from './profile.ts';
import type {
  HarnessInstallContext,
  HarnessInstallStep,
  HarnessJsonHooks,
  HarnessProfile,
} from './profile.ts';
import { HARNESSES, LIFECYCLE_EVENTS, MANAGED_EVENTS } from './registry.ts';
import { instructionArtefact, locateFormer, locateStep, renderRoot, scopeRoot } from './scope.ts';
import type { InstallScope, ScopeRoots } from './scope.ts';
import { instructionSnippet, OURS_TOKEN, SNIPPET_END_MD, SNIPPET_START_MD } from './snippet.ts';
import { DEFAULT_SUGGESTION_BUDGET_BYTES } from '../hooks/guard-core.ts';
import type { EnforcementMode } from '../hooks/guard-core.ts';
import { pathStability, smeltInvocation } from '../hooks/invocation.ts';
import type { SmeltInvocation } from '../hooks/invocation.ts';
import { SETUP_RECIPE } from '../setup/recipe.ts';
import {
  editJsonProperty,
  editTopLevelProperty,
  jsonStyle,
  stripMarkerBlock,
  upsertMarkerBlock,
} from '../text/json-edit.ts';
import { editTomlTable } from '../text/toml-edit.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
} from '../config.ts';
import type { SmeltConfig, SmeltConfigHooks } from '../config.ts';

/**
 * The install plan: every file the two install verbs would write, and every one
 * `remove` would take back out — computed against the disk, writing nothing.
 *
 * The seam is {@link planInstall} / {@link planRemove}, and both are **folds over
 * `HarnessProfile.install`**: what to write is the profile's fact, where it goes is
 * `locateStep`'s (CONTEXT.md, **InstallScope**), what a hook entry says is
 * `harness/hook-command.ts`'s, and the byte-faithful editing itself — one top-level
 * JSON property, one delimited text block, one TOML table — is `text/json-edit.ts`
 * and `text/toml-edit.ts`, neither of which knows what a harness is. There is no
 * per-harness case anywhere below.
 *
 * It lives in `harness/` rather than in a verb because **planning is not a verb**: the
 * wizard (`cli/hooks.ts`) and `smelt setup` (`cli/setup.ts`) plan identically and
 * differ only in who consents to the write, which is `cli/merge-policy.ts`. While this
 * fold sat inside the wizard's module, `setup` imported the wizard to plan, and every
 * reader of either had to read both.
 *
 * It imports nothing from `cli/`. The config schema it goes through is `src/config.ts`
 * at the root — its reader and its one writer. `planInstall` writes `smelt.config.json`
 * because the guard's runtime settings are what the install is *for*; going through
 * `renderConfig` is what keeps a key added to the schema reaching this file and
 * `init`'s together or not at all.
 */

/**
 * A harness whose config directory exists in the project or the home directory —
 * where a run with no `--harness` starts. It reads the registry's own `detect` /
 * `detectHome` paths, so a harness joins detection by existing in the registry.
 */
export function detectedHarnesses(cwd: string, home: string): readonly HarnessProfile[] {
  return HARNESSES.filter(
    (profile) =>
      profile.detect.some((path) => existsSync(join(cwd, path))) ||
      profile.detectHome.some((path) => existsSync(join(home, path))),
  );
}

/* ------------------------------------------------------------------------------------
 * Generated content
 * ---------------------------------------------------------------------------------- */

/** Claude-style hook entry: one command under an optional matcher. */
function commandEntry(matcher: string | undefined, command: string): unknown {
  return {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ type: 'command', command }],
  };
}

/**
 * The guard command a harness's entries run: its own shim script, as a
 * {@link HookCommand} the renderer spells.
 *
 * @throws {Error} when a profile declares a JSON hook file but ships no shim — a
 *   registry bug, pinned by `test/guards/harness-registry.test.ts`, not a user error.
 */
function guardCommand(profile: HarnessProfile, distDir?: string): HookCommand {
  /* v8 ignore next 5 -- unreachable: pinned by the harness-registry guard */
  if (!hasShim(profile)) {
    throw new Error(
      `smelt: harness "${profile.id}" wires a hook command but ships no shim script.`,
    );
  }
  return { kind: 'guard', script: shimScriptPath(profile, distDir) };
}

/**
 * A lifecycle hook's command, in whichever spelling this machine can still run after
 * an upgrade: the bare `smelt` where it is on PATH, `node "<script>"` otherwise.
 *
 * The guard hook is deliberately **not** built this way — a shim is a script, not a
 * bin, and `smelt` has no verb that runs one — which is why only the three lifecycle
 * commands go through here.
 */
function smeltLifecycleCommand(
  kind: 'stats' | 'map' | 'lint',
  args: string,
  invocation: SmeltInvocation,
): HookCommand {
  return invocation.kind === 'path'
    ? { kind, invocation: 'path', args }
    : { kind, invocation: 'node', script: invocation.script ?? smeltBinPath(), args };
}

/**
 * One harness's hook entries: the guard under each matcher its schema spells, plus
 * the session-lifecycle hooks for the harnesses whose schema carries them. Every
 * toggle the wizard offers is a key that is present or absent here — an absent key is
 * how a re-run turns a toggle *off*, because the merge deletes what it no longer sees.
 *
 * The two `SessionStart` toggles — the opening map and the instruction-file lint —
 * are **concatenated into one array**, not spread as two objects. Spreading would put
 * the same computed key twice in one literal, and the second would silently replace
 * the first: turning the lint on would turn the map off, with no error anywhere. It is
 * the shape of bug this file exists to refuse, one layer up from the config it writes.
 */
function jsonHookEvents(
  step: HarnessJsonHooks,
  ctx: HarnessInstallContext,
  guard: HookCommand,
  invocation: SmeltInvocation,
): Record<string, readonly unknown[]> {
  // Every string below is rendered by the one writer in `harness/hook-command.ts`, so
  // the readers that have to recognise these entries again — the merge, the toggle
  // reader, `smelt doctor` — parse rather than search for a substring.
  // Paths in a written command are spelled against the scope's render root: relative
  // to the project where the config travels with the repo, absolute at user scope,
  // where the hook runs from whatever project the agent happened to open.
  const root = renderRoot(ctx.scope, ctx);
  const command = renderHookCommand(guard, root);
  const lifecycle = (kind: 'stats' | 'map' | 'lint', args: string): string =>
    renderHookCommand(smeltLifecycleCommand(kind, args, invocation), root);
  const stats = lifecycle('stats', 'stats');
  const map = lifecycle(
    'map',
    `${MAP_ON_START_ARGS} --budget ${String(ctx.budgetBytes)} --cache .smelt/tags`,
  );
  const lint = lifecycle('lint', AGENTS_LINT_ARGS);

  const sessionStart = [
    ...(ctx.mapOnStart ? [commandEntry(SESSION_START_MATCHER, map)] : []),
    ...(ctx.lintOnStart ? [commandEntry(SESSION_START_MATCHER, lint)] : []),
  ];

  return {
    ...(ctx.guard
      ? {
          [step.event]: step.matchers.map((matcher) =>
            step.entry === 'bare-command' ? { command } : commandEntry(matcher, command),
          ),
        }
      : {}),
    ...(step.lifecycle && ctx.statsOnStop
      ? { [LIFECYCLE_EVENTS.stats]: [commandEntry(undefined, stats)] }
      : {}),
    ...(step.lifecycle && sessionStart.length > 0 ? { [LIFECYCLE_EVENTS.map]: sessionStart } : {}),
  };
}

/** The matcher both `SessionStart` entries fire under — a session opening, however. */
const SESSION_START_MATCHER = 'startup|resume|clear|compact';

/**
 * Merge our hook entries into a JSON settings file, preserving everything foreign
 * **byte-faithfully**: the merged `hooks` value is spliced into the original text, so
 * unknown top-level keys, string escapes, number spellings, indentation and key order
 * outside the `hooks` property ride through verbatim (an installer
 * that reformats somebody's settings file has edited what it was never asked to).
 * Inside `hooks`, unmanaged events and other people's entries under managed events
 * are preserved; our previous entries are replaced (that is what makes a re-run edit
 * toggles), and events left with no entries disappear. A semantic no-op returns the
 * input text unchanged. Returns `undefined` when the existing file is not a JSON
 * object — the caller skips the file rather than clobbering something it cannot
 * understand.
 */
export function mergeJsonHooks(
  existingText: string | undefined,
  events: Record<string, readonly unknown[]>,
  shape: { readonly version?: number } = {},
): string | undefined {
  let root: Record<string, unknown> = {};
  if (existingText !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existingText);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
      root = parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  const hooksValue = root['hooks'];
  const existingHooks =
    typeof hooksValue === 'object' && hooksValue !== null && !Array.isArray(hooksValue)
      ? (hooksValue as Record<string, unknown>)
      : undefined;
  const hooks = { ...existingHooks };

  for (const event of MANAGED_EVENTS) {
    const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
    const foreign = existing.filter((entry) => !isOursEntry(entry));
    const ours = events[event] ?? [];
    const merged = [...foreign, ...ours];
    if (merged.length > 0) hooks[event] = merged;
    else delete hooks[event];
  }

  const mergedHooks = Object.keys(hooks).length > 0 ? hooks : undefined;

  // A brand-new file: nothing to preserve, render fresh two-space JSON.
  if (existingText === undefined) {
    const fresh: Record<string, unknown> = {};
    if (mergedHooks !== undefined) fresh['hooks'] = mergedHooks;
    if (shape.version !== undefined) fresh['version'] = shape.version;
    return `${JSON.stringify(fresh, null, 2)}\n`;
  }

  const hooksChanged =
    JSON.stringify(existingHooks ?? null) !== JSON.stringify(mergedHooks ?? null);
  const needsVersion = shape.version !== undefined && root['version'] === undefined;
  if (!hooksChanged && !needsVersion) return existingText;

  // The style is read once, off the original: a second edit must match the first.
  const style = jsonStyle(existingText);
  let text: string | undefined = existingText;

  if (hooksChanged) {
    text = editTopLevelProperty(text, 'hooks', mergedHooks, style);
    /* v8 ignore next -- unreachable: JSON.parse accepted the same text above */
    if (text === undefined) return undefined;
  }
  if (needsVersion) {
    text = editTopLevelProperty(text, 'version', shape.version, style);
    /* v8 ignore next -- unreachable: every splice above keeps the text valid JSON */
    if (text === undefined) return undefined;
  }
  return text;
}

/* ------------------------------------------------------------------------------------
 * Planning
 * ---------------------------------------------------------------------------------- */

export interface PlannedFile {
  /** Display path, relative to the project. */
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  readonly unchanged: boolean;
  /**
   * Whose bytes are in the planned content, and therefore what a non-interactive run
   * is allowed to do with an existing file (see {@link Consent}).
   *
   *  - `'merged'` — the content was computed *from* the existing bytes by a
   *    byte-faithful edit: `editTopLevelProperty` on a JSON hooks file,
   *    `upsertMarkerBlock` on an instruction file, `editJsonProperty` /
   *    `editTomlTable` on an MCP registration. Everything foreign in the file is
   *    already in the planned content, so writing it destroys nothing.
   *    `smelt.config.json` counts too: it is smelt's own file, re-rendered from its
   *    own parsed fields with every key carried through.
   *  - `'whole'` — smelt writes every byte (the opencode plugin, cline's hook
   *    wrapper, hermes's YAML, KiloCode's rules file). There is nothing to merge
   *    into, so an existing file that is not already ours is refused rather than
   *    replaced.
   */
  readonly ownership: 'merged' | 'whole';
  /** chmod after writing (the cline hook must be executable). */
  readonly mode?: number;
}

export interface SkippedFile {
  readonly name: string;
  readonly why: string;
}

export interface PlannedRemoval {
  readonly name: string;
  readonly path: string;
  /** `'delete'` removes the file; `'modify'` writes `content` (ours stripped out). */
  readonly action: 'delete' | 'modify';
  readonly content?: string;
}

export interface HooksChoices {
  harnesses: HarnessProfile[];
  /** The release writing these bytes — stamped into the snippet for `smelt doctor`. */
  writtenBy?: string;
  guard: boolean;
  statsOnStop: boolean;
  mapOnStart: boolean;
  lintOnStart: boolean;
  enforcement: EnforcementMode;
  thresholdBytes: number;
  /**
   * How smelt is re-invoked on this machine. Defaults to reading the machine
   * (`smeltInvocation()`); a caller passes one to plan against something else, which
   * is what lets a test see both spellings of a lifecycle hook without a global PATH.
   */
  invocation?: SmeltInvocation;
  /**
   * The package `dist` the shim and guard-core paths are named under. Defaults to
   * this install's own; a caller passes one to plan for a layout that is not the
   * running one — which is how the stability reporting below is exercised without a
   * Homebrew machine.
   */
  distDir?: string;
  /**
   * Project or machine (CONTEXT.md, **InstallScope**). Defaults to `'project'`, which
   * is exactly what this installer did before scopes existed. At `'user'` every path
   * is resolved through `locateStep` against {@link home}, and a harness that
   * documents no user-level home for an artefact is skipped with the reason.
   */
  scope?: InstallScope;
  /** The home directory a user-scope plan writes into. Defaults to the real one. */
  home?: string;
}

/**
 * One step this scope turns into a printed command rather than a written file: the
 * location exists, but the harness owns and rewrites it. Claude Code's user-scope MCP
 * registration is the case that exists — `~/.claude.json` is theirs.
 */
export interface ManualStep {
  /** The file the command edits, as the user sees it. */
  readonly name: string;
  readonly kind: HarnessInstallStep['kind'];
  /** The exact command to run. */
  readonly command: string;
  /** Which harness asked for it. */
  readonly harness: string;
}

export interface InstallPlan {
  readonly files: readonly PlannedFile[];
  readonly skipped: readonly SkippedFile[];
  readonly notes: readonly string[];
  /** Steps this scope hands back to the user as a command. Empty at project scope. */
  readonly manual: readonly ManualStep[];
}

function planFile(
  path: string,
  name: string,
  content: string,
  ownership: PlannedFile['ownership'],
  mode?: number,
): PlannedFile {
  const exists = existsSync(path);
  const unchanged = exists && readFileSync(path, 'utf8') === content;
  return {
    name,
    path,
    content,
    exists,
    unchanged,
    ownership,
    ...(mode === undefined ? {} : { mode }),
  };
}

/**
 * A file's text when it is there, `undefined` when it is not — the one read-or-nothing
 * the installer's three modules share. It was declared three times (here, the state
 * reader and the setup flow) with three identical bodies, which is the smallest shape
 * of the thing this repository refuses everywhere else.
 */
export function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

/**
 * Every file `install` would write, computed against the current disk state — pure
 * planning, nothing written. A fold over each chosen profile's `install` list and its
 * instruction layer; all per-harness knowledge is in the profiles. Shared instruction
 * files (several harnesses read AGENTS.md) are planned once.
 *
 * @throws {CliUsageError} when an existing `smelt.config.json` is malformed — the
 *   same refusal every other subcommand makes; an installer that guessed around a
 *   broken config would write settings the guard then ignores.
 */
export function planInstall(cwd: string, choices: HooksChoices): InstallPlan {
  const files = new Map<string, PlannedFile>();
  const skipped: SkippedFile[] = [];
  const notes: string[] = [];
  const manual: ManualStep[] = [];

  // Project or machine. Every path below goes through `locateStep` — the one resolver
  // — so a user-scope install lands where each harness's own documentation says, and
  // an artefact with no documented user-level home is skipped with the reason rather
  // than written into `~` where nothing reads it.
  const scope: InstallScope = choices.scope ?? 'project';
  const home = choices.home ?? homedir();
  const root = scopeRoot(scope, { cwd, home });
  const rootsFor = (profile: HarnessProfile): ScopeRoots => ({ cwd, home, harness: profile.name });

  // Every path this plan writes down has to still be there tomorrow. The verdict is
  // taken per **script actually named** — the guard shim, the guard core the opencode
  // plugin imports, and the CLI binary the lifecycle hooks run — never from the
  // invocation value: that one is stable whenever `smelt` is on PATH, and an earlier
  // cut of this reported the lifecycle hooks fine while writing the guard hook, the
  // security-relevant one, as a bare Cellar path with nothing said.
  const invocation = choices.invocation ?? smeltInvocation();
  const written: string[] = [];
  if (invocation.script !== undefined) written.push(invocation.script);
  for (const profile of choices.harnesses) {
    if (hasShim(profile)) written.push(shimScriptPath(profile, choices.distDir));
    else written.push(guardCoreScriptPath(choices.distDir));
  }
  const said = new Set<string>();
  for (const script of written) {
    const stability = pathStability(script);
    if (stability.stable || said.has(stability.why)) continue;
    said.add(stability.why);
    notes.push(
      `hook command uses an unstable path (${stability.why}) — re-run setup after upgrading`,
    );
  }
  if (invocation.caveat !== undefined) notes.push(invocation.caveat);

  /**
   * A step's base text: the previous step's planned output for this same path when
   * one exists, disk otherwise. Codex's `.codex/config.toml` carries two independent
   * edits — the `[features]` marker block and the `mcp_servers.smelt` table — and
   * without this, the second step to touch a shared file would read stale disk bytes
   * and its `files.set` would silently discard the first step's edit.
   */
  const currentContent = (path: string): string | undefined =>
    files.get(path)?.content ?? readIfExists(path);

  // -- smelt.config.json: the guard's runtime settings live here, not in any harness
  // file, so every shim reads one source of truth.
  //
  // At user scope the location is not *discovered*, it is decided: `~/smelt.config.json`,
  // with the directory store at `~/.smelt/store` under it. That is the whole point of
  // installing for the machine — config discovery walks up, so one config at `~` is the
  // one every project below it finds — and walking up from `~` looking for somebody
  // else's config would defeat it.
  const configPath =
    scope === 'user'
      ? join(home, CONFIG_FILE_NAME)
      : (findConfigFile(cwd) ?? join(cwd, CONFIG_FILE_NAME));
  const existingConfig =
    readIfExists(configPath) === undefined
      ? undefined
      : parseConfig(readFileSync(configPath, 'utf8'), configPath);
  const hooksBlock: SmeltConfigHooks = {
    thresholdBytes: choices.thresholdBytes,
    enforcement: choices.enforcement,
  };
  const budgetBytes = existingConfig?.defaultBudgetBytes ?? DEFAULT_SUGGESTION_BUDGET_BYTES;
  files.set(configPath, {
    name: portablePath(root, configPath),
    path: configPath,
    content: renderConfigWithHooks(existingConfig, hooksBlock),
    exists: existsSync(configPath),
    unchanged: readIfExists(configPath) === renderConfigWithHooks(existingConfig, hooksBlock),
    // smelt's own file, re-rendered from its own parsed fields — every key the reader
    // knows rides through, so writing it over an existing one loses nothing.
    ownership: 'merged',
  });

  const ctx: HarnessInstallContext = {
    cwd,
    scope,
    ...(choices.writtenBy === undefined ? {} : { writtenBy: choices.writtenBy }),
    guard: choices.guard,
    statsOnStop: choices.statsOnStop,
    mapOnStart: choices.mapOnStart,
    lintOnStart: choices.lintOnStart,
    thresholdBytes: choices.thresholdBytes,
    budgetBytes,
    ...(choices.distDir === undefined ? {} : { distDir: choices.distDir }),
  };
  const snippet = instructionSnippet(choices.thresholdBytes, budgetBytes, choices.writtenBy, scope);

  const planJsonHooks = (
    path: string,
    name: string,
    events: Record<string, readonly unknown[]>,
    shape: { readonly version?: number } = {},
  ): void => {
    // Nothing to install and nothing to strip: don't create an empty hooks file.
    if (Object.keys(events).length === 0 && !existsSync(path)) return;
    const merged = mergeJsonHooks(readIfExists(path), events, shape);
    if (merged === undefined) {
      skipped.push({
        name,
        why: 'exists but is not a JSON object — fix or remove it, then re-run',
      });
      return;
    }
    files.set(path, planFile(path, name, merged, 'merged'));
  };

  const planBlockFile = (
    path: string,
    name: string,
    block: string,
    start: string,
    end: string,
    skipWhen?: { readonly contains: string; readonly why: string },
  ): void => {
    const existing = currentContent(path);
    // A file that already carries its owner's version of what this block does is
    // theirs to edit, not ours: say so, and touch nothing.
    if (
      skipWhen !== undefined &&
      existing !== undefined &&
      !existing.includes(start) &&
      existing.includes(skipWhen.contains)
    ) {
      skipped.push({ name, why: skipWhen.why });
      return;
    }
    files.set(path, planFile(path, name, upsertMarkerBlock(existing, block, start, end), 'merged'));
  };

  for (const profile of choices.harnesses) {
    const roots = rootsFor(profile);
    for (const step of profile.install) {
      // A guard-only file the guard toggle turned off is not installed at any scope,
      // so it is not located either: reporting it skipped for want of a user-level
      // home would name a file this run was never going to write.
      if (step.kind === 'own-file' && step.guardOnly && !ctx.guard) continue;
      // One resolver, before any per-kind work: no path means this harness documents
      // no home for this artefact at this scope, and a `manual` one means the harness
      // owns the file and we print a command instead of writing a byte.
      const located = locateStep(step, scope, roots);
      if (located.path === undefined || located.name === undefined) {
        skipped.push({ name: step.file, why: located.skipped ?? 'no location at this scope' });
        continue;
      }
      const { path, name } = located;
      if (located.manual !== undefined) {
        manual.push({ name, kind: step.kind, command: located.manual, harness: profile.id });
        continue;
      }
      switch (step.kind) {
        case 'json-hooks':
          planJsonHooks(
            path,
            name,
            jsonHookEvents(step, ctx, guardCommand(profile, choices.distDir), invocation),
            step.shape ?? {},
          );
          break;
        case 'marker-block':
          planBlockFile(path, name, step.block(ctx), step.start, step.end, step.skipWhen);
          break;
        case 'own-file': {
          files.set(path, planFile(path, name, step.content(ctx), 'whole', step.mode));
          // A copy of ours still sitting at the artefact's former name is named, never
          // touched: install writes, `remove` removes, and this run is an install. The
          // note is what tells somebody the old file is theirs to take out and how —
          // silence would leave a file smelt wrote in a directory smelt no longer
          // writes, with nothing anywhere saying so.
          const former = locateFormer(step, scope, roots);
          if (former?.path !== undefined && former.name !== undefined && former.path !== path) {
            const stale = readIfExists(former.path);
            if (stale !== undefined && stale.includes(OURS_TOKEN)) {
              notes.push(
                `${profile.name}: ${former.name} is where an earlier release wrote this ` +
                  `file, and ${name} is where this one reads it from; ` +
                  `\`smelt hooks remove --harness ${profile.id}\` takes the old one out`,
              );
            }
          }
          break;
        }
        case 'mcp-registration': {
          // Byte-faithful beside whatever servers the user already registered —
          // sibling entries, key order and indentation all ride through.
          const existing = readIfExists(path);
          const merged = editJsonProperty(
            existing ?? '{}',
            step.path,
            step.entry(ctx),
            existing === undefined ? undefined : jsonStyle(existing),
          );
          if (merged === undefined) {
            skipped.push({
              name,
              why: 'exists but is not a JSON object — fix or remove it, then re-run',
            });
            break;
          }
          files.set(path, planFile(path, name, merged, 'merged'));
          break;
        }
        case 'toml-mcp-registration': {
          // The TOML sibling of 'mcp-registration': table-form or dotted-form, beside
          // whatever the user already has — via currentContent, so a profile whose
          // marker-block step already wrote this file (Codex's [features] block) is
          // edited on top of that plan rather than overwritten by a fresh disk read.
          const existing = currentContent(path);
          const merged = editTomlTable(existing ?? '', step.path, step.entry(ctx));
          if (merged === undefined) {
            skipped.push({
              name,
              why: 'the server is already registered both as a table and as dotted keys — fix by hand, then re-run',
            });
            break;
          }
          files.set(path, planFile(path, name, merged, 'merged'));
          break;
        }
      }
    }

    // The instruction layer is located by the same rule, through the same resolver.
    const instructions = locateStep(instructionArtefact(profile), scope, roots);
    if (instructions.path === undefined || instructions.name === undefined) {
      skipped.push({
        name: profile.instructionFile,
        why: instructions.skipped ?? 'no location at this scope',
      });
    } else if (profile.instructions === 'snippet') {
      planBlockFile(
        instructions.path,
        instructions.name,
        snippet,
        SNIPPET_START_MD,
        SNIPPET_END_MD,
      );
    } else {
      files.set(
        instructions.path,
        planFile(instructions.path, instructions.name, profile.instructions(ctx), 'whole'),
      );
    }

    for (const caveat of profile.caveats) notes.push(`${profile.name}: ${caveat}`);
  }

  return { files: [...files.values()], skipped, notes, manual };
}

/** Where the installed config points the persistent store, relative to the config file. */
export const DEFAULT_STORE_DIR = SETUP_RECIPE.store.defaultDir;

/**
 * Existing config re-rendered with the hooks block, other fields carried verbatim —
 * except that a config with **no** store block gains a directory store. The deny
 * reasons and the instruction snippet teach `smelt retrieve <hash>`, and retrieval
 * across processes needs a persistent store (`smelt retrieve` refuses a memory
 * store, exit 2) — an install whose own guard promises a command the installed
 * config cannot run would be the exact silent-failure shape this project refuses.
 * An *explicit* `{"kind":"memory"}` is respected; the guard then conditions its
 * retrieve promise on the store kind instead (`retrieveSentence` in guard-core).
 *
 * That store injection is this verb's **policy**, which is why it lives here; the
 * bytes are written by `renderConfig` in `config.ts`, the one writer, so a key added
 * to the schema reaches this file and `init`'s together or not at all.
 *
 * "Carried verbatim" is spelled as a spread rather than as a list of the fields to
 * copy, and that is load-bearing: the list version silently dropped every key nobody
 * remembered to add to it — `agents` was added to the schema and this function kept
 * writing configs without it, which is a setting the user believed was in force,
 * caught by `test/guards/config-writer.test.ts`. Only the two fields this verb
 * actually decides are named.
 */
export function renderConfigWithHooks(
  existing: SmeltConfig | undefined,
  hooks: SmeltConfigHooks,
): string {
  return renderConfig({
    ...existing,
    smeltConfig: CONFIG_VERSION,
    store: existing?.store ?? { kind: 'directory', path: DEFAULT_STORE_DIR },
    hooks,
  });
}

/**
 * Everything `remove` would delete or strip, computed against the current disk state.
 * The mirror image of {@link planInstall}, over the same data: each install step's
 * kind is also how it comes back out — a JSON hook file is strip-merged, a marker
 * block is stripped, a file that is entirely ours is deleted.
 */
export function planRemove(
  cwd: string,
  harnesses: readonly HarnessProfile[],
  where: { readonly scope?: InstallScope; readonly home?: string } = {},
): readonly PlannedRemoval[] {
  const removals = new Map<string, PlannedRemoval>();
  const scope: InstallScope = where.scope ?? 'project';
  const home = where.home ?? homedir();
  const rootsFor = (profile: HarnessProfile): ScopeRoots => ({ cwd, home, harness: profile.name });

  /**
   * A step's base text for stripping: the previous step's planned removal for this
   * same path when one exists (its `'delete'` action reads as "nothing left to
   * strip further"), disk otherwise — `planInstall`'s `currentContent`, mirrored for
   * the tear-down direction, so Codex's two steps on `.codex/config.toml` compose
   * instead of the second stripping stale disk bytes and discarding the first.
   */
  const currentText = (path: string): string | undefined => {
    const planned = removals.get(path);
    if (planned !== undefined) return planned.action === 'delete' ? undefined : planned.content;
    return readIfExists(path);
  };

  const planJsonStrip = (path: string, name: string): void => {
    const existing = readIfExists(path);
    if (existing === undefined) return;
    const stripped = mergeJsonHooks(existing, {});
    if (stripped === undefined || stripped === existing) return;
    const remains: unknown = JSON.parse(stripped);
    const empty =
      typeof remains === 'object' &&
      remains !== null &&
      Object.keys(remains as Record<string, unknown>).filter((key) => key !== 'version').length ===
        0;
    removals.set(
      path,
      empty && existing.includes('hooks')
        ? { name, path, action: 'delete' }
        : { name, path, action: 'modify', content: stripped },
    );
  };

  const planBlockStrip = (path: string, name: string, start: string, end: string): void => {
    const existing = currentText(path);
    if (existing === undefined || !existing.includes(start)) return;
    const stripped = stripMarkerBlock(existing, start, end);
    removals.set(
      path,
      stripped === undefined
        ? { name, path, action: 'delete' }
        : { name, path, action: 'modify', content: stripped },
    );
  };

  const planWholeFileDelete = (path: string, name: string): void => {
    const existing = readIfExists(path);
    if (existing === undefined || !existing.includes(OURS_TOKEN)) return;
    removals.set(path, { name, path, action: 'delete' });
  };

  /**
   * The registration comes back out the way it went in: the server entry lifted,
   * byte-faithfully, from its container. A container this install created — empty
   * once the entry is gone — is removed with it, so a file that never carried the
   * key round-trips to byte-identical; one that carries other servers keeps them.
   */
  const planMcpStrip = (path: string, name: string, keys: readonly [string, string]): void => {
    const existing = currentText(path);
    if (existing === undefined) return;
    const removed = editJsonProperty(existing, keys, undefined);
    if (removed === undefined || removed === existing) return;
    let remains: unknown;
    try {
      remains = JSON.parse(removed);
    } catch {
      return; // unreachable — the editor only returns parseable text; refuse to guess
    }
    const empty =
      typeof remains === 'object' && remains !== null && Object.keys(remains).length === 0;
    removals.set(
      path,
      empty ? { name, path, action: 'delete' } : { name, path, action: 'modify', content: removed },
    );
  };

  /** {@link planMcpStrip}'s TOML sibling — the table lifted out, byte-faithfully. */
  const planTomlMcpStrip = (path: string, name: string, keys: readonly [string, string]): void => {
    const existing = currentText(path);
    if (existing === undefined) return;
    const removed = editTomlTable(existing, keys, undefined);
    if (removed === undefined || removed === existing) return;
    removals.set(
      path,
      removed.trim() === ''
        ? { name, path, action: 'delete' }
        : { name, path, action: 'modify', content: removed },
    );
  };

  for (const profile of harnesses) {
    const roots = rootsFor(profile);
    for (const step of profile.install) {
      // The same resolver the install went through. A step with no home at this scope
      // wrote nothing here, so there is nothing to take back out; a `manual` one was a
      // printed command, and un-writing what a person ran by hand is not ours to do.
      const located = locateStep(step, scope, roots);
      if (located.path === undefined || located.name === undefined) continue;
      if (located.manual !== undefined) continue;
      const { path, name } = located;
      switch (step.kind) {
        case 'json-hooks':
          planJsonStrip(path, name);
          break;
        case 'marker-block':
          planBlockStrip(path, name, step.start, step.end);
          break;
        case 'own-file': {
          planWholeFileDelete(path, name);
          // And the file this artefact used to be written to, where the harness has
          // renamed the directory it loads from: one artefact, so `remove` takes out
          // both names — leaving an earlier release's copy behind would leave a plugin
          // loaded that `remove` has just said it took out.
          const former = locateFormer(step, scope, roots);
          if (former?.path !== undefined && former.name !== undefined) {
            planWholeFileDelete(former.path, former.name);
          }
          break;
        }
        case 'mcp-registration':
          planMcpStrip(path, name, step.path);
          break;
        case 'toml-mcp-registration':
          planTomlMcpStrip(path, name, step.path);
          break;
      }
    }
    const instructions = locateStep(instructionArtefact(profile), scope, roots);
    if (instructions.path === undefined || instructions.name === undefined) continue;
    if (profile.instructions === 'snippet') {
      planBlockStrip(instructions.path, instructions.name, SNIPPET_START_MD, SNIPPET_END_MD);
    } else {
      planWholeFileDelete(instructions.path, instructions.name);
    }
  }

  return [...removals.values()];
}
