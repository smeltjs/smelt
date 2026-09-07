#!/usr/bin/env node
/**
 * The measurement harness. This is the program that earns smelt
 * the right to state a number (Law 4: claim no number that has not been measured).
 *
 * Three tiers, per `docs/ARCHITECTURE.md` § Decision 8:
 *
 *   tier 1  bytes + elision counts per case. Deterministic, offline, no key, and
 *           reproducible by a stranger from a fresh clone: `pnpm build && pnpm bench`.
 *           This is the default, and the only thing that runs without a key.
 *   tier 2  token counts via `/v1/messages/count_tokens` (free, needs
 *           ANTHROPIC_API_KEY). Runs only when the key is present. Every row names
 *           its model; a byte count is never converted to tokens with a fudge factor.
 *   tier 3  expansion rate from real model calls counting `smelt_retrieve`
 *           invocations. Paid, so it additionally requires the explicit `--tier3`
 *           flag; the retrieval log is written to `bench/tier3-log/` to be committed.
 *   tier 4  answer-quality A/B: the same question against the raw blob and the
 *           smelted one (retrieve tool wired), judged against the raw blob as
 *           reference, both arms' token usage recorded. Paid; additionally requires
 *           the explicit `--tier4` flag; the A/B log is written to `bench/ab-log/`
 *           to be committed.
 *
 * Results are appended to `bench/RESULTS.md`. Rows are append-only — a re-run on a
 * newer model is a new row, never an edit.
 *
 * Network access lives only in `tier2.mjs`, `tier3.mjs` and `tier4.mjs`, which are
 * imported dynamically and only on their tiers — a tier-1 run never loads a module
 * that can reach the wire. The library under `src/` cannot reach any of this; bench/
 * sits outside the zero-network guard's walk and outside the published tarball, and
 * must stay there.
 *
 * Zero dependencies: `node:` builtins plus the built `dist/` of this package.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  abRowNote,
  appendResults,
  CORPUS_REF_FORMAT,
  corpusRefMismatch,
  renderTable,
  resultRow,
  tier3Aggregate,
  tier3RowNote,
  tier3Verdict,
  validateCases,
} from './lib.mjs';

const benchDir = dirname(fileURLToPath(import.meta.url));
const resultsPath = join(benchDir, 'RESULTS.md');
const distEntry = join(benchDir, '../dist/index.js');

const RESULTS_PREAMBLE = `# smelt bench — results

Measured by \`bench/run.mjs\` on the committed corpus (\`bench/corpus/\`,
\`bench/cases.json\`). Every row states what was measured, on which date, at which
corpus commit, under which tier — and, for token and retrieval rows, on which model,
because those numbers are model-specific. Rows are **append-only**: a re-run, or a
run on a newer model, adds rows and never edits one — tokenizers shift between
model generations (\`docs/ARCHITECTURE.md\` § Decision 8), and an edit would rewrite history.

Units mean exactly what they say: \`bytes\` is UTF-8 bytes of the input and the
smelted output; \`tokens\` is Anthropic's \`/v1/messages/count_tokens\` for the text
as a single user message on the named model (tier 2); \`elisions retrieved\` is
distinct elisions the named model asked back via \`smelt_retrieve\` out of the
distinct elisions stored (tier 3), where retrieving everything is a LOSS; \`A/B
judged\` is tier 4, whose input column is the raw arm's summed input tokens and
output column the smelted arm's, with the verdict — a named model's opinion, logged
in \`bench/ab-log/\` — in the note. Nothing here is extrapolated, rounded up, or
converted between units.`;

function fail(message) {
  process.stderr.write(`bench: ${message}\n`);
  process.exit(1);
}

const args = new Set(process.argv.slice(2));
const wantTier3 = args.delete('--tier3');
const wantTier4 = args.delete('--tier4');
if (args.size > 0) {
  fail(`unknown arguments: ${[...args].join(' ')} (only --tier3 and --tier4 are accepted)`);
}

if (!existsSync(distEntry)) {
  fail('dist/ is missing — run `pnpm build` first. The harness measures the built library.');
}

// -- corpus and code provenance -----------------------------------------------

const git = (argv) => spawnSync('git', argv, { cwd: benchDir, encoding: 'utf8' });

// The dirty check covers the code being measured, not just the corpus: a row
// produced from an edited src/ names a commit that cannot reproduce its numbers.
const dirty = git(['status', '--porcelain', '--', 'corpus', 'cases.json', '../src']);
if (dirty.status !== 0) fail('git status failed — the corpus commit cannot be established.');
if (dirty.stdout.trim() !== '') {
  fail(
    'bench/corpus, cases.json or src/ has uncommitted changes. A number measured against ' +
      'uncommitted inputs names no commit and is not reproducible — commit first (Law 4).',
  );
}
const commitResult = git(['log', '-n', '1', '--format=%H', '--', 'corpus', 'cases.json']);
const corpusCommit = commitResult.stdout.trim().slice(0, 12);
if (commitResult.status !== 0 || corpusCommit === '') {
  fail('could not resolve the corpus commit — is bench/corpus committed?');
}

// A dist/ built before the latest src/ change measures old code under a fresh date.
const newestMtime = (dir) => {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    newest = Math.max(newest, entry.isDirectory() ? newestMtime(full) : statSync(full).mtimeMs);
  }
  return newest;
};
if (newestMtime(join(benchDir, '../src')) > statSync(distEntry).mtimeMs) {
  fail('dist/ is older than src/ — run `pnpm build` first, or the rows measure stale code.');
}

// -- materialize by-reference corpus entries ----------------------------------
//
// A corpus entry that mirrors this repository's own source is committed as a
// `<name>.json` reference (CORPUS_REF_FORMAT) pinning the source path and its
// sha256, not as a second copy of the bytes. The runner writes the real file here,
// from the working tree, and REFUSES a hash mismatch — that refusal replaces the
// old byte-copy guard: a drifted source cannot be measured under a stale pin. The
// materialized file itself is gitignored; the reference is the committed artefact,
// and it sits under corpus/, so the corpus commit every row names covers it. The
// source itself is committed too — the src/ dirty check above already insisted.

const repoRoot = resolve(benchDir, '../../..');
const corpusDir = join(benchDir, 'corpus');
const materialized = new Set();
for (const entry of readdirSync(corpusDir)) {
  if (!entry.endsWith('.json')) continue;
  const ref = JSON.parse(readFileSync(join(corpusDir, entry), 'utf8'));
  if (ref?.format !== CORPUS_REF_FORMAT) {
    // Loud, not a skip: silently ignoring an unrecognized reference would leave its
    // stale materialized target on disk to be measured with no hash check (Law 4).
    fail(
      `corpus/${entry} declares format ${JSON.stringify(ref?.format ?? null)}, not ` +
        `"${CORPUS_REF_FORMAT}" — an unrecognized reference cannot be materialized, ` +
        'and cannot be skipped either: its target would be measured with no hash pin.',
    );
  }
  const source = readFileSync(join(repoRoot, ref.from));
  const actual = createHash('sha256').update(source).digest('hex');
  if (actual !== ref.sha256) {
    fail(
      corpusRefMismatch({
        refFile: `corpus/${entry}`,
        from: ref.from,
        pinned: ref.sha256,
        actual,
      }),
    );
  }
  writeFileSync(join(corpusDir, entry.slice(0, -'.json'.length)), source);
  materialized.add(`corpus/${entry.slice(0, -'.json'.length)}`);
}

// -- load and validate the cases ---------------------------------------------

const manifest = JSON.parse(readFileSync(join(benchDir, 'cases.json'), 'utf8'));

// A corpus file is measurable only if git tracks its bytes or this run materialized
// it under a verified pin. A leftover target from a prior materialization whose
// reference was since removed still exists on disk — gitignored, so the dirty check
// above is blind to it — but no commit pins its bytes: measuring it would append a
// row citing a corpus commit that cannot reproduce it (Law 4).
const trackedResult = git(['ls-files', '--', 'corpus']);
if (trackedResult.status !== 0) {
  fail('git ls-files failed — cannot establish which corpus files are committed.');
}
const tracked = new Set(trackedResult.stdout.split('\n').filter((line) => line !== ''));
for (const benchCase of Array.isArray(manifest?.cases) ? manifest.cases : []) {
  const file = benchCase?.file;
  if (typeof file !== 'string' || !existsSync(join(benchDir, file))) continue; // validateCases reports
  if (!tracked.has(file) && !materialized.has(file)) {
    fail(
      `bench/${file} exists but is neither git-tracked nor materialized by this run — ` +
        'a stale leftover from an earlier materialization. Delete it, or restore its ' +
        `committed reference (${file}.json), so the corpus commit pins every measured byte.`,
    );
  }
}

const problems = validateCases(manifest, (file) => existsSync(join(benchDir, file)));
if (problems.length > 0) fail(`cases.json is invalid:\n  ${problems.join('\n  ')}`);

const { createSmelter } = await import(distEntry);
const date = new Date().toISOString().slice(0, 10);
const rows = [];
const tiersRun = [];

/** A fresh smelter and result for one case — each case gets its own store. */
async function smeltCase(benchCase) {
  const smelter = createSmelter({ strategy: benchCase.strategy });
  const text = readFileSync(join(benchDir, benchCase.file), 'utf8');
  const result = await smelter.smelt(text, {
    path: benchCase.path,
    focus: benchCase.focus,
    budgetBytes: benchCase.budgetBytes,
  });
  return { smelter, text, result };
}

