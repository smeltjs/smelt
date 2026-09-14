import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import process from 'node:process';

import { DEFAULT_THRESHOLD_BYTES, GUARD_CONFIG_FILE_NAME } from '../hooks/guard-core.ts';
import { smeltOnPath } from '../hooks/invocation.ts';
import type { InvocationEnv } from '../hooks/invocation.ts';
import { asRecord } from '../hooks/shim.ts';
import type { HarnessHookSchema } from '../hooks/shim.ts';
import { commandBehind, parseHookCommand } from './hook-command.ts';
import type { HookCommand } from './hook-command.ts';
import { hasShim } from './profile.ts';
import type { HarnessOwnFileProbe, HarnessProfile, ShimmedHarnessProfile } from './profile.ts';

/**
 * The hook probe — `smelt doctor`'s second half, split from the hook-command value it
 * runs (review IV, REP-57). `harness/hook-command.ts` is a pure round trip: a string in,
 * a {@link HookCommand} out, and back, with no process, filesystem or clock in it. This
 * module is the one that spawns: it runs an installed hook entry against a synthetic
 * payload in a scratch directory, under a timeout, and reports whether it fired. The
 * two lived in one file until every caller of the parser — the installed-state reader,
 * the install planner — transitively imported `node:child_process` for a probe only
 * doctor ever runs. `test/guards/module-seams.test.ts` now pins the parser's imports
 * to the value-only set, and `test/guards/hook-command.test.ts` still pins that the one
 * spawn Law 1 permits runs this very node and nothing else.
 *
 * Why probe at all: `smelt doctor` used to print `wired` for any file carrying an entry
 * of ours — a text fact, never a running one. A shim reached through a symlink and a
 * keg path deleted by `brew upgrade` both leave that text exactly as it was while the
 * guard does nothing, and empty stdout is how every harness schema spells *allow*. The
 * probe reads; it never repairs (ADR-0003), and it never touches the project: the file
 * it oversizes lives in a fresh temp directory that is removed again. {@link
 * probeOwnFile} is the same answer for the harnesses whose wiring is a file smelt owns
 * whole; what each of those files runs is declared on the profile
 * (`HarnessOwnFileProbe`), and nothing here asks which harness it is looking at.
 */

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
