import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Through @guard, so a mutation can point this at a deliberately broken registry.
import { harnessById, harnessesByTier } from '@guard/harness/registry';
import { SETUP_RECIPE, SETUP_STEPS } from '@guard/setup/recipe';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * SITE-FACTS GUARD — the marketing site may only say what the packages say.
 *
 * The site is a separate app in the same repository, and it had no dependency on the
 * packages it advertises. So it retyped them: two version strings, the harness tier
 * table, the guard tally, the grammar count. On 2026-09-03 the deployed page said
 * `@smeltjs/core v0.2.0 · @smeltjs/mcp v0.1.0` while 0.3.0 and 0.2.0 were on npm — a
 * pair that was never published. Nothing could have caught it: root `verify` filters
 * `./packages/**`, and the deploy workflow triggered on `site/**` alone, so a release
 * could not make the site red, rebuild it, or make it right.
 *
 * `site/scripts/facts-data.mjs` now generates `site/src/generated/facts.json` at build
 * time and the components import it. This guard makes the generator's promise
 * checkable:
 *
 *   1. the versions it emits are the two manifests', character for character — the
 *      site says what the repository's own record of the release says. (Not what npm
 *      says: the manifest is the pre-publish source, so a bump merged before
 *      `npm publish` still deploys a page naming an unpublished version. Publish
 *      first; the generator's docblock says so and nothing here can check it.)
 *   2. it refuses, rather than emitting a hole, when a source is missing or
 *      unparseable — asserted by running the real `renderFacts` against a doctored copy
 *      of the JSON sources, the way `third-party.test.ts` watches its own generator
 *      refuse an unattributed grammar;
 *   3. no site component states a **tier** of its own. The tier table was derived and a
 *      hand-typed `hooks tier: verified` badge stayed behind on another component of
 *      the same page, so a profile flipped to `advisory` moved in the table and kept
 *      its old tier in the badge. A tier word in site source is now the failure.
 *   4. the recorded-at version beside the site's terminal transcript — the one version
 *      string deliberately NOT generated, because it is provenance and must keep naming
 *      the release the recording was made on — never names a version the packages have
 *      not reached.
 *
 * The core manifest and the site sources are read through `guardRoot()`, so `pnpm
 * mutate` can stale the copy this guard reads and watch the comparison go red while the
 * generator keeps reporting what the real tree says.
 */

const GENERATOR = join(repoRoot(), 'site/scripts/facts-data.mjs');
const TOUR = 'site/src/components/Tour.tsx';
const AGENT_PROMPT = 'site/src/components/AgentPrompt.tsx';
const SITE_SOURCE = 'site/src';

interface Facts {
  readonly versions: { readonly core: string; readonly mcp: string };
  readonly tiers: readonly {
    readonly tier: string;
    readonly honesty: string;
    readonly harnesses: readonly { readonly id: string; readonly label: string }[];
  }[];
  readonly structuralLanguages: readonly string[];
  readonly grammars: readonly string[];
  readonly guards: { readonly guards: number; readonly mutations: number };
  readonly recipe: {
    readonly installLibrary: string;
    readonly installPnpm: string;
    readonly installBun: string;
    readonly installGlobal: string;
    readonly oneShot: string;
    readonly brewInstall: string;
    readonly brewUpgrade: string;
    readonly skillInstall: string;
    readonly recommendedBudgetBytes: number;
    readonly storeDir: string;
    readonly mcpRun: string;
    readonly mcpRegister: string;
    readonly steps: readonly {
      readonly id: string;
      readonly title: string;
      readonly command: string;
    }[];
  };
}

/** What the generator emits right now — the real script, as a subprocess. */
function generated(): Facts {
  const run = spawnSync(process.execPath, [GENERATOR, '--print'], { encoding: 'utf8' });
  expect(
    run.status,
    `site/scripts/facts-data.mjs failed. It reads the built @smeltjs/core, so the ` +
      `package must be built first (\`pnpm build\`):\n${run.stderr}`,
  ).toBe(0);
  return JSON.parse(run.stdout) as Facts;
}

/**
 * A repository file — from the repository, or from the mutation runner's scratch root
 * when it made one (which is exactly when `guardRoot()` stops being this package's own
 * root).
 */