const fingerprint = (result) =>
  JSON.stringify({
    inputBytes: result.inputBytes,
    outputBytes: result.outputBytes,
    text: result.text,
    elisions: result.elisions.map((e) => [e.hash, e.reason.rule, e.range.start, e.range.end]),
  });

// -- tier 1: bytes and elision counts (always) --------------------------------

tiersRun.push('1');
for (const benchCase of manifest.cases) {
  const first = await smeltCase(benchCase);
  const second = await smeltCase(benchCase);
  if (fingerprint(first.result) !== fingerprint(second.result)) {
    fail(`${benchCase.id}: two identical runs produced different plans — not deterministic.`);
  }
  const { result } = first;
  rows.push(
    resultRow({
      caseId: benchCase.id,
      tier: 1,
      date,
      corpusCommit,
      unit: 'bytes',
      input: result.inputBytes,
      output: result.outputBytes,
      elisions: result.elisions.length,
      note:
        `budget ${String(benchCase.budgetBytes)} B, ${result.planner}` +
        (result.outputBytes > benchCase.budgetBytes ? ' — OVER BUDGET' : ''),
    }),
  );
}

// -- tier 2: token counts, only with a key ------------------------------------

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey !== undefined && apiKey !== '') {
  tiersRun.push('2');
  const model = process.env.SMELT_BENCH_MODEL ?? 'claude-opus-5';
  const { countTokens } = await import('./tier2.mjs');
  for (const benchCase of manifest.cases) {
    const { text, result } = await smeltCase(benchCase);
    const input = await countTokens({ apiKey, model, text });
    const output = await countTokens({ apiKey, model, text: result.text });
    rows.push(
      resultRow({
        caseId: benchCase.id,
        tier: 2,
        date,
        corpusCommit,
        model,
        unit: 'tokens',
        input,
        output,
        elisions: result.elisions.length,
        note: 'count_tokens, text as one user message',
      }),
    );
  }
} else {
  process.stderr.write('bench: ANTHROPIC_API_KEY not set — tier 2 (token counts) skipped.\n');
}

