import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GrammarUnavailableError, UnknownHashError } from '../src/errors.ts';
import {
  budgetFault,
  budgetMalformed,
  budgetRequired,
  DEFAULT_STRATEGY,
  openStore,
  readBlob,
  readTree,
  resolveStrategy,
} from '../src/ops/inputs.ts';
import { mapTree, readCounters, retrieveBytes, retrieveMany, smeltBlob } from '../src/ops/verbs.ts';

/**
 * The operations seam, tested where it lives.
 *
 * Most of this file arrived from `packages/mcp/test/tools.test.ts`, which is the
 * point of the seam: the MCP suite was driving a real SDK client over a transport
 * pair in order to assert that a missing budget is refused, that an unknown strategy
 * name is not invented, that a structural refusal is not silently downgraded, that a
 * file is not a directory, that an unknown hash is not an empty string, and that
 * reading counters does not move them. None of those are protocol facts. They are
 * facts about what smelt *does*, they were being asserted in the package furthest
 * from where they are decided, and the CLI was asserting the same facts again in its
 * own suite because the two front doors each held their own copy of the law.
 *
 * So the laws are tested here, once, against the ops seam both doors call. What the
 * MCP suite keeps is what only it can see: the schema shape, the `isError` envelope,
 * and stdout purity over a real pipe.
 *
 * The refusal *sentences* are pinned verbatim rather than matched loosely. They are
 * what a human or a model reads at the moment they are stuck, both front doors serve
 * them, and a wording change that reaches a user by accident is exactly what a guard
 * is for.
 */

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smelt-ops-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A blob with an obvious focus target and plenty of collapsible padding. */
function fixtureText(lines = 300): string {
  const padding = Array.from({ length: lines }, (_, i) => `padding line ${String(i)}`);
  padding.splice(150, 0, 'the handleRequest line the task is about');
  return `${padding.join('\n')}\n`;
}

describe('the budget law', () => {
  it('refuses a missing budget in either surface’s vocabulary, with one reasoning', () => {
    // The CLI's sentence, byte for byte — the one `smelt --budget` omits.
    expect(
      budgetRequired({
        knob: '--budget',
        stake: 'your context to throw away',
        advice: 'Pass --budget, or set defaultBudgetBytes in smelt.config.json.',
      }),
    ).toBe(
      '--budget is required, in UTF-8 bytes. There is no default, because a budget ' +
        'smelt invented would silently decide how much of your context to throw away. ' +
        'Pass --budget, or set defaultBudgetBytes in smelt.config.json.',
    );

    // The tool's sentence: the same law, spelled as a JSON argument, and with no
    // advice because the schema already says `required`.
    expect(budgetRequired({ knob: '"budgetBytes"', stake: 'your context to throw away' })).toBe(
      '"budgetBytes" is required, in UTF-8 bytes. There is no default, because a budget ' +
        'smelt invented would silently decide how much of your context to throw away.',
    );

    // The map's stake differs, because what an invented budget would cost differs.
    expect(budgetRequired({ knob: '--budget', stake: 'the map to leave out' })).toContain(
      'how much of the map to leave out.',
    );
  });

  it('is a whole number of bytes greater than zero — never invented, never rounded', () => {
    expect(budgetFault(4_000)).toBeUndefined();
    expect(budgetFault(1)).toBeUndefined();
    expect(budgetFault(1.5)).toBe('not-an-integer');
    expect(budgetFault(0)).toBe('not-positive');
    expect(budgetFault(-1)).toBe('not-positive');
  });

  it('echoes a rejected value back in the shape its author wrote it', () => {
    // A tool argument: numbers bare, strings quoted — JSON in, JSON out.
    expect(budgetMalformed('not-an-integer', '"budgetBytes"', '4kb')).toBe(
      '"budgetBytes" must be a whole number of bytes, got "4kb".',
    );
    expect(budgetMalformed('not-positive', '"budgetBytes"', 0)).toBe(
      '"budgetBytes" must be greater than zero, got 0.',
    );
    // An argv word is a string, so it comes back quoted, as the CLI always printed it.
    expect(budgetMalformed('not-an-integer', '--budget', '4kb')).toBe(
      '--budget must be a whole number of bytes, got "4kb".',
    );
    expect(budgetMalformed('not-positive', '--budget', '0')).toBe(
      '--budget must be greater than zero, got "0".',
    );
  });
});

