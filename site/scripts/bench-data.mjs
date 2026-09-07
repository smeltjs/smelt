#!/usr/bin/env node
/**
 * Law 4 at build time: the numbers section and the measured strip render ONLY what this
 * script parses out of `packages/core/bench/RESULTS.md` — per tier, the latest run that
 * measured it, verbatim rows, each tier carrying its own provenance.
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

// Sections are append-only: every `## run …` heading opens one run. A run names the
// tiers it ran (`tier 1` alone, or `tier 1 + 2 + 3 + 4`). Tier 1 reruns on every
// corpus change; tiers 3 and 4 are paid and run once — so "the latest run" is not one
// section but one section PER TIER: the last run that carries rows for that tier. Each
// tier's rows therefore travel with their own date, corpus commit and model, and the
// page prints that provenance beside them rather than one heading for all four.
const headingRe = /^## run (\d{4}-\d{2}-\d{2}) — (tier [\d +]+) — corpus ([0-9a-f]+)\s*$/gm;
const headings = [...md.matchAll(headingRe)];
if (headings.length === 0) {
  console.error('bench-data: no "## run …" heading found in RESULTS.md');
  process.exit(1);
}
const sections = headings.map((heading, index) => {
  const from = heading.index + heading[0].length;
  const to = index + 1 < headings.length ? headings[index + 1].index : md.length;
  return {
    runDate: heading[1],
    tiersRun: heading[2],
    corpusCommit: heading[3],
    body: md.slice(from, to),
  };
});
const latest = sections[sections.length - 1];
const { runDate, tiersRun, corpusCommit } = latest;

function parseRows(body) {
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
  return rows;
}

const parsed = sections.map((section) => ({ ...section, rows: parseRows(section.body) }));
if (parsed[parsed.length - 1].rows.length === 0) {
  console.error('bench-data: latest run section contains no table rows');
  process.exit(1);
}

/** The last run carrying rows of this tier, or `null` when no run ever measured it. */
function latestFor(tier) {
  for (let i = parsed.length - 1; i >= 0; i -= 1) {
    const run = parsed[i];
    const tierRows = run.rows.filter((r) => r.tier === `tier ${String(tier)}`);
    if (tierRows.length > 0) {
      const models = [...new Set(tierRows.filter((r) => r.model !== null).map((r) => r.model))];
      if (models.length > 1) {
        console.error(
          `bench-data: tier ${String(tier)} run ${run.runDate} names more than one model: ${models.join(', ')}`,
        );
        process.exit(1);
      }
      return {
        rows: tierRows,
        provenance: { date: run.runDate, corpusCommit: run.corpusCommit, model: models[0] ?? null },
      };
    }
  }
  return { rows: [], provenance: null };
}
const perTier = {
  bytes: latestFor(1),
  tokens: latestFor(2),
  expansion: latestFor(3),
  ab: latestFor(4),
};
const rows = Object.values(perTier).flatMap((t) => t.rows);

// One run, one model: every non-byte row names the model it measured on, and a page
// that mixed models without saying so would be exactly the drift this script exists
// to refuse.
const models = [...new Set(rows.filter((r) => r.model !== null).map((r) => r.model))];
if (models.length > 1) {
  console.error(`bench-data: run names more than one model: ${models.join(', ')}`);
  process.exit(1);
}

const byTier = (tier) =>
  ({ 1: perTier.bytes, 2: perTier.tokens, 3: perTier.expansion, 4: perTier.ab })[tier].rows;

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
  // The latest run's heading, for the page's own "generated from" line.
  runDate,
  tiersRun,
  corpusCommit,
  model: models[0] ?? null,
  // Per tier: the run its rows came from. Printed beside the rows, never merged.
  provenance: {
    bytes: perTier.bytes.provenance,
    tokens: perTier.tokens.provenance,
    expansion: perTier.expansion.provenance,
    ab: perTier.ab.provenance,
  },
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
  `bench-data: ${rows.length} rows — latest run ${runDate} (${tiersRun}, corpus ${corpusCommit}); ` +
    Object.entries(data.provenance)
      .map(([tier, p]) => `${tier}: ${p === null ? 'unmeasured' : `${p.date} ${p.corpusCommit}`}`)
      .join(', ') +
    ' → src/generated/bench.json',
);
