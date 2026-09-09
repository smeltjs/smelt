import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import {
  colorAllowed,
  colorDepth,
  colorize,
  countedFiles,
  doneBlock,
  palette,
  percent,
  PLAIN,
  supportsUnicode,
} from '@guard/cli/lava';
import { runInit } from '@guard/cli/init';
import { stderrPalette, stdoutPalette } from '@guard/cli/lava';
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

/** A wizard's answers, one line at a time, as the injected stream shape. */
function scripted(answers: readonly string[]): AsyncIterable<string> {
  return (async function* (): AsyncGenerator<string> {
    yield `${answers.join('\n')}\n`;
  })();
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

/** The escape sequence prefix every one of these assertions is about. */
const ESC = '\u001b[';

/**
 * The same, as a pattern: strip the paint back off and see what is underneath.
 *
 * Built from the constant rather than written as a literal, because a control
 * character inside a regex literal is a lint error and an invisible byte in a diff —
 * exactly the thing this file exists to be precise about.
 */
const PAINT = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'gu');

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
      .map((line) => line.replaceAll(PAINT, ''));
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
    const { stdout, stderr } = await loud(argv(cwd), cwd);
    expect(stdout).not.toContain(ESC);
    // …and it is still JSON, so this is a statement about the envelope and not about
    // an empty string.
    expect(() => JSON.parse(stdout) as unknown).not.toThrow();
    // The other stream too: `--json` is bytes for a machine, and `2>&1` is how a
    // machine ends up reading the report beside the envelope.
    expect(stderr, 'the report beside the envelope was painted').not.toContain(ESC);
  });

  it('paints the report on stderr when the run is not a --json one', async () => {
    // The other half of the claim above: the report *is* painted when a person is
    // reading it, which is what makes the plain `--json` case a decision.
    const cwd = projectRoot();
    const { stderr } = await loud([join(cwd, 'corpus.txt'), '--budget', '600'], cwd);
    expect(stderr).toContain(ESC);
  });
});

/** The wordmark at one depth — the surface where a wrong assumption is most visible. */
function logo(depth: 'truecolor' | 256 | 16): string {
  return palette({ color: true, depth }).logo();
}

