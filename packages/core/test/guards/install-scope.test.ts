import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { EXIT, runCli } from '@guard/cli/run';
import { runDoctor } from '@guard/cli/doctor';
import { presetToggles } from '@guard/cli/installed';
import type { DoctorReceipt } from '@guard/cli/doctor';
import type { SetupReceipt } from '@guard/cli/setup';
import { SETUP_RECIPE } from '@guard/setup/recipe';
import { harnessById } from '@guard/harness/registry';

import type { GuardMutation } from './_mutations.ts';

/**
 * INSTALL-SCOPE GUARD — an install for the whole machine lands where the harnesses
 * actually read, or it is not written at all.
 *
 * The only way to get one `smelt.config.json` and one store for every project on a
 * machine is to install from `$HOME`: config discovery walks up, so a config at `~` is
 * the one every project below it finds. Run from there, the installer used to join
 * every project-relative path onto the home directory and write `~/CLAUDE.md`,
 * `~/.mcp.json`, `~/AGENTS.md`, `~/GEMINI.md`, `~/opencode.json` — files no harness
 * reads at that level. Doctor read from those same wrong places, so the writer and the
 * reader agreed the install was healthy while nothing was wired: the exact silent
 * failure shape this project refuses everywhere else.
 *
 * Three promises, one each:
 *
 *   1. **A user-scope install goes to the documented user-level locations**, or is
 *      reported skipped. It is never the project spelling one directory over — a
 *      harness that documents no user-level home for an artefact gets *no path*, so
 *      the fallback is not something a caller can reach by forgetting a check.
 *   2. **The marker block says which thing uses smelt.** A block in
 *      `~/.claude/CLAUDE.md` is loaded in every project on the machine, so "This
 *      project uses smelt" is a claim about a project the reader may not be in.
 *   3. **Doctor reads through the same resolver the writer wrote through.** A doctor
 *      that read the project paths of a machine install reports "nothing installed"
 *      for a working one — or, worse, "current" for a broken one.
 *
 * `home` is an injected temp directory in every case. A user-scope plan *writes into
 * home*, so a guard that used the real one would rewrite the developer's own
 * `~/.claude/settings.json` on every run.
 */

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-scope-guard-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'smelt-scope-guard-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** `smelt setup --yes --json --scope <scope>` in `dir`, with `home` injected. */
async function setup(scope: 'project' | 'user', harness: string): Promise<SetupReceipt> {
  let stdout = '';
  const code = await runCli(['setup', '--yes', '--json', '--scope', scope, '--harness', harness], {
    stdout: (text) => void (stdout += text),
    stderr: () => {},
    stdin: () => '',
    version: '9.9.9-test',
    cwd: dir,
    home,
  });
  expect(code, `setup --scope ${scope} exited ${String(code)}:\n${stdout}`).toBe(EXIT.ok);
  return JSON.parse(stdout) as SetupReceipt;
}

