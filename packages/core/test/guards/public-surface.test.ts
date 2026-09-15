import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { GuardMutation } from './_mutations.ts';
import {
  guardRoot,
  packageRoot,
  readSource,
  repoRoot,
  stripStringsAndComments,
} from './_source.ts';

/**
 * PUBLIC-SURFACE GUARD — the barrel exports what is documented, consumed, reachable
 * or reasoned, and nothing else (ADR-0005; review IV, REP-58).
 *
 * `src/index.ts` is the whole of `@smeltjs/core`'s API: the one entry the package's
 * `exports` map points a consumer at. Every name on it is a promise the `0.x` API has
 * made, and before ADR-0005 about eighty of them had been made by accident — the
 * receipt shapes of `smelt doctor`, the PageRank constants, the store's on-disk format
 * tag, a type nothing referenced. This guard reads the barrel and accounts for every
 * export under exactly one of four clauses:
 *
 *   1. **documented** — named in backticks in the README, `docs/ARCHITECTURE.md`,
 *      `docs/SETUP.md` or a package README;
 *   2. **consumed** — imported from `@smeltjs/core` by a workspace package, or read off
 *      the barrel by a generator the repository runs (`scripts/`, `site/scripts/`);
 *   3. **reachable** — a type that appears in the signature of something public under
 *      1, 2 or 4, walked over the emitted `dist/**\/*.d.ts` (TypeScript 7 ships no
 *      programmatic checker, so the declaration files are the checker's answer);
 *   4. **reasoned** — listed in {@link PUBLIC_BY_REASON} below, under a sentence a
 *      reader can check.
 *
 * And in the other direction: every name a workspace consumer imports must still be on
 * the barrel, so un-exporting cannot break a build this repository owns. Each
 * `SmeltError` subclass is public by construction — a consumer catching one has to be
 * able to name it — and the barrel's `export *` over `errors.ts` is how they get there.
 */

/** The exports a reader has to be told the reason for, because no artefact witnesses it. */
const PUBLIC_BY_REASON: Readonly<Record<string, readonly string[]>> = {
  'the built-in planners a consumer composes with `createSmelter({ planner })` — by class, plan function and id, for every shipped strategy':
    [
      'AutoPlanner',
      'AutoPlannerOptions',
      'planAuto',
      'LexicalPlanner',
      'LEXICAL_PLANNER_ID',
      'StructuralPlanner',
      'STRUCTURAL_PLANNER_ID',
      'JsonPlanner',
      'JSON_PLANNER_ID',
      'planJson',
      'JsonPlannerOptions',
      'DiffPlanner',
      'DIFF_PLANNER_ID',
      'planDiff',
      'DiffPlannerOptions',
    ],
  'the `--json` envelopes and their format tags — the surface the README tells a consumer to parse':
    ['CLI_JSON_FORMAT', 'CliJsonEnvelope', 'CLI_MAP_JSON_FORMAT', 'CliMapJsonEnvelope'],
  'the content hash a marker names — how a consumer verifies retrieved bytes against the marker that promised them':
    ['contentHash', 'HASH_LENGTH'],
  'the language detection the smelter runs, so a consumer choosing a strategy per file makes the same call':
    ['detectLanguage', 'SUPPORTED_LANGUAGES'],
  'the zero-network policy as data — a consumer’s own guard can hold its process to the same lists':
    [
      'ALLOWED_NODE_BUILTINS',
      'ALLOWED_PACKAGES',
      'ALLOWED_URL_SCHEMES',
      'FORBIDDEN_NODE_MODULES',
      'FORBIDDEN_PACKAGES',
      'FORBIDDEN_GLOBALS',
    ],
  'the SetupRecipe type — the shape of `SETUP_RECIPE`, which the generators read and the SkillPack renders; `typeof` points the wrong way for the reachability walk':
    ['SetupRecipe'],
  'the LanguageProfile seam — `profileFor(id)` beside the registry and the derived views CONTEXT.md names':
    ['profileFor'],
  'stable rule ids a consumer switches on: the cache-breaker warnings and the repo-map reasons': [
    'CACHE_BREAKER_RULES',
    'REPO_MAP_CACHE_CORRUPT_RULE',
    'REPO_MAP_FOCUS_RULE',
    'REPO_MAP_RANKED_RULE',
    'REPO_MAP_UNREFERENCED_RULE',
  ],
  'the rerank slot, drivable directly — CHANGELOG 0.8.0 treats its request shape as API': [
    'applyRerank',
    'RerankRequest',
    'RerankOutcome',
  ],
  'the pricing half of a MarkerScheme, kept public by REP-53 for a caller pricing a plan without building markers':
    ['markerPricing'],
  'the operations seam, whole — `@smeltjs/mcp` runs on it and a third front door would too': [
    'readLedger',
    'ReadLedgerOp',
  ],
};

