import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  decide,
  DEFAULT_GUARD_SETTINGS,
  DEFAULT_SUGGESTION_BUDGET_BYTES,
  DEFAULT_THRESHOLD_BYTES,
  parseGuardRequest,
  readGuardSettings,
  searchPattern,
  shellQuote,
  simpleCommandWords,
  smeltCliCommand,
} from '../src/hooks/guard-core.ts';
import type { GuardSettings } from '../src/hooks/guard-core.ts';
import type { InvocationFs } from '../src/hooks/invocation.ts';
import { parseConfig } from '../src/cli/config.ts';
import { renderConfigWithHooks } from '../src/cli/hooks.ts';
import { packageRoot } from './guards/_source.ts';
import { envWithoutSmelt, envWithSmeltOnPath } from './hooks-fixtures.ts';

/**
 * The guard core, unit by unit: threshold, windows, suggestion rendering, config
 * override, and — end to end against the built module — the shape its one live
 * importer uses. The guard core is a *library*, not a process: every shim calls
 * `decide` in-process, and the opencode plugin the installer writes imports the built
 * module and calls the same two functions. It ships no stdin/stdout protocol of its
 * own, so there is none to test here; the fail-open contract lives in `runShimMain`,
 * exercised against a built shim in `test/hooks-shims.test.ts`.
 */

/** A stat stub: the two fixture paths every test in this file speaks about. */
const stat = (path: string): { size: number; isFile: boolean } | undefined => {
  if (path === '/repo/big.ts') return { size: 20_000, isFile: true };
  if (path === '/repo/small.ts') return { size: 10, isFile: true };
  if (path === '/repo/exactly.ts') return { size: DEFAULT_THRESHOLD_BYTES, isFile: true };
  if (path === '/repo/a dir') return { size: 999_999, isFile: false };
  if (path === '/repo/with space.log') return { size: 999_999, isFile: true };
  return undefined;
};

