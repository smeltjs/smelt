import { Parser } from 'web-tree-sitter';
import type { Node } from 'web-tree-sitter';

import { describe, expect, it, vi } from 'vitest';

import { applyPlan, markerPricing } from '@guard/apply';
import { GrammarUnavailableError } from '@guard/errors';
import { createSmelter } from '@guard/index';
import { loadGrammar } from '@guard/plan/grammar';
import { planStructural, STRUCTURAL_PLANNER_ID } from '@guard/plan/structural';
import { MemoryElisionStore } from '@guard/store';
import type { ElisionPlan, PlanInput } from '@guard/types';

import {
  BOUNDARY_TS,
  BUDGET_RUNG_BUDGET,
  BUDGET_RUNG_CUT_BYTES,
  BUDGET_RUNG_MARKER_BYTES,
  BUDGET_RUNG_PY,
  BUILD_TAG_GO,
  FIXTURE_BY_LANGUAGE,
  FUNCTIONS_PY,
  FUNCTIONS_RS,
  FUNCTIONS_TS,
  LONG_DOC_COMMENT,
  LONG_DOC_TS,
  MIXED_TSX,
  PHP_MIXED_HTML,
  PRAGMA_C,
  RUBY_HEREDOC,
  SHEBANG_KT,
  SHEBANG_SWIFT,
  SHEBANG_TS,
} from '../structural-fixtures.ts';

import type { GuardMutation } from './_mutations.ts';

/**
 * STRUCTURAL-PLANNER GUARD — the guarantees the structural planner claims.
 *
 * Six properties, each of which could quietly rot into something that still *looks*
 * structural from the outside:
 *
 *  1. **The explanation names kind and count from the parse tree** — `collapsed 3
 *     sibling functions`, never a line count as the claim. Lose this and Law 2
 *     degrades into the `[...truncated...]` it exists to replace.
 *  2. **The labels are honest for text that is not clean code.** A labeled_statement
 *     is a statement and an ERROR node is an unparsed region — never a
 *     "declaration", which would tell the model broken text was code that parsed.
 *  3. **A kept declaration keeps its signature line and attached doc comment,
 *     always.** The fixture's doc comment is forty lines long, because the cheap bug
 *     is an attachment heuristic that silently hands a big comment to the collapse.
 *  4. **Ranges never cross a parse-node boundary.** Every elision endpoint must be a
 *     top-level node boundary of the real parse — a range that cuts into a
 *     declaration produces output that lies about the code's structure. (Node
 *     boundaries are character boundaries, so this also covers multi-byte safety,
 *     which the reversibility guard asserts separately.)
 *  5. **No silent fallback, on either path.** A language this planner has not mapped
 *     *and* a mapped language whose grammar fails to load are both exceptions —
 *     never lexical output labelled `structural/v1`, which would be undetectable
 *     from the outside.
 *  6. **An elision never costs more than it removes.** The profitability check
 *     renders the actual marker, because a mixed-kind explanation can outgrow a
 *     small cut — and an optimizer that grows its input is worse than none.
 *  7. **The budget rung cuts around the focus, never through it.** `planStructural`
 *     reads `input.budgetBytes` now: when the first pass comes back over budget it
 *     re-prices each run it refused as that run's best profitable sub-run. Under
 *     that pressure, the one thing that must stay untouchable is the declaration the
 *     caller searched for — an optimizer that drops the thing you asked for under
 *     load is worse than one that returns over budget and says so.
 *
 * Plus the determinism claim: same file, same focus, byte-identical plan — asserted
 * by running it, not assumed. Mutations for all of these live in the MUTATIONS
 * export at the bottom of this file; `pnpm mutate` proves each one turns it red.
 */

function inputFor(text: string, focus: readonly string[], language: PlanInput['language']) {
  return { text, language, budgetBytes: 600, focus, pricing: markerPricing(language) } as const;
}

async function structuralPlan(
  text: string,
  focus: readonly string[],
  language: PlanInput['language'] = 'typescript',
): Promise<ElisionPlan> {
  return planStructural(inputFor(text, focus, language));
}

