import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { DEFAULT_THRESHOLD_BYTES, GUARD_CONFIG_FILE_NAME } from '../hooks/guard-core.ts';
import { SMELT_COMMAND_NAME, smeltOnPath } from '../hooks/invocation.ts';
import type { InvocationEnv } from '../hooks/invocation.ts';
import { asRecord } from '../hooks/shim.ts';
import type { HarnessHookSchema } from '../hooks/shim.ts';

import { nodeCommand } from './paths.ts';
import { hasShim } from './profile.ts';
import type { HarnessOwnFileProbe, HarnessProfile, ShimmedHarnessProfile } from './profile.ts';
import { MANAGED_EVENTS } from './registry.ts';
import { OURS_TOKEN } from './snippet.ts';

/**
 * HookCommand — the one module that owns what a smelt hook entry *says*, in both
 * directions, plus the one honest way to ask whether it still does anything.
 *
 * A hook command used to be a string with three readers. The installer wrote it
 * (`cli/hooks.ts`), and three separate substring searches re-recognised it: the
 * ownership check that decides which entries a re-run may replace, the toggle reader
 * that tells the opening map from the instruction lint, and `cli/installed.ts`'s
 * per-file "is this ours". Each carried its own needle (`hooks/shims/`, `map .`,
 * `agents lint .`, the `smelt:hooks` token), and a writer that changed its spelling
 * would leave all three quietly reading for the old one.
 *
 * So the command is a **value** here, and the string is a rendering of it:
 * {@link renderHookCommand} is the only writer, {@link parseHookCommand} is the only
 * reader, and `parseHookCommand(renderHookCommand(c, cwd))` is `c` for every kind —
 * pinned by `test/guards/hook-command.test.ts`. An entry the parser does not
 * recognise is *foreign*, which is the property the merge needs: an installer may
 * only ever replace entries it can prove are its own.
 *
 * {@link probeHookCommand} and {@link probeOwnFile} are the second half, and the reason
 * this module is not just a parser. `smelt doctor` printed `wired` for any file carrying
 * an entry of ours — a text fact, never a running one. A shim reached through a symlink
 * (defect 1, fixed in `hooks/invocation.ts`) and a keg path deleted by `brew upgrade`
 * (defect 2) both leave that text exactly as it was while the guard does nothing, and
 * empty stdout is how every harness schema spells *allow*. The probe runs the command
 * against a synthetic payload built from the harness's own {@link HarnessHookSchema} and
 * reports what came back. It reads; it never repairs (ADR-0003), and it never touches
 * the project: the file it oversizes lives in a fresh temp directory that is removed
 * again.
 *
 * {@link probeOwnFile} is the same answer for the three harnesses whose wiring is a file
 * smelt owns **whole** — Cline's wrapper, Hermes's YAML, opencode's plugin — which
 * carry no hook entries and so were the last places a plain `wired` survived. What each
 * of those files runs, and how to ask it, is declared on the profile beside the renderer
 * that wrote it (`HarnessOwnFileProbe`); this module folds over that declaration, and
 * nothing here asks which harness it is looking at.
 */

/* ------------------------------------------------------------------------------------
 * The value
 * ---------------------------------------------------------------------------------- */

/** What a hook command does. The guard is a script; the rest are `smelt` verbs. */
export type HookCommandKind = 'guard' | 'stats' | 'map' | 'lint';

/**
 * One hook command, as data.
 *
 *  - `guard` runs a harness's shim script through node. It is deliberately not built
 *    like the others: a shim is a *script*, not a bin, and `smelt` has no verb that
 *    runs one.
 *  - `stats` / `map` / `lint` run a `smelt` verb, in whichever spelling this machine
 *    can still run after an upgrade (see `hooks/invocation.ts`). `script` is required
 *    exactly when `invocation` is `'node'`; a `'node'` command carrying none renders a
 *    command {@link parseHookCommand} refuses, which is a visible programming error
 *    rather than a silently reinterpreted one.
 */
export type HookCommand =
  | { readonly kind: 'guard'; readonly script: string }
  | {
      readonly kind: 'stats' | 'map' | 'lint';
      readonly invocation: 'path' | 'node';
      readonly script?: string;
      readonly args: string;
    };

/** One hook entry read back off disk: the event it sits under, and its command. */
export interface HookEntry {
  readonly event: string;
  readonly command: HookCommand;
}

