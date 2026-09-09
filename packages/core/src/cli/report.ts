import { GUIDE, GUIDE_TITLE } from '../agents/guide.ts';
import { overBudgetBytes } from '../agents/lint.ts';
import type { AgentsLintReport, AgentsMirrorReport } from '../agents/lint.ts';
import type { ResolvedFocus } from '../ops/verbs.ts';
import type { RepoMap } from '../repomap/map.ts';
import type { PruneReport } from '../store-dir.ts';
import type { RerankAttribution, RetrieveStats, RuleLedgerEntry, SmeltResult } from '../types.ts';

import { CONFIG_FILE_NAME } from '../config.ts';
import { PLAIN } from './lava.ts';
import type { Palette } from './lava.ts';
import { CLI_NAME } from './shell.ts';

export interface ReportInput {
  readonly result: SmeltResult;
  /** What to call the input in the header: a path, or `'<stdin>'`. */
  readonly source: string;
  /** The budget the caller asked for, so the report can say when it was missed. */
  readonly budgetBytes: number;
  /** The exact text that was smelted. Used only to count lines inside each range. */
  readonly inputText: string;
  /**
   * The focus the planner saw and whose it was — printed so a reader can tell a cut
   * the caller asked for from one a producer hint derived. Absent when the caller
   * built the input by hand and has no focus to attribute.
   */
  readonly focus?: ResolvedFocus;
  /** How *this* surface spells the producer knob: `--producer` for the CLI. */
  readonly producerKnob?: string;
}

/** Longest explanation printed in full before it gets an ellipsis. */
const EXPLANATION_WIDTH = 46;

/**
 * The report, for stderr.
 *
 * Every total here is read straight off the {@link SmeltResult} — `inputBytes`,
 * `outputBytes`, `elisions.length`. The CLI keeps no counters of its own, because two
 * pieces of code counting the same bytes is how a report ends up disagreeing with the
 * library it is reporting on, and the report is the thing a human believes.
 * `test/cli.test.ts` asserts the printed numbers equal the result's fields.
 */
