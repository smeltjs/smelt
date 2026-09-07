#!/usr/bin/env node
/**
 * Law 4 at build time: the numbers section renders ONLY what this script parses out of
 * `packages/core/bench/RESULTS.md` — the latest run, verbatim rows, grouped by tier.
 * Nothing on the page is typed by hand; a stale, missing, or unrecognized RESULTS.md
 * fails the build rather than shipping an unmeasured number.
 *
 * The run heading carries every tier that ran (`tier 1 + 2 + 3 + 4`); rows name their
 * own tier, model, unit and note. Tier-3 and tier-4 rows carry their readings partly
 * in the note cell (the aggregate expansion rate; the verdict and retrieve count), so
 * those are parsed here — with a loud failure on an unrecognized shape — and emitted
 * as structured fields, never re-derived in a component.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(here, '..', '..', 'packages', 'core', 'bench', 'RESULTS.md');
const outPath = join(here, '..', 'src', 'generated', 'bench.json');

const md = readFileSync(resultsPath, 'utf8');

// Sections are append-only: the last `## run …` heading is the latest run. A run that
// ran several tiers names them all (`tier 1 + 2 + 3 + 4`).
const headingRe = /^## run (\d{4}-\d{2}-\d{2}) — (tier [\d +]+) — corpus ([0-9a-f]+)\s*$/gm;
let heading;
for (const m of md.matchAll(headingRe)) heading = m;
if (!heading) {
  console.error('bench-data: no "## run …" heading found in RESULTS.md');
  process.exit(1);
}
const [, runDate, tiersRun, corpusCommit] = heading;
const section = md.slice(heading.index + heading[0].length);
const sectionEnd = section.search(/^## /m);
const body = sectionEnd === -1 ? section : section.slice(0, sectionEnd);

const rows = [];
for (const line of body.split('\n')) {
  if (!line.startsWith('|')) continue;
  const cells = line.split('|').map((c) => c.trim());
  // | case | tier | date | corpus commit | model | unit | input | output | elisions | note |
  if (cells.length < 11 || cells[1] === 'case' || /^-+$/.test(cells[1])) continue;
  const [, caseName, rowTier, date, , model, unit, input, output, elisions, note] = cells;
  const row = {
    case: caseName,
    tier: rowTier,
    date,
    unit,
    input: Number(input),
    output: Number(output),
    elisions: elisions === '—' ? null : Number(elisions),
    model: model === '—' ? null : model,
    note,
    overBudget: /OVER BUDGET/i.test(note),
  };
  if (!Number.isFinite(row.input) || !Number.isFinite(row.output)) {
    console.error(`bench-data: non-numeric value in row "${row.case}"`);
    process.exit(1);
  }
  if (row.tier === 'tier 4') {
    const verdict = /verdict: (.+)$/.exec(note)?.[1];
    const retrieves = /(\d+) retrieve/.exec(note)?.[1];
    if (verdict === undefined || retrieves === undefined) {
      console.error(`bench-data: tier-4 row "${row.case}" has an unrecognized note shape`);
      process.exit(1);
    }
    row.verdict = verdict;
    row.retrieves = Number(retrieves);
  }
  rows.push(row);
}

if (rows.length === 0) {
  console.error('bench-data: latest run section contains no table rows');
  process.exit(1);
}

// One run, one model: every non-byte row names the model it measured on, and a page
// that mixed models without saying so would be exactly the drift this script exists
// to refuse.
const models = [...new Set(rows.filter((r) => r.model !== null).map((r) => r.model))];
if (models.length > 1) {
  console.error(`bench-data: run names more than one model: ${models.join(', ')}`);
  process.exit(1);
}

const byTier = (tier) => rows.filter((r) => r.tier === `tier ${String(tier)}`);

// The tier-3 aggregate lives in the ALL CASES row's note.
const tier3All = byTier(3).find((r) => r.case === 'ALL CASES');
const tier3Aggregate =
  tier3All === undefined
    ? null
    : Number(/aggregate expansion rate ([\d.]+)/.exec(tier3All.note)?.[1]);
if (tier3All !== undefined && !Number.isFinite(tier3Aggregate)) {
  console.error('bench-data: tier-3 ALL CASES row has an unrecognized aggregate note');
  process.exit(1);
}

const data = {
  runDate,
  tiersRun,
  corpusCommit,
  model: models[0] ?? null,
  tiers: {
    bytes: byTier(1),
    tokens: byTier(2),
    expansion: byTier(3).filter((r) => r.case !== 'ALL CASES'),
    ab: byTier(4),
  },
  tier3Aggregate,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n');
console.log(
  `bench-data: ${rows.length} rows from run ${runDate} (${tiersRun}, corpus ${corpusCommit}) → src/generated/bench.json`,
);