/**
 * The tail every lifecycle command carries.
 *
 * `2>/dev/null || true` because a session hook that fails must never fail the session,
 * and the trailing shell comment tags the entry as this installer's: a bare
 * `cli/bin.js` substring would also match some other npm CLI's built binary, and a
 * `smelt <verb>` spelling carries no path at all to recognise. It is not decoration —
 * {@link parseHookCommand} refuses a lifecycle command that does not carry it.
 */
export const HOOK_COMMAND_TAIL = ` 2>/dev/null || true # ${OURS_TOKEN}`;

/** The `smelt map` arguments the opening-map hook runs. */
export const MAP_ON_START_ARGS = 'map .';

/** The `smelt agents lint` arguments the instruction-file lint hook runs. */
export const AGENTS_LINT_ARGS = 'agents lint .';

/**
 * The exact string a harness config carries for this command — the only writer.
 *
 * Paths are portable relative to `root` (a path inside the project travels with the
 * repo), which is `harness/paths.ts`'s rule and not this module's. `undefined` is the
 * user scope's answer: a machine-level hook runs from whatever project the agent
 * opened, so it names every path absolutely.
 */
export function renderHookCommand(cmd: HookCommand, root: string | undefined): string {
  if (cmd.kind === 'guard') return nodeCommand(root, cmd.script);
  const prefix =
    cmd.invocation === 'path' ? SMELT_COMMAND_NAME : nodeCommand(root, cmd.script ?? '');
  return `${prefix} ${cmd.args}${HOOK_COMMAND_TAIL}`;
}

/** A shim script: `.../hooks/shims/<harness id>.js`, absolute or project-relative. */
const SHIM_SCRIPT = /(^|\/)hooks\/shims\/[^/]+\.js$/u;

/** This package's own binary — the only script a lifecycle command may name. */
const BIN_SCRIPT = /(^|\/)cli\/bin\.js$/u;

/**
 * The path with `\` read as `/`, for the two tests above — and **only** for them: the
 * value keeps the spelling the config file actually carries, so the round trip holds.
 *
 * `harness/paths.ts` converts separators for a project-relative path and hands an
 * absolute one back untouched, so on Windows every absolute script in a hook command
 * is written with backslashes. Anchoring the two tests on `/` alone made
 * `node "C:\smelt\dist\cli\bin.js" map . …` foreign — and the toggle reader that
 * used to substring-match would then read the map toggle back as off and a re-run
 * would delete the entry the user had set.
 */
function withForwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

/** `node <script> [args]`, in the three quotings a config file is written with. */
const NODE_COMMAND = /^node\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*(.*)$/u;

/**
 * `$(readlink -f <path>)` — not a spelling smelt writes, but one users have on disk
 * today: it is the manual workaround for the symlink defect, and a reader that called
 * those entries foreign would duplicate them on the next install instead of replacing
 * them.
 */