describe('the structural planner keeps its claims', () => {
  it('explains every elision with a kind and a count, never a line count', async () => {
    const plans = [
      await structuralPlan(FUNCTIONS_TS, ['handleRequest']),
      await structuralPlan(LONG_DOC_TS, ['retryWithBackoff']),
      await structuralPlan(BOUNDARY_TS, ['greetTarget']),
    ];
    const elisions = plans.flatMap((plan) => plan.elisions);
    expect(elisions.length, 'no elisions planned — this guard would be vacuous').toBeGreaterThan(2);
    for (const { reason } of elisions) {
      expect(reason.rule).toBe('sibling-collapse');
      // The kind-and-count shape, from the parse tree: "collapsed 2 sibling
      // functions", or the mixed form "collapsed 4 sibling declarations (…)".
      expect(reason.explanation).toMatch(/^collapsed \d+ sibling [a-z]/);
      // Never a line count as the primary claim — that is the lexical planner's
      // vocabulary, and structural output claiming it has lost its reason to exist.
      expect(reason.explanation).not.toMatch(/\d+ lines?\b/);
    }
  });

  it('keeps a kept declaration whole: signature line and forty-line doc comment', async () => {
    // Self-check first, so the fixture cannot quietly stop being the hard case.
    expect(LONG_DOC_COMMENT.split('\n')).toHaveLength(40);
    expect(LONG_DOC_TS).toContain(LONG_DOC_COMMENT);

    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(LONG_DOC_TS, {
      language: 'typescript',
      budgetBytes: 600,
      focus: ['retryWithBackoff'],
    });
    expect(
      result.elisions.length,
      'nothing elided — the assertion below is vacuous',
    ).toBeGreaterThan(0);
    // The signature line survives…
    expect(result.text).toContain('export async function retryWithBackoff<T>(');
    // …and so does the attached doc comment, every byte of it.
    expect(result.text).toContain(LONG_DOC_COMMENT);
    expect(smelter.reconstruct(result)).toBe(LONG_DOC_TS);
  });

  it('never lets a range cross a top-level parse-node boundary', async () => {
    for (const [text, focus, language] of [
      [FUNCTIONS_TS, ['handleRequest'], 'typescript'],
      [BOUNDARY_TS, ['greetTarget'], 'typescript'],
      [MIXED_TSX, ['Toolbar'], 'tsx'],
    ] as const) {
      const plan = await structuralPlan(text, focus, language);
      expect(plan.elisions.length, 'no elisions — boundary check is vacuous').toBeGreaterThan(0);

      // An independent parse, and an independent code-unit → byte conversion: the
      // boundaries come from the tree itself, not from the planner under test.
      const grammar = await loadGrammar(language);
      const parser = new Parser();
      parser.setLanguage(grammar);
      const tree = parser.parse(text);
      expect(tree).not.toBeNull();
      const toBytes = (index: number): number => Buffer.byteLength(text.slice(0, index), 'utf8');
      const starts = new Set<number>();
      const ends = new Set<number>();
      for (const child of tree!.rootNode.namedChildren) {
        if (child === null) continue;
        starts.add(toBytes(child.startIndex));
        ends.add(toBytes(child.endIndex));
      }
      tree!.delete();
      parser.delete();

      for (const { range } of plan.elisions) {
        expect(starts, `range start ${String(range.start)} is not a node start`).toContain(
          range.start,
        );
        expect(ends, `range end ${String(range.end)} is not a node end`).toContain(range.end);
      }
    }
  });

  it('throws GrammarUnavailableError instead of falling back to lexical', async () => {
    await expect(structuralPlan(FUNCTIONS_TS, ['handleRequest'], 'unknown')).rejects.toThrow(
      GrammarUnavailableError,
    );
    const smelter = createSmelter({ strategy: 'structural' });
    await expect(
      smelter.smelt('just some prose, no language at all', { budgetBytes: 100 }),
    ).rejects.toThrow(GrammarUnavailableError);
  });

  it('rejects when the grammar for a supported language cannot load — never lexical output', async () => {
    // The other half of "no silent fallback": the language is mapped, but the grammar
    // itself will not load — a corrupted or missing wasm in the field. The failure must
    // surface as the loader's own error, never as line-window output labelled
    // structural/v1, which is undetectable from the outside. The check runs against
    // more than one language: the rule holds per grammar, not just for the two the
    // planner started with.
    vi.resetModules();
    vi.doMock('@guard/plan/grammar', () => ({
      loadGrammar: () =>
        Promise.reject(
          new GrammarUnavailableError('smelt: induced grammar-load failure, for this guard'),
        ),
    }));
    try {
      const fresh =
        (await import('@guard/plan/structural')) as typeof import('@guard/plan/structural');
      await expect(
        fresh.planStructural(inputFor(FUNCTIONS_TS, ['handleRequest'], 'typescript')),
      ).rejects.toThrow(GrammarUnavailableError);
      await expect(
        fresh.planStructural(inputFor(FUNCTIONS_RS, ['resolve_target'], 'rust')),
      ).rejects.toThrow(GrammarUnavailableError);
    } finally {
      vi.doUnmock('@guard/plan/grammar');
      vi.resetModules();
    }
  });

  it('labels statements and unparsed regions honestly, never as declarations', async () => {
    // Log lines parsed as TypeScript are labeled_statement nodes; garbage is ERROR and
    // empty_statement nodes. A marker that calls either a "declaration" tells the model
    // the text was code that parsed — the parse tree says otherwise, and Law 2 says the
    // explanation reads off the tree.
    const log = Array.from({ length: 6 }, (_, i) => `line ${String(i)}: routine chatter here`).join(
      '\n',
    );
    const logPlan = await structuralPlan(log, []);
    expect(logPlan.elisions.length, 'log input planned nothing — vacuous').toBeGreaterThan(0);
    for (const { reason } of logPlan.elisions) {
      expect(reason.explanation).toMatch(/sibling statements$/);
      expect(reason.explanation).not.toContain('declaration');
    }

    const garbage = Array.from({ length: 5 }, () => '%%%% not typescript at all ???!!! ;;; @@@')
      .join('\n')
      .concat('\n');
    const garbagePlan = await structuralPlan(garbage, []);
    expect(garbagePlan.elisions.length, 'garbage input planned nothing — vacuous').toBeGreaterThan(
      0,
    );
    for (const { reason } of garbagePlan.elisions) {
      expect(reason.explanation).not.toContain('declaration');
      expect(reason.explanation).toContain('unparsed region');
    }
  });

  it('never plans an elision whose marker costs more bytes than it removes', async () => {
    // Eight tiny declarations of many kinds: the run is real, but the mixed-kind
    // explanation makes the marker bigger than the cut. The honest move is to plan
    // nothing — an optimizer that grows its input is worse than none.
    const tiny = [
      'type Alias = 1;',
      'enum Level {}',
      'interface Cfg { x: 1 }',
      'class Box {}',
      'const nine = 1;',
      'declare const flag: 1;',
      'function noop() {}',
      'let extra = 2;',
    ].join('\n');
    const plan = await structuralPlan(tiny, []);
    const result = applyPlan(tiny, plan, new MemoryElisionStore());
    expect(
      result.outputBytes,
      'the output grew: a marker cost more than the bytes it removed',
    ).toBeLessThanOrEqual(result.inputBytes);
  });

  it('prices a caller-supplied marker with its own rendering, end to end through createSmelter', async () => {
    // The shipped custom-builder path: `createSmelter` must construct the
    // MarkerPricing seam from `config.marker` — the exact builder applyPlan will
    // render — so a builder whose marker outweighs any candidate cut makes every
    // elision unprofitable and the plan honestly comes back empty. Priced from the
    // ~105-byte default instead, the planner keeps planning cuts the real marker
    // then outgrows: output bigger than input, no error anywhere.
    const callOptions = {
      language: 'typescript',
      budgetBytes: 600,
      focus: ['handleRequest'],
    } as const;

    // Control first, or the zero-elision assertion below would be vacuous.
    const control = await createSmelter({ strategy: 'structural' }).smelt(
      FUNCTIONS_TS,
      callOptions,
    );
    expect(
      control.elisions.length,
      'the default marker elides nothing here — the expensive-builder case is vacuous',
    ).toBeGreaterThan(0);

    const banner = 'X'.repeat(8_192);
    const smelter = createSmelter({
      strategy: 'structural',
      marker: ({ hash }) => `// ${banner} retrieve("${hash}")`,
    });
    const result = await smelter.smelt(FUNCTIONS_TS, callOptions);
    expect(
      result.elisions,
      'an elision was planned although the configured marker costs more than any cut',
    ).toEqual([]);
    expect(result.text).toBe(FUNCTIONS_TS);
    expect(result.outputBytes).toBe(result.inputBytes);
  });

  it('labels every plan it does produce as its own', async () => {
    const plan = await structuralPlan(FUNCTIONS_TS, ['handleRequest']);
    expect(plan.planner).toBe(STRUCTURAL_PLANNER_ID);
    expect(plan.language).toBe('typescript');
  });

  it('is deterministic: repeated runs produce byte-identical plans and output', async () => {
    const runs: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const plan = await structuralPlan(FUNCTIONS_TS, ['handleRequest']);
      const result = applyPlan(FUNCTIONS_TS, plan, new MemoryElisionStore());
      runs.push(JSON.stringify({ plan, text: result.text }));
    }
    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });
});

