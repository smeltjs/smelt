import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { planInstall, planRemove } from '@guard/harness/plan';
import type { HooksChoices } from '@guard/harness/plan';
import { SETUP_RECIPE } from '@guard/setup/recipe';
import { claudeCode } from '@guard/harness/claude-code';
import { grok } from '@guard/harness/grok';
import { codex } from '@guard/harness/codex';
import { HARNESSES, harnessById } from '@guard/harness/registry';

import type { GuardMutation } from './_mutations.ts';

/**
 * MCP-REGISTRATION GUARD — the registration is a profile fact, applied and removed
 * byte-faithfully, in whichever format the harness reads.
 *
 * Before the `mcp-registration` step kind, registering the server was the one setup
 * act no profile could express: the command existed in four retyped places, setup
 * could only print it, and whether `.mcp.json` already carried somebody else's
 * servers was nobody's business but luck's. Now the entry is merged in beside them —
 * and the properties this guard holds are the ones that make that safe:
 *
 *   1. an apply → remove round trip over a file that never carried the key lands
 *      byte-identical — the container this install created is lifted out with it;
 *   2. a file with the user's own servers keeps every foreign byte through both
 *      directions;
 *   3. the written entry is the recipe's command, split — never a second spelling;
 *   4. a container that is not a JSON object is skipped loudly, never merged into;
 *   5. Codex and Grok (KOT-258) carry the *TOML* sibling step kind,
 *      `toml-mcp-registration`, over `text/toml-edit.ts` — the same recipe command,
 *      the same byte-faithful contract, no "manual" caveat left standing now that
 *      setup can honestly apply it. Codex's `.codex/config.toml` also carries the
 *      unrelated `[features] hooks = true` marker block on the *same file*; the two
 *      steps must compose, not clobber each other.
 */

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `smelt-mcp-${label}-`));
}

const CHOICES: HooksChoices = {
  harnesses: [claudeCode],
  guard: true,
  statsOnStop: true,
  mapOnStart: false,
  lintOnStart: false,
  enforcement: 'deny',
  thresholdBytes: 8192,
};

/** Write every planned file whose name is `name`, as planInstall rendered it. */
function applyFile(cwd: string, name: string): string {
  const plan = planInstall(cwd, CHOICES);
  const planned = plan.files.find((file) => file.name === name);
  expect(planned, `planInstall planned no ${name}`).toBeDefined();
  const path = join(cwd, name);
  writeFileSync(path, planned!.content);
  return planned!.content;
}

