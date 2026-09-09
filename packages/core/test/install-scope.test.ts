import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runDoctor } from '../src/cli/doctor.ts';
import { EXIT } from '../src/cli/shell.ts';
import type { DoctorReceipt } from '../src/cli/doctor.ts';
import { runHooks } from '../src/cli/hooks.ts';
import { presetToggles } from '../src/cli/installed.ts';
import { planInstall, planRemove } from '../src/harness/plan.ts';
import type { HooksChoices } from '../src/harness/plan.ts';
import { readInstalledState } from '../src/cli/installed.ts';
import { SETUP_RECIPE } from '../src/setup/recipe.ts';
import { runSetup } from '../src/cli/setup.ts';
import type { SetupReceipt } from '../src/cli/setup.ts';
import {
  GUARD_ONLY_FILES,
  HARNESSES,
  harnessById,
  JSON_HOOK_FILES,
} from '../src/harness/registry.ts';
import { detectScope, locateStep, resolveScope } from '../src/harness/scope.ts';
import { instructionSnippet } from '../src/harness/snippet.ts';
import type { SmeltInvocation } from '../src/hooks/invocation.ts';

/**
 * InstallScope, end to end: where every artefact goes when the install is for the
 * whole machine rather than for one project.
 *
 * `home` is an injected temp directory in every case here — never the real one. That
 * is not politeness: a user-scope plan *writes into home*, and a suite that used the
 * developer's would rewrite their `~/.claude/settings.json` on every run. The two
 * roots are also kept in *different* temp directories, so "nothing landed in cwd" is
 * a claim the assertions can actually make.
 */

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-scope-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'smelt-scope-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/**
 * A fixed invocation, so a machine with a global `smelt` and a machine without one
 * plan the same bytes. `test/hooks-fixtures.ts` makes the same point about PATH for
 * the spawned cases.
 */
const NODE_INVOCATION: SmeltInvocation = {
  kind: 'node',
  command: 'node "/pkg/dist/cli/bin.js"',
  script: '/pkg/dist/cli/bin.js',
  bin: '/pkg/dist/cli/bin.js',
  stable: true,
  why: 'test fixture',
};

function choicesFor(ids: readonly string[], extra: Partial<HooksChoices> = {}): HooksChoices {
  return {
    harnesses: ids.map((id) => harnessById(id)!),
    guard: true,
    statsOnStop: true,
    mapOnStart: true,
    lintOnStart: true,
    enforcement: 'deny',
    thresholdBytes: 8192,
    invocation: NODE_INVOCATION,
    home,
    ...extra,
  };
}

/** Plan for the machine, and return the planned paths. */
function userPlan(ids: readonly string[], extra: Partial<HooksChoices> = {}) {
  return planInstall(dir, choicesFor(ids, { scope: 'user', ...extra }));
}

/**
 * The same, but with the **real** invocation — so the scripts the plan names are this
 * package's own built ones and doctor's probe can actually run them. The fixture
 * invocation above names `/pkg/dist/cli/bin.js`, which is the point everywhere else and
 * exactly wrong for the one case that asks whether a machine install reads back healthy.
 */
function livePlan(ids: readonly string[], extra: Partial<HooksChoices> = {}) {
  const { invocation: _fixture, ...live } = choicesFor(ids, { scope: 'user', ...extra });
  return planInstall(dir, live);
}

describe('locateStep is the one resolver', () => {
  it('project scope is exactly join(cwd, step.file) — unchanged, by construction', () => {
    const step = { kind: 'json-hooks', file: '.claude/settings.json' } as const;
    expect(locateStep(step, 'project', { cwd: dir, home })).toEqual({
      path: join(dir, '.claude/settings.json'),
      name: '.claude/settings.json',
    });
  });

  it('user scope is the documented location under home', () => {
    const step = {
      kind: 'json-hooks',
      file: '.claude/settings.json',
      user: { file: '.claude/settings.json' },
    } as const;
    expect(locateStep(step, 'user', { cwd: dir, home })).toEqual({
      path: join(home, '.claude/settings.json'),
      name: '.claude/settings.json',
    });
  });

  it('a step with no documented user location has no path at all, and says why', () => {
    const step = { kind: 'own-file', file: '.hermes/hooks.yaml' } as const;
    const located = locateStep(step, 'user', { cwd: dir, home, harness: 'Hermes Agent' });
    expect(located.path, 'a skipped step must offer no path to fall back on').toBeUndefined();
    expect(located.skipped).toBe('Hermes Agent has no documented user-level hook file');
  });

  it('a manual location carries the command instead of being written', () => {
    const step = {
      kind: 'mcp-registration',
      file: '.mcp.json',
      user: { file: '.claude.json', manual: 'claude mcp add --scope user smelt -- npx x' },
    } as const;
    const located = locateStep(step, 'user', { cwd: dir, home });
    expect(located.path).toBe(join(home, '.claude.json'));
    expect(located.manual).toBe('claude mcp add --scope user smelt -- npx x');
  });
});

