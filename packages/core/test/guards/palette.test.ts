import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { colorAllowed, palette, percent, PLAIN, supportsUnicode } from '@guard/cli/lava';
import { EXIT, runCli } from '@guard/cli/run';
import { cliUsage, frontDoor } from '@guard/cli/usage';

import type { GuardMutation } from './_mutations.ts';

/**
 * PALETTE GUARD — the presentation, held to the three properties that make it safe.
 *
 * A CLI that paints is a CLI that can lie in a new way: an escape sequence in a pipe
 * is a byte somebody has to parse around, a padded column measured after painting is a
 * column that does not line up, and a percentage rounded down to `0.0%` is Law 4
 * broken at the very last inch — in the direction that flatters smelt, because
 * "nothing was asked back" is the comfortable answer.
 *
 * So this guard pins:
 *
 *   1. **Off is the identity.** With colour off, every role, every primitive and the
 *      whole help page are the plain bytes. `--json` is off *whatever* the terminal
 *      says, on every verb that has an envelope: a machine surface never carries paint.
 *   2. **The switches are obeyed.** `NO_COLOR` beats a terminal, `FORCE_COLOR` beats a
 *      pipe, `--no-color` beats both, and a non-TTY is plain by default.
 *   3. **A rendering may not round a non-zero to zero.** `percent` prints `<0.1%`, and
 *      the bar keeps one filled cell for a rate that is not zero and one empty cell for
 *      a rate that is not one.
 *
 * The fourth thing it pins is quieter and was the first bug this module had: padding is
 * computed on unpainted text. An ANSI sequence has zero width on screen and eight to
 * twenty bytes in a string, so a table that pads after painting looks perfect in every
 * test that runs plain and is ragged on the only machine that matters — the user's.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A project with a directory store, so the store-backed verbs have somewhere to read. */
function projectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'smelt-palette-guard-'));
  roots.push(root);
  writeFileSync(
    join(root, 'smelt.config.json'),
    `${JSON.stringify(
      { smeltConfig: 1, defaultBudgetBytes: 4000, store: { kind: 'directory', path: '.smelt' } },
      null,
      2,
    )}\n`,
  );
  writeFileSync(join(root, 'corpus.txt'), corpus());
  return root;
}

/** Long enough that a small budget forces elisions. */
function corpus(): string {
  return `${Array.from({ length: 200 }, (_, i) => `line ${String(i)} padding padding`).join('\n')}\n`;
}

/** One CLI run, with the colour switches turned all the way up. */
async function loud(
  argv: readonly string[],
  cwd: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    stdin: () => corpus(),
    version: '9.9.9-test',
    cwd,
    color: true,
    colorErr: true,
    tty: true,
  });
  return { code, stdout, stderr };
}

/** The escape byte every one of these assertions is about. */
const ESC = '[';

