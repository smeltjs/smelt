import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { SETUP_RECIPE, SETUP_STEPS } from '@guard/setup/recipe';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * SKILL-PACK GUARD — the published skill teaches only what the recipe and the MCP
 * server say, it is the generator's output byte for byte, and its root is a router
 * that fits a stated budget.
 *
 * The skill (ADR-0002) is the teaching channel for agents that never ran the hooks
 * installer — which means it is also the place retyped commands would drift the
 * quietest: nobody's verify breaks when a README-quality document goes stale. So the
 * skill is not hand-written at all. `scripts/generate-skill.mjs` renders it from the
 * built SetupRecipe as a **pack** — a root `SKILL.md` plus `references/*.md` — and
 * this guard:
 *
 *   1. regenerates and compares every file — a hand edit to any committed file, or a
 *      stray file the generator did not render, is a red verify, the same discipline
 *      THIRD-PARTY.md is under;
 *   2. holds the root under `rootBudgetBytes`, recounted here rather than trusted —
 *      the root is loaded on every invocation of the skill, relevant or not, and the
 *      whole reason the operator workflows live in `references/` is that an agent
 *      reading one big file should not pay for prune, rerank and doctor. The budget
 *      is the generator's own number; a root that outgrows it is a refusal, not a
 *      warning;
 *   3. pins the MCP tool names to the server's own source — a tool the server does
 *      not register is a command an agent loops on;
 *   4. walks the recipe's steps into the pack — every command the recipe carries, the
 *      pack teaches, somewhere a link from the root reaches;
 *   5. holds the prose to Law 4: no percentages, no rates, no savings.
 */

const GENERATOR_PATH = 'scripts/generate-skill.mjs';
const PACK_DIR = 'skills/smelt';
const ROOT = 'SKILL.md';
const MCP_SRC = join(repoRoot(), 'packages/mcp/src');
const INDEX = 'llms.txt';

/**
 * A committed artefact — from the mutation runner's scratch root when that run staled
 * this particular file, else from the real repository. The runner copies only the one
 * artefact it is breaking into the scratch root, so a guard that read the whole pack
 * (or the generator) from `guardRoot()` would go red for a missing file rather than for
 * the break it exists to notice — and a mutant generator would never be run at all.
 * The same per-file fallback `test/guards/llms-txt.test.ts` documents.
 */
function committedPath(file: string): string {
  const scratched = join(guardRoot(), file);
  return guardRoot() !== packageRoot() && existsSync(scratched)
    ? scratched
    : join(repoRoot(), file);
}

/** What `--print-json` emits: every file of the pack, plus the root's measurement. */
interface RenderedPack {
  readonly files: Readonly<Record<string, string>>;
  readonly rootBytes: number;
  readonly rootBudgetBytes: number;
}

/**
 * Every committed file of the pack, path (relative to the pack) → text. The file list
 * is the real repository's — that is what "a stray file" is measured against — and each
 * file's bytes come through {@link committedPath}, so a staled copy is read where the
 * runner put it.
 */
function committedPack(): Readonly<Record<string, string>> {
  const files: Record<string, string> = {};
  const real = join(repoRoot(), PACK_DIR);
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else files[rel] = readFileSync(committedPath(`${PACK_DIR}/${rel}`), 'utf8');
    }
  };
  walk(real, '');
  return files;
}

/**
 * The generator's current output — the script, as a subprocess. The script is read
 * through {@link committedPath} too, so a mutation that breaks the generator runs the
 * *broken* generator; the pristine one would make every generator mutation vacuous.
 */
function generated(): RenderedPack {
  // `SMELT_REPO_ROOT` points a scratch copy of the generator back at the real built
  // core and the real pack, so the copy renders and its break is what goes red.
  const run = spawnSync(process.execPath, [committedPath(GENERATOR_PATH), '--print-json'], {
    encoding: 'utf8',
    env: { ...process.env, SMELT_REPO_ROOT: repoRoot() },
  });
  expect(
    run.status,
    `scripts/generate-skill.mjs failed. It reads the built @smeltjs/core, so the ` +
      `package must be built first (\`pnpm build\`):\n${run.stderr}`,
  ).toBe(0);
  return JSON.parse(run.stdout) as RenderedPack;
}

function wholePack(files: Readonly<Record<string, string>>): string {
  return Object.values(files).join('\n');
}

