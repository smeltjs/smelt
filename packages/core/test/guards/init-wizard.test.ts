import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken
// copy of `src` and watch it go red. See scripts/mutate.mjs.
import { CONFIG_FILE_NAME } from '@guard/config';
import { RERANK_STUB_FILE, runInit } from '@guard/cli/init';

import type { GuardMutation } from './_mutations.ts';

/**
 * INIT-WIZARD GUARD — the three promises `smelt init` makes about other people's files.
 *
 *  1. **Nothing is written before the final confirm.** A wizard that writes as it
 *     goes cannot be declined; "no" at the end must mean the directory is exactly as
 *     it was found.
 *  2. **An existing file is never overwritten without an explicit per-file yes.**
 *     Anything but a literal `yes` — including silence-shaped answers like `` or
 *     `y` — leaves the existing bytes byte-for-byte intact.
 *  3. **Nothing is written outside the directory the user was shown.** The wizard may
 *     now write at a workspace root instead of the working directory — it asks, and
 *     the "About to write" listing names the directory either way — so the answer must
 *     decide the destination, and the directory not chosen must stay untouched.
 *
 * All three are the same failure family as the rest of this repo's guards: the
 * violation looks *helpful* (the wizard "just" finished the job, "just" put the config
 * where runs would find it), succeeds on the happy path, and writes over someone's
 * file — or into someone's repo root — only on the day it matters. The mutations
 * `init-overwrite-without-consent` and `init-writes-outside-the-chosen-directory`
 * prove the second and third can go red.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-init-guard-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function wizard(answers: readonly string[]): Promise<string> {
  return await wizardIn(dir, answers);
}

async function wizardIn(cwd: string, answers: readonly string[]): Promise<string> {
  let output = '';
  await runInit({
    input: Readable.from([`${answers.join('\n')}\n`]),
    output: (text: string) => {
      output += text;
    },
    cwd,
  });
  return output;
}

describe('the init wizard never touches an existing file without a per-file yes', () => {
  const sentinel = '// hand-written — the wizard must not touch this\n';

  it('asks per file, and anything but a literal yes keeps the existing bytes', async () => {
    writeFileSync(join(dir, RERANK_STUB_FILE), sentinel);
    for (const refusal of ['no', '', 'y', 'ok', 'overwrite']) {
      // Fresh run choosing the rerank stub; config is new, the stub exists.
      const output = await wizard(['4000', '1', '1', '1', '2', 'yes', refusal]);
      expect(output, refusal).toContain(`${RERANK_STUB_FILE} exists`);
      expect(readFileSync(join(dir, RERANK_STUB_FILE), 'utf8'), refusal).toBe(sentinel);
      rmSync(join(dir, CONFIG_FILE_NAME), { force: true });
    }
  });

  it('an explicit yes is honoured — the rule is consent, not read-only', async () => {
    writeFileSync(join(dir, RERANK_STUB_FILE), sentinel);
    await wizard(['4000', '1', '1', '1', '2', 'yes', 'yes']);
    const written = readFileSync(join(dir, RERANK_STUB_FILE), 'utf8');
    expect(written).not.toBe(sentinel);
    expect(written).toContain('RerankStage');
  });

  it('writes nothing at all before the final confirm', async () => {
    writeFileSync(join(dir, RERANK_STUB_FILE), sentinel);
    const output = await wizard(['4000', '2', 'my-store', '2', '2', '2', 'no']);
    expect(output).toContain('Nothing was written');
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, 'my-store'))).toBe(false);
    expect(existsSync(join(dir, 'smelt.measure.ts'))).toBe(false);
    expect(readFileSync(join(dir, RERANK_STUB_FILE), 'utf8')).toBe(sentinel);
  });
});

describe('the init wizard writes only inside the directory it named', () => {
  it('honours the answer to the workspace question, and leaves the other end alone', async () => {
    const pkg = join(dir, 'packages', 'web');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");

    // "here": the workspace root above it must stay exactly as it was found.
    const here = await wizardIn(pkg, ['2', '4000', '1', '1', '1', '1', 'yes']);
    expect(here).toContain(`About to write, into ${pkg}`);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(true);
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(false);

    // "the workspace root": the package it was run from gains nothing.
    rmSync(join(pkg, CONFIG_FILE_NAME));
    const rooted = await wizardIn(pkg, ['1', '4000', '1', '1', '1', '1', 'yes']);
    expect(rooted).toContain(`About to write, into ${dir}`);
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(true);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(false);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'init-overwrite-without-consent',
    file: 'cli/init.ts',
    find: "      if (answer !== 'yes') {",
    replace: '      if (false) {',
    why: 'the per-file overwrite consent wired shut — `smelt init` would clobber a hand-written file after any answer, the helpful-looking break the never-overwrite rule exists to refuse',
  },
  {
    id: 'init-writes-outside-the-chosen-directory',
    file: 'cli/init.ts',
    find: "    if (pick === '2') return io.cwd;",
    replace: "    if (pick === '2') return root;",
    why: 'the monorepo question asked and then ignored — a user who answered "here" gets a config written at the workspace root instead, which is the wizard writing outside the one directory its own listing named and they confirmed',
  },
];