describe('off is the identity', () => {
  it('renders every role, glyph and primitive as plain text with colour off', () => {
    expect(PLAIN.paint('bad', 'ORPHAN: something')).toBe('ORPHAN: something');
    expect(PLAIN.heading('USAGE')).toBe('USAGE');
    expect(PLAIN.glyph('ok')).toBe('✓');
    expect(PLAIN.bar(0.5, 4)).toBe('██░░');
    expect(PLAIN.kv([{ name: 'a', value: '1' }])).toBe('  a  1');
    expect(PLAIN.logo()).not.toContain(ESC);
    expect(cliUsage()).not.toContain(ESC);
    expect(frontDoor()).not.toContain(ESC);
  });

  it('pads on the unpainted text, so a painted column is the same width as a plain one', () => {
    const spec = {
      columns: [
        { header: 'rule' },
        { header: 'n', align: 'right' as const, role: 'number' as const },
      ],
      rows: [
        ['head-tail', '1'],
        ['sibling-collapse', '20'],
      ],
    };
    const plain = PLAIN.table(spec).split('\n');
    const painted = palette({ color: true })
      .table(spec)
      .split('\n')
      // Strip the paint back off: what is left must be the plain table, byte for byte.
      .map((line) => line.replaceAll(/\[[0-9;]*m/gu, ''));
    expect(painted).toEqual(plain);
  });

  it('falls back to ASCII where the locale never promised more', () => {
    const ascii = palette({ unicode: false });
    expect(ascii.glyph('ok')).toBe('+');
    expect(ascii.glyph('bad')).toBe('x');
    expect(ascii.glyph('warn')).toBe('!');
    expect(ascii.bar(0.5, 4)).toBe('##..');
    expect(ascii.logo()).not.toMatch(/[█╗╚]/u);
    expect(supportsUnicode({ LANG: 'en_US.UTF-8' })).toBe(true);
    expect(supportsUnicode({ LANG: 'C' })).toBe(false);
    expect(supportsUnicode({})).toBe(false);
    // LC_ALL wins over LANG, exactly as the C library resolves it.
    expect(supportsUnicode({ LC_ALL: 'C', LANG: 'en_US.UTF-8' })).toBe(false);
  });
});

describe('a machine surface never carries paint', () => {
  // Every verb with an envelope, driven with the terminal claiming to be as
  // colour-hungry as it gets. `--json` is the contract an agent parses.
  // A path is resolved against the *process* working directory, not the injected one,
  // so the two runs that name one are given the scratch project's absolute path.
  const JSON_RUNS: readonly (readonly [string, (cwd: string) => readonly string[]])[] = [
    ['smelt <file>', (cwd) => [join(cwd, 'corpus.txt'), '--budget', '600', '--json']],
    ['map', (cwd) => ['map', cwd, '--budget', '600', '--json']],
    ['stats', () => ['stats', '--json']],
    ['doctor', () => ['doctor', '--json']],
    ['agents lint', (cwd) => ['agents', 'lint', cwd, '--json']],
    ['store prune', () => ['store', 'prune', '--older-than', '30d', '--dry-run', '--json']],
  ];

  it.each(JSON_RUNS)('smelt %s emits an envelope with no escape bytes', async (_name, argv) => {
    const cwd = projectRoot();
    const { stdout } = await loud(argv(cwd), cwd);
    expect(stdout).not.toContain(ESC);
    // …and it is still JSON, so this is a statement about the envelope and not about
    // an empty string.
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
  });
});

describe('the switches are obeyed', () => {
  it('NO_COLOR beats a terminal, FORCE_COLOR beats a pipe, and NO_COLOR beats FORCE_COLOR', () => {
    expect(colorAllowed({}, true)).toBe(true);
    expect(colorAllowed({}, false)).toBe(false);
    expect(colorAllowed({ NO_COLOR: '1' }, true)).toBe(false);
    expect(colorAllowed({ NO_COLOR: '' }, true)).toBe(true); // empty is unset, per no-color.org
    expect(colorAllowed({ FORCE_COLOR: '1' }, false)).toBe(true);
    expect(colorAllowed({ FORCE_COLOR: '0' }, false)).toBe(false);
    expect(colorAllowed({ FORCE_COLOR: '1', NO_COLOR: '1' }, true)).toBe(false);
  });

  it('--no-color makes even the refusal plain, and the flag reaches every verb', async () => {
    const cwd = projectRoot();
    const painted = await loud(['stats'], cwd);
    expect(painted.stdout).toContain(ESC);

    const plain = await loud(['stats', '--no-color'], cwd);
    expect(plain.stdout).not.toContain(ESC);

    // A refusal is printed before there is an invocation to carry the flag, which is
    // why `--no-color` is read off argv rather than out of the parsed values.
    const refused = await loud(['stats', 'extra', '--no-color'], cwd);
    expect(refused.code).toBe(EXIT.usage);
    expect(refused.stderr).not.toContain(ESC);
    expect((await loud(['stats', 'extra'], cwd)).stderr).toContain(ESC);
  });

  it('does not touch the wizard input stream on its way past — a colour flag is not a pipe bug', async () => {
    // `bin.ts` hands `initInput` over as a getter, because merely touching
    // `process.stdin` flips fd 0 into non-blocking mode and breaks the one-shot read
    // every other verb uses. `--no-color` derives a plainer io on the way in, and a
    // *spread* would evaluate that getter — turning a colour flag into `EAGAIN` on a
    // slow pipe.
    const cwd = projectRoot();
    let touched = false;
    let stdout = '';
    const code = await runCli(['stats', '--no-color'], {
      stdout: (text) => void (stdout += text),
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd,
      color: true,
      get initInput() {
        touched = true;
        return (async function* () {
          yield '';
        })();
      },
    });
    expect(code).toBe(EXIT.ok);
    expect(stdout).not.toContain(ESC);
    expect(touched, 'the CLI read initInput for a verb that never asks a question').toBe(false);
  });

  it('a stream that is not a terminal is plain, and the front door does not appear in it', async () => {
    const cwd = projectRoot();
    let stdout = '';
    const code = await runCli([], {
      stdout: (text) => void (stdout += text),
      stderr: () => {},
      // Bare `smelt` with something on stdin is a pipe, not a person: the old
      // behaviour, byte for byte, and no logo written into somebody's data.
      stdin: () => corpus(),
      version: '9.9.9-test',
      cwd,
    });
    // Whether this corpus fits the config's budget is beside the point: what matters
    // is that it was *smelted* rather than greeted.
    expect([EXIT.ok, EXIT.overBudget]).toContain(code);
    expect(stdout).not.toContain(ESC);
    expect(stdout).not.toContain('███');
  });

  it('bare `smelt` at a terminal is the front door, painted', async () => {
    const cwd = projectRoot();
    const { code, stdout } = await loud([], cwd);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain(ESC);
    expect(stdout.replaceAll(/\[[0-9;]*m/gu, '')).toBe(frontDoor());
  });
});

describe('Law 4 reaches the formatter', () => {
  it('never rounds a non-zero rate to zero', () => {
    expect(percent(0)).toBe('0.0%');
    expect(percent(0.0004)).toBe('<0.1%'); // 0.04% — real, and not 0.0%
    expect(percent(-0.0004)).toBe('>-0.1%');
    expect(percent(0.001)).toBe('0.1%');
    expect(percent(0.125)).toBe('12.5%');
    expect(percent(1)).toBe('100.0%');
  });

  it('never draws an empty bar for a rate that is not zero, or a full one for a rate that is not one', () => {
    expect(PLAIN.bar(0, 20)).toBe('░'.repeat(20));
    // 1 in 500 asked back: rounds to no cells, so the bar keeps one.
    expect(PLAIN.bar(0.002, 20)).toBe(`█${'░'.repeat(19)}`);
    expect(PLAIN.bar(0.999, 20)).toBe(`${'█'.repeat(19)}░`);
    expect(PLAIN.bar(1, 20)).toBe('█'.repeat(20));
  });

  it('caps a bar at the width the palette will draw, however wide it is asked for', () => {
    expect(PLAIN.bar(1, 4000)).toHaveLength(40);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    id: 'palette-colour-leaks-into-json',
    file: 'cli/subcommands/doctor.ts',
    find: '        lava: resolved.json ? PLAIN : stdoutPalette(io),',
    replace: '        lava: stdoutPalette(io),',
    why: 'a machine surface carrying paint — an agent parsing `smelt doctor --json` would have to parse around escape sequences, which is the one thing an envelope promises it never has to do',
  },
  {
    kind: 'src',
    id: 'palette-bar-rounds-a-real-rate-to-nothing',
    file: 'cli/lava.ts',
    find: '  if (clamped > 0 && filled === 0) filled = 1;',
    replace: '  if (false) filled = 1;',
    why: 'a bar that draws "nothing was asked back" for a rate that is not zero — Law 4 lost in a picture, in the direction that flatters smelt',
  },
  {
    kind: 'src',
    id: 'palette-percent-rounds-a-non-zero-to-zero',
    file: 'cli/lava.ts',
    find: "  if (value > 0 && value < 0.05) return '<0.1%';",
    replace: '  if (false) return String(value);',
    why: 'a real 0.04% expansion rate printed as `0.0%` — the same rounding-to-a-comfortable-answer Law 4 exists to forbid',
  },
  {
    kind: 'src',
    id: 'palette-ignores-NO_COLOR',
    file: 'cli/lava.ts',
    find: "  if (no !== undefined && no !== '') return false;",
    replace: '  if (false) return false;',
    why: 'NO_COLOR ignored — the one environment variable whose whole meaning is "this terminal, or this CI log, must not receive escape sequences"',
  },
  {
    kind: 'src',
    id: 'palette-paints-when-switched-off',
    file: 'cli/lava.ts',
    find: "    if (!on || text === '') return text;",
    replace: "    if (text === '') return text;",
    why: 'the palette painting bytes nobody asked to paint — the identity property every other guard in this repository leans on',
  },
  {
    kind: 'src',
    id: 'palette-no-color-drains-the-wizard-stream',
    file: 'cli/run.ts',
    find:
      '  return Object.create(io, {\n' +
      '    color: { value: false, enumerable: true },\n' +
      '    colorErr: { value: false, enumerable: true },\n' +
      '  }) as CliIo;',
    replace: '  return { ...io, color: false, colorErr: false };',
    why: 'the obvious spelling of "the same io, unpainted" — which reads every own property on the way past, evaluating the lazy `initInput` getter that exists precisely so fd 0 is not touched, and turns a colour flag into an EAGAIN on a slow pipe',
  },
  {
    kind: 'src',
    id: 'palette-pads-after-painting',
    file: 'cli/lava.ts',
    find: "      .map((column, index) => paint(column.role ?? 'plain', lay(row[index] ?? '', index)))",
    replace:
      "      .map((column, index) => lay(paint(column.role ?? 'plain', row[index] ?? ''), index))",
    why: 'a cell padded after it was painted — an escape sequence has zero width on screen and a dozen bytes in the string, so the column is padded to a width nobody can see and the table is ragged on the only machine that matters',
  },
];