describe('the SkillPack is the generator\u2019s output and states only package facts', () => {
  it('regenerating leaves every committed file byte-identical, and renders no other', () => {
    const committed = committedPack();
    const rendered = generated().files;
    expect(
      Object.keys(committed).toSorted(),
      'the committed skills/smelt/ directory and the generator name different files — a ' +
        'stray or missing file; run `pnpm generate:skill` and commit the result',
    ).toEqual(Object.keys(rendered).toSorted());
    for (const [path, text] of Object.entries(rendered)) {
      expect(
        committed[path],
        `skills/smelt/${path} is not the generator\u2019s output — run \`pnpm generate:skill\` and commit the result, never edit the skill by hand`,
      ).toBe(text);
    }
  });

  it('keeps the root a router: under its own byte budget, recounted here', () => {
    const pack = generated();
    const root = pack.files[ROOT];
    expect(root, 'the pack has no SKILL.md root').toBeDefined();
    const recount = Buffer.byteLength(root ?? '', 'utf8');
    expect(pack.rootBytes, 'the generator reports a root size it did not measure').toBe(recount);
    expect(
      recount,
      `SKILL.md is ${String(recount)} B, over its ${String(pack.rootBudgetBytes)} B budget — ` +
        'the root is loaded on every invocation; move operator prose into references/',
    ).toBeLessThanOrEqual(pack.rootBudgetBytes);
    expect(pack.rootBudgetBytes, 'a root budget of zero is not a budget').toBeGreaterThan(0);
  });

  it('links every reference file from the root, so nothing rendered is unreachable', () => {
    const files = generated().files;
    const root = files[ROOT] ?? '';
    for (const path of Object.keys(files)) {
      if (path === ROOT) continue;
      expect(root, `SKILL.md never links ${path} — a reference no router reaches`).toContain(
        `](${path})`,
      );
    }
  });

  it('teaches every command the recipe carries, none beside them', () => {
    const text = wholePack(committedPack());
    for (const step of SETUP_STEPS) {
      expect(
        text.includes(step.command),
        `the pack never teaches the recipe's ${step.id} step (${step.command})`,
      ).toBe(true);
    }
    expect(text).toContain(SETUP_RECIPE.install.oneShot);
  });

  it('names only MCP tools the server actually registers', () => {
    const text = wholePack(committedPack());
    const names = [
      ...text.matchAll(/`(smelt_file|repo_map|smelt_retrieve_batch|smelt_retrieve|smelt_stats)`/gu),
    ].map((match) => match[1]!);
    expect(names.length, 'the skill names no MCP tools at all').toBeGreaterThan(0);
    for (const name of new Set(names)) {
      const inServer = spawnSync('grep', ['-r', name, MCP_SRC], { encoding: 'utf8' });
      expect(
        inServer.status,
        `the skill teaches \`${name}\`, which packages/mcp/src never registers`,
      ).toBe(0);
    }
  });

  it('is indexed whole: every file of the pack is a document llms.txt names', () => {
    // The generator's file map and the AgentIndex's document list are two lists that
    // must agree, and nothing else joins them: a reference the index does not name is
    // one llms-full.txt never inlines, silently.
    const index = readFileSync(committedPath(INDEX), 'utf8');
    for (const path of Object.keys(generated().files)) {
      expect(
        index,
        `llms.txt does not name ${PACK_DIR}/${path} — add it to the document list`,
      ).toContain(`${PACK_DIR}/${path}`);
    }
  });

  it('states no saving: Law 4 holds for prose, not just for the README', () => {
    const text = wholePack(committedPack());
    expect(
      /%\s|(?:token|cost|size)\s+(?:reduction|saving)|saves?\s+(?:up to|\d)/iu.exec(text)?.[0],
      `the skill states a saving smelt has not measured: "${/.*(%|(?:token|cost|size)\s+(?:reduction|saving)).*/iu.exec(text)?.[0]?.trim()}" — mechanisms only, like every other surface`,
    ).toBeUndefined();
  });

  it('teaches the retrieve contract in both spellings a marker implies, in the root', () => {
    const text = committedPack()[ROOT] ?? '';
    expect(text).toContain('retrieve("hash")');
    expect(text).toContain('smelt retrieve <hash>');
  });

  it('names its trigger in one description sentence, not the domain', () => {
    const text = committedPack()[ROOT] ?? '';
    const description = /^description: (.*)$/mu.exec(text)?.[1] ?? '';
    expect(description, 'the root has no description frontmatter').not.toBe('');
    expect(
      description.startsWith('Use when'),
      'the description opens with the domain, not the trigger',
    ).toBe(true);
    expect(
      Buffer.byteLength(description, 'utf8'),
      'the description is long enough to be truncated where many skills are installed',
    ).toBeLessThanOrEqual(200);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'skill-edited-by-hand',
    file: 'skills/smelt/SKILL.md',
    find: '## Retrieving what was cut',
    replace: '## Retrieving what was cut (up to 94% fewer tokens)',
    why: 'the original pitch\u2019s unmeasured 94% landing in the teaching artifact — the exact Law 4 failure, in the one file an agent reads as instructions rather than as marketing',
  },
  {
    kind: 'artifact',
    id: 'skill-reference-edited-by-hand',
    file: 'skills/smelt/references/store.md',
    find: 'Read the dry run before the real one.',
    replace: 'Read the dry run before the real one (it usually saves 40% of the store).',
    why: 'a hand edit to a reference file — the directory compare must reach past the root, or the operator docs become the one unwatched teaching surface',
  },
  {
    kind: 'artifact',
    id: 'skill-root-outgrows-its-budget',
    file: 'scripts/generate-skill.mjs',
    find: 'It makes zero network calls.',
    replace:
      'It makes zero network calls. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent. ' +
      'It also has a great deal more to say about itself than an agent reading one file needs, and every word of it is loaded on every invocation, relevant or not, which is the shape the router exists to prevent.',
    why: 'the root growing by two kilobytes of prose that reads well — the flat 7.6 KB skill this pack replaced, coming back one helpful paragraph at a time; only a measured root budget can see it',
  },
  {
    kind: 'artifact',
    id: 'skill-setup-steps-dropped-from-pack',
    file: 'scripts/generate-skill.mjs',
    find: '${steps}',
    replace: '(see smelt setup --help)',
    why: 'the recipe\u2019s step-by-step fallback dropped from the pack — an agent on an older install with no `setup` verb is told to run a help text instead of the four commands the recipe carries',
  },
  {
    kind: 'artifact',
    id: 'skill-generator-invents-a-tool',
    file: 'scripts/generate-skill.mjs',
    find: 'smelt_file',
    replace: 'smelt_fyle',
    why: 'the generator teaching a tool the server does not register — an agent would loop on a command that cannot succeed, and only the tool-name pin to the server\u2019s own source can see it',
  },
];