describe('the strategy law', () => {
  it('lets an explicit choice win, a config fill in, and lexical fill last', () => {
    expect(resolveStrategy('structural', 'lexical')).toEqual({
      strategy: 'structural',
      source: 'flag',
    });
    expect(resolveStrategy(undefined, 'structural')).toEqual({
      strategy: 'structural',
      source: 'config',
    });
    expect(resolveStrategy(undefined, undefined)).toEqual({
      strategy: DEFAULT_STRATEGY,
      source: 'builtin',
    });
  });

  it('names the built-in once, so promoting a planner is one edit', () => {
    expect(DEFAULT_STRATEGY).toBe('lexical');
  });
});

describe('the source laws', () => {
  it('reads a path, or refuses naming the path as its author wrote it', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'build.log'), 'hello\n');

    const read = readBlob(join(dir, 'build.log'), 'build.log');
    expect(read.ok && read.value).toBe('hello\n');

    // The refusal names `build.lgo`, not the absolute path it actually opened, and it
    // carries the cause verbatim — EACCES and ENOENT call for different responses.
    const missing = readBlob(join(dir, 'build.lgo'), 'build.lgo');
    expect(missing.ok).toBe(false);
    expect(missing.ok ? '' : missing.refusal).toMatch(/^cannot read "build\.lgo": ENOENT/);
  });

  it('refuses a missing tree, and refuses a file by naming the verb that wants one', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'a-file.txt'), 'not a directory\n');
    const naming = { tree: 'repo_map', file: 'smelt_file' };

    const ok = readTree(dir, '.', naming);
    expect(ok.ok && ok.value).toBe(dir);

    const missing = readTree(join(dir, 'nowhere'), 'nowhere', naming);
    expect(missing.ok).toBe(false);
    expect(missing.ok ? '' : missing.refusal).toMatch(/^cannot read directory "nowhere": ENOENT/);

    const file = readTree(join(dir, 'a-file.txt'), 'a-file.txt', naming);
    expect(file.ok).toBe(false);
    expect(file.ok ? '' : file.refusal).toBe(
      '"a-file.txt" is not a directory. repo_map reads a whole tree; for one file, ' +
        'use smelt_file.',
    );

    // The same law under the CLI's naming — one sentence, two vocabularies.
    const cli = readTree(join(dir, 'a-file.txt'), 'a-file.txt', {
      tree: 'map',
      file: '`smelt <file>`',
    });
    expect(cli.ok ? '' : cli.refusal).toBe(
      '"a-file.txt" is not a directory. map reads a whole tree; for one file, use ' +
        '`smelt <file>`.',
    );
  });
});

describe('the store law', () => {
  it('opens the decision it was handed, and opens a fresh memory store each time', () => {
    const dir = tempDir();
    const directory = openStore({ kind: 'directory', path: join(dir, 'store') });
    const hash = directory.put('some elided bytes');
    expect(openStore({ kind: 'directory', path: join(dir, 'store') }).peek(hash)).toBe(
      'some elided bytes',
    );

    // A memory store is per-call by construction: two opens never share bytes, which
    // is exactly why `smelt retrieve` refuses one and a resident server does not.
    const memory = openStore({ kind: 'memory' });
    expect(memory.peek(memory.put('x'))).toBe('x');
    expect(openStore({ kind: 'memory' }).peek(hash)).toBeUndefined();
  });
});

describe('smeltBlob', () => {
  it('cuts to the budget, keeps the focus, and returns what a report needs', async () => {
    const input = fixtureText();
    const outcome = await smeltBlob({
      text: input,
      source: '<text>',
      budgetBytes: 600,
      strategy: 'lexical',
      focus: ['handleRequest'],
    });

    expect(outcome.result.text).toContain('the handleRequest line the task is about');
    expect(outcome.result.text).toContain('<<smelt/v1:');
    expect(outcome.result.text.length).toBeLessThan(input.length);
    // The report's inputs come back off the op, so no front door counts a byte twice.
    expect(outcome.inputText).toBe(input);
    expect(outcome.budgetBytes).toBe(600);
    expect(outcome.source).toBe('<text>');
    expect(outcome.result.elisions.length).toBeGreaterThan(0);
  });

  it('passes a structural refusal through — never a silent lexical fallback', async () => {
    // Pathless text detects as `unknown`, which structural refuses rather than
    // approximating: output labelled structural/v1 that is really line windows is
    // undetectable from outside.
    await expect(
      smeltBlob({
        text: fixtureText(),
        source: '<text>',
        budgetBytes: 600,
        strategy: 'structural',
      }),
    ).rejects.toThrow(GrammarUnavailableError);
  });

  it('hands back the store it used, so an envelope can peek at the bytes', async () => {
    const outcome = await smeltBlob({
      text: fixtureText(),
      source: '<text>',
      budgetBytes: 600,
      strategy: 'lexical',
      focus: ['handleRequest'],
    });
    for (const elision of outcome.result.elisions) {
      expect(outcome.store.peek(elision.hash)).toBeTypeOf('string');
    }
  });

  it('treats an empty focus list and no focus list as the same thing', async () => {
    const common = { text: fixtureText(), source: '<text>', budgetBytes: 600 } as const;
    const empty = await smeltBlob({ ...common, strategy: 'lexical', focus: [] });
    const absent = await smeltBlob({ ...common, strategy: 'lexical' });
    expect(empty.result.text).toBe(absent.result.text);
  });

  it('does not truncate a large input silently', async () => {
    const big = fixtureText(120_000); // ~2 MB
    const outcome = await smeltBlob({
      text: big,
      source: '<text>',
      budgetBytes: 2_000,
      strategy: 'lexical',
      focus: ['handleRequest'],
    });
    expect(outcome.result.text).toContain('the handleRequest line the task is about');
    expect(outcome.result.text).toContain('<<smelt/v1:');
    expect(outcome.result.text.length).toBeLessThan(big.length / 100);
    expect(outcome.result.inputBytes).toBe(Buffer.byteLength(big, 'utf8'));
  });
});

