import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { EXIT, runCli } from '@guard/cli/run';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, guardSrcRoot, packageRoot, repoRoot } from './_source.ts';

/**
 * README-NUMBERS GUARD — Law 4's first surface, cross-checked mechanically.
 *
 * `test/guards/bench-results.test.ts` pins what the measurement harness is allowed to
 * *produce* (no extrapolation vocabulary, every row named and dated, network confined
 * to the tier modules). It says nothing about what the README then *quotes* from that
 * harness — and the README's numbers are hand-typed, every time a run changes them.
 * That is exactly the gap Law 4 exists to close: a number that was true on
 * 2026-09-01 and never re-checked is, structurally, the same shape of claim as one
 * that was never measured at all.
 *
 * So this guard parses both documents as data and cross-checks them:
 *
 *  1. The README states which corpus commit backs each tier ("tier 1 from run … on
 *     corpus `<hex>`"). This guard reads that citation — never a hardcoded commit —
 *     and looks up the **last** row in `bench/RESULTS.md` for that exact
 *     (case, tier, corpus) triple, matching the file's own stated rule: "each tier's
 *     rows come from the last run that measured it" (RESULTS.md is append-only, so a
 *     re-run appends rather than edits, and the *last* matching block is the current
 *     truth).
 *  2. Every Tier 1 and Tier 2 table row in the README — including the **corpus
 *     total** row — must equal the bench row's `input`/`output` byte or token counts
 *     exactly, and the stated reduction percentage must equal the one this guard
 *     independently computes from those same two numbers (one decimal place,
 *     `Math.round`, the README's own rounding).
 *  3. Tier 3's two prose figures — the aggregate expansion rate and the "N of M
 *     blobs" count — must equal `bench/RESULTS.md`'s `ALL CASES` row for that tier.
 *  4. Every Tier 4 table row's raw/smelted token counts, retrieve count and verdict
 *     must equal the bench row, and the tallied verdict counts (ties / raw-better /
 *     smelted-better) must equal both the README's own summary sentence and what this
 *     guard counts directly from the bench rows.
 *  5. The top-of-file three-number summary table — the first thing a reader sees —
 *     must equal the same Tier 2 corpus total, Tier 3 aggregate and Tier 4 tally the
 *     sections below it state, so the headline cannot drift from the detail beneath
 *     it even if both happen to still be internally self-consistent.
 *
 * A case name is spelled differently in prose ("large TS file") than in the bench
 * corpus ("large-ts-file"); {@link toSlug} normalizes the common shape and
 * {@link CASE_NAME_ALIASES} states the two exceptions explicitly, by name, rather
 * than folding them into the normalizer as an unexplained special case.
 *
 * The README is read from the **real repository**, never from a mutant copy — the
 * same "outside voice" ruling `test/guards/harness-registry.test.ts` and
 * `test/guards/structural-totality.test.ts` already make: this guard exists to catch
 * the README drifting from the measurement, and a README that could itself be
 * mutated back into agreement would make the check circular. `bench/RESULTS.md` is
 * the artefact `pnpm mutate` stales, through {@link resultsArtifact}.
 */

/** The committed `bench/RESULTS.md` — the mutated copy when `pnpm mutate` staled it. */
function resultsArtifact(): string {
  const relative = 'bench/RESULTS.md';
  const staled = join(guardRoot(), relative);
  return readFileSync(existsSync(staled) ? staled : join(packageRoot(), relative), 'utf8');
}

/** The real README.md, always — see the module doc for why this is never `guardRoot()`. */
function readme(): string {
  return readFileSync(join(repoRoot(), 'README.md'), 'utf8');
}

interface BenchRow {
  readonly case: string;
  readonly tier: number;
  readonly corpus: string;
  readonly model: string;
  readonly unit: string;
  readonly input: number;
  readonly output: number;
  /** `undefined` for the bench file's `—` cell (tiers with no elisions column). */
  readonly elisions: number | undefined;
  readonly note: string;
}

const NUMBER = /^-?\d+$/;

