import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { setupCommand } from '@guard/cli/subcommands/setup';
import { storeCommand } from '@guard/cli/subcommands/store';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * LLMS-TXT GUARD — the agent-facing index is the generator's output, its two copies
 * agree byte for byte, and every link in it names a file that is actually here.
 *
 * `llms.txt` (llmstxt.org) is the first thing an agent fetches about this project, and
 * `llms-full.txt` is every document that index names, inlined. The index is committed
 * twice — at the repository root, where an agent reading the repo finds it without a
 * fetch, and under `site/public/`, where the built site serves it; the companion is
 * committed once, under `site/public/`, because a second copy of the whole documentation
 * set would put a large regenerated blob in the diff of every docs change for no reader.
 * That is three committed files a hand edit could put into three different states, so
 * none of them is hand-written: `scripts/generate-llms-txt.mjs` renders them from one
 * document list and the built packages' own facts, and this guard holds them to it:
 *
 *   1. regenerate and byte-compare **each** committed copy — the same discipline
 *      `test/guards/skill-pack.test.ts` puts the SkillPack under;
 *   2. the root copy and the site copy are byte-identical to each other, checked
 *      directly rather than inferred, because "both equal the generator" is the claim
 *      that fails first when only one is regenerated and committed;
 *   3. every link in `llms.txt` maps back to a path in this repository, and that path
 *      exists — a link to a file nobody moved with the rest is the failure mode a
 *      generated index does not otherwise protect against, because regenerating it
 *      reproduces the dead link exactly;
 *   4. every source document the index names is inlined in `llms-full.txt` under its
 *      own path header, so the index and its companion cannot name different sets;
 *   5. the flags the index and the SkillPack teach are flags the verbs own — pinned to
 *      `setupCommand.flags` and `storeCommand.flags`, so a renamed flag is red here
 *      rather than in an agent's transcript;
 *   6. Law 4 holds for the prose: no percentage, no saving, no measured figure. The
 *      index links `bench/RESULTS.md`; it never quotes it.
 *
 * Existence is checked on the filesystem rather than through `git ls-files`, because
 * `scripts/check-fresh-clone.sh` runs the whole gate against a `git archive` export
 * that has no `.git` at all — and that export is itself the check that these files are
 * tracked, since an untracked one would simply not be there.
 */

const GENERATOR = join(repoRoot(), 'scripts/generate-llms-txt.mjs');
const INDEX = 'llms.txt';
const SITE_INDEX = 'site/public/llms.txt';
const FULL = 'site/public/llms-full.txt';

/** The three URL shapes the index may use, and what each maps to in the repository. */
const RAW_BASE = 'https://raw.githubusercontent.com/smeltjs/smelt/main/';
const TREE_BASE = 'https://github.com/smeltjs/smelt/tree/main/';
const SITE_BASE = 'https://smeltjs.github.io/smelt/';

/**
 * A committed artefact — from the mutation runner's scratch root when that run staled
 * this particular file, else from the real repository.
 *
 * The per-file fallback is what lets one mutation stale one of four files: the runner
 * copies only the artefact it is breaking into the scratch root, so a guard that read
 * all four from `guardRoot()` would fail on the three that are simply not there, and
 * would go red for a missing file rather than for the break it exists to notice.
 */
function committed(file: string): string {
  const scratched = join(guardRoot(), file);
  const real = join(repoRoot(), file);
  const path = guardRoot() !== packageRoot() && existsSync(scratched) ? scratched : real;
  return readFileSync(path, 'utf8');
}

/** The generator's current output — the real script, as a subprocess. */
function generated(flag: '--print' | '--print-full'): string {
  const run = spawnSync(process.execPath, [GENERATOR, flag], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  expect(
    run.status,
    `scripts/generate-llms-txt.mjs ${flag} failed. It reads the built @smeltjs/core and ` +
      `@smeltjs/mcp, so the packages must be built first (\`pnpm build\`):\n${run.stderr}`,
  ).toBe(0);
  return run.stdout;
}

/** Every `- [title](url): note` link in the index, in order, with its H2 section. */
function links(index: string): readonly { section: string; url: string }[] {
  const found: { section: string; url: string }[] = [];
  let section = '(before any section)';
  for (const line of index.split('\n')) {
    const heading = /^## (.+)$/u.exec(line);
    if (heading !== null) {
      section = heading[1]!;
      continue;
    }
    const link = /^- \[[^\]]+\]\(([^)]+)\):/u.exec(line);
    if (link !== null) found.push({ section, url: link[1]! });
  }
  return found;
}

/**
 * The repository path a link names, or `undefined` when the URL is not one of the
 * three shapes the index is allowed to use. `undefined` is a failure, not a pass: a
 * link nothing can resolve is a link nobody can verify, which is the whole reason this
 * guard can make a claim about the index's links at all.
 */
function repoPathFor(url: string): string | undefined {
  if (url.startsWith(RAW_BASE)) return url.slice(RAW_BASE.length);
  if (url.startsWith(TREE_BASE)) return url.slice(TREE_BASE.length);
  if (url.startsWith(SITE_BASE)) {
    const rest = url.slice(SITE_BASE.length);
    return rest === '' ? 'site/index.html' : `site/public/${rest}`;
  }
  return undefined;
}

