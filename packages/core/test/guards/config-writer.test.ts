import { describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken
// copy of `src` and watch it go red. See scripts/mutate.mjs.
import { CONFIG_VERSION, parseConfig, renderConfig } from '@guard/config';
import type { SmeltConfig } from '@guard/config';
import { renderConfigWithHooks } from '@guard/harness/plan';
import { resolveRun } from '@guard/cli/subcommands/smelt';
import { LEXICAL_PLANNER_ID } from '@guard/plan/lexical';
import { DEFAULT_STRATEGY, isStrategy, PLANNERS } from '@guard/plan/planners';
import { createSmelter } from '@guard/smelter';

import { allSourceFiles, readSource } from './_source.ts';
import type { GuardMutation } from './_mutations.ts';

/**
 * CONFIG-WRITER GUARD — one reader and one writer of `smelt.config.json`, and one
 * built-in strategy.
 *
 * Two facts about a config file used to be spread across modules that could not see
 * each other drift:
 *
 *  1. **The write.** `config.ts` owned `parseConfig`; nobody owned the serialization,
 *     so `init` and `hooks install` each hand-built a config object and stringified
 *     it — and they already disagreed about which keys to emit. A sixth key would
 *     have been written by whichever module its author was editing and silently
 *     dropped by the other: a setting the user believed was in force. The round trip
 *     below is the property that could not be expressed while there were two writers,
 *     and its totality leg reads the key set out of the **reader's own refusal**, so
 *     a key added to `parseConfig` and forgotten in `renderConfig` goes red here
 *     without anyone remembering to update this file.
 *  2. **The default strategy.** `PLANNERS` derived the names (`STRATEGIES`,
 *     `isStrategy`) but not the default, so the string `'lexical'` was hand-typed as
 *     a `??` fallback in four places across two packages. This guard pins the default
 *     to the registry and to what a caller who names no strategy actually gets, and
 *     scans `src` for anyone restating it.
 */

/** A path for the refusal messages; nothing is read from disk. */
const CONFIG_PATH = '/repo/smelt.config.json';

/**
 * A config with every optional key set. The totality assertion below compares its
 * rendered key set against the reader's own list, so this literal falling behind the
 * schema is itself the failure being watched for.
 */
const FULL: SmeltConfig = {
  smeltConfig: CONFIG_VERSION,
  defaultBudgetBytes: 4000,
  strategy: 'structural',
  store: { kind: 'directory', path: '.smelt/store' },
  hooks: { thresholdBytes: 2048, enforcement: 'rewrite' },
  agents: { budgetBytes: 2000 },
  rerank: { kind: 'voyage', model: 'rerank-2.5', apiKeyEnv: 'VOYAGE_API_KEY', topK: 8 },
};

/** Every shape a config can take, one field at a time and all of them at once. */
const CONFIGS: readonly (readonly [string, SmeltConfig])[] = [
  ['version only', { smeltConfig: CONFIG_VERSION }],
  ['budget only', { smeltConfig: CONFIG_VERSION, defaultBudgetBytes: 1 }],
  ['strategy lexical', { smeltConfig: CONFIG_VERSION, strategy: 'lexical' }],
  ['strategy structural', { smeltConfig: CONFIG_VERSION, strategy: 'structural' }],
  ['memory store', { smeltConfig: CONFIG_VERSION, store: { kind: 'memory' } }],
  [
    'directory store',
    { smeltConfig: CONFIG_VERSION, store: { kind: 'directory', path: 'elsewhere/store' } },
  ],
  ['empty hooks block', { smeltConfig: CONFIG_VERSION, hooks: {} }],
  ['hooks threshold only', { smeltConfig: CONFIG_VERSION, hooks: { thresholdBytes: 1 } }],
  ['hooks enforcement only', { smeltConfig: CONFIG_VERSION, hooks: { enforcement: 'deny' } }],
  ['empty agents block', { smeltConfig: CONFIG_VERSION, agents: {} }],
  ['agents budget only', { smeltConfig: CONFIG_VERSION, agents: { budgetBytes: 1 } }],
  [
    'rerank module',
    { smeltConfig: CONFIG_VERSION, rerank: { kind: 'module', path: './smelt.rerank.ts' } },
  ],
  ['rerank voyage, defaults left out', { smeltConfig: CONFIG_VERSION, rerank: { kind: 'voyage' } }],
  [
    'rerank voyage, every field',
    {
      smeltConfig: CONFIG_VERSION,
      rerank: { kind: 'voyage', model: 'rerank-2.5-lite', apiKeyEnv: 'MY_KEY', topK: 32 },
    },
  ],
  ['every field', FULL],
];

/**
 * The keys `parseConfig` accepts, read out of its own refusal rather than restated
 * here — the reader names them when it rejects an unknown one. That is what makes the
 * totality check total: a sixth key reaches this guard the moment the reader knows
 * about it.
 */
function readerKnownKeys(): readonly string[] {
  let message = '';
  try {
    parseConfig(JSON.stringify({ smeltConfig: CONFIG_VERSION, notAKey: 1 }), CONFIG_PATH);
  } catch (error) {
    message = (error as Error).message;
  }
  const match = /Known keys: ([^.]+)\./.exec(message);
  expect(match, `the reader's refusal must list its known keys; got: ${message}`).not.toBeNull();
  return match![1]!.split(', ');
}

describe('config.ts owns both directions: parseConfig(renderConfig(c)) === c', () => {
  it.each(CONFIGS)('round-trips %s, field for field', (_label, config) => {
    expect(parseConfig(renderConfig(config), CONFIG_PATH)).toStrictEqual(config);
  });

  it('writes every key the reader knows about — no field is write-only', () => {
    const written = Object.keys(JSON.parse(renderConfig(FULL)) as Record<string, unknown>);
    expect(written.toSorted()).toEqual([...readerKnownKeys()].toSorted());
  });

  it('writes one key order, whichever verb asked for the bytes', () => {
    // Restated by hand: the order is the file's shape, and a re-run must diff cleanly
    // against a file the other verb wrote.
    expect(Object.keys(JSON.parse(renderConfig(FULL)) as Record<string, unknown>)).toEqual([
      'smeltConfig',
      'defaultBudgetBytes',
      'strategy',
      'store',
      'hooks',
      'agents',
      'rerank',
    ]);
    // The same fields handed over in a different order still render identically:
    // the writer imposes the order, callers do not carry it.
    const shuffled: SmeltConfig = {
      rerank: { kind: 'voyage', model: 'rerank-2.5', apiKeyEnv: 'VOYAGE_API_KEY', topK: 8 },
      agents: { budgetBytes: 2000 },
      hooks: { enforcement: 'rewrite', thresholdBytes: 2048 },
      store: { kind: 'directory', path: '.smelt/store' },
      strategy: 'structural',
      defaultBudgetBytes: 4000,
      smeltConfig: CONFIG_VERSION,
    };
    expect(renderConfig(shuffled)).toBe(renderConfig(FULL));
  });

  it('renders bytes a config file can hold: one trailing newline, two-space indent', () => {
    const text = renderConfig(FULL);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toContain('\n  "defaultBudgetBytes": 4000,');
  });

  it('is the writer `hooks install` uses, so the two verbs cannot disagree', () => {
    // The hooks verb's policy — carry the existing fields, inject a directory store
    // when there is none — stays in the verb; the bytes come from here.
    expect(renderConfigWithHooks(FULL, FULL.hooks!)).toBe(renderConfig(FULL));
    const injected = parseConfig(
      renderConfigWithHooks({ smeltConfig: CONFIG_VERSION }, { enforcement: 'deny' }),
      CONFIG_PATH,
    );
    expect(injected.store).toStrictEqual({ kind: 'directory', path: '.smelt/store' });
    expect(injected.hooks).toStrictEqual({ enforcement: 'deny' });
  });
});

describe('planners.ts owns the default strategy', () => {
  it('names a strategy the registry actually carries', () => {
    expect(isStrategy(DEFAULT_STRATEGY)).toBe(true);
    expect(Object.keys(PLANNERS)).toContain(DEFAULT_STRATEGY);
  });

  it('defaults to the planner that works on any text', () => {
    // Restated by hand, like the shipped strategy names in planner-registry: the
    // built-in must be the planner with no language it refuses, because the other one
    // throws GrammarUnavailableError rather than approximate — right when a caller
    // asked for it, wrong as the answer to "no preference".
    expect(PLANNERS[DEFAULT_STRATEGY]({}).id).toBe(LEXICAL_PLANNER_ID);
  });

  it('is what a smelter given no strategy actually uses', async () => {
    const smelter = createSmelter({ defaultBudgetBytes: 200 });
    const result = await smelter.smelt('a line\n'.repeat(200), { path: 'notes.txt' });
    expect(result.planner).toBe(PLANNERS[DEFAULT_STRATEGY]({}).id);
  });

  it('is what the CLI falls back to, with `builtin` provenance', () => {
    const run = resolveRun({ mode: 'smelt', focus: [], json: false, budgetBytes: 1 }, undefined);
    expect(run.strategy).toBe(DEFAULT_STRATEGY);
    expect(run.strategySource).toBe('builtin');
  });

  it('is read, never restated: no `?? <strategy name>` anywhere in src', () => {
    // `plan/planners.ts` is the owner — it declares the default and its doc comment
    // names the fallback spelling it replaced. Everywhere else must read the constant.
    const restated = allSourceFiles()
      .filter((file) => file !== 'plan/planners.ts')
      .filter((file) => /\?\?\s*'(?:lexical|structural|auto)'/.test(readSource(file)));
    expect(
      restated,
      'a hardcoded strategy fallback is a second default that can drift from the registry',
    ).toEqual([]);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'config-writer-field-dropped',
    file: 'config.ts',
    find: '    ...(config.store === undefined ? {} : { store: renderStore(config.store) }),\n',
    replace: '',
    why: 'the one writer stops emitting a field the reader still accepts — the config comes back missing a store the user set, which is the silent "setting you believed was in force" failure a single writer exists to make impossible',
  },
  {
    id: 'config-writer-default-strategy-diverged',
    file: 'smelter.ts',
    find: 'PLANNERS[config.strategy ?? DEFAULT_STRATEGY](config)',
    replace: "PLANNERS[config.strategy ?? 'structural'](config)",
    why: 'a call site defaults to something other than DEFAULT_STRATEGY — the constant and what a caller who names no strategy actually gets have come apart, which is exactly the drift the four hand-typed copies used to allow',
  },
  {
    id: 'config-writer-rerank-block-write-only',
    file: 'config.ts',
    find: '    ...(config.rerank === undefined ? {} : { rerank: renderRerank(config.rerank) }),\n',
    replace: '',
    why: 'the writer stops emitting the one key that can send a caller\u2019s source to a third party — `smelt init` would report writing a reranker, the file would carry none, and the totality leg (which reads the key set out of the reader\u2019s own refusal) is what notices without anyone remembering to update this guard',
  },
];