describe('detection: the machine is the default only from the machine', () => {
  it('cwd == home detects user; anywhere else detects project', () => {
    expect(detectScope({ cwd: home, home })).toBe('user');
    expect(detectScope({ cwd: dir, home })).toBe('project');
  });

  it('the comparison is through realpath, so a symlinked home is still home', () => {
    // Two spellings of one directory. A string compare answers `project` here, and
    // the machine install nobody asked for goes into the project instead.
    const realpath = (path: string): string => (path === join(dir, 'link') ? home : path);
    expect(detectScope({ cwd: join(dir, 'link'), home }, realpath)).toBe('user');
  });

  it('--scope wins over detection, in both directions', () => {
    expect(resolveScope('project', { cwd: home, home })).toBe('project');
    expect(resolveScope('user', { cwd: dir, home })).toBe('user');
    expect(resolveScope(undefined, { cwd: dir, home })).toBe('project');
  });
});

describe('a user-scope plan writes where each harness reads', () => {
  it('claude-code: settings and CLAUDE.md under ~/.claude, config at ~/smelt.config.json', () => {
    const plan = userPlan(['claude-code']);
    const paths = plan.files.map((file) => file.path);
    expect(paths).toContain(join(home, '.claude', 'settings.json'));
    expect(paths).toContain(join(home, '.claude', 'CLAUDE.md'));
    expect(paths).toContain(join(home, 'smelt.config.json'));
    // Not one byte in the project — and in particular not the inert spellings the
    // installer used to write there: `~/CLAUDE.md`, `~/.mcp.json`.
    for (const path of paths) expect(path.startsWith(home)).toBe(true);
    expect(paths).not.toContain(join(home, 'CLAUDE.md'));
    expect(paths).not.toContain(join(home, '.mcp.json'));
  });

  it('every harness, at user scope, plans only under home', () => {
    const plan = userPlan(HARNESSES.map((profile) => profile.id));
    expect(plan.files.length).toBeGreaterThan(0);
    for (const file of plan.files) {
      expect(file.path.startsWith(home), `${file.name} landed outside ${home}`).toBe(true);
      expect(file.path.startsWith(dir), `${file.name} landed in the project`).toBe(false);
    }
  });

  it('the documented locations, per harness', () => {
    const at = (id: string, ...expected: readonly string[]): void => {
      const paths = userPlan([id])
        .files.map((file) => file.path)
        .filter((path) => path !== join(home, 'smelt.config.json'));
      expect(paths.toSorted(), id).toEqual(expected.map((one) => join(home, one)).toSorted());
    };
    at('claude-code', '.claude/settings.json', '.claude/CLAUDE.md');
    at('codex', '.codex/hooks.json', '.codex/config.toml', '.codex/AGENTS.md');
    at('gemini', '.gemini/settings.json', '.gemini/GEMINI.md');
    at('cursor', '.cursor/hooks.json');
    at('grok', '.grok/config.toml');
    at(
      'opencode',
      '.config/opencode/plugins/smelt-guard.js',
      '.config/opencode/opencode.json',
      '.config/opencode/AGENTS.md',
    );
    at('cline', '.cline/hooks/PreToolUse', '.cline/rules/smelt.md');
    at('hermes');
    at('kilocode');
    at('aider');
  });

  it('a harness with no documented user location is skipped with the reason', () => {
    const plan = userPlan(['hermes']);
    const why = plan.skipped.map((one) => one.why).join('\n');
    expect(why).toContain('Hermes Agent has no documented user-level hook file');
    expect(why).toContain('Hermes Agent has no documented user-level instruction file');
    expect(plan.files.map((file) => file.path)).toEqual([join(home, 'smelt.config.json')]);
  });

  it("Claude Code's user-scope MCP registration is a command, not a file", () => {
    const plan = userPlan(['claude-code']);
    expect(plan.files.map((file) => file.name)).not.toContain('.claude.json');
    expect(plan.manual).toEqual([
      {
        name: '.claude.json',
        kind: 'mcp-registration',
        command: 'claude mcp add --scope user smelt -- npx @smeltjs/mcp',
        harness: 'claude-code',
      },
    ]);
  });

  it('paths inside a written command are absolute at user scope', () => {
    // A `dist` under home, and both plans made *from* home — so the only thing that
    // differs is the scope. A project install spells a script inside its own root
    // relatively, because that config travels with the repo. A machine install must
    // not: its hook runs with cwd set to whatever project the agent opened, where a
    // relative path names a file that is not there.
    const distDir = join(home, 'node_modules', '@smeltjs', 'core', 'dist');
    const guardCommandAt = (scope: 'project' | 'user'): string => {
      const settings = planInstall(
        home,
        choicesFor(['claude-code'], { scope, distDir }),
      ).files.find((file) => file.name === '.claude/settings.json')!.content;
      const parsed = JSON.parse(settings) as {
        hooks: { PreToolUse: { hooks: { command: string }[] }[] };
      };
      return parsed.hooks.PreToolUse[0]!.hooks[0]!.command;
    };

    expect(guardCommandAt('user')).toBe(
      `node "${join(distDir, 'hooks', 'shims', 'claude-code.js')}"`,
    );
    expect(guardCommandAt('project')).toBe(
      'node "node_modules/@smeltjs/core/dist/hooks/shims/claude-code.js"',
    );
  });
});