/** A committed artefact, read from the scratch tree when the mutation runner made one. */
function repoFile(path: string): string {
  const root = guardRoot() === packageRoot() ? repoRoot() : guardRoot();
  const staled = join(root, path);
  return readFileSync(existsSync(staled) ? staled : join(repoRoot(), path), 'utf8');
}

/** Every `.ts` file under a directory, recursively — absent directories are empty. */
function filesUnder(dir: string, ext: string): readonly string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (at: string): void => {
    for (const entry of readdirSync(at).toSorted()) {
      if (entry === 'node_modules') continue;
      const full = join(at, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(ext)) found.push(full);
    }
  };
  walk(dir);
  return found;
}

const IDENT = /\b[A-Za-z_]\w*\b/gu;

/** The names the barrel exports, kind by kind, read from `src/index.ts` as source. */
function barrelExports(): ReadonlyMap<string, string> {
  const barrel = readSource('index.ts');
  const names = new Map<string, string>();
  for (const match of barrel.matchAll(/export\s+(type\s+)?\{([^}]*)\}\s*(?:from\s+'([^']+)')?/gu)) {
    for (const raw of match[2]!.split(',')) {
      const name = raw.trim().replace(/^type\s+/u, '');
      if (name !== '') names.set(name, match[3] ?? './apply.ts');
    }
  }
  // `export * from` — the module's own top-level declarations are the barrel's.
  for (const match of barrel.matchAll(/export\s+\*\s+from\s+'([^']+)'/gu)) {
    const module = readSource(match[1]!.replace(/^\.\//u, ''));
    for (const decl of module.matchAll(
      /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|const|function|class|let|enum)\s+([A-Za-z_]\w*)/gmu,
    )) {
      names.set(decl[1]!, match[1]!);
    }
  }
  return names;
}

