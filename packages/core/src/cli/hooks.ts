import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { CliUsageError } from '../errors.ts';
import {
  AGENTS_LINT_ARGS,
  hookEntryCommands,
  isOursEntry,
  MAP_ON_START_ARGS,
  parseHookCommand,
  renderHookCommand,
} from '../harness/hook-command.ts';
import type { HookCommand } from '../harness/hook-command.ts';
import {
  guardCoreScriptPath,
  portablePath,
  shimScriptPath,
  smeltBinPath,
} from '../harness/paths.ts';
import { hasShim, TIER_HONESTY } from '../harness/profile.ts';
import type {
  HarnessInstallContext,
  HarnessInstallStep,
  HarnessJsonHooks,
  HarnessProfile,
} from '../harness/profile.ts';
import {
  GUARD_EVENTS,
  HARNESSES,
  harnessById,
  harnessNames,
  LIFECYCLE_EVENTS,
  lifecycleHarnesses,
  MANAGED_EVENTS,
} from '../harness/registry.ts';
import {
  instructionArtefact,
  locateStep,
  renderRoot,
  resolveScope,
  scopeRoot,
} from '../harness/scope.ts';
import type { InstallScope, ScopeRoots } from '../harness/scope.ts';
import {
  instructionSnippet,
  OURS_TOKEN,
  SNIPPET_END_MD,
  SNIPPET_START_MD,
} from '../harness/snippet.ts';
import { DEFAULT_SUGGESTION_BUDGET_BYTES, DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import type { EnforcementMode } from '../hooks/guard-core.ts';
import { pathStability, smeltInvocation } from '../hooks/invocation.ts';
import type { SmeltInvocation } from '../hooks/invocation.ts';
import {
  editJsonProperty,
  editTopLevelProperty,
  jsonStyle,
  stripMarkerBlock,
  upsertMarkerBlock,
} from '../text/json-edit.ts';
import { editTomlTable } from '../text/toml-edit.ts';

import { SETUP_RECIPE } from '../setup/recipe.ts';
import { fileIsOurs } from './installed.ts';
import {
  confirmLoop,
  confirmYesNo,
  listPlannedFiles,
  walkSteps,
  wizardAsk,
  writePlannedFile,
} from './wizard.ts';
import type { Ask } from './wizard.ts';
import { CLI_NAME } from './shell.ts';
import type { AnswerStream } from './shell.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
} from './config.ts';
import type { SmeltConfig, SmeltConfigHooks } from './config.ts';

/**
 * `smelt hooks install` / `smelt hooks remove` — the multi-harness guard preset.
 *
 * The design: one zero-dependency guard core
 * (`src/hooks/guard-core.ts`), thin per-harness shims mapping each harness's native
 * hook schema onto it, and this installer, which writes the harness config that wires
 * a shim in — plus an instruction-file snippet as belt and braces, because the
 * snippet is also what teaches the model to run `smelt retrieve` after a deny.
 *
 * Every per-harness fact lives in that harness's {@link HarnessProfile}
 * (`src/harness/<id>.ts`), including what to write and how to take it back out. This
 * module owns only what is the *same* for every harness: the hooks merge (which entries
 * are ours, what a re-run replaces), the wizard, and the two plans below — folds over
 * `profile.install`, with no case list of its own. The byte-faithful editing itself —
 * one top-level JSON property, one delimited text block — is `src/text/json-edit.ts`,
 * which knows nothing about harnesses.
 *
 * Harnesses come in three honesty tiers (docs/research/2026-09-02-harness-capability-matrix.md),
 * and which harness sits at which is `HarnessProfile.tier` — read through
 * `harnessesByTier()`, never listed again here:
 *
 *  - **verified** — schemas verified against primary docs and exercised against
 *    recorded fixtures; first-class targets.
 *  - **experimental** — hook schemas mapped from the capability matrix but not yet
 *    smoke-tested green against the real binary. Labelled as such in code, docs, and
 *    this installer's output.
 *  - **advisory** — no usable hook API, so what ships is instructions (and, for
 *    KiloCode, a permissions/MCP sketch). Nothing enforces them, and the output says
 *    so rather than implying a guard exists.
 *
 * The wizard discipline is `smelt init`'s, verbatim: every step accepts `back`,
 * nothing is written until a final confirm that lists every file, and an existing
 * file is never overwritten without an explicit per-file `yes` — guarded by
 * `test/guards/hooks-preset.test.ts`, with mutation `hooks-install-overwrite-without-consent`
 * proving the guard goes red.
 */

