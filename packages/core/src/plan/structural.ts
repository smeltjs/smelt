import { Parser } from 'web-tree-sitter';
import type { Node, Tree } from 'web-tree-sitter';

import { GrammarUnavailableError, MissingMarkerPricingError } from '../errors.ts';
import type { LanguageStructure } from '../lang/profile.ts';
import { profileFor, structuralLanguages } from '../lang/registry.ts';
import type {
  ElisionPlan,
  LanguageId,
  MarkerPricing,
  PlanInput,
  PlannedElision,
  Planner,
} from '../types.ts';

import { predictOutputBytes, savingBytes } from './budget.ts';
import { loadGrammar } from './grammar.ts';
import { utf8OffsetIndex } from './offsets.ts';

export const STRUCTURAL_PLANNER_ID = 'structural/v1';

/**
 * The languages this planner actually parses — a derived view of the registry: every
 * {@link LanguageProfile} that carries a `structure` section, in registry order. A
 * language appears here only once its node kinds are mapped in its profile
 * (`src/lang/<id>.ts`), because claiming a language before that would produce markers
 * that mislabel what they collapsed.
 *
 * Exported for the totality guard (`test/guards/structural-totality.test.ts`): every
 * language named here must have a fixture, a snapshot and a doc-comment case, so a
 * language cannot be claimed without tests.
 */
export const STRUCTURAL_LANGUAGES: readonly LanguageId[] = structuralLanguages();

/**
 * Historically the union of the claimed ids; every `LanguageId` carries a profile
 * now, so the compile-time totality this type enforced lives on the registry
 * (`Record<LanguageId, LanguageProfile>`) instead.
 */
export type StructuralLanguage = LanguageId;

/**
 * Every elision this planner produces carries this rule id, and the profitability
 * check below prices the marker that rule would earn — so the two must not drift.
 */
const SIBLING_COLLAPSE_RULE = 'sibling-collapse';

/**
 * The rule id every cut the budget rung mints carries, instead of
 * {@link SIBLING_COLLAPSE_RULE}. The rung is an over-budget escalation — it trades a
 * maximal run's better explanation for a smaller, uglier cut only because the plan
 * would otherwise stay over budget — and a plan that made that trade under the same
 * rule id as an ordinary profitable cut would have silently changed its own rules: the
 * report, the `--json` envelope and the per-rule ledger (`ElisionReason.rule` is their
 * shared key, per `CONTEXT.md`) would show one more `sibling-collapse` row with no way
 * to tell it apart from a first-pass cut. A distinct id is the label, in the one
 * currency every consumer of a plan already reads.
 */
const SIBLING_COLLAPSE_PRESSURE_RULE = 'sibling-collapse-pressure';

export interface StructuralPlannerOptions {
  /**
   * Never collapse a sibling group smaller than this. Defaults to 1 — the byte
   * profitability check already refuses collapses that would not pay for their marker.
   */
  readonly minSiblings?: number;
  /** Focus matching is substring, case-insensitive by default — same as lexical. */
  readonly caseSensitive?: boolean;
}

/**
 * One top-level declaration, together with the doc comment attached to it. The unit is
 * the atom of every decision here: a unit is kept whole or collapsed whole, which is
 * what makes "a kept declaration keeps its signature line and attached doc comment"
 * true by construction rather than by patching ranges afterwards.
 *
 * All positions are UTF-16 code-unit indices (what web-tree-sitter reports for a JS
 * string); they are converted to UTF-8 byte offsets in one place, at the end.
 */
interface Unit {
  /** Start of the unit — the first attached comment or attribute if there is one. */
  readonly start: number;
  /** End of the declaration node. */
  readonly end: number;
  /** Human word for the declaration's kind, e.g. `'function'`. */
  readonly kind: string;
  /** The declaration's own name, read off the tree — `'parseConfig'` — when it has one. */
  readonly name?: string;
  /**
   * A unit the planner must never collapse, matched or not. Every pin follows one
   * law: collapsing it would silently change what the survivor *is*, not what it
   * contains. Go's `//go:build` constraint governs which builds see the whole file;
   * shebang lines (bash, ruby, python as comments; javascript, typescript, tsx,
   * kotlin and swift as their grammars' own shebang nodes) and ruby's
   * `# frozen_string_literal:` magic comment govern how the file is executed at all;
   * php's `<?php` open tag is what makes the rest of the file php; and c/c++'s
   * `#pragma once` governs what including the file means.
   */
  readonly pinned?: boolean;
}

