import { ContentKindError, MissingMarkerPricingError } from '../errors.ts';
import type { ElisionPlan, MarkerPricing, PlanInput, PlannedElision, Planner } from '../types.ts';

import { savingBytes } from './budget.ts';
import { probeKind } from './kind.ts';
import { utf8OffsetIndex } from './offsets.ts';

export const JSON_PLANNER_ID = 'json/v1';

/** The one rule this planner has. */
export const MEMBER_COLLAPSE_RULE = 'member-collapse';

export interface JsonPlannerOptions {
  /** Focus matching is substring, case-insensitive by default. */
  readonly caseSensitive?: boolean;
}

/**
 * The JSON planner: **members are the units, not lines.**
 *
 * A pretty-printed tool result — a test report, an API response, a bench log — puts
 * its biggest values on single lines, and a line planner cannot cut a line. This one
 * scans the document once with positions, so each object member (`"key": value`) and
 * array element is a unit with a byte range, and collapses runs of sibling units the
 * focus does not touch — exactly the structural planner's move, with members for
 * declarations. A matched container is descended into, so the cut lands as deep as
 * the focus reaches; with no focus the root's members are kept as a skeleton and each
 * container beneath collapses to one marker whose outline names its keys.
 *
 * It refuses text that is not JSON ({@link ContentKindError}) rather than
 * approximating — the structural planner's rule, for the same reason.
 */
export class JsonPlanner implements Planner {
  readonly id = JSON_PLANNER_ID;
  readonly #options: JsonPlannerOptions;

  constructor(options: JsonPlannerOptions = {}) {
    this.#options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return Promise.resolve(planJson(input, this.#options));
  }
}

/** One member or element: where it sits, what to call it, and what it contains. */
interface Unit {
  readonly start: number;
  readonly end: number;
  /** The object key, or `[index]` for an array element. */
  readonly label: string;
  /** The members inside, when the value is an object or array. */
  readonly children?: readonly Unit[];
}

/**
 * The synchronous core, exported like {@link planLexical}. Deterministic; every
 * candidate is priced through the input's {@link MarkerPricing}, never estimated.
 *
 * @throws {ContentKindError} when the text does not parse as a JSON object or array.
 */
export function planJson(input: PlanInput, options: JsonPlannerOptions = {}): ElisionPlan {
  const pricing = requirePricing(input);
  if (probeKind(input.text) !== 'json') {
    throw new ContentKindError(
      `smelt: the json planner was asked to plan text that does not parse as a JSON ` +
        `object or array. It refuses rather than approximating — output labelled ` +
        `${JSON_PLANNER_ID} that was really line windows would be undetectable from ` +
        `outside. Use "lexical", or "auto" to pick by content.`,
    );
  }
  const root = scanValue(input.text, skipWs(input.text, 0));
  const units = root.children ?? [];
  const boundaries = [...flatten(units)].flatMap((unit) => [unit.start, unit.end]);
  const toByte = utf8OffsetIndex(input.text, boundaries);
  const caseSensitive = options.caseSensitive ?? false;
  const focus = (input.focus ?? []).filter((term) => term.length > 0);
  const needles = caseSensitive ? focus : focus.map((term) => term.toLowerCase());

  const matches = (unit: Unit): boolean => {
    const raw = input.text.slice(unit.start, unit.end);
    const haystack = caseSensitive ? raw : raw.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  };

  const elisions: PlannedElision[] = [];
  const collapse = (run: readonly Unit[]): void => {
    if (run.length === 0) return;
    const candidate: PlannedElision = {
      range: { start: toByte.get(run[0]!.start)!, end: toByte.get(run[run.length - 1]!.end)! },
      reason: {
        rule: MEMBER_COLLAPSE_RULE,
        explanation: `collapsed ${String(run.length)} sibling ${run.length === 1 ? 'member' : 'members'}`,
      },
      names: run.map((unit) => unit.label),
    };
    if (savingBytes(candidate, pricing) > 0) elisions.push(candidate);
  };

  const walk = (siblings: readonly Unit[], depth: number): void => {
    let run: Unit[] = [];
    for (const unit of siblings) {
      // With a focus, a unit survives when its bytes carry a term; with none, the root
      // is kept as a skeleton and everything beneath it is fair game.
      const kept = needles.length > 0 ? matches(unit) : depth === 0;
      if (!kept) {
        run.push(unit);
        continue;
      }
      collapse(run);
      run = [];
      if (unit.children !== undefined) walk(unit.children, depth + 1);
    }
    collapse(run);
  };
  walk(units, 0);

  return { planner: JSON_PLANNER_ID, language: input.language, elisions };
}

function* flatten(units: readonly Unit[]): Generator<Unit> {
  for (const unit of units) {
    yield unit;
    if (unit.children !== undefined) yield* flatten(unit.children);
  }
}

function requirePricing(input: PlanInput): MarkerPricing {
  const pricing: MarkerPricing | undefined = input.pricing;
  if (pricing === undefined) throw new MissingMarkerPricingError(JSON_PLANNER_ID);
  return pricing;
}

/* ------------------------------------------------------------------------------------
 * A positional scan of already-validated JSON: `probeKind` proved `JSON.parse` accepts
 * the text, so this only has to find where each value starts and ends.
 * ---------------------------------------------------------------------------------- */

interface Scanned {
  readonly end: number;
  readonly children?: readonly Unit[];
}

function skipWs(text: string, i: number): number {
  let j = i;
  while (j < text.length && ' \t\n\r'.includes(text[j]!)) j += 1;
  return j;
}

function scanValue(text: string, i: number): Scanned {
  const ch = text[i];
  if (ch === '{') return scanObject(text, i);
  if (ch === '[') return scanArray(text, i);
  if (ch === '"') return { end: scanString(text, i) };
  let j = i;
  while (j < text.length && !',]} \t\n\r'.includes(text[j]!)) j += 1;
  return { end: j };
}

function scanString(text: string, i: number): number {
  let j = i + 1;
  while (j < text.length) {
    const ch = text[j]!;
    if (ch === '\\') {
      j += 2;
      continue;
    }
    if (ch === '"') return j + 1;
    j += 1;
  }
  return j;
}

function scanObject(text: string, open: number): Scanned {
  const children: Unit[] = [];
  let i = skipWs(text, open + 1);
  while (i < text.length && text[i] !== '}') {
    const keyStart = i;
    const keyEnd = scanString(text, i);
    const label = JSON.parse(text.slice(keyStart, keyEnd)) as string;
    i = skipWs(text, keyEnd);
    i = skipWs(text, i + 1); // ':'
    const value = scanValue(text, i);
    children.push({
      start: keyStart,
      end: value.end,
      label,
      ...(value.children === undefined ? {} : { children: value.children }),
    });
    i = skipWs(text, value.end);
    if (text[i] === ',') i = skipWs(text, i + 1);
  }
  return { end: i + 1, children };
}

function scanArray(text: string, open: number): Scanned {
  const children: Unit[] = [];
  let i = skipWs(text, open + 1);
  let index = 0;
  while (i < text.length && text[i] !== ']') {
    const value = scanValue(text, i);
    children.push({
      start: i,
      end: value.end,
      label: `[${String(index)}]`,
      ...(value.children === undefined ? {} : { children: value.children }),
    });
    index += 1;
    i = skipWs(text, value.end);
    if (text[i] === ',') i = skipWs(text, i + 1);
  }
  return { end: i + 1, children };
}