/** Where the wizard's bytes come from and go. Injected so `runHooks` tests in-process. */
export interface HooksIo {
  /**
   * Scripted answers in, one line at a time. Structural on purpose; see
   * {@link AnswerStream}.
   */
  readonly input: AnswerStream;
  readonly output: (text: string) => void;
  /** Project directory: detection, config discovery, and every write are relative to it. */
  readonly cwd: string;
  /**
   * Home directory: harness detection, and — at user scope — where every file goes.
   * Tests point it at a temp dir, which is the only way a user-scope install is
   * testable without writing into the developer's own home.
   */
  readonly home?: string;
  /**
   * This project or this machine. Absent means detect: `user` when {@link cwd} *is*
   * {@link home}, `project` otherwise. The wizard states what it found and, where it
   * found `user`, offers to flip it.
   */
  readonly scope?: InstallScope;
  /**
   * The release running the install — stamped into the instruction block so
   * `smelt doctor` can tell what wrote it. Absent (legacy callers) writes no stamp.
   */
  readonly version?: string;
}

export { instructionSnippet, SNIPPET_END_MD, SNIPPET_START_MD };

/** A harness whose config directory exists in the project or the home directory. */
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

export { AGENTS_LINT_ARGS };

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

interface PlannedFile {
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

interface SkippedFile {
  readonly name: string;
  readonly why: string;
}

interface PlannedRemoval {
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

interface InstallPlan {
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

function readIfExists(path: string): string | undefined {
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
        case 'own-file':
          files.set(path, planFile(path, name, step.content(ctx), 'whole', step.mode));
          break;
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
        case 'own-file':
          planWholeFileDelete(path, name);
          break;
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

/* ------------------------------------------------------------------------------------
 * The merge policy — one apply, two ways of consenting to it
 * ---------------------------------------------------------------------------------- */

/**
 * How an apply decides whether it may write over a file that already exists.
 *
 * There are exactly two answers, and one apply loop behind both — because two apply
 * loops would drift, and the one that drifted would be the one nobody watches: the
 * non-interactive path an agent drives blind.
 *
 *  - `wizard` — ask the human, per file, and take nothing but a literal `yes`. The
 *    rule `smelt init` lives under, unchanged.
 *  - `policy` — no one to ask, so the *plan's own shape* answers: a file whose planned
 *    content was computed by editing the existing bytes is safe to write (nothing
 *    foreign is lost), and a file smelt writes whole is refused unless it is already
 *    ours. That is what `--yes` and `smelt setup` consent by.
 */
export type Consent = { readonly kind: 'wizard'; readonly ask: Ask } | { readonly kind: 'policy' };

/** What one apply did to one file — the receipt line and the prose line, as data. */
export interface AppliedFile {
  readonly name: string;
  readonly action: 'written' | 'unchanged' | 'skipped';
  /** Why it was skipped, or what a write over an existing file changed. */
  readonly detail?: string;
}

/** What a policy write over an existing file changed, said the same way everywhere. */
const MERGED_DETAIL = "merged — every byte outside smelt's own entries is unchanged";

/**
 * Whether an existing planned file is smelt's to write over without being asked.
 * The config is smelt's own; every other whole-owned file is ours exactly when it
 * already carries our entries — the marker token in text, our hook entries in a JSON
 * hooks file (the guard command carries no token, hence the entry-level predicate).
 *
 * Exported because `smelt setup` applies the same policy: one merge policy, or the
 * two verbs disagree about whose file it is.
 */
export function fileIsOursToRepair(file: {
  readonly name: string;
  readonly path: string;
}): boolean {
  if (basename(file.path) === CONFIG_FILE_NAME) return true;
  return fileIsOurs(file.name, readFileSync(file.path, 'utf8'));
}

/**
 * The policy's answer for one existing file. A merged plan already carries every
 * foreign byte, so writing it is not an overwrite at all; a whole-owned file has no
 * merge to perform, and one that is not ours is somebody else's work.
 */
function policyMayWrite(file: PlannedFile): boolean {
  if (file.ownership === 'merged') return true;
  return fileIsOursToRepair(file);
}

/** The refusal a policy run gives a whole-owned file that belongs to somebody else. */
function foreignWholeFileDetail(name: string): string {
  return (
    `exists and carries nothing of smelt's — ${name} is written whole, so there is ` +
    `nothing to merge into; move it aside, or run \`${CLI_NAME} hooks install\` ` +
    `without --yes to be asked per file`
  );
}

/**
 * The one apply loop. Writes the plan, file by file, consenting the way {@link Consent}
 * says; returns what it did rather than printing it, so the wizard's prose and setup's
 * receipt are two renderings of one run.
 */
export async function applyPlanFiles(
  files: readonly PlannedFile[],
  consent: Consent,
): Promise<readonly AppliedFile[]> {
  const applied: AppliedFile[] = [];
  for (const file of files) {
    if (file.unchanged) {
      applied.push({ name: file.name, action: 'unchanged' });
      continue;
    }
    if (file.exists && !(await allowedToWrite(file, consent))) {
      applied.push({
        name: file.name,
        action: 'skipped',
        detail:
          consent.kind === 'wizard'
            ? 'the existing file was not touched'
            : foreignWholeFileDetail(file.name),
      });
      continue;
    }
    writePlannedFile(file);
    applied.push({
      name: file.name,
      action: 'written',
      ...(file.exists ? { detail: MERGED_DETAIL } : {}),
    });
  }
  return applied;
}

/** The consent question itself, asked or answered by policy. */
async function allowedToWrite(file: PlannedFile, consent: Consent): Promise<boolean> {
  if (consent.kind === 'policy') return policyMayWrite(file);
  // The one hard rule, same as `smelt init`: an existing file is never touched
  // without an explicit per-file yes — not `y`, not Enter, a literal `yes`.
  const answer = await consent.ask(`  ${file.name} exists — overwrite it? (yes/no)> `);
  return answer === 'yes';
}

/* ------------------------------------------------------------------------------------
 * The wizard
 * ---------------------------------------------------------------------------------- */

type Asker = Ask;

/**
 * `smelt hooks <install|remove>`, start to finish. The same testability pattern as
 * `runInit`: a pure function over an input/output pair, exit code returned. The ask
 * adapter, the step machine and the confirms are the wizard kit's (`cli/wizard.ts`) —
 * this file holds what is hooks' own: the steps, the plan, the per-file consent.
 */
export async function runHooks(
  action: 'install' | 'remove',
  harnessFlag: string | undefined,
  io: HooksIo,
): Promise<number> {
  const wizard = wizardAsk(
    io.input,
    io.output,
    `${CLI_NAME} hooks: input ended before the wizard finished. ` +
      `Files already confirmed and written stay; nothing further was written.`,
  );
  try {
    return action === 'install'
      ? await installFlow(io, wizard.ask, harnessFlag)
      : await removeFlow(io, wizard.ask, harnessFlag);
  } finally {
    await wizard.release();
  }
}

function resolveHarnessFlag(flag: string): HarnessProfile {
  const profile = harnessById(flag);
  if (profile === undefined) {
    throw new CliUsageError(
      `${CLI_NAME} hooks: unknown harness "${flag}". ` +
        `Known: ${HARNESSES.map((h) => h.id).join(', ')}.`,
    );
  }
  return profile;
}

function tierLabel(profile: HarnessProfile): string {
  return `${profile.id.padEnd(12)} ${profile.name.padEnd(14)} [${profile.tier}] — ${TIER_HONESTY[profile.tier]}`;
}

async function installFlow(
  io: HooksIo,
  ask: Asker,
  harnessFlag: string | undefined,
): Promise<number> {
  const home = io.home ?? homedir();
  const detected = detectedHarnesses(io.cwd, home);
  const detectedScope = resolveScope(io.scope, { cwd: io.cwd, home });

  io.output(
    `${CLI_NAME} hooks install — wires the smelt guard into agent-harness hooks.\n` +
      `Answer \`back\` at any step to return to the previous one. Nothing is written ` +
      `until you confirm at the end.\n\n`,
  );

  const choices: HooksChoices = {
    harnesses: harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...detected],
    ...(io.version === undefined ? {} : { writtenBy: io.version }),
    ...presetToggles(io.cwd, { scope: detectedScope, home }),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    scope: detectedScope,
    home,
  };

  /**
   * Take a scope, and re-read the toggles **that scope's** files carry.
   *
   * A re-run edits rather than resets, and what it edits is what is installed *at the
   * scope being installed to*. Reading the machine's toggles and then writing the
   * project's spellings is the reset this reading exists to prevent, one directory
   * over: the user answers "project", and the project's own guard/stats/map/lint
   * settings are replaced by the machine's. Unchanged when the answer is the scope
   * already settled on, so going `back` past this question does not discard toggles
   * the user typed after it.
   */
  const useScope = (next: InstallScope): void => {
    if (choices.scope === next) return;
    choices.scope = next;
    Object.assign(choices, presetToggles(io.cwd, { scope: next, home }));
  };

  // With --harness the selection step is skipped, so the tier label — and its one
  // line of honesty about what the tier means — is printed here instead.
  if (harnessFlag !== undefined) {
    for (const profile of choices.harnesses) io.output(`  ${tierLabel(profile)}\n`);
  }

  const steps: readonly ((io_: HooksIo, ask_: Asker) => Promise<'ok' | 'back'>)[] = [
    // Asked only where detection said `user` — from any other directory `project` is
    // the only reading that makes sense, and a question with one possible answer is a
    // question that trains people to hit Enter.
    async (io_, ask_) =>
      io.scope !== undefined || detectedScope === 'project'
        ? 'ok'
        : stepScope(io_, ask_, useScope, home),
    async (io_, ask_) =>
      harnessFlag !== undefined ? 'ok' : stepHarnesses(io_, ask_, choices, detected),
    async (io_, ask_) =>
      stepToggle(io_, ask_, 'PreToolUse size-guard', guardCopy(), choices.guard, (on) => {
        choices.guard = on;
      }),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'stats on Stop',
        `\`smelt stats\` runs when a session ends — the honest signal (expansion rate) ` +
          `surfaced where the turn ends. Observation only; never blocks. Wired for the ` +
          `harnesses whose hooks carry session events (${harnessNames(lifecycleHarnesses())}).`,
        choices.statsOnStop,
        (on) => {
          choices.statsOnStop = on;
        },
      ),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'repo map on SessionStart',
        `\`smelt map . --budget …\` runs at session start and its output opens the ` +
          `context — the agent starts oriented. Costs one map build per session. ` +
          `Wired for the harnesses whose hooks carry session events ` +
          `(${harnessNames(lifecycleHarnesses())}).`,
        choices.mapOnStart,
        (on) => {
          choices.mapOnStart = on;
        },
      ),
    async (io_, ask_) =>
      stepToggle(
        io_,
        ask_,
        'instruction-file lint on SessionStart',
        `\`smelt agents lint .\` runs at session start and reports on the AGENTS.md, ` +
          `CLAUDE.md and GEMINI.md this session is about to load on every request — ` +
          `bytes per level, and any path or link in them that no longer resolves. ` +
          `Advisory: it never blocks, and it exits 0 unless you set ` +
          `agents.budgetBytes in ${CONFIG_FILE_NAME}. Wired for verified-tier ` +
          `harnesses (Claude Code, Codex).`,
        choices.lintOnStart,
        (on) => {
          choices.lintOnStart = on;
        },
      ),
    async (io_, ask_) => stepEnforcement(io_, ask_, choices),
    async (io_, ask_) => stepThreshold(io_, ask_, choices),
  ];