/** Every data row of `bench/RESULTS.md`'s one ten-column table shape. */
function parseBenchRows(markdown: string): readonly BenchRow[] {
  const rows: BenchRow[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.length !== 10) continue;
    if (cells[0] === 'case') continue; // header row
    if (cells.every((cell) => /^-+$/.test(cell))) continue; // separator row
    const tierMatch = /^tier (\d)$/.exec(cells[1] ?? '');
    if (tierMatch === null) continue; // not a data row this parser understands
    const [caseName, , date, corpus, model, unit, inputCell, outputCell, elisionsCell, note] =
      cells as [string, string, string, string, string, string, string, string, string, string];
    if (!NUMBER.test(inputCell) || !NUMBER.test(outputCell)) continue;
    rows.push({
      case: caseName,
      tier: Number(tierMatch[1]),
      corpus,
      model,
      unit,
      input: Number(inputCell),
      output: Number(outputCell),
      elisions: NUMBER.test(elisionsCell) ? Number(elisionsCell) : undefined,
      note,
    });
    void date; // read for shape only; not part of any cross-check here
  }
  return rows;
}

/**
 * The bench file is append-only and states its own rule: "each tier's rows come from
 * the last run that measured it". A `Map` keyed by (case, tier, corpus) and folded in
 * file order gives exactly that — a later block's row for the same triple replaces an
 * earlier one, so a re-run that changed a number (without changing the corpus commit)
 * is still read as the current truth, matching what a human reading top-to-bottom and
 * taking the last match would conclude.
 */
function lastByTriple(rows: readonly BenchRow[]): Map<string, BenchRow> {
  const byTriple = new Map<string, BenchRow>();
  for (const row of rows) byTriple.set(`${row.case}\0${String(row.tier)}\0${row.corpus}`, row);
  return byTriple;
}

function benchRow(
  byTriple: Map<string, BenchRow>,
  caseSlug: string,
  tier: number,
  corpus: string,
): BenchRow {
  const row = byTriple.get(`${caseSlug}\0${String(tier)}\0${corpus}`);
  expect(
    row,
    `bench/RESULTS.md has no tier ${String(tier)} row for case "${caseSlug}" at corpus ` +
      `"${corpus}" — the README cites a run this file does not (or no longer) carry`,
  ).toBeDefined();
  return row!;
}

/**
 * The two case names the README spells too differently from their bench slug for a
 * generic normalizer to bridge honestly — stated explicitly, not folded into
 * {@link toSlug} as an unexplained special case. `git diff (content-kind probe)` and
 * `sklearn _ridge` both normalize correctly on their own; these two do not.
 */
const CASE_NAME_ALIASES: Readonly<Record<string, string>> = {
  'json log': 'json-tool-result',
};

/** README prose case name → bench corpus slug: strip a parenthetical, then kebab-case. */
function toSlug(name: string): string {
  const bare = name
    .replace(/\s*\([^)]*\)\s*$/, '') // trailing "(content-kind probe)" / "(labelled synthetic)"
    .replace(/\\\*$/, '') // a footnote marker riding on a verdict cell, not a case name
    .trim()
    .toLowerCase();
  const alias = CASE_NAME_ALIASES[bare];
  if (alias !== undefined) return alias;
  return bare.replace(/[\s_]+/g, '-');
}

/** `109,348` → `109348`. README tables use thousands separators; bench does not. */
function parseThousands(cell: string): number {
  return Number(cell.replace(/,/g, '').replace(/\*\*/g, '').trim());
}

/** The README's own rounding: one decimal place, a leading `−`, a trailing `%`. */
function reductionPercent(input: number, output: number): string {
  const pct = ((input - output) / input) * 100;
  return `−${pct.toFixed(1)}%`;
}

/**
 * A Tier 4 row's `elisions` column is **not** the retrieve count — it is the same
 * "how many elisions did smelt make" figure carried on every tier's row for that case
 * (tiers 1/2/3/4 share one smelt run per case, so it is identical across all four).
 * The model's actual retrieve count for the A/B judged run lives only in the row's
 * prose `note`, as `"N retrieve(s)"`, which is what the README's "retrieves" column
 * actually states — the two numbers coincide on some cases and disagree on others
 * (e.g. `large-ts-file`: 3 elisions, 0 retrieves), so reading the wrong column would
 * have passed by accident on most cases and silently missed the real one.
 */
function retrievesFromNote(note: string, label: string): number {
  const match = /(\d+) retrieve\(s\)/.exec(note);
  expect(match, `bench row for "${label}" carries no "N retrieve(s)" in its note`).not.toBeNull();
  return Number(match![1]);
}

/** One row of a markdown table, split on `|`, outer pipes and whitespace trimmed. */
function tableRows(markdown: string): readonly (readonly string[])[] {
  const rows: (readonly string[])[] = [];
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) continue;
    const cells = trimmed
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim());
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue; // separator row
    rows.push(cells);
  }
  return rows;
}

