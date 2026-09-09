import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SETUP_RECIPE, SETUP_STEPS } from '@guard/setup/recipe';
import { DEFAULT_STORE_DIR } from '@guard/harness/plan';
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
    expect(SETUP_RECIPE.mcp.register).toBe('claude mcp add smelt -- npx @smeltjs/mcp');
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
    expect(SETUP_STEPS.find((step) => step.id === 'mcp')?.command).toBe(SETUP_RECIPE.mcp.register);
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
    'claude mcp add smelt -- npx @smeltjs/mcp',
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
});

describe('the docs stay pinned to the recipe', () => {
  it('the README spells the commands the recipe carries — and no longer the typo', () => {
    const readme = repoFile('README.md');
    const lines = readme.split('\n').map((line) => line.trim());
    expect(lines, 'the README no longer shows the global install the recipe carries').toContain(
      SETUP_RECIPE.install.globalInstall,
    );
    expect(lines, 'the README no longer shows the MCP registration the recipe carries').toContain(
      SETUP_RECIPE.mcp.register,
    );
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
    expect(lines).toContain(SETUP_RECIPE.mcp.register);
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