const READLINK = /^\$\(\s*readlink\s+-f\s+(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)$/u;

/**
 * `smelt <args>` — the bare-name spelling, for a machine with `smelt` on PATH. Built
 * from {@link SMELT_COMMAND_NAME}, the same constant `smeltInvocation` puts in
 * `command`, so the reader cannot look for a name the ranking has stopped writing.
 */
const SMELT_COMMAND = new RegExp(`^${SMELT_COMMAND_NAME}\\s+(.*)$`, 'u');

/**
 * The command a harness config carries, as a value — or `undefined` for an entry that
 * is not ours.
 *
 * `undefined` is load-bearing: it is what tells the merge an entry belongs to somebody
 * else, so being generous here would let a re-run replace a foreign hook. The two kinds
 * are recognised by different evidence, because they carry different amounts of it:
 *
 *  - a **guard** command names a shim, `<...>/hooks/shims/<harness id>.js`, and that
 *    path is smelt's own by construction;
 *  - a **lifecycle** command names `cli/bin.js` — a path another npm CLI's built binary
 *    could share — or nothing at all (`smelt stats`). Neither is evidence, so for these
 *    the `# smelt:hooks` tail **is part of the recognised shape**: a `stats`, `map` or
 *    `lint` command without it is foreign. {@link renderHookCommand} always writes the
 *    tail, so the round trip is unaffected, and the cost of being wrong here is a re-run
 *    that deletes somebody else's `Stop` hook.
 */
export function parseHookCommand(command: string): HookCommand | undefined {
  const { text, tagged } = withoutTail(command);
  const node = NODE_COMMAND.exec(text);
  if (node !== null) {
    const script = unwrapReadlink(node[1] ?? node[2] ?? node[3] ?? '');
    const posix = withForwardSlashes(script);
    const args = (node[4] ?? '').trim();
    if (args === '') {
      return SHIM_SCRIPT.test(posix) ? { kind: 'guard', script } : undefined;
    }
    if (!BIN_SCRIPT.test(posix)) return undefined;
    const kind = lifecycleKind(args, tagged);
    return kind === undefined ? undefined : { kind, invocation: 'node', script, args };
  }
  const smelt = SMELT_COMMAND.exec(text);
  if (smelt === null) return undefined;
  const args = (smelt[1] ?? '').trim();
  const kind = lifecycleKind(args, tagged);
  return kind === undefined ? undefined : { kind, invocation: 'path', args };
}

/** The command with its ownership tail taken off, and whether it carried one. */
interface TaggedCommand {
  readonly text: string;
  /** True when the trailing shell comment carried {@link OURS_TOKEN}. */
  readonly tagged: boolean;
}

/**
 * The command without its ownership tail. The shell comment is stripped only when it
 * carries {@link OURS_TOKEN}, so a `#` inside somebody's quoted path is left alone.
 */
function withoutTail(command: string): TaggedCommand {
  let text = command.trim();
  const hash = text.lastIndexOf('#');
  const tagged = hash !== -1 && text.slice(hash).includes(OURS_TOKEN);
  if (tagged) text = text.slice(0, hash).trimEnd();
  if (text.endsWith('|| true')) text = text.slice(0, -'|| true'.length).trimEnd();
  if (text.endsWith('2>/dev/null')) text = text.slice(0, -'2>/dev/null'.length).trimEnd();
  return { text, tagged };
}

/**
 * The lifecycle kind these arguments are — **only** for a command that carried the
 * ownership tail.
 *
 * The tail is the whole of the evidence here. `stats` on `Stop`, and a `map .` or
 * `agents lint .` on `SessionStart`, are ordinary enough shapes that another tool could
 * write one; the path a lifecycle command names is `cli/bin.js`, which another npm CLI's
 * built binary could share; and the `smelt <verb>` spelling carries no path at all.
 * Recognising one of these without the token would let a re-run replace or delete a
 * foreign session hook that merely looks like ours.
 */
function lifecycleKind(args: string, tagged: boolean): 'stats' | 'map' | 'lint' | undefined {
  if (!tagged) return undefined;
  return verbKind(args);
}

function unwrapReadlink(script: string): string {
  const match = READLINK.exec(script);
  return match === null ? script : (match[1] ?? match[2] ?? match[3] ?? script);
}

/**
 * Which lifecycle hook these arguments are — the verb table both directions share.
 *
 * `map` and `lint` sit under the *same* `SessionStart` event, so the arguments are the
 * only thing that tells them apart: a reader that confused them would read a re-run's
 * toggles back wrong and quietly delete the entry the user believed they had set.
 */
function verbKind(args: string): 'stats' | 'map' | 'lint' | undefined {
  const words = args.split(/\s+/u);
  if (words[0] === 'stats') return 'stats';
  if (`${words[0] ?? ''} ${words[1] ?? ''}` === MAP_ON_START_ARGS) return 'map';
  if (`${words[0] ?? ''} ${words[1] ?? ''} ${words[2] ?? ''}` === AGENTS_LINT_ARGS) return 'lint';
  return undefined;
}

/* ------------------------------------------------------------------------------------
 * Recognising our entries in somebody else's settings file
 * ---------------------------------------------------------------------------------- */

/**
 * Every command string one hook entry carries — Claude Code's `{matcher, hooks:[{type,
 * command}]}` and Cursor's bare `{command}`, the two entry shapes the profiles declare.
 */
export function hookEntryCommands(entry: unknown): readonly string[] {
  const record = asRecord(entry);
  const commands: string[] = [];
  if (typeof record['command'] === 'string') commands.push(record['command']);
  const hooks = record['hooks'];
  if (Array.isArray(hooks)) {
    for (const one of hooks) {
      const command = asRecord(one)['command'];
      if (typeof command === 'string') commands.push(command);
    }
  }
  return commands;
}

/**
 * True for a hook entry this installer wrote — the **one** predicate for that fact,
 * shared by the merge (which entries a re-run may replace), the toggle reader and
 * `cli/installed.ts`.
 *
 * A command the parser recognises is ours by construction — and the parser is where the
 * standing rule lives that ownership is never decided on a substring as generic as
 * `cli/bin.js`, which another npm CLI's built binary could share: a lifecycle command
 * has to carry the `smelt:hooks` token to be recognised at all. The token check behind
 * it catches an entry a user hand-edited past recognition but left tagged: a re-run
 * replacing that is right, and orphaning it is not.
 */
export function isOursEntry(entry: unknown): boolean {
  if (hookEntryCommands(entry).some((command) => parseHookCommand(command) !== undefined)) {
    return true;
  }
  return (JSON.stringify(entry) ?? '').includes(OURS_TOKEN);
}

/** The `hooks` object of a JSON settings file, or `undefined` when there is none. */
function hooksObject(text: string): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const hooks = asRecord(parsed)['hooks'];
  return typeof hooks === 'object' && hooks !== null && !Array.isArray(hooks)
    ? (hooks as Record<string, unknown>)
    : undefined;
}