/** The markdown between one `##`/`###` heading (matched by a substring) and the next. */
function section(markdown: string, headingContains: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => /^#{2,3} /.test(line) && line.includes(headingContains));
  expect(
    start,
    `no heading containing "${headingContains}" was found in the README`,
  ).toBeGreaterThanOrEqual(0);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{2,3} /.test(lines[i]!)) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('the README states which run backs each tier, and this guard reads that citation', () => {
  const intro = section(readme(), 'Measured numbers');

  it('parses the corpus commits the README itself cites — never hardcoded here', () => {
    const tier1 = /tier 1 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(intro);
    const tier24 = /tiers? 2.{0,3}4 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(intro);
    expect(tier1?.[1], 'README no longer states which corpus backs tier 1').toBeDefined();
    expect(tier24?.[1], 'README no longer states which corpus backs tiers 2–4').toBeDefined();
  });
});

describe('Tier 1 (bytes): every README row, and the corpus total, match the cited bench run', () => {
  const readmeText = readme();
  const bench = lastByTriple(parseBenchRows(resultsArtifact()));
  const corpus = /tier 1 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(
    section(readmeText, 'Measured numbers'),
  )?.[1];
  const tier1 = section(readmeText, 'Tier 1');
  const rows = tableRows(tier1).filter((cells) => cells.length === 5 && cells[0] !== 'case');

  it('is non-vacuous: the Tier 1 table and its citation both parsed', () => {
    expect(corpus, 'no corpus commit parsed for tier 1').toBeDefined();
    expect(rows.length, 'no Tier 1 data rows parsed from the README').toBeGreaterThan(5);
  });

  for (const cells of rows) {
    const [caseCell, , inCell, outCell, reductionCell] = cells as [
      string,
      string,
      string,
      string,
      string,
    ];
    const isTotal = caseCell.includes('corpus total');
    const label = isTotal ? 'corpus total' : caseCell;
    it(`"${label}" — in/out bytes and the reduction match bench/RESULTS.md`, () => {
      const input = parseThousands(inCell);
      const output = parseThousands(outCell);
      if (isTotal) {
        const all = [...bench.values()].filter((row) => row.tier === 1 && row.corpus === corpus);
        const totalIn = all.reduce((sum, row) => sum + row.input, 0);
        const totalOut = all.reduce((sum, row) => sum + row.output, 0);
        expect(input, 'README Tier 1 corpus total (in) disagrees with the summed bench rows').toBe(
          totalIn,
        );
        expect(
          output,
          'README Tier 1 corpus total (out) disagrees with the summed bench rows',
        ).toBe(totalOut);
      } else {
        const row = benchRow(bench, toSlug(caseCell), 1, corpus!);
        expect(input, `README Tier 1 "${caseCell}" (in) disagrees with bench/RESULTS.md`).toBe(
          row.input,
        );
        expect(output, `README Tier 1 "${caseCell}" (out) disagrees with bench/RESULTS.md`).toBe(
          row.output,
        );
      }
      expect(
        reductionCell.replace(/\*\*/g, '').startsWith(reductionPercent(input, output)),
        `README Tier 1 "${label}" states a reduction that does not match ` +
          `${reductionPercent(input, output)} computed from its own in/out cells`,
      ).toBe(true);
    });
  }
});