describe('mapTree', () => {
  it('renders a ranked map inside the budget', async () => {
    const cwd = tempDir();
    const src = join(cwd, 'src');
    mkdirSync(src);
    writeFileSync(
      join(src, 'greet.ts'),
      'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    );
    writeFileSync(
      join(src, 'main.ts'),
      "import { greet } from './greet.ts';\n\nexport function main(): void {\n" +
        "  greet('smelt');\n  greet('again');\n}\n",
    );

    const map = await mapTree({ root: src, budgetBytes: 2_000 });
    expect(map.text).toContain('greet');
    expect(Buffer.byteLength(map.text, 'utf8')).toBeLessThanOrEqual(2_000);
  });
});

function contextGrep(): string {
  // What `grep -C 2 handleRequest src` prints: matches with two lines of context,
  // so most lines do NOT contain the term — exactly where a focus window can cut.
  const lines: string[] = [];
  for (let file = 0; file < 12; file += 1) {
    for (let i = 0; i < 20; i += 1) lines.push(`src/f${String(file)}.ts-${String(i)}-padding`);
    lines.push(`src/f${String(file)}.ts:21:  return handleRequest(path);`);
    for (let i = 22; i < 40; i += 1) lines.push(`src/f${String(file)}.ts-${String(i)}-padding`);
  }
  return `${lines.join('\n')}\n`;
}

describe('smeltBlob — the producer hint', () => {
  it('derives the focus from the producer when the caller gave none', async () => {
    const outcome = await smeltBlob({
      text: contextGrep(),
      source: '<stdin>',
      budgetBytes: 1500,
      strategy: 'lexical',
      producer: 'grep -C 2 handleRequest src',
    });
    expect(outcome.focus).toEqual({ terms: ['handleRequest'], source: 'producer' });
    expect(outcome.result.elisions.length).toBeGreaterThan(0);
    expect(outcome.result.elisions.every((e) => e.reason.rule === 'focus-window')).toBe(true);
    expect(outcome.result.text).toContain('handleRequest(path)');
  });

  it('lets an explicit focus win over the producer, and says whose it was', async () => {
    const outcome = await smeltBlob({
      text: contextGrep(),
      source: '<stdin>',
      budgetBytes: 1500,
      strategy: 'lexical',
      focus: ['f3.ts'],
      producer: 'grep -C 2 handleRequest src',
    });
    expect(outcome.focus).toEqual({ terms: ['f3.ts'], source: 'caller' });
  });

  it('reports no focus when neither the caller nor the producer names a term', async () => {
    const outcome = await smeltBlob({
      text: contextGrep(),
      source: '<stdin>',
      budgetBytes: 1500,
      strategy: 'lexical',
      producer: 'cat grep-output.txt',
    });
    expect(outcome.focus).toEqual({ terms: [], source: 'none' });
    expect(outcome.result.elisions.every((e) => e.reason.rule === 'head-tail')).toBe(true);
  });
});

describe('retrieveBytes and readCounters', () => {
  it('gives the exact bytes back, and counts the asking', async () => {
    const store = openStore({ kind: 'memory' });
    const input = fixtureText();
    const outcome = await smeltBlob({
      text: input,
      source: '<text>',
      budgetBytes: 600,
      strategy: 'lexical',
      store,
      focus: ['handleRequest'],
    });

    const hash = outcome.result.elisions[0]?.hash;
    expect(hash, 'the fixture should have produced at least one elision').toBeDefined();

    const bytes = retrieveBytes({ store, hash: hash! });
    expect(bytes.length).toBeGreaterThan(0);
    expect(input).toContain(bytes);

    const stats = readCounters({ store });
    expect(stats.retrieveCalls).toBe(1);
    expect(stats.uniqueRetrieved).toBe(1);
  });

  it('answers an unknown hash with a refusal, never an empty string', () => {
    const store = openStore({ kind: 'memory' });
    expect(() => retrieveBytes({ store, hash: 'deadbeefdeadbeef' })).toThrow(UnknownHashError);
    expect(() => retrieveBytes({ store, hash: 'deadbeefdeadbeef' })).toThrow(
      /no stored content for hash "deadbeefdeadbeef"/,
    );
  });

  it('is an uncounted read: watching the counters never moves them', async () => {
    const store = openStore({ kind: 'memory' });
    await smeltBlob({
      text: fixtureText(),
      source: '<text>',
      budgetBytes: 600,
      strategy: 'lexical',
      store,
      focus: ['handleRequest'],
    });

    const first = readCounters({ store });
    const second = readCounters({ store });
    expect(second).toEqual(first);
    expect(first.retrieveCalls).toBe(0);
    expect(first.elisionsStored).toBeGreaterThan(0);
    expect(first.allElisionsRetrieved).toBe(false);
  });

  it('counts a miss too — an unknown hash is a question that was asked', () => {
    const store = openStore({ kind: 'memory' });
    expect(() => retrieveBytes({ store, hash: 'deadbeefdeadbeef' })).toThrow(UnknownHashError);
    expect(readCounters({ store }).misses).toBe(1);
  });
});

describe('retrieveMany — N hashes, one call, every hit counted on its own', () => {
  async function stored(): Promise<{
    store: ReturnType<typeof openStore>;
    hashes: readonly string[];
    input: string;
  }> {
    const store = openStore({ kind: 'memory' });
    const input = fixtureText(900);
    const outcome = await smeltBlob({
      text: input,
      source: '<text>',
      budgetBytes: 600,
      strategy: 'lexical',
      store,
      focus: ['handleRequest'],
    });
    const hashes = outcome.result.elisions.map((elision) => elision.hash);
    expect(hashes.length, 'the fixture must produce at least two elisions').toBeGreaterThan(1);
    return { store, hashes, input };
  }

  it('returns one block per hash, in the order asked, each holding the exact bytes', async () => {
    const { store, hashes, input } = await stored();
    const blocks = retrieveMany({ store, hashes });
    expect(blocks.map((block) => block.hash)).toEqual(hashes);
    for (const block of blocks) {
      expect('text' in block, `hash ${block.hash} should have been a hit`).toBe(true);
      if ('text' in block) {
        expect(block.text).toBe(store.peek(block.hash));
        expect(input).toContain(block.text);
      }
    }
  });

  it('moves the expansion rate exactly as N single retrievals would', async () => {
    const { store, hashes } = await stored();
    retrieveMany({ store, hashes });
    const stats = readCounters({ store });
    expect(stats.retrieveCalls).toBe(hashes.length);
    expect(stats.uniqueRetrieved).toBe(hashes.length);
    expect(stats.allElisionsRetrieved).toBe(true);
  });

  it('carries a refusal per hash instead of failing the batch — and counts the miss', async () => {
    const { store, hashes } = await stored();
    const asked = [hashes[0]!, 'deadbeefdeadbeef', hashes[1]!];
    const blocks = retrieveMany({ store, hashes: asked });
    expect(blocks.map((block) => block.hash)).toEqual(asked);
    expect('text' in blocks[0]!).toBe(true);
    expect('text' in blocks[2]!).toBe(true);
    const missed = blocks[1]!;
    expect('error' in missed).toBe(true);
    if ('error' in missed) {
      expect(missed.error).toBeInstanceOf(UnknownHashError);
      expect(missed.error.message).toContain('no stored content for hash "deadbeefdeadbeef"');
    }
    const stats = readCounters({ store });
    expect(stats.retrieveCalls).toBe(3);
    expect(stats.misses).toBe(1);
    expect(stats.uniqueRetrieved).toBe(2);
  });

  it('answers an empty batch with an empty list and touches no counter', () => {
    const store = openStore({ kind: 'memory' });
    expect(retrieveMany({ store, hashes: [] })).toEqual([]);
    expect(readCounters({ store }).retrieveCalls).toBe(0);
  });
});
