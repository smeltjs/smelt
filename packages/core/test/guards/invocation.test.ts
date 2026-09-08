import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken
// copy of `src` and watch it go red. See scripts/mutate.mjs.
import { isMainModule } from '@guard/hooks/guard-core';
import { stableScriptPath } from '@guard/hooks/invocation';
import type { InvocationFs } from '@guard/hooks/invocation';

import type { GuardMutation } from './_mutations.ts';

/**
 * INVOCATION GUARD — the two promises `hooks/invocation.ts` makes to everything smelt
 * writes into somebody else's config file.
 *
 *  1. **A shim reached through a symlink still runs.** Node realpaths the ESM main
 *     entry, so `argv[1]` and `import.meta.url` name the same file with two different
 *     spellings whenever a link is involved — a Homebrew `opt` alias, a `pnpm link`, a
 *     hand-made `dist` alias. Under a string compare `isMainModule` answered *no*,
 *     `runShimMain` never ran, and the shim exited 0 with empty stdout, which in every
 *     harness schema means **allow**. That is the worst failure this project has: not a
 *     guard that is wrong, a guard that is silently absent while the transcript looks
 *     exactly as it does when the guard is working. It passes the happy path (a direct
 *     `node dist/…` run has no symlink), and it hurts only on a real install.
 *  2. **A written command survives `brew upgrade`.** Homebrew stores each release in a
 *     versioned keg and points `<prefix>/opt/<name>` at the current one. A hook entry,
 *     a plugin import or a deny reason holding the keg spelling names a directory the
 *     next upgrade deletes — every installed hook then dies with "Cannot find module"
 *     until setup is re-run, and nobody re-runs setup they were not told to. The
 *     rewrite is what makes those commands outlive the release that wrote them.
 *
 * The mutations below prove each assertion can go red: the string compare restored,
 * and the keg rewrite dropped.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-invocation-guard-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('a script reached through a symlink is still the main module', () => {
  it('isMainModule says yes through a link, where a string compare says no', () => {
    const real = join(dir, 'real.js');
    const link = join(dir, 'link.js');
    writeFileSync(real, 'export {};\n');
    symlinkSync(real, link);

    // What node actually hands a shim: argv[1] as spelled on the command line, and
    // import.meta.url already realpathed. Two spellings, one file.
    const moduleUrl = pathToFileURL(real).href;
    expect(pathToFileURL(link).href === moduleUrl, 'the compare this replaced').toBe(false);

    const entry = process.argv[1];
    process.argv[1] = link;
    try {
      expect(
        isMainModule(moduleUrl),
        'a shim run through a symlink must run — an inert guard is an allow',
      ).toBe(true);
      // And it still says no to a file that is genuinely not the entry: the fix is
      // identity through links, never "always main".
      expect(isMainModule(pathToFileURL(join(dir, 'other.js')).href)).toBe(false);
    } finally {
      if (entry === undefined) process.argv.splice(1, 1);
      else process.argv[1] = entry;
    }
  });
});

describe('a command written into a config file survives the next upgrade', () => {
  /** A Homebrew machine, injected: the alias exists and resolves to this keg. */
  const keg = '/opt/homebrew/Cellar/smelt/0.6.0';
  const brewFs: InvocationFs = {
    existsSync: (path) => path === '/opt/homebrew/opt/smelt' || path === keg,
    realpathSync: (path) => {
      if (path === '/opt/homebrew/opt/smelt' || path === keg) return keg;
      throw new Error(`ENOENT: ${path}`);
    },
    statSync: () => {
      throw new Error('ENOENT');
    },
  };

  it('a versioned keg path is written as the opt alias, never the keg', () => {
    const script = `${keg}/libexec/lib/node_modules/@smeltjs/core/dist/hooks/shims/claude-code.js`;
    const written = stableScriptPath(script, brewFs);
    expect(written, 'the keg spelling is what `brew upgrade` deletes').not.toContain('/Cellar/');
    expect(written).toBe(
      '/opt/homebrew/opt/smelt/libexec/lib/node_modules/@smeltjs/core/dist/hooks/shims/claude-code.js',
    );
  });

  it('leaves alone what it cannot prove — no alias, or an alias on another version', () => {
    const script = `${keg}/libexec/x.js`;
    const noAlias: InvocationFs = { ...brewFs, existsSync: (path) => path === keg };
    expect(stableScriptPath(script, noAlias)).toBe(script);
    const moved: InvocationFs = {
      ...brewFs,
      realpathSync: (path) =>
        path === '/opt/homebrew/opt/smelt' ? '/opt/homebrew/Cellar/smelt/0.7.0' : keg,
    };
    expect(stableScriptPath(script, moved)).toBe(script);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'hooks-main-module-string-compare',
    file: 'hooks/invocation.ts',
    find: '  return resolvedPath(a, fs) === resolvedPath(b, fs);',
    replace: '  return a === b;',
    why: 'the raw string compare restored — node realpaths the ESM main entry, so every shim reached through a symlink (a Homebrew opt alias, a pnpm link) decides it is not the main module, never runs, and exits 0 with empty stdout: a silently inert guard that allows every oversized read while the transcript looks normal',
  },
  {
    id: 'invocation-cellar-rewrite-dropped',
    file: 'hooks/invocation.ts',
    find: '  const keg = kegPath(realPath);',
    replace: '  const keg = undefined;',
    why: 'stableScriptPath handing back its input — every command smelt writes into a harness config names the versioned Homebrew keg, so `brew upgrade` deletes the directory and every installed hook dies with "Cannot find module" until somebody re-runs setup',
  },
];
