import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SETUP_RECIPE, SETUP_STEPS } from '@guard/setup/recipe';
import { DEFAULT_STORE_DIR } from '@guard/harness/plan';
import { HARNESSES, harnessById } from '@guard/harness/registry';
import type { HarnessProfile } from '@guard/harness/profile';
import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * SETUP-RECIPE GUARD — the setup recipe is data, and it is owned once.
 *
 * The setup recipe (CONTEXT.md: the one true way to put smelt on a machine) used to
 * exist only as retyped literals and prose: the store default was written by two
 * source modules and spelled three ways across the docs — one of them wrong
 * (`.smelt-store` in the README's library example) — and the MCP registration command
 * was retyped in four places. This guard holds the two ends the way the site-facts
 * guard holds versions: the recipe module is the source, and everything that used to
 * retype a fact either imports it or is pinned to it.
 */
describe('the setup recipe is owned once', () => {
  it('carries the facts every rendering repeats', () => {
    expect(SETUP_RECIPE.store.defaultDir).toBe('.smelt/store');
    expect(SETUP_RECIPE.recommendedBudgetBytes).toBe(4000);
    expect(SETUP_RECIPE.install.library).toBe('npm install @smeltjs/core');
    expect(SETUP_RECIPE.install.globalInstall).toBe('npm install -g @smeltjs/core');
    expect(SETUP_RECIPE.install.oneShot).toBe('npx @smeltjs/core');
    expect(SETUP_RECIPE.mcp.run).toBe('npx @smeltjs/mcp');
  });

  it('carries no harness’s registration — `run` is the whole of its MCP block', () => {
    // The recipe held Claude Code's `claude mcp add …` as though it were every
    // harness's registration, and five renderings read it from there — one of them
    // printed it at somebody wiring Codex. Registration is a HarnessProfile fact now;
    // what the recipe owns is the one command true of every MCP client.
    expect(
      Object.keys(SETUP_RECIPE.mcp),
      'the recipe has grown a second MCP fact. A registration belongs to the harness ' +
        'that reads it (HarnessProfile.mcp); the recipe names no harness.',
    ).toEqual(['run']);
  });

  it('the hooks store injection reads the recipe, not its own literal', () => {
    expect(DEFAULT_STORE_DIR).toBe(SETUP_RECIPE.store.defaultDir);
  });

  it('names the steps in order, each command carried by a named fact', () => {
    expect(SETUP_STEPS.map((step) => step.id)).toEqual([
      'install',
      'init',
      'hooks',
      'mcp',
      'verify',
    ]);
    for (const step of SETUP_STEPS) {
      expect(step.command, `step ${step.id} carries no command`).toBeTruthy();
    }
    // The steps name no harness, so the MCP step names the stdio command any client
    // registers — not Claude Code's CLI verb, which is Claude Code's profile's.
    expect(SETUP_STEPS.find((step) => step.id === 'mcp')?.command).toBe(SETUP_RECIPE.mcp.run);
  });
});

/** The source trees a recipe fact must not be retyped in: both packages' and the site's. */
const SOURCE_TREES = ['packages/mcp/src', 'site/src'] as const;

/**
 * A repository file — from the repository, or from the mutation runner's scratch root
 * when it made one (which is exactly when `guardRoot()` stops being this package's own
 * root), the same arrangement the site-facts guard reads through.
 */
function repoFile(relative: string): string {
  const root = guardRoot() === packageRoot() ? repoRoot() : guardRoot();
  const staled = join(root, relative);
  return readFileSync(existsSync(staled) ? staled : join(repoRoot(), relative), 'utf8');
}

/** Core's `src`, from the scratch tree when the mutation runner made one. */
function coreSrcDir(): string {
  return guardRoot() === packageRoot()
    ? join(repoRoot(), 'packages/core/src')
    : join(guardRoot(), 'src');
}

/** Every `.ts`/`.tsx` file under a source tree, as repository-relative paths. */
function walk(relative: string): readonly string[] {
  return readdirSync(join(repoRoot(), relative), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(`${relative}/${entry.name}`)
      : /\.tsx?$/u.test(entry.name)
        ? [`${relative}/${entry.name}`]
        : [],
  );
}

/**
 * `source` with its comments blanked — block comments wholesale, any line whose first
 * non-space characters are `//`. Deliberately not a string-aware scanner: a fact
 * inside a template literal is a rendering, and a fact inside a comment is prose
 * explaining the rule — neither is a second owner.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

/** The source files, repository-relative, whose non-comment text spells `fact`. */
function filesSpelling(fact: string): readonly string[] {
  const coreTree = coreSrcDir().slice(repoRoot().length + 1);
  const files = [...walk(coreTree), ...SOURCE_TREES.flatMap((tree) => walk(tree))];
  return files.filter((relative) => withoutComments(repoFile(relative)).includes(fact)).toSorted();
}

describe('the recipe is the only place the facts are spelled', () => {
  const facts = [
    '.smelt/store',
    'npm install @smeltjs/core',
    'pnpm add @smeltjs/core',
    'bun add @smeltjs/core',
    'npm install -g @smeltjs/core',
    'npx @smeltjs/core',
    'npx @smeltjs/mcp',
    'npx skills add smeltjs/smelt',
    'brew install smeltjs/tap/smelt',
    'brew upgrade smelt',
  ] as const;

  it('each fact appears exactly once in source — inside the recipe module', () => {
    for (const fact of facts) {
      expect(
        filesSpelling(fact),
        `"${fact}" is spelled outside the recipe module. A fact with two owners has ` +
          `none: it drifts the way the store default did — three doc spellings, one of ` +
          `them wrong. Import SETUP_RECIPE, or pin the doc with this guard.`,
      ).toEqual(['packages/core/src/setup/recipe.ts']);
    }
  });

  it('Claude Code’s CLI verb is spelled once, in the profile that reads it', () => {
    // The registration left the recipe, so it needs an owner of its own or it becomes
    // the retyped literal again — in the site component, in a README-rendering module,
    // in whichever verb prints it next. Only the prefix is scanned: the tail of the
    // command is `SETUP_RECIPE.mcp.run`, interpolated rather than retyped, so that the
    // sentence a person is told to run and the server smelt wires cannot name
    // different packages.
    expect(
      filesSpelling('claude mcp add smelt --'),
      'Claude Code’s registration verb is spelled outside its own profile. A fact ' +
        'with two owners has none — this one had four.',
    ).toEqual(['packages/core/src/harness/claude-code.ts']);
  });
});

/**
 * Claude Code's registration, from the profile that owns it. The docs that show a
 * registration show *this* one — the quickstart is written for Claude Code — so the
 * README pins below read it from there rather than from the recipe, which carries no
 * harness's registration at all.
 */
function claudeCodeRegistration(): string {
  const manual = harnessById('claude-code')?.mcp?.manual;
  expect(
    manual,
    'claude-code carries no MCP manual step for the docs to be pinned to',
  ).toBeTruthy();
  return manual ?? '';
}

/**
 * Every harness whose profile writes an MCP registration — the ones that must also
 * say how a person does it by hand, because `smelt setup` prints exactly that.
 */
function registersMcp(profile: HarnessProfile): boolean {
  return profile.install.some(
    (step) => step.kind === 'mcp-registration' || step.kind === 'toml-mcp-registration',
  );
}

/**
 * What `packages/mcp/README.md` must show for each of them, restated by hand: a guard
 * that asks the source what the docs should say proves nothing. The section heading is
 * the harness's own name, and the fragments are the mechanism that harness reads.
 */
const README_SECTIONS: readonly {
  readonly id: string;
  readonly heading: string;
  readonly shows: readonly string[];
}[] = [
  {
    id: 'claude-code',
    heading: '### Claude Code',
    shows: ['claude mcp add smelt -- npx @smeltjs/mcp'],
  },
  { id: 'codex', heading: '### Codex CLI', shows: ['~/.codex/config.toml', '[mcp_servers.smelt]'] },
  { id: 'grok', heading: '### Grok CLI', shows: ['~/.grok/config.toml', '[mcp_servers.smelt]'] },
  {
    id: 'opencode',
    heading: '### opencode',
    shows: ['opencode.json', '"smelt": { "type": "local"'],
  },
];

/**
 * One harness's section of the MCP README: from its heading to the next heading that
 * closes it — the next `###`, **or** the next `##`, whichever comes first. Sliced,
 * never searched whole: `[mcp_servers.smelt]` is in both the Codex and the Grok
 * sections, so a whole-file `toContain` stays green when either of them loses it, and
 * green when a harness's snippet has moved into somebody else's section.
 *
 * The `##` half is not hypothetical. opencode is the last `###` under "Wiring it into
 * a harness", so a slice that stopped only at the next `###` ran to the end of the
 * file and quietly checked the whole document again — the exact defect this function
 * exists to fix, surviving in the one section where it is hardest to notice.
 */
function readmeSection(readme: string, heading: string): string {
  const from = readme.indexOf(`\n${heading}\n`);
  if (from === -1) return '';
  const rest = readme.slice(from + heading.length + 2);
  const ends = [rest.indexOf('\n### '), rest.indexOf('\n## ')].filter((at) => at !== -1);
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends));
}

