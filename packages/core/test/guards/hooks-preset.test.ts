import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken
// copy of `src` and watch it go red. See scripts/mutate.mjs.
import { decide, DEFAULT_GUARD_SETTINGS, readGuardSettings } from '@guard/hooks/guard-core';
import { runHooks } from '@guard/cli/hooks';

import type { GuardMutation } from './_mutations.ts';

/**
 * HOOKS-PRESET GUARD — the two promises the harness preset makes.
 *
 *  1. **The size threshold is wired to the config, not to a constant.** A guard whose
 *     `hooks.thresholdBytes` silently does nothing is a setting the user believed was
 *     in force — the exact failure shape `smelt.config.json`'s strict parser exists
 *     to refuse, reappearing one layer down where the tolerant reader lives.
 *  2. **The installer never overwrites an existing file without an explicit per-file
 *     yes.** The same law `smelt init` lives under, re-stated here because
 *     `smelt hooks install` writes into *other tools'* config files — a clobbered
 *     `.claude/settings.json` or hand-written CLAUDE.md is somebody's day gone.
 *
 * Both violations look helpful, pass the happy path, and hurt only on the day it
 * matters. The two mutations below prove each assertion can go red.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-hooks-guard-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the guard threshold obeys smelt.config.json', () => {
  it('a configured hooks.thresholdBytes changes the decision on a real file', () => {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, hooks: { thresholdBytes: 100 } })}\n`,
    );
    const target = join(dir, 'mid.txt');
    writeFileSync(target, 'x'.repeat(150));

    const settings = readGuardSettings(dir, () => {});
    expect(settings.thresholdBytes).toBe(100);

    const request = { tool: 'Read', input: { path: target } };
    expect(
      decide(request, settings, dir).action,
      '150 bytes over a 100-byte configured threshold must deny',
    ).toBe('deny');
    expect(
      decide(request, DEFAULT_GUARD_SETTINGS, dir).action,
      'the same file under the default threshold must pass',
    ).toBe('allow');
  });
});

async function install(answers: readonly string[]): Promise<string> {
  let output = '';
  await runHooks('install', 'claude-code', {
    input: Readable.from([`${answers.join('\n')}\n`]),
    output: (text: string) => {
      output += text;
    },
    cwd: dir,
    home: dir,
    // `home` is `dir` so harness detection finds nothing real; that also makes the
    // detected scope `user` (cwd *is* home), which would add the scope question and
    // eat the first scripted answer. This guard is about consent, not scope: name it.
    scope: 'project',
  });
  return output;
}

describe('the installer never touches an existing file without a per-file yes', () => {
  const sentinel = '# hand-written project instructions — the installer must not touch this\n';

  it('asks per file, and anything but a literal yes keeps the existing bytes', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), sentinel);
    for (const refusal of ['no', '', 'y', 'ok', 'overwrite']) {
      // Enter through the six steps, confirm the plan, refuse the CLAUDE.md write.
      const output = await install(['', '', '', '', '', '', 'yes', refusal]);
      expect(output, refusal).toContain('CLAUDE.md exists');
      expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8'), refusal).toBe(sentinel);
      // The files that were new (config, settings, the MCP registration) may write;
      // clear them per round.
      rmSync(join(dir, 'smelt.config.json'), { force: true });
      rmSync(join(dir, '.claude'), { recursive: true, force: true });
      rmSync(join(dir, '.mcp.json'), { force: true });
    }
  });

  it('an explicit yes is honoured — the rule is consent, not read-only', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), sentinel);
    await install(['', '', '', '', '', '', 'yes', 'yes']);
    const written = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(written).toContain(sentinel.trim()); // appended, not replaced
    expect(written).toContain('smelt retrieve');
  });

  it('writes nothing at all before the final confirm', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), sentinel);
    const output = await install(['', '', '', '', '', '', 'no']);
    expect(output).toContain('Nothing was written');
    expect(existsSync(join(dir, 'smelt.config.json'))).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe(sentinel);
  });
});

describe('the guard hands its command knowledge to the plan', () => {
  it('a context search is wrapped with the literal --focus the guard already parsed', () => {
    // The guard is the producer expert — it parsed the pattern to decide at all — and
    // before this it printed `--focus <?>` and let the model reinvent what it knew.
    // The derivation is `focusTermsFor` in hooks/focus-terms.ts, the same one
    // `smeltBlob` applies to a `producer` hint, so the guard, the CLI and the MCP
    // server cannot disagree about which terms a command names.
    const decision = decide(
      { tool: 'Bash', input: { command: 'grep -C 3 handleRequest src' } },
      { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' },
      dir,
      () => undefined,
    );
    expect(decision.action).toBe('deny');
    expect(decision.suggestion).toContain('--focus handleRequest');
    // And the plain search stays unfocused: every line of its output carries the
    // pattern, so a focus on it would protect the whole output.
    const plain = decide(
      { tool: 'Bash', input: { command: 'grep -rn handleRequest src' } },
      { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' },
      dir,
      () => undefined,
    );
    expect(plain.suggestion).not.toContain('--focus');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'hooks-focus-terms-dropped',
    file: 'hooks/focus-terms.ts',
    find: '  if (!printsContext(search)) return [];',
    replace: '  return [];',
    why: "the one derivation of focus terms wired to nothing — the guard's rewrite wrap, the CLI's --producer and the tool's producer all silently stop focusing, and the model is back to inventing what the guard knew",
  },
  {
    id: 'hooks-threshold-wired-to-constant',
    file: 'hooks/guard-core.ts',
    find: 'if (stat.size <= settings.thresholdBytes) return ALLOW;',
    replace: 'if (stat.size <= DEFAULT_THRESHOLD_BYTES) return ALLOW;',
    why: 'the Read guard threshold wired to the built-in constant — smelt.config.json hooks.thresholdBytes would be a setting the user believed was in force while every read ignored it',
  },
  {
    id: 'hooks-install-overwrite-without-consent',
    file: 'cli/merge-policy.ts',
    find: "  return answer === 'yes';",
    replace: '  return true;',
    why: 'the per-file overwrite consent wired shut — `smelt hooks install` would clobber a hand-written CLAUDE.md or .claude/settings.json after any answer, the helpful-looking break the never-overwrite rule exists to refuse',
  },
];
