import { describe, expect, it } from 'vitest';

import {
  askOverwrite,
  confirmLoop,
  confirmYesNo,
  fileFate,
  listPlannedFiles,
} from '../src/cli/wizard.ts';
import type { Ask, PlannedFileLike } from '../src/cli/wizard.ts';

/**
 * The wizard kit's consent discipline, at the kit's own seam. Every interactive verb —
 * `init`, `hooks`, `setup`, `agents split` — used to carry its own copy of the per-file
 * overwrite question and the file-fate label, each copy with a comment saying it had
 * one home. This is that home; the verbs' own tests prove each verb reaches it.
 */

function scripted(answers: readonly string[]): { ask: Ask; prompts: string[] } {
  const queue = [...answers];
  const prompts: string[] = [];
  const ask: Ask = (prompt) => {
    prompts.push(prompt);
    return Promise.resolve(queue.shift() ?? '');
  };
  return { ask, prompts };
}

function planned(name: string, exists: boolean, unchanged = false): PlannedFileLike {
  return { name, path: `/tmp/${name}`, content: '', exists, unchanged };
}

describe('askOverwrite — the one per-file consent question', () => {
  it('asks the one question, naming the file', async () => {
    const { ask, prompts } = scripted(['yes']);
    await askOverwrite('AGENTS.md', ask);
    expect(prompts).toEqual(['  AGENTS.md exists — overwrite it? (yes/no)> ']);
  });

  it('is satisfied by a literal yes and nothing else', async () => {
    for (const [answer, allowed] of [
      ['yes', true],
      ['y', false],
      ['', false],
      ['YES', false],
      ['no', false],
      ['yes please', false],
    ] as const) {
      expect(
        await askOverwrite('f', scripted([answer]).ask),
        `answer ${JSON.stringify(answer)}`,
      ).toBe(allowed);
    }
  });
});

describe('confirmLoop / confirmYesNo — a mistyped confirm re-asks without eating the next line', () => {
  it('three-way: says the retry copy, then reads the very next answer as the confirm', async () => {
    const { ask, prompts } = scripted(['y', 'yes']);
    const said: string[] = [];
    const verdict = await confirmLoop(ask, (text) => said.push(text), 'yes to write, no to stop.');
    expect(verdict).toBe('yes');
    expect(prompts).toEqual(['confirm (yes / no / back)> ', 'confirm (yes / no / back)> ']);
    expect(said).toEqual(['yes to write, no to stop.\n']);
  });

  it('two-way: the same, and back is not an answer here', async () => {
    const { ask, prompts } = scripted(['back', 'no']);
    const said: string[] = [];
    const verdict = await confirmYesNo(ask, (text) => said.push(text), 'yes or no.');
    expect(verdict).toBe('no');
    expect(prompts).toHaveLength(2);
    expect(said).toEqual(['yes or no.\n']);
  });
});

describe('fileFate — what the confirm listing says will happen to a file', () => {
  it('names the three fates under the ask policy', () => {
    expect(fileFate(planned('a', false), 'ask')).toBe('new');
    expect(fileFate(planned('a', true), 'ask')).toBe('exists — will ask before overwriting');
    expect(fileFate(planned('a', true, true), 'ask')).toBe('unchanged — nothing to write');
  });

  it('says skipped, not asked, under the skip policy — setup consents by policy', () => {
    expect(fileFate(planned('a', true), 'skip')).toBe('exists — will be skipped, not overwritten');
    expect(fileFate(planned('a', false), 'skip')).toBe('new');
    expect(fileFate(planned('a', true, true), 'skip')).toBe('unchanged — nothing to write');
  });
});

describe('listPlannedFiles — one listing, padded to its longest name', () => {
  it('aligns the fates on the longest name in the plan, skipped files included', () => {
    const lines: string[] = [];
    listPlannedFiles(
      (text) => lines.push(text),
      [planned('smelt.config.json', false), planned('a.md', true)],
      [{ name: 'a-much-longer-skipped-file.json', why: 'not ours' }],
      (file) => fileFate(file, 'ask'),
    );
    const width = 'a-much-longer-skipped-file.json'.length;
    expect(lines).toEqual([
      `  ${'smelt.config.json'.padEnd(width)} (new)\n`,
      `  ${'a.md'.padEnd(width)} (exists — will ask before overwriting)\n`,
      `  ${'a-much-longer-skipped-file.json'.padEnd(width)} (SKIPPED: not ours)\n`,
    ]);
  });
});