// -- tier 3: expansion rate, only with a key AND the explicit flag ------------

if (wantTier3) {
  if (apiKey === undefined || apiKey === '') fail('--tier3 needs ANTHROPIC_API_KEY.');
  tiersRun.push('3');
  const model = process.env.SMELT_BENCH_MODEL ?? 'claude-opus-5';
  const { measureExpansion } = await import('./tier3.mjs');
  const logDir = join(benchDir, 'tier3-log');
  mkdirSync(logDir, { recursive: true });
  const completed = [];
  let truncatedCount = 0;
  for (const benchCase of manifest.cases) {
    const { smelter, result } = await smeltCase(benchCase);
    const log = await measureExpansion({
      apiKey,
      model,
      benchCase,
      smelter,
      smeltedText: result.text,
    });
    writeFileSync(join(logDir, `${benchCase.id}.json`), `${JSON.stringify(log, null, 2)}\n`);
    const verdict = tier3Verdict(log.stats);
    if (log.truncated) truncatedCount += 1;
    else completed.push(log.stats);
    rows.push(
      resultRow({
        caseId: benchCase.id,
        tier: 3,
        date,
        corpusCommit,
        model,
        unit: 'elisions retrieved',
        input: log.stats.elisionsStored,
        output: log.stats.uniqueRetrieved,
        note: tier3RowNote({
          verdict,
          retrieveCalls: log.stats.retrieveCalls,
          truncated: log.truncated,
          maxRounds: log.maxRounds,
        }),
      }),
    );
  }
  // Truncated cases stay out of the aggregate: their retrieval counts are floors
  // from cut-off runs, and folding them in would understate the aggregate rate.
  const excluded =
    truncatedCount > 0 ? `; ${String(truncatedCount)} truncated case(s) excluded` : '';
  rows.push(
    resultRow({
      caseId: 'ALL CASES',
      tier: 3,
      date,
      corpusCommit,
      model,
      unit: 'elisions retrieved',
      input: completed.reduce((sum, entry) => sum + entry.elisionsStored, 0),
      output: completed.reduce((sum, entry) => sum + entry.uniqueRetrieved, 0),
      note:
        completed.length === 0
          ? `no aggregate — every case was truncated at the round cap${excluded}`
          : `aggregate expansion rate ${tier3Aggregate(completed).toFixed(2)} ` +
            `over ${String(completed.length)} completed case(s)${excluded}`,
    }),
  );
  process.stderr.write(`bench: tier 3 retrieval logs written to ${logDir} — commit them.\n`);
}