describe('the terminal is asked how much colour it has', () => {
  it('reads the precedence in order, each rung on its own', () => {
    // NO_COLOR beats everything, including a person's own FORCE_COLOR.
    expect(colorDepth({ NO_COLOR: '1', FORCE_COLOR: '3', COLORTERM: 'truecolor' }, true)).toBe(
      'none',
    );
    // FORCE_COLOR's conventional levels, and "colour, but do not guess high".
    expect(colorDepth({ FORCE_COLOR: '0' }, true)).toBe('none');
    expect(colorDepth({ FORCE_COLOR: '1' }, false)).toBe(16);
    expect(colorDepth({ FORCE_COLOR: '2' }, false)).toBe(256);
    expect(colorDepth({ FORCE_COLOR: '3' }, false)).toBe('truecolor');
    expect(colorDepth({ FORCE_COLOR: 'true', TERM: 'xterm-256color' }, false)).toBe(16);
    // Then what the terminal says about itself.
    expect(colorDepth({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }, true)).toBe('truecolor');
    expect(colorDepth({ COLORTERM: '24bit' }, true)).toBe('truecolor');
    expect(colorDepth({ TERM: 'xterm-256color' }, true)).toBe(256);
    // A terminal that has said it cannot is not a terminal that can.
    expect(colorDepth({ TERM: 'dumb' }, true)).toBe('none');
    // And the floor: sixteen colours at a terminal, nothing in a pipe.
    expect(colorDepth({ TERM: 'xterm' }, true)).toBe(16);
    expect(colorDepth({}, true)).toBe(16);
    expect(colorDepth({}, false)).toBe('none');
    // `colorAllowed` is the same answer as a boolean, never a second opinion.
    for (const env of [{}, { NO_COLOR: '1' }, { TERM: 'dumb' }, { FORCE_COLOR: '2' }]) {
      for (const tty of [true, false]) {
        expect(colorAllowed(env, tty), JSON.stringify(env)).toBe(colorDepth(env, tty) !== 'none');
      }
    }
  });

  it('emits the sequences each depth actually has, and 38;2 only where it was promised', () => {
    // The bug this closes: `38;2;…` went out unconditionally, and a 16-colour
    // emulator, Terminal.app or tmux without -2 renders it as garbage — in the logo
    // the front door leads with.
    expect(logo('truecolor')).toContain(`${ESC}38;2;`);
    expect(logo(256)).toContain(`${ESC}38;5;`);
    expect(logo(256)).not.toContain(`${ESC}38;2;`);
    // Sixteen: one of the basic SGR colours, and nothing extended at all.
    // `ESC` is the CSI itself (`\u001b[`), so its bracket is escaped for the pattern.
    expect(logo(16)).toMatch(new RegExp(`${ESC.replace('[', '\\[')}(?:3[0-7]|9[0-7])m`, 'u'));
    expect(logo(16)).not.toContain(`${ESC}38;`);
    // The whole ramp lands on yellow at sixteen colours — the nearest thing a 1979
    // palette has to amber. Flat, and legible, which is the trade.
    const sixteen = palette({ color: true, depth: 16 });
    expect(sixteen.paint('brand', 'x')).toBe(`${ESC}33mx${ESC}0m`);
    expect(sixteen.paint('number', 'x')).toBe(`${ESC}33mx${ESC}0m`);
    // The roles that were never on the ramp are the same at every depth.
    for (const depth of ['truecolor', 256, 16] as const) {
      expect(palette({ color: true, depth }).paint('good', 'y')).toBe(`${ESC}32my${ESC}0m`);
    }
    // …and `none` is the plain rendering, whatever `color` said.
    expect(palette({ color: true, depth: 'none' }).logo()).not.toContain(ESC);
    expect(palette({ color: false, depth: 'truecolor' }).logo()).not.toContain(ESC);
  });

  it('carries the depth from the io to every stream palette', () => {
    const io = { color: true, colorErr: true, depth: 256 as const };
    expect(stdoutPalette(io).depth).toBe(256);
    expect(stderrPalette(io).depth).toBe(256);
    // A stream that is not painted is `none`, whatever the terminal can do.
    expect(stdoutPalette({ color: false, depth: 'truecolor' }).depth).toBe('none');
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
    expect(stdout.replaceAll(PAINT, '')).toBe(frontDoor());
  });
});

describe('the closing block: what happened, and what to type next', () => {
  const block = {
    ok: true,
    what: 'smelt setup',
    summary: 'wrote 4 files; 3 of 3 checks passed',
    note: 'Re-run with different toggles to edit them.',
    next: [
      ['smelt doctor', 'read back what was just written'],
      ['smelt <file> --budget 4000', 'smelt one file'],
    ] as const,
  };

  it("is plain text, and the wizards' sink is what paints it", () => {
    const plain = doneBlock(block);
    expect(plain).not.toContain(ESC);
    // The wizards emit the block plain and their verb wraps the stream in `colorize`:
    // one switch, one place. Off, that sink is the identity; on, it paints the rule.
    expect(colorize(plain, false)).toBe(plain);
    expect(colorize(plain, true)).toContain(`${ESC}38;2;`);
    // …and the words survive the paint, contiguous, the way every other guard's
    // substrings do.
    expect(colorize(plain, true)).toContain('Done. smelt setup wrote 4 files');
  });

  it('opens with the verdict and closes with the commands, aligned', () => {
    const lines = doneBlock(block).split('\n');
    expect(lines[1]).toMatch(/^━{10,}$/u);
    expect(lines[2]).toBe('  ✓ Done. smelt setup wrote 4 files; 3 of 3 checks passed.');
    expect(lines[3]).toBe('    Re-run with different toggles to edit them.');
    expect(doneBlock(block)).toContain('  Next');
    // The command column is padded to the widest command, so the reasons line up.
    expect(doneBlock(block)).toContain('    smelt doctor                read back');
    // A failed run wears the other mark, and says so where a reader is already looking.
    expect(doneBlock({ ...block, ok: false })).toContain('  ✗ Done.');
  });

  it('counts what was applied, and says only what happened', () => {
    expect(countedFiles(['written'])).toBe('wrote 1 file');
    expect(countedFiles(['written', 'written'])).toBe('wrote 2 files');
    expect(countedFiles(['unchanged', 'unchanged'])).toBe('left 2 files unchanged');
    expect(countedFiles(['skipped'])).toBe('skipped 1 file');
    expect(countedFiles(['updated', 'updated'])).toBe('updated 2 files');
    expect(countedFiles([])).toBe('wrote nothing');
    // Several buckets: each one named, and the total stated once rather than implied.
    expect(countedFiles(['written', 'written', 'unchanged', 'skipped'])).toBe(
      'wrote 2, left 1 unchanged, skipped 1 — 4 files in all',
    );
  });
});