describe('llms.txt is the generator’s output, and every link in it is real', () => {
  it('regenerating leaves both copies of the index byte-identical', () => {
    const index = generated('--print');
    for (const file of [INDEX, SITE_INDEX]) {
      expect(
        committed(file),
        `${file} is not the generator’s output — run \`pnpm generate:llms-txt\` and commit what it writes, never edit it by hand`,
      ).toBe(index);
    }
  });

  it('regenerating leaves the served full text byte-identical', () => {
    expect(
      committed(FULL),
      `${FULL} is not the generator’s output — run \`pnpm generate:llms-txt\` and commit what it writes`,
    ).toBe(generated('--print-full'));
  });

  it('the root copy of the index and the site copy never diverge', () => {
    expect(
      committed(SITE_INDEX),
      `${INDEX} and ${SITE_INDEX} disagree — one was regenerated and the other was not, and an agent fetching the site would read a different project from one reading the repo`,
    ).toBe(committed(INDEX));
  });

  it('leaves no second copy of the full text at the repository root', () => {
    expect(
      existsSync(join(repoRoot(), 'llms-full.txt')),
      'llms-full.txt exists at the repository root. The companion is served from site/public/, not vendored twice: two copies of the whole documentation set is a large regenerated blob in the diff of every docs change, for a reader the index already sends to the site URL. Delete it — the renderer no longer writes there.',
    ).toBe(false);
  });

  it('every link resolves to a path that exists in this repository', () => {
    const all = links(committed(INDEX));
    expect(all.length, 'llms.txt lists no links at all').toBeGreaterThan(0);
    for (const { url } of all) {
      const path = repoPathFor(url);
      expect(
        path,
        `llms.txt links ${url}, which is none of the three shapes the index may use (a raw file, a tree directory, or the site) — a link that cannot be mapped back to this repository cannot be checked`,
      ).toBeDefined();
      expect(
        existsSync(join(repoRoot(), path!)),
        `llms.txt links ${url}, but ${path!} does not exist in this repository — the file moved or was deleted and the index was not regenerated with it`,
      ).toBe(true);
    }
  });

  it('names every decision record on disk, so a new ADR cannot be left out', () => {
    const index = committed(INDEX);
    const onDisk = readdirSync(join(repoRoot(), 'docs/adr'))
      .filter((name) => name.endsWith('.md'))
      .toSorted();
    expect(onDisk.length, 'docs/adr holds no records — the index would name none').toBeGreaterThan(
      0,
    );
    for (const name of onDisk) {
      expect(
        index,
        `docs/adr/${name} exists but llms.txt does not link it — regenerate the index when a decision record is added`,
      ).toContain(`${RAW_BASE}docs/adr/${name}`);
    }
  });

  it('inlines in llms-full.txt every source document the index names', () => {
    const full = committed(FULL);
    for (const { section, url } of links(committed(INDEX))) {
      if (section === 'Optional') continue;
      const path = repoPathFor(url);
      if (path === undefined || !path.endsWith('.md')) continue;
      expect(
        full.split('\n').some((line) => line.startsWith(`# ${path}`)),
        `llms.txt names ${path} under "${section}", but llms-full.txt has no "# ${path}" block — the index and its companion name different sets of documents`,
      ).toBe(true);
    }
  });

  it('teaches only flags the verbs actually own', () => {
    const taught = [
      committed(INDEX),
      readFileSync(join(repoRoot(), 'skills/smelt/SKILL.md'), 'utf8'),
    ].join('\n');
    const setupFlags: readonly string[] = setupCommand.flags;
    const storeFlags: readonly string[] = storeCommand.flags;
    for (const flag of ['scope', 'yes', 'json', 'guard', 'stats', 'map', 'lint', 'harness']) {
      if (!taught.includes(`--${flag}`)) continue;
      expect(
        setupFlags.includes(flag),
        `a teaching surface names \`--${flag}\`, which \`smelt setup\` does not own`,
      ).toBe(true);
    }
    for (const flag of ['older-than', 'dry-run']) {
      expect(
        taught.includes(`--${flag}`) && storeFlags.includes(flag),
        `a teaching surface teaches \`--${flag}\` for \`smelt store prune\`, and the verb must own it`,
      ).toBe(true);
    }
  });

  it('states no measured number: Law 4 governs the index too', () => {
    const index = committed(INDEX);
    expect(
      /%\s|(?:token|cost|size)\s+(?:reduction|saving)|saves?\s+(?:up to|\d)/iu.exec(index)?.[0],
      `llms.txt states a figure it has not measured — the index links packages/core/bench/RESULTS.md so that every number stays where its date and corpus commit are`,
    ).toBeUndefined();
    expect(
      index,
      'llms.txt no longer points at the measured rows — Law 4 needs somewhere honest to send a reader',
    ).toContain('packages/core/bench/RESULTS.md');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'llms-txt-section-dropped',
    file: 'llms.txt',
    find: '## MCP tools',
    replace: '## Tools you may not have',
    why: 'a section of the index edited by hand rather than regenerated — the exact drift four committed copies of a generated file invite, and the one an agent would read as the project’s own word',
  },
  {
    kind: 'artifact',
    id: 'llms-txt-link-to-a-file-that-is-gone',
    file: 'llms.txt',
    find: 'main/CONTEXT.md',
    replace: 'main/docs/CONTEXT.md',
    why: 'a link pointing at a path nothing is at — regenerating an index reproduces a dead link exactly, so only resolving each URL back to a file that exists can notice it',
  },
  {
    kind: 'artifact',
    id: 'llms-txt-copies-diverge',
    file: 'site/public/llms.txt',
    find: 'It makes zero network calls.',
    replace: 'It makes some network calls.',
    why: 'the site copy edited without the root copy — an agent fetching the deployed index would be told the opposite of Law 1 from the same project',
  },
  {
    kind: 'artifact',
    id: 'llms-full-drops-a-document',
    file: 'site/public/llms-full.txt',
    find: '# docs/adr/0002-skill-pack-complements-marker-blocks.md',
    replace: '# docs/adr/0002-skill-pack-complements-marker-blocks.md.old',
    why: 'a document the index names losing its block header in the companion — the index would promise one-shot context that no longer contains what it lists',
  },
];