describe('the snippet says which thing uses smelt', () => {
  it('project scope says project; user scope says machine', () => {
    expect(instructionSnippet(8192, 4000)).toContain('This project uses');
    expect(instructionSnippet(8192, 4000, undefined, 'project')).toContain('This project uses');
    expect(instructionSnippet(8192, 4000, undefined, 'user')).toContain('This machine uses');
    expect(instructionSnippet(8192, 4000, undefined, 'user')).not.toContain('This project uses');
  });

  it('a user-scope install stamps the machine wording into the block it writes', () => {
    const claude = userPlan(['claude-code']).files.find(
      (file) => file.path === join(home, '.claude', 'CLAUDE.md'),
    );
    expect(claude?.content).toContain('This machine uses');
  });
});

/** Apply a plan to disk, the way `hooks install` does after the confirm. */
function apply(plan: ReturnType<typeof planInstall>): void {
  for (const file of plan.files) {
    mkdirSync(join(file.path, '..'), { recursive: true });
    writeFileSync(file.path, file.content);
  }
}

describe('the readers look where the writer wrote', () => {
  it('readInstalledState at user scope finds what planInstall put there', () => {
    apply(userPlan(['claude-code']));

    const user = readInstalledState(dir, { scope: 'user', home });
    expect(user.hookFiles).toContain('.claude/settings.json');
    expect(user.blocks.map((block) => block.file)).toContain('.claude/CLAUDE.md');
    expect(user.config.present, '~/smelt.config.json is the user-scope config').toBe(true);
    expect(user.config.path).toBe(join(home, 'smelt.config.json'));
    expect(user.hooks[0]?.entries.length).toBeGreaterThan(0);

    // And the project reading of the same machine sees nothing, which is the honest
    // answer: nothing of smelt's was written into this project.
    const project = readInstalledState(dir, { scope: 'project', home });
    expect(project.hookFiles).toEqual([]);
    expect(project.blocks).toEqual([]);
  });

  it('the manual registration is read back read-only, and named when absent', () => {
    apply(userPlan(['claude-code']));
    const absent = readInstalledState(dir, { scope: 'user', home });
    const mcp = absent.mcp.find((one) => one.file === '.claude.json');
    expect(mcp?.registered).toBe(false);
    expect(mcp?.manual).toBe('claude mcp add --scope user smelt -- npx @smeltjs/mcp');
    expect(existsSync(join(home, '.claude.json')), 'doctor and setup never write it').toBe(false);

    // Once the user has run the command, the entry is there and doctor sees it.
    writeFileSync(
      join(home, '.claude.json'),
      `${JSON.stringify({ mcpServers: { smelt: { command: 'npx' } } }, null, 2)}\n`,
    );
    const present = readInstalledState(dir, { scope: 'user', home });
    expect(present.mcp.find((one) => one.file === '.claude.json')?.registered).toBe(true);
  });

  it('presetToggles reads its toggles back from the user-level files', () => {
    apply(userPlan(['claude-code'], { mapOnStart: true, lintOnStart: false }));
    expect(presetToggles(dir, { scope: 'user', home })).toEqual({
      guard: true,
      statsOnStop: true,
      mapOnStart: true,
      lintOnStart: false,
    });
    // The project reading of the same machine is the installer's defaults: nothing of
    // smelt's is installed *here*, and answering from the machine's toggles would be
    // a setting the user never chose for this project.
    expect(presetToggles(dir, { scope: 'project', home })).toEqual({
      guard: true,
      statsOnStop: true,
      mapOnStart: false,
      lintOnStart: false,
    });
  });

  it('planRemove at user scope takes back out what the user-scope install put in', () => {
    apply(userPlan(['claude-code']));
    const removals = planRemove(dir, [harnessById('claude-code')!], { scope: 'user', home });
    const paths = removals.map((one) => one.path);
    expect(paths).toContain(join(home, '.claude', 'settings.json'));
    expect(paths).toContain(join(home, '.claude', 'CLAUDE.md'));
    // The command the user ran by hand is not ours to un-run.
    expect(paths).not.toContain(join(home, '.claude.json'));
  });

  it('doctor at user scope reports the machine install, and its project reading is clean', () => {
    // Stamped by the binary that reads it back, and the store the config promises
    // created — `smelt setup` does both, and this test applies a plan directly. Without
    // them doctor is right to say `not current`, for reasons that are not about scope.
    // (A release version with no prerelease suffix: `snippetStampVersion` reads back
    // `x.y.z` and would otherwise report a `9.9.9-test` stamp as behind `9.9.9-test`.)
    apply(livePlan(['claude-code'], { writtenBy: '9.9.9' }));
    mkdirSync(join(home, SETUP_RECIPE.store.defaultDir), { recursive: true });

    let stdout = '';
    const code = runDoctor(
      { json: true, scope: 'user' },
      { output: (text) => void (stdout += text), cwd: dir, home, version: '9.9.9' },
    );
    const receipt = JSON.parse(stdout) as DoctorReceipt;
    expect(receipt.scope).toBe('user');
    expect(receipt.installed, `doctor saw nothing at user scope: ${stdout}`).toBe(true);
    expect(receipt.hookFiles).toContain('.claude/settings.json');
    expect(receipt.blocks.map((block) => block.file)).toContain('.claude/CLAUDE.md');
    expect(receipt.current, `not current: ${stdout}`).toBe(true);
    expect(code).toBe(EXIT.ok);

    let projectOut = '';
    runDoctor(
      { json: true, scope: 'project' },
      { output: (text) => void (projectOut += text), cwd: dir, home, version: '9.9.9-test' },
    );
    const projectReceipt = JSON.parse(projectOut) as DoctorReceipt;
    expect(projectReceipt.scope).toBe('project');
    expect(projectReceipt.installed).toBe(false);
  });

  it('doctor names --scope user in the repair it prints for a machine install', () => {
    // Stamped by an older release, so the block reads `behind` and there is a repair
    // to inspect at all — an unversioned block names none, and an assertion over an
    // empty list is an assertion about nothing.
    apply(userPlan(['claude-code'], { writtenBy: '1.0.0' }));
    let stdout = '';
    const code = runDoctor(
      { json: true, scope: 'user' },
      { output: (text) => void (stdout += text), cwd: dir, home, version: '2.0.0' },
    );
    const receipt = JSON.parse(stdout) as DoctorReceipt;
    expect(code).toBe(EXIT.refused);
    expect(receipt.repair.length, `no repair named: ${stdout}`).toBeGreaterThan(0);
    expect(receipt.repair).toContain('smelt setup --harness claude-code --scope user');
    // Whatever else it found, every repair command must repair *this* install.
    for (const command of receipt.repair) {
      if (!command.startsWith('smelt setup')) continue;
      expect(command, 'a project-scope repair would fix the wrong install').toContain(
        '--scope user',
      );
    }
  });
});