export function formatReport(
  { result, source, budgetBytes, inputText, focus, producerKnob = '--producer' }: ReportInput,
  lava: Palette = PLAIN,
): string {
  const lines: string[] = [];

  lines.push(
    [
      lava.paint('brand', CLI_NAME),
      lava.paint('path', source),
      lava.paint('dim', result.language),
      lava.paint('rule', result.planner),
    ].join('  '),
  );
  lines.push(
    `in ${lava.paint('number', `${group(result.inputBytes)} B`)} → ` +
      `out ${lava.paint('number', `${group(result.outputBytes)} B`)}   ` +
      `(${lava.paint('number', delta(result.inputBytes, result.outputBytes))}, ` +
      `${count(result.elisions.length, 'elision')})`,
  );
  if (focus !== undefined && focus.terms.length > 0) {
    lines.push(
      `focus  ${lava.paint('strong', focus.terms.join(', '))}` +
        (focus.source === 'producer' ? `   (from ${producerKnob})` : ''),
    );
  }

  if (result.measured !== undefined) {
    const { input, output, unit, measure } = result.measured;
    lines.push(
      `in ${lava.paint('number', group(input))} → ` +
        `out ${lava.paint('number', group(output))} ${unit} (${measure})`,
    );
  }

  if (result.rerank !== undefined) lines.push(rerankLine(result.rerank, lava));

  if (result.outputBytes > budgetBytes) {
    lines.push('');
    lines.push(
      lava.paint('bad', 'OVER BUDGET') +
        `  ${group(result.outputBytes)} B against a ${group(budgetBytes)} B budget ` +
        `— over by ${group(result.outputBytes - budgetBytes)} B.`,
    );
    lines.push('             The plan is reported as it came back. smelt did not cut the regions');
    lines.push('             you asked to keep in order to make a number look right.');
  }

  if (result.elisions.length === 0) {
    lines.push('');
    lines.push('  nothing elided — the input already fits, or every run was too small to');
    lines.push('  be worth a marker (a marker that costs more than the lines it replaces');
    lines.push('  makes the output bigger).');
    return `${lines.join('\n')}\n`;
  }

  const rows = result.elisions.map((elision) => ({
    rule: elision.reason.rule,
    lines: String(lineSpan(inputText, elision.range.start, elision.range.end)),
    bytes: group(elision.bytes),
    hash: elision.hash,
    explanation: clip(elision.reason.explanation, EXPLANATION_WIDTH),
    names: elision.names ?? [],
  }));

  const ruleWidth = width(
    'rule',
    rows.map((row) => row.rule),
  );
  const linesWidth = width(
    'lines',
    rows.map((row) => row.lines),
  );
  const bytesWidth = width(
    'bytes',
    rows.map((row) => row.bytes),
  );
  const hashWidth = width(
    'hash',
    rows.map((row) => row.hash),
  );

  lines.push('');
  lines.push(
    lava.paint(
      'dim',
      `  ${'rule'.padEnd(ruleWidth)}  ${'lines'.padStart(linesWidth)}  ` +
        `${'bytes'.padStart(bytesWidth)}  ${'hash'.padEnd(hashWidth)}  explanation`,
    ),
  );
  for (const row of rows) {
    // Padded first, painted second: an escape sequence has zero width, so a column
    // padded after painting is a column that does not line up.
    lines.push(
      `  ${lava.paint('rule', row.rule.padEnd(ruleWidth))}  ` +
        `${lava.paint('number', row.lines.padStart(linesWidth))}  ` +
        `${lava.paint('number', row.bytes.padStart(bytesWidth))}  ` +
        `${lava.paint('hash', row.hash.padEnd(hashWidth))}  ${row.explanation}`,
    );
    // The outline — what is behind this marker, by name — on its own wrapped lines
    // beneath the row. Never clipped: it is the index a reader (or a model deciding
    // whether to retrieve) needs whole, and Law 2's explanation is already the row.
    if (row.names.length > 0) {
      for (const wrapped of wrap(`${OUTLINE_LEADER} ${row.names.join(', ')}`, EXPLANATION_WRAP)) {
        lines.push(`      ${wrapped}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

/** Introduces an elision's outline line. */
const OUTLINE_LEADER = '↳ names:';

/**
 * The rerank line — the outbound call, printed where the reader is already looking.
 *
 * A configured reranker means regions of this input left the machine, and Law 2 says a
 * reader must be able to see what happened to their bytes without reading the config.
 * So the line names the adapter (and its model, when the stage names one) and states
 * the numbers that were actually measured: how many regions were offered to it, how
 * many survived the cut, and what those put back into the output.
 *
 * The `B back` clause appears exactly when the stage ran, which is exactly when there
 * are bytes to report — the same rule the attribution itself follows.
 *
 * `0 candidates` gets its own clause rather than being hidden, because "the stage was
 * configured and had nothing to do" and "the stage never ran" look identical from a
 * line that only prints numbers — and one of them is a misconfiguration. The budget
 * stop gets one for the same reason one level along: a `topK` of 8 that yielded 3 is
 * unreadable without the sentence that says smelt refused the other five, and which
 * ceiling it refused them against.
 *
 * Built from {@link RerankAttribution} rather than from anything this module counts:
 * the report keeps no tally of its own, here as everywhere else in this file.
 */
function rerankLine(rerank: RerankAttribution, lava: Palette): string {
  const adapter = rerank.model === undefined ? rerank.adapter : `${rerank.adapter}/${rerank.model}`;
  const back = rerank.sparedBytes === undefined ? '' : `, ${group(rerank.sparedBytes)} B back`;
  const counts = `(${count(rerank.candidates, 'candidate')}, ${group(rerank.kept)} kept${back})`;
  const skipped = RERANK_SKIPPED[rerank.skipped ?? 'ran'];
  const stopped = rerank.stopped === undefined ? '' : RERANK_STOPPED[rerank.stopped](rerank);
  return (
    `rerank  ${lava.paint('rule', adapter)}  ${counts}` +
    // The clause is the interesting half of the line when it is there: the stage was
    // configured, and did not run — or it ran, and the budget cut its answer short.
    `${lava.paint('warn', skipped)}${lava.paint('warn', stopped)}`
  );
}

/**
 * Why the stage did not run, when it did not — a clause rather than a silence.
 *
 * `Record<…, string>` over the outcomes so a third `skipped` reason is a compile error
 * here rather than a line that quietly prints nothing, the same totality the language
 * and harness registries get.
 */
const RERANK_SKIPPED: Readonly<
  Record<'ran' | 'no-candidates' | 'no-query' | 'plan-over-budget', string>
> = {
  ran: '',
  'no-candidates': '   not run: the planner proposed nothing to cut',
  'no-query': '   not run: this run named no focus terms to rank against',
  'plan-over-budget':
    '   not run: the planner’s own plan is over budget, so nothing could be spared',
};

/**
 * Where the sparing stopped, when the stage ran — the other total table on this line.
 *
 * Only the budget stop prints. `cap` and `exhausted` are the outcomes where `kept` is
 * already the whole answer the stage gave, so a clause would restate the counts beside
 * it on every single run; `budget` is the one where the printed `kept` is smaller than
 * what was asked for, and a number that small with no reason beside it is the thing
 * Law 2 exists to forbid. They are entries rather than an `if` so a fourth stop reason
 * is a compile error here, exactly as a third `skipped` reason is above.
 */
const RERANK_STOPPED: Readonly<
  Record<NonNullable<RerankAttribution['stopped']>, (rerank: RerankAttribution) => string>
> = {
  // The count is the stage's answer, not a stand-in for it: an attribution that carries
  // `stopped` without `returned` is one this pipeline does not produce, and printing
  // `kept` there instead would render "the stage offered 3" over a run where it offered
  // eight. So the half of the sentence that has no measurement behind it is not printed.
  budget: (rerank) =>
    rerank.returned === undefined
      ? '   stopped at the budget'
      : `   stopped at the budget: the stage offered ${group(rerank.returned)}`,
  cap: () => '',
  exhausted: () => '',
};

/** What `smelt map` prints to stderr. */
export interface MapReportInput {
  readonly map: RepoMap;
  /** The directory named on the command line, exactly as the user wrote it. */
  readonly source: string;
  /**
   * Where the budget came from — the `ResolvedMapRun.budgetSource` receipt, printed
   * beside the budget so a surprising number can be traced to the flag or the config
   * file that set it without re-deriving the precedence by hand.
   */
  readonly budgetSource: 'flag' | 'config';
}

/**
 * The map report, for stderr — same law as {@link formatReport}: every number is
 * read straight off the {@link RepoMap} the library returned. In particular the
 * "bytes used" figure is `map.outputBytes`, which the library measured off the
 * rendered text — the CLI counts nothing itself, because a report that keeps its
 * own tally is a report that can disagree with the map it describes.
 * `test/guards/repo-map.test.ts` asserts the printed figure equals the actual byte
 * length of what landed on stdout, and a mutation proves the assertion can go red.
 */
export function formatMapReport(
  { map, source, budgetSource }: MapReportInput,
  lava: Palette = PLAIN,
): string {
  const lines: string[] = [];

  lines.push(
    [
      `${lava.paint('brand', CLI_NAME)} map`,
      lava.paint('path', source),
      lava.paint('hash', map.id),
    ].join('  '),
  );
  lines.push(
    `files scanned ${lava.paint('number', group(map.filesScanned))}` +
      (map.binarySkipped === 0 ? '' : ` (${count(map.binarySkipped, 'binary file')} skipped)`) +
      `   symbols ranked ${lava.paint('number', group(map.definitionsTotal))}`,
  );
  lines.push(
    `included ${lava.paint('number', group(map.entries.length))} of ` +
      `${group(map.definitionsTotal)} symbols` +
      (map.pathOnlyTotal === 0
        ? ''
        : ` + ${group(map.pathOnly.length)} of ${group(map.pathOnlyTotal)} path-only files`),
  );
  lines.push(
    `bytes used ${lava.paint('number', group(map.outputBytes))} of ` +
      `${group(map.budgetBytes)} budget (${budgetSource}) ` +
      `— the map fits itself to the budget by construction, so there is no over-budget exit`,
  );

  if (map.cache !== undefined) {
    lines.push(
      `cache  ${count(map.cache.hits, 'hit')}, ${count(map.cache.misses, 'miss', 'es')}, ` +
        `${group(map.cache.discarded)} discarded, ${group(map.cache.pruned)} pruned`,
    );
  }
  for (const warning of map.warnings) {
    lines.push(lava.paint('warn', `warning  ${warning.rule}: ${warning.explanation}`));
  }

  return `${lines.join('\n')}\n`;
}

/** What `smelt agents lint` prints. */
export interface AgentsReportInput {
  /** The directory named on the command line, exactly as the user wrote it. */
  readonly source: string;
  /** Whether `--strict` was given — it changes what the closing line promises. */
  readonly strict: boolean;
}

/**
 * The lint report — and unlike the other two, it goes to **stdout**, because here the
 * report *is* the output. `smelt` and `smelt map` put a payload on stdout and their
 * report on stderr so the two can be piped apart; a lint has no payload to separate
 * from, and sending its only output to stderr would make `smelt agents lint > audit.txt`
 * write an empty file.
 *
 * Same law as the other two, though: every number is read off the
 * {@link AgentsLintReport} the library returned. The renderer counts nothing, so it
 * cannot disagree with what was measured — and in particular both totals are the ones
 * the lint computed over the levels, not a second tally over the printed rows. The
 * guide's cited figure is likewise read from `agents/guide.ts` rather than retyped
 * under the guide's name.
 */
export function formatAgentsReport(
  report: AgentsLintReport,
  { source, strict }: AgentsReportInput,
  lava: Palette = PLAIN,
): string {
  const lines: string[] = [
    `${lava.paint('brand', `${CLI_NAME} agents lint`)}  ${lava.paint('path', source)}`,
  ];

  if (report.levels.length === 0) {
    lines.push('');
    lines.push(`  no AGENTS.md, CLAUDE.md or GEMINI.md under ${source} — nothing is loaded on`);
    lines.push('  every request, so there is nothing to measure. That is a fine state, not a');
    lines.push(`  failure; \`${CLI_NAME} agents lint\` has no opinion about whether you want one.`);
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  lines.push('  the instruction files in this tree');
  const labelWidth = report.levels.reduce(
    (widest, level) =>
      Math.max(widest, level.path.length, ...level.mirrors.map((m) => m.path.length)),
    Math.max(IMPERATIVES_LABEL.length, PER_REQUEST_LABEL.length, WHOLE_TREE_LABEL.length),
  );
  for (const level of report.levels) {
    lines.push(`    ${level.path.padEnd(labelWidth)}  ${group(level.bytes).padStart(9)} B`);
    for (const mirror of level.mirrors) {
      lines.push(
        `    ${mirror.path.padEnd(labelWidth)}  ${' '.repeat(11)}${mirrorNote(mirror.standing)}`,
      );
    }
  }
  lines.push(
    `    ${PER_REQUEST_LABEL.padEnd(labelWidth)}  ${group(report.perRequestBytes).padStart(9)} B`,
  );
  // Printed only when it is a different number — which is exactly when a reader could
  // otherwise mistake the sum for a per-request cost. In a single-chain repository the
  // two are equal and a second row would be noise claiming to be information.
  if (report.totalBytes !== report.perRequestBytes) {
    lines.push(
      `    ${WHOLE_TREE_LABEL.padEnd(labelWidth)}  ${group(report.totalBytes).padStart(9)} B`,
    );
    lines.push('    a nested file merges with its ancestors, never with its siblings, so no');
    lines.push('    one request loads the whole tree. Per request is the heaviest chain.');
  }
  lines.push(
    `    ${IMPERATIVES_LABEL.padEnd(labelWidth)}  ` +
      `${group(report.imperatives.length).padStart(9)}`,
  );
  // The figure is the guide's, so it is read from where the guide is quoted rather
  // than retyped here: an explanation that paraphrases its source drifts from it
  // silently, and this one is printed under the guide's own name.
  for (const wrapped of wrap(`${GUIDE_TITLE} cites: "${GUIDE.instructionCeiling}".`, 68)) {
    lines.push(`    ${wrapped}`);
  }
  lines.push('    Printed as a citation, compared to nothing: the only ceiling here is');
  lines.push('    the one you set.');

  const over = overBudgetBytes(report);
  lines.push('');
  if (report.budgetBytes === undefined) {
    lines.push(`  no budget set — add {"agents":{"budgetBytes":N}} to ${CONFIG_FILE_NAME} and`);
    lines.push(`  exceeding it exits 1. ${CLI_NAME} will never invent that number for you.`);
  } else if (over === undefined) {
    lines.push(
      `  within budget  ${group(report.totalBytes)} B of ${group(report.budgetBytes)} B ` +
        `(${CONFIG_FILE_NAME}: agents.budgetBytes, against the whole tree).`,
    );
  } else {
    lines.push(
      `  ${lava.paint('bad', 'OVER BUDGET')}  ${group(report.totalBytes)} B against your ` +
        `${group(report.budgetBytes)} B budget — over by ${group(over)} B.`,
    );
    lines.push(`               The budget is yours, from ${CONFIG_FILE_NAME}, and it caps the`);
    lines.push('               whole tree rather than one request — the stricter of the two, so');
    lines.push('               it cannot be met by moving bytes into another package. Exit 1 is');
    lines.push('               the same over-budget code every other smelt run uses.');
  }

  if (report.findings.length === 0) {
    lines.push('');
    lines.push('  no findings. Eight advisory rules ran and none matched — either the file is');
    lines.push('  in good shape, or a rule is asleep. `pnpm mutate` is how this repo tells the');
    lines.push('  difference about its own guards; a fixture per rule is how it tells it here.');
    return `${lines.join('\n')}\n`;
  }

  const rows = report.findings.map((finding) => ({
    place: `${finding.file}:${String(finding.line)}`,
    rule: finding.reason.rule,
    explanation: finding.reason.explanation,
  }));
  const ruleWidth = width(
    '',
    rows.map((row) => row.rule),
  );

  lines.push('');
  for (const row of rows) {
    lines.push(
      `  ${lava.paint('rule', row.rule.padEnd(ruleWidth))}  ${lava.paint('path', row.place)}`,
    );
    // The explanation gets its own wrapped lines rather than a fourth column. It is
    // the *reason*, which is the part a reader actually has to read — clipped to a
    // terminal column it becomes an ellipsis, and Law 2 promises an explanation, not
    // the first 46 characters of one.
    for (const wrapped of wrap(row.explanation, EXPLANATION_WRAP)) lines.push(`      ${wrapped}`);
  }

  lines.push('');
  lines.push(
    `  ${count(report.findings.length, 'finding')}. ` +
      (strict
        ? 'Exit 1: --strict was given.'
        : `Advisory — exit 0. Pass --strict to fail a CI run on any of them.`),
  );

  return `${lines.join('\n')}\n`;
}

/** The label the imperative count is reported under. Never "instructions": R6. */
const IMPERATIVES_LABEL = 'imperatives (heuristic)';

/** The heaviest ancestor chain — the honest answer to "what does a request cost". */
const PER_REQUEST_LABEL = 'per request (worst case)';

/** Every level summed. The repository's instruction surface, and not a request's cost. */
const WHOLE_TREE_LABEL = 'whole tree';

/** Where a finding's explanation wraps, once its six-column indent is removed. */
const EXPLANATION_WRAP = 84;

/** Greedy word wrap. No ICU, no dependency — the output is identical everywhere. */
function wrap(text: string, columns: number): readonly string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && candidate.length > columns) {
      out.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== '') out.push(line);
  return out;
}

/** How a mirror stands beside its AGENTS.md, in one clause. */
function mirrorNote(standing: AgentsMirrorReport['standing']): string {
  switch (standing) {
    case 'symlink':
      return 'symlink — cannot drift, and costs no extra bytes';
    case 'copy':
      return 'copy, byte-identical today — a symlink could not drift';
    case 'drift':
      return 'DIVERGED — see mirror-drift below';
  }
}

/** How many lines a byte range covers in the input. Derived, never tallied separately. */ function lineSpan(
  text: string,
  start: number,
  end: number,
): number {
  const slice = Buffer.from(text, 'utf8').subarray(start, end).toString('utf8');
  return slice.split('\n').length;
}

function width(header: string, values: readonly string[]): number {
  return values.reduce((widest, value) => Math.max(widest, value.length), header.length);
}

/** Thousands separators without pulling in ICU, so the output is identical everywhere. */
function group(n: number): string {
  const digits = String(Math.abs(Math.trunc(n)));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `-${grouped}` : grouped;
}

function delta(inputBytes: number, outputBytes: number): string {
  if (inputBytes === 0) return 'empty input';
  const percent = ((outputBytes - inputBytes) / inputBytes) * 100;
  const sign = percent > 0 ? '+' : '';
  return `${sign}${percent.toFixed(1)}%`;
}

function count(n: number, noun: string, pluralSuffix = 's'): string {
  return `${group(n)} ${noun}${n === 1 ? '' : pluralSuffix}`;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * `3 blobs, 1.2 KB` — one store's size, as prose.
 *
 * It lives here, with every other rendering, because two surfaces print it: the
 * `smelt doctor` config line and the `smelt store prune` header. Both read the same
 * two integers off a structured field (`DoctorConfig.store.blobs`/`.bytes`,
 * `PruneReport`), and the exact bytes stay in those fields — this is the *rendering*
 * of them, so a reader who needs the number to the byte reads the receipt rather than
 * a rounded KB.
 */
export function formatStoreSize(blobs: number, bytes: number): string {
  return `${count(blobs, 'blob')}, ${formatBytes(bytes)}`;
}

/** What {@link formatStatsReport} renders: the counters, the ledger, and the store. */
export interface StatsReportInput {
  readonly stats: RetrieveStats;
  readonly ledger: readonly RuleLedgerEntry[];
  /** The store directory this reading came from, as resolved. */
  readonly storePath: string;
  /**
   * The directory's own size, read off disk — `undefined` when it holds no `blobs/`
   * yet. Two numbers rather than a sentence, for the same reason the doctor receipt
   * carries them that way.
   */
  readonly size?: { readonly blobs: number; readonly bytes: number };
}

/** How wide the expansion bar is drawn. The palette caps any bar at `BAR_WIDTH`. */
const EXPANSION_BAR = 24;

/**
 * The `smelt stats` report — the store, looked at.
 *
 * Four blocks, in the order a reader needs them: **where** these counters came from,
 * **the one number that means something** (the expansion rate, with a bar, so a glance
 * is enough), **the counters themselves**, and **the ledger** — which rule's cuts get
 * asked for back, the feedback loop the ledger exists for.
 *
 * Every number here is read straight off the {@link RetrieveStats} and the ledger the
 * store returned, exactly like every other renderer in this file. The rate is the
 * store's own `expansionRate` and not `uniqueRetrieved / elisionsStored` recomputed
 * here: a report that re-derives a number is a report that can disagree with the store
 * it describes. The per-rule `rate` column is the one derivation, and it is stated as
 * what it is — a ratio of the two integers printed beside it.
 *
 * There is no "corrupt" or "evicted" row, because there is no such counter: a prune
 * moves `bytesStored` and nothing else, and a corrupt blob is a refusal at retrieve
 * time rather than a tally. A row smelt cannot measure is a row smelt does not print.
 */
export function formatStatsReport(
  { stats, ledger, storePath, size }: StatsReportInput,
  lava: Palette = PLAIN,
): string {
  const lines: string[] = [
    `${lava.paint('brand', `${CLI_NAME} stats`)}  ${lava.paint('path', storePath)}`,
    size === undefined
      ? lava.paint('dim', 'directory store')
      : `${lava.paint('number', formatStoreSize(size.blobs, size.bytes))} ` +
        `${lava.paint('dim', 'on disk')}`,
  ];

  if (stats.elisionsStored === 0) {
    lines.push('');
    lines.push(`  nothing stored yet ${lava.dash()} no run has elided anything into this store.`);
    lines.push(`  ${CLI_NAME} <file> --budget 4000 fills it, and this page reports on it.`);
    return `${lines.join('\n')}\n`;
  }

  const asked = `${group(stats.uniqueRetrieved)} of ${group(stats.elisionsStored)} elisions asked for back`;
  lines.push('');
  lines.push(
    `  ${lava.paint('dim', 'expansion')}  ${lava.bar(stats.expansionRate, EXPANSION_BAR)}  ` +
      `${lava.paint('number', lava.percent(stats.expansionRate))}   ${lava.paint('dim', asked)}`,
  );
  lines.push('');
  lines.push(
    lava.kv([
      { name: 'elisionsStored', value: group(stats.elisionsStored), role: 'number' },
      { name: 'bytesStored', value: group(stats.bytesStored), role: 'number' },
      { name: 'retrieveCalls', value: group(stats.retrieveCalls), role: 'number' },
      { name: 'uniqueRetrieved', value: group(stats.uniqueRetrieved), role: 'number' },
      // A miss is a call for a hash the store does not hold: a bug, not over-pruning.
      { name: 'misses', value: group(stats.misses), role: stats.misses === 0 ? 'number' : 'bad' },
      { name: 'expansionRate', value: String(stats.expansionRate), role: 'number' },
      {
        // The one degenerate outcome smelt names. `true` means every blob it hid was
        // asked back — the elision achieved nothing — so the row is painted as the
        // finding it is.
        name: 'allElisionsRetrieved',
        value: String(stats.allElisionsRetrieved),
        role: stats.allElisionsRetrieved ? 'bad' : 'plain',
      },
    ]),
  );

  if (ledger.length > 0) {
    lines.push('');
    lines.push(
      lava.table({
        columns: [
          { header: 'rule', role: 'rule' },
          { header: 'stored', align: 'right', role: 'number' },
          { header: 'retrieved', align: 'right', role: 'number' },
          { header: 'rate', align: 'right', role: 'number' },
        ],
        // Heaviest rule first: the rule that cut the most is the rule whose retrieval
        // rate costs the most, and it is the row a reader is looking for. Ties fall
        // back to the rule id, so two reads of one store render identically.
        rows: ledger
          .toSorted((a, b) => b.stored - a.stored || a.rule.localeCompare(b.rule))
          .map((entry) => [
            entry.rule,
            group(entry.stored),
            group(entry.retrieved),
            lava.percent(entry.stored === 0 ? 0 : entry.retrieved / entry.stored),
          ]),
      }),
    );
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Bytes for a human: exact under a kibibyte, one decimal above it. Deliberately not a
 * measurement — every byte count smelt *claims* is an integer in a receipt, and this
 * only decides how to print one.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${group(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** What {@link formatPruneReport} renders: the store's own report, plus its naming. */
export interface PruneReportInput {
  readonly report: PruneReport;
  /** The store directory the prune ran against, as resolved. */
  readonly storePath: string;
  /** The cut-off the user typed — `30d`, echoed rather than re-derived from a Date. */
  readonly olderThan: string;
  /**
   * Which spelling of the cut-off this run used: `'flag'` for `--older-than`,
   * `'config'` for `store.retention.olderThan`. A receipt for a deletion answers "who
   * chose this number" as well as "what went", and the two answers look identical on
   * the command line — the header says which, so a prune that took more than expected
   * can be traced to the file that said so.
   */
  readonly olderThanSource: 'flag' | 'config';
  /** Whether `--keep-retrieved` was in force, so the report can say what spared a blob. */
  readonly keepRetrieved: boolean;
  /**
   * What put it in force — the flag, the config, or both. The header attributes the
   * sparing whenever the config had a hand in it, because "this kept blobs I never
   * asked it to keep" is the question a receipt has to be able to answer; a flag the
   * user typed themselves needs no attribution.
   */
  readonly keepRetrievedSource: 'flag' | 'config' | 'both' | 'none';
}

/**
 * The `smelt store prune` report, for stdout.
 *
 * Every number here is read straight off the {@link PruneReport} the store returned —
 * the CLI counts nothing itself, for the same reason `formatReport` counts nothing
 * itself: two pieces of code counting the same bytes is how a report ends up
 * disagreeing with the thing it is reporting on, and this report is about bytes that
 * are now gone.
 *
 * The closing sentence is not decoration. A prune is the only deletion in smelt, and a
 * user who runs it should leave knowing exactly what a later `retrieve` of one of these
 * hashes will say.
 */
export function formatPruneReport(
  {
    report,
    storePath,
    olderThan,
    olderThanSource,
    keepRetrieved,
    keepRetrievedSource,
  }: PruneReportInput,
  lava: Palette = PLAIN,
): string {
  const configured = `${CONFIG_FILE_NAME}: store.retention`;
  const mercy = !keepRetrieved
    ? ''
    : keepRetrievedSource === 'config'
      ? `, keeping retrieved (${configured})`
      : keepRetrievedSource === 'both'
        ? `, keeping retrieved (--keep-retrieved, and ${configured})`
        : ', keeping retrieved';
  const lines: string[] = [];
  lines.push(
    `${lava.paint('brand', `${CLI_NAME} store prune`)}${report.dryRun ? ' --dry-run' : ''}  ` +
      `${lava.paint('path', storePath)}  ` +
      `older than ${olderThan}` +
      `${olderThanSource === 'config' ? ` (${configured})` : ''}` +
      mercy,
  );
  lines.push(
    `scanned ${count(report.scanned, 'blob')}  ` +
      `${report.dryRun ? 'would evict' : 'evicted'} ` +
      `${lava.paint('number', group(report.evicted.length))}  ` +
      `kept ${lava.paint('number', group(report.kept))}  ` +
      `${report.dryRun ? 'would free' : 'freed'} ` +
      `${lava.paint('number', formatBytes(report.bytesFreed))}`,
  );

  if (report.evicted.length === 0) {
    lines.push('');
    // Two reasons nothing went, and they are not the same fact: with --keep-retrieved
    // in force, a blob old enough to evict may have been spared for having been asked
    // for back, and telling the user it "was not old enough" would be false.
    lines.push(
      keepRetrieved
        ? '  nothing was both old enough and unretrieved — no bytes left this store.'
        : '  nothing was old enough — no bytes left this store.',
    );
    return `${lines.join('\n')}\n`;
  }

  lines.push('');
  for (const blob of report.evicted) {
    lines.push(
      `  ${lava.paint('hash', blob.hash)}  ` +
        `${lava.paint('number', formatBytes(blob.bytes).padStart(9))}  ` +
        `${lava.paint('dim', blob.putAt)}`,
    );
  }
  lines.push('');
  lines.push(
    report.dryRun
      ? '  Nothing was deleted. Run the same command without --dry-run to evict these.'
      : lava.paint(
          'warn',
          '  These bytes are gone. A retrieve of one of these hashes now answers\n' +
            '  EvictedHashError, naming the date — never "it was never elided".',
        ),
  );
  return `${lines.join('\n')}\n`;
}
