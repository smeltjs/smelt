import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { EXIT, runCli } from '@guard/cli/run';
import { runSetup } from '@guard/cli/setup';
import { colorize, lavaBanner } from '@guard/cli/lava';

import type { AnswerStream } from '@guard/cli/shell';
import type { GuardMutation } from './_mutations.ts';

/**
 * LAVA RENDERER GUARD — delight that knows where it ends.
 *
 * The wizards' presentation is one adapter behind the output seam (the spike's
 * verdict: clack/ink cannot own the terminal inside the injected-stream loop without
 * taking the wizards' in-process guard-testability with them). This guard holds the
 * adapter to the two properties that make that trade safe:
 *
 *   1. **Off is the identity.** `colorize(_, false)` and an unbannered wizard emit
 *      byte-for-byte what they always have — every existing guard's assertions lean
 *      on that, and so does every pipe an agent reads.
 *   2. **Styled text stays greppable.** ANSI codes wrap whole lines; the substrings
 *      the other guards assert (`wrote …`, `Nothing was written.`) survive inside
 *      the styled line untouched.
 *
 * And the switch itself: `--yes` and `--json` never style, however pretty the
 * terminal — the machine paths' bytes stay plain.
 */

const MIXED = [
  'smelt setup — applying the recipe with --yes:',
  '  wrote CLAUDE.md',
  'note: see packages/mcp/README.md',
  '  ✓ round trip — 6 elisions; 210 bytes retrieved byte-identical',
  '  ✗ config parses — malformed',
  '  ORPHAN: an MCP registration is present but no hooks wiring is',
  'numbers, all, or Enter (Enter for detected)> ',
  'Nothing was written.',
  'Done. `smelt hooks install` edits the hook toggles.',
].join('\n');

function scriptAnswers(lines: readonly string[]): AnswerStream {
  return (async function* (): AsyncGenerator<string> {
    for (const line of lines) yield `${line}\n`;
  })();
}

describe('the lava renderer', () => {
  it('is the identity when off — the property every other guard leans on', () => {
    expect(colorize(MIXED, false)).toBe(MIXED);
    expect(lavaBanner('smelt setup', false)).not.toContain('\x1b[');
  });

  it('wraps whole lines when on — greppable substrings survive the styling', () => {
    const styled = colorize(MIXED, true);
    // The substrings the other guards assert, still contiguous:
    expect(styled).toContain('  wrote CLAUDE.md');
    expect(styled).toContain('Nothing');
    expect(styled).toContain('numbers, all, or Enter');
    // …with the palette on top: green for success, red for failure, amber for notes.
    expect(styled).toContain(`\x1b[32m  ✓ round trip`);
    expect(styled).toContain(`\x1b[31m  ✗ config parses`);
    expect(styled).toContain(`\x1b[31m  ORPHAN`);
    expect(styled).toContain(`\x1b[33mnote: see`);
    expect(styled).toContain(`\x1b[1mnumbers, all, or Enter`);
  });

  it('paints the banner with the lava gradient when on', () => {
    const banner = lavaBanner('smelt setup', true);
    expect(banner).toContain('smelt setup');
    expect(banner).toContain('\x1b[38;2;'); // truecolor stops
    expect(banner).toContain('\x1b[0m'); // and a reset
  });
});

describe('the switch', () => {
  it('--yes and --json emit no styling bytes, however colour-hungry the terminal', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-lava-yes-'));
    try {
      let stdout = '';
      const code = await runCli(['setup', '--yes', '--harness', 'claude-code'], {
        stdout: (text) => void (stdout += text),
        stderr: () => {},
        stdin: () => '',
        version: '9.9.9-test',
        cwd,
        color: true,
      });
      expect(code).toBe(EXIT.ok);
      expect(
        stdout.includes('\x1b['),
        'the --yes path styled its bytes — a machine parsing wizard output must not parse around escape sequences',
      ).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an interactive wizard with colour on renders the banner; without, plain bytes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-lava-wizard-'));
    try {
      const answers = scriptAnswers(['', '', '', '', '', 'yes']);
      let styled = '';
      await runSetup(
        { harnessIds: [], yes: false, noMcp: false, json: false },
        {
          input: answers,
          output: (text) => void (styled += text),
          cwd,
          home: join(cwd, 'no-home'),
          color: true,
        },
      );
      expect(styled).toContain('\x1b[38;2;');

      const answersPlain = scriptAnswers(['', '', '', '', '', 'yes']);
      let plain = '';
      await runSetup(
        { harnessIds: [], yes: false, noMcp: false, json: false },
        {
          input: answersPlain,
          output: (text) => void (plain += text),
          cwd,
          home: join(cwd, 'no-home'),
        },
      );
      expect(plain.includes('\x1b[')).toBe(false);
      // Same words, different paint:
      expect(plain.replace(/\n+/g, '\n')).toContain('one command through the whole recipe');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    id: 'lava-styles-when-switched-off',
    file: 'cli/lava.ts',
    find: '  if (!on) return text;',
    replace: '  if (false) return text;',
    why: 'the renderer styling bytes nobody asked to style — piped output, agents and CI parse wizard output, and an escape sequence in it is a parsed-against-nothing byte',
  },
  {
    kind: 'src',
    // Re-anchored twice: when the banner's bar became the palette's `divider`
    // primitive, and again when the switch it obeys became the terminal's depth
    // rather than a boolean. Same switch, same intent, one seam further in each time.
    id: 'lava-banner-ignores-the-switch',
    file: 'cli/lava.ts',
    find: "  if (depth === 'none') return cell.repeat(cells);",
    replace: '  if (false) return cell.repeat(cells);',
    why: 'the banner rendering its gradient in plain mode — the one place the identity guarantee is most visible, at the very first line a pipe reads',
  },
];
