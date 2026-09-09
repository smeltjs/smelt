import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { formatReport, EXIT, frontDoor, runCli } from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';
import type { SmeltResult } from '../src/types.ts';

/**
 * THE PRESENTATION, PINNED — what a person actually sees, as committed text.
 *
 * The palette guard (`test/guards/palette.test.ts`) holds the *properties*: off is the
 * identity, a machine surface carries no paint, a non-zero never rounds to zero. This
 * file holds the *rendering* — the four pages a person meets — as file snapshots, for
 * the same reason `cli-usage.help.txt` exists: a layout change should be a diff a
 * reviewer reads, not something that happens.
 *
 * Every snapshot here is the **plain** rendering. The paint is a function of the same
 * words (the palette is the identity with colour off), so pinning the words pins both,
 * and a snapshot full of escape sequences would be unreadable in review — which is the
 * whole point of a snapshot.
 *
 * The two `--json` fixtures are the other half of the promise: those envelopes are a
 * stated surface, and this overhaul moved a lot of rendering around them. A byte that
 * moves in either of them is a diff, not a surprise in somebody's agent.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A project with a directory store the store-backed verbs can read. */
function projectRoot(storePath = '.smelt/store'): string {
  const root = mkdtempSync(join(tmpdir(), 'smelt-presentation-'));
  roots.push(root);
  writeFileSync(
    join(root, 'smelt.config.json'),
    `${JSON.stringify(
      {
        smeltConfig: 1,
        defaultBudgetBytes: 4000,
        store: { kind: 'directory', path: storePath },
      },
      null,
      2,
    )}\n`,
  );
  return root;
}

/** Fixed input, so every hash, byte count and rate in these snapshots is reproducible. */
function corpus(): string {
  return `${Array.from({ length: 200 }, (_, i) => `line ${String(i)} padding padding`).join('\n')}\n`;
}

async function run(
  argv: readonly string[],
  cwd: string,
  stdin = '',
  io: Partial<CliIo> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    stdin: () => stdin,
    version: '9.9.9-test',
    cwd,
    ...io,
  });
  return { code, stdout, stderr };
}

/** Temp paths differ every run; the shape of the line does not. */
function normalize(text: string, root: string): string {
  return text.replaceAll(root, '<project>');
}

describe('the front door', () => {
  it('greets a person at a terminal with the wordmark and the three commands', async () => {
    const { code, stdout } = await run([], projectRoot(), '', { tty: true });
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe(frontDoor());
    await expect(stdout).toMatchFileSnapshot('__snapshots__/cli-front-door.txt');
  });
});

describe('smelt stats', () => {
  it('renders a populated store: what it holds, the rate, the counters, the ledger', async () => {
    const root = projectRoot();
    // Filled through the CLI rather than through the store's API: the point of the
    // snapshot is the page a real run produces.
    await run(['--budget', '600'], root, corpus());
    const { code, stdout } = await run(['stats'], root);
    expect(code).toBe(EXIT.ok);
    await expect(normalize(stdout, root)).toMatchFileSnapshot(
      '__snapshots__/cli-stats.populated.txt',
    );
  });

  it('says so in one line when the store is empty, rather than printing a page of zeroes', async () => {
    const root = projectRoot();
    mkdirSync(join(root, '.smelt/store'), { recursive: true });
    const { code, stdout } = await run(['stats'], root);
    expect(code).toBe(EXIT.ok);
    await expect(normalize(stdout, root)).toMatchFileSnapshot('__snapshots__/cli-stats.empty.txt');
  });
});

describe('smelt doctor', () => {
  it('reports a clean nothing-installed reading', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-presentation-'));
    roots.push(root);
    const { code, stdout } = await run(['doctor'], root, '', { home: join(root, 'home') });
    expect(code).toBe(EXIT.ok);
    await expect(normalize(stdout, root)).toMatchFileSnapshot(
      '__snapshots__/cli-doctor.nothing.txt',
    );
  });

  it('marks each finding, and sets the repair apart from what it repairs', async () => {
    // A config that promises a store directory nobody made: one orphan, one repair,
    // and the exit that says so.
    const root = projectRoot('.smelt/store');
    const { code, stdout } = await run(['doctor'], root, '', { home: join(root, 'home') });
    expect(code).toBe(EXIT.refused);
    await expect(normalize(stdout, root)).toMatchFileSnapshot(
      '__snapshots__/cli-doctor.orphan.txt',
    );
  });
});

