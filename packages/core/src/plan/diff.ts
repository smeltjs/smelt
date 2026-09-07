import { ContentKindError, MissingMarkerPricingError } from '../errors.ts';
import type { ElisionPlan, MarkerPricing, PlanInput, PlannedElision, Planner } from '../types.ts';

import { predictOutputBytes, savingBytes } from './budget.ts';
import { probeKind } from './kind.ts';

export const DIFF_PLANNER_ID = 'diff/v1';

/**
 * The three rules, coarsest first: whole files the focus never touches; hunks inside a
 * file it does; and, inside a hunk it does, the line runs no match sits near.
 */
export const FILE_COLLAPSE_RULE = 'file-collapse';
export const HUNK_COLLAPSE_RULE = 'hunk-collapse';
export const HUNK_WINDOW_RULE = 'hunk-window';

/** Context lines kept either side of a match inside a matched hunk, tried in order. */
const WINDOW_LADDER: readonly number[] = [4, 3, 2, 1, 0];

/** Never collapse a run inside a hunk shorter than this. */
const MIN_RUN_LINES = 3;

export interface DiffPlannerOptions {
  /** Focus matching is substring, case-insensitive by default. */
  readonly caseSensitive?: boolean;
}

/**
 * The diff planner: **files and hunks are the units, not lines.**
 *
 * A unified diff has a structure a line planner cannot see: files, each with a header
 * and hunks. Under a focus, a file none of whose hunks carry a term collapses whole —
 * one marker per run of such files, the outline naming their paths — and inside a file
 * that does match, the hunks that do not collapse as a run while the header survives
 * verbatim — and inside a hunk that does match, the line runs no match sits near
 * collapse as a window (the lexical planner's move, confined to the hunk, with the same
 * context ladder under budget pressure), so the planner never keeps more of a hunk than
 * a line planner would. With no focus every file header is kept and each file's hunks
 * collapse to one marker, so the survivor is the diff's table of contents. Measured on
 * the bench's real diff (`git-diff`): every hunk mentioned the focus term, and without
 * the window rule this planner cut nothing where lexical cut to 1516 B.
 *
 * Refuses text without a unified-diff header shape ({@link ContentKindError}).
 */
export class DiffPlanner implements Planner {
  readonly id = DIFF_PLANNER_ID;
  readonly #options: DiffPlannerOptions;

  constructor(options: DiffPlannerOptions = {}) {
    this.#options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return Promise.resolve(planDiff(input, this.#options));
  }
}

interface Line {
  readonly start: number;
  /** One past the last byte, excluding the newline. */
  readonly end: number;
  readonly text: string;
}

interface Hunk {
  readonly start: number;
  readonly end: number;
  /** The `@@ … @@` header, without any trailing function context. */
  readonly header: string;
  readonly text: string;
  /** The body lines after the header, for the window rule. */
  readonly lines: readonly Line[];
}

interface FileDiff {
  readonly start: number;
  readonly end: number;
  readonly path: string;
  readonly headerText: string;
  readonly hunks: readonly Hunk[];
}

/**
 * The synchronous core. Deterministic; every candidate priced through the input's
 * {@link MarkerPricing}. Byte offsets come straight off the UTF-8 line split, so no
 * conversion is needed.
 *
 * @throws {ContentKindError} when the text carries no unified-diff header.
 */
