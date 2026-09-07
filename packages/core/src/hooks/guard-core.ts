import { readSync, statSync, existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';

import { focusTermsFor, searchPattern, shellQuote, simpleCommandWords } from './focus-terms.ts';

/**
 * The command parsing lives in `./focus-terms.ts` — a zero-import sibling, so the
 * guard's no-library-import rule holds — and is re-exported here because this module
 * is the published `hooks/guard-core` subpath every shim and the opencode plugin load.
 */
export {
  focusTermsFor,
  searchPattern,
  searchPatterns,
  shellQuote,
  simpleCommandWords,
} from './focus-terms.ts';

/**
 * The guard core — one zero-dependency node module, shared by every harness shim.
 *
 * Contract: a caller hands `decide` a {@link GuardRequest}
 * (`{ tool, input: { path?, command?, offsetLimited? } }`) with the settings
 * {@link readGuardSettings} read, and gets one {@link GuardDecision} back —
 * `{ action: "allow" | "deny", reason?, suggestion? }`. Each shim translates that into
 * its harness's own schema (exit 2, `permissionDecision`, `cancel:true`, …), and the
 * opencode plugin — the one harness whose hook API is JavaScript — imports this module
 * at hook time and calls the same two functions.
 *
 * Two properties are load-bearing and guarded:
 *
 *  - **Fail open, loudly.** Malformed stdin, a malformed config, an unstatable path —
 *    every degenerate input produces `{"action":"allow"}` plus a warning on stderr.
 *    A guard that can brick a session on bad input is worse than no guard; the agent
 *    loses nothing but the optimization, and the warning says so.
 *  - **No library import on any path.** This module imports node builtins only —
 *    never `../index.ts`, never a planner, never web-tree-sitter — plus its one
 *    zero-import sibling `./focus-terms.ts`, which owns the command parsing. The allow case is
 *    a stat and an exit; the research note
 *    (docs/research/2026-09-02-agent-enforcement.md § 5) budgets the always-on guard
 *    at tens of milliseconds, and loading grammar machinery here would spend that
 *    budget before deciding anything. The smelt run itself is only ever paid by the
 *    *replacement* command the model runs after a deny (or the rewritten command).
 *
 * Config: the nearest `smelt.config.json` (walking up from the cwd, same discovery
 * as the CLI) may carry a `hooks` block — `thresholdBytes` and `enforcement` — plus
 * the `defaultBudgetBytes` the suggested command quotes. This file reads that config
 * with its own tolerant reader instead of importing `cli/config.ts`: the CLI's strict
 * parser sits on the planner import graph, and a *guard* must fail open where the CLI
 * correctly refuses. `test/hooks-guard-core.test.ts` pins the two readers to the same
 * key names and defaults, so they cannot drift apart silently.
 */

/** Deny threshold when no config says otherwise: reads at or under this pass untouched. */
export const DEFAULT_THRESHOLD_BYTES = 8192;

/**
 * The `--budget` the suggested replacement command quotes when no config carries
 * `defaultBudgetBytes`. A suggestion default, not a smelt default: the CLI itself
 * still refuses to run without an explicit budget from a flag or the config.
 */
export const DEFAULT_SUGGESTION_BUDGET_BYTES = 8000;

/** The `hooks.enforcement` values `smelt.config.json` may carry. Deny is the default. */
export const ENFORCEMENT_MODES = ['deny', 'rewrite'] as const;
export type EnforcementMode = (typeof ENFORCEMENT_MODES)[number];

/** The config file this guard discovers, by the same name the CLI uses. */
export const GUARD_CONFIG_FILE_NAME = 'smelt.config.json';

/**
 * The runnable CLI name every reason and suggestion quotes. A local (non-global)
 * `npm install @smeltjs/core` puts no `smelt` on anyone's PATH — the installer wires
 * every shim as `node "<dist path>"` for exactly that reason — so a suggestion
 * saying bare `smelt` would exit 127 the moment the model (or a rewrite-mode
 * harness) ran it. When this module's sibling `cli/bin.js` exists — the shipped
 * `dist/` layout every real run executes from — the command names it through `node`
 * explicitly; the bare name is only the fallback for layouts where the sibling is
 * absent (the source tree under the test runner).
 */
export function smeltCliCommand(): string {
  try {
    const bin = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'bin.js');
    if (existsSync(bin)) return `node ${shellQuote(bin)}`;
  } catch {
    // fall through to the PATH name
  }
  return 'smelt';
}