/**
 * The structural planner — the reason smelt exists.
 *
 * It parses with the language's tree-sitter grammar, finds the top-level declarations
 * whose text matches the caller's focus, keeps each match whole — signature line,
 * attached doc comment, body — and collapses each contiguous run of non-matching
 * *siblings* into one marker that names them from the parse tree: `collapsed 3 sibling
 * functions`. Structure is what makes that explanation possible; a line window can only
 * ever say "collapsed 40 lines".
 *
 * It throws {@link GrammarUnavailableError} rather than falling back to the lexical
 * planner, and that is the deliberate part. A silent fallback would mean a caller who
 * asked for structural planning, and whose grammar failed to load, gets line-window
 * output labelled `structural/v1` — plausible, wrong, and undetectable from the
 * outside. A caller who wants the fallback asks for it, by planning lexically itself.
 *
 * **Non-goal: one level deep.** {@link unitsOf} groups only the parse tree's *root*
 * children — a file's top-level functions, classes, and the rest. A class's own
 * methods are never separately matched or collapsed; the whole class body is one
 * opaque unit that is either kept in full (any method's text matches the focus, or the
 * class is small enough that collapsing it costs more than it saves) or collapsed
 * whole into the run around it. One very large class with one matching method — and no
 * other top-level declarations near it to collapse instead — gets no elision at all,
 * because there is nothing at the root level *to* collapse. Recursing into class
 * bodies for a second, nested collapse pass was considered and set aside: it would
 * double the shapes every consumer of a plan (the outline, the budget rung, the
 * per-rule ledger) has to reason about, for a case the lexical planner already
 * handles reasonably — a focus window still finds the matching method and prunes the
 * rest of a large class by *lines*, just without a per-method name in the marker.
 * `--strategy auto` does not route around this; a caller who hits it can ask for
 * `--strategy lexical` on that file. `test/guards/structural.test.ts` pins this as
 * the stated behaviour (`'does not descend into a class body — a stated non-goal'`),
 * not a bug: a fixture with one huge class produces no method-level collapse, on
 * purpose, and a change here is a design decision, not a fix.
 */
export class StructuralPlanner implements Planner {
  readonly id = STRUCTURAL_PLANNER_ID;
  readonly options: StructuralPlannerOptions;

  constructor(options: StructuralPlannerOptions = {}) {
    this.options = options;
  }

  plan(input: PlanInput): Promise<ElisionPlan> {
    return planStructural(input, this.options);
  }
}

/**
 * The planner as a function, exported like {@link planLexical} so it can be tested and
 * reused directly. Deterministic: same text, same language, same focus, same options —
 * byte-identical plan.
 *
 * `budgetBytes` is a target, not a guarantee. The plan is built in two passes: every
 * maximal run of non-matching siblings is collapsed where that pays for its marker,
 * and then — only if the plan is still over budget — each run the first pass refused
 * is re-asked as its own best profitable sub-run (the budget rung, in
 * {@link planFromTree}). Under the last of those there is nothing left to cut except
 * the declarations the caller asked to keep, and an optimizer that silently drops the
 * thing you searched for is the exact failure this design refuses. Callers who need a
 * hard ceiling check `outputBytes` and decide.
 *
 * @throws {GrammarUnavailableError} when the language is not one this planner parses,
 *   when the grammar cannot be loaded, or when the parser produces no tree. Never a
 *   lexical fallback.
 */
export async function planStructural(
  input: PlanInput,
  options: StructuralPlannerOptions = {},
): Promise<ElisionPlan> {
  const language = assertStructuralLanguage(input.language);
  // The runtime backstop for JS callers: TypeScript makes `pricing` required, but a
  // JS caller can omit it, and the honest answer is a named refusal rather than the
  // planner quietly pricing markers itself — the inversion the seam removed.
  const pricing: MarkerPricing | undefined = input.pricing;
  if (pricing === undefined) throw new MissingMarkerPricingError(STRUCTURAL_PLANNER_ID);
  const grammar = await loadGrammar(language);

  const parser = new Parser();
  let tree: Tree | null = null;
  try {
    parser.setLanguage(grammar);
    tree = parser.parse(input.text);
    if (tree === null) {
      throw new GrammarUnavailableError(
        `smelt: the ${language} parser returned no tree. Structural planning cannot ` +
          `proceed, and it does not fall back to lexical — a caller who wants the ` +
          `fallback plans lexically itself.`,
      );
    }
    return {
      planner: STRUCTURAL_PLANNER_ID,
      language: input.language,
      elisions: planFromTree(tree, input, options, language),
    };
  } finally {
    tree?.delete();
    parser.delete();
  }
}