/**
 * Whether a JSON hook file's text carries entries of ours.
 *
 * Entry-level on purpose: the guard command carries only a shim path and no token, so
 * a text-level {@link OURS_TOKEN} search misses a guard-only install — the exact drift
 * this predicate exists to prevent.
 */
export function jsonHooksContainOurs(text: string): boolean {
  const hooks = hooksObject(text);
  if (hooks === undefined) return false;
  return MANAGED_EVENTS.some((event) =>
    Array.isArray(hooks[event]) ? (hooks[event] as unknown[]).some(isOursEntry) : false,
  );
}

/**
 * Every command of ours a JSON hook file carries, with the event it fires under.
 * Foreign entries are absent rather than reported: this is the reading `smelt doctor`
 * probes, and nothing here has an opinion about somebody else's hooks.
 */
export function parseHookEntries(text: string): readonly HookEntry[] {
  const hooks = hooksObject(text);
  if (hooks === undefined) return [];
  const entries: HookEntry[] = [];
  for (const event of MANAGED_EVENTS) {
    const under = hooks[event];
    if (!Array.isArray(under)) continue;
    for (const entry of under) {
      for (const written of hookEntryCommands(entry)) {
        const command = parseHookCommand(written);
        if (command !== undefined) entries.push({ event, command });
      }
    }
  }
  return entries;
}

/* ------------------------------------------------------------------------------------
 * Reading a file smelt owns whole
 * ---------------------------------------------------------------------------------- */

/**
 * The one entry a whole-owned hook file carries — Cline's wrapper, Hermes's YAML, the
 * opencode plugin — read back the way its renderer wrote it.
 *
 * There is always exactly one, and that is the point: these files have no event-to-entry
 * table, so a reader that returned nothing for a file it could not make sense of would
 * hand doctor the same silence as a file with nothing wrong. The command names what the
 * file *runs* (the shim it execs, the plugin the harness imports), falling back to the
 * file itself when the shape the renderer wrote is no longer in it — which the probe
 * then reports as inert rather than as a file it never looked at.
 */
export function ownFileEntry(probe: HarnessOwnFileProbe, file: string, text: string): HookEntry {
  return { event: probe.event, command: { kind: 'guard', script: ownFileRuns(probe, file, text) } };
}

/** What the file runs, as the renderer spelled it — or the file, when it says nothing. */
function ownFileRuns(probe: HarnessOwnFileProbe, file: string, text: string): string {
  if (probe.kind === 'esm-plugin') return file;
  const command = commandBehind(probe.prefix, text);
  const parsed = command === undefined ? undefined : parseHookCommand(command);
  return parsed?.kind === 'guard' ? parsed.script : file;
}

/**
 * The command a fixed prefix introduces — `exec node "<shim>"`, `- command: node
 * "<shim>"` — with the prefix taken off and nothing else interpreted.
 *
 * The prefix is the renderer's own (it is declared on the step beside the renderer that
 * wrote it), and what follows goes to {@link parseHookCommand}. So a whole-owned file is
 * read by the same reader as every other hook command, and neither Cline's `exec` nor
 * Hermes's YAML list item needs a syntax of its own here.
 */
