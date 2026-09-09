import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { TagsCache, tagsCacheKey, TAGS_CACHE_FORMAT } from '@guard/repomap/cache';
import {
  buildRepoMap,
  DEFAULT_REPO_IGNORE,
  REPO_MAP_CACHE_CORRUPT_RULE,
  REPO_MAP_CACHE_UNREADABLE_RULE,
  REPO_MAP_FOCUS_RULE,
  REPO_MAP_ID,
  REPO_MAP_PATH_ONLY_RULE,
  REPO_MAP_RANKED_RULE,
  REPO_MAP_UNREFERENCED_RULE,
} from '@guard/repomap/map';
import { EXIT, runCli } from '@guard/cli/run';
import { RepoMapIoError, SmeltError } from '@guard/errors';
import { extractTags } from '@guard/repomap/tags';
import { nodeFsReader } from '@guard/repomap/reader';

import { STUB_ROOT, stubReader } from '../repo-reader-stub.ts';
import { guardSrcRoot, packageRoot, readSource } from './_source.ts';
import type { GuardMutation } from './_mutations.ts';

/**
 * REPO-MAP GUARD — the guarantees the repo map claims.
 *
 * The repo map is modelled on Aider's (https://aider.chat/docs/repomap.html) and
 * inherits this repo's laws on top of it. Each property here could quietly rot into
 * something that still *looks* like a repo map from the outside:
 *
 *  1. **Deterministic, byte for byte.** Fixed PageRank constants and a total
 *     tie-break (rank, path, name, line). Equal-rank symbols in one file must come
 *     out name-sorted — lose the tie-break and the map's ordering becomes whatever
 *     the walk happened to produce.
 *  2. **The byte budget is respected**, and the included set is a rank-order prefix.
 *     A map that overruns the budget it was handed breaks the planner contract
 *     silently; a map that skips its #2 symbol to squeeze in its #9 lies about what
 *     mattered.
 *  3. **Every inclusion is explainable** — Law 2 applied to inclusion: rule id plus
 *     a sentence naming the definition site and the measured reference counts.
 *  4. **The cache invalidates on content change.** The key is a content hash; edit
 *     the file and the stale entry must never be served again.
 *  5. **A corrupt cache entry is discarded loudly, never trusted.** Trusting one
 *     silently drops symbols from the map with no error anywhere.
 *  6. **The walk stays inside the root**: symlinks are never followed, binary files
 *     are skipped, the ignore list is honored — and without a `cacheDir` the map
 *     **writes nothing to disk at all**: the tree it reads stays byte-for-byte and
 *     mtime-identical, and no file appears anywhere in it.
 *  7. **The `smelt map` report tells the truth.** The stderr "bytes used" figure is
 *     the byte count of what actually landed on stdout, read off the RepoMap —
 *     never a second tally, never the budget dressed up as a measurement.
 *  8. **The tree is touched only through the read-only `RepoReader` seam**, and the
 *     symlink refusal is stated on `isSymlink` rather than inherited from the
 *     accident that an `lstat` of a link is neither file nor directory. Both are
 *     counted at the reader: a resolving reader's link is statted once and never
 *     read, an ignored path is never statted at all, and a `cacheDir` changes the
 *     call log by nothing.
 *  9. **The default ignore list holds the build outputs.** On a built TypeScript
 *     repo, `dist/x.js` and `dist/x.d.ts` sit beside `src/x.ts`, so a default that
 *     skipped only `.git` and `node_modules` ranked and rendered every symbol three
 *     times. A caller-supplied list still *replaces* the default wholesale — a
 *     default nobody can turn off is not a default.
 * 10. **Every failure is a `SmeltError`.** The consumer contract makes exactly one
 *     promise about errors, and the repo map is the module most able to break it: it
 *     walks a whole tree. A missing root, an unreadable file, an unusable cache
 *     directory — each arrives wrapped, naming the path, never as a raw Node errno.
 *     The tree is not the only way out: every mappable file also reaches the grammar
 *     loader, where `existsSync` reports a `.wasm`'s *presence* and never its
 *     readability, so an unreadable or truncated grammar leaked a raw `EACCES` or a
 *     V8 `RangeError` past the same `catch`. That path is pinned here too.
 * 11. **The tags cache is bounded, and the bound is never fatal.** The key is a
 *     content hash, so an edit orphans an entry rather than replacing it; unswept,
 *     every pre-edit version of every file lives forever. Each build sweeps what it
 *     did not use — and a miss may only make the next map slower, never different,
 *     which is also why a sweep that cannot even list its directory reports `0`
 *     rather than throwing away a map that was already computed.
 * 12. **The ranking's resolution limit is written down, and its numbers are pinned.**
 *     References bind by bare identifier, so same-name symbols across files — and two
 *     definitions of one name in a single file, the overload/re-export shape — share
 *     rank. That is Aider's design and not a bug (KOT-205 §3/§4): resolving properly
 *     needs per-language import/scope resolution the map deliberately does not do.
 *     Undocumented it is a trap, so the behaviour and the sentences describing it are
 *     both pinned here — cross-file and same-file.
 * 13. **A damaged cache entry is discarded by *why*, and neither side crashes the
 *     map (KOT-205 §5).** `read()` used to let a non-`ENOENT` failure (`EISDIR`
 *     because the entry path is now a directory, `EACCES` because the process lost
 *     permission) escape uncaught and crash the whole map over one damaged entry it
 *     did not need. It is discarded instead, named `'corrupt'` or `'unreadable'`
 *     honestly rather than lumped together, and an entry the discard cannot even
 *     delete is reported as undeleted rather than claimed gone — the write that
 *     follows every discard is equally non-fatal.
 * 14. **A file's `stat` and its `read` are adjacent, closing the scan's own
 *     two-phase gap (KOT-205 §6).** The walk used to vet every path first and only
 *     then, in a second pass over the finished list, read each one — so a path
 *     already cleared as "not a symlink" could sit unread for as long as the rest of
 *     the tree's scan, wide open to being swapped for a symlink escaping `root` in
 *     the meantime. Reading a file in the same walk step that just vetted it closes
 *     that window; what remains is the single `stat`-then-`read` pair itself, the
 *     same residue any program accepts when it opens a path by name.
 *
 * Mutations for 1, 2, 4, 5, 7, 8, 9, 10, 11, 12, 13 and 14 live in the MUTATIONS
 * export at the bottom of this file; `pnpm mutate` proves each one turns this file
 * red.
 */

const fixtureRoot = fileURLToPath(new URL('../fixtures/repomap-repo', import.meta.url));

const scratchDirs: string[] = [];
afterAll(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratchDirs.push(dir);
  return dir;
}

const BUDGET = 10_000;

