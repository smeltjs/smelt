import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { DirectoryElisionStore } from '@guard/store-dir';

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

function doctor(
  cwd: string,
  version: string,
  json = true,
  env: Readonly<Record<string, string | undefined>> = {},
): { code: number; stdout: string } {
  let stdout = '';
  const code = runDoctor({ json }, { output: (text) => void (stdout += text), cwd, version, env });
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

  it('reports the rerank opt-in, and whether its key variable is set — presence only', () => {
    // The one config key that can make a smelt run talk to another machine, so
    // "is that on here, and does it have what it needs?" must be answerable without
    // running anything. And a doctor report is a thing people paste into issues: the
    // variable is named, its *value* is never read into the receipt or the prose.
    const cwd = scratch('opt-in');
    try {
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({
          smeltConfig: 1,
          defaultBudgetBytes: 4000,
          rerank: { kind: 'voyage', model: 'rerank-2.5', apiKeyEnv: 'VOYAGE_API_KEY', topK: 8 },
        })}\n`,
      );

      const missing = doctor(cwd, '9.9.9', false, {});
      expect(missing.stdout).toContain('rerank: voyage/rerank-2.5 — VOYAGE_API_KEY missing');
      const receiptMissing = receiptOf(doctor(cwd, '9.9.9', true, {}).stdout);
      expect(receiptMissing.rerank).toMatchObject({
        kind: 'voyage',
        adapter: 'voyage/rerank-2.5',
        keyEnv: 'VOYAGE_API_KEY',
        keySet: false,
      });
      // Exactly those four facts, plus exactly one of the two resolution facts —
      // `adapterFrom` when the adapter is installed somewhere, `install` when it is
      // not. Nothing else about the opt-in reaches a receipt people paste into issue
      // trackers, and the list is closed rather than merely checked for the key.
      // Which of the two shows up is a fact about the machine, and pnpm gives this
      // process a `NODE_PATH` into the workspace store, so the not-installed half is
      // pinned in the spawned-binary case below where a consumer's environment applies.
      const resolutionFields = new Set(['adapterFrom', 'adapterProblem', 'install']);
      const fields = Object.keys(receiptMissing.rerank ?? {}).toSorted();
      expect(fields.filter((key) => !resolutionFields.has(key))).toEqual([
        'adapter',
        'keyEnv',
        'keySet',
        'kind',
      ]);
      expect(fields.some((key) => resolutionFields.has(key))).toBe(true);

      const present = doctor(cwd, '9.9.9', false, { VOYAGE_API_KEY: 'sk-super-secret' });
      expect(present.stdout).toContain('rerank: voyage/rerank-2.5 — VOYAGE_API_KEY set');
      expect(present.stdout).not.toContain('sk-super-secret');
      const receipt = receiptOf(
        doctor(cwd, '9.9.9', true, { VOYAGE_API_KEY: 'sk-super-secret' }).stdout,
      );
      expect(receipt.rerank?.keySet).toBe(true);
      expect(JSON.stringify(receipt)).not.toContain('sk-super-secret');

      // And absent means absent: no key, no line, no receipt field.
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 4000 })}\n`,
      );
      expect(doctor(cwd, '9.9.9', false).stdout).not.toContain('rerank');
      expect(receiptOf(doctor(cwd, '9.9.9').stdout).rerank).toBeUndefined();
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

  it('reports the store it found: blob count and bytes, as receipt fields', () => {
    const cwd = scratch('store-size');
    try {
      const storeDir = join(cwd, SETUP_RECIPE.store.defaultDir);
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({
          smeltConfig: 1,
          store: { kind: 'directory', path: SETUP_RECIPE.store.defaultDir },
        })}\n`,
      );
      const store = new DirectoryElisionStore(storeDir);
      store.put('one elided blob');
      store.put('another elided blob');

      const receipt = receiptOf(doctor(cwd, '9.9.9').stdout);
      expect(receipt.config.store.dirExists).toBe(true);
      // Structured, and exact: the prose line is a rendering of these two integers,
      // so an agent reading the receipt never has to parse a rounded "1.2 KB".
      expect(receipt.config.store.blobs).toBe(2);
      expect(receipt.config.store.bytes).toBe(
        Buffer.byteLength('one elided blob', 'utf8') +
          Buffer.byteLength('another elided blob', 'utf8'),
      );
      expect(doctor(cwd, '9.9.9', false).stdout).toContain('2 blobs');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reads a missing store directory without creating it — doctor never writes', () => {
    const cwd = scratch('store-absent');
    try {
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({
          smeltConfig: 1,
          store: { kind: 'directory', path: SETUP_RECIPE.store.defaultDir },
        })}\n`,
      );
      const receipt = receiptOf(doctor(cwd, '9.9.9').stdout);
      // The size is absent rather than zero: "there is no store here" and "the store
      // here is empty" are different facts, and doctor states only the one it read.
      expect(receipt.config.store.dirExists).toBe(false);
      expect(receipt.config.store.blobs).toBeUndefined();
      expect(receipt.config.store.bytes).toBeUndefined();
      // And the orphan it already reported is still true after the reading: a doctor
      // that opened the store to size it would have created the very directory it
      // just called missing.
      expect(existsSync(join(cwd, SETUP_RECIPE.store.defaultDir))).toBe(false);
      expect(receipt.orphans.join('\n')).toContain('store directory');
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

/**
 * The same substitution for a file smelt owns **whole** — Cline's wrapper, Hermes's
 * YAML, opencode's plugin — where the path to re-point is not in a JSON entry but in
 * the file's own text, exactly where its renderer put it.
 *
 * One replacement covers all three shapes because all three name something under the
 * package's `dist/hooks/`: a shim (`node "<...>/dist/hooks/shims/<id>.js"`) or the
 * guard core (`const GUARD_CORE = "<...>/dist/hooks/guard-core.js"`). The built prefix
 * is spelled out rather than derived through `@guard/harness/paths`, for the reason
 * {@link useBuiltScripts} spells out: a derived path is a path the mutation under test
 * may have changed.
 */
function useBuiltScriptsIn(path: string): void {
  if (!existsSync(path)) return;
  const built = join(packageRoot(), 'dist', 'hooks');
  writeFileSync(path, readFileSync(path, 'utf8').replace(/"[^"]*\/dist\/hooks\//gu, `"${built}/`));
}

/** Re-point whatever the whole-owned file at `path` runs at `script`. */
function pointFileAt(path: string, script: string): void {
  writeFileSync(path, readFileSync(path, 'utf8').replace(/"[^"]*\/hooks\/[^"]*"/u, `"${script}"`));
}

/** `smelt setup --yes --json --harness <id>`, with every script it wrote made real. */
async function setupHarness(cwd: string, harness: string, file: string): Promise<string> {
  let stdout = '';
  const code = await runCli(['setup', '--yes', '--json', '--harness', harness], {
    stdout: (text) => void (stdout += text),
    stderr: () => {},
    stdin: () => '',
    version: '0.5.0',
    cwd,
  });
  expect(code, `setup --harness ${harness} failed:\n${stdout}`).toBe(EXIT.ok);
  const path = join(cwd, file);
  useBuiltScriptsIn(path);
  return path;
}

/**
 * THE THREE HARNESSES WHOSE WIRING IS A FILE, NOT AN ENTRY.
 *
 * Cline runs an executable, Hermes reads a YAML list, opencode imports a JavaScript
 * plugin — and smelt owns each of those files whole. They carry no hook entries, so the
 * probe had nothing to read and doctor printed a plain `wired` for all three: the exact
 * text fact this arc exists to remove, surviving in the three places hardest to check
 * by hand. Each is now read back through the probe its own profile declares, spawned
 * for real against this package's built `dist`.
 */
const WHOLE_OWNED: readonly { id: string; file: string; event: string }[] = [
  { id: 'cline', file: '.clinerules/hooks/PreToolUse', event: 'PreToolUse' },
  { id: 'hermes', file: '.hermes/hooks.yaml', event: 'pre_tool_call' },
  { id: 'opencode', file: '.opencode/plugins/smelt-guard.js', event: 'tool.execute.before' },
];

describe('a hook file smelt owns whole is run too', () => {
  for (const harness of WHOLE_OWNED) {
    it(`${harness.id}: the file setup wrote fires, and the receipt names the event`, async () => {
      const cwd = scratch(`whole-${harness.id}`);
      try {
        await setupHarness(cwd, harness.id, harness.file);
        const { stdout } = doctor(cwd, '0.5.0', false);
        expect(stdout).toContain(`${harness.file}: wired (verified)`);

        const receipt = receiptOf(doctor(cwd, '0.5.0').stdout);
        const file = receipt.hooks?.find((one) => one.file === harness.file);
        expect(file?.harness).toBe(harness.id);
        const entry = file?.entries[0];
        expect(entry?.event).toBe(harness.event);
        expect(entry?.probe.status, entry?.probe.detail).toBe('fires');
        // Additive: the name is still in the list the receipt has always carried.
        expect(receipt.hookFiles).toContain(harness.file);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }

  it('cline: a wrapper whose shim was deleted is `wired but missing`', async () => {
    const cwd = scratch('whole-missing');
    try {
      const path = await setupHarness(cwd, 'cline', '.clinerules/hooks/PreToolUse');
      const gone = join(cwd, 'Cellar', 'smelt', '0.5.0', 'dist', 'hooks', 'shims', 'cline.js');
      pointFileAt(path, gone);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.clinerules/hooks/PreToolUse: wired but missing');
      expect(stdout).toContain(gone);
      expect(stdout).toContain('smelt setup --harness cline');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hermes: a shim that runs and says nothing is `wired but inert`', async () => {
    const cwd = scratch('whole-inert');
    try {
      const path = await setupHarness(cwd, 'hermes', '.hermes/hooks.yaml');
      // Still recognisably a shim of ours — the ownership rule is the path's shape —
      // and exactly what the symlink defect produced: exit 0, no output, no guard.
      const stub = join(cwd, 'hooks', 'shims', 'hermes.js');
      mkdirSync(join(cwd, 'hooks', 'shims'), { recursive: true });
      writeFileSync(stub, 'process.exit(0);\n');
      pointFileAt(path, stub);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.hermes/hooks.yaml: wired but inert');
      expect(stdout).toContain('empty stdout is an allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('cline: a wrapper whose shim runs and says nothing is `wired but inert`', async () => {
    const cwd = scratch('whole-cline-inert');
    try {
      const path = await setupHarness(cwd, 'cline', '.clinerules/hooks/PreToolUse');
      const stub = join(cwd, 'hooks', 'shims', 'cline.js');
      mkdirSync(join(cwd, 'hooks', 'shims'), { recursive: true });
      writeFileSync(stub, 'process.exit(0);\n');
      pointFileAt(path, stub);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.clinerules/hooks/PreToolUse: wired but inert');
      expect(stdout).toContain('empty stdout is an allow');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('hermes: a YAML naming a shim that was deleted is `wired but missing`', async () => {
    const cwd = scratch('whole-hermes-missing');
    try {
      const path = await setupHarness(cwd, 'hermes', '.hermes/hooks.yaml');
      const gone = join(cwd, 'Cellar', 'smelt', '0.5.0', 'dist', 'hooks', 'shims', 'hermes.js');
      pointFileAt(path, gone);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.hermes/hooks.yaml: wired but missing');
      expect(stdout).toContain(gone);
      expect(stdout).toContain('smelt setup --harness hermes');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('opencode: a plugin whose guard core is gone is `wired but missing`', async () => {
    const cwd = scratch('plugin-missing');
    try {
      const path = await setupHarness(cwd, 'opencode', '.opencode/plugins/smelt-guard.js');
      const gone = join(cwd, 'Cellar', 'smelt', '0.5.0', 'dist', 'hooks', 'guard-core.js');
      pointFileAt(path, gone);

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.opencode/plugins/smelt-guard.js: wired but missing');
      expect(stdout).toContain(gone);
      expect(stdout).toContain('smelt setup --harness opencode');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('opencode: a plugin that loads and exports no hook is `wired but inert`', async () => {
    const cwd = scratch('plugin-inert');
    try {
      const path = await setupHarness(cwd, 'opencode', '.opencode/plugins/smelt-guard.js');
      // Ours (it carries the token, so the reader still owns it) and loadable — and it
      // registers nothing. From inside a session this is indistinguishable from a
      // working guard: opencode calls nothing and every read goes through.
      const core = join(packageRoot(), 'dist', 'hooks', 'guard-core.js');
      writeFileSync(
        path,
        `// smelt:hooks v1\nconst GUARD_CORE = ${JSON.stringify(core)};\n` +
          `export const SmeltGuard = async () => ({});\n`,
      );

      const { code, stdout } = doctor(cwd, '0.5.0', false);
      expect(code).toBe(EXIT.refused);
      expect(stdout).toContain('.opencode/plugins/smelt-guard.js: wired but inert');
      expect(stdout).toContain('tool.execute.before');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('the installed binary answers doctor', () => {
  it('reads the module kind by the loader’s rule: a file, or an installed package', () => {
    // The reader and the loader must ask the same question. `rerank/resolve.ts` made
    // `{"kind":"module","path":"my-reranker"}` loadable — a bare specifier is looked up
    // as a package — while doctor still asked `existsSync` about a file of that name,
    // so a config every run loads without complaint was reported as an orphan at exit 3.
    // Spawned, and with `NODE_PATH` cleared, for the reason the case below is.
    const bin = join(import.meta.dirname, '../../dist/cli/bin.js');
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-doctor-module-')));
    try {
      const write = (path: string): void =>
        writeFileSync(
          join(cwd, 'smelt.config.json'),
          `${JSON.stringify({
            smeltConfig: 1,
            defaultBudgetBytes: 4000,
            rerank: { kind: 'module', path },
          })}\n`,
        );
      const read = (): DoctorReceipt => {
        const run = spawnSync(process.execPath, [bin, 'doctor', '--json'], {
          encoding: 'utf8',
          cwd,
          env: { ...process.env, NODE_PATH: '' },
        });
        return JSON.parse(run.stdout) as DoctorReceipt;
      };

      // A package beside the config, and no file of that name anywhere.
      const home = join(cwd, 'node_modules', 'my-reranker');
      mkdirSync(home, { recursive: true });
      writeFileSync(
        join(home, 'package.json'),
        `${JSON.stringify({
          name: 'my-reranker',
          version: '1.0.0',
          type: 'module',
          main: 'i.js',
        })}\n`,
      );
      writeFileSync(join(home, 'i.js'), `export default { id: 'x', rerank: async () => [] };\n`);

      write('my-reranker');
      const asPackage = read();
      expect(
        asPackage.rerank,
        'a module kind naming an installed package was read as a missing file',
      ).toMatchObject({ kind: 'module', moduleExists: true, adapterFrom: 'config' });
      expect(asPackage.orphans.join('\n')).not.toContain('rerank');

      // A relative path is never a package: the old reading, unchanged.
      write('./gone.mjs');
      const asMissingFile = read();
      expect(asMissingFile.rerank?.moduleExists).toBe(false);
      expect(asMissingFile.rerank?.adapterProblem).toBeUndefined();
      expect(asMissingFile.orphans.join('\n')).toContain('gone.mjs');

      // And a bare specifier that is no package either says so as one, with the
      // command for the config's directory rather than `smelt init`.
      write('not-a-package-anywhere');
      const asMissingPackage = read();
      expect(asMissingPackage.rerank?.adapterProblem).toBe('missing');
      expect(asMissingPackage.rerank?.install).toBe(
        `npm install --prefix "${cwd}" not-a-package-anywhere`,
      );
      expect(asMissingPackage.repair).toContain(
        `npm install --prefix "${cwd}" not-a-package-anywhere`,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 20_000);

  it('says WHERE the rerank adapter is, and names an install command that could work', () => {
    // The one fact about the opt-in that could not be read without running a smelt:
    // an adapter can be installed beside the config, beside smelt, or in neither, and
    // only the last is a problem. `NODE_PATH` is cleared because pnpm points this
    // process's at the workspace's virtual store, where every package in the
    // repository — this adapter included — resolves from any directory at all; a
    // consumer's machine has no such variable.
    const bin = join(import.meta.dirname, '../../dist/cli/bin.js');
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'smelt-doctor-adapter-')));
    try {
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({
          smeltConfig: 1,
          defaultBudgetBytes: 4000,
          rerank: { kind: 'voyage', topK: 8 },
        })}\n`,
      );
      const run = spawnSync(process.execPath, [bin, 'doctor', '--json'], {
        encoding: 'utf8',
        cwd,
        env: { ...process.env, NODE_PATH: '' },
      });
      const receipt = JSON.parse(run.stdout) as DoctorReceipt;

      const install = `npm install --prefix "${cwd}" @smeltjs/rerank-voyage`;
      expect(receipt.rerank?.install, `doctor said:\n${run.stdout}${run.stderr}`).toBe(install);
      expect(receipt.rerank?.adapterProblem).toBe('missing');
      expect(receipt.rerank?.adapterFrom).toBeUndefined();
      expect(receipt.repair).toContain(install);
      // And the value of the key never rides along, whichever half is reported.
      expect(JSON.stringify(receipt)).not.toContain('sk-');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 15_000);

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
    id: 'doctor-skips-whole-owned-files',
    file: 'cli/installed.ts',
    find: "    const probe = step.kind === 'own-file' ? step.probe : undefined;",
    replace: '    const probe = undefined;',
    why: 'the three harnesses whose wiring is a file smelt owns whole going back to being read as a file *name* — Cline, Hermes and opencode would report a plain `wired` again, which is the text fact this whole arc exists to remove and reads identically for a working guard and for a plugin whose guard core an upgrade deleted',
  },
  {
    kind: 'src',
    id: 'doctor-authors-the-store-it-reports-on',
    file: 'store-dir.ts',
    find: "  const blobsDir = join(resolve(root), 'blobs');",
    replace:
      "  const blobsDir = join(resolve(root), 'blobs');\n" +
      '  mkdirSync(blobsDir, { recursive: true });',
    why: 'the read-only store reader starts creating what it reads — `smelt doctor` would author the very store directory it is reporting as missing, breaking the one promise that separates doctor from setup (ADR-0003: doctor reports, setup repairs)',
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
  {
    kind: 'src',
    id: 'doctor-prints-the-rerank-key-instead-of-its-presence',
    file: 'cli/doctor.ts',
    find: "    keySet: key !== undefined && key !== '',",
    replace: '    keySet: key as unknown as boolean,',
    why: 'the API key itself reaching the receipt in place of a boolean — a doctor report is a thing people paste into issue trackers, and the presence-only rule is the only thing between a config opt-in and a leaked key',
  },
];