describe('the closing block counts what was applied, not what was planned', () => {
  it('counts a file the preset would not write as a file it did not write', async () => {
    // Grok documents no user-level hook file and no user-level instruction file, so a
    // machine-scope install writes two of four and skips two. A block that counted
    // only what it applied would round that to "wrote 2 files" and say nothing about
    // the two a person may well have been expecting.
    const cwd = projectRoot();
    let stdout = '';
    const code = await runCli(
      ['hooks', 'install', '--yes', '--harness', 'grok', '--scope', 'user'],
      {
        stdout: (text) => void (stdout += text),
        stderr: () => {},
        stdin: () => '',
        version: '9.9.9-test',
        cwd,
        home: cwd,
      },
    );
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('skipped .grok/hooks.json');
    expect(stdout).toContain('Done. smelt hooks install wrote 2, skipped 2 — 4 files in all.');
  });

  it('a file the user declined is not a file the block says it wrote', async () => {
    // The whole hazard in one run: `smelt init` plans two files, the person says no to
    // the one that already exists, and the closing block is the last thing they read.
    // A block that counted the *plan* would tell them their file was overwritten.
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-done-block-'));
    roots.push(cwd);
    writeFileSync(join(cwd, 'smelt.rerank.ts'), '// hand-written — do not touch\n');
    let output = '';
    await runInit({
      // budget, store=memory, strategy, measure, rerank=module, confirm, decline
      input: scripted(['4000', '1', '1', '1', '2', 'yes', 'no']),
      output: (text) => void (output += text),
      cwd,
    });
    expect(output).toContain('skipped smelt.rerank.ts');
    expect(output).toContain('Done. smelt init wrote 1, skipped 1 — 2 files in all.');
    expect(output).not.toContain('wrote 2 files');
    expect(readFileSync(join(cwd, 'smelt.rerank.ts'), 'utf8')).toBe(
      '// hand-written — do not touch\n',
    );
  });
});

describe('the ASCII fallback reaches the wizards, not just the primitives', () => {
  /**
   * The one non-ASCII character the fallback does **not** remove.
   *
   * Every prose surface in this CLI — the help page, the reports, doctor, every wizard
   * — punctuates with an em dash, and always has. The `unicode` switch is about the
   * characters smelt *draws*: the marks, the rule, the bar, the wordmark. Folding the
   * prose's punctuation as well is a separate job, and a real one; this test states
   * exactly where the line is today rather than pretending it is somewhere else.
   */
  const PROSE_DASH = '—';

  it.each([
    ['setup', ['setup', '--yes', '--harness', 'claude-code']],
    ['hooks install', ['hooks', 'install', '--yes', '--harness', 'claude-code']],
  ])('%s draws nothing above ASCII when the locale never promised it', async (_name, argv) => {
    const cwd = projectRoot();
    let stdout = '';
    const code = await runCli(argv, {
      stdout: (text) => void (stdout += text),
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd,
      home: join(cwd, 'home'),
      unicode: false,
    });
    expect(code).toBe(EXIT.ok);
    // The block, the marks and the rule are all there — in their ASCII spellings.
    expect(stdout).toContain('----');
    expect(stdout).toMatch(/^\s*\+ Done\./mu);
    expect(stdout).not.toContain('━');
    expect(stdout).not.toContain('✓');
    expect(stdout).not.toContain('✗');
    const above = [...new Set([...stdout].filter((ch) => (ch.codePointAt(0) ?? 0) > 127))];
    expect(above, `unexpected non-ASCII: ${JSON.stringify(above)}`).toEqual([PROSE_DASH]);
  });

  it('draws the marks and the rule in Unicode when the locale did promise it', async () => {
    const cwd = projectRoot();
    let stdout = '';
    await runCli(['setup', '--yes', '--harness', 'claude-code'], {
      stdout: (text) => void (stdout += text),
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd,
      home: join(cwd, 'home'),
    });
    expect(stdout).toContain('━━━━');
    expect(stdout).toContain('✓ Done.');
  });
});