/**
 * THIRTEEN MORE LANGUAGES — the same claims beyond the first two grammars.
 *
 * Every language in `FIXTURE_BY_LANGUAGE` is planned by the same machinery as
 * TypeScript and TSX: the marker names kind and count from the parse tree, a kept
 * declaration keeps its signature and its doc comment in the language's own idiom
 * (`///`, javadoc, PHPDoc, KDoc, a docstring, `#`), and grammar failure is an
 * exception, never lexical output. One claim is survivor-shaped and holds for **every
 * structural language**: the survivor still parses. A bare `<<smelt…>>` marker line
 * was verified to break the reparse non-locally in every grammar here — python's
 * indentation lets the ERROR swallow neighbouring definitions, ruby and bash read the
 * marker's own `<<` as a heredoc operator, php reads it as an operator and re-types
 * the kept function into an expression operand, and the brace-delimited grammars
 * scatter ERROR nodes across the kept declarations. The marker therefore lands
 * behind the language's own line-comment leader (see `markerForLanguage`), and this
 * guard *reparses the post-applyPlan survivor* of every language's fixture and
 * asserts it introduces no ERROR, missing or zero-width nodes that the original
 * parse did not have. Mutations for each of these live in this file's MUTATIONS export.
 */
/**
 * Every parse issue in an independent parse of `text`: ERROR nodes, missing nodes,
 * and zero-width tokens. The last matters because tree-sitter-ruby recovers from an
 * unterminated heredoc at EOF with a zero-width `heredoc_end` and **no ERROR node at
 * all** — an ERROR-only walk is blind to the exact breakage the heredoc unit rule
 * exists to prevent.
 */
async function parseIssues(
  text: string,
  language: PlanInput['language'],
): Promise<readonly string[]> {
  const grammar = await loadGrammar(language as Exclude<PlanInput['language'], 'unknown'>);
  const parser = new Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(text);
  expect(tree).not.toBeNull();
  const issues: string[] = [];
  const walk = (node: Node): void => {
    if (node.type === 'ERROR' || node.isMissing) {
      issues.push(`${node.type}@${String(node.startIndex)}`);
    } else if (node.childCount === 0 && node.startIndex === node.endIndex && node.parent !== null) {
      issues.push(`zero-width ${node.type}@${String(node.startIndex)}`);
    }
    for (const child of node.children) {
      if (child !== null) walk(child);
    }
  };
  walk(tree!.rootNode);
  tree!.delete();
  parser.delete();
  return issues;
}