export function planDiff(input: PlanInput, options: DiffPlannerOptions = {}): ElisionPlan {
  const pricing = requirePricing(input);
  if (probeKind(input.text) !== 'diff') {
    throw new ContentKindError(
      `smelt: the diff planner was asked to plan text with no unified-diff header ` +
        `(a "diff --git" line, or "--- "/"+++ " lines followed by a hunk). It refuses ` +
        `rather than approximating — output labelled ${DIFF_PLANNER_ID} that was ` +
        `really line windows would be undetectable from outside. Use "lexical", or ` +
        `"auto" to pick by content.`,
    );
  }
  const files = parseFiles(splitLines(input.text));
  const caseSensitive = options.caseSensitive ?? false;
  const focus = (input.focus ?? []).filter((term) => term.length > 0);
  const needles = caseSensitive ? focus : focus.map((term) => term.toLowerCase());
  const matches = (text: string): boolean => {
    const haystack = caseSensitive ? text : text.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  };

  /** The file and hunk collapses — the same at every rung of the window ladder. */
  const fixed: PlannedElision[] = [];
  /** The hunks the focus reached, where the window rule runs. */
  const matched: { readonly file: FileDiff; readonly hunk: Hunk }[] = [];
  const push = (candidate: PlannedElision): void => {
    if (savingBytes(candidate, pricing) > 0) fixed.push(candidate);
  };

  const collapseFiles = (run: readonly FileDiff[]): void => {
    if (run.length === 0) return;
    const hunks = run.reduce((n, file) => n + file.hunks.length, 0);
    push({
      range: { start: run[0]!.start, end: run[run.length - 1]!.end },
      reason: {
        rule: FILE_COLLAPSE_RULE,
        explanation:
          `collapsed ${String(run.length)} ${run.length === 1 ? 'file' : 'files'} ` +
          `(${String(hunks)} ${hunks === 1 ? 'hunk' : 'hunks'})`,
      },
      names: run.map((file) => file.path),
    });
  };

  const collapseHunks = (file: FileDiff, run: readonly Hunk[]): void => {
    if (run.length === 0) return;
    push({
      range: { start: run[0]!.start, end: run[run.length - 1]!.end },
      reason: {
        rule: HUNK_COLLAPSE_RULE,
        explanation: `collapsed ${String(run.length)} ${run.length === 1 ? 'hunk' : 'hunks'} of ${file.path}`,
      },
      names: run.map((hunk) => hunk.header),
    });
  };

  let fileRun: FileDiff[] = [];
  for (const file of files) {
    const fileKept =
      needles.length === 0 ||
      matches(file.headerText) ||
      file.hunks.some((hunk) => matches(hunk.text));
    if (!fileKept) {
      fileRun.push(file);
      continue;
    }
    collapseFiles(fileRun);
    fileRun = [];
    let hunkRun: Hunk[] = [];
    for (const hunk of file.hunks) {
      if (needles.length > 0 && matches(hunk.text)) {
        collapseHunks(file, hunkRun);
        hunkRun = [];
        matched.push({ file, hunk });
      } else {
        hunkRun.push(hunk);
      }
    }
    collapseHunks(file, hunkRun);
  }
  collapseFiles(fileRun);

  // The window rule inside every matched hunk, tried with less context at each rung
  // until the plan fits — the lexical ladder, confined to hunks. The first rung that
  // fits wins; if none does, the tightest is returned over budget, as it came back.
  const inputBytes = Buffer.byteLength(input.text, 'utf8');
  const attempts = WINDOW_LADDER.map((context) => [
    ...fixed,
    ...matched.flatMap(({ file, hunk }) => windowsIn(file, hunk, context, matches, pricing)),
  ]);
  const elisions =
    attempts.find((plan) => predictOutputBytes(inputBytes, plan, pricing) <= input.budgetBytes) ??
    attempts[attempts.length - 1]!;

  return { planner: DIFF_PLANNER_ID, language: input.language, elisions };
}

/**
 * Inside one matched hunk: keep every line within `context` of a matching line, and
 * collapse each run of the rest that is at least {@link MIN_RUN_LINES} long and pays
 * for its marker. The header line is never part of a run — it is what makes the
 * survivor still read as a hunk.
 */
function windowsIn(
  file: FileDiff,
  hunk: Hunk,
  context: number,
  matches: (text: string) => boolean,
  pricing: MarkerPricing,
): readonly PlannedElision[] {
  const lines = hunk.lines;
  const keep: boolean[] = lines.map(() => false);
  for (let i = 0; i < lines.length; i += 1) {
    if (!matches(lines[i]!.text)) continue;
    for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j += 1) {
      keep[j] = true;
    }
  }
  const out: PlannedElision[] = [];
  let runStart = -1;
  const flush = (endExclusive: number): void => {
    if (runStart < 0) return;
    const count = endExclusive - runStart;
    const range = { start: lines[runStart]!.start, end: lines[endExclusive - 1]!.end };
    runStart = -1;
    if (count < MIN_RUN_LINES) return;
    const candidate: PlannedElision = {
      range,
      reason: {
        rule: HUNK_WINDOW_RULE,
        explanation: `collapsed ${String(count)} lines of a hunk of ${file.path}`,
      },
    };
    if (savingBytes(candidate, pricing) > 0) out.push(candidate);
  };
  for (let i = 0; i < lines.length; i += 1) {
    if (keep[i] === true) flush(i);
    else if (runStart < 0) runStart = i;
  }
  flush(lines.length);
  return out;
}

