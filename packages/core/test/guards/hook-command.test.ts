import { describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken copy
// of `src` and watch it go red. See scripts/mutate.mjs.
import {
  AGENTS_LINT_ARGS,
  MAP_ON_START_ARGS,
  parseHookCommand,
  renderHookCommand,
} from '@guard/harness/hook-command';
import type { HookCommand } from '@guard/harness/hook-command';
import { OURS_TOKEN } from '@guard/harness/snippet';

import type { GuardMutation } from './_mutations.ts';
import { allSourceFiles, readSource } from './_source.ts';

/**
 * HOOK-COMMAND GUARD — the three promises a hook command makes to everything that has
 * to read it again.
 *
 *  1. **The round trip.** `parseHookCommand(renderHookCommand(c, cwd))` is `c`, for
 *     every kind and both spellings. One writer, one reader, and a test that fails the
 *     moment they stop agreeing — which is the whole reason the command stopped being
 *     a string with three substring searches pointed at it.
 *  2. **Ownership is provable.** Every entry this installer writes carries the
 *     `smelt:hooks` token, and a command naming somebody else's script is *foreign*:
 *     `parseHookCommand` answers `undefined`, and the merge that decides what a re-run
 *     may replace answers with it. A parser that were generous here would let an
 *     upgrade quietly delete another tool's hook.
 *  3. **The spawn is `process.execPath`, and nothing else.** `node:child_process` is on
 *     the Law 1 allowlist (`src/net/policy.ts`) for exactly one use: `smelt doctor`
 *     running this node on a script an installed hook already names. That is a narrower
 *     ruling than the import, so it is asserted over the source rather than assumed —
 *     any other program name in a spawn call is a transport nobody classified.
 *
 * The mutations below prove each can go red: the ownership token dropped from the
 * rendered command, the parser confusing `map` for `lint`, and the parser accepting a
 * foreign script.
 */

const CWD = '/project';
const SHIM = '/opt/smelt/dist/hooks/shims/claude-code.js';
const BIN = '/opt/smelt/dist/cli/bin.js';

/** Every kind, in every spelling a machine can produce. */
const EVERY_COMMAND: readonly HookCommand[] = [
  { kind: 'guard', script: SHIM },
  { kind: 'stats', invocation: 'path', args: 'stats' },
  { kind: 'stats', invocation: 'node', script: BIN, args: 'stats' },
  {
    kind: 'map',
    invocation: 'path',
    args: `${MAP_ON_START_ARGS} --budget 8000 --cache .smelt/tags`,
  },
  {
    kind: 'map',
    invocation: 'node',
    script: BIN,
    args: `${MAP_ON_START_ARGS} --budget 8000 --cache .smelt/tags`,
  },
  { kind: 'lint', invocation: 'path', args: AGENTS_LINT_ARGS },
  { kind: 'lint', invocation: 'node', script: BIN, args: AGENTS_LINT_ARGS },
];

describe('a hook command survives being written to a file and read back', () => {
  it('every kind, in both spellings, round-trips exactly', () => {
    for (const command of EVERY_COMMAND) {
      const written = renderHookCommand(command, CWD);
      expect(parseHookCommand(written), `the writer and the reader must agree: ${written}`).toEqual(
        command,
      );
    }
  });

  it('every lifecycle command carries the ownership token it is recognised by', () => {
    // The guard entry is recognised by its shim path; the three verb entries carry no
    // path of ours at all, so the token is the only thing marking them as smelt's. A
    // rendered command without it is an entry a re-run orphans instead of replacing.
    for (const command of EVERY_COMMAND) {
      if (command.kind === 'guard') continue;
      expect(renderHookCommand(command, CWD), command.kind).toContain(`# ${OURS_TOKEN}`);
    }
  });
});

describe('an entry that is not ours is foreign, and stays that way', () => {
  it('a node command naming somebody else’s script does not parse', () => {
    for (const foreign of [
      'node "/opt/other/other.js"',
      'node "/opt/other/other.js" stats',
      `node "/opt/other/other.js" ${MAP_ON_START_ARGS}`,
      'node "./node_modules/.bin/something"',
    ]) {
      expect(
        parseHookCommand(foreign),
        `${foreign} belongs to somebody else — a re-run may never replace it`,
      ).toBeUndefined();
    }
  });

  it('a `smelt` command running a verb this preset does not wire does not parse', () => {
    expect(parseHookCommand('smelt retrieve deadbeef')).toBeUndefined();
    expect(parseHookCommand('smelt map')).toBeUndefined();
  });
});

describe('the one spawn Law 1 permits', () => {
  it('every spawn under src/ runs this node, never a named program', () => {
    const calls: { file: string; program: string }[] = [];
    for (const file of allSourceFiles()) {
      // Raw source, not `stripStringsAndComments`: that helper does not know a regex
      // literal from a string, and this module's parser is mostly regex literals. The
      // lookbehind is what keeps `NODE_COMMAND.exec(text)` out of the results.
      for (const match of readSource(file).matchAll(
        /(?<![.\w])(?:spawnSync|spawn|execSync|exec|execFileSync|execFile|fork)\s*\(\s*([^,)\s]+)/gu,
      )) {
        calls.push({ file, program: match[1] ?? '' });
      }
    }
    expect(calls.length, 'a vacuous assertion: no spawn call was found at all').toBeGreaterThan(0);
    for (const call of calls) {
      expect(
        call.program,
        `${call.file} spawns ${call.program} — node:child_process is allowlisted for ` +
          `\`process.execPath\` alone, and any other program is a transport nobody classified`,
      ).toBe('process.execPath');
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy of
 * `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'hook-command-ownership-token-dropped',
    file: 'harness/hook-command.ts',
    find: 'export const HOOK_COMMAND_TAIL = ` 2>/dev/null || true # ${OURS_TOKEN}`;',
    replace: 'export const HOOK_COMMAND_TAIL = ` 2>/dev/null || true`;',
    why: 'the rendered lifecycle command losing the `smelt:hooks` token it is recognised by — the three verb entries carry no path of smelt’s, so a re-run would stop recognising them, orphan every one it wrote and add a duplicate beside it',
  },
  {
    id: 'hook-command-map-parsed-as-lint',
    file: 'harness/hook-command.ts',
    find: "if (`${words[0] ?? ''} ${words[1] ?? ''}` === MAP_ON_START_ARGS) return 'map';",
    replace: "if (`${words[0] ?? ''} ${words[1] ?? ''}` === MAP_ON_START_ARGS) return 'lint';",
    why: 'the reader confusing the two SessionStart hooks — the opening map and the instruction lint share one event key, so a reader that cannot tell them apart writes a re-run’s toggles back wrong and deletes the entry the user believed they had set',
  },
  {
    id: 'hook-command-accepts-a-foreign-script',
    file: 'harness/hook-command.ts',
    find: '    if (!BIN_SCRIPT.test(script)) return undefined;',
    replace: '    if (false) return undefined;',
    why: 'the parser calling any `node <script> stats` command smelt’s own — ownership is what decides which entries a re-run may replace, so a generous parser lets an upgrade silently delete another tool’s hook',
  },
];