const SMELT_CLI = smeltCliCommand();

/** What a shim hands the guard core: the harness schema already mapped away. */
export interface GuardRequest {
  /** `'Read'` for a file-read tool, `'Bash'` for a shell tool; anything else passes. */
  readonly tool: string;
  readonly input: {
    /** The file a Read-shaped tool targets. Relative paths resolve against the cwd. */
    readonly path?: string;
    /** The command a Bash-shaped tool would run, verbatim. */
    readonly command?: string;
    /**
     * True when the read is already windowed (offset/limit given). A windowed read
     * of a huge file is an economy move — it is always allowed, whatever the size.
     */
    readonly offsetLimited?: boolean;
  };
}

/** The guard's whole answer. `suggestion`, when present, is an executable command. */
export interface GuardDecision {
  readonly action: 'allow' | 'deny';
  /** Why, written to steer: names the exact replacement command and `smelt retrieve`. */
  readonly reason?: string;
  /**
   * A command that faithfully replaces the denied one — `smelt <path> --budget <n>`
   * for a raw read, the original pipeline with ` | smelt …` appended for a search.
   * Only emitted when running it preserves the intent of the original call, which is
   * exactly the condition under which a rewrite-mode shim may substitute it via
   * `updatedInput`. Absent on decisions that need the model's judgement instead.
   */
  readonly suggestion?: string;
}

/** The guard's merged settings: config values where sane, defaults where not. */
export interface GuardSettings {
  readonly thresholdBytes: number;
  readonly enforcement: EnforcementMode;
  /** Quoted in every suggested command, so the model runs a complete line. */
  readonly budgetBytes: number;
  /**
   * True when the config carries a directory store. `smelt retrieve <hash>` only
   * works across processes with a persistent store (the CLI's default is memory,
   * which dies with the process that elided), so a deny reason may only *promise*
   * retrieval when this is true — otherwise it says what to configure instead.
   */
  readonly persistentStore: boolean;
}

export const DEFAULT_GUARD_SETTINGS: GuardSettings = {
  thresholdBytes: DEFAULT_THRESHOLD_BYTES,
  enforcement: 'deny',
  budgetBytes: DEFAULT_SUGGESTION_BUDGET_BYTES,
  persistentStore: false,
};

/**
 * Read the nearest `smelt.config.json`'s guard-relevant fields, tolerantly.
 *
 * Tolerant is a deliberate divergence from the CLI: `smelt` refuses a malformed
 * config because a silently skipped setting is a setting the user believed was in
 * force — but this code runs inside somebody's *session*, before every Read, and a
 * guard that turns a config typo into a hard-down harness has failed worse than the
 * typo. So: any unreadable or ill-typed field falls back to its default, and `warn`
 * receives one line saying which file and why — visible in the harness's hook debug
 * output, never fatal.
 */
