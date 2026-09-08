import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import process from 'node:process';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { EXIT, runCli } from '@guard/cli/run';
import { runDoctor } from '@guard/cli/doctor';
import type { DoctorReceipt } from '@guard/cli/doctor';
import { SNIPPET_END_MD, SNIPPET_START_MD } from '@guard/harness/snippet';
import { SETUP_RECIPE } from '@guard/setup/recipe';

import type { GuardMutation } from './_mutations.ts';
import { packageRoot } from './_source.ts';

/**
 * DOCTOR GUARD — the update story's first command, and the promises that make it one.
 *
 * Before doctor, only writers touched installed state: an npm update changed the
 * binary and nothing else, and whether the hooks, config and MCP registration on
 * *this* machine still agreed with it was unreadable. Doctor is the reader, and this
 * guard holds it to the reading:
 *
 *   1. a fresh `setup` reports current, exit 0 — the same binary, the same machine;
 *   2. an older binary reading newer state (or a stamped block from an older release)
 *      reports behind, exit 3, with the exact repair command — `smelt setup --harness
 *      <id>` — in both prose and receipt;
 *   3. a block that predates stamping is reported as unversioned *behind*, never as
 *      "not installed" — the ownership token still recognizes it;
 *   4. orphans are named: a registration without wiring, wiring without a config, a
 *      store directory that does not exist;
 *   5. a clean tree reports nothing-installed and exits 0 — nothing to be behind;
 *   6. and doctor never writes: every scenario asserts the tree is byte-identical
 *      after the run.
 *
 * And the promise added when `wired` stopped being a text fact:
 *
 *   7. **a wired hook is *run*, not merely seen.** `wired` used to mean "this file
 *      carries an entry of ours". A shim reached through a symlink, and a Homebrew keg
 *      path the next upgrade deleted, both leave that text exactly as it was while the
 *      guard does nothing — and empty stdout is how every harness schema spells
 *      *allow*, so the transcript looks identical to a working install. Doctor now
 *      runs each command it read and reports `wired (verified)`, `wired but inert` or
 *      `wired but missing`, and a broken one costs `current` and names its repair.
 */

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `smelt-doctor-${label}-`));
}

function doctor(cwd: string, version: string, json = true): { code: number; stdout: string } {
  let stdout = '';
  const code = runDoctor({ json }, { output: (text) => void (stdout += text), cwd, version });
  return { code, stdout };
}

function receiptOf(stdout: string): DoctorReceipt {
  return JSON.parse(stdout) as DoctorReceipt;
}

/** `smelt setup --yes --json --harness claude-code` in `cwd`, stamped as `version`. */
async function setupWith(cwd: string, version: string): Promise<void> {
  let stdout = '';
  const code = await runCli(['setup', '--yes', '--json', '--harness', 'claude-code'], {
    stdout: (text) => void (stdout += text),
    stderr: () => {},
    stdin: () => '',
    version,
    cwd,
  });
  expect(code, `setup failed:\n${stdout}`).toBe(EXIT.ok);
  useBuiltScripts(cwd);
}

/**
 * Re-point every script `setup` just wrote at this package's **built** `dist`.
 *
 * Setup derives those paths from where its own code was loaded from, which under the
 * mutation runner is a scratch copy of `src` with no `dist` beside it — so every probe
 * would answer `missing`, every scenario would go red, and every mutation aimed at this
 * guard would be caught for a reason that has nothing to do with it. The wiring under
 * test is what the file *says*; where the package happens to live is not.
 *
 * `HooksChoices.distDir` is the seam for exactly this, one layer down — but these
 * scenarios drive `runCli(['setup', …])` end to end, and nothing on `SetupOptions`
 * reaches `planInstall`'s choices. So the substitution happens here, on the bytes setup
 * wrote, and the built paths are spelled out rather than derived through
 * `shimScriptPath(profile, distDir)`: a path derived through `@guard/harness/paths` is
 * a path the mutation under test may have changed, which is the dependence this helper
 * exists to remove. If a later PR threads a `distDir` onto `SetupOptions`, this should
 * become an injection instead.
 */