function assertStructuralLanguage(language: PlanInput['language']): StructuralLanguage {
  if (isStructuralLanguage(language)) return language;
  const named = `${STRUCTURAL_LANGUAGES.slice(0, -1).join(', ')} and ${
    STRUCTURAL_LANGUAGES[STRUCTURAL_LANGUAGES.length - 1]
  }`;
  throw new GrammarUnavailableError(
    `smelt: structural planning covers ${named} in this ` +
      `slice; got "${language}". It does not fall back to the lexical planner — output ` +
      `labelled structural/v1 that is really line windows would be undetectable from ` +
      `the outside. Use \`strategy: 'auto'\` for a mixed stream that is sometimes not ` +
      `code — it picks the planner from the language and labels the one it ran — or ` +
      `the lexical planner explicitly if that is what you want.`,
  );
}

/**
 * Whether this planner has a bundled grammar for the language — the one membership
 * test, shared with the `auto` strategy (`plan/auto.ts`).
 *
 * The refusal above and auto's selection are the same question asked for opposite
 * reasons, and two spellings of it would be two answers: a language auto routed to
 * `structural` that `assertStructuralLanguage` then refused would be a
 * `GrammarUnavailableError` raised by the strategy whose entire job is not raising
 * one.
 */
export function isStructuralLanguage(
  language: PlanInput['language'],
): language is StructuralLanguage {
  for (const supported of STRUCTURAL_LANGUAGES) {
    if (language === supported) return true;
  }
  return false;
}