describe('a machine-wide install lands where the harness reads', () => {
  it('setup --scope user writes under home, and not one byte into the project', async () => {
    const receipt = await setup('user', 'claude-code');

    expect(receipt.scope).toBe('user');
    // The four locations Claude Code's own docs name (verified 2026-09-09): user
    // settings, user memory, and the config every project below `~` discovers.
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(home, 'smelt.config.json'))).toBe(true);
    expect(existsSync(join(home, SETUP_RECIPE.store.defaultDir))).toBe(true);

    // And none of the inert spellings the old installer wrote there.
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(home, '.mcp.json'))).toBe(false);

    // The project directory is untouched. This is the assertion the whole scope
    // exists for: a machine install that reaches into the project has installed
    // twice, and the second one is invisible.
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a harness with no documented user-level location is skipped, never guessed', async () => {
    // Hermes's `.hermes/hooks.yaml` is smelt's own invention and its instruction file
    // is `AGENTS.md`; neither has a documented home-level location. The install must
    // say so and write neither — `~/AGENTS.md` and `~/.hermes/hooks.yaml` are files
    // nothing reads, and writing them is how the old installer looked successful.
    const receipt = await setup('user', 'hermes');
    expect(existsSync(join(home, 'AGENTS.md'))).toBe(false);
    expect(existsSync(join(home, '.hermes', 'hooks.yaml'))).toBe(false);

    const skipped = receipt.files.filter((file) => file.action === 'skipped');
    expect(
      skipped.map((file) => file.detail).join('\n'),
      `nothing was reported skipped: ${JSON.stringify(receipt.files)}`,
    ).toContain('no documented user-level');

    // The config is still written: it is smelt's own file, and `~/smelt.config.json`
    // is exactly the point of a machine install.
    expect(existsSync(join(home, 'smelt.config.json'))).toBe(true);
  });

  it("Claude Code's user-scope MCP registration is handed over as a command", async () => {
    // `~/.claude.json` is Claude Code's file — its own docs say to manage it through
    // `/config` and the `claude mcp` CLI. Editing it would be smelt writing into a
    // file whose owner rewrites it wholesale.
    const receipt = await setup('user', 'claude-code');
    expect(existsSync(join(home, '.claude.json')), 'smelt must not write it').toBe(false);
    expect(receipt.mcp.status).toBe('manual');
    expect(receipt.mcp.command).toBe(harnessById('claude-code')?.mcp?.manualUser);
    expect(receipt.mcp.command).toContain('--scope user');

    // The manual path builds its list the same way the applied one does: every manual
    // MCP step this run handed back, with `command` the first of them. Exactly one
    // profile documents a user-scope registration file it owns, so one is all this
    // combination can produce — and a list of one is still a list, which is what makes
    // `commands` the field a reader can act on without asking how many there are.
    expect(receipt.mcp.commands).toEqual([harnessById('claude-code')?.mcp?.manualUser]);
    expect(receipt.mcp.command).toBe((receipt.mcp.commands ?? [])[0]);
  });

  it('a project install is unchanged: the project files, and nothing in home', async () => {
    const receipt = await setup('project', 'claude-code');
    expect(receipt.scope).toBe('project');
    expect(existsSync(join(dir, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(dir, '.mcp.json'))).toBe(true);
    expect(receipt.mcp.status).toBe('applied');
    // A one-harness run still carries `commands`, holding the one thing `command`
    // holds. Deliberate: a reader that always reads the list never has to branch on
    // how many harnesses a run happened to name.
    expect(receipt.mcp.commands).toEqual([harnessById('claude-code')?.mcp?.manual]);
    expect(readdirSync(home)).toEqual([]);
  });
});

