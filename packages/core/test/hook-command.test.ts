import { describe, expect, it } from 'vitest';

import {
  AGENTS_LINT_ARGS,
  hookEntryCommands,
  isOursEntry,
  jsonHooksContainOurs,
  MAP_ON_START_ARGS,
  parseHookCommand,
  parseHookEntries,
  renderHookCommand,
} from '../src/harness/hook-command.ts';

/**
 * `harness/hook-command.ts` — both directions of one hook command, and nothing that
 * spawns: the probe's cases live in `test/hook-probe.test.ts` (review IV, REP-57).
 *
 * The round trip itself is the guard (`test/guards/hook-command.test.ts`); what lives
 * here is the breadth: every spelling a config file on disk can hold, and every foreign
 * command that must come back `undefined`.
 */

const CWD = '/project';
const SHIM = '/opt/smelt/dist/hooks/shims/claude-code.js';
const BIN = '/opt/smelt/dist/cli/bin.js';

describe('rendering a hook command', () => {
  it('the guard is node running the shim — never a `smelt` verb', () => {
    expect(renderHookCommand({ kind: 'guard', script: SHIM }, CWD)).toBe(`node "${SHIM}"`);
  });

  it('a lifecycle command on a machine with `smelt` on PATH is one word plus the tail', () => {
    expect(renderHookCommand({ kind: 'stats', invocation: 'path', args: 'stats' }, CWD)).toBe(
      'smelt stats 2>/dev/null || true # smelt:hooks',
    );
  });

  it('a lifecycle command without it names the binary through node', () => {
    expect(
      renderHookCommand(
        {
          kind: 'map',
          invocation: 'node',
          script: BIN,
          args: `${MAP_ON_START_ARGS} --budget 8000`,
        },
        CWD,
      ),
    ).toBe(`node "${BIN}" map . --budget 8000 2>/dev/null || true # smelt:hooks`);
  });

  it('a script inside the project is written project-relative, so it travels with the repo', () => {
    expect(
      renderHookCommand({ kind: 'guard', script: '/project/dist/hooks/shims/cursor.js' }, CWD),
    ).toBe('node "dist/hooks/shims/cursor.js"');
  });
});