const SETTINGS: GuardSettings = DEFAULT_GUARD_SETTINGS;
const REWRITE: GuardSettings = { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' };

describe('the Read guard', () => {
  it('allows at the threshold and denies just above it — the threshold is a boundary, not a vibe', () => {
    expect(
      decide({ tool: 'Read', input: { path: '/repo/exactly.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
    expect(
      decide({ tool: 'Read', input: { path: '/repo/big.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('deny');
    expect(
      decide({ tool: 'Read', input: { path: '/repo/small.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
  });

  it('always allows a windowed read — offset/limit of a huge file is an economy move', () => {
    const decision = decide(
      { tool: 'Read', input: { path: '/repo/big.ts', offsetLimited: true } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision).toEqual({ action: 'allow' });
  });

  it('fails open on anything it cannot stat: missing files, directories, unknown tools', () => {
    expect(
      decide({ tool: 'Read', input: { path: '/repo/nope.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
    expect(
      decide({ tool: 'Read', input: { path: '/repo/a dir' } }, SETTINGS, '/repo', stat).action,
    ).toBe('allow');
    expect(decide({ tool: 'Glob', input: {} }, SETTINGS, '/repo', stat).action).toBe('allow');
    expect(decide({ tool: 'Read', input: {} }, SETTINGS, '/repo', stat).action).toBe('allow');
  });

  it('resolves a relative path against the cwd before statting', () => {
    expect(
      decide({ tool: 'Read', input: { path: 'big.ts' } }, SETTINGS, '/repo', stat).action,
    ).toBe('deny');
  });

  it('renders the deny to steer: the exact command with the file path and budget, and smelt retrieve', () => {
    const decision = decide(
      { tool: 'Read', input: { path: '/repo/big.ts' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.reason).toContain('/repo/big.ts is 20000 bytes');
    expect(decision.reason).toContain(`${String(DEFAULT_THRESHOLD_BYTES)}-byte`);
    expect(decision.reason).toContain(
      `smelt /repo/big.ts --budget ${String(DEFAULT_SUGGESTION_BUDGET_BYTES)}`,
    );
    expect(decision.reason).toContain('smelt retrieve <hash>');
    expect(decision.suggestion).toBe(
      `smelt /repo/big.ts --budget ${String(DEFAULT_SUGGESTION_BUDGET_BYTES)}`,
    );
  });

  it('shell-quotes a path with spaces in the suggestion, so the command runs as printed', () => {
    const decision = decide(
      { tool: 'Read', input: { path: '/repo/with space.log' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.suggestion).toBe(`smelt '/repo/with space.log' --budget 8000`);
  });
});

describe('the Bash guard', () => {
  it('denies a simple cat of an oversized file, with the faithful replacement as suggestion', () => {
    const decision = decide(
      { tool: 'Bash', input: { command: 'cat /repo/big.ts' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe('smelt /repo/big.ts --budget 8000');
  });

  it('multi-file cat with an oversized member denies with a reason but NO suggestion — a substitute would drop the other file', () => {
    const decision = decide(
      { tool: 'Bash', input: { command: 'cat /repo/small.ts /repo/big.ts' } },
      SETTINGS,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBeUndefined();
    // The reason must say the replacement covers only the oversized file — a model
    // following it verbatim must not silently drop the others.
    expect(decision.reason).toContain('covers only /repo/big.ts');
    expect(decision.reason).toContain('separately');
  });

  it('passes anything it cannot judge whole: pipelines, redirects, substitutions, small cats', () => {
    for (const command of [
      'cat /repo/big.ts | head -5',
      'cat /repo/big.ts > /tmp/x',
      'cat $(ls)',
      'cat `ls`',
      'cat /repo/small.ts',
      'cat /repo/*.ts',
      'grep -rn pattern src && echo done',
    ]) {
      expect(
        decide({ tool: 'Bash', input: { command } }, SETTINGS, '/repo', stat),
        command,
      ).toEqual({ action: 'allow' });
    }
  });

  it('never intercepts a command that already uses smelt — including the exact replacement it just suggested', () => {
    for (const command of [
      'smelt /repo/big.ts --budget 8000',
      'grep -rn x src | smelt --budget 8000 --focus x',
      'smelt retrieve 84998967370f38bc',
    ]) {
      expect(decide({ tool: 'Bash', input: { command } }, REWRITE, '/repo', stat), command).toEqual(
        { action: 'allow' },
      );
    }
  });

  it('grep passes in deny mode — output size is unknowable pre-run, and denying would fight the agent', () => {
    expect(
      decide({ tool: 'Bash', input: { command: 'grep -rn pattern src' } }, SETTINGS, '/repo', stat),
    ).toEqual({ action: 'allow' });
  });

  it('rewrite mode wraps grep/rg through smelt — with NO --focus on the searched pattern', () => {
    // Focusing on the pattern grep just matched would protect every output line of a
    // plain grep (each one contains the pattern), so nothing could be elided exactly
    // when the output is large, and the pipeline would exit over budget. The wrap
    // must let the lexical planner cut.
    const decision = decide(
      { tool: 'Bash', input: { command: 'grep -rn handleRequest src' } },
      REWRITE,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe('grep -rn handleRequest src | smelt --budget 8000');
    expect(decision.suggestion).not.toContain('--focus');
    expect(decision.reason).not.toContain('the focus keeps every match');

    const quoted = decide(
      { tool: 'Bash', input: { command: "rg -e 'foo bar' src" } },
      REWRITE,
      '/repo',
      stat,
    );
    expect(quoted.suggestion).toBe("rg -e 'foo bar' src | smelt --budget 8000");
  });

  it('rewrite mode carries the pattern as a literal --focus when the search prints context', () => {
    // With -C the output holds non-matching lines too, so the pattern distinguishes
    // the lines the task is about — and the guard, which already parsed it, says so
    // in the command instead of leaving the model to reinvent it.
    const decision = decide(
      { tool: 'Bash', input: { command: 'grep -C 3 handleRequest src' } },
      REWRITE,
      '/repo',
      stat,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe(
      'grep -C 3 handleRequest src | smelt --budget 8000 --focus handleRequest',
    );
    expect(decision.reason).toContain('--focus handleRequest');

    const quoted = decide(
      { tool: 'Bash', input: { command: "rg -C 2 -e 'foo bar' src" } },
      REWRITE,
      '/repo',
      stat,
    );
    expect(quoted.suggestion).toBe(
      "rg -C 2 -e 'foo bar' src | smelt --budget 8000 --focus 'foo bar'",
    );
  });
});

describe('command parsing helpers', () => {
  it('simpleCommandWords honors quotes and refuses shell machinery', () => {
    expect(simpleCommandWords(`cat 'a file.ts' next`)).toEqual(['cat', 'a file.ts', 'next']);
    expect(simpleCommandWords('a | b')).toBeUndefined();
    expect(simpleCommandWords('a "un$safe"')).toBeUndefined();
    expect(simpleCommandWords("a 'unterminated")).toBeUndefined();
  });

  it('searchPattern finds the pattern through flags, -e, and --', () => {
    expect(searchPattern(['grep', '-rn', 'pat', 'src'])).toBe('pat');
    expect(searchPattern(['grep', '-e', 'pat', 'src'])).toBe('pat');
    expect(searchPattern(['rg', '--type', 'ts', 'pat'])).toBe('pat');
    expect(searchPattern(['grep', '--', '-literal'])).toBe('-literal');
    expect(searchPattern(['grep', '-r'])).toBeUndefined();
  });

  it('shellQuote leaves safe strings bare and single-quotes the rest', () => {
    expect(shellQuote('src/plan.ts')).toBe('src/plan.ts');
    expect(shellQuote('a b')).toBe(`'a b'`);
    expect(shellQuote(`it's`)).toBe(`'it'"'"'s'`);
  });
});

const stat150 = (): { size: number; isFile: boolean } => ({ size: 150, isFile: true });

describe('config: the guard reads smelt.config.json tolerantly, and agrees with the CLI parser', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smelt-guard-config-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('no config: the defaults, and they are the documented ones', () => {
    expect(readGuardSettings(dir, () => {})).toEqual({
      thresholdBytes: 8192,
      enforcement: 'deny',
      budgetBytes: 8000,
      persistentStore: false,
    });
  });

  it('a config override changes the decision — the threshold is wired to the config, not a constant', () => {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 4000, hooks: { thresholdBytes: 100, enforcement: 'rewrite' } })}\n`,
    );
    const settings = readGuardSettings(dir, () => {});
    expect(settings).toEqual({
      thresholdBytes: 100,
      enforcement: 'rewrite',
      budgetBytes: 4000,
      persistentStore: false,
    });

    const decision = decide(
      { tool: 'Read', input: { path: '/repo/x.ts' } },
      settings,
      '/repo',
      stat150,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toBe('smelt /repo/x.ts --budget 4000');
    expect(
      decide(
        { tool: 'Read', input: { path: '/repo/x.ts' } },
        DEFAULT_GUARD_SETTINGS,
        '/repo',
        stat150,
      ).action,
    ).toBe('allow');
  });

  it('fails open on a malformed config, warning instead of refusing — the CLI refuses, a session guard must not', () => {
    writeFileSync(join(dir, 'smelt.config.json'), 'not json at all');
    const warnings: string[] = [];
    expect(readGuardSettings(dir, (text) => warnings.push(text))).toEqual(DEFAULT_GUARD_SETTINGS);
    expect(warnings.join('\n')).toContain('not readable JSON');

    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, hooks: { thresholdBytes: 'huge', enforcement: 'shout' } })}\n`,
    );
    const warned: string[] = [];
    expect(readGuardSettings(dir, (text) => warned.push(text))).toEqual(DEFAULT_GUARD_SETTINGS);
    expect(warned.join('\n')).toContain('hooks.thresholdBytes');
    expect(warned.join('\n')).toContain('hooks.enforcement');
  });

  it('pins the guard reader and the strict CLI parser to the same keys and values (no drift)', () => {
    // What the installer writes, the strict parser accepts, and the guard reads —
    // one config, three readers, identical facts.
    const rendered = renderConfigWithHooks(
      { smeltConfig: 1, defaultBudgetBytes: 4000 },
      { thresholdBytes: 12_345, enforcement: 'rewrite' },
    );
    writeFileSync(join(dir, 'smelt.config.json'), rendered);

    const strict = parseConfig(rendered, join(dir, 'smelt.config.json'));
    expect(strict.hooks).toEqual({ thresholdBytes: 12_345, enforcement: 'rewrite' });
    // The installer writes a directory store (the retrieve promise needs one) …
    expect(strict.store).toEqual({ kind: 'directory', path: '.smelt/store' });

    const guard = readGuardSettings(dir, () => {});
    // … and the guard reads it back as the persistent store its reasons rely on.
    expect(guard).toEqual({
      thresholdBytes: 12_345,
      enforcement: 'rewrite',
      budgetBytes: 4000,
      persistentStore: true,
    });
  });

  it('the retrieve promise is conditioned on the store: promised with a directory store, deferred without', () => {
    // Without a persistent store, `smelt retrieve <hash>` refuses (exit 2), so the
    // deny reason may not promise it — it must say what to configure instead.
    const withoutStore = decide(
      { tool: 'Read', input: { path: '/repo/x.ts' } },
      { ...DEFAULT_GUARD_SETTINGS, thresholdBytes: 100 },
      '/repo',
      stat150,
    );
    expect(withoutStore.reason).toContain('once a persistent store is configured');
    expect(withoutStore.reason).not.toContain('byte for byte');

    const withStore = decide(
      { tool: 'Read', input: { path: '/repo/x.ts' } },
      { ...DEFAULT_GUARD_SETTINGS, thresholdBytes: 100, persistentStore: true },
      '/repo',
      stat150,
    );
    expect(withStore.reason).toContain('retrieve <hash>');
    expect(withStore.reason).toContain('byte for byte');
    expect(withStore.reason).not.toContain('once a persistent store is configured');
  });
});

describe('parseGuardRequest', () => {
  it('accepts the documented shape and refuses everything else as undefined', () => {
    expect(parseGuardRequest('{"tool":"Read","input":{"path":"/a"}}')).toEqual({
      tool: 'Read',
      input: { path: '/a' },
    });
    expect(parseGuardRequest('nope')).toBeUndefined();
    expect(parseGuardRequest('[]')).toBeUndefined();
    expect(parseGuardRequest('{"tool":1,"input":{}}')).toBeUndefined();
    expect(parseGuardRequest('{"tool":"Read"}')).toBeUndefined();
    expect(parseGuardRequest('{"tool":"Read","input":{"path":5}}')).toBeUndefined();
  });
});

describe('smeltCliCommand — the command a deny reason quotes', () => {
  /** A machine with an executable `smelt` in one PATH directory, and nothing else. */
  const withSmelt: InvocationFs = {
    existsSync: () => false,
    realpathSync: (path) => path,
    statSync: (path) => {
      if (path !== '/fake/bin/smelt') throw new Error('ENOENT');
      return { isFile: () => true, mode: 0o755 };
    },
  };
  const withoutSmelt: InvocationFs = {
    existsSync: () => false,
    realpathSync: (path) => path,
    statSync: () => {
      throw new Error('ENOENT');
    },
  };

  it('names the bare `smelt` where one is on PATH, and node the sibling bin where none is', () => {
    expect(smeltCliCommand({ env: { PATH: '/fake/bin' }, fs: withSmelt })).toBe('smelt');
    // From the source tree the sibling cli/bin.js does not exist, so the last-resort
    // bare name is what remains — the built tree is covered by the dist cases below.
    expect(smeltCliCommand({ env: { PATH: '/fake/bin' }, fs: withoutSmelt })).toBe('smelt');
  });

  it('memoises the uninjected answer, and an injected call neither reads nor writes it', () => {
    // One rendered deny reason asks three times; the answer cannot change inside a
    // hook process. What must not happen is a fixture leaking into the memo (or the
    // memo answering a fixture), which is what the second half pins.
    const first = smeltCliCommand();
    expect(smeltCliCommand()).toBe(first);
    expect(smeltCliCommand({ env: { PATH: '/fake/bin' }, fs: withSmelt })).toBe('smelt');
    expect(smeltCliCommand(), 'the injected call must not have overwritten the memo').toBe(first);
  });
});

describe('the built module (dist/hooks/guard-core.js) — the artifact the opencode plugin imports', () => {
  const script = join(packageRoot(), 'dist', 'hooks', 'guard-core.js');

  it('is built (pnpm verify builds before testing; run `pnpm build` if this fails)', () => {
    expect(existsSync(script)).toBe(true);
  });

  it('denies an oversized Read through the two functions the plugin calls, naming the replacement', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smelt-guard-e2e-'));
    try {
      const big = join(dir, 'big.log');
      writeFileSync(big, 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1));
      // Exactly what the generated opencode plugin does: import the built module by
      // file URL, read the settings, decide. Nothing else of the library is loaded.
      const run = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { pathToFileURL } from 'node:url';` +
            `const core = await import(pathToFileURL(process.argv[1]).href);` +
            `const settings = core.readGuardSettings(process.cwd(), () => {});` +
            `const request = { tool: 'Read', input: { path: process.argv[2] } };` +
            `process.stdout.write(JSON.stringify(core.decide(request, settings, process.cwd())));`,
          script,
          big,
        ],
        { encoding: 'utf8', cwd: dir, env: envWithoutSmelt() },
      );
      expect(run.status, run.stderr).toBe(0);
      const decision = JSON.parse(run.stdout) as {
        action: string;
        reason?: string;
        suggestion?: string;
      };
      expect(decision.action).toBe('deny');
      expect(decision.reason).toContain(big);
      expect(decision.reason).toContain('retrieve <hash>');
      // With no `smelt` on PATH the sibling cli/bin.js is named through node, so the
      // suggestion is runnable on a local (non-global) install — never a bare `smelt`
      // that would exit 127.
      expect(decision.suggestion).toContain('cli/bin.js');
      expect(decision.suggestion).toMatch(/^node /);
      // And never the versioned Homebrew keg, which the next upgrade deletes.
      expect(decision.suggestion).not.toContain('/Cellar/');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the bare `smelt` when one is on PATH — the global install, one word', () => {
    const dir = mkdtempSync(join(tmpdir(), 'smelt-guard-e2e-path-'));
    try {
      const big = join(dir, 'big.log');
      writeFileSync(big, 'x'.repeat(DEFAULT_THRESHOLD_BYTES + 1));
      const bin = mkdtempSync(join(tmpdir(), 'smelt-guard-bin-'));
      const run = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { pathToFileURL } from 'node:url';` +
            `const core = await import(pathToFileURL(process.argv[1]).href);` +
            `const settings = core.readGuardSettings(process.cwd(), () => {});` +
            `const request = { tool: 'Read', input: { path: process.argv[2] } };` +
            `process.stdout.write(JSON.stringify(core.decide(request, settings, process.cwd())));`,
          script,
          big,
        ],
        { encoding: 'utf8', cwd: dir, env: envWithSmeltOnPath(bin) },
      );
      expect(run.status, run.stderr).toBe(0);
      const decision = JSON.parse(run.stdout) as { suggestion?: string };
      expect(decision.suggestion).toBe(`smelt ${big} --budget 8000`);
      rmSync(bin, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the allow fast path stays library-free: no planner, no grammar, no index import', () => {
    // The property behind the latency budget (research § 5): the always-on guard
    // imports node builtins only — transitively. Walk the *built* script's static
    // imports, and every relative import's imports in turn: a sibling under
    // dist/hooks/ that itself imports nothing but builtins (focus-terms.js, the one
    // derivation of focus terms) keeps the closure builtins-only; anything reaching
    // outside dist/hooks/ (`../index.js`, a planner, a grammar) is the library.
    const run = spawnSync(
      process.execPath,
      [
        '-e',
        `const{readFileSync}=require('node:fs');const{dirname,resolve,relative}=require('node:path');` +
          `const seen=new Set();const out=[];const walk=(file)=>{if(seen.has(file))return;seen.add(file);` +
          `const s=readFileSync(file,'utf8');` +
          `for(const m of s.matchAll(/from\\s*['"]([^'"]+)['"]/g)){const spec=m[1];` +
          `if(spec.startsWith('.')){const target=resolve(dirname(file),spec);` +
          `out.push({from:relative(process.argv[2],file),spec,escapes:relative(process.argv[2],target).startsWith('..')});walk(target);}` +
          `else out.push({from:relative(process.argv[2],file),spec,escapes:false});}};` +
          `walk(process.argv[1]);console.log(JSON.stringify(out));`,
        script,
        dirname(script),
      ],
      { encoding: 'utf8' },
    );
    const edges = JSON.parse(run.stdout) as { from: string; spec: string; escapes: boolean }[];
    expect(edges.length).toBeGreaterThan(0);
    for (const edge of edges) {
      const ok = edge.spec.startsWith('node:') || (edge.spec.startsWith('./') && !edge.escapes);
      expect(ok, `${edge.from} imports "${edge.spec}"`).toBe(true);
    }
    // The transitive closure is exactly the guard core and its two zero-import
    // siblings: focus-terms.js (the one derivation of focus terms) and invocation.js
    // (the one derivation of how smelt is re-invoked). Both are builtins-only
    // themselves, which the per-edge assertion above proves for every file walked.
    const relatives = edges.filter((edge) => edge.spec.startsWith('.')).map((edge) => edge.spec);
    expect([...new Set(relatives)].toSorted()).toEqual(['./focus-terms.js', './invocation.js']);
  });
});