  const machine = steps.map((step) => (a: Ask) => step(io, a));
  for (;;) {
    await walkSteps(machine, ask, io.output);
    if (choices.harnesses.length === 0) {
      io.output(`No harness selected. Nothing to do; nothing was written.\n`);
      return 0;
    }
    const verdict = await confirmAndInstall(io, ask, choices);
    if (verdict !== 'back') return 0;
    await walkSteps(machine, ask, io.output, machine.length - 1);
  }
}

function guardCopy(): string {
  return (
    `Denies raw Reads (and simple \`cat\`s) of files over the size threshold, with a ` +
    `reason naming the exact \`smelt\` replacement — the model still sees everything: ` +
    `smelted first, \`smelt retrieve\` for the rest. Windowed reads (offset/limit) ` +
    `always pass.`
  );
}

/**
 * The one scope question, asked only where detection said `user`. It states what was
 * found and what each answer writes; Enter takes the detected answer.
 */
async function stepScope(
  io: HooksIo,
  ask: Asker,
  useScope: (scope: InstallScope) => void,
  home: string,
): Promise<'ok' | 'back'> {
  io.output(
    `\nYou are in your home directory, so this looks like a machine-wide install:\n` +
      `  every harness file goes to its own documented user-level location under ` +
      `${home}, and ${CONFIG_FILE_NAME} to ${join(home, CONFIG_FILE_NAME)} — which ` +
      `every project below it finds, because config discovery walks up.\n` +
      `  A project install writes into ${io.cwd} instead, and only that project sees it.\n` +
      `  A harness that documents no user-level location for a file is listed as ` +
      `skipped, never guessed into ${home}.\n`,
  );
  for (;;) {
    const answer = await ask(`scope (1 machine / 2 project) [1]> `);
    if (answer === 'back') return 'back';
    if (answer === '' || answer === '1') {
      useScope('user');
      return 'ok';
    }
    if (answer === '2') {
      useScope('project');
      return 'ok';
    }
    io.output(`1 for this machine, 2 for this project.\n`);
  }
}

async function stepHarnesses(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
  detected: readonly HarnessProfile[],
): Promise<'ok' | 'back'> {
  io.output(`\nHarnesses — detected by their config directories (project or home):\n`);
  for (const profile of HARNESSES) {
    const mark = detected.includes(profile) ? '*' : ' ';
    io.output(`  ${mark} ${tierLabel(profile)}\n`);
  }
  io.output(`(* = detected here)\n`);
  for (;;) {
    const current = choices.harnesses.map((profile) => profile.id).join(',') || '(none)';
    const answer = await ask(
      `install for which? (comma-separated ids, Enter = ${current}, or back)\n> `,
    );
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    const ids = answer
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== '');
    const chosen: HarnessProfile[] = [];
    let bad: string | undefined;
    for (const id of ids) {
      const profile = harnessById(id);
      if (profile === undefined) bad = id;
      else if (!chosen.includes(profile)) chosen.push(profile);
    }
    if (bad !== undefined) {
      io.output(`Unknown harness "${bad}". Known: ${HARNESSES.map((h) => h.id).join(', ')}.\n`);
      continue;
    }
    choices.harnesses = chosen;
    return 'ok';
  }
}