describe('Tier 2 (tokens): every README row, and the corpus total, match the cited bench run', () => {
  const readmeText = readme();
  const bench = lastByTriple(parseBenchRows(resultsArtifact()));
  const corpus = /tiers? 2.{0,3}4 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(
    section(readmeText, 'Measured numbers'),
  )?.[1];
  const tier2 = section(readmeText, 'Tier 2');
  const rows = tableRows(tier2).filter((cells) => cells.length === 4 && cells[0] !== 'case');

  it('is non-vacuous: the Tier 2 table and its citation both parsed', () => {
    expect(corpus, 'no corpus commit parsed for tiers 2-4').toBeDefined();
    expect(rows.length, 'no Tier 2 data rows parsed from the README').toBeGreaterThan(5);
  });

  for (const cells of rows) {
    const [caseCell, inCell, outCell, reductionCell] = cells as [string, string, string, string];
    const isTotal = caseCell.includes('corpus total');
    const label = isTotal ? 'corpus total' : caseCell;
    it(`"${label}" — in/out tokens and the reduction match bench/RESULTS.md`, () => {
      const input = parseThousands(inCell);
      const output = parseThousands(outCell);
      if (isTotal) {
        const all = [...bench.values()].filter((row) => row.tier === 2 && row.corpus === corpus);
        expect(input, 'README Tier 2 corpus total (in) disagrees with the summed bench rows').toBe(
          all.reduce((sum, row) => sum + row.input, 0),
        );
        expect(
          output,
          'README Tier 2 corpus total (out) disagrees with the summed bench rows',
        ).toBe(all.reduce((sum, row) => sum + row.output, 0));
      } else {
        const row = benchRow(bench, toSlug(caseCell), 2, corpus!);
        expect(input, `README Tier 2 "${caseCell}" (in) disagrees with bench/RESULTS.md`).toBe(
          row.input,
        );
        expect(output, `README Tier 2 "${caseCell}" (out) disagrees with bench/RESULTS.md`).toBe(
          row.output,
        );
      }
      expect(
        reductionCell.replace(/\*\*/g, '').startsWith(reductionPercent(input, output)),
        `README Tier 2 "${label}" states a reduction that does not match ` +
          `${reductionPercent(input, output)} computed from its own in/out cells`,
      ).toBe(true);
    });
  }
});

describe('Tier 3: the aggregate expansion rate and the "N of M" count match bench/RESULTS.md', () => {
  const readmeText = readme();
  const bench = parseBenchRows(resultsArtifact());
  const corpus = /tiers? 2.{0,3}4 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(
    section(readmeText, 'Measured numbers'),
  )?.[1];
  const allCases = bench.find(
    (row) => row.tier === 3 && row.corpus === corpus && row.case === 'ALL CASES',
  );

  it('bench/RESULTS.md carries the tier 3 ALL CASES aggregate row this cross-check needs', () => {
    expect(allCases, 'no tier 3 "ALL CASES" row at the cited corpus').toBeDefined();
  });

  it('the "N of M blobs" figure in the top summary and the Tier 3 section match bench', () => {
    const stored = allCases!.input; // "elisions retrieved" row: input = distinct stored
    const retrieved = allCases!.output; // output = distinct retrieved
    const rate = (retrieved / stored).toFixed(2);
    const tier3 = section(readmeText, 'Tier 3');
    expect(
      tier3.includes(`Aggregate **${rate}**`),
      `Tier 3 no longer states "Aggregate **${rate}**" — bench/RESULTS.md's ALL CASES ` +
        `row computes expansion rate ${rate} (${String(retrieved)} of ${String(stored)})`,
    ).toBe(true);
    expect(
      tier3.includes(`**${String(retrieved)} of ${String(stored)}**`),
      `Tier 3 no longer states "**${String(retrieved)} of ${String(stored)}**" elided blobs`,
    ).toBe(true);
  });
});

describe('Tier 4: every README row and the tallied verdicts match bench/RESULTS.md', () => {
  const readmeText = readme();
  const bench = lastByTriple(parseBenchRows(resultsArtifact()));
  const corpus = /tiers? 2.{0,3}4 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(
    section(readmeText, 'Measured numbers'),
  )?.[1];
  const tier4 = section(readmeText, 'Tier 4');
  const rows = tableRows(tier4).filter((cells) => cells.length === 5 && cells[0] !== 'case');

  it('is non-vacuous: the Tier 4 table parsed', () => {
    expect(rows.length, 'no Tier 4 data rows parsed from the README').toBeGreaterThan(5);
  });

  for (const cells of rows) {
    const [caseCell, rawInCell, smeltedInCell, retrievesCell, verdictCell] = cells as [
      string,
      string,
      string,
      string,
      string,
    ];
    it(`"${caseCell}" — raw/smelted tokens, retrieves and verdict match bench/RESULTS.md`, () => {
      const row = benchRow(bench, toSlug(caseCell), 4, corpus!);
      expect(parseThousands(rawInCell), `README Tier 4 "${caseCell}" raw-in`).toBe(row.input);
      expect(parseThousands(smeltedInCell), `README Tier 4 "${caseCell}" smelted-in`).toBe(
        row.output,
      );
      expect(Number(retrievesCell), `README Tier 4 "${caseCell}" retrieves`).toBe(
        retrievesFromNote(row.note, caseCell),
      );
      const verdict = verdictCell.replace(/\\\*$/, '').trim();
      expect(row.note.includes(`verdict: ${verdict}`), `README Tier 4 "${caseCell}" verdict`).toBe(
        true,
      );
    });
  }

  it('the tallied verdicts match both the bench rows and the "Six ties…" summary sentence', () => {
    const all = [...bench.values()].filter((row) => row.tier === 4 && row.corpus === corpus);
    const tally = { tie: 0, 'raw better': 0, 'smelted better': 0 } as Record<string, number>;
    for (const row of all) {
      const verdict = /verdict: ([a-z ]+)$/.exec(row.note)?.[1];
      expect(verdict, `tier 4 row "${row.case}" carries no parseable verdict`).toBeDefined();
      tally[verdict!] = (tally[verdict!] ?? 0) + 1;
    }
    const words: Record<number, string> = { 1: 'one', 2: 'two', 3: 'three', 4: 'four', 6: 'six' };
    const sentence =
      `${words[tally['tie']!] ?? String(tally['tie'])} ties, ` +
      `${words[tally['raw better']!] ?? String(tally['raw better'])} raw-better, ` +
      `${words[tally['smelted better']!] ?? String(tally['smelted better'])} smelted-better`;
    expect(
      readmeText.toLowerCase().includes(sentence),
      `README's verdict tally sentence no longer reads "${sentence}" — bench/RESULTS.md's ` +
        `tier 4 rows for corpus ${corpus} tally to ${JSON.stringify(tally)}`,
    ).toBe(true);
  });
});

