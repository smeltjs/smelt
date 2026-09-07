import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FORBIDDEN_NODE_MODULES, FORBIDDEN_PACKAGES } from '@guard/net/policy';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, importSpecifiers, packageRoot, stripStringsAndComments } from './_source.ts';

/**
 * BENCH-RESULTS GUARD — Law 4, for the one place numbers are allowed to exist.
 *
 * The measurement harness is what lets smelt state a number, and it is also where
 * a Law 4 violation stops being hypothetical: a results file is exactly
 * where an unmeasured, unattributed, or extrapolated figure would land, and where a
 * network call could quietly creep out of its tier. Three claims are pinned here:
 *
 *  1. `bench/` is not shipped. The manifest's `files` list must never grow a bench
 *     entry — the harness is measurement equipment, not product, and its tier-2/3
 *     modules can reach the network, which must never ride along in the tarball.
 *  2. Every row in `bench/RESULTS.md` is a measurement: it names its date, corpus
 *     commit and tier, token/retrieval/judged rows name their model (token counts are
 *     model-specific — Decision 8 in docs/ARCHITECTURE.md), byte rows name none (bytes belong to no
 *     model, and a model on a byte row would imply a conversion nobody performed).
 *     And the file contains no extrapolation vocabulary: no "up to", and never a
 *     cache-hit-rate figure — the exact unsupported claims Law 4 was written
 *     against.
 *  3. The harness touches the network only in `tier2.mjs`, `tier3.mjs` and `tier4.mjs`.
 *     Every other bench module — the runner, the pure lib, the corpus generator — must
 *     be incapable of it, so a tier-1 run is offline by construction, not by flag.
 *
 * Committed artefacts are read through `guardRoot()` (with a fallback to the real
 * package for files a mutation did not copy), so `pnpm mutate` can stale one file
 * at a time and watch each claim go red.
 */

/** A committed artefact: the mutated copy when the runner staled it, else the real one. */
function artifact(relative: string): string {
  const staled = join(guardRoot(), relative);
  return readFileSync(existsSync(staled) ? staled : join(packageRoot(), relative), 'utf8');
}

const DATA_ROW = /^\|(?<cells>.+)\|$/;

interface ResultsRow {
  readonly cells: readonly string[];
  readonly line: string;
}

/** Every data row in every table of RESULTS.md — header and separator rows dropped. */
function resultsRows(markdown: string): readonly ResultsRow[] {
  const rows: ResultsRow[] = [];
  for (const line of markdown.split('\n')) {
    const match = DATA_ROW.exec(line.trim());
    const raw = match?.groups?.['cells'];
    if (raw === undefined) continue;
    const cells = raw.split('|').map((cell) => cell.trim());
    if (cells[0] === 'case') continue; // header
    if (cells.every((cell) => /^-+$/.test(cell))) continue; // separator
    rows.push({ cells, line });
  }
  return rows;
}