function useBuiltScripts(cwd: string): void {
  const path = join(cwd, '.claude', 'settings.json');
  if (!existsSync(path)) return;
  const settings = JSON.parse(readFileSync(path, 'utf8')) as {
    hooks: Record<string, { hooks?: { command: string }[] }[]>;
  };
  const shim = join(packageRoot(), 'dist', 'hooks', 'shims', 'claude-code.js');
  const bin = join(packageRoot(), 'dist', 'cli', 'bin.js');
  for (const entries of Object.values(settings.hooks)) {
    for (const entry of entries) {
      for (const one of entry.hooks ?? []) {
        one.command = one.command
          .replace(/node "[^"]*hooks\/shims\/claude-code\.js"/u, `node "${shim}"`)
          .replace(/node "[^"]*cli\/bin\.js"/u, `node "${bin}"`);
      }
    }
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

describe('smelt doctor reads installed state back', () => {
  it('a fresh setup is current for the binary that wrote it — exit 0', async () => {
    const cwd = scratch('current');
    try {
      await setupWith(cwd, '0.5.0');
      const before = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
      const { code, stdout } = doctor(cwd, '0.5.0');
      expect(code).toBe(EXIT.ok);
      const receipt = receiptOf(stdout);
      expect(receipt.current).toBe(true);
      expect(receipt.installed).toBe(true);
      const block = receipt.blocks.find((one) => one.file === 'CLAUDE.md');
      expect(block?.installedBy).toBe('0.5.0');
      expect(block?.status).toBe('current');
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe(before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an older binary over newer state reports behind, with the exact repair', async () => {
    const cwd = scratch('behind');
    try {
      await setupWith(cwd, '0.5.0');
      const { code, stdout } = doctor(cwd, '0.4.0');
      expect(code).toBe(EXIT.refused);
      const receipt = receiptOf(stdout);
      expect(receipt.current).toBe(false);
      const block = receipt.blocks.find((one) => one.file === 'CLAUDE.md');
      expect(block?.installedBy).toBe('0.5.0');
      expect(block?.status).toBe('behind');
      expect(receipt.repair).toContain('smelt setup --harness claude-code');
      expect(stdout).toContain('smelt setup --harness claude-code');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a pre-stamping block is recognized as ours and reported behind, not missing', () => {
    const cwd = scratch('legacy');
    try {
      writeFileSync(
        join(cwd, 'CLAUDE.md'),
        `${SNIPPET_START_MD}\n\n## smelt — context discipline\n\nold bytes\n\n${SNIPPET_END_MD}\n`,
      );
      const before = readFileSync(join(cwd, 'CLAUDE.md'), 'utf8');
      const { code, stdout } = doctor(cwd, '9.9.9');
      expect(code).toBe(EXIT.refused);
      const receipt = receiptOf(stdout);
      const block = receipt.blocks.find((one) => one.file === 'CLAUDE.md');
      expect(block?.installedBy).toBeUndefined();
      expect(block?.status).toBe('behind');
      expect(readFileSync(join(cwd, 'CLAUDE.md'), 'utf8')).toBe(before);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('orphans are named: a registration without wiring, a missing store directory', () => {
    const cwd = scratch('orphans');
    try {
      writeFileSync(
        join(cwd, '.mcp.json'),
        `${JSON.stringify({
          mcpServers: {
            smelt: {
              command: SETUP_RECIPE.mcp.run.split(' ')[0],
              args: SETUP_RECIPE.mcp.run.split(' ').slice(1),
            },
          },
        })}\n`,
      );
      const { code, stdout } = doctor(cwd, '9.9.9');
      expect(code).toBe(EXIT.refused);
      const receipt = receiptOf(stdout);
      expect(receipt.orphans.join('\n')).toContain('MCP registration');
      expect(receipt.orphans.join('\n')).toContain('no hooks wiring');
      // Every orphan names its repair — a report that ends without one has not
      // finished its sentence.
      expect(receipt.repair).toContain('smelt setup');

      // And the store-directory orphan, off a real config:
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({
          smeltConfig: 1,
          defaultBudgetBytes: 4000,
          strategy: 'lexical',
          store: { kind: 'directory', path: SETUP_RECIPE.store.defaultDir },
        })}\n`,
      );
      const second = doctor(cwd, '9.9.9');
      const parsed = receiptOf(second.stdout);
      expect(parsed.orphans.join('\n')).toContain('store directory');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a clean tree is nothing-installed, exit 0 — nothing to be behind', () => {
    const cwd = scratch('clean');
    try {
      const { code, stdout } = doctor(cwd, '9.9.9', false);
      expect(code).toBe(EXIT.ok);
      const receipt = receiptOf(doctor(cwd, '9.9.9').stdout);
      expect(receipt.installed).toBe(false);
      expect(receipt.current).toBe(false);
      expect(receipt.repair).toEqual([]);
      expect(stdout).toContain('Nothing of smelt');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('doctor never writes — the tree is byte-identical after every reading', async () => {
    const cwd = scratch('readonly');
    try {
      await setupWith(cwd, '0.5.0');
      const before = new Map(
        ['smelt.config.json', 'CLAUDE.md', '.claude/settings.json', '.mcp.json']
          .filter((name) => existsSync(join(cwd, name)))
          .map((name) => [name, readFileSync(join(cwd, name), 'utf8')]),
      );
      doctor(cwd, '0.5.0');
      doctor(cwd, '0.4.0');
      for (const [name, bytes] of before) {
        expect(readFileSync(join(cwd, name), 'utf8'), name).toBe(bytes);
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

/**
 * The guard command a settings file carries, replaced with one naming `script`. The
 * entry stays recognisably ours — a shim path is a shim path whether or not the file
 * behind it exists — which is the whole point: the *text* cannot tell you.
 */
function pointGuardAt(cwd: string, script: string): void {
  const path = join(cwd, '.claude', 'settings.json');
  const settings = JSON.parse(readFileSync(path, 'utf8')) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  for (const entry of settings.hooks['PreToolUse'] ?? []) {
    for (const one of entry.hooks) one.command = `node "${script}"`;
  }
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

describe('a wired hook is one that runs', () => {
  it('the shim setup wrote fires — `wired (verified)`, and the receipt says which', async () => {
    const cwd = scratch('verified');
    try {
      await setupWith(cwd, '0.5.0');
      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.ok);
      expect(stdout).toContain('.claude/settings.json: wired (verified)');

      const receipt = receiptOf(doctor(cwd, '0.5.0').stdout);
      const file = receipt.hooks?.find((one) => one.file === '.claude/settings.json');
      expect(file?.harness).toBe('claude-code');
      const guard = file?.entries.find((entry) => entry.kind === 'guard');
      expect(guard?.probe.status, guard?.probe.detail).toBe('fires');
      expect(guard?.script).toContain('hooks/shims/claude-code.js');
      // Additive, never a rename: everything the receipt carried, it still carries.
      expect(receipt.hookFiles).toContain('.claude/settings.json');
      expect(receipt.format).toBe('smelt.doctor.v1');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a settings file pointing at a deleted script is `wired but missing`, not wired', async () => {
    const cwd = scratch('missing');
    try {
      await setupWith(cwd, '0.5.0');
      // What `brew upgrade` leaves behind: the entry is untouched, the keg is gone.
      const gone = join(
        cwd,
        'Cellar',
        'smelt',
        '0.5.0',
        'dist',
        'hooks',
        'shims',
        'claude-code.js',
      );
      pointGuardAt(cwd, gone);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.claude/settings.json: wired but missing');
      expect(stdout).toContain(gone);
      expect(stdout).toContain('smelt setup --harness claude-code');

      const receipt = receiptOf(doctor(cwd, '0.5.0').stdout);
      expect(receipt.current).toBe(false);
      expect(receipt.repair).toContain('smelt setup --harness claude-code');
      const guard = receipt.hooks?.[0]?.entries.find((entry) => entry.kind === 'guard');
      expect(guard?.probe.status).toBe('missing');
      expect(guard?.probe.detail).toContain('does not exist');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('a shim that runs and says nothing is `wired but inert` — empty stdout is an allow', async () => {
    const cwd = scratch('inert');
    try {
      await setupWith(cwd, '0.5.0');
      const stub = join(cwd, 'hooks', 'shims', 'claude-code.js');
      mkdirSync(join(cwd, 'hooks', 'shims'), { recursive: true });
      // Exactly what the symlink defect produced: exit 0, no output, no guard.
      writeFileSync(stub, 'process.exit(0);\n');
      pointGuardAt(cwd, stub);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.claude/settings.json: wired but inert');
      expect(stdout).toContain('empty stdout is an allow');
      expect(stdout).toContain('smelt setup --harness claude-code');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('the installed binary answers doctor', () => {
  it('`smelt doctor --json` over piped stdin parses as a receipt', () => {
    // Only a real process proves the read-only verb needs no wizard stream — piped
    // stdin that would starve a wizard is exactly what doctor must not care about.
    const bin = join(import.meta.dirname, '../../dist/cli/bin.js');
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-doctor-bin-'));
    try {
      writeFileSync(
        join(cwd, 'CLAUDE.md'),
        `${SNIPPET_START_MD}\n<!-- smelt:hooks written-by @smeltjs/core 0.0.1 -->\n\nold\n\n${SNIPPET_END_MD}\n`,
      );
      const run = spawnSync(process.execPath, [bin, 'doctor', '--json'], {
        encoding: 'utf8',
        cwd,
      });
      expect(run.status, `bin doctor failed:\n${run.stderr}`).toBe(EXIT.refused);
      const receipt = JSON.parse(run.stdout) as DoctorReceipt;
      expect(receipt.format).toBe('smelt.doctor.v1');
      expect(receipt.blocks[0]?.status).toBe('behind');
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
    id: 'doctor-probe-result-ignored',
    file: 'cli/doctor.ts',
    find: "  if (file === undefined || file.entries.length === 0) return 'wired';",
    replace: "  if (file !== undefined) return 'wired (verified)';",
    why: 'doctor reporting `wired (verified)` whatever the probe answered \u2014 which is exactly the old `wired`, the text fact that reads identically for a working install and for a shim that exits 0 with empty stdout',
  },
  {
    kind: 'src',
    id: 'doctor-version-comparison-flipped',
    file: 'cli/doctor.ts',
    find: "? 'current' : 'behind';",
    replace: "? 'behind' : 'current';",
    why: 'current and behind trading places — the verdict the exit code carries would tell an upgraded machine it is current and a current machine it needs repair',
  },
  {
    kind: 'src',
    id: 'doctor-stops-seeing-the-stamp',
    file: 'harness/snippet.ts',
    find: '${stamp}',
    replace: '',
    why: 'the installer stops writing the version stamp — every block would read as pre-stamping, and the behind detection this whole slice exists for goes quiet forever',
  },
  {
    kind: 'src',
    id: 'doctor-misreads-a-stamped-block',
    file: 'harness/snippet.ts',
    find: '/<!-- smelt:hooks written-by @smeltjs\\/core (\\d+\\.\\d+\\.\\d+)(?:[-+][^>]*)? -->/u',
    replace: '/<!-- never-matches -->/u',
    why: 'the reader forgetting the writer\u2019s format — write and read are two ends of one fact, and a reader that matches nothing reports every stamped block as unversioned',
  },
];