function repoFile(relative: string): string {
  const root = guardRoot() === packageRoot() ? repoRoot() : guardRoot();
  const staled = join(root, relative);
  return readFileSync(existsSync(staled) ? staled : join(repoRoot(), relative), 'utf8');
}

/** Every `.ts`/`.tsx` file under `relative`, recursively, as repository paths. */
function walk(relative: string): readonly string[] {
  return readdirSync(join(repoRoot(), relative), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? walk(`${relative}/${entry.name}`)
      : /\.tsx?$/u.test(entry.name)
        ? [`${relative}/${entry.name}`]
        : [],
  );
}

/** Every site source file — the components a visitor's browser renders. */
const siteSources = (): readonly string[] => walk(SITE_SOURCE);

/**
 * `source` with its comments blanked — block comments wholesale, and any line whose
 * first non-space characters are `//`. Deliberately not the full string-aware scanner:
 * a `//` inside a string (every URL in the paste-me prompts has one) must NOT start a
 * comment here, because a tier word typed after one on the same line is exactly the
 * thing being looked for.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function versionIn(path: string): string {
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version;
}

/** The core's own version — through `guardRoot()`, so a mutation can stale this copy. */
function coreVersion(): string {
  const staled = join(guardRoot(), 'package.json');
  return versionIn(existsSync(staled) ? staled : join(packageRoot(), 'package.json'));
}

const mcpVersion = (): string => versionIn(join(repoRoot(), 'packages/mcp/package.json'));

const parts = (value: string): readonly number[] => value.split('.').map(Number);