describe('project scope is untouched', () => {
  it('a project plan is byte-identical with the scope named and with it left out', () => {
    const named = planInstall(dir, choicesFor(['claude-code', 'codex'], { scope: 'project' }));
    const bare = planInstall(dir, choicesFor(['claude-code', 'codex']));
    expect(named.files.map((file) => [file.name, file.path, file.content])).toEqual(
      bare.files.map((file) => [file.name, file.path, file.content]),
    );
    expect(named.manual).toEqual([]);
    expect(named.skipped).toEqual([]);
  });
});

describe('the wizards state the detected scope and let you flip it', () => {
  /** The hooks wizard, run from `home` so detection picks `user`. */
  async function hooksFromHome(
    answers: readonly string[],
    scope?: 'project' | 'user',
  ): Promise<string> {
    let output = '';
    await runHooks('install', 'claude-code', {
      input: Readable.from([`${answers.join('\n')}\n`]),
      output: (text) => void (output += text),
      cwd: home,
      home,
      ...(scope === undefined ? {} : { scope }),
    });
    return output;
  }

  // guard, stats, map, lint, enforcement, threshold, confirm — and, from home, the
  // scope question in front of them.
  const AFTER_SCOPE = ['', '', '', '', '', '', 'yes'];

  it('asks once from the home directory, and Enter takes the machine install', async () => {
    const output = await hooksFromHome(['', ...AFTER_SCOPE]);
    expect(output).toContain('scope (1 machine / 2 project)');
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(true);
    expect(existsSync(join(home, 'CLAUDE.md')), 'the inert spelling').toBe(false);
  });

  it('answering 2 installs for the project instead', async () => {
    await hooksFromHome(['2', ...AFTER_SCOPE, 'yes', 'yes', 'yes']);
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(false);
  });

  it('does not ask when --scope answered it', async () => {
    const output = await hooksFromHome(AFTER_SCOPE, 'project');
    expect(output).not.toContain('scope (1 machine / 2 project)');
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(true);
  });

  it('does not ask from a project directory, where there is nothing to ask', async () => {
    let output = '';
    await runHooks('install', 'claude-code', {
      input: Readable.from([`${AFTER_SCOPE.join('\n')}\n`]),
      output: (text) => void (output += text),
      cwd: dir,
      home,
    });
    expect(output).not.toContain('scope (1 machine / 2 project)');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(true);
  });

  it('the setup wizard asks the same question, in the same place', async () => {
    let output = '';
    const code = await runSetup(
      { harnessIds: ['claude-code'], yes: false, noMcp: false, json: false },
      {
        // scope, budget, store kind, store path, mcp, confirm
        input: Readable.from([['', '', '', '', '', 'yes'].join('\n') + '\n']),
        output: (text) => void (output += text),
        cwd: home,
        home,
      },
    );
    expect(code, output).toBe(0);
    expect(output).toContain('scope (1 machine / 2 project)');
    expect(output).toContain('scope: this machine');
    expect(existsSync(join(home, 'smelt.config.json'))).toBe(true);
    expect(existsSync(join(home, '.claude', 'CLAUDE.md'))).toBe(true);
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(false);
  });
});

