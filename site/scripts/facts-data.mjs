#!/usr/bin/env node
/**
 * Law 4 at build time, for the facts the packages own.
 *
 * The site is a separate app in the same repo, and it had no dependency on the packages
 * it describes — so every package fact was retyped into a React component: three
 * version strings, the harness tier table, the guard tally, the grammar count. They
 * went stale exactly the way retyped facts do, silently and at the worst moment: the
 * deployed page advertised `@smeltjs/core v0.2.0 · @smeltjs/mcp v0.1.0` while 0.3.0 and
 * 0.2.0 were on npm. Nothing could have caught it. Root `verify` filters
 * `./packages/**`, and the deploy workflow only triggered on `site/**`, so a release
 * could neither make the site red nor rebuild it.
 *
 * This is the fix, and it is `bench-data.mjs`'s seam: read the sources, write one JSON
 * file under `src/generated/`, and **fail the build** when a source is missing or
 * unparseable rather than shipping a fact nobody measured. Every component that typed
 * one of these imports the JSON.
 *
 * The sources, in order:
 *
 *   - `packages/core/package.json` and `packages/mcp/package.json` — the versions. The
 *     manifests are the *repository's* record of the release, not npm's: what this
 *     guarantees is that the page says what the manifests say, character for character
 *     (`packages/core/test/guards/site-facts.test.ts` pins that), which is the drift
 *     that was live. It cannot guarantee the version is published — a version bump
 *     merged before `npm publish` deploys a page naming a release that is on no
 *     registry yet, and nothing here can see that. Publish, then merge the bump; the
 *     window is the length of that gap.
 *   - `HARNESS_PROFILES`, through `harnessesByTier()` — the tier table, grouped by
 *     `HarnessProfile.tier` with `TIER_HONESTY`'s line per tier.
 *   - `structuralLanguages()` and `WASM_BY_LANGUAGE` — which languages the structural
 *     planner claims, and how many grammars ride in the tarball.
 *   - `guards.json` — the mutation tally, written by `scripts/mutate.mjs` and refused
 *     by it when stale.
 *
 * The three registry facts come from the **built** package (`@smeltjs/core`, a
 * `workspace:*` devDependency), so `pnpm --filter "@smeltjs/site..." build` builds the
 * core first. No network, no key: this reads the repository and nothing else.
 *
 * `renderFacts(root)` is exported and throws — the guard calls it against a doctored
 * copy of the JSON sources to watch the refusal happen, the same arrangement
 * `generate-third-party.mjs` uses. Only run directly does a refusal become exit 1.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..', '..');
const OUT_PATH = join(here, '..', 'src', 'generated', 'facts.json');

export const CORE_MANIFEST = 'packages/core/package.json';
export const MCP_MANIFEST = 'packages/mcp/package.json';
export const GUARDS_MANIFEST = 'guards.json';

/** A source file, or a refusal — never a default. */
function readJson(root, relative, what) {
  const path = join(root, relative);
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `${what} is missing (${relative}) — the site cannot state a fact it cannot read`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${what} is not parseable JSON (${relative}): ${error.message}`, {
      cause: error,
    });
  }
}

function version(manifest, relative) {
  const value = manifest.version;
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error(`${relative} has no usable "version" — got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Every fact the site renders about the packages, read out of `root`'s JSON sources and
 * the built `@smeltjs/core` registries. Throws on anything missing, unparseable or
 * empty: a site that quietly renders `undefined` for a version is worse than a site
 * that does not build.
 */
export async function renderFacts(root = REPO_ROOT) {
  const core = readJson(root, CORE_MANIFEST, "the core package's manifest");
  const mcp = readJson(root, MCP_MANIFEST, "the MCP server package's manifest");
  const guards = readJson(root, GUARDS_MANIFEST, 'the guard tally');

  for (const key of ['guards', 'mutations']) {
    if (!Number.isInteger(guards[key]) || guards[key] <= 0) {
      throw new Error(
        `${GUARDS_MANIFEST} has no positive integer "${key}" — run \`pnpm generate:guards\``,
      );
    }
  }

  let smelt;
  try {
    smelt = await import('@smeltjs/core');
  } catch (error) {
    throw new Error(
      `@smeltjs/core could not be imported: ${error.message}. The site renders the ` +
        `package's own registries, so the package must be built first — ` +
        `\`pnpm --filter "@smeltjs/site..." build\` does that in order.`,
      { cause: error },
    );
  }

  const tiers = smelt.harnessesByTier().map((group) => ({
    tier: group.tier,
    honesty: group.honesty,
    harnesses: group.harnesses.map((profile) => ({
      id: profile.id,
      name: profile.name,
      label: smelt.harnessLabel(profile),
    })),
  }));
  if (tiers.length === 0) throw new Error('the harness registry produced no tiers');

  const structuralLanguages = [...smelt.structuralLanguages()];
  if (structuralLanguages.length === 0) {
    throw new Error('the language registry claims no structural languages');
  }

  const grammars = [...new Set(Object.values(smelt.WASM_BY_LANGUAGE))].toSorted();
  if (grammars.length === 0) throw new Error('the language registry names no bundled grammars');

  // The SetupRecipe (CONTEXT.md): the commands and defaults every setup rendering
  // repeats. The components read them from here, so a changed command edits the
  // recipe module and this line follows — never the other way round.
  const recipe = smelt.SETUP_RECIPE;
  // The MCP registration is a *harness's* fact, not the recipe's: a `claude` CLI verb
  // for Claude Code, a `[mcp_servers.smelt]` table for Codex and Grok. The two places
  // the site prints one are Claude-Code-specific prose, so they read Claude Code's own
  // profile — the recipe carries only `mcp.run`, which is true of every MCP client.
  const claudeCode = (smelt.HARNESSES ?? []).find((profile) => profile.id === 'claude-code');
  const recipeFacts = {
    installLibrary: recipe.install?.library,
    installPnpm: recipe.install?.libraryPnpm,
    installBun: recipe.install?.libraryBun,
    installGlobal: recipe.install?.globalInstall,
    oneShot: recipe.install?.oneShot,
    brewInstall: recipe.install?.brewInstall,
    brewUpgrade: recipe.install?.brewUpgrade,
    skillInstall: recipe.install?.skillInstall,
    recommendedBudgetBytes: recipe.recommendedBudgetBytes,
    storeDir: recipe.store?.defaultDir,
    mcpRun: recipe.mcp?.run,
    mcpRegister: claudeCode?.mcp?.manual,
    steps: (smelt.SETUP_STEPS ?? []).map((step) => ({
      id: step.id,
      title: step.title,
      command: step.command,
    })),
  };
  for (const [key, value] of Object.entries(recipeFacts)) {
    const empty = Array.isArray(value)
      ? value.length === 0
      : value === undefined || value === null || value === '';
    if (empty) {
      throw new Error(
        `the recipe fact "${key}" is missing from @smeltjs/core — the site cannot render ` +
          `a fact the package does not state`,
      );
    }
  }

  return {
    versions: { core: version(core, CORE_MANIFEST), mcp: version(mcp, MCP_MANIFEST) },
    tiers,
    structuralLanguages,
    grammars,
    guards: { guards: guards.guards, mutations: guards.mutations },
    recipe: recipeFacts,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let facts;
  try {
    facts = await renderFacts();
  } catch (error) {
    console.error(`facts-data: ${error.message}`);
    process.exit(1);
  }
  const document = JSON.stringify(facts, null, 2) + '\n';
  // `--print` writes to stdout instead of the file, so the guard checks the generator
  // that actually ships rather than a copy of its logic.
  if (process.argv.includes('--print')) {
    process.stdout.write(document);
  } else {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, document);
    console.log(
      `facts-data: core ${facts.versions.core}, mcp ${facts.versions.mcp}, ` +
        `${String(facts.tiers.length)} tiers over ` +
        `${String(facts.tiers.reduce((n, tier) => n + tier.harnesses.length, 0))} harnesses, ` +
        `${String(facts.structuralLanguages.length)} structural languages, ` +
        `${String(facts.grammars.length)} grammars, ${String(facts.guards.mutations)} mutations ` +
        `across ${String(facts.guards.guards)} guards → src/generated/facts.json`,
    );
  }
}
