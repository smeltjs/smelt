import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { applyPlan, reconstruct } from '@guard/apply';
import { createSmelter } from '@guard/index';
import { MemoryElisionStore } from '@guard/store';
import { DirectoryElisionStore } from '@guard/store-dir';
import type { ElisionPlan } from '@guard/types';

import { BOUNDARY_TS, FUNCTIONS_TS, LONG_DOC_TS, MIXED_TSX } from '../structural-fixtures.ts';

import type { GuardMutation } from './_mutations.ts';

/**
 * REVERSIBILITY GUARD — Law 3.
 *
 * Every elision must be recoverable, exactly. Not "close enough", not "the important
 * parts" — the original bytes. This asserts the equation `reconstruct(smelt(x)) === x`
 * over inputs chosen to break the places byte arithmetic goes wrong: multi-byte
 * characters, CRLF, no trailing newline, a file that is one long line.
 *
 * Why this needs to be a guard rather than a nice unit test: reversibility is the claim
 * that makes elision safe to do at all. If it quietly breaks, nothing else looks
 * different — the output still contains plausible markers, the model still gets text,
 * and the loss only shows up as a model that is subtly wrong about a file. Mutation:
 * `pnpm mutate` breaks the output-range bookkeeping and this must go red.
 */

const CASES: readonly { readonly name: string; readonly text: string }[] = [
  {
    name: 'plain ascii log',
    text: Array.from({ length: 200 }, (_, i) => `line ${String(i)}: routine chatter here`)
      .concat(['line 200: TARGET the interesting one'])
      .concat(Array.from({ length: 200 }, (_, i) => `line ${String(i + 201)}: more chatter`))
      .join('\n'),
  },
  {
    name: 'multi-byte characters',
    text: Array.from(
      { length: 120 },
      (_, i) => `rad ${String(i)}: smältverket brann — ембер — 🔥🔥🔥 padding padding padding`,
    ).join('\n'),
  },
  {
    name: 'crlf line endings',
    text: Array.from(
      { length: 120 },
      (_, i) => `line ${String(i)} of a windows file, padded out`,
    ).join('\r\n'),
  },
  {
    name: 'no trailing newline',
    text: Array.from(
      { length: 90 },
      (_, i) => `entry ${String(i)} ..............................`,
    ).join('\n'),
  },
  {
    name: 'one enormous line',
    text: `single line ${'x'.repeat(20_000)} end`,
  },
];

describe('Law 3 — every elision is reversible', () => {
  for (const { name, text } of CASES) {
    it(`round-trips: ${name}`, async () => {
      const smelter = createSmelter();
      const result = await smelter.smelt(text, { budgetBytes: 1_500, focus: ['TARGET'] });
      expect(smelter.reconstruct(result)).toBe(text);
    });

    it(`round-trips with no focus terms: ${name}`, async () => {
      const smelter = createSmelter();
      const result = await smelter.smelt(text, { budgetBytes: 1_500 });
      expect(smelter.reconstruct(result)).toBe(text);
    });
  }

  it('stores bytes for every elision it reports', async () => {
    const smelter = createSmelter();
    const text = CASES[0]!.text;
    const result = await smelter.smelt(text, { budgetBytes: 800 });
    expect(result.elisions.length).toBeGreaterThan(0);
    for (const elision of result.elisions) {
      expect(smelter.store.has(elision.hash)).toBe(true);
      expect(smelter.store.peek(elision.hash)).toHaveLength(
        Buffer.from(text, 'utf8').subarray(elision.range.start, elision.range.end).toString('utf8')
          .length,
      );
    }
  });

  it('marker byte ranges point at the markers themselves', async () => {
    const smelter = createSmelter();
    const result = await smelter.smelt(CASES[0]!.text, { budgetBytes: 800 });
    const output = Buffer.from(result.text, 'utf8');
    for (const elision of result.elisions) {
      const atRange = output
        .subarray(elision.outputRange.start, elision.outputRange.end)
        .toString('utf8');
      expect(atRange).toBe(elision.marker);
    }
  });

  it('every marker names what was removed and how to get it back', async () => {
    const smelter = createSmelter();
    const result = await smelter.smelt(CASES[0]!.text, { budgetBytes: 800 });
    for (const elision of result.elisions) {
      expect(elision.reason.explanation).toMatch(/^collapsed \d+ lines?\b/);
      expect(elision.reason.rule).not.toBe('');
      expect(elision.marker).toContain(`retrieve("${elision.hash}")`);
      expect(elision.marker).toContain(elision.reason.explanation);
    }
  });

  it('refuses to apply a plan whose ranges overlap', () => {
    const store = new MemoryElisionStore();
    const text = 'abcdefghijklmnopqrstuvwxyz';
    const plan: ElisionPlan = {
      planner: 'test',
      language: 'unknown',
      elisions: [
        { range: { start: 2, end: 10 }, reason: { rule: 'r', explanation: 'collapsed 1 line' } },
        { range: { start: 8, end: 14 }, reason: { rule: 'r', explanation: 'collapsed 1 line' } },
      ],
    };
    expect(() => applyPlan(text, plan, store)).toThrow(/overlapping/i);
  });

  it('refuses a range outside the input', () => {
    const store = new MemoryElisionStore();
    const plan: ElisionPlan = {
      planner: 'test',
      language: 'unknown',
      elisions: [
        { range: { start: 0, end: 99 }, reason: { rule: 'r', explanation: 'collapsed 1 line' } },
      ],
    };
    expect(() => applyPlan('short', plan, store)).toThrow(/not a non-empty range/);
  });

  it('reconstruct fails loudly when the store has lost the bytes', () => {
    const store = new MemoryElisionStore();
    const text = `${'a'.repeat(300)}\n${'b'.repeat(300)}`;
    const plan: ElisionPlan = {
      planner: 'test',
      language: 'unknown',
      elisions: [
        { range: { start: 0, end: 300 }, reason: { rule: 'r', explanation: 'collapsed 1 line' } },
      ],
    };
    const result = applyPlan(text, plan, store);
    expect(() => reconstruct(result, new MemoryElisionStore())).toThrow(/no stored content/);
  });
});