describe('every claimed language keeps the same claims', () => {
  const CASES = Object.entries(FIXTURE_BY_LANGUAGE).map(([language, fixture]) => ({
    language: language as PlanInput['language'],
    ...fixture,
  }));

  it('explains with kind and count in every language, including each pure same-kind form', async () => {
    for (const { language, text, focus, pureCollapse } of CASES) {
      const plan = await structuralPlan(text, focus, language);
      expect(
        plan.elisions.length,
        `${language}: no elisions planned — this guard would be vacuous`,
      ).toBeGreaterThan(0);
      for (const { reason } of plan.elisions) {
        expect(reason.rule).toBe('sibling-collapse');
        expect(reason.explanation).toMatch(/^collapsed \d+ sibling [a-z]/);
        expect(reason.explanation).not.toMatch(/\d+ lines?\b/);
      }
      // The same shape TypeScript earns — kind and count read off this language's own
      // parse tree, in its strongest guaranteed form ("collapsed 2 sibling functions",
      // "… classes", "… methods" — the mixed form only where the fixture mixes kinds).
      expect(
        plan.elisions.some(({ reason }) => pureCollapse.test(reason.explanation)),
        `${language}: expected ${String(pureCollapse)} among: ` +
          plan.elisions.map((e) => e.reason.explanation).join(' | '),
      ).toBe(true);
    }
  });

  it('names language-specific kinds honestly in mixed collapses', async () => {
    const rust = await structuralPlan(FUNCTIONS_RS, ['resolve_target'], 'rust');
    expect(
      rust.elisions.some(({ reason }) =>
        /^collapsed \d+ sibling declarations \(1 struct, 1 impl block\)$/.test(reason.explanation),
      ),
      `rust: ${rust.elisions.map((e) => e.reason.explanation).join(' | ')}`,
    ).toBe(true);

    const go = await structuralPlan(
      FIXTURE_BY_LANGUAGE.go.text,
      FIXTURE_BY_LANGUAGE.go.focus,
      'go',
    );
    const goMixed = go.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(goMixed, `go: ${goMixed}`).toContain('1 method');
    expect(goMixed).toContain('1 type declaration');
    expect(goMixed).toContain('1 package clause');

    const python = await structuralPlan(FUNCTIONS_PY, ['fetch_user'], 'python');
    const pyMixed = python.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(pyMixed, `python: ${pyMixed}`).toContain('1 class');
    expect(pyMixed).toContain('1 import statement');

    // A sample across the 4b languages: the kind words come from each parse tree.
    const java = await structuralPlan(
      FIXTURE_BY_LANGUAGE.java.text,
      FIXTURE_BY_LANGUAGE.java.focus,
      'java',
    );
    const javaMixed = java.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(javaMixed, `java: ${javaMixed}`).toContain('1 package declaration');
    expect(javaMixed).toContain('1 import declaration');

    const c = await structuralPlan(FIXTURE_BY_LANGUAGE.c.text, FIXTURE_BY_LANGUAGE.c.focus, 'c');
    const cMixed = c.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(cMixed, `c: ${cMixed}`).toContain('include directive');
    expect(cMixed).toContain('1 macro definition');

    const bash = await structuralPlan(
      FIXTURE_BY_LANGUAGE.bash.text,
      FIXTURE_BY_LANGUAGE.bash.focus,
      'bash',
    );
    const bashMixed = bash.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(bashMixed, `bash: ${bashMixed}`).toContain('1 command');
  });

  it('keeps the focused declaration whole — signature and doc comment — and round-trips', async () => {
    for (const { language, text, focus, signature, doc } of CASES) {
      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, { language, budgetBytes: 600, focus });
      expect(
        result.elisions.length,
        `${language}: nothing elided — the assertions below are vacuous`,
      ).toBeGreaterThan(0);
      expect(result.text, `${language}: the signature line did not survive`).toContain(signature);
      expect(result.text, `${language}: the doc comment did not survive`).toContain(doc);
      expect(smelter.reconstruct(result), `${language}: reconstruction drifted`).toBe(text);
    }
  });

  // The expected leader per language, written out literally rather than read from
  // MARKER_LINE_COMMENT_LEADERS — a guard that derives its expectation from the code
  // under test cannot notice that code losing an entry.
  const EXPECTED_LEADERS: Readonly<Record<string, string>> = {
    typescript: '// ',
    tsx: '// ',
    javascript: '// ',
    rust: '// ',
    python: '# ',
    go: '// ',
    java: '// ',
    c: '// ',
    cpp: '// ',
    c_sharp: '// ',
    ruby: '# ',
    php: '// ',
    kotlin: '// ',
    swift: '// ',
    bash: '# ',
  };

  for (const { language, text, focus } of CASES) {
    it(`the ${language} survivor still parses: the reparse introduces no new issues`, async () => {
      // Self-check: the fixture parses cleanly, so "no new issues" below means
      // exactly "no issues at all" — the comparison cannot be vacuous.
      expect(await parseIssues(text, language), 'the fixture itself must parse cleanly').toEqual(
        [],
      );

      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, { language, budgetBytes: 600, focus });
      expect(
        result.elisions.length,
        'nothing elided — the reparse below is vacuous',
      ).toBeGreaterThan(0);
      expect(
        await parseIssues(result.text, language),
        `the survivor no longer parses as ${language} — an elision broke the structure of what remains`,
      ).toEqual([]);
      // How that is achieved: every marker landed as a comment in the survivor's own
      // syntax. A bare `<<smelt…>>` line was verified to break the reparse in every
      // grammar here — indentation errors cascade in python, `<<` opens a heredoc in
      // ruby and bash and is an operator in php, and the brace grammars scatter
      // ERROR nodes across the kept declarations.
      const leader = EXPECTED_LEADERS[language]!;
      for (const { marker } of result.elisions) {
        expect(
          marker.startsWith(`${leader}<<smelt/`),
          `marker is not a ${language} line comment: ${marker}`,
        ).toBe(true);
      }
      expect(smelter.reconstruct(result)).toBe(text);
    });
  }

  it('bare applyPlan defaults its marker to the plan language — python still parses', async () => {
    // The documented public composition is `planStructural → applyPlan`, with no
    // options. If that path defaulted to the bare `<<smelt/v1…>>` marker, a python
    // survivor would stop parsing — exactly the failure the comment leader prevents —
    // and only the createSmelter path would keep the claim.
    const plan = await structuralPlan(FUNCTIONS_PY, ['fetch_user'], 'python');
    const result = applyPlan(FUNCTIONS_PY, plan, new MemoryElisionStore());
    expect(result.elisions.length, 'nothing elided — the reparse is vacuous').toBeGreaterThan(0);
    expect(await parseIssues(result.text, 'python')).toEqual([]);
  });

  it('refuses a python collapse whose marker would comment out kept code on its line', async () => {
    // tree-sitter-python emits semicolon-separated top-level statements as separate
    // module children, the second starting mid-line. A `# `-led marker replacing the
    // first would comment out the rest of the line — the exact statement the caller
    // asked to keep, syntactically alive as a comment and semantically dead. The
    // planner must refuse that collapse.
    const text =
      'configure_everything_up_front("a deliberately long argument string, padded until ' +
      'the collapse would clearly pay for its marker", 12345); TARGET_FLAG = True\n';
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(text, {
      language: 'python',
      budgetBytes: 10,
      focus: ['TARGET_FLAG'],
    });
    // The kept statement is still real code: its line is not a comment…
    const flagLine = result.text.split('\n').find((line) => line.includes('TARGET_FLAG = True'));
    expect(flagLine, 'the kept statement vanished entirely').toBeDefined();
    expect(
      flagLine!.trimStart().startsWith('#'),
      `the kept statement was swallowed into a comment: ${flagLine!}`,
    ).toBe(false);
    // …and the survivor still parses as python.
    expect(await parseIssues(result.text, 'python')).toEqual([]);
    expect(smelter.reconstruct(result)).toBe(text);
  });

  it('pins a go build-tag comment to the file — it never collapses into a run', async () => {
    // `//go:build` must be followed by a blank line (the Go spec requires it), so it
    // can never attach to a declaration — and a collapse that swallows it silently
    // changes which builds see the file. The planner pins it instead.
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(BUILD_TAG_GO, {
      language: 'go',
      budgetBytes: 10,
      focus: ['Target'],
    });
    expect(
      result.elisions.length,
      'nothing elided — the build-tag assertion below is vacuous',
    ).toBeGreaterThan(0);
    expect(result.text, 'the build constraint did not survive').toContain('//go:build linux');
    expect(smelter.reconstruct(result)).toBe(BUILD_TAG_GO);
  });

  it('pins file-governing prefixes: shebangs, magic comments, `<?php`, `#pragma once`', async () => {
    // Same law as the go build tag: a run that swallows one of these changes what the
    // survivor *is* — which interpreter runs it, whether its strings are frozen,
    // whether the file is php at all, what including the header means — with no
    // elision the caller asked for. Shebangs are covered across every grammar shape
    // they take: a plain comment (python, ruby, bash), a hash_bang_line (javascript,
    // typescript, tsx) and a shebang_line (kotlin, swift).
    const fixturePins = (
      [
        ['javascript', '#!/usr/bin/env node'],
        ['python', '#!/usr/bin/env python3'],
        ['ruby', '#!/usr/bin/env ruby'],
        ['ruby', '# frozen_string_literal: true'],
        ['php', '<?php'],
        ['bash', '#!/usr/bin/env bash'],
      ] as const
    ).map(([language, pinned]) => ({
      language,
      pinned,
      text: FIXTURE_BY_LANGUAGE[language].text,
      focus: FIXTURE_BY_LANGUAGE[language].focus,
    }));
    const PINS = [
      ...fixturePins,
      {
        language: 'typescript',
        pinned: '#!/usr/bin/env -S npx tsx',
        text: SHEBANG_TS,
        focus: ['runTarget'],
      },
      {
        language: 'tsx',
        pinned: '#!/usr/bin/env -S npx tsx',
        text: SHEBANG_TS,
        focus: ['runTarget'],
      },
      {
        language: 'kotlin',
        pinned: '#!/usr/bin/env kotlin',
        text: SHEBANG_KT,
        focus: ['runTarget'],
      },
      {
        language: 'swift',
        pinned: '#!/usr/bin/env swift',
        text: SHEBANG_SWIFT,
        focus: ['runTarget'],
      },
      { language: 'c', pinned: '#pragma once', text: PRAGMA_C, focus: ['run_target'] },
      { language: 'cpp', pinned: '#pragma once', text: PRAGMA_C, focus: ['run_target'] },
    ] as const;
    for (const { language, pinned, text, focus } of PINS) {
      const smelter = createSmelter({ strategy: 'structural' });
      const result = await smelter.smelt(text, {
        language,
        budgetBytes: 10,
        focus,
      });
      expect(
        result.elisions.length,
        `${language}: nothing elided — the pin assertion below is vacuous`,
      ).toBeGreaterThan(0);
      expect(
        result.text,
        `${language}: the pinned prefix ${JSON.stringify(pinned)} did not survive`,
      ).toContain(pinned);
      expect(smelter.reconstruct(result)).toBe(text);
    }
  });

  it('labels c/c++ preprocessor regions honestly, never as declarations', async () => {
    // `#pragma once` is a preproc_call, `#ifdef … #endif` a preproc_ifdef — kinds the
    // parse tree states plainly. A marker calling either a "declaration" reports a
    // kind not read off the tree, which is the structural guard's own standard.
    for (const language of ['c', 'cpp'] as const) {
      const plan = await structuralPlan(PRAGMA_C, ['run_target'], language);
      expect(
        plan.elisions.length,
        `${language}: no elisions planned — this labelling check is vacuous`,
      ).toBeGreaterThan(0);
      const explanations = plan.elisions.map((e) => e.reason.explanation).join(' | ');
      expect(explanations, `${language}: ${explanations}`).toContain('1 preprocessor conditional');
      expect(explanations).not.toContain('declaration');
    }
  });

  it('keeps a ruby heredoc whole: the body can never be cut away from its opener', async () => {
    // tree-sitter-ruby emits heredoc_body as a top-level sibling of the statement
    // holding the `<<~SQL` opener. A plan that keeps the opener while collapsing the
    // body leaves an unterminated heredoc — `ruby -c` refuses the survivor, and every
    // kept declaration after it is swallowed into the string. Worse, tree-sitter
    // reports no ERROR node for it, only a zero-width heredoc_end, which is exactly
    // why parseIssues flags zero-width tokens.
    expect(await parseIssues(RUBY_HEREDOC, 'ruby'), 'the fixture must parse cleanly').toEqual([]);

    // Focus on the target method: the opener statement and the heredoc body must
    // collapse together, as one unit of the same elision.
    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(RUBY_HEREDOC, {
      language: 'ruby',
      budgetBytes: 10,
      focus: ['handle_request'],
    });
    expect(result.elisions.length, 'nothing elided — vacuous').toBeGreaterThan(0);
    expect(
      result.text.includes('QUERY_FOR_ACTIVE_USERS'),
      'the opener survived — the heredoc did not collapse as one unit',
    ).toBe(false);
    expect(
      result.text.includes('order by last_seen_at desc'),
      'heredoc content survived without its opener',
    ).toBe(false);
    expect(await parseIssues(result.text, 'ruby'), 'the survivor no longer parses').toEqual([]);
    expect(smelter.reconstruct(result)).toBe(RUBY_HEREDOC);

    // Focus on the opener: the kept unit is the whole heredoc, terminator included.
    const kept = await smelter.smelt(RUBY_HEREDOC, {
      language: 'ruby',
      budgetBytes: 10,
      focus: ['QUERY_FOR_ACTIVE_USERS'],
    });
    expect(kept.elisions.length, 'nothing elided — vacuous').toBeGreaterThan(0);
    expect(kept.text).toContain('QUERY_FOR_ACTIVE_USERS = <<~SQL');
    expect(kept.text).toContain('order by last_seen_at desc\nSQL');
    expect(await parseIssues(kept.text, 'ruby'), 'the survivor no longer parses').toEqual([]);
  });

  it('labels php mixed-HTML text honestly and keeps that survivor parsing', async () => {
    // Raw markup between `?>` and `<?php` parses as text/text_interpolation nodes.
    // Calling them "declarations" would defeat the mixed-heading honesty rule
    // upstream, at the kind level — the marker must say what the tree says: html.
    expect(await parseIssues(PHP_MIXED_HTML, 'php'), 'the fixture must parse cleanly').toEqual([]);
    const plan = await structuralPlan(PHP_MIXED_HTML, ['render_target'], 'php');
    expect(plan.elisions.length, 'no elisions planned — vacuous').toBeGreaterThan(0);
    const explanations = plan.elisions.map((e) => e.reason.explanation).join(' | ');
    expect(explanations, `php: ${explanations}`).toContain('html section');
    expect(explanations).not.toContain('declaration');

    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(PHP_MIXED_HTML, {
      language: 'php',
      budgetBytes: 10,
      focus: ['render_target'],
    });
    expect(result.elisions.length, 'nothing elided — vacuous').toBeGreaterThan(0);
    expect(result.text).toContain('function render_target(): string {');
    expect(await parseIssues(result.text, 'php'), 'the survivor no longer parses').toEqual([]);
    expect(smelter.reconstruct(result)).toBe(PHP_MIXED_HTML);
  });
});