function requirePricing(input: PlanInput): MarkerPricing {
  const pricing: MarkerPricing | undefined = input.pricing;
  if (pricing === undefined) throw new MissingMarkerPricingError(DIFF_PLANNER_ID);
  return pricing;
}

function splitLines(text: string): readonly Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (const content of text.split('\n')) {
    const end = start + Buffer.byteLength(content, 'utf8');
    lines.push({ start, end, text: content });
    start = end + 1;
  }
  return lines;
}

/** True where a file starts: a `diff --git` line, or a `---` line followed by `+++`. */
function startsFile(lines: readonly Line[], i: number): boolean {
  const line = lines[i]!.text;
  if (line.startsWith('diff --git ')) return true;
  return (
    line.startsWith('--- ') &&
    lines[i + 1]?.text.startsWith('+++ ') === true &&
    !(i > 0 && lines[i - 1]!.text.startsWith('diff --git '))
  );
}

function parseFiles(lines: readonly Line[]): readonly FileDiff[] {
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (startsFile(lines, i)) {
      // A `---` line directly under a `diff --git` line belongs to that file's header.
      if (lines[i]!.text.startsWith('--- ') && starts.at(-1) !== undefined) {
        const previous = starts.at(-1)!;
        const between = lines.slice(previous, i).map((line) => line.text);
        if (
          between[0]?.startsWith('diff --git ') === true &&
          !between.some((l) => l.startsWith('@@ '))
        )
          continue;
      }
      starts.push(i);
    }
  }
  return starts.map((from, index) => {
    const to = index + 1 < starts.length ? starts[index + 1]! : lastContentLine(lines) + 1;
    const fileLines = lines.slice(from, to);
    const firstHunk = fileLines.findIndex((line) => line.text.startsWith('@@ '));
    const headerLines = firstHunk === -1 ? fileLines : fileLines.slice(0, firstHunk);
    const hunks: Hunk[] = [];
    if (firstHunk !== -1) {
      let hunkStart = firstHunk;
      for (let i = firstHunk + 1; i <= fileLines.length; i += 1) {
        if (i === fileLines.length || fileLines[i]!.text.startsWith('@@ ')) {
          const body = fileLines.slice(hunkStart, i);
          hunks.push({
            start: body[0]!.start,
            end: body[body.length - 1]!.end,
            header: hunkHeader(body[0]!.text),
            text: body.map((line) => line.text).join('\n'),
            lines: body.slice(1),
          });
          hunkStart = i;
        }
      }
    }
    return {
      start: fileLines[0]!.start,
      end: fileLines[fileLines.length - 1]!.end,
      path: pathOf(headerLines.map((line) => line.text)),
      headerText: headerLines.map((line) => line.text).join('\n'),
      hunks,
    };
  });
}

/** The index of the last line with content, so a trailing newline is never claimed. */
function lastContentLine(lines: readonly Line[]): number {
  let i = lines.length - 1;
  while (i > 0 && lines[i]!.text === '') i -= 1;
  return i;
}

function hunkHeader(line: string): string {
  const close = line.indexOf('@@', 2);
  return close === -1 ? line : line.slice(0, close + 2);
}

/** The path a file header names: the `+++` side first, else the `diff --git` b-side. */
function pathOf(header: readonly string[]): string {
  const plus = header.find((line) => line.startsWith('+++ '));
  if (plus !== undefined && plus !== '+++ /dev/null') return stripPrefix(plus.slice(4));
  const minus = header.find((line) => line.startsWith('--- '));
  if (minus !== undefined && minus !== '--- /dev/null') return stripPrefix(minus.slice(4));
  const git = header.find((line) => line.startsWith('diff --git '));
  if (git !== undefined) {
    const parts = git.slice('diff --git '.length).split(' b/');
    return parts[parts.length - 1] ?? git;
  }
  return '<unknown>';
}

function stripPrefix(path: string): string {
  const trimmed = path.split('\t')[0]!;
  return trimmed.startsWith('a/') || trimmed.startsWith('b/') ? trimmed.slice(2) : trimmed;
}