function commandBehind(prefix: string, text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return undefined;
}

/** The `const <name> = "<path>";` binding a rendered ES module carries. */
function bindingIn(name: string, text: string): string | undefined {
  const match = new RegExp(`^const ${name} = ("[^"]*");`, 'mu').exec(text);
  if (match?.[1] === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(match[1]);
    return typeof value === 'string' ? value : undefined;
  } catch {
    /* v8 ignore next -- the writer JSON.stringify'd it; a hand-edit is the only way here */
    return undefined;
  }
}

/* ------------------------------------------------------------------------------------
 * The probe
 * ---------------------------------------------------------------------------------- */

/**
 * What running the command actually did.
 *
 *  - `fires` — the command ran and did its job: the guard answered with this harness's
 *    deny document, or the binary answered `--version`.
 *  - `inert` — the command ran and did nothing. This is the dangerous one: empty stdout
 *    is how every harness schema spells *allow*, so an inert guard reads exactly like a
 *    working one from inside the session.
 *  - `missing` — there is nothing to run.
 */
export interface HookProbe {
  readonly status: 'fires' | 'inert' | 'missing';
  /** The script the probe resolved and ran, when the command names one. */
  readonly script?: string;
  /** What happened, in the words a report prints. */
  readonly detail: string;
}

/** Everything the probe reads besides the command itself. Small on purpose. */
export interface HookProbeIo {
  /** The project directory a portable (relative) script path resolves against. */
  readonly cwd: string;
  /** Where a bare `smelt` is looked for. Defaults to this process's environment. */
  readonly env?: InvocationEnv;
  /** How long a spawned script gets before the probe calls it inert. */
  readonly timeoutMs?: number;
}

/** A probe that hangs is a probe that never answers. Five seconds, then a verdict. */
export const HOOK_PROBE_TIMEOUT_MS = 5000;

/**
 * The size of the file the guard probe asks about — comfortably over
 * `DEFAULT_THRESHOLD_BYTES` (8 192), which the probe **pins** in the scratch directory
 * rather than relying on it being the default there.
 */
export const HOOK_PROBE_FILE_BYTES = 9000;

/** The reason slot of a rendered deny document, filled with what no schema spells. */
const REASON_SENTINEL = ' smelt-probe-reason ';

/**
 * Run the command and report what it did — read-only, and never against the project.
 *
 * The guard is probed the way the harness probes it: a payload built from the profile's
 * own {@link HarnessHookSchema} — its read-tool name, its payload keys, its cwd key —
 * naming an oversized file, and the answer compared against the deny document that
 * schema wants back. The file is written into a fresh temp directory and the shim is
 * spawned *there*, beside a `smelt.config.json` pinning the threshold and `deny`, so
 * the project's config is not consulted and no elision store is ever opened.
 */
export function probeHookCommand(
  cmd: HookCommand,
  profile: ShimmedHarnessProfile,
  io: HookProbeIo,
): HookProbe {
  return cmd.kind === 'guard' ? probeGuard(cmd.script, profile, io) : probeLifecycle(cmd, io);
}

/**
 * {@link probeHookCommand}'s sibling for a file smelt owns **whole**: Cline's executable
 * wrapper, Hermes's `hooks.yaml`, opencode's plugin.
 *
 * Three harnesses wire the guard through a file with no hook entries in it, and doctor
 * used to print a plain `wired` for all three — the text fact PR 2 set out to end,
 * surviving in the three places it was hardest to read. This fold answers for them from
 * the {@link HarnessOwnFileProbe} their profile declares, so nothing here asks which
 * harness it is looking at:
 *
 *  - `command-line` — take the command the renderer wrote behind its prefix, read it
 *    with the one reader, and probe the shim it names exactly as a JSON entry's guard
 *    command is probed. Same payload, same scratch directory, same verdicts.
 *  - `esm-plugin` — load the module the way the harness loads it. The plugin imports the
 *    built guard core at its top level, so a resolvable import graph *is* the thing
 *    being checked: `fires` means it loaded and exported the hook, `missing` means the
 *    plugin or the core it names is gone, `inert` means it loaded and exports no hook.
 *    No opencode binary is involved, and nothing but this process's own node is spawned.
 */