describe('the reading order of hookFiles is the receipt field it has always been', () => {
  it('project scope lists every JSON hook file, then every guard-only file', () => {
    apply(planInstall(dir, choicesFor(HARNESSES.map((profile) => profile.id))));

    // Restated by hand: the order `[...JSON_HOOK_FILES, ...GUARD_ONLY_FILES]` produced,
    // which is the order `smelt.doctor.v1`'s `hookFiles` and doctor's prose list have
    // always carried. A profile-by-profile fold reads the same *set* and interleaves
    // it — `.hermes/hooks.yaml` ahead of `.cursor/hooks.json` — which is a receipt
    // field changing shape for a reason that has nothing to do with what is installed.
    const state = readInstalledState(dir, { scope: 'project', home });
    expect(state.hookFiles).toEqual([
      '.claude/settings.json',
      '.codex/hooks.json',
      '.gemini/settings.json',
      '.grok/hooks.json',
      '.cursor/hooks.json',
      '.hermes/hooks.yaml',
      '.opencode/plugins/smelt-guard.js',
      '.clinerules/hooks/PreToolUse',
    ]);
    // …and it is the registry's own derivation, not a list that happens to agree today.
    expect(state.hookFiles).toEqual(
      [...JSON_HOOK_FILES, ...GUARD_ONLY_FILES].filter((name) => existsSync(join(dir, name))),
    );
  });

  it('user scope lists them in the same two passes', () => {
    apply(userPlan(HARNESSES.map((profile) => profile.id)));
    const state = readInstalledState(dir, { scope: 'user', home });
    expect(state.hookFiles).toEqual([
      '.claude/settings.json',
      '.codex/hooks.json',
      '.gemini/settings.json',
      '.cursor/hooks.json',
      '.config/opencode/plugins/smelt-guard.js',
      '.cline/hooks/PreToolUse',
    ]);
  });
});

