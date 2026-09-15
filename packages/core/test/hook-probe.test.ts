import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HOOK_PROBE_FILE_BYTES, probeHookCommand } from '../src/harness/hook-probe.ts';
import { DEFAULT_THRESHOLD_BYTES } from '../src/hooks/guard-core.ts';
import { harnessById } from '../src/harness/registry.ts';
import type { ShimmedHarnessProfile } from '../src/harness/profile.ts';
import { hasShim } from '../src/harness/profile.ts';

import { envWithoutSmelt, envWithSmeltOnPath } from './hooks-fixtures.ts';
import { packageRoot } from './guards/_source.ts';

/**
 * `harness/hook-probe.ts` — the four probe outcomes against real spawned scripts,
 * split from the parser's tests when the module was (review IV, REP-57). The one spawn
 * Law 1 permits is pinned by `test/guards/hook-command.test.ts`; what lives here is what
 * each outcome looks like from doctor's side.
 */

function claudeCode(): ShimmedHarnessProfile {
  const profile = harnessById('claude-code');
  if (profile === undefined || !hasShim(profile)) throw new Error('claude-code ships a shim');
  return profile;
}

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

  it('the probe pins the guard settings in the directory it runs the shim in', () => {
    // `findGuardConfigFile` walks up from the process cwd to the filesystem root, and
    // the system temp directory is not above nothing — on Windows it sits under the
    // user's profile, where somebody's `hooks.thresholdBytes: 100000` would make a
    // working guard allow the probe's file and be reported `wired but inert`. So the
    // probe writes its own config into the scratch directory and the walk stops there.
    //
    // The stub hands back what it found, which is the only way to see a directory the
    // probe creates and removes itself — and asserting on the file is what makes the
    // pin a fact rather than a comment.
    mkdirSync(join(dir, 'hooks', 'shims'), { recursive: true });
    const stub = join(dir, 'hooks', 'shims', 'claude-code.js');
    const captured = join(dir, 'seen-config.json');
    writeFileSync(
      stub,
      `import { readFileSync, writeFileSync } from 'node:fs';\n` +
        `writeFileSync(${JSON.stringify(captured)}, readFileSync('smelt.config.json', 'utf8'));\n`,
    );
    probeHookCommand({ kind: 'guard', script: stub }, claudeCode(), { cwd: dir });

    const seen = JSON.parse(readFileSync(captured, 'utf8')) as {
      hooks?: { thresholdBytes?: number; enforcement?: string };
    };
    expect(seen.hooks?.thresholdBytes).toBe(DEFAULT_THRESHOLD_BYTES);
    expect(seen.hooks?.enforcement).toBe('deny');
    // And the file the probe asks about is over that threshold, or the pin proves nothing.
    expect(HOOK_PROBE_FILE_BYTES).toBeGreaterThan(DEFAULT_THRESHOLD_BYTES);
  });

  it('a shim that dies before deciding says so — not just "empty stdout"', () => {
    // Empty stdout has two causes that read identically: a shim that decided *allow*,
    // and a shim that crashed before deciding anything. The exit code and the first
    // stderr line are what tell them apart. (A genuine import-time throw lands here
    // too, with node's own first stderr line — its `<file>:<line>` header.)
    mkdirSync(join(dir, 'hooks', 'shims'), { recursive: true });
    const stub = join(dir, 'hooks', 'shims', 'claude-code.js');
    writeFileSync(stub, "process.stderr.write('boom at import\\n');\nprocess.exit(1);\n");
    const probe = probeHookCommand({ kind: 'guard', script: stub }, claudeCode(), { cwd: dir });
    expect(probe.status).toBe('inert');
    expect(probe.detail).toContain('exit 1');
    expect(probe.detail).toContain('boom at import');
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
    // A timeout and a spawn that never started are two different things to be told.
    expect(probe.detail).not.toContain('could not be run');
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