describe('the top-of-file summary table restates the same three numbers, not a fourth document', () => {
  const readmeText = readme();
  const bench = lastByTriple(parseBenchRows(resultsArtifact()));
  const corpus24 = /tiers? 2.{0,3}4 from run [\d-]+ on corpus `([0-9a-f]+)`/.exec(
    section(readmeText, 'Measured numbers'),
  )?.[1];
  const top = readmeText.slice(0, readmeText.indexOf('## What it does'));

  it('states the same Tier 2 corpus total as the "Measured numbers" section', () => {
    const all = [...bench.values()].filter((row) => row.tier === 2 && row.corpus === corpus24);
    const input = all.reduce((sum, row) => sum + row.input, 0);
    const output = all.reduce((sum, row) => sum + row.output, 0);
    const inFmt = input.toLocaleString('en-US');
    const outFmt = output.toLocaleString('en-US');
    expect(
      top.includes(`${inFmt} → ${outFmt}`),
      `the top summary no longer states "${inFmt} → ${outFmt}" — disagrees with the Tier ` +
        `2 corpus total below it`,
    ).toBe(true);
  });

  it('states the same Tier 3 aggregate as the "Measured numbers" section', () => {
    const allCases = [...bench.values()].find(
      (row) => row.tier === 3 && row.corpus === corpus24 && row.case === 'ALL CASES',
    );
    expect(allCases).toBeDefined();
    const rate = (allCases!.output / allCases!.input).toFixed(2);
    expect(
      top.includes(`**${rate}**`) &&
        top.includes(`${String(allCases!.output)} of ${String(allCases!.input)}`),
      `the top summary no longer states "${rate}" / "${String(allCases!.output)} of ` +
        `${String(allCases!.input)}" — disagrees with the Tier 3 section below it`,
    ).toBe(true);
  });
});

/**
 * The "Sixty seconds" section's first fenced example is a real terminal transcript,
 * not hand-typed prose — `smelt packages/core/src/plan/lexical.ts --budget 4000
 * --focus planLexical`, run against the repo's own planner source. Unlike the
 * bench/RESULTS.md cross-checks above, there is no separate measurement file to
 * quote: the "measurement" here *is* the CLI, so this guard runs it directly (through
 * `@guard/cli/run`, so a source mutation reaches it exactly as a real code change
 * would) rather than shelling out to a prebuilt binary — `pnpm mutate` never rebuilds
 * `dist`, so a check against the packaged binary would never see a mutation at all.
 *
 * This is a real, if unusual, maintenance cost stated rather than hidden: `lexical.ts`
 * growing or shrinking moves the pinned byte counts, and whoever touches that file
 * next regenerates the block (the exact command is printed right above it in the
 * README, so "regenerate" is one shell line, not archaeology). The alternative —
 * a synthetic fixture that never drifts — would stop being a real demonstration of
 * smelting smelt's own source, which is the point of showing it at all.
 */
