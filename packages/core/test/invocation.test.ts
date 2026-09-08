import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSameFile,
  packageDistDir,
  smeltInvocation,
  smeltOnPath,
  stableBinPath,
  stableGuardCorePath,
  stableScriptPath,
  stableShimPath,
} from '../src/hooks/invocation.ts';
import type { InvocationFs } from '../src/hooks/invocation.ts';

/**
 * The invocation module — "how is smelt re-invoked on this machine", answered once.
 *
 * Every filesystem fact these cases need is injected, because the two defects this
 * module exists for are only reachable on a machine with Homebrew's layout: a real
 * `/opt/homebrew/Cellar` cannot be a test fixture, and a test that skipped itself
 * where the layout is absent would be green on every machine that runs it.
 * `isSameFile` is the exception — a symlink is cheap to make for real, and the
 * realpath compare is the whole point of it.
 */

/** A fake machine: which paths exist, and what each one resolves to. */
function fakeFs(
  entries: Readonly<Record<string, string>>,
  files: Readonly<Record<string, number>> = {},
): InvocationFs {
  return {
    existsSync: (path) => path in entries,
    realpathSync: (path) => {
      const target = entries[path];
      if (target === undefined) throw new Error(`ENOENT: ${path}`);
      return target;
    },
    statSync: (path) => {
      const mode = files[path];
      if (mode === undefined) throw new Error(`ENOENT: ${path}`);
      return { isFile: () => true, mode };
    },
  };
}

const KEG = '/opt/homebrew/Cellar/smelt/0.6.0';
const SCRIPT = `${KEG}/libexec/x.js`;
const ALIAS_SCRIPT = '/opt/homebrew/opt/smelt/libexec/x.js';

describe('stableScriptPath — the spelling that survives brew upgrade', () => {
  it('rewrites a keg path to the opt alias when the alias resolves to that keg', () => {
    const fs = fakeFs({ '/opt/homebrew/opt/smelt': KEG, [KEG]: KEG });
    expect(stableScriptPath(SCRIPT, fs)).toBe(ALIAS_SCRIPT);
  });

  it('leaves the keg path alone when there is no alias', () => {
    expect(stableScriptPath(SCRIPT, fakeFs({ [KEG]: KEG }))).toBe(SCRIPT);
  });

  it('leaves the keg path alone when the alias points at another version', () => {
    // The alias has already moved on. Rewriting here would name a *different*
    // release's files — worse than the versioned path, which at least is this one.
    const fs = fakeFs({
      '/opt/homebrew/opt/smelt': '/opt/homebrew/Cellar/smelt/0.7.0',
      [KEG]: KEG,
    });
    expect(stableScriptPath(SCRIPT, fs)).toBe(SCRIPT);
  });

  it('derives the prefix from the path — /usr/local and linuxbrew work the same', () => {
    for (const prefix of ['/usr/local', '/home/linuxbrew/.linuxbrew']) {
      const keg = `${prefix}/Cellar/smelt/0.6.0`;
      const fs = fakeFs({ [`${prefix}/opt/smelt`]: keg, [keg]: keg });
      expect(stableScriptPath(`${keg}/libexec/x.js`, fs)).toBe(`${prefix}/opt/smelt/libexec/x.js`);
    }
  });

  it('leaves a path with no Cellar run untouched, alias or no alias', () => {
    const plain = '/home/me/project/node_modules/@smeltjs/core/dist/cli/bin.js';
    expect(stableScriptPath(plain, fakeFs({}))).toBe(plain);
    // A `Cellar` with nothing below the version is a keg root, not a script in one.
    expect(stableScriptPath(KEG, fakeFs({ '/opt/homebrew/opt/smelt': KEG }))).toBe(KEG);
  });
});

describe('smeltOnPath', () => {
  const EXECUTABLE = 0o755;

  it('finds the first executable `smelt` across the PATH entries', () => {
    const fs = fakeFs({}, { '/b/smelt': EXECUTABLE, '/c/smelt': EXECUTABLE });
    expect(smeltOnPath({ PATH: '/a:/b:/c' }, fs)).toBe('/b/smelt');
  });

  it('ignores a `smelt` nobody may execute', () => {
    expect(smeltOnPath({ PATH: '/a' }, fakeFs({}, { '/a/smelt': 0o644 }))).toBeUndefined();
  });

  it('is undefined with no smelt anywhere, and with no PATH at all', () => {
    expect(smeltOnPath({ PATH: '/a:/b' }, fakeFs({}))).toBeUndefined();
    expect(smeltOnPath({}, fakeFs({}, { '/a/smelt': EXECUTABLE }))).toBeUndefined();
  });
});