/** `1.2.3` → `[1, 2, 3]`, compared field by field. */
function order(a: string, b: string): number {
  const [left, right] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

describe('the site states the packages, and nothing it made up', () => {
  it('the generated versions are the manifests, character for character', () => {
    const facts = generated();
    expect(
      facts.versions.core,
      'the site would advertise a @smeltjs/core version the manifest does not carry — ' +
        'the exact defect this generator exists to end',
    ).toBe(coreVersion());
    expect(
      facts.versions.mcp,
      'the site would advertise a @smeltjs/mcp version the manifest does not carry',
    ).toBe(mcpVersion());
    // The published *pair*, not two independent strings: the footer prints both.
    expect(`core ${facts.versions.core} · mcp ${facts.versions.mcp}`).toBe(
      `core ${coreVersion()} · mcp ${mcpVersion()}`,
    );
  });

  it('carries the registry facts the page renders, none of them empty', () => {
    const facts = generated();
    // The tier rows are `harnessesByTier()` — the same fold the README table, the help
    // body and the wizard render — so this compares two readings of one registry rather
    // than a hand-typed count of the thing this branch just made derivable.
    expect(
      facts.tiers.map((tier) => tier.tier),
      'the generated tier rows are not the registry grouping — the harness table would ' +
        'render tiers nothing derived',
    ).toEqual(harnessesByTier().map((group) => group.tier));
    expect(
      facts.tiers.length,
      'no tier rows — the harness table would render empty',
    ).toBeGreaterThan(0);
    expect(facts.tiers.every((tier) => tier.harnesses.length > 0)).toBe(true);
    // Every column the table renders, present: a key the generator stops emitting is
    // dropped by JSON.stringify, and the cell renders blank.
    for (const tier of facts.tiers) {
      expect(tier.honesty, `tier ${tier.tier} carries no line saying what it means`).toBeTruthy();
      for (const harness of tier.harnesses) {
        expect(harness.id, `a harness under ${tier.tier} has no id`).toBeTruthy();
        expect(harness.label, `${harness.id} has no label to render`).toBeTruthy();
      }
    }
    expect(facts.structuralLanguages.length).toBeGreaterThanOrEqual(10);
    expect(facts.grammars.length).toBeGreaterThanOrEqual(10);
    expect(facts.guards.guards).toBeGreaterThanOrEqual(12);
    expect(facts.guards.mutations).toBeGreaterThan(facts.guards.guards);
    // The recipe facts are the built module's, character for character — the prompts
    // and install lines render these, so a site-side retelling would be the second
    // owner the setup-recipe guard exists to refuse.
    expect(facts.recipe.storeDir).toBe(SETUP_RECIPE.store.defaultDir);
    expect(facts.recipe.installGlobal).toBe(SETUP_RECIPE.install.globalInstall);
    expect(facts.recipe.installLibrary).toBe(SETUP_RECIPE.install.library);
    expect(facts.recipe.installPnpm).toBe(SETUP_RECIPE.install.libraryPnpm);
    expect(facts.recipe.installBun).toBe(SETUP_RECIPE.install.libraryBun);
    expect(facts.recipe.oneShot).toBe(SETUP_RECIPE.install.oneShot);
    expect(facts.recipe.brewInstall).toBe(SETUP_RECIPE.install.brewInstall);
    expect(facts.recipe.brewUpgrade).toBe(SETUP_RECIPE.install.brewUpgrade);
    expect(facts.recipe.skillInstall).toBe(SETUP_RECIPE.install.skillInstall);
    expect(facts.recipe.mcpRun).toBe(SETUP_RECIPE.mcp.run);
    // The registration is a harness fact, and the two places the site prints one are
    // Claude Code's prose — so it is pinned to Claude Code's profile, not to the
    // recipe, which carries no harness's registration any more.
    expect(facts.recipe.mcpRegister).toBe(harnessById('claude-code')?.mcp?.manual);
    expect(facts.recipe.recommendedBudgetBytes).toBe(SETUP_RECIPE.recommendedBudgetBytes);
    expect(facts.recipe.steps.map((step) => step.id)).toEqual(SETUP_STEPS.map((step) => step.id));
    for (const step of facts.recipe.steps) {
      expect(step.command, `recipe step ${step.id} renders no command`).toBeTruthy();
    }
  });

  it('no site component states a tier of its own', () => {
    // A tier is a package fact. The table below the prompts was derived from it while a
    // hand-typed `hooks tier: verified` badge stayed behind on the same page — so the
    // property is not "the table is derived" but "the word does not appear in site
    // source at all". Comments are exempt: they explain the rule.
    const tiers = harnessesByTier().map((group) => group.tier);
    const word = new RegExp(`\\b(?:${tiers.join('|')})\\b`, 'u');
    for (const relative of siteSources()) {
      const offending = word.exec(withoutComments(repoFile(relative)));
      expect(
        offending?.[0],
        `${relative} states the tier "${offending?.[0] ?? ''}" itself. Tiers come from ` +
          `HarnessProfile.tier through facts.json — read one by harness id, or the page ` +
          `advertises one tier in one component and another in the next.`,
      ).toBeUndefined();
    }
  });

  it('the prompt tabs name harnesses the registry actually carries', () => {
    // The badge is `facts.tiers` looked up by harness id, so an id the registry dropped
    // finds no group. The component throws rather than render `hooks tier: undefined` —
    // but a throw is a blank page in a browser, so the ids are checked here, where it is
    // a red build instead.
    const source = repoFile(AGENT_PROMPT);
    const ids = [...source.matchAll(/harness: '(?<id>[a-z-]+)'/gu)].map(
      (match) => match.groups!['id']!,
    );
    expect(
      ids.length,
      `${AGENT_PROMPT} declares no harness for any tab — its badges then state no tier, ` +
        `and nothing holds them to the registry`,
    ).toBeGreaterThan(0);
    for (const id of ids) {
      expect(
        harnessById(id),
        `${AGENT_PROMPT} offers a paste-me prompt for the harness "${id}", which the ` +
          `registry does not carry — the tab would ask for the tier of a profile that is gone`,
      ).toBeDefined();
    }
  });

  it('refuses to generate when a source is missing or unparseable', () => {
    // The generator, pointed at a copy of the repository's JSON sources: sound first
    // (so the refusals below are the ones under test and not an accident of the
    // scratch tree), then with the tally emptied, mangled, and removed. It must throw
    // every time rather than emit a fact with a hole in it — a build that fails is the
    // point. Run in a subprocess, like the third-party generator's partition check.
    const scratch = join(packageRoot(), '.guard-scratch/site-facts');
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(join(scratch, 'packages/core'), { recursive: true });
    mkdirSync(join(scratch, 'packages/mcp'), { recursive: true });
    for (const manifest of ['packages/core/package.json', 'packages/mcp/package.json']) {
      cpSync(join(repoRoot(), manifest), join(scratch, manifest));
    }
    cpSync(join(repoRoot(), 'guards.json'), join(scratch, 'guards.json'));

    const run = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
        import { rmSync, writeFileSync } from 'node:fs';
        import { join } from 'node:path';
        const root = ${JSON.stringify(scratch)};
        const tally = join(root, 'guards.json');
        const { renderFacts } = await import(${JSON.stringify(GENERATOR)});
        const attempt = async (label) => {
          try {
            await renderFacts(root);
            console.log(label + ': NO THROW');
          } catch (error) {
            console.log(label + ': THREW: ' + error.message);
          }
        };
        await attempt('sound');
        writeFileSync(tally, '{ "guards": 0, "mutations": 0 }');
        await attempt('empty');
        writeFileSync(tally, 'not json at all');
        await attempt('mangled');
        rmSync(tally);
        await attempt('missing');
        `,
      ],
      { encoding: 'utf8', cwd: repoRoot() },
    );
    rmSync(scratch, { recursive: true, force: true });

    expect(run.status, `the refusal probe failed to run:\n${run.stderr}`).toBe(0);
    const lines = Object.fromEntries(
      run.stdout
        .split('\n')
        .filter((line) => line.includes(': '))
        .map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]),
    );
    expect(
      lines['sound'],
      'the doctored copy is not a working root — the probe proves nothing',
    ).toBe('NO THROW');
    expect(
      lines['empty'],
      'a tally of zero guards is not a tally, and the site would print "0 mutations"',
    ).toMatch(/^THREW: .*guards\.json/);
    expect(lines['mangled'], 'an unparseable source must fail the build, not be skipped').toMatch(
      /^THREW: .*parseable/,
    );
    expect(lines['missing'], 'a missing source must fail the build, not default').toMatch(
      /^THREW: .*missing/,
    );
  });

  it("the tour's recorded-at version is a version the packages have reached", () => {
    // The one version string on the page that is deliberately not generated: it says
    // which release the committed terminal transcript was recorded from, and pointing
    // it at the current release would claim a run that never happened. What it may
    // never do is name a version that does not exist yet.
    const source = repoFile(TOUR);
    const recorded = /const RECORDED = \{ version: '(?<version>[^']+)'/u.exec(source);
    expect(
      recorded?.groups?.['version'],
      'Tour.tsx no longer declares the version its transcript was recorded from — ' +
        'a terminal recording without provenance is a screenshot',
    ).toBeDefined();
    const version = recorded!.groups!['version']!;
    expect(
      order(version, coreVersion()) <= 0,
      `the tour says it was recorded on @smeltjs/core v${version}, which is ahead of the ` +
        `${coreVersion()} in the manifest — a recording from a release that does not exist`,
    ).toBe(true);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'site-advertises-an-unpublished-version',
    file: 'package.json',
    // Anchored on the key, never on the release: `find: '"version": "0.3.0",'` would
    // turn the next version bump into a BROKEN mutation and a red `pnpm verify` on the
    // release commit itself — a fourth place to retype the version, in the guard that
    // exists to stop the third.
    find: '"version": "',
    replace: '"version": "9',
    why: 'the released version and the advertised one disagreeing — exactly the state the deployed page was found in (v0.2.0 on the page while 0.3.0 was on npm), and which nothing in the repository could see, because the site retyped what the manifest says',
  },
  {
    kind: 'artifact',
    id: 'site-badge-states-a-tier-by-hand',
    file: 'site/src/components/AgentPrompt.tsx',
    find: "  codex: { file: 'paste-into-codex.txt', harness: 'codex' },",
    replace: "  codex: { file: 'paste-into-codex.txt', note: 'hooks tier: verified' },",
    why: "a tier typed into a component beside a derived one — the shipped page's own defect: the tier table moved a harness to advisory while this badge went on saying verified, on the same screen, with the versions guard and the tier grouping guard both green",
  },
];