describe("the wizards' closing block", () => {
  it('ends `smelt setup` with what it did and what to type next', async () => {
    // The whole recipe, applied with --yes into a scratch project, so the block is the
    // one a real install prints — counts included.
    const root = mkdtempSync(join(tmpdir(), 'smelt-presentation-'));
    roots.push(root);
    const { code, stdout } = await run(['setup', '--yes', '--harness', 'claude-code'], root, '', {
      home: join(root, 'home'),
    });
    expect(code).toBe(EXIT.ok);
    // Only the block: everything above it is the apply listing, which the setup guards
    // already pin and which names absolute paths.
    const block = stdout.slice(stdout.indexOf('\n━'));
    await expect(normalize(block, root)).toMatchFileSnapshot(
      '__snapshots__/cli-done-block.setup.txt',
    );
  });
});

describe('the stated surfaces did not move', () => {
  it('smelt --json is byte-identical to the committed envelope', async () => {
    const root = projectRoot();
    const { code, stdout } = await run(['--budget', '600', '--json'], root, corpus());
    expect(code).toBe(EXIT.ok);
    await expect(stdout).toMatchFileSnapshot('__snapshots__/cli-json.smelt.json');
  });

  it('smelt stats --json is byte-identical to the committed envelope', async () => {
    const root = projectRoot();
    await run(['--budget', '600'], root, corpus());
    const { code, stdout } = await run(['stats', '--json'], root);
    expect(code).toBe(EXIT.ok);
    await expect(stdout).toMatchFileSnapshot('__snapshots__/cli-json.stats.json');
  });
});

/** A result with no elisions, so only the report's header lines are under test. */
function result(rerank: SmeltResult['rerank']): SmeltResult {
  return {
    text: 'kept',
    inputBytes: 4,
    outputBytes: 4,
    planner: 'lexical/v1',
    language: 'unknown',
    elisions: [],
    ...(rerank === undefined ? {} : { rerank }),
  };
}

describe('the report says what a configured reranker did, and why it stopped', () => {
  const report = (rerank: SmeltResult['rerank']): string =>
    formatReport({
      result: result(rerank),
      source: '<stdin>',
      budgetBytes: 4000,
      inputText: 'kept',
    });

  it('names the adapter and the measured numbers when it ran', () => {
    expect(
      report({
        adapter: 'voyage',
        model: 'rerank-2.5',
        candidates: 23,
        returned: 8,
        kept: 8,
        sparedBytes: 3010,
        stopped: 'cap',
      }),
    ).toContain('rerank  voyage/rerank-2.5  (23 candidates, 8 kept, 3,010 B back)');
  });

  it('states the budget stop and how many the stage had offered', () => {
    // The line a `topK` of 8 that yielded 3 has to print. Without the clause the reader
    // sees a number smaller than the one they configured and no reason for it, and the
    // most natural guess — "the ranker only found three relevant regions" — is wrong.
    const line = report({
      adapter: 'voyage',
      model: 'rerank-2.5',
      candidates: 23,
      returned: 8,
      kept: 3,
      sparedBytes: 1204,
      stopped: 'budget',
    });
    expect(line).toContain(
      'rerank  voyage/rerank-2.5  (23 candidates, 3 kept, 1,204 B back)' +
        '   stopped at the budget: the stage offered 8',
    );
  });

  it('prints no stop clause when the stage’s own answer ended the walk', () => {
    // `cap` and `exhausted` are the outcomes where `kept` already IS the whole answer,
    // so a clause would restate the counts beside it on every run.
    for (const stopped of ['cap', 'exhausted'] as const) {
      const line = report({
        adapter: 'voyage',
        candidates: 4,
        returned: 4,
        kept: 4,
        sparedBytes: 90,
        stopped,
      });
      expect(line).toContain('rerank  voyage  (4 candidates, 4 kept, 90 B back)\n');
      expect(line).not.toContain('stopped at');
    }
  });

  it('states the precondition it could not supply when it did not', () => {
    // These two clauses had no render test at all: the strings existed, the table was
    // total over the outcomes, and nothing asserted that either one reached a reader.
    expect(
      report({ adapter: 'voyage', candidates: 0, kept: 0, skipped: 'no-candidates' }),
    ).toContain(
      'rerank  voyage  (0 candidates, 0 kept)   not run: the planner proposed nothing to cut',
    );
    expect(report({ adapter: 'voyage', candidates: 12, kept: 0, skipped: 'no-query' })).toContain(
      'rerank  voyage  (12 candidates, 0 kept)   not run: this run named no focus terms to rank against',
    );
  });

  it('prints no rerank line at all when no stage was configured', () => {
    expect(report(undefined)).not.toContain('rerank');
  });
});