export function readGuardSettings(cwd: string, warn: (text: string) => void): GuardSettings {
  const path = findGuardConfigFile(cwd);
  if (path === undefined) return DEFAULT_GUARD_SETTINGS;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    warn(
      `smelt guard: ${path} is not readable JSON ` +
        `(${cause instanceof Error ? cause.message : String(cause)}) — ` +
        `guarding with defaults instead. \`smelt\` itself will refuse this config.`,
    );
    return DEFAULT_GUARD_SETTINGS;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    warn(`smelt guard: ${path} is not a JSON object — guarding with defaults instead.`);
    return DEFAULT_GUARD_SETTINGS;
  }
  const fields = parsed as Record<string, unknown>;
  const hooks =
    typeof fields['hooks'] === 'object' &&
    fields['hooks'] !== null &&
    !Array.isArray(fields['hooks'])
      ? (fields['hooks'] as Record<string, unknown>)
      : {};

  return {
    thresholdBytes: positiveInteger(
      hooks['thresholdBytes'],
      DEFAULT_THRESHOLD_BYTES,
      `${path}: hooks.thresholdBytes`,
      warn,
    ),
    enforcement: enforcementMode(hooks['enforcement'], `${path}: hooks.enforcement`, warn),
    budgetBytes: positiveInteger(
      fields['defaultBudgetBytes'],
      DEFAULT_SUGGESTION_BUDGET_BYTES,
      `${path}: defaultBudgetBytes`,
      warn,
    ),
    persistentStore: isDirectoryStore(fields['store']),
  };
}

/** True for a well-formed `{"kind":"directory","path":…}` store block; no warning
 * otherwise — an absent or memory store is a valid (just non-persistent) choice. */
function isDirectoryStore(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>;
  return fields['kind'] === 'directory' && typeof fields['path'] === 'string';
}

function positiveInteger(
  value: unknown,
  fallback: number,
  what: string,
  warn: (text: string) => void,
): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
  warn(
    `smelt guard: ${what} must be a positive integer, got ${JSON.stringify(value)} — ` +
      `using ${String(fallback)}.`,
  );
  return fallback;
}

function enforcementMode(
  value: unknown,
  what: string,
  warn: (text: string) => void,
): EnforcementMode {
  if (value === undefined) return 'deny';
  if (value === 'deny' || value === 'rewrite') return value;
  warn(
    `smelt guard: ${what} must be "deny" or "rewrite", got ${JSON.stringify(value)} — ` +
      `using "deny".`,
  );
  return 'deny';
}

/** The same upward walk `cli/config.ts` does, re-implemented to keep this module tiny. */
export function findGuardConfigFile(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, GUARD_CONFIG_FILE_NAME);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Parse one {@link GuardRequest} *document* — the request shape as JSON, for an
 * adapter that receives it over a pipe rather than building it in-process.
 * `undefined` means malformed, and a caller that gets it allows and warns: the same
 * fail-open rule the rest of this module lives under.
 */
export function parseGuardRequest(text: string): GuardRequest | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const fields = parsed as Record<string, unknown>;
  if (typeof fields['tool'] !== 'string') return undefined;
  const input = fields['input'];
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined;
  const inputFields = input as Record<string, unknown>;
  const path = inputFields['path'];
  const command = inputFields['command'];
  const offsetLimited = inputFields['offsetLimited'];
  if (path !== undefined && typeof path !== 'string') return undefined;
  if (command !== undefined && typeof command !== 'string') return undefined;
  if (offsetLimited !== undefined && typeof offsetLimited !== 'boolean') return undefined;
  return {
    tool: fields['tool'],
    input: {
      ...(path === undefined ? {} : { path }),
      ...(command === undefined ? {} : { command }),
      ...(offsetLimited === undefined ? {} : { offsetLimited }),
    },
  };
}

const ALLOW: GuardDecision = { action: 'allow' };

/**
 * The decision, pure given a stat function — so tests exercise every branch without
 * a filesystem, and the script wires `statSync` in.
 *
 * The shape of the rules, from the research note (§ 5, "the ~8 KB threshold,
 * validated", with both amendments):
 *
 *  - **Read**: stat the exact target; deny only above the threshold, and never when
 *    the read is already windowed (`offsetLimited`) — a windowed read of a huge file
 *    is an economy move.
 *  - **Bash**: only a *simple* command whose subject is a statable named file can be
 *    judged pre-run. `cat <file>` above the threshold is denied with the faithful
 *    replacement; `grep`/`rg` output is unknowable pre-run, so it passes in deny
 *    mode and is wrapped (` | smelt --budget … --focus <pattern>`) only under
 *    `hooks.enforcement: "rewrite"`. Pipelines, redirects, substitutions — anything
 *    this parser cannot be sure about — pass untouched. Fail open, always.
 */