describe('the marker block says which thing uses smelt', () => {
  it('a machine install says machine; a project install says project', async () => {
    await setup('user', 'claude-code');
    expect(readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8')).toContain('This machine uses');

    await setup('project', 'claude-code');
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('This project uses');
  });
});

describe('doctor reads through the same resolver the writer wrote through', () => {
  function doctor(scope: 'project' | 'user'): { code: number; receipt: DoctorReceipt } {
    let stdout = '';
    const code = runDoctor(
      { json: true, scope },
      { output: (text) => void (stdout += text), cwd: dir, home, version: '9.9.9-test' },
    );
    return { code, receipt: JSON.parse(stdout) as DoctorReceipt };
  }

  it('a machine install reads back as installed at user scope, and absent at project', async () => {
    await setup('user', 'claude-code');

    const user = doctor('user');
    expect(user.receipt.scope).toBe('user');
    expect(
      user.receipt.installed,
      `doctor read nothing back from a machine install: ${JSON.stringify(user.receipt)}`,
    ).toBe(true);
    expect(user.receipt.hookFiles).toContain('.claude/settings.json');
    expect(user.receipt.blocks.map((block) => block.file)).toContain('.claude/CLAUDE.md');
    expect(user.receipt.config.present).toBe(true);

    // Nothing of smelt's is in this project, and doctor says so rather than reporting
    // the machine's install as the project's.
    const project = doctor('project');
    expect(project.receipt.installed).toBe(false);
    expect(project.code).toBe(EXIT.ok);
  });

  it('doctor never writes, at either scope', async () => {
    await setup('user', 'claude-code');
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');
    doctor('user');
    doctor('project');
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual([]);
  });
});

/**
 * ONE ARTEFACT, TWO NAMES — what happens when a harness renames the directory it
 * loads from.
 *
 * opencode documents `.opencode/plugins/` (and `~/.config/opencode/plugins/`); smelt
 * wrote the singular `.opencode/plugin/` up to 0.6.0. A resolver that knew only today's
 * spelling would make every existing install a file nobody owns: doctor stops reporting
 * it, `remove` stops removing it, a re-run reads the guard toggle back as off, and the
 * next install writes a second copy beside the first. So the former spelling is
 * declared on the step and resolved by `locateFormer` — read, and removed, never
 * written.
 */
describe("an artefact's former home is still read, and still removed", () => {
  const FORMER = '.opencode/plugin/smelt-guard.js';
  const TODAY = '.opencode/plugins/smelt-guard.js';

  /** `smelt doctor --json` in `dir`, read back as a receipt. */
  function doctorHere(): DoctorReceipt {
    let stdout = '';
    runDoctor(
      { json: true, scope: 'project' },
      { output: (text) => void (stdout += text), cwd: dir, home, version: '9.9.9-test' },
    );
    return JSON.parse(stdout) as DoctorReceipt;
  }

  /** What an earlier release left on disk: ours, under the name it used to write. */
  function earlierRelease(): void {
    mkdirSync(join(dir, dirname(FORMER)), { recursive: true });
    writeFileSync(join(dir, FORMER), '// smelt:hooks v1 — written by an earlier release\n');
  }

  it('is read back as an install, and named — not orphaned, and not written to again', async () => {
    earlierRelease();

    // **Before** anything is written: the old name is the only install on this disk.
    // The toggle reader is asked here, and asked for the whole value, because a reader
    // blind to the old name does not answer "no guard" — it answers *the defaults*
    // (guard on, stats on), which is a `stats` hook this machine does not have and a
    // wizard offering to write one. Asking after setup would ask about the file setup
    // had just written, which reads the same either way and proves nothing.
    expect(existsSync(join(dir, TODAY)), 'the case must start with only the old name').toBe(false);
    expect(presetToggles(dir, { home }), 'an existing install read as nothing installed').toEqual({
      guard: true,
      statsOnStop: false,
      mapOnStart: false,
      lintOnStart: false,
    });

    const receipt = await setup('project', 'opencode');

    // Written: today's spelling only. The old copy is somebody's to remove, and this
    // verb writes — it does not delete.
    expect(existsSync(join(dir, TODAY))).toBe(true);
    expect(readFileSync(join(dir, FORMER), 'utf8')).toContain('an earlier release');
    expect(receipt.files.some((file) => file.name === FORMER)).toBe(false);

    // And doctor is not silent about the leftover: a file of ours in a directory
    // opencode no longer loads from is an orphan, and it costs `current`.
    const read = doctorHere();
    expect(read.orphans.join('\n')).toContain(FORMER);
    expect(read.repair).toContain('smelt hooks remove --harness opencode');
    expect(read.current).toBe(false);
  });

  it('comes out on remove, under both names', async () => {
    earlierRelease();
    await setup('project', 'opencode');
    let stdout = '';
    const code = await runCli(['hooks', 'remove', '--yes', '--harness', 'opencode'], {
      stdout: (text) => void (stdout += text),
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      home,
    });
    expect(code, stdout).toBe(EXIT.ok);
    expect(existsSync(join(dir, TODAY)), 'the file this release wrote').toBe(false);
    expect(existsSync(join(dir, FORMER)), 'the file an earlier release wrote').toBe(false);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    id: 'install-scope-falls-back-to-the-project-path',
    file: 'harness/scope.ts',
    find: `    return {
      skipped: \`\${roots.harness ?? 'this harness'} has no documented user-level \${KIND_LABEL[step.kind]}\`,
    };`,
    replace: '    return { path: join(roots.cwd, step.file), name: step.file };',
    why: 'a user-scope install silently falling back to the project spelling — `~/AGENTS.md`, `~/.hermes/hooks.yaml`, files no harness reads, written with nothing said; that is the original defect exactly, and the whole reason a skipped step is given no path to fall back on',
  },
  {
    kind: 'src',
    id: 'install-scope-forgets-a-former-location',
    file: 'harness/scope.ts',
    find: "  if (step.formerly === undefined || scope !== 'project') return undefined;",
    replace: '  return undefined;',
    why: "an artefact's former home going unread the moment a harness renames the directory it loads from — every existing install becomes a file nobody owns: `remove` leaves it behind for ever, doctor stops reporting it, and a re-run reads the guard toggle back as off and offers to turn off a guard that is installed",
  },
  {
    kind: 'src',
    id: 'install-scope-snippet-ignores-scope',
    file: 'harness/snippet.ts',
    find: "This ${scope === 'user' ? 'machine' : 'project'} uses",
    replace: 'This project uses',
    why: 'the marker block in `~/.claude/CLAUDE.md` claiming "this project" — it is loaded in every project on the machine, so it is a claim about a project the reader is not necessarily in, and the one word is the only thing telling a reader which install they are looking at',
  },
  {
    kind: 'src',
    id: 'install-scope-doctor-reads-the-project',
    file: 'cli/doctor.ts',
    find: 'const state = readInstalledState(io.cwd, { scope, home });',
    replace: 'const state = readInstalledState(io.cwd);',
    why: 'doctor reading the project paths of a machine install — it reports "nothing installed" for a working one and, when a project install exists too, reports the wrong one; the writer and the reader going through one resolver is the entire point of InstallScope',
  },
];
