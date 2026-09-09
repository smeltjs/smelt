import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUsageError } from '../src/errors.ts';
import { parseConfig } from '../src/cli/config.ts';
import {
  planInstall,
  presetToggles,
  runHooks,
  SNIPPET_END_MD,
  SNIPPET_START_MD,
} from '../src/cli/hooks.ts';
import { harnessById } from '../src/harness/registry.ts';
import type { SmeltInvocation } from '../src/hooks/invocation.ts';
import { runInit } from '../src/cli/init.ts';
import { EXIT, runCli } from '../src/cli/run.ts';

/**
 * The `smelt hooks` installer, driven entirely in-process — the same pattern as
 * `test/init.test.ts`: scripted answers in, files and transcript out. Fresh install,
 * re-run toggle editing, declines, merges that must preserve other people's config,
 * and the remove path.
 */

let dir: string;
let home: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-hooks-'));
  home = mkdtempSync(join(tmpdir(), 'smelt-hooks-home-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

interface WizardRun {
  readonly code: number;
  readonly output: string;
}

async function hooks(
  action: 'install' | 'remove',
  harness: string | undefined,
  answers: readonly string[],
): Promise<WizardRun> {
  let output = '';
  const code = await runHooks(action, harness, {
    input: Readable.from([`${answers.join('\n')}\n`]),
    output: (text) => {
      output += text;
    },
    cwd: dir,
    home,
  });
  return { code, output };
}

/** guard on, stats on, map off, lint off, deny, 8192 — Enter every step, then confirm. */
const DEFAULT_ANSWERS = ['', '', '', '', '', '', 'yes'];

function readJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>;
}

describe('a fresh claude-code install', () => {
  it('writes the config, the settings hooks, and the CLAUDE.md snippet — and all of it parses', async () => {
    const { code, output } = await hooks('install', 'claude-code', DEFAULT_ANSWERS);
    expect(code).toBe(0);
    expect(output).toContain('Nothing has been written yet');

    // smelt.config.json: the guard's settings, strict-parseable by the CLI itself.
    const config = parseConfig(
      readFileSync(join(dir, 'smelt.config.json'), 'utf8'),
      join(dir, 'smelt.config.json'),
    );
    expect(config.hooks).toEqual({ thresholdBytes: 8192, enforcement: 'deny' });
    // A directory store is written when the config had none: every deny reason and
    // the snippet teach `smelt retrieve <hash>`, which refuses a memory store.
    expect(config.store).toEqual({ kind: 'directory', path: '.smelt/store' });

    // .claude/settings.json: guard on both matchers, stats on Stop, no map (opt-in).
    const settings = readJson('.claude/settings.json');
    const events = settings['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(events).toSorted()).toEqual(['PreToolUse', 'Stop']);
    expect(events['PreToolUse']).toHaveLength(2);
    const rendered = JSON.stringify(events);
    expect(rendered).toContain('hooks/shims/claude-code.js');
    expect(rendered).toContain('stats');
    expect(rendered).not.toContain('SessionStart');

    // CLAUDE.md: the belt-and-braces snippet, marker-bracketed, teaching retrieve.
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain(SNIPPET_START_MD);
    expect(claudeMd).toContain(SNIPPET_END_MD);
    expect(claudeMd).toContain('smelt retrieve <hash>');
  });

  it('map-on-start is opt-in: switching it on writes the SessionStart hook with the matcher', async () => {
    await hooks('install', 'claude-code', ['', '', 'on', '', '', '', 'yes']);
    const events = readJson('.claude/settings.json')['hooks'] as Record<string, unknown>;
    expect(JSON.stringify(events['SessionStart'])).toContain('startup|resume|clear|compact');
    expect(JSON.stringify(events['SessionStart'])).toContain('map . --budget');
  });

  it('declining the final confirm writes nothing at all', async () => {
    const { output } = await hooks('install', 'claude-code', ['', '', '', '', '', '', 'no']);
    expect(output).toContain('Nothing was written');
    expect(existsSync(join(dir, 'smelt.config.json'))).toBe(false);
    expect(existsSync(join(dir, '.claude'))).toBe(false);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
  });

  it('an unknown --harness is a usage error naming the known ids', async () => {
    await expect(hooks('install', 'clod-code', DEFAULT_ANSWERS)).rejects.toThrow(CliUsageError);
    await expect(hooks('install', 'clod-code', DEFAULT_ANSWERS)).rejects.toThrow(/claude-code/);
  });

  it('an existing defaultBudgetBytes flows into the suggestion budget and the snippet', async () => {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 4000 })}\n`,
    );
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);
    const config = parseConfig(
      readFileSync(join(dir, 'smelt.config.json'), 'utf8'),
      join(dir, 'smelt.config.json'),
    );
    expect(config.defaultBudgetBytes).toBe(4000); // carried through, not dropped
    expect(config.hooks).toBeDefined();
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain('--budget 4000');
  });

  it("an explicit memory store is respected — the installer edits the user's choice for nobody", async () => {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, store: { kind: 'memory' } })}\n`,
    );
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);
    const config = parseConfig(readFileSync(join(dir, 'smelt.config.json'), 'utf8'), 'x');
    expect(config.store).toEqual({ kind: 'memory' });
  });
});