/**
 * The same law, against the persistent store — including the case the in-memory store
 * cannot have: the process that elided is gone, and a *different* store instance over
 * the same directory must still put every byte back.
 */
describe('Law 3 — reversible against the persistent store, across a restart', () => {
  const roots: string[] = [];
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });
  const newRoot = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-reversibility-guard-'));
    roots.push(root);
    return root;
  };

  for (const { name, text } of CASES) {
    it(`round-trips: ${name}`, async () => {
      const smelter = createSmelter({ store: new DirectoryElisionStore(newRoot()) });
      const result = await smelter.smelt(text, { budgetBytes: 1_500, focus: ['TARGET'] });
      expect(smelter.reconstruct(result)).toBe(text);
    });

    it(`round-trips through a second store instance over the same directory: ${name}`, async () => {
      const root = newRoot();
      const smelter = createSmelter({ store: new DirectoryElisionStore(root) });
      const result = await smelter.smelt(text, { budgetBytes: 1_500, focus: ['TARGET'] });
      // The smelter and its store are gone from memory; only the directory remains.
      expect(reconstruct(result, new DirectoryElisionStore(root))).toBe(text);
    });
  }

  it('stores bytes on disk for every elision it reports', async () => {
    const root = newRoot();
    const smelter = createSmelter({ store: new DirectoryElisionStore(root) });
    const result = await smelter.smelt(CASES[0]!.text, { budgetBytes: 800 });
    expect(result.elisions.length).toBeGreaterThan(0);
    const reopened = new DirectoryElisionStore(root);
    for (const elision of result.elisions) {
      expect(reopened.has(elision.hash)).toBe(true);
    }
  });
});

/**
 * Law 3 does not care which planner made the plan, so the equation is asserted over
 * structural output too — real TypeScript and TSX with multi-byte characters, and,
 * deliberately, the lexical CASES above parsed *as* TypeScript: a parse full of ERROR
 * nodes still yields node-boundary elisions, and those must round-trip like any other.
 */
describe('Law 3 — every structural elision is reversible', () => {
  const STRUCTURAL_CASES: readonly {
    readonly name: string;
    readonly text: string;
    readonly language: 'typescript' | 'tsx';
    readonly focus?: readonly string[];
  }[] = [
    { name: 'functions.ts', text: FUNCTIONS_TS, language: 'typescript', focus: ['handleRequest'] },
    { name: 'long-doc.ts', text: LONG_DOC_TS, language: 'typescript', focus: ['retryWithBackoff'] },
    { name: 'mixed.tsx', text: MIXED_TSX, language: 'tsx', focus: ['Toolbar'] },
    {
      name: 'multi-byte boundary.ts',
      text: BOUNDARY_TS,
      language: 'typescript',
      focus: ['greetTarget'],
    },
    { name: 'functions.ts with no focus', text: FUNCTIONS_TS, language: 'typescript' },
    ...CASES.map(({ name, text }) => ({
      name: `lexical case parsed as typescript: ${name}`,
      text,
      language: 'typescript' as const,
      focus: ['TARGET'] as const,
    })),
  ];

  for (const { name, text, language, focus } of STRUCTURAL_CASES) {
    it(`round-trips: ${name}`, async () => {
      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, {
        budgetBytes: 600,
        language,
        ...(focus === undefined ? {} : { focus }),
      });
      expect(result.planner).toBe('structural/v1');
      // Without this, a planner change that elides nothing keeps every round trip
      // trivially green while the coverage claim above goes false.
      expect(result.elisions.length, 'nothing elided — this round trip is vacuous').toBeGreaterThan(
        0,
      );
      expect(smelter.reconstruct(result)).toBe(text);
    });
  }
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'law3-marker-range-off-by-one',
    file: 'apply.ts',
    find: '      outputRange: { start: outputBytes, end: outputBytes + markerBuffer.length },',
    replace:
      '      outputRange: { start: outputBytes, end: outputBytes + markerBuffer.length - 1 },',
    why: 'off-by-one marker bookkeeping — reconstruct would return almost-right text',
  },
  {
    id: 'law3-elision-not-stored',
    file: 'apply.ts',
    find: '    const hash = store.put(removedText, reason);',
    replace:
      '    const hash = removedText.length > 4096 ? store.put(removedText, reason) : "0000000000000000";',
    why: 'a size threshold that quietly makes small elisions unrecoverable',
  },
];