describe('the "Sixty seconds" first example is regenerated from the real binary, not stale prose', () => {
  it('smelt packages/core/src/plan/lexical.ts --budget 4000 --focus planLexical matches the pinned block', async () => {
    const filePath = join(guardSrcRoot(), 'plan/lexical.ts');
    let stdoutText = '';
    let stderrText = '';
    const code = await runCli([filePath, '--budget', '4000', '--focus', 'planLexical'], {
      stdout: (text: string) => {
        stdoutText += text;
      },
      stderr: (text: string) => {
        stderrText += text;
      },
      stdin: () => '',
      version: '0.0.0-guard',
    });
    expect(code, `smelt exited ${String(code)}, expected ${String(EXIT.ok)} (ok)`).toBe(EXIT.ok);
    void stdoutText;

    // The report names the file by the path it was given (a temp scratch path under
    // `pnpm mutate`, the real repo-relative one otherwise) — normalize it to the
    // README's own spelling before comparing, so the pin stays portable.
    const normalized = stderrText.replace(filePath, 'packages/core/src/plan/lexical.ts');

    const block = section(readme(), 'Sixty seconds');
    const pinned = /```\nsmelt {2}packages\/core\/src\/plan\/lexical\.ts[\s\S]*?\n```/.exec(block);
    expect(
      pinned,
      'README no longer carries the pinned lexical.ts transcript block',
    ).not.toBeNull();
    const pinnedBody = pinned![0].replace(/^```\n/, '').replace(/\n```$/, '');

    expect(
      normalized.trimEnd(),
      "the real binary's output for this exact command no longer matches the README's " +
        'pinned transcript — regenerate the block with the command printed above it ' +
        'and pin the new output',
    ).toBe(pinnedBody.trimEnd());
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`. The three `bench/RESULTS.md`
 * mutations are `kind: 'artifact'`: the README is deliberately never mutated (see the
 * module doc's "outside voice" note), so the only side of those three cross-checks
 * that can drift is the measurement they quote. The fourth mutation is `kind: 'src'`,
 * against `lexical.ts` itself — the file the pinned transcript is *of* — proving the
 * transcript check reads the real, mutation-sensitive planner rather than a frozen
 * snapshot of one past run.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'readme-numbers-tier2-total-stale',
    file: 'bench/RESULTS.md',
    find: '| large-ts-file | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 11768 | 4036 | 3 | count_tokens, text as one user message |',
    replace:
      '| large-ts-file | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 11768 | 5000 | 3 | count_tokens, text as one user message |',
    why: 'a Tier 2 token count edited without touching the README — the corpus total and the per-case row both drift silently from what the README states as measured',
  },
  {
    kind: 'artifact',
    id: 'readme-numbers-tier3-aggregate-stale',
    file: 'bench/RESULTS.md',
    find: '| ALL CASES | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 18 | 17 | — | aggregate expansion rate 0.94 over 9 completed case(s) |',
    replace:
      '| ALL CASES | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 18 | 16 | — | aggregate expansion rate 0.89 over 9 completed case(s) |',
    why: 'the tier 3 expansion-rate aggregate changing without the README\'s "0.94" / "17 of 18" prose moving with it — the alarm figure Law 4 exists to keep honest',
  },
  {
    kind: 'artifact',
    id: 'readme-numbers-tier4-verdict-stale',
    file: 'bench/RESULTS.md',
    find: '| multi-file-grep | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 2886 | 5091 | 2 | raw 2886 in/1087 out · smelted 5091 in/1649 out · 2 retrieve(s) · verdict: raw better |',
    replace:
      '| multi-file-grep | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 2886 | 5091 | 2 | raw 2886 in/1087 out · smelted 5091 in/1649 out · 2 retrieve(s) · verdict: tie |',
    why: 'a tier 4 verdict changing (raw better → tie) without the README\'s per-case cell or its "Six ties, two raw-better, one smelted-better" tally sentence moving with it',
  },
  {
    id: 'readme-numbers-lexical-transcript-stale',
    file: 'plan/lexical.ts',
    find: '/** How hard the head/tail strategy squeezes, in order, when the budget is not met. */',
    replace:
      '/** How hard the head/tail strategy squeezes, in order, when the budget is not met — extended for the mutation guard. */',
    why: 'lexical.ts growing without the README\'s pinned "Sixty seconds" transcript being regenerated — the byte counts, hashes and line counts in that block are a real terminal capture, not prose, and they go stale exactly like this',
  },
];
