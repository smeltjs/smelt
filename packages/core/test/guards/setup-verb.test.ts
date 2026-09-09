import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { EXIT, runCli } from '@guard/cli/run';
import { parseConfig } from '@guard/cli/config';
import { runSetup } from '@guard/cli/setup';
import type { SetupReceipt } from '@guard/cli/setup';
import type { AnswerStream } from '@guard/cli/shell';
import { SETUP_RECIPE } from '@guard/setup/recipe';

import type { GuardMutation } from './_mutations.ts';

/**
 * SETUP-VERB GUARD — the one-command recipe, and the promises it makes.
 *
 * `smelt setup` exists so that "set smelt up" is one command a human types once and
 * an agent can drive blind. That promise is only as good as its least honest branch,
 * so this guard holds each one:
 *
 *   1. `--yes --json` on a clean directory applies the whole recipe with zero prompts
 *      — config (the recipe's budget and a directory store), the hooks preset for the
 *      named harness, the manual MCP step handed over as the exact command — and the
 *      receipt names every file and every check.
 *   2. a re-run on a current machine is a byte-neutral no-op: `unchanged` everywhere,
 *      exit 0. Setup that rewrites what it already wrote is a setup that cannot be
 *      used to *update* a machine.
 *   3. the hard rule survives `--yes`: an existing file that is not smelt's config is
 *      never written — skipped, with the receipt saying so.
 *   4. a config that already carries choices keeps them: an explicit memory store and
 *      an explicit budget are the user's, not gaps for the recipe to fill.
 *   5. the refusals are the agent-facing interface: no stream without `--yes` names
 *      the flags; `--json` without `--yes` is refused; an unknown harness is refused
 *      with the known list.
 *   6. the interactive wizard, fed a scripted stream, completes with Enter alone
 *      except the final confirm — that is the whole point of defaults.
 */

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `smelt-setup-${label}-`));
}

function scriptAnswers(lines: readonly string[]): AnswerStream {
  // Chunks of stream text, not pre-split lines: answerReader splits on '\n', so an
  // answer is its line *and* its terminator — Enter is a bare '\n'.
  return (async function* (): AsyncGenerator<string> {
    for (const line of lines) yield `${line}\n`;
  })();
}

async function runYes(cwd: string, argv: readonly string[] = []): Promise<SetupReceipt> {
  let stdout = '';
  const code = await runCli(['setup', '--yes', '--json', ...argv], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    stdin: () => '',
    version: '9.9.9-test',
    cwd,
  });
  expect(code, `setup --yes --json exited ${String(code)}:\n${stdout}`).toBe(EXIT.ok);
  return JSON.parse(stdout) as SetupReceipt;
}

/** `smelt setup --yes --json --harness claude-code` in `cwd`, stamped as `version`. */
async function setupWith(cwd: string, version: string): Promise<void> {
  let stdout = '';
  const code = await runCli(['setup', '--yes', '--json', '--harness', 'claude-code'], {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    stdin: () => '',
    version,
    cwd,
  });
  expect(code, `setup failed:\n${stdout}`).toBe(EXIT.ok);
}

async function usageErrorFor(argv: readonly string[]): Promise<string> {
  let stderr = '';
  const code = await runCli(argv, {
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
    stdin: () => '',
    version: '9.9.9-test',
  });
  expect(code).toBe(EXIT.usage);
  return stderr;
}