describe("merging never clobbers other people's config", () => {
  it('preserves foreign settings.json keys and foreign hook entries, replacing only ours', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const foreign = {
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'echo mine' }] }],
        PostToolUse: [{ hooks: [{ type: 'command', command: 'echo after' }] }],
      },
    };
    writeFileSync(join(dir, '.claude/settings.json'), `${JSON.stringify(foreign, null, 2)}\n`);

    // settings.json exists → the per-file consent question appears; answer yes.
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);

    const settings = readJson('.claude/settings.json');
    expect(settings['permissions']).toEqual({ allow: ['Bash(ls:*)'] });
    const events = settings['hooks'] as Record<string, unknown[]>;
    expect(JSON.stringify(events['PostToolUse'])).toContain('echo after');
    expect(JSON.stringify(events['PreToolUse'])).toContain('echo mine');
    expect(
      events['PreToolUse']!.filter((entry) => JSON.stringify(entry).includes('hooks/shims/')),
    ).toHaveLength(2);
  });

  it('merging is byte-faithful outside the hooks key: 4-space indentation, escapes and number forms survive', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    // Not the installer's own 2-space style, and with spellings JSON.stringify would
    // normalize: re-serializing the whole file would rewrite all of it.
    const foreign =
      '{\n' +
      '    "permissions": {\n' +
      '        "allow": ["Bash(ls:*)"]\n' +
      '    },\n' +
      '    "env": {\n' +
      '        "FOO": "a\\u0041b"\n' +
      '    },\n' +
      '    "num": 1e3\n' +
      '}\n';
    writeFileSync(join(dir, '.claude/settings.json'), foreign);

    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);

    const written = readFileSync(join(dir, '.claude/settings.json'), 'utf8');
    // Every foreign byte rides through verbatim — indentation, escape, number form.
    expect(written).toContain('    "permissions": {\n        "allow": ["Bash(ls:*)"]\n    }');
    expect(written).toContain('"a\\u0041b"');
    expect(written).toContain('1e3');
    expect(written).toContain('hooks/shims/claude-code.js');
    expect(JSON.parse(written)).toMatchObject({ num: 1000 });

    // And remove restores the original bytes exactly.
    await hooks('remove', 'claude-code', ['yes', 'yes', 'yes', 'yes']);
    expect(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).toBe(foreign);
  });

  it("a foreign hook whose command merely ends in cli/bin.js is not smelt's — remove keeps it", async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const foreignEntry = {
      matcher: 'Write',
      hooks: [{ type: 'command', command: 'node /opt/other-cli/dist/cli/bin.js check' }],
    };
    writeFileSync(
      join(dir, '.claude/settings.json'),
      `${JSON.stringify({ hooks: { PreToolUse: [foreignEntry] } }, null, 2)}\n`,
    );
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);
    await hooks('remove', 'claude-code', ['yes', 'yes', 'yes', 'yes']);
    const settings = readJson('.claude/settings.json');
    // The consent shown was "remove smelt entries, keep the rest" — a generic
    // cli/bin.js substring must not classify somebody else's hook as smelt's.
    expect(JSON.stringify(settings['hooks'])).toContain('/opt/other-cli/dist/cli/bin.js');
  });

  it('a settings.json it cannot parse is SKIPPED, listed as such, and left byte-identical', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(join(dir, '.claude/settings.json'), 'not json {');
    const { output } = await hooks('install', 'claude-code', DEFAULT_ANSWERS);
    expect(output).toContain('SKIPPED');
    expect(readFileSync(join(dir, '.claude/settings.json'), 'utf8')).toBe('not json {');
  });

  it('appends the snippet to an existing CLAUDE.md (with consent) instead of replacing it', async () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# My project\n\nHand-written rules.\n');
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);
    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('Hand-written rules.');
    expect(claudeMd).toContain(SNIPPET_START_MD);
  });
});