function planFromTree(
  tree: Tree,
  input: PlanInput,
  options: StructuralPlannerOptions,
  language: StructuralLanguage,
): readonly PlannedElision[] {
  const profile = profileFor(language);
  // assertStructuralLanguage admits only languages whose profile carries a
  // `structure` section — that is the definition of a structural language — so the
  // assertion states a fact the seam already proved.
  const structure = profile.structure!;
  const pricing = input.pricing;
  // The marker lands as a line comment in every structural language (the profile's
  // markerLeader), and a line comment comments out everything to the end of its
  // line — so a collapse is only legal where nothing kept follows on the marker's
  // own line. See the flush below.
  const markerIsLineComment = profile.markerLeader !== undefined;
  const units = unitsOf(tree.rootNode, input.text, structure);
  const matched = matchUnits(units, input, options);
  const minSiblings = options.minSiblings ?? 1;
  const toByte = utf8OffsetIndex(
    input.text,
    units.flatMap((unit) => [unit.start, unit.end]),
  );

  /**
   * One contiguous group of siblings as an elision — or nothing, when collapsing it
   * would be illegal or would not pay for its marker. Every cut in this planner,
   * first pass and budget rung alike, is minted here: one legality rule, one price,
   * one explanation, so the rung cannot cut something the first pass would refuse.
   *
   * `rule` defaults to the first pass's id; the budget rung (below) passes
   * {@link SIBLING_COLLAPSE_PRESSURE_RULE} instead, so the one thing that changes
   * between an ordinary cut and an over-budget escalation is stated on the elision
   * itself, never inferred from which pass happened to run.
   */
  const collapse = (
    group: readonly Unit[],
    rule: string = SIBLING_COLLAPSE_RULE,
  ): PlannedElision | undefined => {
    if (group.length === 0 || group.length < minSiblings) return undefined;
    // A line-comment marker swallows the rest of its line. When the group's last unit
    // ends mid-line — python's `stmt_a(); stmt_b()` puts two top-level statements on
    // one line — the marker's `# ` leader would comment out the *kept* code after it.
    // Refusing the collapse is the honest move; extending the range would elide code
    // no unit accounted for.
    if (markerIsLineComment && !restOfLineIsBlank(input.text, group[group.length - 1]!.end)) {
      return undefined;
    }
    const start = toByte.get(group[0]!.start)!;
    const end = toByte.get(group[group.length - 1]!.end)!;
    // The outline: every named unit in the run, in source order. Out of band — the
    // marker below is priced and rendered from `reason` alone, so attaching names
    // moves no byte of the wire surface. Absent rather than empty when nothing in the
    // run has a name (a run of comments, or unparsed regions).
    const names = group.flatMap((unit) => (unit.name === undefined ? [] : [unit.name]));
    const candidate: PlannedElision = {
      range: { start, end },
      reason: { rule, explanation: explain(group) },
      ...(names.length === 0 ? {} : { names }),
    };
    // Profitability, priced rather than estimated: ask the MarkerPricing seam for the
    // exact cost of the marker this cut would earn — the explanation's length varies
    // with kind diversity, and the pricing carries the language's comment leader (or a
    // caller's custom builder), so a fixed estimate can pass a cut whose marker is
    // bigger than what it removes, and a marker that costs more than it removes grows
    // the output.
    return savingBytes(candidate, pricing) > 0 ? candidate : undefined;
  };

  /**
   * The UTF-8 bytes a sub-run `[from, to)` spans — read off the same offset index
   * `collapse` mints ranges from, so it is the exact upper bound on what collapsing
   * that sub-run could save, in O(1) and without slicing. The budget rung's span
   * bound depends on it being both exact and cheap.
   */
  const spanBytes = (group: readonly Unit[], from: number, to: number): number =>
    toByte.get(group[to - 1]!.end)! - toByte.get(group[from]!.start)!;

  // The first pass: every maximal run of siblings no focus term matched and no rule
  // pinned, collapsed whole. A run that earns no cut is remembered, not forgotten —
  // the budget rung below is the only reader of that list.
  const elisions: PlannedElision[] = [];
  const refused: (readonly Unit[])[] = [];
  for (const group of maximalRuns(units, matched)) {
    const cut = collapse(group);
    if (cut === undefined) refused.push(group);
    else elisions.push(cut);
  }

  // THE BUDGET RUNG — the structural answer to the lexical planner's context ladder.
  //
  // Until this existed, `planStructural` never read `input.budgetBytes` at all: it
  // took every profitable maximal run and stopped, which is right until the plan
  // comes back over budget with a profitable cut still on the table. The review's
  // case: 158 bytes, a budget of 120, and a run of three sibling classes worth 92
  // bytes left whole — because the *maximal* run also swallowed a `VERSION = 1`
  // statement above them, and a mixed-kind explanation ("1 statement, 3 classes")
  // priced a 106-byte marker against a 105-byte cut. The planner returned over budget
  // having elided nothing, while the three classes alone priced an 82-byte marker
  // against 92 bytes — a real saving of 10 bytes nobody was offered.
  //
  // So, and only when the plan is still over budget, each refused run is re-asked as
  // its own best profitable sub-run, earliest run first, stopping the moment the plan
  // fits. Four properties hold by construction rather than by care:
  //
  //   - **A focus match is never cut.** A matched unit is not in any run, so no
  //     sub-run of any run can contain one. Same for a pinned unit.
  //   - **The output never grows.** Every candidate goes through `collapse`, which
  //     mints nothing whose marker is not strictly cheaper than the bytes it removes.
  //   - **It stays deterministic.** Sub-runs are enumerated start-ascending and
  //     length-descending, and a tie in saving keeps the one already held — the
  //     earliest start, then the longest. Both of the rung's bounds read that same
  //     order, so a bounded sweep and an exhaustive one answer alike.
  //   - **It stays bounded.** A refused run can be the whole file — the mid-line
  //     refusal is about one character, not about size — so the sweep stops at the
  //     first cut that fits the budget and skips every candidate whose span already
  //     proves it cannot win. See {@link bestSubRun}.
  //   - **It says so.** Every cut this loop mints carries
  //     `SIBLING_COLLAPSE_PRESSURE_RULE`, not the first pass's plain
  //     `sibling-collapse` — the report's rule column, the `--json` envelope and the
  //     per-rule ledger all key off `ElisionReason.rule`, so a caller reading any of
  //     them can tell an over-budget escalation from an ordinary profitable cut
  //     without re-deriving which pass happened to run. A plan that made this trade
  //     under the ordinary rule id would have changed its own rules silently — the
  //     failure this repository's guards exist to catch.
  //
  // Budget pressure is the trigger, not profitability, because a maximal run is the
  // better *explanation*: one marker naming everything it hid beats two naming halves
  // of it. Trading that away is worth it to fit a budget and not worth it otherwise.
  const inputBytes = Buffer.byteLength(input.text, 'utf8');
  for (const group of refused) {
    const currentBytes = predictOutputBytes(inputBytes, elisions, pricing);
    if (currentBytes <= input.budgetBytes) break;
    // What this run would have to save to land the plan under budget — the sweep's
    // stopping condition, so a run that can fit the budget is priced a handful of
    // times instead of exhaustively. See {@link bestSubRun}.
    const enough = currentBytes - input.budgetBytes;
    // Every cut the rung mints carries SIBLING_COLLAPSE_PRESSURE_RULE, never the first
    // pass's plain id — the escalation stated on the elision itself, not just implied
    // by which loop happened to produce it. See the constant's doc comment.
    const cut = bestSubRun(
      group,
      (candidate) => collapse(candidate, SIBLING_COLLAPSE_PRESSURE_RULE),
      pricing,
      spanBytes,
      enough,
    );
    if (cut !== undefined) elisions.push(cut);
  }

  return elisions.toSorted((a, b) => a.range.start - b.range.start);
}

/**
 * The runs the first pass collapses: every maximal contiguous group of units that no
 * focus term matched and no rule pinned. A matched or pinned unit ends the run before
 * it and starts none — which is what makes "never cut a focus-matched declaration" a
 * property of the *shape* of the data rather than a check anyone has to remember.
 */