describe('smelt setup applies the recipe in one command', () => {
  it('runs clean-room with zero prompts, and the receipt names everything', async () => {
    const cwd = scratch('clean');
    try {
      const receipt = await runYes(cwd, ['--harness', 'claude-code']);

      // The config: the recipe's budget, a directory store at the recipe's path,
      // the strategy default — all parsed back out of the file on disk.
      const config = parseConfig(
        readFileSync(join(cwd, 'smelt.config.json'), 'utf8'),
        join(cwd, 'smelt.config.json'),
      );
      expect(config.defaultBudgetBytes).toBe(SETUP_RECIPE.recommendedBudgetBytes);
      expect(config.store).toEqual({
        kind: 'directory',
        path: SETUP_RECIPE.store.defaultDir,
      });
      expect(config.strategy).toBeTruthy();

      // The hooks preset: an instruction file carrying the ownership marker, and at
      // least one JSON hooks file — written, and named in the receipt.
      const written = receipt.files.filter((file) => file.action === 'written');
      expect(written.map((file) => file.name)).toContain('smelt.config.json');
      const instruction = written.find((file) => file.name.includes('CLAUDE.md'));
      expect(instruction, `no instruction file written: ${JSON.stringify(written)}`).toBeDefined();
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toContain('smelt:hooks');

      // The MCP step: claude-code's profile carries the registration, so it is
      // applied to `.mcp.json` — byte-faithfully, with the recipe's own command.
      expect(receipt.mcp.status).toBe('applied');
      expect(receipt.mcp.command).toBe(SETUP_RECIPE.mcp.register);
      const mcpConfig = JSON.parse(readFileSync(join(cwd, '.mcp.json'), 'utf8')) as {
        mcpServers: { smelt: { command: string; args: readonly string[] } };
      };
      expect(mcpConfig.mcpServers.smelt).toEqual({
        command: SETUP_RECIPE.mcp.run.split(' ')[0],
        args: SETUP_RECIPE.mcp.run.split(' ').slice(1),
      });

      // The checks passed — the round trip is the one that makes "set up" true.
      expect(receipt.checks.length).toBeGreaterThan(0);
      for (const check of receipt.checks) {
        expect(`${check.name}: ${check.detail} (${String(check.ok)})`, check.name).toBe(
          `${check.name}: ${check.detail} (true)`,
        );
      }
      expect(receipt.format).toBe('smelt.setup.v1');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('the MCP step is the one the chosen harness actually reads', async () => {
    const cwd = scratch('mcp-per-harness');
    try {
      const receipt = await runYes(cwd, ['--harness', 'codex']);

      // Codex's registration is a TOML table in its own config file, and setup wrote
      // it. The receipt used to hand back Claude Code's CLI verb for every harness —
      // a command about a file Codex does not read, run by a binary the user may not
      // have. What it names now is what was written, in the words Codex's own docs use.
      expect(receipt.mcp.status).toBe('applied');
      expect(receipt.mcp.command).toContain('[mcp_servers.smelt]');
      expect(receipt.mcp.command).toContain('.codex/config.toml');
      expect(
        receipt.mcp.command,
        'the recipe’s Claude Code command, printed at somebody wiring Codex',
      ).not.toContain('claude mcp add');
      expect(readFileSync(join(cwd, '.codex', 'config.toml'), 'utf8')).toContain(
        '[mcp_servers.smelt]',
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('re-runs a current machine as a byte-neutral no-op', async () => {
    const cwd = scratch('idempotent');
    try {
      await runYes(cwd, ['--harness', 'codex']);
      const configBefore = readFileSync(join(cwd, 'smelt.config.json'), 'utf8');
      const agentsBefore = existsSync(join(cwd, 'AGENTS.md'))
        ? readFileSync(join(cwd, 'AGENTS.md'), 'utf8')
        : undefined;

      let stdout = '';
      const code = await runCli(['setup', '--yes', '--json', '--harness', 'codex'], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        stdin: () => '',
        version: '9.9.9-test',
        cwd,
      });
      expect(code).toBe(EXIT.ok);
      const receipt = JSON.parse(stdout) as SetupReceipt;

      expect(receipt.config.action).toBe('current');
      for (const file of receipt.files) {
        expect(file.action, `${file.name} was touched by a re-run: ${file.action}`).toBe(
          'unchanged',
        );
      }
      expect(readFileSync(join(cwd, 'smelt.config.json'), 'utf8')).toBe(configBefore);
      if (agentsBefore !== undefined) {
        expect(readFileSync(join(cwd, 'AGENTS.md'), 'utf8')).toBe(agentsBefore);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('repairs what doctor names behind — the update loop closes', async () => {
    const cwd = scratch('repair');
    try {
      await setupWith(cwd, '1.0.0');
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toContain(
        'written-by @smeltjs/core 1.0.0',
      );

      // A newer binary re-runs setup: our own blocks are repaired, not skipped —
      // doctor said behind, and setup is the repair it named.
      let stdout = '';
      const code = await runCli(['setup', '--yes', '--json', '--harness', 'claude-code'], {
        stdout: (text) => {
          stdout += text;
        },
        stderr: () => {},
        stdin: () => '',
        version: '2.0.0',
        cwd,
      });
      expect(code, `repair run failed:\n${stdout}`).toBe(EXIT.ok);
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toContain(
        'written-by @smeltjs/core 2.0.0',
      );

      // And the loop closes: doctor on the new binary says current, exit 0.
      let doctorOut = '';
      const doctorCode = await runCli(['doctor', '--json'], {
        stdout: (text) => {
          doctorOut += text;
        },
        stderr: () => {},
        stdin: () => '',
        version: '2.0.0',
        cwd,
      });
      expect(doctorCode).toBe(EXIT.ok);
      expect((JSON.parse(doctorOut) as { current: boolean }).current).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('merges into an existing file, and refuses the one it would have to write whole', async () => {
    const cwd = scratch('protect');
    try {
      const theirs = '# My house rules — smelt must not lose a byte of this.\n';
      const { mkdirSync, writeFileSync } = await import('node:fs');
      writeFileSync(join(cwd, 'CLAUDE.md'), theirs);
      // A file smelt writes *whole*, sitting there with somebody else's bytes in it.
      mkdirSync(join(cwd, '.opencode/plugin'), { recursive: true });
      const plugin = join(cwd, '.opencode/plugin/smelt-guard.js');
      const notOurs = 'export const theirs = true;\n';
      writeFileSync(plugin, notOurs);

      const receipt = await runYes(cwd, ['--harness', 'claude-code', '--harness', 'opencode']);

      // A marker-block file is *merged*: their bytes are all still there, and so is
      // our block. `--yes` used to skip this file and point at a wizard, which meant
      // the one command an agent can drive could not finish the install it started.
      const claudeMd = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
      expect(claudeMd).toContain(theirs.trim());
      expect(claudeMd).toContain('smelt:hooks');
      const merged = receipt.files.find((file) => file.name === 'CLAUDE.md');
      expect(merged?.action).toBe('written');
      // The receipt says only what the editor can deliver. It used to claim "every
      // byte outside smelt's own entries is unchanged", which a JSON hooks merge does
      // not give: it re-serialises the `hooks` value, so a foreign entry inside it
      // keeps its content and loses its formatting. The claim is about entries.
      expect(merged?.detail).toContain("every entry that is not smelt's is preserved");
      expect(merged?.detail).not.toContain("every byte outside smelt's own entries");

      // A whole-owned file has nothing to merge into, so it is refused — untouched,
      // reported skipped, with a reason that names it.
      expect(readFileSync(plugin, 'utf8')).toBe(notOurs);
      const skipped = receipt.files.find((file) => file.name.endsWith('smelt-guard.js'));
      expect(skipped?.action).toBe('skipped');
      expect(skipped?.detail).toContain('smelt-guard.js');
      expect(skipped?.detail).toContain('hooks install');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('repairs a whole-owned file that is already its own', async () => {
    const cwd = scratch('repair-whole');
    try {
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(cwd, '.opencode/plugin'), { recursive: true });
      const plugin = join(cwd, '.opencode/plugin/smelt-guard.js');
      // Ours — it carries the ownership token — but stale: an older release's bytes.
      writeFileSync(plugin, '// smelt:hooks — written by an older release\n');

      const receipt = await runYes(cwd, ['--harness', 'opencode']);

      expect(readFileSync(plugin, 'utf8')).toContain('tool.execute.before');
      const repaired = receipt.files.find((file) => file.name.endsWith('smelt-guard.js'));
      expect(repaired?.action).toBe('written');
      // A file rewritten whole cannot claim bytes outside the edit survived — there
      // was no edit, and there is nothing outside it. What is true is that all of
      // those bytes were smelt's.
      expect(repaired?.detail).toBe("repaired — only smelt's own entries in it changed");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('respects a config that already carries a budget and a store', async () => {
    const cwd = scratch('respect');
    try {
      const { writeFileSync } = await import('node:fs');
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify(
          {
            smeltConfig: 1,
            defaultBudgetBytes: 1234,
            store: { kind: 'memory' },
          },
          null,
          2,
        )}\n`,
      );

      const receipt = await runYes(cwd);

      const config = parseConfig(
        readFileSync(join(cwd, 'smelt.config.json'), 'utf8'),
        join(cwd, 'smelt.config.json'),
      );
      expect(config.defaultBudgetBytes).toBe(1234);
      expect(config.store).toEqual({ kind: 'memory' });
      // The recipe's budget was printed as the default, but the user's number is
      // the user's: the config was either current or updated without this field.
      expect(receipt.config.action === 'current' || receipt.config.action === 'updated').toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('the refusals are the agent-facing interface', () => {
  it('a bare setup with no interactive stream names the flags that answer it', async () => {
    const stderr = await usageErrorFor(['setup']);
    expect(stderr).toContain('--yes');
    expect(stderr).toContain('--harness');
    expect(stderr).toContain('--json');
  });

  it('--json without --yes is refused: a receipt for a conversation nobody can read', async () => {
    const stderr = await usageErrorFor(['setup', '--json']);
    expect(stderr).toContain('--yes');
  });

  it('an unknown harness is refused with the known list', async () => {
    const stderr = await usageErrorFor(['setup', '--yes', '--harness', 'nope']);
    expect(stderr).toContain('unknown harness "nope"');
    expect(stderr).toContain('claude-code');
  });

  it('setup refuses foreign flags by the generated message, like every verb', async () => {
    const stderr = await usageErrorFor(['setup', '--budget', '4000']);
    expect(stderr).toContain('--budget');
    expect(stderr).toContain('setup');
  });
});

describe('the interactive wizard completes on Enter alone', () => {
  it('defaults through every question, then writes on confirm', async () => {
    const cwd = scratch('wizard');
    try {
      // Enter for harnesses (none detected in a scratch home), Enter for the budget,
      // Enter twice for the store (kind, then path), Enter for MCP, then yes.
      let stdout = '';
      const code = await runSetup(
        {
          harnessIds: [],
          yes: false,
          noMcp: false,
          json: false,
        },
        {
          input: scriptAnswers(['', '', '', '', '', 'yes']),
          output: (text) => {
            stdout += text;
          },
          cwd,
          home: join(cwd, 'no-home'),
        },
      );
      expect(code, `wizard exited ${String(code)}:\n${stdout}`).toBe(EXIT.ok);
      // The questions arrive in order — the store question before the MCP one. The
      // first version of this wizard launched a step without awaiting it and the
      // two prompts raced; scripted Enters masked it, a human would not.
      expect(stdout.indexOf('store (1 memory')).toBeLessThan(
        stdout.indexOf('register the MCP server'),
      );
      expect(stdout).toContain('Nothing has been written yet.'); // the confirm listing
      expect(existsSync(join(cwd, 'smelt.config.json'))).toBe(true);
      const config = parseConfig(
        readFileSync(join(cwd, 'smelt.config.json'), 'utf8'),
        join(cwd, 'smelt.config.json'),
      );
      expect(config.defaultBudgetBytes).toBe(SETUP_RECIPE.recommendedBudgetBytes);
      expect(config.store).toEqual({ kind: 'directory', path: SETUP_RECIPE.store.defaultDir });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('back is real back: budget returns to the harness question', async () => {
    const cwd = scratch('backnav');
    try {
      let stdout = '';
      const code = await runSetup(
        { harnessIds: [], yes: false, noMcp: false, json: false },
        {
          input: scriptAnswers(['', 'back', '', '', '', '', '', 'yes']),
          output: (text) => {
            stdout += text;
          },
          cwd,
          home: join(cwd, 'no-home'),
        },
      );
      expect(code, `wizard exited ${String(code)}:\n${stdout}`).toBe(EXIT.ok);
      // The harness question was asked twice — the first pass, then again after
      // budget's back. The wizard kit's step machine is what makes back real;
      // the first version of this wizard had no back at all.
      expect(stdout.split("numbers, 'all', or Enter").length - 1).toBe(2);
      expect(existsSync(join(cwd, 'smelt.config.json'))).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a declined confirm writes nothing', async () => {
    const cwd = scratch('declined');
    try {
      let stdout = '';
      const code = await runSetup(
        { harnessIds: [], yes: false, noMcp: false, json: false },
        {
          input: scriptAnswers(['', '', '', '', '', 'no']),
          output: (text) => {
            stdout += text;
          },
          cwd,
          home: join(cwd, 'no-home'),
        },
      );
      expect(code).toBe(EXIT.ok);
      expect(stdout).toContain('Nothing was written.');
      expect(existsSync(join(cwd, 'smelt.config.json'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('the installed binary drives setup end to end', () => {
  it('the built CLI answers --help, refuses EOF with a usage exit, and applies --yes --json for real', () => {
    // Only a real process proves the bin wires the wizard stream for the new verb
    // without flipping fd 0 into non-blocking mode for everyone else — and that the
    // agent path (piped stdin, everything answered by flags) works past the parse.
    const bin = join(import.meta.dirname, '../../dist/cli/bin.js');

    const help = spawnSync(process.execPath, [bin, 'setup', '--help'], {
      encoding: 'utf8',
      cwd: tmpdir(),
    });
    expect(help.status).toBe(EXIT.ok);
    expect(help.stdout).toContain('SETUP');

    const eof = spawnSync(process.execPath, [bin, 'setup'], {
      encoding: 'utf8',
      cwd: tmpdir(),
    });
    expect(eof.status).toBe(EXIT.usage);
    expect(eof.stderr).toContain('input ended');
    expect(eof.stderr).toContain('--yes');

    const cwd = mkdtempSync(join(tmpdir(), 'smelt-setup-bin-'));
    try {
      const applied = spawnSync(
        process.execPath,
        [bin, 'setup', '--yes', '--json', '--harness', 'claude-code'],
        { encoding: 'utf8', cwd },
      );
      expect(applied.status, `bin setup failed:\n${applied.stdout}\n${applied.stderr}`).toBe(
        EXIT.ok,
      );
      const receipt = JSON.parse(applied.stdout) as SetupReceipt;
      expect(receipt.format).toBe('smelt.setup.v1');
      expect(receipt.checks.every((check) => check.ok)).toBe(true);
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
    id: 'setup-invents-its-own-budget',
    file: 'cli/setup.ts',
    find: 'budgetBytes: SETUP_RECIPE.recommendedBudgetBytes,',
    replace: 'budgetBytes: 4096,',
    why: 'the --yes path quietly writing a budget nobody chose — the recipe is the one place the recommended number lives, and a second literal here drifts from it the way the store default did',
  },
  {
    kind: 'src',
    id: 'setup-rewrites-a-current-config',
    file: 'cli/setup.ts',
    find: '} else if (before !== rendered) {',
    replace: '} else if (true) {',
    why: 'setup that rewrites what it already wrote cannot be the update story — a second run must be a byte-neutral no-op, or the other-machine flow upgrades by rewriting a file that was already right',
  },
  {
    kind: 'src',
    id: 'wizard-back-advances-instead',
    file: 'cli/wizard.ts',
    find: 'else index -= 1;',
    replace: 'else index += 1;',
    why: 'the step machine’s back moving forward — a wizard that eats the answer instead of returning for it is the defect the kit itself was extracted to end',
  },
  {
    kind: 'src',
    id: 'setup-writes-a-whole-file-that-is-not-ours',
    file: 'cli/merge-policy.ts',
    find: '  return fileIsOursToRepair(file);',
    replace: '  return true;',
    why: "the merge policy's one refusal wired shut — a run with nobody to ask would write smelt's own bytes over a file it does not own and cannot merge into (somebody's opencode plugin, Cline's hook wrapper), which is the single act the whole policy exists to prevent",
  },
  {
    kind: 'src',
    id: 'setup-stops-repairing-its-own-blocks',
    file: 'cli/merge-policy.ts',
    find: "  return fileIsOurs(file.name, readFileSync(file.path, 'utf8'));",
    replace: '  return false;',
    why: 'setup treating its own instruction blocks as foreign — doctor would name them behind forever and the repair it names would skip them, the update loop this whole arc exists to close, quietly not closing',
  },
  {
    kind: 'src',
    id: 'setup-claims-to-skip-while-touched',
    file: 'cli/merge-policy.ts',
    find: "        action: 'skipped',",
    replace: "        action: 'written',",
    why: 'the receipt claiming a skipped file was written — the receipt is what an agent reads to verify the run, and a receipt that lies is worse than no receipt',
  },
  {
    kind: 'src',
    id: 'setup-prints-one-harness-command-for-all',
    file: 'cli/setup.ts',
    find: "  return scope === 'user' ? (manual.manualUser ?? manual.manual) : manual.manual;",
    replace: '  return SETUP_RECIPE.mcp.register;',
    why: 'the MCP step read off the recipe again instead of off the harness that carries it — somebody wiring Codex or Grok is told to run a `claude` CLI verb against a file their harness never reads, which is the defect the per-harness fact exists to end',
  },
  {
    kind: 'src',
    id: 'setup-claims-applied-when-manual',
    file: 'cli/setup.ts',
    find: "    return {\n      mcp: { status: 'applied', command: mcpManual(applied, choices.scope) },\n      fromProfile: false,\n    };",
    replace:
      "    return {\n      mcp: { status: 'manual', command: mcpManual(applied, choices.scope) },\n      fromProfile: false,\n    };",
    why: 'the receipt calling an applied registration manual — the agent reading --json would re-register by hand what setup already wrote, and the receipt would be wrong in the direction that costs work',
  },
];