describe('a re-run edits toggles instead of duplicating entries', () => {
  it('turning map on and stats off on a second run updates the same file, no duplicates', async () => {
    await hooks('install', 'claude-code', DEFAULT_ANSWERS);
    // Second run: keep guard, stats off, map on. Existing files → consent per file.
    await hooks('install', 'claude-code', [
      '',
      'off',
      'on',
      '',
      '',
      '',
      'yes',
      'yes',
      'yes',
      'yes',
    ]);
    const events = readJson('.claude/settings.json')['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(events).toSorted()).toEqual(['PreToolUse', 'SessionStart']);
    expect(events['PreToolUse']).toHaveLength(2); // replaced, not appended

    // Third run presets from what is installed: Enter-through keeps map on.
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes', 'yes', 'yes']);
    const again = readJson('.claude/settings.json')['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(again).toSorted()).toEqual(['PreToolUse', 'SessionStart']);
  });
});

describe('smelt hooks remove', () => {
  it('strips our entries, keeps everything foreign, and deletes files that were entirely ours', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      join(dir, '.claude/settings.json'),
      `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`,
    );
    writeFileSync(join(dir, 'CLAUDE.md'), '# Mine\n');
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes', 'yes']);

    const { output } = await hooks('remove', 'claude-code', ['yes', 'yes', 'yes', 'yes']);
    expect(output).toContain('left untouched'); // the config stays; it says so

    const settings = readJson('.claude/settings.json');
    expect(settings['permissions']).toEqual({ allow: ['Bash(ls:*)'] });
    expect(settings['hooks']).toBeUndefined();

    const claudeMd = readFileSync(join(dir, 'CLAUDE.md'), 'utf8');
    expect(claudeMd).toContain('# Mine');
    expect(claudeMd).not.toContain(SNIPPET_START_MD);

    // The config's hooks block survives — removing wiring is not editing settings.
    expect(
      parseConfig(readFileSync(join(dir, 'smelt.config.json'), 'utf8'), 'x').hooks,
    ).toBeDefined();
  });

  it('deletes a CLAUDE.md that was entirely ours, and reports nothing to do on a clean tree', async () => {
    await hooks('install', 'claude-code', DEFAULT_ANSWERS);
    await hooks('remove', 'claude-code', ['yes', 'yes', 'yes', 'yes']);
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false);

    const { output } = await hooks('remove', undefined, []);
    expect(output).toContain("nothing of smelt's found");
  });

  it('a per-file no leaves that file alone', async () => {
    await hooks('install', 'claude-code', DEFAULT_ANSWERS);
    await hooks('remove', 'claude-code', ['yes', 'no', 'no', 'no', 'no']);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(true);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain(SNIPPET_START_MD);
  });
});