describe('bench honesty guard (Law 4 — the harness that states the numbers)', () => {
  it('never ships bench/ — the files list excludes it', () => {
    const manifest = JSON.parse(artifact('package.json')) as { files?: readonly string[] };
    expect(manifest.files, 'the manifest has no files list to check').toBeDefined();
    const shipped = (manifest.files ?? []).filter(
      (entry) => entry === 'bench' || entry.startsWith('bench/'),
    );
    expect(
      shipped,
      'bench/ is measurement equipment with network-capable tier-2/3 modules; it must never enter the tarball',
    ).toEqual([]);
  });

  it('actually found rows to check — an empty results table proves nothing', () => {
    expect(resultsRows(artifact('bench/RESULTS.md')).length).toBeGreaterThan(0);
  });

  it('every results row names its date, corpus commit and tier; token and retrieval rows name their model', () => {
    for (const { cells, line } of resultsRows(artifact('bench/RESULTS.md'))) {
      const [caseId, tier, date, commit, model, unit, input, output] = cells;
      expect(caseId, line).toBeTruthy();
      expect(tier, line).toMatch(/^tier [1-4]$/);
      expect(date, line).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(commit, line).toMatch(/^[0-9a-f]{7,40}$/);
      expect(unit, line).toBeTruthy();
      expect(input, line).toMatch(/^\d+$/);
      expect(output, line).toMatch(/^\d+$/);
      if (unit === 'bytes') {
        expect(model, `a byte row must not name a model (no conversion exists): ${line}`).toBe('—');
      } else {
        expect(
          model,
          `a ${String(unit)} row without its model is not a measurement: ${line}`,
        ).toMatch(/\S/);
        expect(model, line).not.toBe('—');
      }
    }
  });

  it('RESULTS.md contains no extrapolation vocabulary and no cache-hit-rate claim', () => {
    const results = artifact('bench/RESULTS.md').toLowerCase();
    expect(results, '"up to" is extrapolation, not measurement').not.toMatch(/\bup to\b/);
    expect(
      results,
      'the cache-hit-rate figure is the claim Law 4 was written against',
    ).not.toContain('cache hit rate');
  });

  it('only tier2.mjs, tier3.mjs and tier4.mjs can reach the network', () => {
    const NETWORK_SHAPES = [/\bfetch\s*\(/, /node:https?\b/, /\bWebSocket\b/, /\bXMLHttpRequest\b/];
    const ALLOWED = new Set(['tier2.mjs', 'tier3.mjs', 'tier4.mjs']);
    const benchFiles = readdirSync(join(packageRoot(), 'bench'))
      .filter((entry) => entry.endsWith('.mjs'))
      .toSorted();
    expect(
      benchFiles.length,
      'found no bench modules — a vacuous scan proves nothing',
    ).toBeGreaterThan(0);
    expect(benchFiles).toContain('tier2.mjs');
    expect(benchFiles).toContain('tier3.mjs');
    expect(benchFiles).toContain('tier4.mjs');

    for (const file of benchFiles) {
      if (ALLOWED.has(file)) continue;
      const raw = artifact(`bench/${file}`);
      const source = stripStringsAndComments(raw);
      for (const shape of NETWORK_SHAPES) {
        expect(
          shape.test(source),
          `bench/${file} matches ${String(shape)} — network access belongs only in ` +
            'tier2.mjs/tier3.mjs/tier4.mjs, so that a tier-1 run is offline by construction',
        ).toBe(false);
      }
      // The shape scan above runs on STRIPPED source, so a transport imported
      // statically — `import 'node:https'` — is invisible to it: the specifier lives
      // inside a string literal, which stripping blanks out. Scan the import/require
      // specifiers of the RAW source too, against the same forbidden lists the
      // src-tree walk uses.
      const banned = importSpecifiers(raw).filter(
        (specifier) =>
          FORBIDDEN_NODE_MODULES.includes(specifier) || FORBIDDEN_PACKAGES.includes(specifier),
      );
      expect(
        banned,
        `bench/${file} imports a network transport — network access belongs only in ` +
          'tier2.mjs/tier3.mjs/tier4.mjs, so that a tier-1 run is offline by construction',
      ).toEqual([]);
    }
  });

  it("non-tier bench modules spawn only a literal 'git' — child_process is not a network side door", () => {
    // The network scan above cannot see `spawnSync('curl', [url])`: a subprocess
    // reaches the wire without fetch or node:http ever appearing in the file. The
    // runner legitimately shells out to git for corpus provenance, so the rule is:
    // outside tier2/3, every subprocess call site must name the literal 'git'.
    // Bare calls only: `.exec(...)` on a RegExp is not a subprocess, so a leading
    // `.` (or identifier character) exempts a match.
    const SPAWN_CALL =
      /(?<![.\w$])(?:spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/g;
    const ALLOWED = new Set(['tier2.mjs', 'tier3.mjs', 'tier4.mjs']);
    const benchFiles = readdirSync(join(packageRoot(), 'bench'))
      .filter((entry) => entry.endsWith('.mjs'))
      .toSorted();

    for (const file of benchFiles) {
      if (ALLOWED.has(file)) continue;
      const raw = artifact(`bench/${file}`);
      // stripStringsAndComments preserves length, so match positions in the
      // stripped text index straight back into the raw text — comments and string
      // contents cannot hide a call site or fake a 'git' literal.
      const stripped = stripStringsAndComments(raw);
      for (const match of stripped.matchAll(SPAWN_CALL)) {
        const site = raw.slice(match.index, match.index + match[0].length + 8);
        expect(
          site,
          `bench/${file} spawns a subprocess that is not a literal 'git' (${site.trim()}…) — ` +
            'a spawned curl or fetch-via-CLI would make tier 1 reach the network while the network scan stays green',
        ).toMatch(/^\w+\s*\(\s*'git'/);
      }
      // Method-style calls (`cp.spawnSync(...)`) would dodge the literal check, so
      // they are banned outright. Known residual hole: `.exec(` cannot be banned —
      // it is indistinguishable from RegExp.prototype.exec — so `cp.exec('curl …')`
      // would pass; the bare-import convention above is what keeps that visible.
      expect(
        /\.\s*(?:spawnSync|spawn|execFileSync|execFile|execSync|fork)\s*\(/.test(stripped),
        `bench/${file} makes a method-style subprocess call — import the named function ` +
          "so the spawn-only-'git' rule can see the argv",
      ).toBe(false);
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` stales each committed artefact in a
 * scratch root and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'bench-results-extrapolated-claim',
    file: 'bench/RESULTS.md',
    find: 'here is extrapolated, rounded up, or converted between units.',
    replace: 'here is extrapolated — savings of up to 94% are typical.',
    why: "the original pitch's extrapolation vocabulary landing in the one file that exists to hold measurements — Law 4's exact failure, in its most likely home",
  },
  {
    kind: 'artifact',
    id: 'bench-shipped-in-tarball',
    file: 'package.json',
    find: '  "files": [\n    "dist",',
    replace: '  "files": [\n    "dist",\n    "bench",',
    why: 'the network-capable measurement harness packed into the published tarball — bench/ is equipment, not product, and shipping it smuggles fetch() past the src-only zero-network walk',
  },
  {
    kind: 'artifact',
    id: 'bench-network-outside-tiers',
    file: 'bench/run.mjs',
    find: 'const { createSmelter } = await import(distEntry);',
    replace:
      "await fetch(new URL('https://example.invalid/telemetry'));\nconst { createSmelter } = await import(distEntry);",
    why: 'a network call in the default tier-1 path — the harness must be offline by construction outside tier2.mjs/tier3.mjs, or "reproducible offline by a stranger" is a flag away from false',
  },
  {
    kind: 'artifact',
    id: 'bench-subprocess-network-escape',
    file: 'bench/run.mjs',
    find: 'const { createSmelter } = await import(distEntry);',
    replace:
      "spawnSync('curl', ['https://example.invalid/telemetry']);\nconst { createSmelter } = await import(distEntry);",
    why: 'a subprocess reaching the network from the tier-1 path — no fetch, no node:http, so the network-shape scan stays green; only the spawn-only-git rule catches it',
  },
  {
    kind: 'artifact',
    id: 'bench-static-transport-import',
    file: 'bench/lib.mjs',
    find: 'export const RESULTS_HEADER = [',
    replace: "import 'node:https';\n\nexport const RESULTS_HEADER = [",
    why: 'a network transport imported statically into a non-tier bench module — the specifier lives inside a string literal, which the stripped-source shape scan blanks out, so only the import-specifier scan can see it',
  },
  {
    kind: 'artifact',
    id: 'bench-network-in-generator',
    file: 'bench/gen-build-log.mjs',
    find: '#!/usr/bin/env node',
    replace: "#!/usr/bin/env node\nawait fetch('https://example.invalid/telemetry');",
    why: 'a network call in the corpus generator — a third non-tier bench file beside the runner and the lib, proving the scan covers every bench module and not only the two the earlier mutations named',
  },
  {
    kind: 'artifact',
    id: 'bench-results-forged-tier',
    file: 'bench/RESULTS.md',
    find: '| large-ts-file   | tier 1 | 2026-09-02 | 1f65ab089364',
    replace: '| large-ts-file   | tier 9 | 2026-09-02 | 1f65ab089364',
    why: 'a results row citing a tier that does not exist — the row-shape check must refuse a number that names no measurement tier, or any figure could ride in under an invented tier label',
  },
];