/** The review's case as a `PlanInput`, at whatever budget is being squeezed. */
const budgetInput = (budgetBytes: number): PlanInput => ({
  text: BUDGET_RUNG_PY,
  language: 'python',
  budgetBytes,
  focus: ['alpha_gate'],
  pricing: markerPricing('python'),
});

/**
 * THE BUDGET RUNG — the pass that reads `input.budgetBytes`, and the one thing it is
 * never allowed to reach for.
 *
 * Under budget pressure the planner re-prices the runs its first pass refused. Every
 * candidate it mints goes through the same profitability check as the first pass, so
 * the output cannot grow; and a focus-matched unit is not in any run, so no sub-run of
 * any run can contain one. That second property is the one worth a guard: it holds
 * because of the *shape* of the data, and a plausible edit that widened the search to
 * "all units" instead of "the units of a refused run" would break it silently — the
 * plan would still be smaller, still be reversible, and still be labelled
 * `structural/v1`, having quietly hidden the declaration the caller went looking for.
 */
describe('the budget rung cuts around the focus, never through it', () => {
  it('finds the profitable cut a maximal run was hiding, when over budget', async () => {
    // The review's case: 158 bytes against a budget of 120. Without the rung this
    // plan is empty and the run is over budget having elided nothing.
    const plan = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    expect(plan.elisions, 'nothing elided — every assertion below is vacuous').toHaveLength(1);
    const elision = plan.elisions[0]!;
    const cut = elision.range.end - elision.range.start;
    expect(cut).toBe(BUDGET_RUNG_CUT_BYTES);
    expect(markerPricing('python').costBytes(elision.reason, cut)).toBe(BUDGET_RUNG_MARKER_BYTES);
    // The escalation is stated on the elision: a rule id distinct from the first
    // pass's plain `sibling-collapse`, so a reader of the report, the `--json`
    // envelope or the per-rule ledger can tell this cut apart from an ordinary
    // profitable one without knowing which pass produced it.
    expect(elision.reason.rule).toBe('sibling-collapse-pressure');
  });

  it('stays silent under a budget the first pass already meets', async () => {
    // The rung is an over-budget escalation, not a hunt for extra profitable cuts:
    // the profitability floor is the only thing that runs once the plan already
    // fits. The refused run here (a `VERSION = 1` statement plus three classes,
    // priced whole) stays refused even though a sub-run of it — the same three
    // classes the tighter budgets above cut — is profitable on its own, because
    // nothing asked for it to be re-priced.
    const plan = await planStructural(budgetInput(10_000));
    expect(plan.elisions).toEqual([]);
  });

  it('keeps the focus-matched declaration whole, at every budget it is squeezed to', async () => {
    for (const budget of [BUDGET_RUNG_BUDGET, 64, 8, 1]) {
      const plan = await planStructural(budgetInput(budget));
      const result = applyPlan(BUDGET_RUNG_PY, plan, new MemoryElisionStore());
      expect(result.text, `budget ${String(budget)}`).toContain('def alpha_gate(flag):');
      expect(result.text, `budget ${String(budget)}`).toContain('return 1 if flag else -1');
      expect(result.outputBytes, `budget ${String(budget)}`).toBeLessThan(result.inputBytes);
      expect(result.elisions.length, `budget ${String(budget)}: vacuous`).toBeGreaterThan(0);
      expect(
        result.elisions.every(({ reason }) => !reason.explanation.includes('function')),
        `budget ${String(budget)}: a marker claims to have collapsed a function — the ` +
          'only function in this fixture is the focus match',
      ).toBe(true);
    }
  });

  it('never grows the output, whatever the budget asks for', async () => {
    for (const budget of [1, 40, BUDGET_RUNG_BUDGET, 10_000]) {
      const plan = await planStructural(budgetInput(budget));
      const result = applyPlan(BUDGET_RUNG_PY, plan, new MemoryElisionStore());
      expect(result.outputBytes, `budget ${String(budget)}`).toBeLessThanOrEqual(result.inputBytes);
    }
  });

  it('is deterministic, and reversible like every other plan', async () => {
    const first = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    const second = await planStructural(budgetInput(BUDGET_RUNG_BUDGET));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    const smelter = createSmelter({ strategy: 'structural' });
    const result = await smelter.smelt(BUDGET_RUNG_PY, {
      language: 'python',
      budgetBytes: BUDGET_RUNG_BUDGET,
      focus: ['alpha_gate'],
    });
    expect(smelter.reconstruct(result)).toBe(BUDGET_RUNG_PY);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'pricing-wired-to-constant',
    file: 'apply.ts',
    find:
      '    costBytes: (reason, elidedBytes) =>\n' +
      '      Buffer.byteLength(\n' +
      '        build({\n' +
      '          hash: PLACEHOLDER_HASH,\n' +
      '          bytes: elidedBytes,\n' +
      '          rule: reason.rule,\n' +
      '          explanation: reason.explanation,\n' +
      '        }),\n' +
      "        'utf8',\n" +
      '      ),',
    replace: '    costBytes: () => 8,',
    why: 'the MarkerPricing seam answering a constant instead of rendering the real marker — every planner now believes a ~105-byte marker costs 8 bytes, plans cuts the marker outweighs, and the output grows with no error anywhere',
  },
  {
    id: 'smelter-pricing-ignores-custom-marker',
    file: 'smelter.ts',
    find: '        pricing: markerPricing(language, config.marker),',
    replace: '        pricing: markerPricing(language),',
    why: "createSmelter pricing built without config.marker — the planner prices the ~105-byte default while applyPlan renders the caller's far larger marker, so cuts the real marker outweighs get planned and the shipped custom-builder path grows its output with no error anywhere",
  },
  {
    id: 'structural-explanation-loses-kind',
    file: 'plan/structural.ts',
    find: '    return `collapsed ${String(total)} sibling ${countNoun(kind, total)}`;',
    replace: '    return `collapsed ${String(total)} lines`;',
    why: "the sibling-collapse explanation reduced to a line count — Law 2's whole point for this planner is naming kind and count from the parse tree",
  },
  {
    id: 'structural-silent-lexical-fallback',
    file: 'plan/structural.ts',
    find: '  throw new GrammarUnavailableError(\n    `smelt: structural planning covers ${named} in this ` +',
    replace:
      "  return 'typescript';\n  throw new GrammarUnavailableError(\n    `smelt: structural planning covers ${named} in this ` +",
    why: 'the no-fallback rule broken: an unmapped language quietly parsed as typescript instead of refused — structural/v1 output nobody asked the grammar to justify',
  },
  {
    id: 'structural-doc-comment-cut',
    file: 'plan/structural.ts',
    find: '  return (between.match(/\\n/g) ?? []).length <= 1;',
    replace: '  return false;',
    why: 'doc comments detached from their declarations, so a kept declaration silently loses its forty-line doc comment to the sibling collapse',
  },
  {
    id: 'structural-range-crosses-node-boundary',
    file: 'plan/structural.ts',
    find: '      range: { start, end },',
    replace: '      range: { start, end: end - 1 },',
    why: 'an elision range that stops one byte inside the last collapsed declaration — output that lies about where the parse tree was cut',
  },
  {
    id: 'structural-grammar-load-fallback',
    file: 'plan/structural.ts',
    find: '  const grammar = await loadGrammar(language);',
    replace:
      '  let grammar;\n' +
      '  try {\n' +
      '    grammar = await loadGrammar(language);\n' +
      '  } catch {\n' +
      "    const { planLexical } = await import('./lexical.ts');\n" +
      '    return { ...planLexical(input), planner: STRUCTURAL_PLANNER_ID };\n' +
      '  }',
    why: 'a failed grammar load quietly answered with line windows labelled structural/v1 — the exact undetectable fallback the no-fallback rule forbids',
  },
  {
    id: 'structural-error-node-called-declaration',
    file: 'plan/structural.ts',
    find: "  if (node.type === 'ERROR') return 'unparsed region';",
    replace: "  if (node.type === 'ERROR') return 'declaration';",
    why: 'an ERROR node labelled a declaration — the marker telling the model that broken text was code that parsed',
  },
  {
    id: 'structural-marker-cost-guessed',
    file: 'plan/structural.ts',
    find: '    return savingBytes(candidate, pricing) > 0 ? candidate : undefined;',
    replace: '    return end - start > 8 ? candidate : undefined;',
    why: 'the profitability check reverted to a guessed constant — a mixed-kind marker can cost more than the cut it replaces, and the output grows',
  },
  {
    id: 'structural-budget-rung-cuts-focus-match',
    file: 'plan/structural.ts',
    find: '    if (cut === undefined) refused.push(group);',
    replace: '    if (cut === undefined) refused.push(units);',
    why: 'the budget rung searching every unit in the file instead of the units of the run the first pass refused — under budget pressure the best-priced sub-run then swallows the focus-matched declaration, and the plan is smaller, reversible, labelled structural/v1, and missing the one thing the caller went looking for',
  },
  {
    id: 'structural-budget-rung-ignores-budget',
    file: 'plan/structural.ts',
    find: '    if (currentBytes <= input.budgetBytes) break;',
    replace: '    break;',
    why: "the rung breaking out on its first iteration regardless of budget — planStructural goes back to never reading input.budgetBytes at all, and the review's own case (158 bytes against a 120-byte budget) returns to zero elisions, over budget, with the ten-byte profitable cut left on the table again",
  },
  {
    id: 'structural-budget-rung-fires-under-budget',
    file: 'plan/structural.ts',
    find: '    if (currentBytes <= input.budgetBytes) break;',
    replace: '    if (false) break;',
    why: 'the over-budget check disabled — the rung re-prices every refused run even when the plan already fits, so a caller who never asked for the escalation gets a smaller, uglier plan (and a sibling-collapse-pressure rule id) than the one their budget already satisfied: the profitability floor stops being the only thing that runs under budget',
  },
  {
    id: 'structural-new-language-dropped',
    file: 'lang/registry.ts',
    find: '  python,\n  go,\n  java,',
    replace: '  python,\n  java,',
    why: 'a structural language quietly dropped from the profile registry — go callers would be refused while the docs still claim it',
  },
  {
    id: 'structural-bash-shebang-collapsed',
    file: 'lang/bash.ts',
    find:
      "    // comment node, so it is pinned the way go's build tag is — never collapsed.\n" +
      '    pinnedCommentPattern: /^#!/,',
    replace: "    // comment node, so it is pinned the way go's build tag is — never collapsed.",
    why: "the bash shebang pin removed — `#!/usr/bin/env bash` collapses into the head run and the survivor silently changes which interpreter runs it, go build tags' exact failure in a new language",
  },
  {
    id: 'ruby-survivor-marker-not-a-comment',
    file: 'lang/ruby.ts',
    find: "  markerLeader: '# ',\n",
    replace: '',
    why: 'the ruby marker landing as a bare `<<smelt/v1 …>>` line — ruby reads `<<` as a heredoc operator, so the marker swallows every kept declaration after it into a string and the survivor stops being ruby at all',
  },
  {
    id: 'structural-rust-function-mislabelled',
    file: 'lang/rust.ts',
    find: "    kindLabels: {\n      function_item: 'function',",
    replace: "    kindLabels: {\n      function_item: 'declaration',",
    why: "rust's node kinds unmapped in the marker — `collapsed 2 sibling declarations` where the tree says functions, Law 2 decayed to a vaguer truth",
  },
  {
    id: 'structural-go-method-mislabelled',
    file: 'lang/go.ts',
    find: "    kindLabels: {\n      function_declaration: 'function',\n      method_declaration: 'method',",
    replace:
      "    kindLabels: {\n      function_declaration: 'function',\n      method_declaration: 'declaration',",
    why: "go's method kind erased from the marker — a mixed collapse that can no longer say what it mixed",
  },
  {
    id: 'python-survivor-marker-not-a-comment',
    file: 'lang/python.ts',
    find: "  markerLeader: '# ',\n",
    replace: '',
    why: 'the python marker landing as a bare `<<smelt/v1 …>>` line — significant indentation lets the ERROR node swallow the neighbouring definitions, so the survivor stops being python at all',
  },
  {
    id: 'structural-rust-attribute-detached',
    file: 'lang/rust.ts',
    find: "    attributeTypes: new Set(['attribute_item']),",
    replace: '    attributeTypes: new Set(),',
    why: 'rust outer attributes treated as their own units again — a kept declaration loses its `#[inline]`, and the doc comment above it, to the sibling collapse',
  },
  {
    id: 'structural-python-midline-marker-comments-out-kept-code',
    file: 'plan/structural.ts',
    find: '    if (markerIsLineComment && !restOfLineIsBlank(input.text, group[group.length - 1]!.end)) {\n      return undefined;\n    }',
    replace: '',
    why: 'the mid-line refusal dropped — a `# `-led marker replacing the first of two semicolon-separated statements comments out the kept one, syntactically alive and semantically dead',
  },
  {
    id: 'structural-go-buildtag-collapsed',
    file: 'lang/go.ts',
    find: '    pinnedCommentPattern: /^\\/\\/(go:build|\\s*\\+build)\\s/,',
    replace: '',
    why: 'the build-tag pin removed — `//go:build linux` collapses into the head run and the survivor silently loses its build constraint',
  },
  {
    id: 'structural-python-shebang-collapsed',
    file: 'lang/python.ts',
    find:
      '    // interpreter runs the file — pinned the way the bash and ruby shebangs are.\n' +
      '    pinnedCommentPattern: /^#!/,',
    replace: '    // interpreter runs the file — pinned the way the bash and ruby shebangs are.',
    why: 'the python shebang pin removed — `#!/usr/bin/env python3` parses as a plain comment, attaches to whatever follows, and collapses into the head run: the survivor silently changes which interpreter runs it',
  },
  {
    id: 'structural-ts-shebang-collapsed',
    file: 'lang/typescript.ts',
    find:
      "  // law as javascript's: collapsing it changes which interpreter runs the file.\n" +
      "  pinnedTypes: new Set(['hash_bang_line']),",
    replace:
      "  // law as javascript's: collapsing it changes which interpreter runs the file.\n" +
      '  pinnedTypes: new Set(),',
    why: 'the typescript/tsx hash_bang_line pin removed — `#!/usr/bin/env -S npx tsx` collapses into the head run, mislabelled, and the survivor silently changes which interpreter runs it',
  },
  {
    id: 'structural-kotlin-shebang-collapsed',
    file: 'lang/kotlin.ts',
    find:
      '    // `#!/usr/bin/env kotlin` parses as a shebang_line node; same law as the rest.\n' +
      "    pinnedTypes: new Set(['shebang_line']),",
    replace:
      '    // `#!/usr/bin/env kotlin` parses as a shebang_line node; same law as the rest.\n' +
      '    pinnedTypes: new Set(),',
    why: 'the kotlin shebang_line pin removed — a `.kts` script loses the line that names its interpreter to a sibling collapse',
  },
  {
    id: 'structural-pragma-once-collapsed',
    file: 'lang/c.ts',
    find:
      '    // the file *means*, so only it is pinned — the `//go:build` law again.\n' +
      '    pinnedPatternsByType: { preproc_call: /^#\\s*pragma\\s+once\\b/ },',
    replace: '    // the file *means*, so only it is pinned — the `//go:build` law again.',
    why: "c's `#pragma once` pin removed — the pragma collapses into the head run and the survivor silently changes header inclusion semantics, and the fallback labels it a declaration the tree never contained",
  },
  {
    id: 'structural-kotlin-import-doc-swallowed',
    file: 'lang/kotlin.ts',
    find: "    trailingCommentSplitTypes: new Set(['import_list']),",
    replace: '    trailingCommentSplitTypes: new Set(),',
    why: 'the import_list trailing-comment split disabled — tree-sitter-kotlin extends import_list over the KDoc that follows it, so the first documented declaration after the imports loses its doc comment to the import collapse',
  },
  {
    id: 'structural-ruby-heredoc-split-from-opener',
    file: 'lang/ruby.ts',
    find: "    ridesBackwardTypes: new Set(['heredoc_body']),",
    replace: '    ridesBackwardTypes: new Set(),',
    why: 'the heredoc body detached from its opener — a focus matching the opener keeps it while the body collapses, leaving an unterminated heredoc that swallows every kept declaration after it, with no ERROR node for an ERROR-only reparse to see',
  },
  {
    id: 'kotlin-survivor-marker-not-a-comment',
    file: 'lang/kotlin.ts',
    find: "  markerLeader: '// ',\n",
    replace: '',
    why: 'the kotlin marker landing as a bare `<<smelt/v1 …>>` line — the reparse scatters ERROR nodes across the kept declarations, exactly the non-local breakage the leader exists to prevent',
  },
  {
    id: 'php-survivor-marker-not-a-comment',
    file: 'lang/php.ts',
    find: "  markerLeader: '// ',\n",
    replace: '',
    why: "the php marker landing bare — php reads the marker's own `<<` as an operator and re-types the kept function into an expression operand, so the kept declaration is no longer a declaration in the survivor",
  },
  {
    id: 'apply-default-marker-ignores-language',
    file: 'apply.ts',
    find: '  const buildMarker = options.marker ?? markerForLanguage(plan.language);',
    replace: '  const buildMarker = options.marker ?? defaultMarker;',
    why: 'bare applyPlan reverted to the bare marker — the documented planStructural → applyPlan composition would land `<<smelt/v1…>>` in a python survivor and break its parse',
  },
];