export function probeOwnFile(
  probe: HarnessOwnFileProbe,
  file: string,
  profile: HarnessProfile,
  io: HookProbeIo,
): HookProbe {
  const path = resolveScript(file, io.cwd);
  if (!existsSync(path)) {
    return {
      status: 'missing',
      script: path,
      detail: `${path} does not exist, so nothing wires the guard for ${profile.id}`,
    };
  }
  const text = readFileSync(path, 'utf8');
  if (probe.kind === 'esm-plugin') return probePlugin(probe, path, text, io);
  const command = commandBehind(probe.prefix, text);
  const parsed = command === undefined ? undefined : parseHookCommand(command);
  if (parsed?.kind !== 'guard') {
    return {
      status: 'inert',
      script: path,
      detail: `${path} carries no \`${probe.prefix.trim()}\` line naming a smelt shim, so it runs nothing of ours`,
    };
  }
  /* v8 ignore next 3 -- unreachable: only a shimmed profile declares a command-line probe */
  if (!hasShim(profile)) {
    return { status: 'inert', script: path, detail: `${profile.id} ships no shim to probe` };
  }
  return probeGuard(parsed.script, profile, io);
}

/**
 * Load a rendered plugin the way the harness would: import it, call the factory it
 * exports, and see whether the hook the harness calls is there.
 *
 * The loader runs in the scratch directory through `node --input-type=module -e`, so the
 * import graph is resolved for real — the plugin's own top-level `await import(<guard
 * core>)` included, which is the edge that a moved or deleted `dist` breaks and which
 * no amount of reading the file can prove. The core's path is read out of the binding
 * the renderer wrote it into, and checked before the spawn, so "the core is gone" is
 * `missing` (a fact) rather than `inert` (a verdict about behaviour).
 */