describe('the repo map keeps its claims', () => {
  it('is deterministic: two runs are byte-identical, with or without a cache', async () => {
    const cold = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    const again = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(again.text).toBe(cold.text);
    expect(JSON.stringify(again)).toBe(JSON.stringify(cold));

    // A cache must be an optimization, never an author: the map built through a cold
    // cache and through a warm one is the same map, byte for byte.
    const cacheDir = scratch('smelt-repomap-cache-');
    const cachedCold = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    const cachedWarm = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    expect(cachedCold.text).toBe(cold.text);
    expect(cachedWarm.text).toBe(cold.text);
    expect(cachedWarm.entries).toEqual(cold.entries);
  });

  it('breaks rank ties by path and name, so equal-rank symbols never reorder', async () => {
    const map = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    // src/ties.ts defines zuluTie before alphaTie; both are unreferenced, so their
    // ranks are equal and only the tie-break decides. Name order must win over
    // document order.
    const tieNames = map.entries
      .filter((entry) => entry.path === 'src/ties.ts')
      .map((entry) => entry.name);
    expect(tieNames).toEqual(['alphaTie', 'zuluTie']);
  });

  it('ranks the cross-file symbol first and fits the budget with a rank-order prefix', async () => {
    const full = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(full.id).toBe(REPO_MAP_ID);
    expect(full.outputBytes).toBeLessThanOrEqual(BUDGET);
    expect(full.outputBytes).toBe(Buffer.byteLength(full.text, 'utf8'));
    // readSettings is the only symbol referenced from another file, so PageRank must
    // put it first — ahead of every unreferenced definition.
    expect(full.entries[0]?.name).toBe('readSettings');
    expect(full.entries[0]?.rank).toBeGreaterThan(0);
    expect(full.definitionsTotal).toBe(full.entries.length);

    // A budget that only fits the first line: the map keeps exactly the top-ranked
    // symbol and stays under budget — never over, never a different symbol.
    const firstLine = full.text.split('\n')[0]!;
    const tight = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: Buffer.byteLength(firstLine, 'utf8') + 1,
    });
    expect(tight.outputBytes).toBeLessThanOrEqual(tight.budgetBytes);
    expect(tight.entries.map((entry) => entry.name)).toEqual(['readSettings']);
    expect(tight.definitionsTotal).toBe(full.definitionsTotal);
    expect(tight.pathOnly).toEqual([]);

    // A budget nothing fits: an empty map, not an overrun one.
    const none = await buildRepoMap({ root: fixtureRoot, budgetBytes: 3 });
    expect(none.text).toBe('');
    expect(none.entries).toEqual([]);
  });

  it('explains every inclusion: rule id, definition site, measured counts', async () => {
    const map = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(map.entries.length, 'no entries — this guard would be vacuous').toBeGreaterThan(3);
    for (const entry of map.entries) {
      expect([REPO_MAP_RANKED_RULE, REPO_MAP_UNREFERENCED_RULE]).toContain(entry.reason.rule);
      expect(entry.reason.explanation).toMatch(/^defined at .+:\d+/);
    }
    const top = map.entries[0]!;
    expect(top.reason.rule).toBe(REPO_MAP_RANKED_RULE);
    expect(top.reason.explanation).toMatch(/\d+ references? in from \d+ files?/);
    expect(top.reason.explanation).toMatch(/\d+ references? out/);
    const unreferenced = map.entries.find((entry) => entry.name === 'unusedHelper');
    expect(unreferenced?.reason.rule).toBe(REPO_MAP_UNREFERENCED_RULE);
    expect(unreferenced?.reason.explanation).toContain('no references');

    // Files with nothing parseable are still visible, with their own rule.
    const notes = map.pathOnly.find((entry) => entry.path === 'notes.md');
    expect(notes?.reason.rule).toBe(REPO_MAP_PATH_ONLY_RULE);
    expect(notes?.reason.explanation).not.toBe('');
  });

  it('counts cache activity honestly: all misses cold, all hits warm', async () => {
    const cacheDir = scratch('smelt-repomap-counts-');
    const cold = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    expect(cold.cache).toBeDefined();
    expect(cold.cache!.hits).toBe(0);
    expect(cold.cache!.misses).toBeGreaterThan(0);
    expect(cold.cache!.discarded).toBe(0);

    const warm = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET, cacheDir });
    expect(warm.cache!.hits).toBe(cold.cache!.misses);
    expect(warm.cache!.misses).toBe(0);

    // No cacheDir handed in → no cache counts invented, and nothing written to disk.
    const uncached = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(uncached.cache).toBeUndefined();
  });

  it('invalidates the cache when file content changes', async () => {
    const root = scratch('smelt-repomap-edit-');
    const cacheDir = scratch('smelt-repomap-edit-cache-');
    const file = join(root, 'only.ts');

    writeFileSync(file, 'export function firstName(): string {\n  return "one";\n}\n');
    const before = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(before.entries.map((entry) => entry.name)).toContain('firstName');

    writeFileSync(file, 'export function secondName(): string {\n  return "two";\n}\n');
    const after = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(
      after.entries.map((entry) => entry.name),
      'the edited file was answered with stale cached tags',
    ).toContain('secondName');
    expect(after.entries.map((entry) => entry.name)).not.toContain('firstName');
  });

  it('discards a corrupt cache entry loudly — a warning and a re-extraction, never trust', async () => {
    const root = scratch('smelt-repomap-corrupt-');
    const cacheDir = scratch('smelt-repomap-corrupt-cache-');
    const content = 'export function survivor(): string {\n  return "here";\n}\n';
    writeFileSync(join(root, 'only.ts'), content);

    // Plant an entry at the exact key the build will look up: valid JSON, wrong
    // shape (a version this code does not understand, so its tags cannot be trusted).
    const key = tagsCacheKey('typescript', content);
    mkdirSync(join(cacheDir, 'tags'), { recursive: true });
    writeFileSync(
      join(cacheDir, 'tags', `${key}.json`),
      `${JSON.stringify({ format: TAGS_CACHE_FORMAT, version: 999, defs: [], refs: [] })}\n`,
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(map.cache!.discarded).toBe(1);
    expect(map.warnings.map((warning) => warning.rule)).toContain(REPO_MAP_CACHE_CORRUPT_RULE);
    expect(map.warnings[0]!.explanation).toContain('only.ts');
    // The symbol still appears — re-extracted from source, not lost to the bad entry.
    expect(map.entries.map((entry) => entry.name)).toContain('survivor');

    // The discard rewrote a valid entry: the next build hits cleanly, no warning.
    const healed = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(healed.warnings).toEqual([]);
    expect(healed.cache!.hits).toBe(1);
    expect(healed.cache!.discarded).toBe(0);
  });

  it('never follows a symlink, so the walk cannot leave the root', async () => {
    const root = scratch('smelt-repomap-links-');
    const outside = scratch('smelt-repomap-outside-');
    writeFileSync(
      join(root, 'real.ts'),
      'export function insideTheRoot(): number {\n  return 1;\n}\n',
    );
    writeFileSync(
      join(outside, 'secret.ts'),
      'export function leakedSecretToken(): number {\n  return 2;\n}\n',
    );
    symlinkSync(join(outside, 'secret.ts'), join(root, 'link.ts'));
    symlinkSync(outside, join(root, 'linkdir'));

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    expect(map.filesScanned).toBe(1);
    const names = map.entries.map((entry) => entry.name);
    expect(names).toContain('insideTheRoot');
    expect(names, 'a symlink was followed out of the root').not.toContain('leakedSecretToken');
    expect(map.text).not.toContain('leakedSecretToken');
  });

  it('writes nothing to disk without a cacheDir — the tree it reads stays untouched', async () => {
    // The help text promises "the map writes nothing to disk unless --cache names a
    // directory". `cache === undefined` on the result is not that promise — it says
    // no *counts* were kept, not that no bytes landed. So this pins the claim at the
    // filesystem: every path, every byte, every mtime in the scanned tree identical
    // before and after, and no file created anywhere in it.
    const root = scratch('smelt-repomap-readonly-');
    mkdirSync(join(root, 'lib'));
    writeFileSync(
      join(root, 'main.ts'),
      "import { helper } from './lib/helper.ts';\n\nexport function entry(): number {\n  return helper();\n}\n",
    );
    writeFileSync(
      join(root, 'lib', 'helper.ts'),
      'export function helper(): number {\n  return 41;\n}\n',
    );

    interface TreeRecord {
      readonly path: string;
      readonly kind: 'dir' | 'file';
      readonly mtimeMs: number;
      readonly content?: string;
    }
    const snapshotTree = (dir: string, prefix = ''): TreeRecord[] => {
      const records: TreeRecord[] = [];
      for (const entry of readdirSync(dir).toSorted()) {
        const full = join(dir, entry);
        const rel = prefix === '' ? entry : `${prefix}/${entry}`;
        const stat = statSync(full);
        if (stat.isDirectory()) {
          records.push({ path: rel, kind: 'dir', mtimeMs: stat.mtimeMs });
          records.push(...snapshotTree(full, rel));
        } else {
          records.push({
            path: rel,
            kind: 'file',
            mtimeMs: stat.mtimeMs,
            content: readFileSync(full, 'utf8'),
          });
        }
      }
      return records;
    };

    const before = snapshotTree(root);
    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    expect(
      map.entries.length,
      'nothing mapped — the untouched-tree check is vacuous',
    ).toBeGreaterThan(0);
    expect(map.cache).toBeUndefined();
    expect(
      snapshotTree(root),
      'the scanned tree changed — a file was created, rewritten or touched with no cacheDir given',
    ).toEqual(before);
  });

  it('skips binary files and honors the caller-supplied ignore list', async () => {
    // The committed fixture carries data.bin (contains a NUL byte). Self-check that
    // it is really there, so this test cannot go vacuous if the fixture moves.
    expect(readdirSync(fixtureRoot)).toContain('data.bin');

    const map = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    expect(map.binarySkipped).toBeGreaterThanOrEqual(1);
    expect(map.text).not.toContain('data.bin');
    expect(map.pathOnly.map((entry) => entry.path)).not.toContain('data.bin');

    const ignored = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      ignore: ['tools', 'src/ties.ts'],
    });
    const names = ignored.entries.map((entry) => entry.name);
    expect(names).not.toContain('tally');
    expect(names).not.toContain('alphaTie');
    expect(names).toContain('readSettings');
  });

  it('refuses a budget that is not a positive integer', async () => {
    await expect(buildRepoMap({ root: fixtureRoot, budgetBytes: 0 })).rejects.toThrow(SmeltError);
    await expect(buildRepoMap({ root: fixtureRoot, budgetBytes: 1.5 })).rejects.toThrow(SmeltError);
  });

  it('counts refsOut once per reference, not once per definer file (Law 4)', async () => {
    // `dup` is defined in TWO other files. a.ts makes exactly 2 references to it, so
    // its "references out" is 2 — an implementation that walks the per-definer edge
    // loop for this number reports 4, and every explanation a.ts's symbols carry
    // states a number nothing measured.
    const root = scratch('smelt-repomap-refsout-');
    writeFileSync(
      join(root, 'a.ts'),
      'export function useDup(): number {\n  return dup() + dup();\n}\n' +
        'export function callUseDup(): number {\n  return useDup();\n}\n',
    );
    writeFileSync(join(root, 'b.ts'), 'export function dup(): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'c.ts'), 'export function dup(): number {\n  return 2;\n}\n');

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    const useDup = map.entries.find((entry) => entry.name === 'useDup');
    expect(useDup).toBeDefined();
    expect(useDup!.refsOut).toBe(2);
    expect(useDup!.reason.explanation).toContain('makes 2 references out');
    expect(map.text).toContain('useDup [1 in from 1 file, 2 out]');
  });

  it('never reports a bodiless C/C++ specifier as a definition (Law 2 — the receipt must be true)', async () => {
    // `struct point p;` parses as a struct_specifier exactly like the bodied
    // definition does. Reporting it as a definition mints a false `defined at`
    // receipt, AND poisons defNameStarts so the usage no longer counts as a
    // reference — the true definition's cross-file rank silently evaporates.
    // Mutation: `pnpm mutate` removes the body requirement, and this must go red.
    const tags = await extractTags(
      [
        'struct point {',
        '  int x;',
        '  int y;',
        '};',
        '',
        'enum color {',
        '  RED,',
        '  BLUE,',
        '};',
        '',
        'struct point origin(void);',
        '',
        'enum color pick(struct point p);',
        '',
      ].join('\n'),
      'c',
    );

    // Exactly the 2 real definitions — the usage sites must not add fake ones.
    expect(tags.defs.map((def) => `${def.kind} ${def.name}`)).toEqual([
      'struct point',
      'enum color',
    ]);
    // And the usage sites now count as references, so the true definitions regain
    // their cross-file rank: `point` is mentioned twice below its definition
    // (`origin`'s return type and `pick`'s parameter), `color` once.
    expect(tags.refs).toContainEqual({ name: 'point', count: 2 });
    expect(tags.refs).toContainEqual({ name: 'color', count: 1 });
  });

  it('regains cross-file references for a C definition mentioned in another file', async () => {
    // The audit's shape end to end: the header defines `struct point`; the consumer
    // file only *mentions* the type. Before the body check, the consumer's mention
    // was itself reported as a definition (with a fake receipt) and its name node
    // swallowed the reference — so the real definition ranked as unreferenced.
    const root = scratch('smelt-repomap-cspec-');
    writeFileSync(join(root, 'point.h'), 'struct point {\n  int x;\n  int y;\n};\n');
    writeFileSync(
      join(root, 'use.c'),
      'struct point make_origin(void);\n\nstruct point make_origin(void) {\n' +
        '  struct point p;\n  p.x = 0;\n  p.y = 0;\n  return p;\n}\n',
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    const pointDefs = map.entries.filter((entry) => entry.name === 'point');
    expect(pointDefs, 'the bodiless mentions in use.c minted extra definitions').toHaveLength(1);
    expect(pointDefs[0]!.path).toBe('point.h');
    expect(pointDefs[0]!.reason.rule).toBe(REPO_MAP_RANKED_RULE);
    expect(pointDefs[0]!.refsIn, 'the usage sites no longer count as references').toBeGreaterThan(
      0,
    );
    expect(pointDefs[0]!.refsInFiles).toBe(1);
  });

  it('treats a trailing-slash ignore entry as the documented root-relative prefix', async () => {
    // `build/` contains a `/`, so the doc promises prefix matching: the root-level
    // build tree is skipped, and a nested `deep/build` — a different path entirely —
    // is not. Stripping the slash first used to demote `build/` to a bare name that
    // matched every `build` segment at any depth.
    const root = scratch('smelt-repomap-slash-');
    mkdirSync(join(root, 'build'), { recursive: true });
    mkdirSync(join(root, 'deep', 'build'), { recursive: true });
    writeFileSync(
      join(root, 'build', 'top.ts'),
      'export function topLevelArtifact(): number {\n  return 1;\n}\n',
    );
    writeFileSync(
      join(root, 'deep', 'build', 'nested.ts'),
      'export function nestedKeeper(): number {\n  return 2;\n}\n',
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET, ignore: ['build/'] });
    const names = map.entries.map((entry) => entry.name);
    expect(names, 'the root-level build/ tree was not ignored').not.toContain('topLevelArtifact');
    expect(
      names,
      'a trailing-slash entry leaked into bare-name mode and ate deep/build too',
    ).toContain('nestedKeeper');
  });

  it('promotes a focus match without touching its measured numbers, and says which term', async () => {
    const plain = await buildRepoMap({ root: fixtureRoot, budgetBytes: BUDGET });
    const focused = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      focus: ['unusedHelper'],
    });

    // Promotion only: place in the fill order changes, rank and counts do not.
    const top = focused.entries[0]!;
    expect(top.name).toBe('unusedHelper');
    expect(top.reason.rule).toBe(REPO_MAP_FOCUS_RULE);
    expect(top.reason.explanation).toContain('matches focus "unusedHelper"');
    const unpromoted = plain.entries.find((entry) => entry.name === 'unusedHelper')!;
    expect(top.rank).toBe(unpromoted.rank);
    expect(top.refsIn).toBe(unpromoted.refsIn);

    // Deterministic with focus too — a stable partition of a total order.
    const again = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      focus: ['unusedHelper'],
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(focused));
  });

  it('reports bytes used truthfully through the CLI: the stderr figure IS the stdout byte count', async () => {
    // `smelt map`'s report law, same as the smelt report's: every number is read off
    // the RepoMap the library returned, never tallied separately. The mutation
    // `repomap-map-report-bytes-invented` wires the figure to the budget and this
    // assertion must go red — a budget-fitting report that lies about bytes used
    // would make the one honest number in the subcommand a decoration.
    let stdout = '';
    let stderr = '';
    const code = await runCli(['map', fixtureRoot, '--budget', String(BUDGET)], {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
      stdin: () => '',
      version: '0.0.0-guard',
    });
    expect(code).toBe(EXIT.ok);

    const match = stderr.match(/bytes used ([\d,]+) of ([\d,]+) budget/);
    expect(match, 'the report no longer states bytes used against the budget').not.toBeNull();
    const reported = Number(match![1]!.replaceAll(',', ''));
    expect(reported, 'the report lies about the bytes the map used').toBe(
      Buffer.byteLength(stdout, 'utf8'),
    );
    expect(Number(match![2]!.replaceAll(',', ''))).toBe(BUDGET);
  });

  it('refuses a symlink on isSymlink itself, counted call by call at the reader', async () => {
    // The real-filesystem check above passes for a weak reason: an `lstat` of a
    // symlink reports neither file nor directory, so a walk with no refusal at all
    // would skip it anyway. That accident is not the guarantee. This pins the
    // guarantee: a reader whose `stat` RESOLVES the link — `isFile: true`, readable
    // bytes behind it — must still be refused, and the refusal is visible in the
    // call log: the link is statted once and never read, never listed.
    // Mutation `repomap-symlink-refusal-dropped` deletes the check and this goes red.
    const reader = stubReader({
      'real.ts': {
        kind: 'file',
        content: 'export function insideTheRoot(): number {\n  return 1;\n}\n',
      },
      'link.ts': {
        kind: 'symlink',
        content: 'export function leakedSecretToken(): number {\n  return 2;\n}\n',
      },
    });

    const map = await buildRepoMap({ root: STUB_ROOT, budgetBytes: BUDGET, reader });

    expect(reader.opsFor('link.ts'), 'the walk went through a symlink').toEqual(['stat']);
    expect(reader.opsFor('real.ts')).toEqual(['stat', 'read']);
    expect(map.filesScanned).toBe(1);
    expect(map.entries.map((entry) => entry.name)).toEqual(['insideTheRoot']);
    expect(map.text).not.toContain('leakedSecretToken');
  });

  it('touches the tree only through the read-only seam, and identically with or without a cache', async () => {
    // Law 1's sibling ruling — smelt writes nothing outside a store or cache it was
    // handed — counted rather than described. `RepoReader` is the map's whole door to
    // the tree and it has no writer on it (the shape assertion below), so the walk's
    // entire filesystem contact is this log: one listing per directory, one stat per
    // entry the ignore list kept, one read per file. An ignored path is not even
    // statted, and handing in a cacheDir changes the log by nothing at all — the
    // bytes that land on disk are the cache the caller named, never a by-product of
    // reading.
    const tree = {
      'src/only.ts': {
        kind: 'file' as const,
        content: 'export function onlySymbol(): number {\n  return 1;\n}\n',
      },
      'src/nested/deep.ts': {
        kind: 'file' as const,
        content: 'export function deepSymbol(): number {\n  return 2;\n}\n',
      },
      'skipme/huge.ts': {
        kind: 'file' as const,
        content: 'export function ignoredSymbol(): number {\n  return 3;\n}\n',
      },
    };
    // Every file's `read` sits immediately after its own `stat` — never after some
    // other file's `stat`, the way a whole-tree-scan-then-whole-tree-read design would
    // order them. That adjacency is the TOCTOU fix (KOT-205 §6): the symlink refusal
    // and the byte read happen in the same walk step, so nothing sits "vetted, not yet
    // read" across the rest of the tree's scan. `deep.ts` sits deeper in the walk than
    // `only.ts` but is read before it, because it is read where it is found.
    const EXPECTED_CALLS = [
      { op: 'list', path: '' },
      { op: 'stat', path: 'src' },
      { op: 'list', path: 'src' },
      { op: 'stat', path: 'src/nested' },
      { op: 'list', path: 'src/nested' },
      { op: 'stat', path: 'src/nested/deep.ts' },
      { op: 'read', path: 'src/nested/deep.ts' },
      { op: 'stat', path: 'src/only.ts' },
      { op: 'read', path: 'src/only.ts' },
    ];

    const bare = stubReader(tree);
    const uncached = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      ignore: ['skipme'],
      reader: bare,
    });
    expect(bare.calls).toEqual(EXPECTED_CALLS);
    expect(bare.opsFor('skipme'), 'an ignored path was statted').toEqual([]);
    expect(bare.opsFor('skipme/huge.ts'), 'an ignored file was touched').toEqual([]);
    expect(uncached.cache, 'cache counts invented with no cacheDir').toBeUndefined();

    // The same tree with a cacheDir: identical reader calls, cold and warm.
    const cacheDir = scratch('smelt-repomap-seam-cache-');
    const cold = stubReader(tree);
    const coldMap = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      ignore: ['skipme'],
      reader: cold,
      cacheDir,
    });
    const warm = stubReader(tree);
    const warmMap = await buildRepoMap({
      root: STUB_ROOT,
      budgetBytes: BUDGET,
      ignore: ['skipme'],
      reader: warm,
      cacheDir,
    });
    expect(cold.calls).toEqual(EXPECTED_CALLS);
    expect(warm.calls).toEqual(EXPECTED_CALLS);
    expect(coldMap.cache).toEqual({ hits: 0, misses: 2, discarded: 0, pruned: 0 });
    expect(warmMap.cache).toEqual({ hits: 2, misses: 0, discarded: 0, pruned: 0 });
    expect(warmMap.text).toBe(uncached.text);

    // And the seam itself carries no way to write: three read-only methods, and a
    // fourth one appearing here is a Law 1 conversation, not a merge.
    expect(Object.keys(nodeFsReader()).toSorted()).toEqual(['list', 'read', 'stat']);
  });

  it('ignores build output by default, so a built repo is not mapped three times over', async () => {
    // The defect this pins: `dist/` was not on the default list, so on any built
    // TypeScript repo the default map carried src/x.ts, dist/x.js AND dist/x.d.ts —
    // every symbol three times, the copies referencing each other, two-thirds of the
    // map its own compiler output.
    const root = scratch('smelt-repomap-built-');
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'thing.ts'),
      'export function builtSymbol(): number {\n  return 1;\n}\n',
    );
    const skipped = ['.git', 'node_modules', 'dist', 'build', 'out', 'coverage'];
    for (const dir of skipped) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(
        join(root, dir, 'thing.js'),
        'export function builtSymbol() {\n  return 1;\n}\n',
      );
    }
    for (const dir of skipped) {
      expect(DEFAULT_REPO_IGNORE, `${dir} fell off the default ignore list`).toContain(dir);
    }

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    expect(map.filesScanned, 'a build-output directory was walked by default').toBe(1);
    expect(
      map.entries.filter((entry) => entry.name === 'builtSymbol'),
      'the same symbol was ranked once per build-output copy of its file',
    ).toHaveLength(1);
    expect(map.entries[0]!.path).toBe('src/thing.ts');

    // And the documented contract survives: a caller's list REPLACES the default, it
    // is not merged with it — otherwise there is no way to say "map my dist, I meant
    // it", and a default that cannot be turned off is not a default.
    const replaced = await buildRepoMap({ root, budgetBytes: BUDGET, ignore: ['coverage'] });
    expect(
      replaced.filesScanned,
      'a caller-supplied ignore list was merged with the default instead of replacing it',
    ).toBe(1 + skipped.length - 1);
  });

  it('wraps every filesystem failure in a SmeltError naming the path — no raw errno escapes', async () => {
    // The contract's one promise about errors is that catching SmeltError is enough.
    // buildRepoMap({root: '/nonexistent'}) used to throw the bare ENOENT readdirSync
    // raises, so a caller doing exactly what the docs say still had an escape.
    const missingRoot = join(scratch('smelt-repomap-missing-'), 'no-such-tree');
    const missing = await buildRepoMap({ root: missingRoot, budgetBytes: BUDGET }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(missing, 'a missing root stopped failing at all').toBeDefined();
    expect(
      missing,
      'a raw Node error escaped buildRepoMap — the SmeltError guarantee has a hole in it',
    ).toBeInstanceOf(SmeltError);
    expect(missing).toBeInstanceOf(RepoMapIoError);
    expect((missing as Error).message, 'the failure does not name the path').toContain(missingRoot);
    expect((missing as Error).message).toContain('ENOENT');
    expect(
      (missing as Error).cause,
      'the original error was thrown away, not wrapped',
    ).toBeDefined();

    // A file that lists but will not read: same promise, through the reader seam.
    const reader = stubReader({
      'only.ts': { kind: 'file', content: 'export function fine(): number {\n  return 1;\n}\n' },
      'locked.ts': { kind: 'unreadable', reason: 'EACCES' },
    });
    await expect(
      buildRepoMap({ root: STUB_ROOT, budgetBytes: BUDGET, reader }),
    ).rejects.toBeInstanceOf(SmeltError);

    // And a cache directory that cannot be made, because a file is already there.
    const occupied = join(scratch('smelt-repomap-cachefile-'), 'not-a-dir');
    writeFileSync(occupied, 'this is a file, not a cache directory\n');
    const cacheFailure = await buildRepoMap({
      root: fixtureRoot,
      budgetBytes: BUDGET,
      cacheDir: occupied,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(cacheFailure, 'an unusable cache directory stopped failing at all').toBeDefined();
    expect(cacheFailure, 'a raw Node error escaped the tags cache').toBeInstanceOf(SmeltError);
    expect((cacheFailure as Error).message).toContain(occupied);
  });

  it('bounds the tags cache: a superseded entry is swept, never left to accumulate', async () => {
    const root = scratch('smelt-repomap-bounded-');
    const cacheDir = scratch('smelt-repomap-bounded-cache-');
    const file = join(root, 'only.ts');
    const onDisk = (): readonly string[] =>
      readdirSync(join(cacheDir, 'tags')).filter((name) => name.endsWith('.json'));

    let last = '';
    for (let edit = 0; edit < 4; edit += 1) {
      writeFileSync(file, `export function edit${String(edit)}(): number {\n  return 1;\n}\n`);
      const map = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
      expect(
        map.entries.map((entry) => entry.name),
        'the edited file was answered with stale cached tags',
      ).toEqual([`edit${String(edit)}`]);
      expect(
        onDisk(),
        'the cache kept the pre-edit entry — keyed by content hash and never evicted, it grows without bound across a session',
      ).toHaveLength(1);
      expect(map.cache!.pruned, 'the sweep count is not the number of entries removed').toBe(
        edit === 0 ? 0 : 1,
      );
      last = map.text;
    }

    // The rule any bound here must meet: a miss may cost a re-parse and nothing else.
    // Throw the whole cache away and the map is byte-identical, merely colder.
    rmSync(cacheDir, { recursive: true, force: true });
    const cold = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(cold.cache).toEqual({ hits: 0, misses: 1, discarded: 0, pruned: 0 });
    expect(cold.text, 'an emptied cache changed the map instead of only slowing it').toBe(last);
  });

  it('keeps a grammar that resolves but will not load inside the contract', async () => {
    // The SmeltError promise is not only about `node:fs` under src/repomap/. Every
    // mappable file in the tree reaches the grammar loader, and `grammarPath`'s
    // `existsSync` reports a `.wasm`'s PRESENCE, never its readability — so a grammar
    // that resolved and then would not load threw a raw error: `EACCES` from an
    // unreadable file, a V8 `RangeError`/`CompileError` from a truncated or
    // half-extracted one, straight past a caller catching SmeltError.
    //
    // Breaking the real bundled grammars would race every other test file, so the
    // loader is exercised in an isolated copy of the guard source instead:
    // `grammar.ts` resolves `../../grammars/` against its own module URL, so a copy at
    // <scratch>/src/plan/grammar.ts reads <scratch>/grammars/. The copy is taken from
    // the guard source root, so a mutation applied to `plan/grammar.ts` travels into
    // it, and `errors.ts` is imported from the same copy because class identity does
    // not cross module graphs.
    const parent = join(packageRoot(), '.guard-scratch');
    mkdirSync(parent, { recursive: true });
    const isolated = mkdtempSync(join(parent, 'grammar-'));
    scratchDirs.push(isolated);
    cpSync(guardSrcRoot(), join(isolated, 'src'), { recursive: true });
    const grammars = join(isolated, 'grammars');
    mkdirSync(grammars, { recursive: true });
    // Present, and unreadable: a directory where the `.wasm` belongs, so the read
    // fails with an errno the way a permission or ownership problem does.
    mkdirSync(join(grammars, 'tree-sitter-typescript.wasm'));
    // Present, readable, and not a grammar: the truncated-tarball case, where the
    // raw error comes from V8 rather than from Node and carries no `code` at all.
    writeFileSync(join(grammars, 'tree-sitter-python.wasm'), 'not a wasm module\n');

    const loader: typeof import('@guard/plan/grammar') = await import(
      pathToFileURL(join(isolated, 'src', 'plan', 'grammar.ts')).href
    );
    const errors: typeof import('@guard/errors') = await import(
      pathToFileURL(join(isolated, 'src', 'errors.ts')).href
    );

    for (const language of ['typescript', 'python'] as const) {
      const failure = await loader.loadGrammar(language).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure, `an unusable ${language} grammar stopped failing at all`).toBeDefined();
      expect(
        failure,
        `a raw error escaped loadGrammar for ${language} — the SmeltError guarantee has a hole in it`,
      ).toBeInstanceOf(errors.SmeltError);
      expect(failure).toBeInstanceOf(errors.GrammarUnavailableError);
      expect((failure as Error).message, 'the failure does not name the grammar path').toContain(
        join(grammars, `tree-sitter-${language}.wasm`),
      );
      expect(
        (failure as Error).cause,
        'the original error was thrown away, not wrapped',
      ).toBeDefined();
    }
  });

  it('never fails a computed map over the cache sweep: an unlistable directory prunes 0', async () => {
    // The sweep is housekeeping, and it runs after the tree has been walked, ranked
    // and rendered. A listing that throws therefore destroys a finished map over a
    // cache smelt only wanted to tidy — the trade this cache is forbidden to make,
    // and one an ordinary external cleaner can trigger by removing the directory
    // between the last write and the sweep.
    const cacheDir = scratch('smelt-repomap-sweep-');
    const cache = new TagsCache(cacheDir);
    rmSync(join(cacheDir, 'tags'), { recursive: true, force: true });
    expect(
      cache.sweep(new Set<string>()),
      'a cache directory that vanished under the sweep failed the whole map instead of pruning nothing',
    ).toBe(0);

    // And end to end, with the directory present but unreadable: the map still comes
    // back, byte for byte what a healthy cache produced.
    const root = scratch('smelt-repomap-sweep-tree-');
    writeFileSync(join(root, 'only.ts'), 'export function kept(): number {\n  return 1;\n}\n');
    const healthyDir = scratch('smelt-repomap-sweep-ok-');
    const healthy = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir: healthyDir });

    const lockedDir = scratch('smelt-repomap-sweep-locked-');
    await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir: lockedDir });
    chmodSync(join(lockedDir, 'tags'), 0o333); // writable and traversable, not listable
    try {
      const locked = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir: lockedDir });
      expect(locked.text, 'the map changed because its cache could not be tidied').toBe(
        healthy.text,
      );
    } finally {
      chmodSync(join(lockedDir, 'tags'), 0o755);
    }
  });

  it('discards an unreadable cache entry (EISDIR) loudly, never crashing the map (KOT-205 §5)', async () => {
    const root = scratch('smelt-repomap-eisdir-');
    const cacheDir = scratch('smelt-repomap-eisdir-cache-');
    const content = 'export function survivor(): string {\n  return "here";\n}\n';
    writeFileSync(join(root, 'only.ts'), content);

    // A directory sits where the entry file should be — another process, an editor's
    // autosave, or a half-finished `mkdir -p` can leave exactly this. `read()` used to
    // let the resulting EISDIR escape uncaught through `fsCall` as a `RepoMapIoError`,
    // crashing the whole map over one damaged cache entry it did not even need.
    const key = tagsCacheKey('typescript', content);
    mkdirSync(join(cacheDir, 'tags', `${key}.json`), { recursive: true });

    const map = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
    expect(map.cache!.discarded).toBe(1);
    const warning = map.warnings.find((entry) => entry.rule === REPO_MAP_CACHE_UNREADABLE_RULE);
    expect(warning, 'no unreadable-cache-entry warning was reported').toBeDefined();
    expect(warning!.explanation).toContain('EISDIR');
    expect(warning!.explanation).toContain('only.ts');
    // `unlink` refuses a directory unconditionally (EPERM/EISDIR), regardless of
    // permissions, so the discard itself cannot land here — the entry stays on disk,
    // and the warning must say so honestly rather than claiming it was cleared.
    expect(
      warning!.explanation,
      'a directory entry the discard could not remove was reported as deleted',
    ).toContain('could not be deleted');
    // The map still comes back, complete — re-extracted from source, not lost.
    expect(map.entries.map((entry) => entry.name)).toContain('survivor');
  });

  it('discards an unreadable cache entry (EACCES) loudly, never crashing the map (KOT-205 §5)', async () => {
    const root = scratch('smelt-repomap-eacces-');
    const cacheDir = scratch('smelt-repomap-eacces-cache-');
    const content = 'export function survivor(): string {\n  return "here";\n}\n';
    writeFileSync(join(root, 'only.ts'), content);

    const key = tagsCacheKey('typescript', content);
    const entryDir = join(cacheDir, 'tags');
    mkdirSync(entryDir, { recursive: true });
    const entryPath = join(entryDir, `${key}.json`);
    writeFileSync(entryPath, 'irrelevant — the read is refused before this is ever examined');
    chmodSync(entryPath, 0o000);
    try {
      const map = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
      expect(map.cache!.discarded).toBe(1);
      const warning = map.warnings.find((entry) => entry.rule === REPO_MAP_CACHE_UNREADABLE_RULE);
      expect(warning, 'no unreadable-cache-entry warning was reported').toBeDefined();
      expect(warning!.explanation).toContain('EACCES');
      expect(map.entries.map((entry) => entry.name)).toContain('survivor');
    } finally {
      chmodSync(entryPath, 0o644);
    }
  });

  it('reports an undeletable cache entry honestly, and never crashes the write that follows (KOT-205 §5)', async () => {
    const root = scratch('smelt-repomap-undeletable-');
    const cacheDir = scratch('smelt-repomap-undeletable-cache-');
    const content = 'export function survivor(): string {\n  return "here";\n}\n';
    writeFileSync(join(root, 'only.ts'), content);

    const key = tagsCacheKey('typescript', content);
    const entryDir = join(cacheDir, 'tags');
    mkdirSync(entryDir, { recursive: true });
    const entryPath = join(entryDir, `${key}.json`);
    writeFileSync(entryPath, 'not valid json, so read() will try to discard it');
    // Read-and-execute, not write: `unlink` (the discard) and creating a new temp file
    // (the rewrite `read()` triggers next) both need write permission on the
    // *directory*, not the entry — so this blocks both without touching the entry
    // file's own permissions.
    chmodSync(entryDir, 0o555);
    try {
      const map = await buildRepoMap({ root, budgetBytes: BUDGET, cacheDir });
      expect(map.cache!.discarded).toBe(1);
      const warning = map.warnings.find((entry) => entry.rule === REPO_MAP_CACHE_CORRUPT_RULE);
      expect(warning, 'no corrupt-cache-entry warning was reported').toBeDefined();
      expect(
        warning!.explanation,
        'an entry this build could not delete was reported as if it had been',
      ).toContain('could not be deleted');
      // The map still comes back, complete — a write that cannot land is a slower
      // build, never a crashed one.
      expect(map.entries.map((entry) => entry.name)).toContain('survivor');
    } finally {
      chmodSync(entryDir, 0o755);
    }
  });

  it('binds references by bare identifier, and says so where a reader will meet it', async () => {
    // Aider's design, inherited on purpose, and judged not a bug: a reference tag is
    // a name, not a resolved symbol. Undocumented it is a trap, so both the behaviour
    // and the sentences describing it are pinned.
    const root = scratch('smelt-repomap-names-');
    writeFileSync(join(root, 'alpha.ts'), 'export function shared(): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'beta.ts'), 'export function shared(): number {\n  return 2;\n}\n');
    writeFileSync(
      join(root, 'caller.ts'),
      "import { shared } from './alpha.ts';\n\nexport function callIt(): number {\n  return shared();\n}\n",
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    const both = map.entries.filter((entry) => entry.name === 'shared');
    expect(both.map((entry) => entry.path).toSorted()).toEqual(['alpha.ts', 'beta.ts']);
    expect(both[0]!.refsIn, 'the guard is vacuous unless something references it').toBeGreaterThan(
      0,
    );
    // beta.ts is imported by nothing, and ranks exactly as alpha.ts does: the counts
    // are per NAME, and the receipts must never claim more resolution than that.
    expect(both[0]!.refsIn).toBe(both[1]!.refsIn);
    expect(both[0]!.refsInFiles).toBe(both[1]!.refsInFiles);
    expect(both[0]!.rank).toBe(both[1]!.rank);

    // Pinned where a reader will actually meet it: the module that emits the map and
    // the module that computes the rank each carry the statement, under a heading a
    // skimmer can see. Checking the heading and not only the phrase is deliberate —
    // "bare identifier" also appears in a field comment, so a phrase check alone
    // survives the deletion of the paragraph that explains it.
    const stated: readonly (readonly [string, string])[] = [
      ['repomap/map.ts', '**What the ranking can and cannot resolve.**'],
      ['repomap/rank.ts', '**The resolution limit, stated plainly:'],
    ];
    for (const [file, heading] of stated) {
      const source = readSource(file);
      expect(
        source,
        `${file} no longer states the ranking's resolution limit — same-name symbols still share rank, and now nothing tells a reader so`,
      ).toContain(heading);
      expect(source).toContain('bare identifier');
    }
  });

  it('doubles the rank share across two definitions of one name in a single file — overloads, not a defect (KOT-205 §4)', async () => {
    const root = scratch('smelt-repomap-overloads-');
    // tree-sitter has no duplicate-declaration check, so this parses as two separate
    // `defs` named `handle` — the same tag shape a real TypeScript overload set (two
    // signatures plus an implementation) or a re-export collision takes. The ranker
    // must not silently start splitting a name's traffic across its definers: KOT-205
    // §3/§4 kept that conflated on purpose (the alternative needs per-language
    // import/scope resolution the map deliberately does not do — see the module doc
    // on `rank.ts`), so both defs must see the SAME whole traffic, not a fraction of
    // it, exactly as the doc comment's "overloads... double-count" says.
    writeFileSync(
      join(root, 'handlers.ts'),
      'export function handle(): number {\n  return 1;\n}\n\n' +
        'export function handle(): number {\n  return 2;\n}\n',
    );
    writeFileSync(
      join(root, 'caller.ts'),
      "import { handle } from './handlers.ts';\n\n" +
        'export function callIt(): number {\n  return handle() + handle();\n}\n',
    );

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    const both = map.entries.filter((entry) => entry.name === 'handle');
    expect(both.map((entry) => entry.line).toSorted((a, b) => a - b)).toEqual([1, 5]);
    expect(both[0]!.refsIn, 'the guard is vacuous unless something references it').toBeGreaterThan(
      0,
    );
    expect(both[0]!.refsIn).toBe(both[1]!.refsIn);
    expect(both[0]!.refsInFiles).toBe(both[1]!.refsInFiles);
    expect(both[0]!.rank).toBe(both[1]!.rank);
    expect(
      both[0]!.rank,
      'the guard is vacuous unless cross-file traffic actually ranked it',
    ).toBeGreaterThan(0);
  });

  /**
   * php, kotlin and bash ship `defKinds: {}` in the language table (`RepoMapFacts`'s
   * own doc comment says why: php's `name` nodes, kotlin's field-less declarations
   * and bash's `word` function names are not the identifier-shaped nodes the
   * extraction walk reads, so they are omitted rather than guessed at). This proves
   * what that omission actually does downstream, rather than trusting the comment: a
   * file in one of these languages produces zero definitions and falls into the
   * *same* `path-only` bucket `language === 'unknown'` uses (`REPO_MAP_PATH_ONLY_RULE`
   * in `map.ts`) — the map says so, honestly, rather than rendering a
   * structurally-supported-looking file that happens to have found nothing.
   */
  it('renders php, kotlin and bash files path-only — defKinds is empty by design, and the map says so', async () => {
    const root = scratch('smelt-repomap-path-only-lang-');
    writeFileSync(
      join(root, 'greet.php'),
      '<?php\nfunction greet($name) {\n  return "hello " . $name;\n}\n',
    );
    writeFileSync(
      join(root, 'Greet.kt'),
      'class Greeter {\n  fun greet(name: String): String {\n    return "hello $name"\n  }\n}\n',
    );
    writeFileSync(join(root, 'greet.sh'), 'greet() {\n  echo "hello $1"\n}\n');

    const map = await buildRepoMap({ root, budgetBytes: BUDGET });
    for (const rel of ['greet.php', 'Greet.kt', 'greet.sh']) {
      const entry = map.pathOnly.find((e) => e.path === rel);
      expect(entry, `${rel} did not land in path-only`).toBeDefined();
      expect(entry!.reason.rule).toBe(REPO_MAP_PATH_ONLY_RULE);
      // And it never doubled up as a (name-less, rank-less) regular entry either.
      expect(map.entries.some((e) => e.path === rel)).toBe(false);
    }
    // Non-vacuity, and the reason the walk found nothing to define: extractTags
    // itself returns zero defs for each language directly, not merely "the map
    // happened to render them that way this time".
    expect((await extractTags('function greet($name) { return $name; }', 'php')).defs).toEqual([]);
    expect(
      (await extractTags('class Greeter { fun greet(): String { return "" } }', 'kotlin')).defs,
    ).toEqual([]);
    expect((await extractTags('greet() {\n  echo hi\n}', 'bash')).defs).toEqual([]);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'repomap-budget-unenforced',
    file: 'repomap/map.ts',
    find: '    if (bytes + lineBytes > budgetBytes) return false;',
    replace: '    if (false) return false;',
    why: 'the repo-map byte budget ignored — a map that overruns the budget it was handed breaks the planner contract silently',
  },
  {
    id: 'repomap-tiebreak-dropped',
    file: 'repomap/rank.ts',
    find: '  if (a.name !== b.name) return a.name < b.name ? -1 : 1;',
    replace: '  // name tie-break removed',
    why: 'the stable path+name tie-break loses its name leg — equal-rank symbols fall back to incidental document order, and byte-for-byte determinism quietly dies',
  },
  {
    id: 'repomap-cache-key-ignores-content',
    file: 'repomap/cache.ts',
    find: '  return contentHash(`${TAGS_CACHE_FORMAT}/${String(TAGS_CACHE_VERSION)}\\0${language}\\0${content}`);',
    replace:
      '  return contentHash(`${TAGS_CACHE_FORMAT}/${String(TAGS_CACHE_VERSION)}\\0${language}`);',
    why: 'the cache key no longer derived from file content — an edited file is answered with stale tags, the exact staleness a content-hash key exists to make impossible',
  },
  {
    id: 'repomap-corrupt-cache-trusted',
    file: 'repomap/cache.ts',
    find:
      '    const tags = validateEntry(parsed);\n' +
      '    if (tags === undefined) {\n' +
      '      return {\n' +
      "        kind: 'corrupt',\n" +
      "        reason: 'the entry JSON does not match the tags shape',\n" +
      '        deleted: this.#discard(key),\n' +
      '      };\n' +
      '    }',
    replace:
      '    const tags = validateEntry(parsed);\n' +
      '    if (tags === undefined) {\n' +
      '      return { defs: [], refs: [] };\n' +
      '    }',
    why: 'a corrupt cache entry quietly trusted as empty tags instead of discarded loudly — symbols vanish from the map with no warning anywhere',
  },
  {
    id: 'repomap-unreadable-cache-crashes',
    file: 'repomap/cache.ts',
    find:
      "      if (code === 'ENOENT') return undefined; // a plain miss — nothing to discard\n" +
      '      return {\n' +
      "        kind: 'unreadable',\n" +
      '        reason: describeReadFailure(error),\n' +
      '        deleted: this.#discard(key),\n' +
      '      };',
    replace: "      if (code === 'ENOENT') return undefined;\n      throw error;",
    why: 'a non-ENOENT cache-entry read failure (EISDIR because the entry path is now a directory, EACCES because the process lost permission) escapes uncaught again — fsCall wraps it into a RepoMapIoError that crashes the whole map over one damaged cache entry the map never needed, instead of the entry being discarded loudly and the build carrying on',
  },
  {
    id: 'repomap-cache-discard-reported-as-deleted',
    file: 'repomap/cache.ts',
    find:
      '      return {\n' +
      "        kind: 'unreadable',\n" +
      '        reason: describeReadFailure(error),\n' +
      '        deleted: this.#discard(key),\n' +
      '      };',
    replace:
      '      return {\n' +
      "        kind: 'unreadable',\n" +
      '        reason: describeReadFailure(error),\n' +
      '        deleted: true,\n' +
      '      };',
    why: "an unreadable cache entry's delete result hardcoded to true — an undeletable entry (a read-only cache directory, say) is then claimed gone when it is still on disk, exactly the false 'we don't know, so assume the best' this repo's stores refuse to say about a damaged entry",
  },
  {
    id: 'repomap-cache-write-crashes',
    file: 'repomap/cache.ts',
    find:
      '    try {\n' +
      "      writeFileSync(temp, body, 'utf8');\n" +
      '      renameSync(temp, target);\n' +
      '    } catch {\n' +
      '      // Not cached this build — see the doc comment above.\n' +
      '    }',
    replace: "    writeFileSync(temp, body, 'utf8');\n    renameSync(temp, target);",
    why: 'a cache write that cannot land (the cache directory turned read-only, or a damaged entry could not be deleted so the rename now targets a directory) throws instead of being treated as an optimisation that failed — a computed map is thrown away over housekeeping the map does not need to survive',
  },
  {
    id: 'repomap-refsout-per-definer',
    file: 'repomap/rank.ts',
    find: '    refsOut: refsOutByFile.get(def.path) ?? 0,',
    replace: '    refsOut: outWeight.get(def.path) ?? 0,',
    why: 'refsOut reported from the PageRank edge denominator, which grows once per definer file — a reference to a name two files define counts double, and every Law 2 explanation states a number nothing measured',
  },
  {
    id: 'repomap-usage-site-counted-as-definition',
    file: 'repomap/tags.ts',
    find:
      "  if (BODY_REQUIRED_TYPES.has(node.type) && node.childForFieldName('body') === null) {\n" +
      '    return false; // a bodiless specifier is a usage or forward declaration, not a definition\n' +
      '  }\n',
    replace: '',
    why: "the C/C++ body requirement dropped — `struct point p;` earns a `defined at` receipt it never had, and its name node poisons defNameStarts so the true definition's cross-file references silently vanish from the map",
  },
  {
    id: 'repomap-map-report-bytes-invented',
    file: 'cli/report.ts',
    // Re-anchored when the report started painting its numbers: the figure moved
    // inside a palette role, and the mutation still wires it to the budget.
    find: "    `bytes used ${lava.paint('number', group(map.outputBytes))} of ` +",
    replace: "    `bytes used ${lava.paint('number', group(map.budgetBytes))} of ` +",
    why: "the map report's bytes-used figure wired to the budget — a budget-fitting report that always claims the budget spent, so the one number a human reads off `smelt map` stops being a measurement",
  },
  {
    id: 'repomap-symlink-refusal-dropped',
    file: 'repomap/map.ts',
    find: '      if (stat.isSymlink) continue;',
    replace: '      // symlink refusal removed',
    why: 'the walk stops refusing symlinks and leans on the accident that an lstat of a link is neither file nor directory — a reader whose stat resolves the link is then followed straight out of the root, and the call log shows the map reading a path it was never handed',
  },
  {
    id: 'repomap-read-not-fused-with-stat',
    file: 'repomap/map.ts',
    find:
      '  const found: ScannedFile[] = [];\n' +
      '  const walk = (dir: string, relDir: string): void => {\n' +
      "    const listed = fsCall('list the directory', dir, () => reader.list(dir));\n" +
      '    for (const entry of listed.map((item) => item.name).toSorted()) {\n' +
      "      const rel = relDir === '' ? entry : `${relDir}/${entry}`;\n" +
      '      if (isIgnored(rel, ignore)) continue;\n' +
      '      const full = join(dir, entry);\n' +
      "      const stat = fsCall('stat', full, () => reader.stat(full));\n" +
      '      if (stat === undefined) continue; // the reader has nothing there\n' +
      '      if (stat.isSymlink) continue;\n' +
      '      if (stat.isDirectory) walk(full, rel);\n' +
      '      else if (stat.isFile) {\n' +
      "        const bytes = fsCall('read the file', full, () => reader.read(full));\n" +
      '        found.push({ rel, bytes });\n' +
      '      }\n' +
      '    }\n' +
      '  };\n' +
      "  walk(root, '');\n" +
      '  return found;',
    replace:
      '  const vetted: { rel: string; full: string }[] = [];\n' +
      '  const walk = (dir: string, relDir: string): void => {\n' +
      "    const listed = fsCall('list the directory', dir, () => reader.list(dir));\n" +
      '    for (const entry of listed.map((item) => item.name).toSorted()) {\n' +
      "      const rel = relDir === '' ? entry : `${relDir}/${entry}`;\n" +
      '      if (isIgnored(rel, ignore)) continue;\n' +
      '      const full = join(dir, entry);\n' +
      "      const stat = fsCall('stat', full, () => reader.stat(full));\n" +
      '      if (stat === undefined) continue; // the reader has nothing there\n' +
      '      if (stat.isSymlink) continue;\n' +
      '      if (stat.isDirectory) walk(full, rel);\n' +
      '      else if (stat.isFile) vetted.push({ rel, full });\n' +
      '    }\n' +
      '  };\n' +
      "  walk(root, '');\n" +
      '  return vetted.map(({ rel, full }) => ({\n' +
      '    rel,\n' +
      "    bytes: fsCall('read the file', full, () => reader.read(full)),\n" +
      '  }));',
    why: "the whole-tree scan and the per-file read split back into two phases — every path is stat-vetted first and only then, in a second pass over the finished list, read; a file swapped for a symlink escaping root between the two phases has its target's bytes read straight into the map past a symlink refusal that already ran and already said no (the TOCTOU the fused walk exists to close, KOT-205 §6)",
  },
  {
    id: 'repomap-default-ignores-build-output-dropped',
    file: 'repomap/map.ts',
    find: "  'node_modules',\n  'dist',\n  'build',\n  'out',\n  'coverage',\n",
    replace: "  'node_modules',\n",
    why: 'the build-output directories dropped from the default ignore list — on any built TypeScript repo the default map then ranks src/x.ts, dist/x.js and dist/x.d.ts as three separate symbols apiece, and two-thirds of what a caller paid for is the compiler output of the other third',
  },
  {
    id: 'repomap-fs-error-unwrapped',
    file: 'repomap/io.ts',
    find: '    if (error instanceof SmeltError) throw error;\n    throw new RepoMapIoError(operation, path, error);',
    replace: '    throw error;',
    why: "the repo map's filesystem failures stop being wrapped — a missing root throws the raw Node ENOENT again, straight past a consumer catching SmeltError, and the contract's one promise about errors has an exception nobody is told about",
  },
  {
    id: 'repomap-cache-unbounded',
    file: 'repomap/map.ts',
    find: '  if (cache !== undefined) cacheCounts.pruned = cache.sweep(liveKeys);',
    replace: '  // sweep removed',
    why: 'the tags cache stops being swept — entries are keyed by content hash, so every pre-edit version of every file stays on disk forever and a long session grows a cache nothing will ever read again',
  },
  {
    id: 'repomap-ranking-limit-undocumented',
    file: 'repomap/rank.ts',
    find: ' * **The resolution limit, stated plainly: references bind by bare identifier.** A',
    replace: ' * A',
    why: "the ranking's resolution limit deleted from the module that implements it — same-name symbols across files still share rank and overloads still double-count, but nothing tells a reader that the numbers are per name rather than per symbol",
  },
  {
    id: 'repomap-ranking-limit-undocumented-in-map',
    file: 'repomap/map.ts',
    find: ' * **What the ranking can and cannot resolve.** A reference binds to a definition **by',
    replace: ' * A reference binds to a definition **by',
    why: "the resolution limit deleted from the map's own module doc — a reader of buildRepoMap meets refsIn with nothing to tell them it counts a name rather than a symbol, and the one place the limit was stated for the module's own callers is gone",
  },
  {
    id: 'repomap-rank-share-not-conflated',
    file: 'repomap/rank.ts',
    find: '      for (const def of definers) {\n        if (def.path === path) continue;\n        def.rank += (sourceRank * ref.count) / total;',
    replace:
      '      for (const def of definers) {\n        if (def.path === path) continue;\n        if (def !== definers[0]) continue;\n        def.rank += (sourceRank * ref.count) / total;',
    why: "rank share silently stops being conflated across every definer of a name — only the first-encountered definition of a shared or overloaded name earns rank, the rest sit at zero — which is a worse, undocumented behaviour change smuggled in under the 'inherited from Aider' banner: KOT-205 §3/§4 kept the conflation on purpose (splitting it needs per-language import/scope resolution this map deliberately does not do), so any accidental partial split must be exactly as loud as a full one",
  },
  {
    id: 'grammar-load-error-unwrapped',
    file: 'plan/grammar.ts',
    find: '    if (error instanceof SmeltError) throw error;\n    throw new GrammarUnavailableError(`${what}: ${describeFailure(error)}.`, { cause: error });',
    replace: '    throw error;',
    why: "the grammar loader's failures stop being wrapped — `grammarPath`'s existsSync proves presence and never readability, so an unreadable or truncated .wasm throws a raw EACCES or a V8 RangeError out of both smelt() and buildRepoMap(), straight past a consumer catching SmeltError",
  },
  {
    id: 'repomap-sweep-listing-fatal',
    file: 'repomap/cache.ts',
    find: '    let names: string[];\n    try {\n      names = readdirSync(this.#entriesDir);\n    } catch {\n      return 0;\n    }',
    replace:
      "    const names = fsCall('list the tags cache directory', this.#entriesDir, () =>\n      readdirSync(this.#entriesDir),\n    );",
    why: 'the tags-cache sweep fails the build when it cannot list its own directory — housekeeping that runs after the tree is walked, ranked and rendered then throws a fully computed map away over a cache smelt only wanted to tidy, which is exactly the slower-map-versus-no-map trade this cache is forbidden to make',
  },
];