export function decide(
  request: GuardRequest,
  settings: GuardSettings,
  cwd: string,
  statFile: (path: string) => { size: number; isFile: boolean } | undefined = statFileReal,
): GuardDecision {
  if (request.tool === 'Read') {
    return decideRead(request.input, settings, cwd, statFile);
  }
  if (request.tool === 'Bash') {
    return decideBash(request.input, settings, cwd, statFile);
  }
  return ALLOW;
}

function statFileReal(path: string): { size: number; isFile: boolean } | undefined {
  try {
    const stat = statSync(path);
    return { size: stat.size, isFile: stat.isFile() };
  } catch {
    return undefined;
  }
}

function decideRead(
  input: GuardRequest['input'],
  settings: GuardSettings,
  cwd: string,
  statFile: (path: string) => { size: number; isFile: boolean } | undefined,
): GuardDecision {
  if (input.path === undefined) return ALLOW;
  if (input.offsetLimited === true) return ALLOW; // already windowed — an economy move
  const path = isAbsolute(input.path) ? input.path : resolve(cwd, input.path);
  const stat = statFile(path);
  if (stat === undefined || !stat.isFile) return ALLOW; // let the tool surface its own error
  if (stat.size <= settings.thresholdBytes) return ALLOW;
  return denyOversized(path, stat.size, settings, 'Reading it raw');
}