describe('everything a newcomer meets fits an 80-column terminal', () => {
  it('keeps the front door and the closing block under 80 columns', () => {
    const lines = [
      ...frontDoor().split('\n'),
      ...doneBlock({
        ok: true,
        what: 'smelt setup',
        summary: 'wrote 4 files; 3 of 3 checks passed',
        next: [
          ['smelt doctor', 'read back what was written, and what is behind'],
          ['smelt <file> --budget 4000', 'smelt one file — the report says what went'],
          ['smelt stats', 'the store, once a run has put something in it'],
        ],
      }).split('\n'),
    ];
    for (const line of lines) {
      // Counted in characters, not bytes: a wrapped line in an 80-column terminal
      // breaks the alignment the block exists to give.
      expect([...line].length, JSON.stringify(line)).toBeLessThan(80);
    }
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

  it('draws nothing rather than throwing when there is no room for a bar', () => {
    // A width computed from a subtraction can reach zero on a narrow terminal, and
    // `String.repeat(-1)` throws — a stats page that crashed instead of printing.
    expect(PLAIN.bar(0.5, 0)).toBe('');
    expect(PLAIN.bar(0.5, -3)).toBe('');
    expect(PLAIN.bar(0, 0)).toBe('');
    expect(palette({ color: true }).bar(0.5, 0)).toBe('');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    // The shape the leak actually had before the palette existed: doctor's sink was
    // `colorize(text, io.color === true && !resolved.json)`, and the whole receipt
    // travels through that one sink. Drop the `--json` exception from the sink and the
    // envelope is painted. (Handing `runDoctor` a painting palette under `--json` is
    // *not* the mutation to write: the receipt never goes through `say`, so nothing
    // happens and the guard is right not to notice.)
    id: 'palette-colour-leaks-into-json',
    file: 'cli/subcommands/doctor.ts',
    find: '        output: (text) => io.stdout(text),',
    replace: "        output: (text) => io.stdout(stdoutPalette(io).paint('dim', text)),",
    why: 'a machine surface carrying paint — an agent parsing `smelt doctor --json` would have to parse around escape sequences, which is the one thing an envelope promises it never has to do',
  },
  {
    kind: 'src',
    id: 'palette-assumes-truecolor',
    file: 'cli/lava.ts',
    find: "  if (depth === 'truecolor') return `\\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;",
    replace: '  return `\\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;',
    why: "truecolor emitted at every depth — the assumption this module shipped with, which renders the front door's gradient as garbage on Terminal.app, on tmux without -2 and on every 16-colour emulator",
  },
  {
    kind: 'src',
    id: 'palette-bar-rounds-a-real-rate-to-nothing',
    file: 'cli/lava.ts',
    find: '  if (cells > 0 && clamped > 0 && filled === 0) filled = 1;',
    replace: '  if (cells > 0 && false) filled = 1;',
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
    // Re-anchored when the boolean switch became a depth: NO_COLOR now answers the
    // first rung of `colorDepth`, and `colorAllowed` is that answer as a boolean.
    find: "  if (no !== undefined && no !== '') return 'none';",
    replace: "  if (false) return 'none';",
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
    id: 'done-block-counts-the-plan-not-the-run',
    file: 'cli/init.ts',
    find: "        applied.push('skipped');",
    replace: "        applied.push('written');",
    why: 'the closing block counting a file the person declined as a file it wrote — the most quietly wrong line a wizard can print, because it is the last one they read and the one they believe',
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
