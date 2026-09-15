import { SMELT_COMMAND_NAME } from '../hooks/invocation.ts';
import { asRecord } from '../hooks/shim.ts';
import { nodeCommand } from './paths.ts';
import type { HarnessOwnFileProbe } from './profile.ts';
import { MANAGED_EVENTS } from './registry.ts';
import { OURS_TOKEN } from './snippet.ts';

/**
 * HookCommand — the one module that owns what a smelt hook entry *says*, in both
 * directions.
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
 * The probe that *runs* a parsed command — `smelt doctor`'s `wired (verified)` — is the
 * sibling module `harness/hook-probe.ts`, split out (review IV, REP-57) so that this
 * round trip imports no process, filesystem or clock: the installed-state reader and
 * the install planner parse; only doctor probes.
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
export function commandBehind(prefix: string, text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length).trim();
  }
  return undefined;
}