function maximalRuns(
  units: readonly Unit[],
  matched: readonly boolean[],
): readonly (readonly Unit[])[] {
  const runs: Unit[][] = [];
  let run: Unit[] = [];
  for (let i = 0; i < units.length; i += 1) {
    if (matched[i] === true || units[i]!.pinned === true) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else {
      run.push(units[i]!);
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/**
 * The best cut available inside one refused run: the contiguous sub-run whose real
 * marker is cheapest against the bytes it removes.
 *
 * The enumeration is bounded, and it has to be. A run reaches here refused for any of
 * three reasons, and only one of them is "it lost to a ~100-byte marker": a run is also
 * refused when it holds fewer than `minSiblings` units, and — the one that bites —
 * when its last unit ends mid-line, because a line-comment marker would swallow the
 * kept code after it. That last rule is a property of one character in the file, not of
 * the run's size, so a *whole-file* run can land here: one bash script whose last line
 * is `cleanup_tmp; deploy_release --now` refuses its only maximal run, and an
 * unbounded `(from, to)` sweep over its thousands of units — each candidate slicing,
 * explaining and pricing — is cubic. Measured, before this bound: 19.5 KB / 373 ms,
 * 39 KB / 2.3 s, 79 KB / 17.2 s, 159 KB / 131 s. That is a CPU loop on tool-controlled
 * input, on the path the caller takes precisely when it is over budget — the normal
 * case. Two bounds, neither of which changes which cut a bounded sweep would have
 * found by exhaustion:
 *
 *   - **`enough`** — the saving that lands the plan under budget. The rung exists to
 *     fit a budget; the first candidate that does is the answer, and enumeration order
 *     (start-ascending, length-descending) makes it the earliest, longest such cut.
 *     This is what turns the whole-file case into two priced candidates.
 *   - **The span bound** — a cut can never save more than the bytes it spans, so once
 *     a candidate's span has shrunk to `bestSaving` or below, neither it nor any
 *     shorter candidate from the same start can win, and once the *longest* candidate
 *     from a start is that small, no later start can win either. Spans shrink
 *     monotonically along both loops, so both breaks are exact, not heuristic: they
 *     skip only candidates already proven to lose.
 */
function bestSubRun(
  group: readonly Unit[],
  collapse: (group: readonly Unit[]) => PlannedElision | undefined,
  pricing: MarkerPricing,
  spanBytes: (group: readonly Unit[], from: number, to: number) => number,
  enough: number,
): PlannedElision | undefined {
  let best: PlannedElision | undefined;
  let bestSaving = 0;
  for (let from = 0; from < group.length; from += 1) {
    if (spanBytes(group, from, group.length) <= bestSaving) break;
    for (let to = group.length; to > from; to -= 1) {
      if (spanBytes(group, from, to) <= bestSaving) break;
      const candidate = collapse(group.slice(from, to));
      if (candidate === undefined) continue;
      const saving = savingBytes(candidate, pricing);
      if (saving > bestSaving) {
        best = candidate;
        bestSaving = saving;
        if (saving >= enough) return best;
      }
    }
  }
  return best;
}

/** True when nothing but whitespace follows `index` on its own line. */
function restOfLineIsBlank(text: string, index: number): boolean {
  for (let i = index; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\n') return true;
    if (!/\s/.test(ch)) return false;
  }
  return true;
}

/**
 * Group the root's named children into units: each declaration plus the comment block
 * — and, in rust, the outer attributes — attached to it. A comment attaches when only
 * blank-free whitespace separates it from what follows — one newline at most — so a doc
 * comment travels with its declaration, while a comment left floating above a blank
 * line stands alone.
 *
 * **`root` only, one level, deliberately.** This function is never called on anything
 * but `tree.rootNode` — a class or object body one level down is never re-grouped
 * into units of its own, so its methods are never individually matched or collapsed.
 * See the "Non-goal" paragraph on {@link StructuralPlanner} for why, and
 * `test/guards/structural.test.ts` for the fixture that pins it.
 *
 * Attributes attach *unconditionally*: tree-sitter-rust parses `#[inline]` as a
 * top-level sibling of the item it decorates, but the language's own rule is that an
 * outer attribute modifies the next item, blank lines or not. So once an attribute is
 * pending, the whole pending prefix (doc comments included) rides forward to the next
 * declaration — treating it as its own unit would let a collapse strip `#[derive(…)]`
 * and the doc comment above it off a kept declaration.
 */
function unitsOf(root: Node, text: string, structure: LanguageStructure): readonly Unit[] {
  const units: Unit[] = [];
  /** Comments and attributes waiting to attach to the next declaration. */
  let pending: Node[] = [];
  /** Once true, blank lines no longer detach the pending prefix — see above. */
  let pendingHasAttribute = false;

  const flushPending = (): void => {
    if (pending.length === 0) return;
    units.push({
      start: pending[0]!.startIndex,
      end: pending[pending.length - 1]!.endIndex,
      kind: pendingHasAttribute ? 'attribute' : 'comment',
      pinned: !pendingHasAttribute && pending.some((node) => pinnedComment(node, text, structure)),
    });
    pending = [];
    pendingHasAttribute = false;
  };

  for (const child of root.namedChildren) {
    if (child === null) continue;
    if (structure.ridesBackwardTypes?.has(child.type) === true && units.length > 0) {
      // A node that is grammatically part of the *previous* statement, parsed as a
      // top-level sibling: tree-sitter-ruby emits a heredoc's body as a sibling of
      // the statement holding its `<<~SQL` opener. Splitting them lets a collapse
      // keep the opener and cut the body — an unterminated heredoc that swallows
      // every kept declaration after it, without a single ERROR node to show for
      // it. The body extends the preceding unit instead, so opener and body are
      // kept whole or collapsed whole, always.
      flushPending();
      const last = units[units.length - 1]!;
      units[units.length - 1] = { ...last, end: child.endIndex };
      continue;
    }
    if (
      structure.pinnedTypes?.has(child.type) === true ||
      pinnedDirective(child, text, structure)
    ) {
      // A pinned node (php's `<?php` tag, a `#!` shebang line, c's `#pragma once`)
      // is its own uncollapsible unit — nothing attaches to it, and no run may
      // swallow it.
      flushPending();
      units.push({
        start: child.startIndex,
        end: child.endIndex,
        kind: kindOf(child, structure),
        pinned: true,
      });
      continue;
    }
    const isComment = structure.commentTypes.has(child.type);
    const isAttribute = structure.attributeTypes.has(child.type);
    if (isComment || isAttribute) {
      if (
        pending.length > 0 &&
        !pendingHasAttribute &&
        !adjacent(text, pending[pending.length - 1]!.endIndex, child.startIndex)
      ) {
        flushPending();
      }
      pending.push(child);
      pendingHasAttribute ||= isAttribute;
      continue;
    }

    // tree-sitter-kotlin extends the import_list node over a doc comment that
    // follows it, so the KDoc of the first documented declaration after the imports
    // would be collapsed *with the imports* — a kept declaration losing its attached
    // doc comment. Split such trailing comments off: the unit ends at its last
    // non-comment token, and the comments ride forward like any other pending block.
    const { end: childEnd, trailing } =
      structure.trailingCommentSplitTypes?.has(child.type) === true
        ? splitTrailingComments(child, structure)
        : { end: child.endIndex, trailing: [] };

    const attached =
      pending.length > 0 &&
      (pendingHasAttribute ||
        adjacent(text, pending[pending.length - 1]!.endIndex, child.startIndex));
    if (attached && pending.some((node) => pinnedComment(node, text, structure))) {
      // A pinned comment (`//go:build`) governs the file, not the declaration it
      // happens to touch — keep it a standalone, uncollapsible unit either way.
      flushPending();
      units.push({
        start: child.startIndex,
        end: childEnd,
        kind: kindOf(child, structure),
        ...outlineName(child, structure, kindOf(child, structure)),
      });
    } else if (attached) {
      units.push({
        start: pending[0]!.startIndex,
        end: childEnd,
        kind: kindOf(child, structure),
        ...outlineName(child, structure, kindOf(child, structure)),
      });
      pending = [];
      pendingHasAttribute = false;
    } else {
      flushPending();
      units.push({
        start: child.startIndex,
        end: childEnd,
        kind: kindOf(child, structure),
        ...outlineName(child, structure, kindOf(child, structure)),
      });
    }
    for (const comment of trailing) pending.push(comment);
  }
  flushPending();
  return units;
}

/** Whether this comment node is one the language pins to the file. See {@link Unit}. */
function pinnedComment(node: Node, text: string, structure: LanguageStructure): boolean {
  if (structure.pinnedCommentPattern === undefined) return false;
  if (!structure.commentTypes.has(node.type)) return false;
  return structure.pinnedCommentPattern.test(text.slice(node.startIndex, node.endIndex));
}

/**
 * Whether this non-comment node is pinned by a per-type text pattern. C's
 * `#pragma once` is a `preproc_call` like any other pragma, but collapsing it
 * silently changes header inclusion semantics — the same class as `//go:build`, on a
 * node kind a comment pattern cannot reach.
 */
function pinnedDirective(node: Node, text: string, structure: LanguageStructure): boolean {
  const pattern = structure.pinnedPatternsByType?.[node.type];
  if (pattern === undefined) return false;
  return pattern.test(text.slice(node.startIndex, node.endIndex));
}

/**
 * The end of `node`'s last non-comment token, and every comment node after it. Used
 * for node types the grammar extends over comments that belong to what follows —
 * kotlin's import_list swallowing the next declaration's KDoc.
 */
function splitTrailingComments(
  node: Node,
  structure: LanguageStructure,
): { readonly end: number; readonly trailing: readonly Node[] } {
  const comments: Node[] = [];
  let end = node.startIndex;
  const walk = (current: Node): void => {
    if (structure.commentTypes.has(current.type)) {
      comments.push(current);
      return;
    }
    let hasChildren = false;
    for (const child of current.children) {
      if (child === null) continue;
      hasChildren = true;
      walk(child);
    }
    if (!hasChildren && current.endIndex > end) end = current.endIndex;
  };
  for (const child of node.children) {
    if (child !== null) walk(child);
  }
  return { end, trailing: comments.filter((comment) => comment.startIndex >= end) };
}

/** Nothing but whitespace between the two indices, and at most one newline. */
function adjacent(text: string, end: number, start: number): boolean {
  const between = text.slice(end, start);
  if (!/^\s*$/.test(between)) return false;
  return (between.match(/\n/g) ?? []).length <= 1;
}

function matchUnits(
  units: readonly Unit[],
  input: PlanInput,
  options: StructuralPlannerOptions,
): readonly boolean[] {
  const caseSensitive = options.caseSensitive ?? false;
  const focus = (input.focus ?? []).filter((term) => term.length > 0);
  const needles = caseSensitive ? focus : focus.map((term) => term.toLowerCase());

  return units.map((unit) => {
    if (needles.length === 0) return false;
    const raw = input.text.slice(unit.start, unit.end);
    const haystack = caseSensitive ? raw : raw.toLowerCase();
    return needles.some((needle) => haystack.includes(needle));
  });
}

/**
 * Law 2, for this rule: the explanation names the *kind* and the *count*, read off the
 * parse tree — `collapsed 3 sibling functions` — never a line count as the claim. A
 * mixed run says what it mixed: `collapsed 4 sibling declarations (3 functions,
 * 1 class)` — and when the run holds anything that is not a declaration (a statement,
 * a floating comment, an unparsed region), the heading says `nodes`, because calling
 * a parse error a declaration would be the marker lying about the tree.
 *
 * The explanation stays the same sentence a first-pass cut of the same shape would
 * earn — {@link SIBLING_COLLAPSE_PRESSURE_RULE} is where the escalation is stated.
 * Words added here would grow the rendered marker (`defaultMarker` renders
 * `explanation`, byte for byte) and could flip a rung candidate priced right at the
 * edge of profitable back into unprofitable — the review's own case prices its
 * 92-byte cut against an 82-byte marker, ten bytes of room a longer sentence would
 * spend. The rule id costs the marker nothing: `defaultMarker` never renders it.
 */
function explain(group: readonly Unit[]): string {
  const counts = new Map<string, number>();
  for (const unit of group) counts.set(unit.kind, (counts.get(unit.kind) ?? 0) + 1);

  const total = group.length;
  if (counts.size === 1) {
    const kind = group[0]!.kind;
    return `collapsed ${String(total)} sibling ${countNoun(kind, total)}`;
  }
  const parts = [...counts.entries()].map(
    ([kind, count]) => `${String(count)} ${countNoun(kind, count)}`,
  );
  const heading = [...counts.keys()].every((kind) => !NON_DECLARATION_KINDS.has(kind))
    ? 'declarations'
    : 'nodes';
  return `collapsed ${String(total)} sibling ${heading} (${parts.join(', ')})`;
}

/** The kind labels that are not declarations, so a mixed heading never overclaims. */
const NON_DECLARATION_KINDS: ReadonlySet<string> = new Set([
  'statement',
  'comment',
  'unparsed region',
  'package clause',
  'package header',
  'package declaration',
  'attribute',
  'command',
  'variable assignment',
  'include directive',
  'shebang',
  'php tag',
  'html section',
  'heredoc body',
  'preprocessor directive',
  'preprocessor conditional',
]);

function countNoun(kind: string, count: number): string {
  if (count === 1) return kind;
  if (/[^aeiou]y$/.test(kind)) return `${kind.slice(0, -1)}ies`;
  return /(?:s|sh|ch)$/.test(kind) ? `${kind}es` : `${kind}s`;
}

/**
 * The kind of a declaration, unwrapping wrappers (`export …`, `@decorator`) so the
 * marker names what it hides. What the language's map does not name is still labelled
 * honestly — see {@link LanguageStructure.kindLabels} for the labelling rules.
 */
function kindOf(node: Node, structure: LanguageStructure): string {
  const wrapperFallback = structure.wrapperTypes[node.type];
  if (wrapperFallback !== undefined) {
    for (const child of node.namedChildren) {
      if (child === null || structure.commentTypes.has(child.type)) continue;
      const label = structure.kindLabels[child.type];
      if (label !== undefined) return label;
    }
    return wrapperFallback;
  }
  const label = structure.kindLabels[node.type];
  if (label !== undefined) return label;
  if (node.type === 'ERROR') return 'unparsed region';
  if (node.type.endsWith('_statement') || node.type === 'statement_block') return 'statement';
  return 'declaration';
}

/**
 * `{ name }` when the unit is a declaration with a name, `{}` otherwise — spread into
 * a unit. Only declarations are named: an import, a package clause or a bare statement
 * has an identifier in it too (`require 'json'`, `using System;`) but naming it would
 * put a word on the outline that names nothing a model could be looking for.
 */
function outlineName(
  node: Node,
  structure: LanguageStructure,
  kind: string,
): { readonly name?: string } {
  if (UNNAMED_KINDS.has(kind)) return {};
  const name = nameOf(node, structure, 0);
  return name === undefined ? {} : { name };
}

/**
 * Kinds whose units carry no outline name: everything that is not a declaration, plus
 * the declaration-shaped kinds that name a *module* rather than something defined
 * here (imports, includes, usings, package clauses).
 */
const UNNAMED_KINDS: ReadonlySet<string> = new Set([
  ...NON_DECLARATION_KINDS,
  'import statement',
  'import declaration',
  'import list',
  'include directive',
  'using directive',
  'using declaration',
  'package clause',
  'package declaration',
  'package header',
]);

/**
 * The node types that *are* a name, across the bundled grammars: `identifier` almost
 * everywhere, `simple_identifier` in kotlin and swift, `type_identifier` for a rust
 * `impl` block's type or a C typedef, `constant` for a ruby class, `name` in php,
 * `word` for a bash function. A grammar that names its declaration through a field
 * is read through the field first; this set is the fallback for the ones that do not.
 */
const NAME_NODE_TYPES: ReadonlySet<string> = new Set([
  'identifier',
  'simple_identifier',
  'type_identifier',
  'property_identifier',
  'field_identifier',
  'constant',
  'name',
  'word',
]);

/** How deep the name search descends through wrappers and declarators before giving up. */
const NAME_SEARCH_DEPTH = 4;

/**
 * The declaration's name, read off the tree — or `undefined`, honestly, when the node
 * has none (an expression statement, an import, an unparsed region). Three readings in
 * order, each a fact the grammar states rather than a guess about the text:
 *
 *  1. A wrapper (`export …`, `@decorator`) names what it wraps, so descend to it.
 *  2. The `name` field, which most grammars put on a declaration — and failing that
 *     the `declarator` chain C and C++ use (`int (*fn)(void)` names `fn` three levels
 *     down), which is followed to the identifier at its end.
 *  3. The first named child that is itself a name node, or that carries a `name`
 *     field of its own (go's `type_declaration` → `type_spec`, a `lexical_declaration`
 *     → `variable_declarator`).
 *
 * The search is bounded so a pathological tree cannot make it quadratic, and a name
 * is returned only when the tree says so — a wrong name on an outline would send a
 * model to retrieve the wrong marker, which is worse than no outline at all.
 */
function nameOf(node: Node, structure: LanguageStructure, depth: number): string | undefined {
  if (depth > NAME_SEARCH_DEPTH) return undefined;
  if (NAME_NODE_TYPES.has(node.type)) return node.text;
  if (structure.wrapperTypes[node.type] !== undefined) {
    for (const child of node.namedChildren) {
      if (child === null || structure.commentTypes.has(child.type)) continue;
      const inner = nameOf(child, structure, depth + 1);
      if (inner !== undefined) return inner;
    }
    return undefined;
  }
  const byField = node.childForFieldName('name');
  if (byField !== null) {
    return NAME_NODE_TYPES.has(byField.type) || byField.namedChildCount === 0
      ? byField.text
      : (nameOf(byField, structure, depth + 1) ?? byField.text);
  }
  const declarator = node.childForFieldName('declarator');
  if (declarator !== null) return nameOf(declarator, structure, depth + 1);
  for (const child of node.namedChildren) {
    if (child === null || structure.commentTypes.has(child.type)) continue;
    if (NAME_NODE_TYPES.has(child.type)) return child.text;
    if (
      child.childForFieldName('name') !== null ||
      child.childForFieldName('declarator') !== null
    ) {
      return nameOf(child, structure, depth + 1);
    }
  }
  return undefined;
}