// -- tier 4: answer-quality A/B, only with a key AND the explicit flag ------------

if (wantTier4) {
  if (apiKey === undefined || apiKey === '') fail('--tier4 needs ANTHROPIC_API_KEY.');
  tiersRun.push('4');
  const model = process.env.SMELT_BENCH_MODEL ?? 'claude-opus-5';
  const { measureAb } = await import('./tier4.mjs');
  const logDir = join(benchDir, 'ab-log');
  mkdirSync(logDir, { recursive: true });
  for (const [index, benchCase] of manifest.cases.entries()) {
    if (typeof benchCase.abQuestion !== 'string' || benchCase.abQuestion.length === 0) {
      fail(
        `${benchCase.id}: tier 4 needs an abQuestion — a case without an answerable ` +
          'question cannot be measured for answer quality. Add one to cases.json.',
      );
    }
    const { smelter, text, result } = await smeltCase(benchCase);
    const { log, verdict, rawUsage, smeltedUsage, retrieves, truncated } = await measureAb({
      apiKey,
      model,
      benchCase,
      rawText: text,
      smeltedText: result.text,
      smelter,
      index,
    });
    writeFileSync(join(logDir, `${benchCase.id}.json`), `${JSON.stringify(log, null, 2)}\n`);
    rows.push(
      resultRow({
        caseId: benchCase.id,
        tier: 4,
        date,
        corpusCommit,
        model,
        unit: 'A/B judged',
        input: rawUsage.input_tokens,
        output: smeltedUsage.input_tokens,
        elisions: result.elisions.length,
        note: abRowNote({ verdict, rawUsage, smeltedUsage, retrieves, truncated }),
      }),
    );
  }
  process.stderr.write(`bench: tier 4 A/B logs written to ${logDir} — commit them.\n`);
}

// -- append to RESULTS.md -----------------------------------------------------

const section = `## run ${date} — tier ${tiersRun.join(' + ')} — corpus ${corpusCommit}\n\n${renderTable(rows)}`;
const existing = existsSync(resultsPath) ? readFileSync(resultsPath, 'utf8') : RESULTS_PREAMBLE;
writeFileSync(resultsPath, appendResults(existing, section));
process.stderr.write(
  `bench: ${String(rows.length)} rows (tier ${tiersRun.join(' + ')}) appended to bench/RESULTS.md\n`,
);
process.stdout.write(`${renderTable(rows)}\n`);
