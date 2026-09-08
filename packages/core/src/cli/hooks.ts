import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { CliUsageError } from '../errors.ts';
import { nodeCommand, portablePath, shimScriptPath, smeltBinPath } from '../harness/paths.ts';
import { hasShim, TIER_HONESTY } from '../harness/profile.ts';
import type {
  HarnessInstallContext,
  HarnessJsonHooks,
  HarnessProfile,
} from '../harness/profile.ts';
import {
  GUARD_EVENTS,
  GUARD_ONLY_FILES,
  HARNESSES,
  harnessById,
  harnessNames,
  JSON_HOOK_FILES,
  LIFECYCLE_EVENTS,
  lifecycleHarnesses,
  MANAGED_EVENTS,
} from '../harness/registry.ts';
import {
  instructionSnippet,
  OURS_TOKEN,
  SNIPPET_END_MD,
  SNIPPET_START_MD,
} from '../harness/snippet.ts';
import { DEFAULT_SUGGESTION_BUDGET_BYTES, DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import type { EnforcementMode } from '../hooks/guard-core.ts';
import {
  editJsonProperty,
  editTopLevelProperty,
  jsonStyle,
  stripMarkerBlock,
  upsertMarkerBlock,
} from '../text/json-edit.ts';
import { editTomlTable } from '../text/toml-edit.ts';

import { SETUP_RECIPE } from '../setup/recipe.ts';
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
  /** Home directory for detection only. Tests point it at a temp dir; nothing writes here. */
  readonly home?: string;
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
 * The hook command a harness's entries run: its own shim script, through node.
 *
 * @throws {Error} when a profile declares a JSON hook file but ships no shim — a
 *   registry bug, pinned by `test/guards/harness-registry.test.ts`, not a user error.
 */
function shimCommand(profile: HarnessProfile, cwd: string): string {
  /* v8 ignore next 5 -- unreachable: pinned by the harness-registry guard */
  if (!hasShim(profile)) {
    throw new Error(
      `smelt: harness "${profile.id}" wires a hook command but ships no shim script.`,
    );
  }
  return nodeCommand(cwd, shimScriptPath(profile));
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
  command: string,
): Record<string, readonly unknown[]> {
  // The trailing shell comment tags the entry as this installer's (see isOursEntry):
  // a bare `cli/bin.js` substring would also match some other npm CLI's built binary.
  const stats = `${nodeCommand(ctx.cwd, smeltBinPath(), 'stats')} 2>/dev/null || true # ${OURS_TOKEN}`;
  const map = `${nodeCommand(
    ctx.cwd,
    smeltBinPath(),
    `${MAP_ON_START_ARGS} --budget ${String(ctx.budgetBytes)} --cache .smelt/tags`,
  )} 2>/dev/null || true # ${OURS_TOKEN}`;
  const lint = `${nodeCommand(
    ctx.cwd,
    smeltBinPath(),
    AGENTS_LINT_ARGS,
  )} 2>/dev/null || true # ${OURS_TOKEN}`;

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
 * The two `SessionStart` commands' distinguishing arguments, and **the substrings a
 * re-run recognises each entry by**. Spelled once so the writer and the reader cannot
 * drift: `presetToggles` tells the two entries apart by the command each one runs, and
 * a wizard that wrote `agents lint .` while its reader looked for `agents lint` would
 * read every re-run's lint toggle back as off and quietly delete it.
 */
const MAP_ON_START_ARGS = 'map .';
export const AGENTS_LINT_ARGS = 'agents lint .';

/**
 * True for a hook entry this installer wrote. Matched on the shim script paths and the
 * `smelt:hooks` token the stats/map commands carry — never on a substring as generic
 * as `cli/bin.js`, which another npm CLI's built binary could share: remove and
 * re-install may only ever touch entries that are provably smelt's.
 */
function isOursEntry(entry: unknown): boolean {
  const text = JSON.stringify(entry) ?? '';
  return text.includes('hooks/shims/') || text.includes(OURS_TOKEN);
}

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
}

interface InstallPlan {
  readonly files: readonly PlannedFile[];
  readonly skipped: readonly SkippedFile[];
  readonly notes: readonly string[];
}

function planFile(cwd: string, name: string, content: string, mode?: number): PlannedFile {
  const path = join(cwd, name);
  const exists = existsSync(path);
  const unchanged = exists && readFileSync(path, 'utf8') === content;
  return { name, path, content, exists, unchanged, ...(mode === undefined ? {} : { mode }) };
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
  const configPath = findConfigFile(cwd) ?? join(cwd, CONFIG_FILE_NAME);
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
    name: portablePath(cwd, configPath),
    path: configPath,
    content: renderConfigWithHooks(existingConfig, hooksBlock),
    exists: existsSync(configPath),
    unchanged: readIfExists(configPath) === renderConfigWithHooks(existingConfig, hooksBlock),
  });

  const ctx: HarnessInstallContext = {
    cwd,
    ...(choices.writtenBy === undefined ? {} : { writtenBy: choices.writtenBy }),
    guard: choices.guard,
    statsOnStop: choices.statsOnStop,
    mapOnStart: choices.mapOnStart,
    lintOnStart: choices.lintOnStart,
    thresholdBytes: choices.thresholdBytes,
    budgetBytes,
  };
  const snippet = instructionSnippet(choices.thresholdBytes, budgetBytes, choices.writtenBy);

  const planJsonHooks = (
    name: string,
    events: Record<string, readonly unknown[]>,
    shape: { readonly version?: number } = {},
  ): void => {
    const path = join(cwd, name);
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
    files.set(path, planFile(cwd, name, merged));
  };

  const planBlockFile = (
    name: string,
    block: string,
    start: string,
    end: string,
    skipWhen?: { readonly contains: string; readonly why: string },
  ): void => {
    const path = join(cwd, name);
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
    files.set(path, planFile(cwd, name, upsertMarkerBlock(existing, block, start, end)));
  };

  for (const profile of choices.harnesses) {
    for (const step of profile.install) {
      switch (step.kind) {
        case 'json-hooks':
          planJsonHooks(
            step.file,
            jsonHookEvents(step, ctx, shimCommand(profile, cwd)),
            step.shape ?? {},
          );
          break;
        case 'marker-block':
          planBlockFile(step.file, step.block(ctx), step.start, step.end, step.skipWhen);
          break;
        case 'own-file':
          if (step.guardOnly && !ctx.guard) break;
          files.set(join(cwd, step.file), planFile(cwd, step.file, step.content(ctx), step.mode));
          break;
        case 'mcp-registration': {
          // Byte-faithful beside whatever servers the user already registered —
          // sibling entries, key order and indentation all ride through.
          const existing = readIfExists(join(cwd, step.file));
          const merged = editJsonProperty(
            existing ?? '{}',
            step.path,
            step.entry(ctx),
            existing === undefined ? undefined : jsonStyle(existing),
          );
          if (merged === undefined) {
            skipped.push({
              name: step.file,
              why: 'exists but is not a JSON object — fix or remove it, then re-run',
            });
            break;
          }
          files.set(join(cwd, step.file), planFile(cwd, step.file, merged));
          break;
        }
        case 'toml-mcp-registration': {
          // The TOML sibling of 'mcp-registration': table-form or dotted-form, beside
          // whatever the user already has — via currentContent, so a profile whose
          // marker-block step already wrote this file (Codex's [features] block) is
          // edited on top of that plan rather than overwritten by a fresh disk read.
          const path = join(cwd, step.file);
          const existing = currentContent(path);
          const merged = editTomlTable(existing ?? '', step.path, step.entry(ctx));
          if (merged === undefined) {
            skipped.push({
              name: step.file,
              why: 'the server is already registered both as a table and as dotted keys — fix by hand, then re-run',
            });
            break;
          }
          files.set(path, planFile(cwd, step.file, merged));
          break;
        }
      }
    }

    if (profile.instructions === 'snippet') {
      planBlockFile(profile.instructionFile, snippet, SNIPPET_START_MD, SNIPPET_END_MD);
    } else {
      files.set(
        join(cwd, profile.instructionFile),
        planFile(cwd, profile.instructionFile, profile.instructions(ctx)),
      );
    }

    for (const caveat of profile.caveats) notes.push(`${profile.name}: ${caveat}`);
  }

  return { files: [...files.values()], skipped, notes };
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
): readonly PlannedRemoval[] {
  const removals = new Map<string, PlannedRemoval>();

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

  const planJsonStrip = (name: string): void => {
    const path = join(cwd, name);
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

  const planBlockStrip = (name: string, start: string, end: string): void => {
    const path = join(cwd, name);
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

  const planWholeFileDelete = (name: string): void => {
    const path = join(cwd, name);
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
  const planMcpStrip = (name: string, keys: readonly [string, string]): void => {
    const path = join(cwd, name);
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
  const planTomlMcpStrip = (name: string, keys: readonly [string, string]): void => {
    const path = join(cwd, name);
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
    for (const step of profile.install) {
      switch (step.kind) {
        case 'json-hooks':
          planJsonStrip(step.file);
          break;
        case 'marker-block':
          planBlockStrip(step.file, step.start, step.end);
          break;
        case 'own-file':
          planWholeFileDelete(step.file);
          break;
        case 'mcp-registration':
          planMcpStrip(step.file, step.path);
          break;
        case 'toml-mcp-registration':
          planTomlMcpStrip(step.file, step.path);
          break;
      }
    }
    if (profile.instructions === 'snippet') {
      planBlockStrip(profile.instructionFile, SNIPPET_START_MD, SNIPPET_END_MD);
    } else {
      planWholeFileDelete(profile.instructionFile);
    }
  }

  return [...removals.values()];
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

  io.output(
    `${CLI_NAME} hooks install — wires the smelt guard into agent-harness hooks.\n` +
      `Answer \`back\` at any step to return to the previous one. Nothing is written ` +
      `until you confirm at the end.\n\n`,
  );

  const choices: HooksChoices = {
    harnesses: harnessFlag !== undefined ? [resolveHarnessFlag(harnessFlag)] : [...detected],
    ...(io.version === undefined ? {} : { writtenBy: io.version }),
    ...presetToggles(io.cwd),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
  };

  // With --harness the selection step is skipped, so the tier label — and its one
  // line of honesty about what the tier means — is printed here instead.
  if (harnessFlag !== undefined) {
    for (const profile of choices.harnesses) io.output(`  ${tierLabel(profile)}\n`);
  }

  const steps: readonly ((io_: HooksIo, ask_: Asker) => Promise<'ok' | 'back'>)[] = [
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
/**
 * Whether a JSON hook file's text carries entries of ours — the **one** predicate for
 * this fact, shared by the readers (`smelt doctor`, `smelt setup`'s repair policy) and
 * backed by the same `isOursEntry` the writer's strip-merge uses. The guard command
 * itself carries only the shim path (no token), so a text-level `OURS_TOKEN` search
 * would miss a guard-only install — the exact drift this exists to prevent.
 */
export function jsonHooksContainOurs(text: string): boolean {
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
  if (hooks === undefined) return false;
  return MANAGED_EVENTS.some((event) =>
    Array.isArray(hooks[event])
      ? (hooks[event] as unknown[]).some((entry) => isOursEntry(entry))
      : false,
  );
}

export function presetToggles(
  cwd: string,
): Pick<HooksChoices, 'guard' | 'statsOnStop' | 'mapOnStart' | 'lintOnStart'> {
  const defaults = { guard: true, statsOnStop: true, mapOnStart: false, lintOnStart: false };
  let anyOurs = false;
  let guard = false;
  let statsOnStop = false;
  let mapOnStart = false;
  let lintOnStart = false;

  for (const name of JSON_HOOK_FILES) {
    const text = readIfExists(join(cwd, name));
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
    /** One of ours under `event` whose command carries `needle`. */
    const hasOursRunning = (event: string, needle: string): boolean =>
      oursUnder(event).some((entry) => (JSON.stringify(entry) ?? '').includes(needle));
    if (!MANAGED_EVENTS.some((event) => hasOurs(event))) continue;
    anyOurs = true;
    guard ||= GUARD_EVENTS.some((event) => hasOurs(event));
    statsOnStop ||= hasOurs(LIFECYCLE_EVENTS.stats);
    mapOnStart ||= hasOursRunning(LIFECYCLE_EVENTS.map, MAP_ON_START_ARGS);
    lintOnStart ||= hasOursRunning(LIFECYCLE_EVENTS.lint, AGENTS_LINT_ARGS);
  }

  for (const name of GUARD_ONLY_FILES) {
    const text = readIfExists(join(cwd, name));
    if (text !== undefined && text.includes(OURS_TOKEN)) {
      anyOurs = true;
      guard = true;
    }
  }

  return anyOurs ? { guard, statsOnStop, mapOnStart, lintOnStart } : defaults;
}

const fileLabel = (file: PlannedFile): string => {
  if (file.unchanged) return 'unchanged — nothing to write';
  return file.exists ? 'exists — will ask before overwriting' : 'new';
};

async function confirmAndInstall(
  io: HooksIo,
  ask: Asker,
  choices: HooksChoices,
): Promise<'done' | 'back'> {
  const plan = planInstall(io.cwd, choices);

  io.output(`\nAbout to write, into ${io.cwd}:\n`);
  listPlannedFiles(io.output, plan.files, plan.skipped, fileLabel);
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

  for (const file of plan.files) {
    if (file.unchanged) {
      io.output(`  ${file.name} — unchanged, not rewritten\n`);
      continue;
    }
    if (file.exists) {
      // The one hard rule, same as `smelt init`: an existing file is never touched
      // without an explicit per-file yes — not `y`, not Enter, a literal `yes`.
      const answer = await ask(`  ${file.name} exists — overwrite it? (yes/no)> `);
      if (answer !== 'yes') {
        io.output(`  skipped ${file.name} — the existing file was not touched\n`);
        continue;
      }
    }
    writePlannedFile(file);
    io.output(`  wrote ${file.name}\n`);
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
  const removals = planRemove(io.cwd, harnesses);

  if (removals.length === 0) {
    io.output(`${CLI_NAME} hooks remove: nothing of smelt's found to remove in ${io.cwd}.\n`);
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