describe('the other tiers write what their matrix row supports', () => {
  it('codex (verified): hooks.json mirrors the claude shape, config.toml gains the marker block', async () => {
    await hooks('install', 'codex', DEFAULT_ANSWERS);
    const events = readJson('.codex/hooks.json')['hooks'] as Record<string, unknown[]>;
    expect(JSON.stringify(events['PreToolUse'])).toContain('hooks/shims/codex.js');
    const toml = readFileSync(join(dir, '.codex/config.toml'), 'utf8');
    expect(toml).toContain('[features]');
    expect(toml).toContain('hooks = true');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(SNIPPET_START_MD);
  });

  it('codex: an existing config.toml with its own [features] table is skipped, never broken', async () => {
    mkdirSync(join(dir, '.codex'), { recursive: true });
    writeFileSync(join(dir, '.codex/config.toml'), '[features]\nsomething = true\n');
    // Declining the [features] marker block doesn't excuse the *separate*
    // mcp_servers.smelt registration step, which also targets this pre-existing
    // file and asks its own per-file consent — decline that too, so this test's own
    // claim ("skipped, never broken") stays literally true.
    const { output } = await hooks('install', 'codex', [...DEFAULT_ANSWERS, 'no']);
    expect(output).toContain('SKIPPED');
    expect(readFileSync(join(dir, '.codex/config.toml'), 'utf8')).toBe(
      '[features]\nsomething = true\n',
    );
  });

  it('experimental harnesses are labelled as such in the plan output', async () => {
    const { output } = await hooks('install', 'gemini', DEFAULT_ANSWERS);
    expect(output).toContain('[experimental]');
    expect(output).toContain('not yet smoke-tested');
    const events = readJson('.gemini/settings.json')['hooks'] as Record<string, unknown[]>;
    expect(JSON.stringify(events['BeforeTool'])).toContain('hooks/shims/gemini.js');
    expect(readFileSync(join(dir, 'GEMINI.md'), 'utf8')).toContain(SNIPPET_START_MD);
  });

  it('opencode: the plugin file carries the matrix caveat and imports the guard core', async () => {
    const { output } = await hooks('install', 'opencode', DEFAULT_ANSWERS);
    const pluginPath = join(dir, '.opencode/plugin/smelt-guard.js');
    const plugin = readFileSync(pluginPath, 'utf8');
    expect(plugin).toContain('tool.execute.before');
    expect(plugin).toContain('hooks/guard-core.js');
    expect(plugin).toContain('sst/opencode#2319');
    expect(output).toContain('sst/opencode#2319'); // caveat carried into installer output
    // It is generated JavaScript, spliced from constants — so it is also the one file
    // here that a template typo turns into a syntax error at somebody's session start.
    const { spawnSync } = await import('node:child_process');
    const checked = spawnSync(process.execPath, ['--check', pluginPath], { encoding: 'utf8' });
    expect(checked.status, checked.stderr).toBe(0);
  });

  it('cline: the hook wrapper is executable and execs the cline shim', async () => {
    await hooks('install', 'cline', DEFAULT_ANSWERS);
    const hook = join(dir, '.clinerules/hooks/PreToolUse');
    expect(readFileSync(hook, 'utf8')).toContain('hooks/shims/cline.js');
    // eslint-style bit check: 0o111 — some execute bit set.
    const { statSync } = await import('node:fs');
    expect(statSync(hook).mode & 0o111).not.toBe(0);
  });

  it('advisory harnesses say the honest thing: instructions only, nothing enforced', async () => {
    const { output } = await hooks('install', 'aider', DEFAULT_ANSWERS);
    expect(output).toContain('[advisory]');
    expect(output).toContain('nothing enforces them');
    expect(readFileSync(join(dir, 'CONVENTIONS.md'), 'utf8')).toContain(SNIPPET_START_MD);
    expect(output).toContain('.aider.conf.yml'); // the manual read: step, said out loud

    await hooks('install', 'kilocode', DEFAULT_ANSWERS);
    const rules = readFileSync(join(dir, '.kilocode/rules/smelt.md'), 'utf8');
    expect(rules).toContain('advisory');
    expect(rules).toContain('kilocode#5827');
  });
});

/**
 * The non-interactive interface. It is the same plan and the same apply loop the
 * wizard drives — what differs is who consents (`Consent` in cli/hooks.ts) — so these
 * cases are about the parts that are genuinely its own: the toggles, the refusals,
 * and the one file shape a policy run may not write.
 */