/**
 * Every config file a manual step names — a token ending in `.json` or `.toml`, with
 * any `~/` prefix left on the front for the reader and stripped for the match. This is
 * how a manual is tied to *its own* section: the fragments above are restated by hand
 * and would stay true if a profile started naming another harness's file, and the
 * snippet lines below are shared between Codex and Grok verbatim.
 */
function filesNamedIn(manual: string): readonly string[] {
  return [...manual.matchAll(/[\w@.\-/]*\.(?:json|toml)\b/gu)].map((match) =>
    match[0].replace(/^~\//u, ''),
  );
}

/**
 * The snippet a person pastes: every line after the first, which is smelt's own
 * instruction sentence ("add this table to …"). A one-line manual is a command, and
 * the whole of it is the snippet.
 */
function snippetLines(manual: string): readonly string[] {
  const lines = manual.split('\n').filter((line) => line.trim() !== '');
  return lines.length > 1 ? lines.slice(1) : lines;
}

describe('an MCP registration is a per-harness fact, not the recipe’s one command', () => {
  it('a harness that registers carries its own manual step, and no other does', () => {
    for (const profile of HARNESSES) {
      if (registersMcp(profile)) {
        expect(
          profile.mcp?.manual,
          `${profile.id} writes an MCP registration but says nothing about how a ` +
            `person performs it — so setup would fall back to naming another ` +
            `harness's command at somebody using this one.`,
        ).toBeTruthy();
      } else {
        expect(
          profile.mcp,
          `${profile.id} claims a registration mechanism smelt never writes; the ` +
            `manual step is the by-hand spelling of the step beside it, not a survey.`,
        ).toBeUndefined();
      }
    }
  });

  it('no two harnesses print the same registration', () => {
    const manuals = HARNESSES.filter(registersMcp).map((profile) => profile.mcp?.manual ?? '');
    expect(
      new Set(manuals).size,
      `two harnesses print the same MCP step: ${manuals.join(' | ')}. One command for ` +
        `every harness is the defect — a Codex user told to run a \`claude\` verb.`,
    ).toBe(manuals.length);
  });

  it('the MCP README gives each of them its own section', () => {
    const readme = repoFile('packages/mcp/README.md');
    expect(
      README_SECTIONS.map((section) => section.id),
      'a harness gained (or lost) an MCP registration without the README following',
    ).toEqual(HARNESSES.filter(registersMcp).map((profile) => profile.id));
    for (const section of README_SECTIONS) {
      const slice = readmeSection(readme, section.heading);
      expect(slice, `no "${section.heading}" section, or it is empty`).not.toBe('');
      for (const shows of section.shows) {
        expect(slice, `the ${section.id} section no longer shows ${shows}`).toContain(shows);
      }
    }
  });

  it('a section ends where the next heading starts, including the next `##`', () => {
    // opencode is the last `###` in "Wiring it into a harness", so its slice is the
    // one that runs to the end of the file when only `###` closes a section — and a
    // slice that is the whole document makes every assertion above vacuous.
    const readme = repoFile('packages/mcp/README.md');
    const opencode = readmeSection(readme, '### opencode');
    expect(opencode, 'the opencode section is empty').not.toBe('');
    expect(
      opencode,
      "the opencode slice runs past its own section into the README's later `##` " +
        'headings, so every fragment asserted against it is really being asserted ' +
        'against the whole document',
    ).not.toContain('One store with the CLI');
    // And the section really is the last `###`: if a later one is added, the case
    // above stops testing what it says it tests.
    expect(readme.slice(readme.indexOf('### opencode'))).not.toContain('\n### ');
  });

  it('each manual step is the mechanism its own README section documents', () => {
    // The project spelling is the one the README documents; the machine spelling is
    // asserted where it is read, in `test/guards/install-scope.test.ts`'s receipt.
    const readme = repoFile('packages/mcp/README.md');
    for (const section of README_SECTIONS) {
      const profile = HARNESSES.find((one) => one.id === section.id);
      const manual = profile?.mcp?.manual ?? '';
      const slice = readmeSection(readme, section.heading);
      for (const file of filesNamedIn(manual)) {
        expect(
          slice,
          `${section.id}'s manual step names ${file}, which its own README section ` +
            `does not — either the profile is naming another harness's config file, ` +
            `or the section it is documented in has moved.`,
        ).toContain(file);
      }
      for (const line of snippetLines(manual)) {
        expect(
          slice,
          `${section.id}'s manual step tells a person to paste "${line}", which is ` +
            `not in its README section — the snippet and the doc that owns it have ` +
            `drifted apart.`,
        ).toContain(line);
      }
    }
  });
});

describe('the docs stay pinned to the recipe', () => {
  it('the README spells the commands the recipe carries — and no longer the typo', () => {
    const readme = repoFile('README.md');
    const lines = readme.split('\n').map((line) => line.trim());
    expect(lines, 'the README no longer shows the global install the recipe carries').toContain(
      SETUP_RECIPE.install.globalInstall,
    );
    expect(
      lines,
      'the README no longer shows the MCP registration Claude Code’s profile carries',
    ).toContain(claudeCodeRegistration());
    expect(readme).toContain(SETUP_RECIPE.store.defaultDir);
    // The distribution and update narrative, pinned to the recipe the same way:
    const setupLine = `${SETUP_RECIPE.install.oneShot} setup --yes --harness claude-code --json`;
    expect(lines, 'the README quickstart no longer teaches the agent setup line').toContain(
      setupLine,
    );
    expect(lines).toContain(SETUP_RECIPE.install.skillInstall);
    expect(lines).toContain(SETUP_RECIPE.install.brewInstall);
    for (const command of ['smelt setup', 'smelt doctor']) {
      expect(lines, `the README update loop no longer names \`${command}\``).toContain(command);
    }
    expect(
      readme.includes('.smelt-store'),
      'the README spells the store default `.smelt-store` — the typo the recipe exists ' +
        'to make unrepresentable; derive or pin, never retype',
    ).toBe(false);
  });

  it('the MCP README spells the run and registration commands the recipe carries', () => {
    const readme = repoFile('packages/mcp/README.md');
    const lines = readme.split('\n').map((line) => line.trim());
    expect(lines).toContain(claudeCodeRegistration());
    expect(readme).toContain(SETUP_RECIPE.mcp.run);
    expect(readme).toContain(SETUP_RECIPE.store.defaultDir);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    id: 'mcp-manual-names-another-harness-file',
    file: 'harness/grok.ts',
    find: '  mcp: tomlMcpManual(CONFIG_TOML),',
    replace: "  mcp: tomlMcpManual('.codex/config.toml'),",
    why: 'one harness’s manual MCP step naming another harness’s config file — the shape of the defect this fact exists to end, where a user is told to edit a file the harness they run never reads',
  },
  {
    kind: 'artifact',
    id: 'recipe-store-default-renamed',
    file: 'src/setup/recipe.ts',
    find: "defaultDir: '.smelt/store'",
    replace: "defaultDir: '.smelt/stash'",
    why: 'the recipe quietly pointing every install at a store directory nothing else names — the init suggestion and the hooks injection follow it, so the drift would be invisible until a retrieve could not find its bytes',
  },
  {
    kind: 'artifact',
    id: 'site-retypes-the-mcp-command',
    file: 'site/src/components/Harness.tsx',
    find: 'const MCP_CMD = facts.recipe.mcpRegister;',
    replace: `const MCP_CMD = 'claude mcp add smelt -- npx @smeltjs/mcp';`,
    why: 'a recipe fact retyped into a component — the exact second-owner shape the exactly-once scan exists to refuse, and the shape the registration command was found in across four files',
  },
  {
    kind: 'artifact',
    id: 'readme-mcp-command-drifts',
    file: 'packages/mcp/README.md',
    find: 'claude mcp add smelt -- npx @smeltjs/mcp',
    replace: 'claude mcp add smelt -- npx @smeltjs/mcp@latest',
    why: 'the pinned MCP README letting the registration command drift from the recipe — the pin is the outside witness, so it must go red when the prose stops saying what the module says (the repository README pin is the same assertion, pointed at the root file)',
  },
];