function decideBash(
  input: GuardRequest['input'],
  settings: GuardSettings,
  cwd: string,
  statFile: (path: string) => { size: number; isFile: boolean } | undefined,
): GuardDecision {
  if (input.command === undefined) return ALLOW;
  const command = input.command.trim();
  // A command already using smelt is the model doing the right thing — including the
  // exact replacement a previous deny suggested. Never intercept it (and never wrap a
  // wrapped pipeline a second time).
  if (/(^|[\s/"'=])smelt($|[\s"'])/.test(command)) return ALLOW;

  const words = simpleCommandWords(command);
  if (words === undefined || words.length === 0) return ALLOW; // not simple — unknowable pre-run

  const program = words[0]!.split('/').at(-1)!;

  if (program === 'cat') {
    const files = words.slice(1).filter((word) => word !== '--' && !word.startsWith('-'));
    for (const file of files) {
      const path = isAbsolute(file) ? file : resolve(cwd, file);
      const stat = statFile(path);
      if (stat === undefined || !stat.isFile) continue;
      if (stat.size > settings.thresholdBytes) {
        const decision = denyOversized(path, stat.size, settings, `\`${command}\``);
        // The suggestion is only a *faithful* replacement when cat named exactly this
        // one file; `cat a b` replaced by `smelt a` would silently drop b, so the
        // multi-file case keeps the reason (the model decides), drops the suggestion
        // (nothing may auto-substitute it), and says out loud that the named
        // replacement covers only the oversized file — a model following the reason
        // verbatim must not silently drop the others.
        return files.length === 1
          ? decision
          : {
              action: 'deny',
              reason:
                `${decision.reason ?? ''} Note: \`${command}\` names ` +
                `${String(files.length)} files and the replacement above covers only ` +
                `${path} — read the other file(s) separately (cat is fine for the ones ` +
                `under the threshold).`,
            };
      }
    }
    return ALLOW;
  }

  if ((program === 'grep' || program === 'rg') && settings.enforcement === 'rewrite') {
    const pattern = searchPattern(words);
    if (pattern === undefined) return ALLOW;
    // `--focus` on the wrap only where it distinguishes lines: a plain grep's every
    // output line contains the searched pattern, so focusing on it would protect the
    // entire output — zero elisions exactly when the output is large, plus an
    // over-budget exit — and the wrap lets the lexical planner keep the head and tail
    // and collapse the middle instead. A search with context prints non-matching
    // lines too, and there the pattern the guard already parsed is exactly the focus.
    // One derivation, `focusTermsFor`, states which is which; the same function
    // resolves a `--producer` hint in the ops seam, so both doors agree with this wrap.
    const focus = focusTermsFor(command);
    const focused = focus.map((term) => ` --focus ${shellQuote(term)}`).join('');
    const wrapped = `${command} | ${SMELT_CLI} --budget ${String(settings.budgetBytes)}${focused}`;
    return {
      action: 'deny',
      reason:
        `smelt guard (rewrite mode): \`${program}\` output size is unknowable before it runs, ` +
        `so pipe it through smelt instead. Run exactly: ${wrapped} — output within the ` +
        `budget passes through untouched; past it, elided regions leave <<smelt/v1 …>> ` +
        `markers${focused === '' ? '' : `, and the${focused} keeps every match and its context verbatim`}. ` +
        `${retrieveSentence(settings)}`,
      suggestion: wrapped,
    };
  }

  return ALLOW;
}

/**
 * The one sentence about getting elided bytes back — honest about the store: the
 * retrieval promise is only made when a persistent store is configured, because a
 * memory store dies with the process and `retrieve` then refuses (`resolveStoreRun`).
 */
function retrieveSentence(settings: GuardSettings): string {
  return settings.persistentStore
    ? `\`${SMELT_CLI} retrieve <hash>\` prints any marker's bytes back, byte for byte.`
    : `\`${SMELT_CLI} retrieve <hash>\` can print a marker's bytes back once a persistent ` +
        `store is configured ({"store":{"kind":"directory","path":…}} in smelt.config.json — ` +
        `\`smelt hooks install\` writes one); without it the elided bytes die with the ` +
        `smelt process.`;
}

/** The deny everything above the threshold gets: steering text plus the exact command. */
function denyOversized(
  path: string,
  size: number,
  settings: GuardSettings,
  what: string,
): GuardDecision {
  const replacement = `${SMELT_CLI} ${shellQuote(path)} --budget ${String(settings.budgetBytes)}`;
  return {
    action: 'deny',
    reason:
      `smelt guard: ${path} is ${String(size)} bytes — over the ${String(settings.thresholdBytes)}-byte ` +
      `threshold (smelt.config.json hooks.thresholdBytes). ${what} would spend context on bytes ` +
      `the task may not need. Run instead: ${replacement} --focus <what you are looking for> ` +
      `(repeat --focus per term; focused regions survive verbatim). Elided regions leave ` +
      `<<smelt/v1 …>> markers — ${retrieveSentence(settings)} A windowed read (offset/limit) ` +
      `of just the lines you need is also fine.`,
    suggestion: replacement,
  };
}

/* ------------------------------------------------------------------------------------
 * Process plumbing, for the shims that run as one
 * ---------------------------------------------------------------------------------- */

/** True when this module is the file node was asked to run, not an import. */
export function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === moduleUrl;
  } catch {
    return false;
  }
}

/** Every byte of fd 0 to EOF, retrying EAGAIN — the same shape `cli/bin.ts` uses. */
export function readAllOfStdin(): string {
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(1 << 16);
  for (;;) {
    let bytesRead: number;
    try {
      bytesRead = readSync(0, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'EAGAIN') {
        Atomics.wait(sleeper, 0, 0, 10);
        continue;
      }
      if (code === 'EOF') break;
      throw error;
    }
    if (bytesRead === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, bytesRead)));
  }
  return Buffer.concat(chunks).toString('utf8');
}