async function stepToggle(
  io: HooksIo,
  ask: Asker,
  name: string,
  copy: string,
  current: boolean,
  set: (on: boolean) => void,
): Promise<'ok' | 'back'> {
  io.output(`\n${name} — ${copy}\n`);
  for (;;) {
    const answer = await ask(`${name}? (on/off) [${current ? 'on' : 'off'}] (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    if (answer === 'on' || answer === 'off') {
      set(answer === 'on');
      return 'ok';
    }
    io.output(`on, off, or back.\n`);
  }
}

async function stepEnforcement(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'ok' | 'back'> {
  io.output(
    `\nEnforcement — what happens when the guard catches an oversized raw read:\n` +
      `  1. deny     — refuse with a reason naming the exact replacement command. The\n` +
      `                transcript stays truthful; the model runs the replacement itself.\n` +
      `  2. rewrite  — on harnesses whose hooks can modify tool input, substitute the\n` +
      `                replacement in-flight (grep/cat piped through smelt). Never\n` +
      `                silent: the substitution is announced in the decision reason\n` +
      `                where the harness has one, on stderr where it does not.\n` +
      `                Harnesses that cannot rewrite fall back to deny.\n`,
  );
  for (;;) {
    const current = choices.enforcement === 'deny' ? '1' : '2';
    const answer = await ask(`enforcement (1/2) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    if (pick === '1' || pick === '2') {
      choices.enforcement = pick === '1' ? 'deny' : 'rewrite';
      return 'ok';
    }
    io.output(`1 for deny, 2 for rewrite, or back.\n`);
  }
}

async function stepThreshold(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'ok' | 'back'> {
  io.output(
    `\nSize threshold — reads at or under this many bytes always pass. The ${String(
      DEFAULT_THRESHOLD_BYTES,
    )}-byte default comes from the measured validation in ` +
      `docs/research/2026-09-02-agent-enforcement.md § 5.\n`,
  );
  for (;;) {
    const answer = await ask(`threshold in bytes [${String(choices.thresholdBytes)}] (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '') return 'ok';
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.thresholdBytes = Number(answer);
      return 'ok';
    }
    io.output(`A whole number of bytes greater than zero, e.g. 8192.\n`);
  }
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
): Pick<HooksChoices, 'guard' | 'statsOnStop' | 'mapOnStart' | 'lintOnStart'> {
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

/** One applied file, as this verb's prose spells it. */
function sayApplied(applied: AppliedFile): string {
  if (applied.action === 'unchanged') return `  ${applied.name} — unchanged, not rewritten\n`;
  if (applied.action === 'skipped') {
    return `  skipped ${applied.name} — ${applied.detail ?? 'not written'}\n`;
  }
  return `  wrote ${applied.name}\n`;
}

const fileLabel = (file: { readonly exists: boolean; readonly unchanged: boolean }): string => {
  if (file.unchanged) return 'unchanged — nothing to write';
  return file.exists ? 'exists — will ask before overwriting' : 'new';
};

async function confirmAndInstall(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'done' | 'back'> {
  const plan = planInstall(io.cwd, choices);
  const root = scopeRoot(choices.scope ?? 'project', {
    cwd: io.cwd,
    home: choices.home ?? homedir(),
  });

  io.output(`\nAbout to write, into ${root}:\n`);
  listPlannedFiles(io.output, plan.files, plan.skipped, fileLabel);
  for (const step of plan.manual) {
    io.output(
      `  ${step.name} is ${step.harness}'s own file — run this yourself:\n    ${step.command}\n`,
    );
  }
  io.output(`Nothing has been written yet.\n`);

  const confirmed = await confirmLoop(
    ask,
    'yes to write, no to leave everything untouched, back to change a setting.',
  );
  if (confirmed === 'back') return 'back';
  if (confirmed === 'no') {
    io.output(`Nothing was written.\n`);
    return 'done';
  }

  for (const applied of await applyPlanFiles(plan.files, { kind: 'wizard', ask })) {
    io.output(sayApplied(applied));
  }

  for (const note of plan.notes) io.output(`note: ${note}\n`);
  io.output(
    `Done. Re-run \`${CLI_NAME} hooks install\` to edit toggles; ` +
      `\`${CLI_NAME} hooks remove\` takes it all back out.\n`,
  );
  return 'done';
}

async function removeFlow(
  io: HooksIo,
  ask: Asker,
  harnessFlag: string | undefined,
): Promise<number> {
  const harnesses = harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...HARNESSES];
  const home = io.home ?? homedir();
  const scope = resolveScope(io.scope, { cwd: io.cwd, home });
  const root = scopeRoot(scope, { cwd: io.cwd, home });
  const removals = planRemove(io.cwd, harnesses, { scope, home });

  if (removals.length === 0) {
    io.output(`${CLI_NAME} hooks remove: nothing of smelt's found to remove in ${root}.\n`);
    return 0;
  }

  io.output(
    `${CLI_NAME} hooks remove — takes smelt's hook wiring back out.\n\nPlanned:\n` +
      removals
        .map(
          (removal) =>
            `  ${removal.name.padEnd(32)} (${
              removal.action === 'delete' ? 'delete' : 'remove smelt entries, keep the rest'
            })\n`,
        )
        .join('') +
      `${CONFIG_FILE_NAME} is left untouched — its hooks block is your config now; ` +
      `edit or remove it there.\nNothing has been changed yet.\n`,
  );

  if ((await confirmYesNo(ask, 'yes to proceed, no to leave everything untouched.')) === 'no') {
    io.output(`Nothing was changed.\n`);
    return 0;
  }

  for (const removal of removals) {
    const verb = removal.action === 'delete' ? 'delete' : 'modify';
    const answer = await ask(`  ${removal.name} — ${verb} it? (yes/no)> `);
    if (answer !== 'yes') {
      io.output(`  skipped ${removal.name} — not touched\n`);
      continue;
    }
    if (removal.action === 'delete') {
      unlinkSync(removal.path);
      io.output(`  deleted ${removal.name}\n`);
    } else {
      writeFileSync(removal.path, removal.content ?? '');
      io.output(`  cleaned ${removal.name}\n`);
    }
  }
  io.output(`Done.\n`);
  return 0;
}