describe('smelt hooks install --yes', () => {
  async function yes(
    action: 'install' | 'remove',
    harness: string | undefined,
    toggles: Record<string, boolean> = {},
  ): Promise<WizardRun> {
    let output = '';
    const code = await runHooks(action, harness, {
      output: (text) => {
        output += text;
      },
      cwd: dir,
      home,
      yes: true,
      toggles,
    });
    return { code, output };
  }

  it("applies with no stream at all, at the wizard's own defaults", async () => {
    const { code, output } = await yes('install', 'claude-code');
    expect(code).toBe(0);
    expect(output).toContain('toggles: guard on, stats on, map off, lint off');
    const events = readJson('.claude/settings.json')['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(events).toSorted()).toEqual(['PreToolUse', 'Stop']);
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toContain(SNIPPET_START_MD);
  });

  it('a toggle flag wins over the default, and a re-run keeps what is installed', async () => {
    await yes('install', 'claude-code', { mapOnStart: true });
    expect(JSON.stringify(readJson('.claude/settings.json')['hooks'])).toContain('map . --budget');

    // No --map on the second run: "absent" means as installed, not off.
    const { output } = await yes('install', 'claude-code');
    expect(output).toContain('map on');
    expect(JSON.stringify(readJson('.claude/settings.json')['hooks'])).toContain('map . --budget');
  });

  it('refuses a file it would have to write whole, and says which', async () => {
    mkdirSync(join(dir, '.opencode/plugin'), { recursive: true });
    const plugin = join(dir, '.opencode/plugin/smelt-guard.js');
    writeFileSync(plugin, 'export const theirs = true;\n');

    const { code, output } = await yes('install', 'opencode');
    expect(code).toBe(0);
    expect(readFileSync(plugin, 'utf8')).toBe('export const theirs = true;\n');
    expect(output).toContain('smelt-guard.js');
    expect(output).toContain('written whole');
    // The merged file beside it was still installed: one refusal is not a halt.
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain(SNIPPET_START_MD);
  });

  it('remove --yes takes it back out with no confirm and no per-file question', async () => {
    await yes('install', 'claude-code');
    const { code, output } = await yes('remove', 'claude-code');
    expect(code).toBe(0);
    expect(output).not.toContain('confirm (yes / no)');
    expect(existsSync(join(dir, 'CLAUDE.md'))).toBe(false);
    expect(existsSync(join(dir, '.claude/settings.json'))).toBe(false);
  });

  it('names --harness when nothing is detected and nothing was named', async () => {
    await expect(yes('install', undefined)).rejects.toThrow(CliUsageError);
    await expect(yes('install', undefined)).rejects.toThrow(/--harness/);
  });
});

/**
 * Without `--yes`, the same four flags pre-answer the wizard's questions: they set
 * what Enter accepts, rather than being a second, silent way to install.
 */
describe('a toggle takes on or off, and says so when it does not get one', () => {
  async function refusal(argv: readonly string[]): Promise<{ code: number; stderr: string }> {
    let stderr = '';
    const code = await runCli(argv, {
      stdout: () => {},
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      home,
    });
    return { code, stderr };
  }

  it.each([
    ['hooks', ['hooks', 'install', '--yes', '--harness', 'claude-code']],
    ['setup', ['setup', '--yes', '--json', '--harness', 'claude-code']],
  ])('%s names the flag and both values', async (_verb, base) => {
    for (const flag of ['guard', 'stats', 'map', 'lint']) {
      const { code, stderr } = await refusal([...base, `--${flag}`, 'yes']);
      expect(code, flag).toBe(EXIT.usage);
      expect(stderr, flag).toContain(`--${flag}`);
      expect(stderr, flag).toContain('on or off');
      expect(stderr, flag).toContain('"yes"');
    }
  });

  it('the two verbs mean the same thing by the same word', async () => {
    // Not a tautology: the flags are parsed twice, once per verb, and `on` meaning
    // one thing to setup and another to hooks is exactly what one owner prevents.
    const code = await runCli(['setup', '--yes', '--harness', 'claude-code', '--map', 'on'], {
      stdout: () => {},
      stderr: () => {},
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      home,
    });
    expect(code).toBe(EXIT.ok);
    const fromSetup = JSON.stringify(readJson('.claude/settings.json')['hooks']);
    // Only the settings file goes: the config setup wrote stays, so the two runs
    // plan against the same budget and the only variable left is the flag.
    rmSync(join(dir, '.claude'), { recursive: true, force: true });
    await runHooks('install', 'claude-code', {
      output: () => {},
      cwd: dir,
      home,
      yes: true,
      toggles: { mapOnStart: true },
    });
    expect(JSON.stringify(readJson('.claude/settings.json')['hooks'])).toBe(fromSetup);
  });
});

describe('the toggle flags pre-answer the wizard', () => {
  it('Enter through every step takes the flag values, not the built-in defaults', async () => {
    let output = '';
    await runHooks('install', 'claude-code', {
      input: Readable.from([`${['', '', '', '', '', '', 'yes'].join('\n')}\n`]),
      output: (text) => {
        output += text;
      },
      cwd: dir,
      home,
      toggles: { statsOnStop: false, lintOnStart: true },
    });
    expect(output).toContain('stats on Stop? (on/off) [off]');
    expect(output).toContain('instruction-file lint on SessionStart? (on/off) [on]');
    const events = readJson('.claude/settings.json')['hooks'] as Record<string, unknown[]>;
    expect(Object.keys(events).toSorted()).toEqual(['PreToolUse', 'SessionStart']);
    expect(JSON.stringify(events['SessionStart'])).toContain('agents lint .');
  });
});

describe('harness detection', () => {
  it('with no --harness, detected harnesses (project or home config dirs) are preselected', async () => {
    mkdirSync(join(dir, '.claude'), { recursive: true });
    mkdirSync(join(home, '.codex'), { recursive: true });
    const { output } = await hooks('install', undefined, ['', '', '', '', '', '', '', 'yes']);
    expect(output).toContain('* claude-code');
    expect(output).toContain('* codex');
    expect(output).toContain('Enter = claude-code,codex');
  });

  it('with nothing detected and nothing chosen, it does nothing and says so', async () => {
    const { output } = await hooks('install', undefined, ['', '', '', '', '', '', '']);
    expect(output).toContain('No harness selected');
    expect(existsSync(join(dir, 'smelt.config.json'))).toBe(false);
  });
});

describe('smelt init keeps the hooks block', () => {
  it('an init edit re-run over a config with hooks preserves the block verbatim', async () => {
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 4000 })}\n`,
    );
    await hooks('install', 'claude-code', ['', '', '', '', '', '', 'yes', 'yes']);
    let output = '';
    await runInit({
      input: Readable.from(['done\nyes\nyes\n']),
      output: (text) => {
        output += text;
      },
      cwd: dir,
    });
    expect(output).toContain('wrote');
    const config = parseConfig(readFileSync(join(dir, 'smelt.config.json'), 'utf8'), 'x');
    expect(config.hooks).toEqual({ thresholdBytes: 8192, enforcement: 'deny' });
    expect(config.defaultBudgetBytes).toBe(4000);
  });
});

/**
 * Which spelling a written command gets, and the reader that has to recognise both.
 *
 * A hook entry outlives the process that wrote it, so the installer asks
 * `hooks/invocation.ts` how smelt is re-invoked on this machine and writes that. The
 * invocation is injected here rather than read off the developer's PATH, because a
 * machine with a global `smelt` and a machine without it would otherwise run
 * different halves of this file.
 */
describe('the lifecycle hooks take the invocation this machine has', () => {
  const ON_PATH: SmeltInvocation = {
    kind: 'path',
    command: 'smelt',
    bin: '/usr/local/bin/smelt',
    stable: true,
    why: 'test fixture',
  };
  const VIA_NODE: SmeltInvocation = {
    kind: 'node',
    command: 'node "/pkg/dist/cli/bin.js"',
    script: '/pkg/dist/cli/bin.js',
    bin: '/pkg/dist/cli/bin.js',
    stable: true,
    why: 'test fixture',
  };
  /**
   * A keg under a prefix that does not exist, so `<prefix>/opt/smelt` cannot resolve
   * to it on any machine — the "unstable" verdict without a Homebrew fixture, and
   * without the developer's own `/opt/homebrew/opt/smelt` deciding the outcome.
   */
  const BROKEN_KEG_DIST =
    '/opt/nonexistent-brew/Cellar/smelt/0.0.0-fixture/libexec/lib/node_modules/@smeltjs/core/dist';

  function planWith(
    invocation: SmeltInvocation,
    distDir?: string,
  ): {
    settings: string;
    notes: readonly string[];
  } {
    const plan = planInstall(dir, {
      harnesses: [harnessById('claude-code')!],
      guard: true,
      statsOnStop: true,
      mapOnStart: true,
      lintOnStart: true,
      enforcement: 'deny',
      thresholdBytes: 8192,
      invocation,
      ...(distDir === undefined ? {} : { distDir }),
    });
    const settings = plan.files.find((file) => file.name === '.claude/settings.json');
    expect(settings, 'the claude-code plan must write .claude/settings.json').toBeDefined();
    return { settings: settings!.content, notes: plan.notes };
  }

  it('a `smelt` on PATH is written as one word, token and all', () => {
    const { settings } = planWith(ON_PATH);
    expect(settings).toContain('smelt stats 2>/dev/null || true # smelt:hooks');
    expect(settings).toContain(
      'smelt map . --budget 8000 --cache .smelt/tags 2>/dev/null || true # smelt:hooks',
    );
    expect(settings).toContain('smelt agents lint . 2>/dev/null || true # smelt:hooks');
    // The guard hook is never a bin call: a shim is a script `smelt` has no verb for.
    expect(settings).toContain('node \\"');
    expect(settings).toContain('hooks/shims/claude-code.js');
  });

  it('no `smelt` on PATH keeps the node spelling, exactly as before', () => {
    const { settings } = planWith(VIA_NODE);
    expect(settings).toContain(
      'node \\"/pkg/dist/cli/bin.js\\" stats 2>/dev/null || true # smelt:hooks',
    );
    expect(settings).toContain('node \\"/pkg/dist/cli/bin.js\\" map . --budget 8000');
    expect(settings).toContain('node \\"/pkg/dist/cli/bin.js\\" agents lint .');
  });

  it('an unstable path is written *and said out loud* — the plan never hides it', () => {
    const { settings, notes } = planWith({
      kind: 'node',
      command: `node "${BROKEN_KEG_DIST}/cli/bin.js"`,
      script: `${BROKEN_KEG_DIST}/cli/bin.js`,
      bin: `${BROKEN_KEG_DIST}/cli/bin.js`,
      stable: false,
      why: 'a versioned path that the next upgrade deletes',
    });
    expect(settings).toContain('/Cellar/');
    expect(notes.join('\n')).toContain('hook command uses an unstable path');
    expect(notes.join('\n')).toContain('re-run setup after upgrading');
  });

  it('the guard shim path is judged on its own, not on the invocation value', () => {
    // The defect this case exists for: `stable` is true whenever `smelt` is on PATH,
    // so judging the *invocation* left the guard hook — the security-relevant one —
    // written as a bare keg path with nothing said about it.
    const { settings, notes } = planWith(ON_PATH, BROKEN_KEG_DIST);
    expect(ON_PATH.stable, 'the invocation itself is stable — that is the trap').toBe(true);
    expect(settings).toContain('/opt/nonexistent-brew/Cellar/smelt/0.0.0-fixture/');
    expect(notes.join('\n')).toContain('hook command uses an unstable path');
    expect(notes.join('\n')).toContain('re-run setup after upgrading');
    // And the stable case stays quiet: no note invented for an ordinary install.
    expect(planWith(ON_PATH).notes.join('\n')).not.toContain('unstable path');
  });

  it('a PATH `smelt` that is not this install is written down as a note', () => {
    const { notes } = planWith({
      ...ON_PATH,
      caveat: 'the `smelt` on PATH (/usr/local/bin/smelt) does not resolve to this install',
    });
    expect(notes.join('\n')).toContain('does not resolve to this install');
  });

  it('presetToggles reads its own toggles back from both spellings', () => {
    for (const invocation of [ON_PATH, VIA_NODE]) {
      const { settings } = planWith(invocation);
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'settings.json'), settings);
      expect(presetToggles(dir), invocation.kind).toEqual({
        guard: true,
        statsOnStop: true,
        mapOnStart: true,
        lintOnStart: true,
      });
      rmSync(join(dir, '.claude'), { recursive: true, force: true });
    }
  });
});