describe('the mcp-registration step kind', () => {
  it('applies the recipe command to .mcp.json and removes it whole', () => {
    const cwd = scratch('roundtrip');
    try {
      applyFile(cwd, '.mcp.json');
      const written = readFileSync(join(cwd, '.mcp.json'), 'utf8');
      const parsed = JSON.parse(written) as {
        mcpServers: { smelt: { command: string; args: readonly string[] } };
      };
      expect(parsed.mcpServers.smelt).toEqual({
        command: SETUP_RECIPE.mcp.run.split(' ')[0],
        args: SETUP_RECIPE.mcp.run.split(' ').slice(1),
      });

      const removal = planRemove(cwd, [claudeCode]).find((one) => one.name === '.mcp.json');
      expect(removal, 'planRemove planned nothing for .mcp.json').toBeDefined();
      // The container existed only because we created it: the plan says delete —
      // and planRemove plans, it never writes, so the file is still on disk here.
      expect(removal!.action).toBe('delete');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps every foreign byte of a shared config, both directions', () => {
    const cwd = scratch('foreign');
    try {
      // Deliberately off-style: two-space indent mixed with four, a spaced colon,
      // a trailing comma-free but oddly-spaced entry that is nobody's business.
      const theirs = `{
    "$schema": "https://json.schemastore.org/claude-code-settings.json",
    "mcpServers": {
        "other" :  {"command" :  "uvx", "args": ["some-server"]},
        "zeta": {"command": "node", "args": ["zeta.js"]}
    }
}
`;
      writeFileSync(join(cwd, '.mcp.json'), theirs);

      const applied = applyFile(cwd, '.mcp.json');

      // Foreign bytes ride through: the other entries are character-identical.
      expect(applied).toContain('"other" :  {"command" :  "uvx", "args": ["some-server"]}');
      // And the fresh entry lands at its siblings' depth, its members one unit
      // deeper — the file's own convention, not a flattened re-render. The fixture
      // indents members by 8, so `smelt` sits at 8 and `command` at 12.
      expect(applied).toContain('\n        "smelt": {\n            "command": "npx"');
      expect(applied).toContain('"zeta": {"command": "node", "args": ["zeta.js"]}');
      const merged = JSON.parse(applied) as { mcpServers: Record<string, unknown> };
      expect(Object.keys(merged.mcpServers).toSorted()).toEqual(['other', 'smelt', 'zeta']);

      const removal = planRemove(cwd, [claudeCode]).find((one) => one.name === '.mcp.json');
      expect(removal!.action).toBe('modify');
      writeFileSync(join(cwd, '.mcp.json'), removal!.content ?? '');
      expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe(theirs);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('opencode registers under its own key and shape, derivable from the same recipe', () => {
    const cwd = scratch('opencode');
    try {
      const profile = harnessById('opencode')!;
      const plan = planInstall(cwd, { ...CHOICES, harnesses: [profile] });
      const planned = plan.files.find((file) => file.name === 'opencode.json');
      expect(planned).toBeDefined();
      const parsed = JSON.parse(planned!.content) as {
        mcp: { smelt: { type: string; command: readonly string[] } };
      };
      expect(parsed.mcp.smelt).toEqual({
        type: 'local',
        command: SETUP_RECIPE.mcp.run.split(' '),
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('skips a config whose container is not a JSON object, loudly', () => {
    const cwd = scratch('notobject');
    try {
      writeFileSync(join(cwd, '.mcp.json'), '{ "mcpServers": false }');
      const plan = planInstall(cwd, CHOICES);
      const skipped = plan.skipped.find((one) => one.name === '.mcp.json');
      expect(skipped, 'the broken container was not skipped').toBeDefined();
      expect(skipped!.why).toContain('not a JSON object');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Codex and Grok declare the TOML registration, and carry no manual caveat', () => {
    for (const profile of [codex, grok]) {
      expect(
        profile.install.some((step) => step.kind === 'toml-mcp-registration'),
        `${profile.id} must declare its TOML registration as a step, not a caveat`,
      ).toBe(true);
      expect(
        profile.caveats.some((line) => line.includes('MCP registration is manual')),
        `${profile.id} still says it is manual after KOT-258`,
      ).toBe(false);
    }
    // And every other profile either carries one of the two step kinds or is honest
    // by absence — the registry is the only list, so this walks it rather than a
    // hand-typed set.
    for (const profile of HARNESSES) {
      const jsonForm = profile.install.some((step) => step.kind === 'mcp-registration');
      const tomlForm = profile.install.some((step) => step.kind === 'toml-mcp-registration');
      expect(jsonForm && tomlForm, `${profile.id} declares both forms at once`).toBe(false);
      if (jsonForm) {
        expect(
          ['claude-code', 'opencode'],
          `${profile.id} declares a JSON registration without an adapter in this guard`,
        ).toContain(profile.id);
      }
      if (tomlForm) {
        expect(
          ['codex', 'grok'],
          `${profile.id} declares a TOML registration without an adapter in this guard`,
        ).toContain(profile.id);
      }
    }
  });

  it('a removal on a file smelt never touched is a no-op', () => {
    const cwd = scratch('untouched');
    try {
      const theirs = '{\n  "mcpServers": {\n    "other": {"command": "uvx"}\n  }\n}\n';
      writeFileSync(join(cwd, '.mcp.json'), theirs);
      const removal = planRemove(cwd, [claudeCode]).find((one) => one.name === '.mcp.json');
      expect(removal, 'nothing of ours to remove, yet a removal was planned').toBeUndefined();
      expect(readFileSync(join(cwd, '.mcp.json'), 'utf8')).toBe(theirs);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe('the toml-mcp-registration step kind (Codex, Grok)', () => {
  it('applies the recipe command to Grok’s .grok/config.toml and removes it whole', () => {
    const cwd = scratch('grok-roundtrip');
    try {
      const plan = planInstall(cwd, { ...CHOICES, harnesses: [grok] });
      const planned = plan.files.find((file) => file.name === '.grok/config.toml');
      expect(planned, 'planInstall planned no .grok/config.toml').toBeDefined();
      expect(planned!.content).toContain('[mcp_servers.smelt]');
      expect(planned!.content).toContain(`command = "${SETUP_RECIPE.mcp.run.split(' ')[0]}"`);
      const dir = join(cwd, '.grok');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.toml'), planned!.content);

      const removal = planRemove(cwd, [grok]).find((one) => one.name === '.grok/config.toml');
      expect(removal, 'planRemove planned nothing for .grok/config.toml').toBeDefined();
      expect(removal!.action).toBe('delete');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('keeps every foreign byte of a shared Grok config, both directions', () => {
    const cwd = scratch('grok-foreign');
    try {
      const dir = join(cwd, '.grok');
      mkdirSync(dir, { recursive: true });
      const theirs =
        '# grok settings\n' +
        '[mcp_servers.other]\n' +
        'command = "uvx"\n' +
        'args = ["some-server"]\n';
      writeFileSync(join(dir, 'config.toml'), theirs);

      const plan = planInstall(cwd, { ...CHOICES, harnesses: [grok] });
      const planned = plan.files.find((file) => file.name === '.grok/config.toml')!;
      expect(planned.content).toContain('# grok settings');
      expect(planned.content).toContain(
        '[mcp_servers.other]\ncommand = "uvx"\nargs = ["some-server"]',
      );
      expect(planned.content).toContain('[mcp_servers.smelt]');
      writeFileSync(join(dir, 'config.toml'), planned.content);

      const removal = planRemove(cwd, [grok]).find((one) => one.name === '.grok/config.toml')!;
      expect(removal.action).toBe('modify');
      writeFileSync(join(dir, 'config.toml'), removal.content ?? '');
      expect(readFileSync(join(dir, 'config.toml'), 'utf8')).toBe(theirs);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Codex’s [features] marker block and its TOML registration compose on one file', () => {
    // .codex/config.toml carries two independent install steps for codex: the
    // `hooks = true` marker block and the mcp_servers.smelt table. Without
    // planInstall/planRemove layering each step on the previous step's own output
    // (rather than re-reading stale disk bytes), the second step to touch this file
    // would silently discard the first — see `currentContent`/`currentText` in
    // `cli/hooks.ts`.
    const cwd = scratch('codex-compose');
    try {
      const plan = planInstall(cwd, { ...CHOICES, harnesses: [codex] });
      const planned = plan.files.find((file) => file.name === '.codex/config.toml');
      expect(planned, 'planInstall planned no .codex/config.toml').toBeDefined();
      expect(planned!.content).toContain('[features]');
      expect(planned!.content).toContain('hooks = true');
      expect(planned!.content).toContain('[mcp_servers.smelt]');
      expect(planned!.content).toContain(`command = "${SETUP_RECIPE.mcp.run.split(' ')[0]}"`);

      const dir = join(cwd, '.codex');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.toml'), planned!.content);

      const removal = planRemove(cwd, [codex]).find((one) => one.name === '.codex/config.toml');
      expect(removal, 'planRemove planned nothing for .codex/config.toml').toBeDefined();
      // Both steps' bytes are gone once both removals are applied — nothing of
      // either edit survives, but the file itself needn't be empty in general (it
      // is here, since nothing else was ever in it).
      expect(removal!.action).toBe('delete');
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
    id: 'nested-entry-renders-flat',
    file: 'text/json-edit.ts',
    find: '  const memberIndent = /\\n([ \\t]+)"/.exec(inner)?.[1] ?? style.indent + style.indent;',
    replace: '  const memberIndent = style.indent;',
    why: 'the fresh member landing at the file\u2019s top-level indent instead of beside its siblings — every nested insert would read as if it had been pasted by a different formatter, and the byte-faithful contract covers layout too',
  },
  {
    kind: 'src',
    id: 'mcp-roundtrip-leaves-an-empty-container',
    file: 'text/json-edit.ts',
    find: 'return editTopLevelProperty(text, head, undefined, style) ?? text;',
    replace: 'return text;',
    why: 'the container this install created surviving its own removal — a file that never carried the key would round-trip to {"mcpServers":{}}, and the byte-faithful contract would be a promise with a hole exactly where a schema validator looks',
  },
  {
    kind: 'src',
    id: 'mcp-entry-retyped-not-derived',
    file: 'harness/claude-code.ts',
    find: 'entry: () => ({ command: MCP_RUN_ARGS[0], args: MCP_RUN_ARGS.slice(1) }),',
    replace: "entry: () => ({ command: 'npx', args: ['example'] }),",
    why: 'the registration spelled beside the recipe instead of from it — the second owner the setup-recipe guard exists to refuse, reaching into the file a model is told to retrieve from',
  },
];