/** Clause 1: every backticked identifier across the documents that make promises. */
function documented(): ReadonlySet<string> {
  const docs = [
    'README.md',
    'docs/ARCHITECTURE.md',
    'docs/SETUP.md',
    'packages/core/README.md',
    'packages/mcp/README.md',
    'packages/rerank-voyage/README.md',
  ]
    .map((path) => repoFile(path))
    .join('\n');
  return new Set([...docs.matchAll(/`([A-Za-z_]\w*)/gu)].map((m) => m[1]!));
}

/** Clause 2: what the workspace imports from the barrel, by name. */
function consumed(): ReadonlyMap<string, string> {
  const root = repoRoot();
  const users = new Map<string, string>();
  for (const pkg of ['packages/mcp/src', 'packages/rerank-voyage/src']) {
    for (const file of filesUnder(join(root, pkg), '.ts')) {
      const text = readFileSync(file, 'utf8');
      for (const imp of text.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s+'@smeltjs\/core'/gu,
      )) {
        for (const raw of imp[1]!.split(',')) {
          const name = raw.trim().replace(/^type\s+/u, '');
          if (name !== '') users.set(name, relative(root, file));
        }
      }
    }
  }
  // The generators load the built package and read names off it: `smelt.SETUP_RECIPE`.
  for (const dir of ['scripts', 'site/scripts']) {
    for (const file of filesUnder(join(root, dir), '.mjs')) {
      const raw = readFileSync(file, 'utf8');
      if (!/@smeltjs\/core|dist\/index\.js|CORE_ENTRY/u.test(raw)) continue;
      // Strings go first: `smelt.config.json` inside a template is not a property read.
      const text = stripStringsAndComments(raw);
      for (const use of text.matchAll(/\b(?:smelt|core)\.([A-Za-z_]\w*)/gu)) {
        users.set(use[1]!, relative(root, file));
      }
      for (const destructured of text.matchAll(/const\s+\{([^}]*)\}\s*=\s*await\s+import\(/gu)) {
        for (const binding of destructured[1]!.split(',')) {
          const name = binding.trim().split(':')[0]!.trim();
          if (name !== '') users.set(name, relative(root, file));
        }
      }
    }
  }
  return users;
}

/**
 * Clause 3's material: each exported declaration's text from the emitted `.d.ts`
 * files, doc comments stripped, bodies absent by construction.
 */
function declarations(): ReadonlyMap<string, string> {
  const dist = join(packageRoot(), 'dist');
  expect(
    existsSync(join(dist, 'index.d.ts')),
    `${dist} holds no index.d.ts — this guard walks type reachability over the emitted ` +
      `declarations, so the package must be built first (\`pnpm build\`)`,
  ).toBe(true);
  const texts = new Map<string, string>();
  const head =
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:interface|type|const|function|class|let|enum)\s+([A-Za-z_]\w*)/gmu;
  for (const file of filesUnder(dist, '.d.ts')) {
    if (file.endsWith('/index.d.ts')) continue;
    const text = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
    const starts = [...text.matchAll(head)].map((m) => ({ at: m.index, name: m[1]! }));
    starts.forEach((start, i) => {
      const end = i + 1 < starts.length ? starts[i + 1]!.at : text.length;
      texts.set(start.name, (texts.get(start.name) ?? '') + text.slice(start.at, end));
    });
  }
  return texts;
}

/** The closure of `seeds` under "appears in the declaration of", within the barrel. */
function reachable(
  seeds: ReadonlySet<string>,
  barrel: ReadonlyMap<string, string>,
  decls: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const via = new Map<string, string>();
  const frontier = [...seeds];
  while (frontier.length > 0) {
    const from = frontier.pop()!;
    for (const token of (decls.get(from) ?? '').matchAll(IDENT)) {
      const name = token[0];
      if (name === from || !barrel.has(name) || seeds.has(name) || via.has(name)) continue;
      via.set(name, from);
      frontier.push(name);
    }
  }
  return via;
}

const barrel = barrelExports();
const docNames = documented();
const consumers = consumed();
const reasoned = new Map<string, string>();
for (const [reason, names] of Object.entries(PUBLIC_BY_REASON)) {
  for (const name of names) reasoned.set(name, reason);
}
const errorClasses = new Set(
  [...barrel].filter(([, module]) => module === './errors.ts').map(([name]) => name),
);

describe('the barrel exports what is documented, consumed, reachable or reasoned (ADR-0005)', () => {
  it('is non-vacuous: the barrel, the docs and the consumers all parsed', () => {
    expect(barrel.size, 'no exports parsed from src/index.ts').toBeGreaterThan(100);
    expect(docNames.size, 'no backticked names parsed from the docs').toBeGreaterThan(50);
    expect(
      [...consumers.keys()].filter((name) => barrel.has(name)).length,
      'no workspace consumer imports anything from the barrel — the scan is broken',
    ).toBeGreaterThan(5);
    expect(errorClasses.size, 'no error classes found behind `export *`').toBeGreaterThan(5);
  });

  it('every barrel export is accounted for under exactly one clause', () => {
    const seeds = new Set<string>([
      ...[...barrel.keys()].filter((name) => docNames.has(name) || consumers.has(name)),
      ...errorClasses,
      ...reasoned.keys(),
    ]);
    const via = reachable(seeds, barrel, declarations());
    const stray = [...barrel.keys()].filter((name) => !seeds.has(name) && !via.has(name));
    expect(
      stray,
      `src/index.ts exports ${String(stray.length)} name(s) that nothing accounts for — ` +
        `${stray.join(', ')}. Each is ` +
        `a promise the 0.x API makes by accident. Document it, consume it, make it reachable ` +
        `from a public signature, or list it under a reason in PUBLIC_BY_REASON — or un-export it.`,
    ).toEqual([]);
  });

  it('every reasoned export is still on the barrel, and still needs its reason', () => {
    for (const [name, reason] of reasoned) {
      expect(
        barrel.has(name),
        `PUBLIC_BY_REASON lists \`${name}\` ("${reason}") but the barrel no longer exports it — retire the entry`,
      ).toBe(true);
      expect(
        docNames.has(name) || consumers.has(name),
        `\`${name}\` is now documented or consumed, so its PUBLIC_BY_REASON entry ("${reason}") ` +
          `restates a fact another artefact already witnesses — retire the entry`,
      ).toBe(false);
    }
  });

  it('every name a workspace consumer imports is still exported — un-exporting cannot break a build this repository owns', () => {
    for (const [name, file] of consumers) {
      expect(
        barrel.has(name),
        `${file} imports \`${name}\` from @smeltjs/core, and src/index.ts no longer exports it`,
      ).toBe(true);
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'barrel-leaks-an-internal',
    file: 'index.ts',
    find: "export { extractTags } from './repomap/tags.ts';",
    replace:
      "export { extractTags } from './repomap/tags.ts';\nexport { rankDefinitions } from './repomap/rank.ts';",
    why: 'an internal re-exported from the barrel with no document, consumer, signature or reason behind it — the accidental promise ADR-0005 exists to refuse, and the shape every one of the eighty names 0.10.0 removed arrived in',
  },
  {
    id: 'barrel-drops-a-consumed-name',
    file: 'index.ts',
    find: '  configuredStore,\n',
    replace: '',
    why: '`configuredStore` un-exported while `@smeltjs/mcp` still imports it — the guard must fail here, in core, rather than leave the break to be found when the dependent package next builds',
  },
];
