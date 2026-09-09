import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRun } from '../src/cli/subcommands/smelt.ts';
import type { SmeltInvocation } from '../src/cli/args.ts';
import type { LoadedConfig, SmeltConfig } from '../src/config.ts';
import { CliUsageError } from '../src/errors.ts';

/**
 * Direct tests on the CLI's one merge point. Precedence used to be decided across
 * `args.ts` and `run.ts`; these tests pin it to `resolveRun` alone — flag beats
 * config, config beats built-in, and the budget-required refusal lives here and
 * nowhere else.
 */

function invocation(over: Partial<SmeltInvocation> = {}): SmeltInvocation {
  return { mode: 'smelt', focus: [], json: false, ...over };
}

function loaded(config: Omit<SmeltConfig, 'smeltConfig'>): LoadedConfig {
  return { path: '/repo/smelt.config.json', config: { smeltConfig: 1, ...config } };
}

describe('budget precedence, with provenance', () => {
  it('an explicit --budget beats the config default', () => {
    const run = resolveRun(invocation({ budgetBytes: 4000 }), loaded({ defaultBudgetBytes: 120 }));
    expect(run.budgetBytes).toBe(4000);
    expect(run.budgetSource).toBe('flag');
  });

  it('the config fills in only what the flags left unsaid', () => {
    const run = resolveRun(invocation(), loaded({ defaultBudgetBytes: 120 }));
    expect(run.budgetBytes).toBe(120);
    expect(run.budgetSource).toBe('config');
  });

  it('refuses to run with no budget from either source — the error is owned here', () => {
    for (const config of [undefined, loaded({})]) {
      expect(() => resolveRun(invocation(), config)).toThrow(CliUsageError);
      expect(() => resolveRun(invocation(), config)).toThrow(/--budget is required/);
      expect(() => resolveRun(invocation(), config)).toThrow(/defaultBudgetBytes/);
    }
  });
});

describe('strategy precedence: flag > config > built-in', () => {
  it('an explicit --strategy beats the config', () => {
    const run = resolveRun(
      invocation({ budgetBytes: 1, strategy: 'lexical' }),
      loaded({ strategy: 'structural' }),
    );
    expect(run.strategy).toBe('lexical');
    expect(run.strategySource).toBe('flag');
  });

  it('the config beats the built-in', () => {
    const run = resolveRun(invocation({ budgetBytes: 1 }), loaded({ strategy: 'structural' }));
    expect(run.strategy).toBe('structural');
    expect(run.strategySource).toBe('config');
  });

  it('the built-in is lexical, and it is named as a built-in', () => {
    const run = resolveRun(invocation({ budgetBytes: 1 }), undefined);
    expect(run.strategy).toBe('lexical');
    expect(run.strategySource).toBe('builtin');
  });
});

describe('the store decision', () => {
  it('defaults to memory when there is no config, or the config says memory', () => {
    expect(resolveRun(invocation({ budgetBytes: 1 }), undefined).store).toEqual({
      kind: 'memory',
    });
    expect(
      resolveRun(invocation({ budgetBytes: 1 }), loaded({ store: { kind: 'memory' } })).store,
    ).toEqual({ kind: 'memory' });
  });

  it('resolves a directory store path against the config file, not the cwd', () => {
    const run = resolveRun(
      invocation({ budgetBytes: 1 }),
      loaded({ store: { kind: 'directory', path: 'elision-store' } }),
    );
    expect(run.store).toEqual({ kind: 'directory', path: resolve('/repo', 'elision-store') });
  });
});

describe('pass-through fields survive the merge untouched', () => {
  it('file, focus, language and json come straight from the invocation', () => {
    const run = resolveRun(
      invocation({
        budgetBytes: 1,
        file: 'a.ts',
        focus: ['handleRequest'],
        language: 'typescript',
        json: true,
      }),
      undefined,
    );
    expect(run.file).toBe('a.ts');
    expect(run.focus).toEqual(['handleRequest']);
    expect(run.language).toBe('typescript');
    expect(run.json).toBe(true);
  });
});
