import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { EXIT, runCli } from '@guard/cli/run';
import type { SetupReceipt } from '@guard/cli/setup';

import type { GuardMutation } from './_mutations.ts';

/**
 * HOOKS-YES GUARD — one merge policy behind both install verbs, and the three ways it
 * can quietly stop being one.
 *
 * `smelt hooks install --yes` and `smelt setup` write into *other tools'* config
 * files with nobody to ask. That is only safe because of a property, not a habit:
 * every file either has a byte-faithful merge behind it — the planned content was
 * computed *from* the existing bytes, so every foreign byte is already in it — or is
 * a file smelt writes whole, which is refused unless it is already smelt's. Break
 * either half and the failure is somebody's `.claude/settings.json`, on the day they
 * upgrade, with a receipt saying it went fine.
 *
 *   1. **A merge keeps every foreign entry.** The fixture below carries hook entries
 *      that are not smelt's under two managed events, plus indentation, key order and
 *      a number spelling `JSON.stringify` would rewrite. After `--yes` they are all
 *      still there.
 *   2. **`--yes` merges rather than skipping.** Skipping *looks* safe — it is what
 *      setup used to do — and it means the one command an agent can drive cannot
 *      finish the install it started, silently, with exit 0.
 *   3. **`smelt.config.json` is written once.** Setup renders it and the installer's
 *      plan re-renders the same file; reporting both made a fresh `--json` run name
 *      one file twice, once `written` and once `updated: repaired`. A receipt that
 *      double-counts is a receipt an agent cannot reconcile against the disk.
 *
 * Everything here runs through `runCli`, because the flags are the interface being
 * guarded: a policy that is right in `planInstall` and unreachable from argv is not
 * a policy anybody gets.
 */

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-yes-'));
  // A temp home, never the developer's own: `--yes` resolves harness detection and
  // (at user scope) every write against it.
  home = mkdtempSync(join(tmpdir(), 'smelt-yes-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * Somebody else's `.claude/settings.json`: two managed events already carrying hooks
 * that are not smelt's, four-space indentation, and `1e3` — a number spelling a
 * re-serialization would turn into `1000`.
 */
const FOREIGN_SETTINGS =
  '{\n' +
  '    "permissions": {\n' +
  '        "allow": ["Bash(ls:*)"]\n' +
  '    },\n' +
  '    "hooks": {\n' +
  '        "PreToolUse": [\n' +
  '            { "matcher": "Write", "hooks": [{ "type": "command", "command": "echo mine" }] }\n' +
  '        ],\n' +
  '        "Stop": [{ "hooks": [{ "type": "command", "command": "echo bye" }] }]\n' +
  '    },\n' +
  '    "num": 1e3\n' +
  '}\n';

/** The exact bytes outside the `hooks` property that a merge may not touch. */
const UNTOUCHABLE = [
  '    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    },',
  '    "num": 1e3\n',
];

function writeForeignSettings(): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude/settings.json'), FOREIGN_SETTINGS);
}

function settingsText(): string {
  return readFileSync(join(dir, '.claude/settings.json'), 'utf8');
}

/** Every command under one event, ours and theirs alike. */
function commandsUnder(event: string): readonly string[] {
  const settings = JSON.parse(settingsText()) as {
    hooks?: Record<string, { hooks?: { command?: string }[] }[]>;
  };
  return (settings.hooks?.[event] ?? []).flatMap((entry) =>
    (entry.hooks ?? []).map((hook) => hook.command ?? ''),
  );
}

async function cli(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    stdin: () => '',
    version: '9.9.9-test',
    cwd: dir,
    home,
  });
  return { code, stdout };
}