describe('isSameFile — identity through a real symlink', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smelt-invocation-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('a symlink and its target are the same file; a plain compare says otherwise', () => {
    const real = join(dir, 'real.js');
    const link = join(dir, 'link.js');
    writeFileSync(real, 'export {};\n');
    symlinkSync(real, link);
    expect(link === real).toBe(false); // the compare this module replaced
    expect(isSameFile(link, real)).toBe(true);
  });

  it('two different files are not the same file', () => {
    writeFileSync(join(dir, 'a.js'), 'a');
    writeFileSync(join(dir, 'b.js'), 'b');
    expect(isSameFile(join(dir, 'a.js'), join(dir, 'b.js'))).toBe(false);
  });

  it('a missing path falls back to the raw compare instead of throwing', () => {
    expect(isSameFile(join(dir, 'gone.js'), join(dir, 'gone.js'))).toBe(true);
    expect(isSameFile(join(dir, 'gone.js'), join(dir, 'also-gone.js'))).toBe(false);
  });
});

describe('smeltInvocation — the ranking, all three rungs', () => {
  const DIST = '/pkg/dist';

  it('1: `smelt` on PATH wins — a name no upgrade moves', () => {
    const invocation = smeltInvocation({
      env: { PATH: '/usr/local/bin' },
      fs: fakeFs({}, { '/usr/local/bin/smelt': 0o755 }),
      distDir: DIST,
    });
    expect(invocation).toMatchObject({
      kind: 'path',
      command: 'smelt',
      bin: '/usr/local/bin/smelt',
      stable: true,
    });
    expect(invocation.script).toBeUndefined();
  });

  it('2: no PATH name — node running the stable script path', () => {
    const invocation = smeltInvocation({ env: {}, fs: fakeFs({}), distDir: DIST });
    expect(invocation).toMatchObject({
      kind: 'node',
      command: `node "${DIST}/cli/bin.js"`,
      script: `${DIST}/cli/bin.js`,
      stable: true,
    });
  });

  it('2: a keg with a live alias is stable — the alias spelling is what is written', () => {
    const kegDist = `${KEG}/libexec/lib/node_modules/@smeltjs/core/dist`;
    const fs = fakeFs({ '/opt/homebrew/opt/smelt': KEG, [KEG]: KEG });
    const invocation = smeltInvocation({ env: {}, fs, distDir: kegDist });
    expect(invocation.stable).toBe(true);
    expect(invocation.script).toBe(
      '/opt/homebrew/opt/smelt/libexec/lib/node_modules/@smeltjs/core/dist/cli/bin.js',
    );
    expect(invocation.script).not.toContain('/Cellar/');
  });

  it('3: a keg with no alias is honest about it — stable false, why says what breaks', () => {
    const kegDist = `${KEG}/libexec/lib/node_modules/@smeltjs/core/dist`;
    const invocation = smeltInvocation({ env: {}, fs: fakeFs({}), distDir: kegDist });
    expect(invocation.kind).toBe('node');
    expect(invocation.stable).toBe(false);
    expect(invocation.script).toContain('/Cellar/');
    expect(invocation.why).toContain('upgrade deletes');
  });
});

describe('the script paths all pass through stableScriptPath', () => {
  it('shim, guard core and bin are named under the given dist directory', () => {
    expect(stableShimPath('claude-code', '/pkg/dist')).toBe('/pkg/dist/hooks/shims/claude-code.js');
    expect(stableGuardCorePath('/pkg/dist')).toBe('/pkg/dist/hooks/guard-core.js');
    expect(stableBinPath('/pkg/dist')).toBe('/pkg/dist/cli/bin.js');
  });

  it('the default dist directory is this package\u2019s own, never the source tree', () => {
    expect(packageDistDir().endsWith(`${'/'}dist`)).toBe(true);
    expect(stableBinPath()).toBe(join(packageDistDir(), 'cli', 'bin.js'));
  });
});
