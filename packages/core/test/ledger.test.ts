import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { applyPlan, markerPricing } from '../src/apply.ts';
import { readLedger, smeltBlob } from '../src/ops/verbs.ts';
import { planStructural } from '../src/plan/structural.ts';
import { createSmelter } from '../src/smelter.ts';
import { MemoryElisionStore } from '../src/store.ts';
import { DirectoryElisionStore } from '../src/store-dir.ts';
import type { ElisionStore, PlanInput, Planner, RuleLedgerEntry } from '../src/types.ts';

import { FUNCTIONS_TS } from './structural-fixtures.ts';

/**
 * The elision ledger: the rule an elision was cut by, persisted at put time, so
 * "which rule's cuts get asked for back" is derivable from an artefact. Before this,
 * retrievals were journalled per hash but the ElisionReason was never persisted, so
 * the loop was open by data absence — the one deterministic feedback signal the store
 * could carry, and no artefact carried it.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

type LedgerStore = ElisionStore & { ledger(): readonly RuleLedgerEntry[] };

const STORES: readonly (readonly [string, () => LedgerStore])[] = [
  ['MemoryElisionStore', () => new MemoryElisionStore()],
  [
    'DirectoryElisionStore',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'smelt-ledger-'));
      roots.push(root);
      return new DirectoryElisionStore(root);
    },
  ],
];

describe.each(STORES)('the ledger — %s', (_name, makeStore) => {
  it('is empty for an empty store, and empty for puts that named no rule', () => {
    const store = makeStore();
    expect(store.ledger()).toEqual([]);
    store.put('unattributed bytes');
    expect(store.ledger()).toEqual([]);
  });

  it('counts distinct hashes stored per rule, and how many of them were retrieved', () => {
    const store = makeStore();
    const a = store.put('alpha', { rule: 'sibling-collapse', explanation: 'x' });
    store.put('beta', { rule: 'sibling-collapse', explanation: 'x' });
    const c = store.put('gamma', { rule: 'head-tail', explanation: 'x' });
    // A repeat put of identical bytes under the same rule is one hash, not two.
    store.put('alpha', { rule: 'sibling-collapse', explanation: 'x' });

    expect(store.ledger()).toEqual([
      { rule: 'head-tail', stored: 1, retrieved: 0 },
      { rule: 'sibling-collapse', stored: 2, retrieved: 0 },
    ]);

    store.retrieve(a);
    store.retrieve(a);
    store.retrieve(c);
    expect(store.ledger()).toEqual([
      { rule: 'head-tail', stored: 1, retrieved: 1 },
      { rule: 'sibling-collapse', stored: 2, retrieved: 1 },
    ]);
  });

  it('is an uncounted read: reading the ledger never moves a counter', () => {
    const store = makeStore();
    store.put('alpha', { rule: 'r', explanation: 'x' });
    store.ledger();
    store.ledger();
    expect(store.stats().retrieveCalls).toBe(0);
  });
});

describe('the ledger journal is compatible with the counters that predate it', () => {
  it('a put line in retrievals.log is skipped by the counter fold — never counted as a call', () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-ledger-compat-'));
    roots.push(root);
    const store = new DirectoryElisionStore(root);
    const hash = store.put('alpha', { rule: 'sibling-collapse', explanation: 'x' });
    const journal = readFileSync(join(root, 'retrievals.log'), 'utf8');
    expect(journal).toContain(`put ${JSON.stringify(hash)} "sibling-collapse"`);
    // The counter fold matches only hit/miss/corrupt lines and skips the rest — the
    // same skip an older reader applies to a line it does not know, so a store written
    // by this version reads as the same counters under the previous one.
    expect(store.stats()).toMatchObject({ retrieveCalls: 0, misses: 0, uniqueRetrieved: 0 });
  });

  it('a torn or foreign line in the journal is skipped by the ledger fold too', () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-ledger-torn-'));
    roots.push(root);
    const store = new DirectoryElisionStore(root);
    store.put('alpha', { rule: 'r', explanation: 'x' });
    writeFileSync(join(root, 'retrievals.log'), 'put "abc', { flag: 'a' });
    expect(store.ledger()).toEqual([{ rule: 'r', stored: 1, retrieved: 0 }]);
  });
});

describe('the rule reaches the store from the one function that removes bytes', () => {
  it('applyPlan puts every elision under its rule', async () => {
    const store = new MemoryElisionStore();
    const plan = await planStructural({
      text: FUNCTIONS_TS,
      language: 'typescript',
      budgetBytes: 600,
      focus: ['handleRequest'],
      pricing: markerPricing('typescript'),
    });
    const result = applyPlan(FUNCTIONS_TS, plan, store);
    expect(result.elisions.length).toBeGreaterThan(0);
    expect(store.ledger()).toEqual([
      { rule: 'sibling-collapse', stored: result.elisions.length, retrieved: 0 },
    ]);
  });
});

describe('the ledger reaches the planner as opt-in PlanInput data', () => {
  it('createSmelter hands the store’s ledger to the planner as ruleHistory', async () => {
    const store = new MemoryElisionStore();
    store.put('earlier cut', { rule: 'head-tail', explanation: 'x' });
    const seen: PlanInput[] = [];
    const spy: Planner = {
      id: 'spy/v1',
      plan: (input) => {
        seen.push(input);
        return Promise.resolve({ planner: 'spy/v1', language: input.language, elisions: [] });
      },
    };
    const smelter = createSmelter({ store, planner: spy });
    await smelter.smelt('some text\n', { budgetBytes: 100 });
    expect(seen[0]!.ruleHistory).toEqual([{ rule: 'head-tail', stored: 1, retrieved: 0 }]);
  });

  it('omits ruleHistory for a store that cannot supply a ledger', async () => {
    const bare: ElisionStore = {
      put: (content) => new MemoryElisionStore().put(content),
      peek: () => undefined,
      retrieve: () => '',
      has: () => false,
      stats: () => new MemoryElisionStore().stats(),
    };
    const seen: PlanInput[] = [];
    const spy: Planner = {
      id: 'spy/v1',
      plan: (input) => {
        seen.push(input);
        return Promise.resolve({ planner: 'spy/v1', language: input.language, elisions: [] });
      },
    };
    await createSmelter({ store: bare, planner: spy }).smelt('x\n', { budgetBytes: 100 });
    expect(Object.keys(seen[0]!)).not.toContain('ruleHistory');
  });
});

describe('readLedger — the verb', () => {
  it('reads the per-rule counts off a store that keeps them, after a real cut', async () => {
    const store = new MemoryElisionStore();
    const text = Array.from({ length: 300 }, (_, i) => `line ${String(i)} padding`).join('\n');
    const outcome = await smeltBlob({
      text,
      source: '<text>',
      budgetBytes: 600,
      strategy: 'lexical',
      store,
    });
    const ledger = readLedger({ store });
    expect(ledger).toEqual([
      { rule: 'head-tail', stored: outcome.result.elisions.length, retrieved: 0 },
    ]);
  });

  it('is undefined for a store with no ledger — never an invented empty list', () => {
    const bare: ElisionStore = {
      put: () => 'x',
      peek: () => undefined,
      retrieve: () => '',
      has: () => false,
      stats: () => new MemoryElisionStore().stats(),
    };
    expect(readLedger({ store: bare })).toBeUndefined();
  });
});