function probePlugin(
  probe: Extract<HarnessOwnFileProbe, { readonly kind: 'esm-plugin' }>,
  path: string,
  text: string,
  io: HookProbeIo,
): HookProbe {
  const core = bindingIn(probe.core, text);
  if (core === undefined) {
    return {
      status: 'inert',
      script: path,
      detail: `${path} names no ${probe.core}, so it imports no guard core and decides nothing`,
    };
  }
  const corePath = resolveScript(core, io.cwd);
  if (!existsSync(corePath)) {
    // The *core* is what is missing, so it is what `script` names: the plugin is still
    // sitting there, and a line naming the file that exists would send somebody looking
    // in the wrong place — this is what `brew upgrade` leaves behind for opencode.
    return {
      status: 'missing',
      script: corePath,
      detail: `${path} imports ${corePath}, which does not exist: the plugin throws before it can decide anything`,
    };
  }
  const timeoutMs = io.timeoutMs ?? HOOK_PROBE_TIMEOUT_MS;
  const scratch = probeScratchDir();
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', pluginLoader(probe)], {
      input: '',
      encoding: 'utf8',
      cwd: scratch,
      env: loaderEnv(path),
      timeout: timeoutMs,
    });
    if (run.error !== undefined) {
      return { status: 'inert', script: path, detail: runFailure(run, path, timeoutMs) };
    }
    if (run.stdout.trim() === PLUGIN_FIRES) {
      return { status: 'fires', script: path, detail: `${path} loads and exports ${probe.event}` };
    }
    return {
      status: 'inert',
      script: path,
      detail: `${path} did not load an ${probe.event} hook${runTrailer(run)}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** What the loader prints when the plugin loaded and the hook is there. */
const PLUGIN_FIRES = 'smelt-plugin-fires';

/**
 * The variables node itself needs to start and resolve a module graph, and nothing
 * else. The loader resolves imports; it does not run policy, and it is not the harness.
 *
 * Handing it this process's whole environment would hand somebody else's code every
 * secret in it (`smelt doctor` is run inside sessions that hold API keys) for a question
 * about which files exist. `NODE_OPTIONS` is deliberately not on the list: it can inject
 * a `--require` into the probe, and a probe that can be steered is not evidence.
 */
function loaderEnv(plugin: string): Readonly<Record<string, string>> {
  const carried: Record<string, string> = { SMELT_PROBE_PLUGIN: plugin };
  // PATH and HOME because node reads them at startup; the Windows three because a
  // process started without them cannot even open a temp file there.
  for (const name of ['PATH', 'Path', 'HOME', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP']) {
    const value = process.env[name];
    if (value !== undefined) carried[name] = value;
  }
  return carried;
}

/**
 * The loader script, as source. The plugin's path travels in the environment rather
 * than spliced into the program text: a path is data, and a path with a quote in it
 * spliced into a program is an injection.
 */
function pluginLoader(
  probe: Extract<HarnessOwnFileProbe, { readonly kind: 'esm-plugin' }>,
): string {
  return [
    `import { pathToFileURL } from 'node:url';`,
    `const mod = await import(pathToFileURL(process.env.SMELT_PROBE_PLUGIN).href);`,
    `const factory = mod[${JSON.stringify(probe.factory)}];`,
    `if (typeof factory !== 'function') process.exit(3);`,
    `const hooks = await factory({});`,
    `if (typeof hooks?.[${JSON.stringify(probe.event)}] !== 'function') process.exit(4);`,
    `process.stdout.write(${JSON.stringify(PLUGIN_FIRES)});`,
  ].join('\n');
}

function resolveScript(script: string, cwd: string): string {
  return isAbsolute(script) ? script : join(cwd, script);
}

/**
 * A fresh directory to run a probe in, with the guard's settings pinned inside it.
 *
 * The pin is not decoration. `findGuardConfigFile` walks up from the process cwd to
 * the filesystem root, and the system temp directory is not always above nothing —
 * on Windows it sits under the user's profile, where a `smelt.config.json` with
 * `hooks.thresholdBytes: 100000` would make a working guard allow the probe's file
 * and be reported `wired but inert`, costing `current` and printing a repair line for
 * an install that is fine. Writing the file stops the walk here and makes the premise
 * the probe rests on explicit instead of ambient.
 */
function probeScratchDir(): string {
  const scratch = mkdtempSync(join(tmpdir(), 'smelt-hook-probe-'));
  writeFileSync(
    join(scratch, GUARD_CONFIG_FILE_NAME),
    `${JSON.stringify({
      smeltConfig: 1,
      hooks: { thresholdBytes: DEFAULT_THRESHOLD_BYTES, enforcement: 'deny' },
    })}\n`,
  );
  return scratch;
}

/** What a finished spawn says about itself, for a detail line. */
function runTrailer(run: {
  readonly status: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}): string {
  const exit =
    run.status === null ? `signal ${run.signal ?? 'unknown'}` : `exit ${String(run.status)}`;
  const first = run.stderr.split('\n').find((line) => line.trim() !== '');
  return first === undefined ? ` (${exit})` : ` (${exit}; stderr: ${first.trim()})`;
}

/** Timed out, or never started at all — two different things to tell somebody. */
function runFailure(run: { readonly error?: Error }, script: string, timeoutMs: number): string {
  const error = run.error;
  /* v8 ignore next -- spawnSync only sets `error` on a failure, and this is one */
  if (error === undefined) return `${script} failed to run`;
  return (error as { readonly code?: string }).code === 'ETIMEDOUT'
    ? `${script} did not answer within ${String(timeoutMs)}ms`
    : `${script} could not be run: ${error.message}`;
}

function probeGuard(written: string, profile: ShimmedHarnessProfile, io: HookProbeIo): HookProbe {
  const script = resolveScript(written, io.cwd);
  if (!existsSync(script)) {
    return {
      status: 'missing',
      script,
      detail: `${script} does not exist — the hook runs nothing, and a guard that never runs is an allow`,
    };
  }
  const timeoutMs = io.timeoutMs ?? HOOK_PROBE_TIMEOUT_MS;
  const scratch = probeScratchDir();
  try {
    const oversized = join(scratch, 'probe.log');
    writeFileSync(oversized, 'x'.repeat(HOOK_PROBE_FILE_BYTES));
    const schema = profile.hooks;
    const run = spawnSync(process.execPath, [script], {
      input: probePayload(schema, oversized, scratch),
      encoding: 'utf8',
      cwd: scratch,
      timeout: timeoutMs,
    });
    if (run.error !== undefined) {
      return { status: 'inert', script, detail: runFailure(run, script, timeoutMs) };
    }
    if (run.stdout === '') {
      // The exit code and the first stderr line ride along because the two ways to get
      // here read identically otherwise: a shim that decided *allow*, and a shim that
      // threw at import and never decided anything.
      return {
        status: 'inert',
        script,
        detail:
          `${script} allowed a ${String(HOOK_PROBE_FILE_BYTES)}-byte read — empty stdout is ` +
          `an allow, so the hook is wired but not guarding${runTrailer(run)}`,
      };
    }
    if (!isDenyDocument(run.stdout, schema)) {
      return {
        status: 'inert',
        script,
        detail: `${script} answered something other than ${profile.id}'s deny document${runTrailer(run)}`,
      };
    }
    return {
      status: 'fires',
      script,
      detail: `${script} denied a ${String(HOOK_PROBE_FILE_BYTES)}-byte read`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function probeLifecycle(
  cmd: Extract<HookCommand, { readonly args: string }>,
  io: HookProbeIo,
): HookProbe {
  if (cmd.invocation === 'path') {
    const found = smeltOnPath(io.env ?? process.env);
    return found === undefined
      ? { status: 'missing', detail: 'smelt is not on PATH' }
      : { status: 'fires', script: found, detail: `\`smelt\` resolves to ${found}` };
  }
  /* v8 ignore next 3 -- unreachable through the writer: a node command carries a script */
  if (cmd.script === undefined) {
    return { status: 'missing', detail: 'the command names no script to run' };
  }
  const script = resolveScript(cmd.script, io.cwd);
  if (!existsSync(script)) {
    return { status: 'missing', script, detail: `${script} does not exist` };
  }
  const timeoutMs = io.timeoutMs ?? HOOK_PROBE_TIMEOUT_MS;
  // The same scratch directory the guard probe uses, for the same reason: a `--version`
  // asked in the project would read the project, and this question is about the binary.
  const scratch = probeScratchDir();
  try {
    const run = spawnSync(process.execPath, [script, '--version'], {
      encoding: 'utf8',
      cwd: scratch,
      timeout: timeoutMs,
    });
    if (run.error !== undefined) {
      return { status: 'inert', script, detail: runFailure(run, script, timeoutMs) };
    }
    if (run.status !== 0) {
      return {
        status: 'inert',
        script,
        detail: `${script} did not answer \`--version\`${runTrailer(run)}`,
      };
    }
    return { status: 'fires', script, detail: `${script} answers \`--version\`` };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The stdin one oversized read looks like in this harness's schema. Built from the
 * schema's own first spellings, so a harness that renames a payload key is probed with
 * the new name by existing.
 */
function probePayload(schema: HarnessHookSchema | undefined, path: string, cwd: string): string {
  /* v8 ignore next 3 -- unreachable today: every shimmed profile carries a schema */
  if (schema === undefined) {
    return JSON.stringify({ tool_name: 'Read', tool_input: { file_path: path }, cwd });
  }
  const raw: Record<string, unknown> = {};
  setPayload(raw, schema.toolNameKeys[0] ?? 'tool_name', schema.readTools[0] ?? 'Read');
  setPayload(raw, schema.toolInputKeys[0] ?? 'tool_input', { file_path: path });
  if (schema.cwdKey !== undefined) raw[schema.cwdKey] = cwd;
  return JSON.stringify(raw);
}

/** Write one payload key, through the single level of nesting a dotted key spells. */
function setPayload(raw: Record<string, unknown>, key: string, value: unknown): void {
  const dot = key.indexOf('.');
  if (dot === -1) {
    raw[key] = value;
    return;
  }
  const outer = key.slice(0, dot);
  const nested = asRecord(raw[outer]);
  nested[key.slice(dot + 1)] = value;
  raw[outer] = nested;
}

/** Whether stdout is the deny document this schema renders, whatever the reason says. */
function isDenyDocument(stdout: string, schema: HarnessHookSchema | undefined): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return false;
  }
  /* v8 ignore next -- unreachable today: every shimmed profile carries a schema */
  if (schema === undefined) return true;
  return matchesShape(parsed, schema.deny(REASON_SENTINEL));
}

/**
 * Structural equality against a rendered template: every key the template names must be
 * present and equal, and the reason slot must be *some* non-empty string. Extra keys
 * are allowed — a harness that adds a field to its own deny document has not stopped
 * denying.
 */
function matchesShape(actual: unknown, expected: unknown): boolean {
  if (expected === REASON_SENTINEL) return typeof actual === 'string' && actual !== '';
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((one, at) => matchesShape(actual[at], one))
    );
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const fields = actual as Record<string, unknown>;
    const template = expected as Record<string, unknown>;
    return Object.keys(template).every((key) => matchesShape(fields[key], template[key]));
  }
  return actual === expected;
}