describe("`hooks install --yes` merges into somebody else's settings file", () => {
  it('keeps every foreign entry and every byte outside the hooks key, and wires ours', async () => {
    writeForeignSettings();

    const { code, stdout } = await cli(['hooks', 'install', '--yes', '--harness', 'claude-code']);
    expect(code, stdout).toBe(EXIT.ok);

    // Outside `hooks`, the file is byte-identical: an installer that reformats a
    // settings file has edited what it was never asked to.
    const written = settingsText();
    for (const bytes of UNTOUCHABLE) expect(written, bytes).toContain(bytes);

    // Inside it, the entries that were not ours are still exactly what they were.
    expect(commandsUnder('PreToolUse')).toContain('echo mine');
    expect(commandsUnder('Stop')).toContain('echo bye');

    // And ours are there: the guard shim under each matcher claude-code declares.
    const shims = commandsUnder('PreToolUse').filter((command) =>
      command.includes('hooks/shims/claude-code.js'),
    );
    expect(shims.length, written).toBeGreaterThan(0);
    expect(commandsUnder('Stop').some((command) => command.includes('# smelt:hooks'))).toBe(true);
  });

  it('is idempotent: a second --yes run leaves the same bytes', async () => {
    writeForeignSettings();
    await cli(['hooks', 'install', '--yes', '--harness', 'claude-code']);
    const first = settingsText();
    const { code } = await cli(['hooks', 'install', '--yes', '--harness', 'claude-code']);
    expect(code).toBe(EXIT.ok);
    expect(settingsText()).toBe(first);
  });

  it('--guard off takes ours back out and leaves theirs alone', async () => {
    writeForeignSettings();
    await cli(['hooks', 'install', '--yes', '--harness', 'claude-code']);
    const { code } = await cli([
      'hooks',
      'install',
      '--yes',
      '--harness',
      'claude-code',
      '--guard',
      'off',
    ]);
    expect(code).toBe(EXIT.ok);
    expect(
      commandsUnder('PreToolUse').filter((command) => command.includes('hooks/shims/')),
    ).toEqual([]);
    expect(commandsUnder('PreToolUse')).toContain('echo mine');
    expect(commandsUnder('Stop')).toContain('echo bye');
  });

  it('refuses with the flag that answers it when there is nothing to detect', async () => {
    let stderr = '';
    const code = await runCli(['hooks', 'install', '--yes'], {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      home,
    });
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('--harness');
    expect(stderr).toContain('claude-code');
  });
});

describe('`smelt setup --yes` applies the same policy', () => {
  it('merges into the same fixture rather than skipping it', async () => {
    writeForeignSettings();

    let stdout = '';
    const code = await runCli(['setup', '--yes', '--json', '--harness', 'claude-code'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      home,
    });
    expect(code, stdout).toBe(EXIT.ok);
    const receipt = JSON.parse(stdout) as SetupReceipt;

    expect(
      commandsUnder('PreToolUse').some((command) => command.includes('hooks/shims/')),
      stdout,
    ).toBe(true);
    expect(commandsUnder('PreToolUse')).toContain('echo mine');
    for (const bytes of UNTOUCHABLE) expect(settingsText(), bytes).toContain(bytes);

    const settings = receipt.files.find((file) => file.name === '.claude/settings.json');
    expect(settings?.action, JSON.stringify(receipt.files)).toBe('written');
  });

  it('names smelt.config.json exactly once, and the receipt agrees with itself', async () => {
    let stdout = '';
    const code = await runCli(['setup', '--yes', '--json', '--harness', 'claude-code'], {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      home,
    });
    expect(code, stdout).toBe(EXIT.ok);
    const receipt = JSON.parse(stdout) as SetupReceipt;

    const configs = receipt.files.filter((file) => file.name === 'smelt.config.json');
    expect(configs.length, JSON.stringify(receipt.files)).toBe(1);
    // `config.action` and the files list are two statements about one file, and a
    // reader that reconciles them must not find them contradicting each other.
    expect(configs[0]!.action).toBe(receipt.config.action === 'current' ? 'unchanged' : 'written');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    id: 'yes-overwrites-foreign-entry',
    file: 'cli/hooks.ts',
    find: '    const foreign = existing.filter((entry) => !isOursEntry(entry));',
    replace: '    const foreign: unknown[] = [];',
    why: "the merge dropping every entry that is not smelt's — a non-interactive install would delete the hooks somebody else's tool wired, under a managed event, with the receipt reporting a clean write",
  },
  {
    kind: 'src',
    id: 'yes-skips-existing',
    file: 'cli/hooks.ts',
    find: "  if (file.ownership === 'merged') return true;",
    replace: "  if (file.ownership === 'merged') return false;",
    why: 'the merge policy refusing every existing file instead of merging it — the safe-looking break: `--yes` exits 0 having written nothing into the file that matters, so the one command an agent can drive cannot finish the install it started',
  },
  {
    kind: 'src',
    id: 'config-written-twice',
    file: 'cli/setup.ts',
    find:
      '      // The config was written above, from the same choices this plan was built\n' +
      "      // from. Reporting the plan's entry for it too would name one file twice.\n" +
      '      plan.files.filter((file) => basename(file.path) !== CONFIG_FILE_NAME),',
    replace: '      plan.files,',
    why: 'setup reporting smelt.config.json twice — once as its own write and again as the installer plan repairing it — which is a receipt an agent cannot reconcile against the disk it just read',
  },
];