describe('flipping the scope re-reads that scope’s toggles', () => {
  /**
   * The wizard's own transcript is the surface under test: the number in
   * `stats on Stop? (on/off) [on]` is what a re-run offers to keep, and offering the
   * *machine's* answer for a *project* install is how a toggle the user set gets
   * turned off by a wizard they answered with Enter.
   *
   * From `$HOME` the two scopes share most spellings — `.claude/settings.json` is the
   * same file either way — so the state that tells them apart is a guard-only file
   * whose two homes differ: opencode's plugin is `.opencode/plugins/…` under the
   * project and `.config/opencode/plugins/…` under the home directory.
   */
  function machineOnlyGuardInstall(): void {
    apply(planInstall(home, choicesFor(['opencode'], { scope: 'user' })));
  }

  async function wizardFromHome(answers: readonly string[]): Promise<string> {
    let output = '';
    await runHooks('install', 'claude-code', {
      input: Readable.from([`${answers.join('\n')}\n`]),
      output: (text) => void (output += text),
      cwd: home,
      home,
    });
    return output;
  }

  it('answering “project” offers the project’s toggles, not the machine’s', async () => {
    machineOnlyGuardInstall();

    // Machine: something of smelt's is installed, and it wires the guard only — so
    // stats reads back off.
    const machine = await wizardFromHome(['', '', '', '', '', '', '', 'no']);
    expect(machine).toContain('stats on Stop? (on/off) [off]');

    // Project: nothing of smelt's is installed under the project spellings, so the
    // installer's own defaults apply — stats on. Before the toggles were re-read after
    // the flip, this said `[off]`, and an Enter would have written the machine's
    // answer into the project's file.
    const project = await wizardFromHome(['2', '', '', '', '', '', '', 'no']);
    expect(project).toContain('stats on Stop? (on/off) [on]');
  });

  it('a toggle flag still wins after the flip — a scope answer is not an unanswer', async () => {
    machineOnlyGuardInstall();
    let output = '';
    await runHooks('install', 'claude-code', {
      input: Readable.from([`${['2', '', '', '', '', '', '', 'no'].join('\n')}\n`]),
      output: (text) => void (output += text),
      cwd: home,
      home,
      // Neither reading says `on`: the machine wires the guard only, and the project
      // has nothing installed, so both would offer `[off]`. Only the flag says on.
      toggles: { mapOnStart: true },
    });
    expect(output).toContain('repo map on SessionStart? (on/off) [on]');
  });

  it('the written file carries the flipped scope’s toggles', async () => {
    machineOnlyGuardInstall();
    await wizardFromHome(['2', '', '', '', '', '', '', 'yes', 'yes']);
    // The project spelling of the instruction file, and a Stop entry the machine
    // reading would have left out.
    expect(existsSync(join(home, 'CLAUDE.md'))).toBe(true);
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toContain('"Stop"');
  });

  it('setup reads the budget default from the config the settled scope will write', async () => {
    // A config *above* home: project-scope discovery walks up into it, user scope does
    // not — `~/smelt.config.json` is decided, not discovered. That is the one place
    // from `$HOME` where the two scopes name different files.
    const above = mkdtempSync(join(tmpdir(), 'smelt-scope-above-'));
    const nested = join(above, 'home');
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(above, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 1234 }, null, 2)}\n`,
    );
    try {
      const run = async (answers: readonly string[]): Promise<string> => {
        let output = '';
        await runSetup(
          { harnessIds: ['claude-code'], yes: false, noMcp: false, json: false },
          {
            input: Readable.from([`${answers.join('\n')}\n`]),
            output: (text) => void (output += text),
            cwd: nested,
            home: nested,
          },
        );
        return output;
      };
      // scope, budget, store kind, store path, mcp, confirm
      expect(await run(['2', 'back', '', '', '', '', 'no'])).toContain(
        'default budget in bytes [1234]',
      );
      expect(await run(['', 'back', '', '', '', '', 'no'])).toContain(
        `default budget in bytes [${String(SETUP_RECIPE.recommendedBudgetBytes)}]`,
      );
    } finally {
      rmSync(above, { recursive: true, force: true });
    }
  });
});

describe('the prose says only what the scope makes it say', () => {
  it("doctor's header carries the scope only when it is the machine's", () => {
    apply(userPlan(['claude-code']));
    const prose = (scope: 'project' | 'user'): string => {
      let out = '';
      runDoctor(
        { json: false, scope },
        { output: (text) => void (out += text), cwd: dir, home, version: '9.9.9' },
      );
      return out;
    };
    // Project scope reading a project directory is what this line has always meant,
    // and every byte of that prose stays what it was.
    expect(prose('project')).toContain(`doctor — binary 9.9.9, reading ${dir}\n`);
    expect(prose('project')).not.toContain('scope)');
    expect(prose('user')).toContain(`doctor — binary 9.9.9, reading ${home} (machine scope)\n`);
  });

  async function setupProse(options: {
    readonly harnessIds: readonly string[];
    readonly scope: 'project' | 'user';
  }): Promise<string> {
    let out = '';
    await runSetup(
      {
        harnessIds: options.harnessIds,
        yes: true,
        noMcp: false,
        json: false,
        scope: options.scope,
      },
      { output: (text) => void (out += text), cwd: dir, home },
    );
    return out;
  }

  it('the manual MCP sentence says which manual it is', async () => {
    // No harness carries a registration this preset knows how to write — the older of
    // the two manuals, and the sentence this line has always carried.
    expect(await setupProse({ harnessIds: [], scope: 'project' })).toContain(
      'MCP registration stays in your hands (no selected harness carries it)',
    );
  });

  it('a registration the harness owns is a different manual, and says so', async () => {
    const prose = await setupProse({ harnessIds: ['claude-code'], scope: 'user' });
    expect(prose).toContain('MCP registration stays in your hands:');
    expect(prose, 'claude-code does carry one — it is just not ours to write').not.toContain(
      'no selected harness carries it',
    );
    expect(prose).toContain(SETUP_RECIPE.mcp.registerUser);
  });

  it('a run that wrote a registration is applied, whatever else it handed over', async () => {
    let stdout = '';
    await runSetup(
      {
        harnessIds: ['claude-code', 'codex'],
        yes: true,
        noMcp: false,
        json: true,
        scope: 'user',
      },
      { output: (text) => void (stdout += text), cwd: dir, home },
    );
    const receipt = JSON.parse(stdout) as SetupReceipt;
    // Codex's TOML table really was written; calling the whole run `manual` would tell
    // an agent to go and register by hand what setup already registered.
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toContain(
      '[mcp_servers.smelt]',
    );
    expect(receipt.mcp.status).toBe('applied');
    // And the one it could not write is still handed over, per step, in the notes.
    expect((receipt.notes ?? []).join('\n')).toContain(SETUP_RECIPE.mcp.registerUser);
  });
});

describe('a toggle that is off is not a location that is missing', () => {
  it('guard off skips the guard-only files before it asks where they live', () => {
    const off = planInstall(dir, choicesFor(['hermes'], { scope: 'user', guard: false }));
    // Hermes has exactly two artefacts: a guard-only hook file and an instruction
    // file. With the guard off the first is not installed at any scope, so reporting
    // it skipped for want of a user-level home would name a file this run was never
    // going to write.
    expect(off.skipped.map((one) => one.name)).toEqual(['AGENTS.md']);

    const on = planInstall(dir, choicesFor(['hermes'], { scope: 'user', guard: true }));
    expect(on.skipped.map((one) => one.name).toSorted()).toEqual([
      '.hermes/hooks.yaml',
      'AGENTS.md',
    ]);
  });
});
