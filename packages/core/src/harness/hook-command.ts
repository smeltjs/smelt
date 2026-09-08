import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { smeltOnPath } from '../hooks/invocation.ts';
import type { InvocationEnv } from '../hooks/invocation.ts';
import { asRecord } from '../hooks/shim.ts';
import type { HarnessHookSchema } from '../hooks/shim.ts';

import { nodeCommand } from './paths.ts';
import type { ShimmedHarnessProfile } from './profile.ts';
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
 * {@link probeHookCommand} is the second half, and the reason this module is not just
 * a parser. `smelt doctor` printed `wired` for any file carrying an entry of ours — a
 * text fact, never a running one. A shim reached through a symlink (defect 1, fixed in
 * `hooks/invocation.ts`) and a keg path deleted by `brew upgrade` (defect 2) both
 * leave that text exactly as it was while the guard does nothing, and empty stdout is
 * how every harness schema spells *allow*. The probe runs the command against a
 * synthetic payload built from the harness's own {@link HarnessHookSchema} and reports
 * what came back. It reads; it never repairs (ADR-0003), and it never touches the
 * project: the file it oversizes lives in a fresh temp directory that is removed again.
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
 * `smelt <verb>` spelling carries no path at all to recognise.
 */
export const HOOK_COMMAND_TAIL = ` 2>/dev/null || true # ${OURS_TOKEN}`;

/** The `smelt map` arguments the opening-map hook runs. */
export const MAP_ON_START_ARGS = 'map .';

/** The `smelt agents lint` arguments the instruction-file lint hook runs. */
export const AGENTS_LINT_ARGS = 'agents lint .';

/**
 * The exact string a harness config carries for this command — the only writer.
 *
 * Paths are portable relative to `cwd` (a path inside the project travels with the
 * repo), which is `harness/paths.ts`'s rule and not this module's.
 */
export function renderHookCommand(cmd: HookCommand, cwd: string): string {
  if (cmd.kind === 'guard') return nodeCommand(cwd, cmd.script);
  const prefix = cmd.invocation === 'path' ? 'smelt' : nodeCommand(cwd, cmd.script ?? '');
  return `${prefix} ${cmd.args}${HOOK_COMMAND_TAIL}`;
}

/** A shim script: `.../hooks/shims/<harness id>.js`, absolute or project-relative. */
const SHIM_SCRIPT = /(^|\/)hooks\/shims\/[^/]+\.js$/u;

/** This package's own binary — the only script a lifecycle command may name. */
const BIN_SCRIPT = /(^|\/)cli\/bin\.js$/u;

/** `node <script> [args]`, in the three quotings a config file is written with. */
const NODE_COMMAND = /^node\s+(?:"([^"]*)"|'([^']*)'|(\S+))\s*(.*)$/u;

/**
 * `$(readlink -f <path>)` — not a spelling smelt writes, but one users have on disk
 * today: it is the manual workaround for the symlink defect, and a reader that called
 * those entries foreign would duplicate them on the next install instead of replacing
 * them.
 */
const READLINK = /^\$\(\s*readlink\s+-f\s+(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)$/u;

/** `smelt <args>` — the bare-name spelling, for a machine with `smelt` on PATH. */
const SMELT_COMMAND = /^smelt\s+(.*)$/u;

/**
 * The command a harness config carries, as a value — or `undefined` for an entry that
 * is not ours.
 *
 * `undefined` is load-bearing: it is what tells the merge an entry belongs to somebody
 * else, so being generous here would let a re-run replace a foreign hook. A `node`
 * command must name one of *our* scripts — a shim (with no arguments) or this
 * package's binary (with arguments the verb table recognises) — and a bare `smelt`
 * command must run one of the three verbs this preset wires.
 */
export function parseHookCommand(command: string): HookCommand | undefined {
  const text = withoutTail(command);
  const node = NODE_COMMAND.exec(text);
  if (node !== null) {
    const script = unwrapReadlink(node[1] ?? node[2] ?? node[3] ?? '');
    const args = (node[4] ?? '').trim();
    if (args === '') {
      return SHIM_SCRIPT.test(script) ? { kind: 'guard', script } : undefined;
    }
    if (!BIN_SCRIPT.test(script)) return undefined;
    const kind = verbKind(args);
    return kind === undefined ? undefined : { kind, invocation: 'node', script, args };
  }
  const smelt = SMELT_COMMAND.exec(text);
  if (smelt === null) return undefined;
  const args = (smelt[1] ?? '').trim();
  const kind = verbKind(args);
  return kind === undefined ? undefined : { kind, invocation: 'path', args };
}

/**
 * The command without its ownership tail. The shell comment is stripped only when it
 * carries {@link OURS_TOKEN}, so a `#` inside somebody's quoted path is left alone.
 */
function withoutTail(command: string): string {
  let text = command.trim();
  const hash = text.lastIndexOf('#');
  if (hash !== -1 && text.slice(hash).includes(OURS_TOKEN)) text = text.slice(0, hash).trimEnd();
  if (text.endsWith('|| true')) text = text.slice(0, -'|| true'.length).trimEnd();
  if (text.endsWith('2>/dev/null')) text = text.slice(0, -'2>/dev/null'.length).trimEnd();
  return text;
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
 * A command the parser recognises is ours by construction. The token check behind it
 * catches an entry a user hand-edited past recognition but left tagged: a re-run
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
 * The size of the file the guard probe asks about — comfortably over the built-in
 * `DEFAULT_THRESHOLD_BYTES` (8 192), which is what applies in a scratch directory with
 * no `smelt.config.json` in it or above it.
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
 * spawned *there*, so the built-in threshold and deny enforcement apply, the project's
 * config is not consulted, and no elision store is ever opened.
 */
export function probeHookCommand(
  cmd: HookCommand,
  profile: ShimmedHarnessProfile,
  io: HookProbeIo,
): HookProbe {
  return cmd.kind === 'guard' ? probeGuard(cmd.script, profile, io) : probeLifecycle(cmd, io);
}

function resolveScript(script: string, cwd: string): string {
  return isAbsolute(script) ? script : join(cwd, script);
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
  const scratch = mkdtempSync(join(tmpdir(), 'smelt-hook-probe-'));
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
      return {
        status: 'inert',
        script,
        detail: `${script} did not answer within ${String(timeoutMs)}ms`,
      };
    }
    if (run.stdout === '') {
      return {
        status: 'inert',
        script,
        detail:
          `${script} allowed a ${String(HOOK_PROBE_FILE_BYTES)}-byte read — empty stdout is ` +
          `an allow, so the hook is wired but not guarding`,
      };
    }
    if (!isDenyDocument(run.stdout, schema)) {
      return {
        status: 'inert',
        script,
        detail: `${script} answered something other than ${profile.id}'s deny document`,
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
  const run = spawnSync(process.execPath, [script, '--version'], {
    encoding: 'utf8',
    cwd: io.cwd,
    timeout: io.timeoutMs ?? HOOK_PROBE_TIMEOUT_MS,
  });
  if (run.error !== undefined || run.status !== 0) {
    return { status: 'inert', script, detail: `${script} did not answer \`--version\`` };
  }
  return { status: 'fires', script, detail: `${script} answers \`--version\`` };
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