describe('parsing a hook command back', () => {
  it('reads the three quotings a config file can hold', () => {
    for (const written of [`node "${SHIM}"`, `node '${SHIM}'`, `node ${SHIM}`]) {
      expect(parseHookCommand(written), written).toEqual({ kind: 'guard', script: SHIM });
    }
  });

  it('reads the `$(readlink -f …)` workaround users have on disk today', () => {
    // The manual fix for the symlink defect. A reader that called it foreign would
    // duplicate the entry on the next install instead of replacing it.
    expect(parseHookCommand(`node "$(readlink -f ${SHIM})"`)).toEqual({
      kind: 'guard',
      script: SHIM,
    });
    expect(parseHookCommand(`node "$(readlink -f '${SHIM}')"`)).toEqual({
      kind: 'guard',
      script: SHIM,
    });
  });

  it('tells the three verbs apart, in both spellings', () => {
    expect(parseHookCommand('smelt stats 2>/dev/null || true # smelt:hooks')).toEqual({
      kind: 'stats',
      invocation: 'path',
      args: 'stats',
    });
    expect(
      parseHookCommand(`node "${BIN}" ${MAP_ON_START_ARGS} --cache .smelt/tags # smelt:hooks`),
    ).toEqual({
      kind: 'map',
      invocation: 'node',
      script: BIN,
      args: 'map . --cache .smelt/tags',
    });
    expect(parseHookCommand(`smelt ${AGENTS_LINT_ARGS} 2>/dev/null || true # smelt:hooks`)).toEqual(
      {
        kind: 'lint',
        invocation: 'path',
        args: AGENTS_LINT_ARGS,
      },
    );
  });

  it('reads a Windows path, and hands the spelling back unchanged', () => {
    // `harness/paths.ts` hands an absolute path back untouched, so a hook command on
    // Windows carries backslashes. A reader anchored on `/` alone called these foreign,
    // which turned a re-run's map/lint toggles off and deleted the entry the user set.
    const shim = String.raw`C:\smelt\dist\hooks\shims\claude-code.js`;
    const bin = String.raw`C:\smelt\dist\cli\bin.js`;
    expect(parseHookCommand(`node "${shim}"`)).toEqual({ kind: 'guard', script: shim });
    expect(
      parseHookCommand(`node "${bin}" ${MAP_ON_START_ARGS} --budget 8000 # smelt:hooks`),
    ).toEqual({
      kind: 'map',
      invocation: 'node',
      script: bin,
      args: 'map . --budget 8000',
    });
    // And ownership still decides: another tool's script under the same separators.
    expect(parseHookCommand(String.raw`node "C:\other\other.js" stats`)).toBeUndefined();
  });

  it('a `#` inside a path is not mistaken for the ownership comment', () => {
    const odd = '/opt/my#dir/dist/hooks/shims/grok.js';
    expect(parseHookCommand(`node "${odd}"`)).toEqual({ kind: 'guard', script: odd });
  });

  it('everything else is foreign — undefined, so a re-run never touches it', () => {
    for (const foreign of [
      'node "/opt/other/other.js"',
      'node "/opt/other/other.js" stats',
      'node "/opt/smelt/dist/cli/bin.js"',
      'smelt',
      'smelt retrieve abc123',
      'python /opt/smelt/dist/hooks/shims/claude-code.js',
      'echo hello',
      '',
      // A lifecycle command that never carried the ownership token: `cli/bin.js` is a
      // path another npm CLI's built binary could share, and `smelt stats` carries no
      // path at all, so without the token there is nothing here that is smelt's.
      'node "/opt/foreign-cli/dist/cli/bin.js" stats',
      'smelt stats',
      'smelt stats 2>/dev/null || true',
    ]) {
      expect(parseHookCommand(foreign), foreign).toBeUndefined();
    }
  });
});

describe(`recognising our entries inside somebody else's settings file`, () => {
  const ours = { matcher: 'Read', hooks: [{ type: 'command', command: `node "${SHIM}"` }] };
  const bare = { command: `node "${SHIM}"` };
  const foreign = { matcher: 'Read', hooks: [{ type: 'command', command: 'node ./mine.js' }] };

  it('an entry is ours when its command parses, in either entry shape', () => {
    expect(hookEntryCommands(ours)).toEqual([`node "${SHIM}"`]);
    expect(isOursEntry(ours)).toBe(true);
    expect(isOursEntry(bare)).toBe(true);
    expect(isOursEntry(foreign)).toBe(false);
  });

  it('a hand-edited entry that kept the token is still ours — orphaning it would be worse', () => {
    expect(isOursEntry({ command: 'node ./mangled.js # smelt:hooks' })).toBe(true);
  });

  it('the file-level predicate reads entries, not text', () => {
    const wired = JSON.stringify({ hooks: { PreToolUse: [ours] } });
    expect(jsonHooksContainOurs(wired)).toBe(true);
    expect(jsonHooksContainOurs(JSON.stringify({ hooks: { PreToolUse: [foreign] } }))).toBe(false);
    expect(jsonHooksContainOurs('not json at all')).toBe(false);
    expect(jsonHooksContainOurs(JSON.stringify({ hooks: 7 }))).toBe(false);
  });

  it('parseHookEntries returns our commands with the event each fires under', () => {
    const text = JSON.stringify({
      hooks: {
        PreToolUse: [ours, foreign],
        Stop: [{ hooks: [{ type: 'command', command: 'smelt stats # smelt:hooks' }] }],
        SomebodyElse: [ours],
      },
    });
    expect(parseHookEntries(text)).toEqual([
      { event: 'PreToolUse', command: { kind: 'guard', script: SHIM } },
      { event: 'Stop', command: { kind: 'stats', invocation: 'path', args: 'stats' } },
    ]);
  });
});
