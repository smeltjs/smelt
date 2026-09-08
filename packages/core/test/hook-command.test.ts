import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  AGENTS_LINT_ARGS,
  HOOK_PROBE_FILE_BYTES,
  hookEntryCommands,
  isOursEntry,
  jsonHooksContainOurs,
  MAP_ON_START_ARGS,
  parseHookCommand,
  parseHookEntries,
  probeHookCommand,
  renderHookCommand,
} from '../src/harness/hook-command.ts';
import { harnessById } from '../src/harness/registry.ts';
import type { ShimmedHarnessProfile } from '../src/harness/profile.ts';
import { hasShim } from '../src/harness/profile.ts';

import { envWithoutSmelt, envWithSmeltOnPath } from './hooks-fixtures.ts';
import { packageRoot } from './guards/_source.ts';

/**
 * `harness/hook-command.ts` — both directions of one hook command, and the probe.
 *
 * The round trip itself is the guard (`test/guards/hook-command.test.ts`); what lives
 * here is the breadth: every spelling a config file on disk can hold, every foreign
 * command that must come back `undefined`, and the four probe outcomes against real
 * spawned scripts.
 */

const CWD = '/project';
const SHIM = '/opt/smelt/dist/hooks/shims/claude-code.js';
const BIN = '/opt/smelt/dist/cli/bin.js';

function claudeCode(): ShimmedHarnessProfile {
  const profile = harnessById('claude-code');
  if (profile === undefined || !hasShim(profile)) throw new Error('claude-code ships a shim');
  return profile;
}

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

describe('probing what a hook command actually does', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smelt-probe-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const builtShim = join(packageRoot(), 'dist', 'hooks', 'shims', 'claude-code.js');
  const builtBin = join(packageRoot(), 'dist', 'cli', 'bin.js');

  it(`the built shim fires: it denies an oversized read with claude-code's deny document`, () => {
    const probe = probeHookCommand({ kind: 'guard', script: builtShim }, claudeCode(), {
      cwd: dir,
      env: envWithoutSmelt(),
    });
    expect(probe.status, probe.detail).toBe('fires');
    expect(probe.detail).toContain(String(HOOK_PROBE_FILE_BYTES));
  });

  it('a script that is not there is missing, and says which', () => {
    const gone = join(dir, 'dist', 'hooks', 'shims', 'claude-code.js');
    const probe = probeHookCommand({ kind: 'guard', script: gone }, claudeCode(), { cwd: dir });
    expect(probe.status).toBe('missing');
    expect(probe.detail).toContain(gone);
    expect(probe.detail).toContain('does not exist');
  });

  it('a script that prints nothing is inert — empty stdout is an allow, not a pass', () => {
    mkdirSync(join(dir, 'hooks', 'shims'), { recursive: true });
    const stub = join(dir, 'hooks', 'shims', 'claude-code.js');
    writeFileSync(stub, 'process.exit(0);\n');
    const probe = probeHookCommand({ kind: 'guard', script: stub }, claudeCode(), { cwd: dir });
    expect(probe.status).toBe('inert');
    expect(probe.detail).toContain('empty stdout is an allow');
  });

  it('a script that answers something else is inert too', () => {
    mkdirSync(join(dir, 'hooks', 'shims'), { recursive: true });
    const stub = join(dir, 'hooks', 'shims', 'claude-code.js');
    writeFileSync(stub, 'process.stdout.write(JSON.stringify({ ok: true }));\n');
    const probe = probeHookCommand({ kind: 'guard', script: stub }, claudeCode(), { cwd: dir });
    expect(probe.status).toBe('inert');
    expect(probe.detail).toContain("claude-code's deny document");
  });

  it('a project-relative script is resolved against the project', () => {
    mkdirSync(join(dir, 'dist', 'hooks', 'shims'), { recursive: true });
    writeFileSync(join(dir, 'dist', 'hooks', 'shims', 'claude-code.js'), 'process.exit(0);\n');
    const probe = probeHookCommand(
      { kind: 'guard', script: 'dist/hooks/shims/claude-code.js' },
      claudeCode(),
      { cwd: dir },
    );
    expect(probe.status).toBe('inert');
    expect(probe.script).toBe(join(dir, 'dist', 'hooks', 'shims', 'claude-code.js'));
  });

  it('a script that never answers is inert, on the timeout', () => {
    mkdirSync(join(dir, 'hooks', 'shims'), { recursive: true });
    const stub = join(dir, 'hooks', 'shims', 'claude-code.js');
    writeFileSync(stub, 'setTimeout(() => {}, 60_000);\n');
    const probe = probeHookCommand({ kind: 'guard', script: stub }, claudeCode(), {
      cwd: dir,
      timeoutMs: 250,
    });
    expect(probe.status).toBe('inert');
    expect(probe.detail).toContain('did not answer within 250ms');
  });

  it('the `path` form asks PATH, and nothing else', () => {
    const bin = mkdtempSync(join(tmpdir(), 'smelt-probe-path-'));
    try {
      const found = probeHookCommand(
        { kind: 'stats', invocation: 'path', args: 'stats' },
        claudeCode(),
        {
          cwd: dir,
          env: envWithSmeltOnPath(bin),
        },
      );
      expect(found.status).toBe('fires');
      expect(found.script).toBe(join(bin, 'smelt'));

      const gone = probeHookCommand(
        { kind: 'stats', invocation: 'path', args: 'stats' },
        claudeCode(),
        {
          cwd: dir,
          env: envWithoutSmelt(),
        },
      );
      expect(gone.status).toBe('missing');
      expect(gone.detail).toBe('smelt is not on PATH');
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('the `node` form runs the binary — the built one answers `--version`', () => {
    const probe = probeHookCommand(
      { kind: 'stats', invocation: 'node', script: builtBin, args: 'stats' },
      claudeCode(),
      { cwd: dir },
    );
    expect(probe.status, probe.detail).toBe('fires');
    expect(probe.detail).toContain('--version');
  });

  it('a binary that exits non-zero is inert, and one that is gone is missing', () => {
    const broken = join(dir, 'cli', 'bin.js');
    mkdirSync(join(dir, 'cli'), { recursive: true });
    writeFileSync(broken, 'process.exit(2);\n');
    chmodSync(broken, 0o644);
    expect(
      probeHookCommand(
        { kind: 'stats', invocation: 'node', script: broken, args: 'stats' },
        claudeCode(),
        { cwd: dir },
      ).status,
    ).toBe('inert');
    expect(
      probeHookCommand(
        {
          kind: 'stats',
          invocation: 'node',
          script: join(dir, 'nowhere', 'bin.js'),
          args: 'stats',
        },
        claudeCode(),
        { cwd: dir },
      ).status,
    ).toBe('missing');
  });

  it('the probe leaves no bytes behind — the oversized file lives in a temp dir', () => {
    const before = new Set(readdirSync(dir));
    probeHookCommand({ kind: 'guard', script: builtShim }, claudeCode(), { cwd: dir });
    expect(new Set(readdirSync(dir))).toEqual(before);
  });
});
