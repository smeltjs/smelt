import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken copy
// of `src` and watch it go red. See scripts/mutate.mjs.
import { assertKeyedById } from '@smelt/guard-kit';

import {
  AGENTS_LINT_RULES,
  AGENTS_RULES,
  IMPERATIVE_LINE_RULE,
  lintAgents,
  overBudgetBytes,
} from '@guard/agents/lint';
import { cliUsage } from '@guard/cli/args';
import { formatAgentsReport } from '@guard/cli/report';
import { readInstructionSet } from '@guard/agents/instructions';
import { planSplit, readSections, rewriteLinks } from '@guard/agents/split';
import { runAgentsSplit } from '@guard/cli/agents';
import { instructionSnippet } from '@guard/harness/snippet';
import { resolveAgentsRun } from '@guard/cli/subcommands/agents';
import { EXIT, runCli } from '@guard/cli/run';

import { STUB_ROOT, stubReader } from '../repo-reader-stub.ts';
import { allSourceFiles, readSource } from './_source.ts';
import type { GuardMutation } from './_mutations.ts';

/**
 * AGENTS-LINT GUARD — every claim `smelt agents` makes about somebody's instruction
 * files.
 *
 * This verb is unusual for smelt in that its whole output is *assertions about a file
 * the user wrote*. That raises the stakes on being right, and it makes the failure
 * modes quiet: a rule that stops matching, a resolver that says yes to everything, a
 * budget that acquires a default. Each of those leaves a lint that still runs, still
 * prints, still exits 0 — and has stopped telling the truth.
 *
 *  1. **Every rule fires, and fires on its own fixture.** One fixture repo per rule,
 *     crossed: rule R's fixture must produce R, and it must not be the case that some
 *     other rule is quietly doing all the work. A rule nobody has watched match is
 *     not a rule (the same argument as `pnpm mutate`, one level down).
 *  2. **`dead-path` resolves against the real tree** (ruling R3). The same token in
 *     the same prose is a finding in a tree without the file and silent in a tree
 *     with it — and the difference is made **at the reader**, counted call by call,
 *     so a resolver that stopped resolving cannot hide behind a passing assertion
 *     about text.
 *  3. **The budget is the user's, and there is no default** (ruling R2). No config,
 *     no budget, no failing exit — at any size. And nothing in `src/` compares the
 *     imperative count to the guide's cited 150-200: it is printed, never applied.
 *  4. **The merged set is a sum over levels, and a mirror is not a level** (R8). A
 *     nested AGENTS.md adds its bytes; a CLAUDE.md beside one does not.
 *  5. **Every finding is explainable** (Law 2): a rule id from the published list,
 *     a non-empty explanation, and an attribution — a finding that asserted the
 *     guide's opinion as smelt's would be the tool putting words in its source's
 *     mouth.
 *  6. **`--strict` is the only thing that turns a finding into a failure**, and an
 *     exceeded *user* budget fails without it, exactly as every other smelt budget
 *     does.
 *  7. **`split` never overwrites without a per-file yes** — the law `init` and
 *     `hooks` live under, restated here because this command rewrites a file
 *     somebody wrote by hand.
 *  8. **`split` does not mint the finding it reports.** A section moved into `docs/`
 *     takes its relative links with it, so linting the result produces no `dead-link`
 *     that the tool itself created.
 *
 * The MUTATIONS export at the bottom proves each of these can go red.
 */

/* ------------------------------------------------------------------------------------
 * A fixture repo per rule, as a stub tree — so the walk and the resolution are both
 * asserted through the injectable seam rather than against a directory on disk.
 * ---------------------------------------------------------------------------------- */

/** The tree every fixture hangs its instruction file in. `docs/real.md` resolves. */
const REAL_FILES = {
  'README.md': { kind: 'file' as const, content: '# real\n' },
  'docs/real.md': { kind: 'file' as const, content: '# real doc\n' },
  'src/kept.ts': { kind: 'file' as const, content: 'export const kept = 1;\n' },
};

function fixture(agentsMd: string, extra: Record<string, { kind: 'file'; content: string }> = {}) {
  return stubReader({
    ...REAL_FILES,
    ...extra,
    'AGENTS.md': { kind: 'file', content: agentsMd },
  });
}

function lintFixture(
  agentsMd: string,
  extra?: Record<string, { kind: 'file'; content: string }>,
): ReturnType<typeof lintAgents> {
  return lintAgents({ root: STUB_ROOT, reader: fixture(agentsMd, extra) });
}

/** Which rules a fixture produced, deduplicated and sorted. */
function rulesIn(report: ReturnType<typeof lintAgents>): readonly string[] {
  return [...new Set(report.findings.map((finding) => finding.reason.rule))].toSorted();
}

/** The bytes a string costs on disk — what every figure in this report is counted in. */
function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * One fixture per rule: the prose that must trip it. Restated by hand — a rule list
 * that generated its own fixtures would prove only that the generator ran.
 */
const FIXTURES: readonly (readonly [string, string])[] = [
  ['dead-path', '# p\n\nThe handler lives in `src/auth/handlers.ts`.\n'],
  ['dead-link', '# p\n\nSee [the conventions](docs/CONVENTIONS.md).\n'],
  ['forcing-language', '# p\n\nAlways run the formatter before you commit.\n'],
  ['structure-dump', '# p\n\n```\nsrc/\n├── kept.ts\n└── other.ts\n```\n'],
  ['generated-boilerplate', '# p\n\n<!-- generated by codex init -->\n'],
  ['language-rule', '# p\n\nUse `const` rather than `let` in new code.\n'],
  [
    'blanket-read',
    '# p\n\nRead `docs/architecture.md`, `docs/database.md` and `docs/deployment.md` before making changes.\n',
  ],
];

describe('every advisory rule fires, on prose written to trip exactly it', () => {
  it.each(FIXTURES)('%s fires on its own fixture', (rule, markdown) => {
    const report = lintFixture(markdown);
    expect(
      rulesIn(report),
      `${rule} did not fire — a rule nobody has watched match is not a rule`,
    ).toContain(rule);
  });

  it('publishes exactly the nine rules the help and the docs name', () => {
    // Restated by hand: the registry must not be its own witness.
    expect([...AGENTS_LINT_RULES].toSorted()).toEqual([
      'blanket-read',
      'dead-link',
      'dead-path',
      'forcing-language',
      'generated-boilerplate',
      'language-rule',
      'mirror-drift',
      'restated-at-level',
      'structure-dump',
    ]);
    // The imperative counter is deliberately NOT among them: it is a measurement, and
    // as a finding it would make --strict red on every real instruction file.
    expect(
      (AGENTS_LINT_RULES as readonly string[]).includes(IMPERATIVE_LINE_RULE),
      'imperative-line became a finding — --strict is now useless on any real file',
    ).toBe(false);
  });

  it('keeps its rules in one registry, keyed by their own ids, in report order', () => {
    // The same totality discipline HARNESS_PROFILES, SUBCOMMANDS and PLANNERS live
    // under: a rule is one entry, its key is its id, and the report order is the key
    // order — declared once. The list of ids is derived from the table, never restated
    // beside it, so the two cannot disagree.
    assertKeyedById(AGENTS_RULES, 'id');
    expect([...AGENTS_LINT_RULES]).toEqual(Object.keys(AGENTS_RULES));
    // The help prints the registry, not a hand-kept sentence: every id, every meaning.
    const usage = cliUsage();
    for (const rule of Object.values(AGENTS_RULES)) {
      expect(usage, `the help does not name ${rule.id}`).toContain(rule.id);
      const line = usage.split('\n').find((one) => one.includes(rule.meaning));
      expect(line, `the help does not say what ${rule.id} means`).toBeDefined();
      // The help is read in an eighty-column terminal; a meaning is one line of it.
      expect(line?.length ?? 0, `the ${rule.id} line overflows eighty columns`).toBeLessThanOrEqual(
        80,
      );
    }
    for (const rule of Object.values(AGENTS_RULES)) {
      expect(rule.meaning.length, `${rule.id} states no meaning`).toBeGreaterThan(20);
      expect(['file', 'level', 'set']).toContain(rule.scope);
    }
  });

  it('counts its own rules in the no-findings line, from the registry', () => {
    const text = formatAgentsReport(lintFixture('# p\n\nA project.\n'), {
      source: 'p',
      strict: false,
    });
    expect(text).toContain(`${String(AGENTS_LINT_RULES.length)} advisory rules ran`);
  });

  it('blanket-read: the article’s rewrite passes, and so does a pointer to one document', () => {
    // The shape the article recommends in place of the blanket read — a trigger per
    // document — and the shape smelt's own AGENTS.md uses ("Read this before renaming
    // anything", one document, one occasion). Neither is a tour.
    const passing = lintFixture(
      '# p\n\nUse `docs/architecture.md` for service boundaries, `docs/database.md` for schema changes.\n' +
        '\n- [CONTEXT.md](CONTEXT.md) — the vocabulary. Read this before renaming anything.\n',
      {
        'docs/architecture.md': { kind: 'file', content: '' },
        'docs/database.md': { kind: 'file', content: '' },
        'CONTEXT.md': { kind: 'file', content: '' },
      },
    );
    expect(rulesIn(passing)).not.toContain('blanket-read');
    // The failing shape names its documents in the finding, so the reader can see the tour.
    const failing = lintFixture(
      '# p\n\nAlways read `docs/a.md`, `docs/b.md` and `docs/c.md` before you start.\n',
      {
        'docs/a.md': { kind: 'file', content: '' },
        'docs/b.md': { kind: 'file', content: '' },
        'docs/c.md': { kind: 'file', content: '' },
      },
    );
    const found = failing.findings.filter((one) => one.reason.rule === 'blanket-read');
    expect(found, 'the tour fires once, on its one line').toHaveLength(1);
    expect(found[0]!.reason.explanation).toContain('3 documents');
    expect(found[0]!.reason.explanation).toContain("OpenAI's GPT-6 Astra notes");
    // A trailing filler is not a trigger; a trigger per document is; an opening occasion is.
    const docs = {
      'docs/a.md': { kind: 'file' as const, content: '' },
      'docs/b.md': { kind: 'file' as const, content: '' },
    };
    const rulesOf = (markdown: string): readonly string[] => rulesIn(lintFixture(markdown, docs));
    expect(
      rulesOf('# p\n\nRead `docs/a.md` and `docs/b.md` for context before you start.\n'),
    ).toContain('blanket-read');
    expect(
      rulesOf('# p\n\nRead `docs/a.md` for the schema, `docs/b.md` for the routes.\n'),
    ).not.toContain('blanket-read');
    expect(
      rulesOf('# p\n\nBefore touching the schema, read `docs/a.md` and `docs/b.md`.\n'),
    ).not.toContain('blanket-read');
  });

  it('the marker block smelt setup writes mints no finding when the linter reads it', () => {
    // The installer and the linter are two halves of one product; the block the first
    // writes into a user's instruction file must not be something the second reports.
    // Ruled out here, at the default threshold and budget, for both scopes.
    for (const scope of ['project', 'user'] as const) {
      const report = lintFixture(
        `# p\n\nA project.\n\n${instructionSnippet(8192, 8000, '1.2.3', scope)}` +
          // A prohibition that names two files is not a tour either — the block's own
          // "do not read … raw" shape, with paths that exist so dead-path stays quiet.
          '\nDo not read `dist/bundle.js` and `pnpm-lock.yaml` raw.\n',
        {
          'dist/bundle.js': { kind: 'file', content: '' },
          'pnpm-lock.yaml': { kind: 'file', content: '' },
        },
      );
      expect(
        report.findings.map((one) => `${one.reason.rule}: ${one.reason.explanation}`),
        `the ${scope}-scope marker block trips the linter`,
      ).toEqual([]);
    }
  });

  it('mints no finding on a file written to the guide’s own minimum', () => {
    // The dogfood shape (ruling R9): one sentence, the package manager, the
    // non-standard gate, two pointers. Every pointer resolves in the fixture tree.
    const report = lintFixture(
      '# p\n\nA project.\n\nPackage manager: pnpm.\n\n' +
        'Run `pnpm verify` from the root — it is the whole gate.\n\n' +
        '- [the readme](README.md) — what this is.\n' +
        '- [the docs](docs/real.md) — how it works.\n',
    );
    expect(
      report.findings,
      'a minimal, correct instruction file produced findings — either a rule is wrong or the guide is',
    ).toEqual([]);
    expect(report.imperatives.length, 'the imperative heuristic counted nothing').toBeGreaterThan(
      0,
    );
  });
});

describe('staleness is resolved against the real tree, at the reader (R3)', () => {
  it('the same token is dead in one tree and alive in another, decided by a stat', () => {
    const prose = '# p\n\nThe entry point is `src/entry.ts`.\n';

    const missing = fixture(prose);
    const dead = lintAgents({ root: STUB_ROOT, reader: missing });
    expect(rulesIn(dead)).toContain('dead-path');

    const present = fixture(prose, {
      'src/entry.ts': { kind: 'file', content: 'export const entry = 1;\n' },
    });
    const alive = lintAgents({ root: STUB_ROOT, reader: present });
    expect(
      rulesIn(alive),
      'the token resolves in this tree, so reporting it stale is a false accusation',
    ).not.toContain('dead-path');

    // The difference was made through the seam, not by inspecting the string: both
    // readers were asked about the exact path, and the answers differ.
    expect(missing.opsFor('src/entry.ts')).toContain('stat');
    expect(present.opsFor('src/entry.ts')).toContain('stat');
  });

  it('never accuses a URL, a package name, a glob, a bare domain or a product name', () => {
    // Every one of these is prose a real AGENTS.md contains, and every one of them is
    // shaped like a path. The last two are the ones that made this rule libellous:
    // `Node.js` is a bare word ending in a code extension, and `aihero.dev/…` — the
    // guide smelt's own help text prints — is a URL with its scheme left off.
    const report = lintFixture(
      '# p\n\nSee https://example.com/docs/missing.md and `@scope/nowhere`,\n' +
        'and every `src/**/*.ts` in the tree.\n\n' +
        'Built with Node.js and Vue.js, run under Bun.sh.\n' +
        'The guide is at aihero.dev/a-complete-guide-to-agents-md, and\n' +
        'example.com/guide has more.\n',
    );
    expect(
      report.findings
        .filter((finding) => finding.reason.rule === 'dead-path')
        .map((finding) => finding.reason.explanation),
      'a URL, a package name, a glob, a bare domain or a product name was reported as a stale path',
    ).toEqual([]);
  });

  it('still catches the path that is actually stale, in the same prose', () => {
    // The guard above must not pass by turning dead-path off. A backticked token with a
    // separator is the shape this rule exists for, and it still fires beside the prose.
    const report = lintFixture(
      '# p\n\nBuilt with Node.js. The handler is in `src/auth/handlers.ts`.\n',
    );
    expect(rulesIn(report)).toContain('dead-path');
  });

  it('never reports a live file as dead because of how the link was written', () => {
    // CommonMark angle-bracket destinations: the brackets are delimiters, not path.
    const report = lintFixture('# p\n\nSee [the module](<src/kept.ts>) here.\n');
    expect(
      report.findings.filter((finding) => finding.reason.rule === 'dead-link'),
      'a link to a file that exists was reported dead — the false accusation this rule cannot make',
    ).toEqual([]);
  });

  it('a moved doc is caught as dead-link, and reported once — never also as dead-path', () => {
    const report = lintFixture('# p\n\nSee [the guide](docs/gone.md) for more.\n');
    const rules = report.findings.map((finding) => finding.reason.rule);
    expect(rules).toContain('dead-link');
    expect(
      rules.filter((rule) => rule === 'dead-path'),
      'one dead pointer was reported twice, under two rules',
    ).toEqual([]);
  });
});

describe('the budget is the user’s, and smelt has none of its own (R2)', () => {
  it('reports no budget and fails nothing, however large the file', () => {
    const huge = `# p\n\n${'A sentence about the project. '.repeat(400)}\n`;
    const report = lintFixture(huge);
    expect(report.totalBytes).toBeGreaterThan(10_000);
    expect(report.budgetBytes, 'a budget appeared from nowhere').toBeUndefined();
    expect(overBudgetBytes(report), 'an unbudgeted file was called over budget').toBeUndefined();
  });

  it('takes the budget only from the config, and carries it verbatim', () => {
    const withBudget = resolveAgentsRun(
      { mode: 'agents', action: 'lint', dir: '.', strict: false, json: false },
      { path: '/repo/smelt.config.json', config: { smeltConfig: 1, agents: { budgetBytes: 900 } } },
    );
    expect(withBudget.budgetBytes).toBe(900);

    const without = resolveAgentsRun(
      { mode: 'agents', action: 'lint', dir: '.', strict: false, json: false },
      { path: '/repo/smelt.config.json', config: { smeltConfig: 1 } },
    );
    expect(
      without.budgetBytes,
      'a config with no agents block produced a budget — a ceiling nobody chose',
    ).toBeUndefined();
    expect(
      resolveAgentsRun(
        { mode: 'agents', action: 'lint', dir: '.', strict: false, json: false },
        undefined,
      ).budgetBytes,
      'no config at all produced a budget',
    ).toBeUndefined();
  });

  it('never compares the imperative count to the guide’s cited figure', () => {
    // The figure is a citation (R2, R6). Any arithmetic against it in `src` would turn
    // somebody else's rule of thumb into smelt's threshold, silently.
    const offenders = allSourceFiles().filter((file) =>
      /(?:imperatives?|instructionCeiling)[^\n]*[<>]=?\s*\d|[<>]=?\s*(?:150|200)\b/.test(
        readSource(file),
      ),
    );
    expect(
      offenders,
      'the imperative count is being compared to a number — measure, never threshold',
    ).toEqual([]);
  });
});

describe('the merged set is the sum, and a mirror is not a level (R8, R4)', () => {
  it('adds a nested level’s bytes, and reports each level separately', () => {
    const root = '# root\n\nA project.\n';
    const nested = '# nested\n\nThe core package.\n';
    const report = lintAgents({
      root: STUB_ROOT,
      reader: stubReader({
        ...REAL_FILES,
        'AGENTS.md': { kind: 'file', content: root },
        'packages/core/AGENTS.md': { kind: 'file', content: nested },
      }),
    });
    expect(report.levels.map((level) => level.path)).toEqual([
      'AGENTS.md',
      'packages/core/AGENTS.md',
    ]);
    expect(report.totalBytes, 'a nested level was not merged into the total').toBe(
      Buffer.byteLength(root, 'utf8') + Buffer.byteLength(nested, 'utf8'),
    );
  });

  it('counts a mirror’s bytes zero times, and notices when it has drifted', () => {
    const primary = '# root\n\nA project with a reasonably long sentence in it.\n';
    const drifted = '# root\n\nSomething else entirely, written months ago.\n';

    const copy = lintAgents({
      root: STUB_ROOT,
      reader: stubReader({
        ...REAL_FILES,
        'AGENTS.md': { kind: 'file', content: primary },
        'CLAUDE.md': { kind: 'file', content: primary },
      }),
    });
    expect(copy.totalBytes, 'a byte-identical mirror was summed as a second level').toBe(
      Buffer.byteLength(primary, 'utf8'),
    );
    expect(copy.levels[0]!.mirrors[0]!.standing).toBe('copy');
    expect(rulesIn(copy), 'an identical copy was called drift').not.toContain('mirror-drift');

    const diverged = lintAgents({
      root: STUB_ROOT,
      reader: stubReader({
        ...REAL_FILES,
        'AGENTS.md': { kind: 'file', content: primary },
        'CLAUDE.md': { kind: 'file', content: drifted },
      }),
    });
    expect(diverged.levels[0]!.mirrors[0]!.standing).toBe('drift');
    expect(rulesIn(diverged)).toContain('mirror-drift');
    expect(diverged.totalBytes, 'a drifted mirror was summed into the total').toBe(
      Buffer.byteLength(primary, 'utf8'),
    );
  });

  it('reports a line written at two levels once, against the deeper file', () => {
    const shared = 'The gate is `pnpm verify` and a change is not finished until it passes.\n';
    const report = lintAgents({
      root: STUB_ROOT,
      reader: stubReader({
        ...REAL_FILES,
        'AGENTS.md': { kind: 'file', content: `# root\n\n${shared}` },
        'packages/core/AGENTS.md': { kind: 'file', content: `# core\n\n${shared}` },
      }),
    });
    const restated = report.findings.filter(
      (finding) => finding.reason.rule === 'restated-at-level',
    );
    expect(restated).toHaveLength(1);
    expect(restated[0]!.file).toBe('packages/core/AGENTS.md');
    expect(restated[0]!.reason.explanation).toContain('AGENTS.md');
  });

  it('says nothing about a line two SIBLINGS share — siblings never merge', () => {
    // The explanation this rule prints asserts a merge relationship. Between `pkg/a`
    // and `pkg/b` there is none: no agent ever loads both, so the sentence would be
    // false, and a finding whose explanation is false is worse than no finding (Law 2).
    const shared = 'The gate is `pnpm verify` and a change is not finished until it passes.\n';
    const report = lintAgents({
      root: STUB_ROOT,
      reader: stubReader({
        ...REAL_FILES,
        'AGENTS.md': { kind: 'file', content: '# root\n\nA project.\n' },
        'pkg/a/AGENTS.md': { kind: 'file', content: `# a\n\n${shared}` },
        'pkg/b/AGENTS.md': { kind: 'file', content: `# b\n\n${shared}` },
      }),
    });
    expect(
      report.findings.filter((finding) => finding.reason.rule === 'restated-at-level'),
      'a line shared by two siblings was reported as restated — the levels it names do not merge',
    ).toEqual([]);
  });

  it('counts a request as its own chain, and the tree as the tree (R8)', () => {
    const root = '# root\n\nA project.\n';
    const a = `# a\n\n${'x'.repeat(200)}\n`;
    const b = `# b\n\n${'y'.repeat(300)}\n`;
    const report = lintAgents({
      root: STUB_ROOT,
      reader: stubReader({
        ...REAL_FILES,
        'AGENTS.md': { kind: 'file', content: root },
        'pkg/a/AGENTS.md': { kind: 'file', content: a },
        'pkg/b/AGENTS.md': { kind: 'file', content: b },
      }),
    });
    expect(report.totalBytes, 'the repository-wide surface is every level').toBe(
      utf8(root) + utf8(a) + utf8(b),
    );
    expect(
      report.perRequestBytes,
      'a per-request cost summed two siblings — a number nobody pays',
    ).toBe(utf8(root) + utf8(b));
  });

  it('walks through the reader alone, and never enters an ignored directory', () => {
    const reader = stubReader({
      ...REAL_FILES,
      'AGENTS.md': { kind: 'file', content: '# root\n\nA project.\n' },
      'node_modules/dep/AGENTS.md': { kind: 'file', content: "# somebody else's rules\n" },
    });
    const report = readInstructionSet({ root: STUB_ROOT, reader });
    expect(
      report.levels.map((level) => level.primary.path),
      "a vendored AGENTS.md was counted as this repository's instruction to an agent",
    ).toEqual(['AGENTS.md']);
    expect(reader.opsFor('node_modules'), 'an ignored path was statted').toEqual([]);
    expect(reader.opsFor('node_modules/dep/AGENTS.md')).toEqual([]);
  });
});

describe('every finding explains itself, and attributes what it borrowed (Law 2)', () => {
  it('carries a published rule id, a real sentence, and the guide it cites', () => {
    const report = lintFixture(
      '# p\n\nAlways use `const` over `let`; see [gone](docs/gone.md) and `src/gone.ts`.\n' +
        '\n<!-- generated by claude init -->\n',
    );
    expect(report.findings.length, 'this guard would be vacuous').toBeGreaterThan(3);
    for (const finding of report.findings) {
      expect(AGENTS_LINT_RULES as readonly string[], finding.reason.rule).toContain(
        finding.reason.rule,
      );
      expect(finding.reason.explanation.length, finding.reason.rule).toBeGreaterThan(40);
      // Whose sentence the finding leans on — the guide, or for blanket-read the
      // article — and it is the tail, so a reader finds it where every other one is.
      const source =
        finding.reason.rule === 'blanket-read'
          ? "OpenAI's GPT-6 Astra notes"
          : 'the AGENTS.md guide';
      expect(
        finding.reason.explanation,
        `${finding.reason.rule} states an opinion without saying whose it is`,
      ).toMatch(new RegExp(` — ${source.replace(/'/g, "\\'")}: ".*"$`, 'u'));
      expect(finding.line, finding.reason.rule).toBeGreaterThan(0);
    }
  });

  it('says out loud which rule is the softest', () => {
    const soft = lintFixture('# p\n\n<!-- generated by codex init -->\n').findings.find(
      (finding) => finding.reason.rule === 'generated-boilerplate',
    );
    expect(soft?.reason.explanation, 'the softest rule stopped admitting it').toContain(
      'softest rule',
    );
  });

  it('labels the imperative count a heuristic and names the verb it matched', () => {
    const report = lintFixture('# p\n\nRun the formatter.\nNever skip the gate.\n');
    expect(report.imperatives.map((line) => line.reason.rule)).toEqual([
      IMPERATIVE_LINE_RULE,
      IMPERATIVE_LINE_RULE,
    ]);
    expect(report.imperatives[0]!.reason.explanation).toContain('"run"');
    expect(report.imperatives[0]!.reason.explanation).toContain('heuristic');
  });
});

/* ------------------------------------------------------------------------------------
 * The CLI: exit codes, and the consent discipline
 * ---------------------------------------------------------------------------------- */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-agents-guard-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function cli(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    stdin: () => '',
    version: '9.9.9-test',
    cwd: dir,
  });
  return { code, stdout };
}

describe('the exit codes say exactly what happened', () => {
  const withFindings = '# p\n\nAlways check `src/gone.ts` before you start.\n';

  it('findings alone exit 0; --strict makes the same findings exit 1', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), withFindings);

    const advisory = await cli(['agents', 'lint', dir]);
    expect(advisory.code, 'an advisory rule failed a run nobody asked to be strict').toBe(EXIT.ok);
    expect(advisory.stdout).toContain('dead-path');

    const strict = await cli(['agents', 'lint', dir, '--strict']);
    expect(strict.code, '--strict did not turn a finding into a failure').toBe(EXIT.overBudget);
  });

  it('a clean tree exits 0 with --strict — strict is not "always fail"', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# p\n\nA project. Package manager: pnpm.\n');
    const { code } = await cli(['agents', 'lint', dir, '--strict']);
    expect(code).toBe(EXIT.ok);
  });

  it('exceeding the user’s own budget exits 1 with or without --strict', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), `# p\n\n${'A plain sentence. '.repeat(30)}\n`);
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, agents: { budgetBytes: 50 } })}\n`,
    );
    const { code, stdout } = await cli(['agents', 'lint', dir]);
    expect(code, 'the budget the user committed to the repo failed nothing').toBe(EXIT.overBudget);
    expect(stdout).toContain('OVER BUDGET');
  });

  it('an empty tree is a fine state, not a failure', async () => {
    const { code, stdout } = await cli(['agents', 'lint', dir]);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('nothing to measure');
  });

  it('the --json envelope is versioned and carries every finding’s rule id', async () => {
    writeFileSync(join(dir, 'AGENTS.md'), withFindings);
    const { stdout } = await cli(['agents', 'lint', dir, '--json']);
    const envelope = JSON.parse(stdout) as {
      format: string;
      report: { findings: { reason: { rule: string } }[] };
    };
    expect(envelope.format).toBe('smelt-agents-cli/v1');
    expect(envelope.report.findings.map((finding) => finding.reason.rule)).toContain('dead-path');
  });
});

describe('split writes nothing without consent, and mints no finding of its own', () => {
  const bloated =
    '# p\n\nA project.\n\n## Style\n\nUse tabs. See [the readme](README.md).\n\n' +
    '## Testing\n\nRun vitest against `src/kept.ts`.\n';

  async function split(answers: readonly string[]): Promise<string> {
    let output = '';
    await runAgentsSplit({
      input: Readable.from([`${answers.join('\n')}\n`]),
      output: (text) => {
        output += text;
      },
      cwd: dir,
      dir: '.',
    });
    return output;
  }

  beforeEach(() => {
    writeFileSync(join(dir, 'AGENTS.md'), bloated);
    writeFileSync(join(dir, 'README.md'), '# readme\n');
  });

  it('anything but a literal yes leaves the hand-written file byte for byte', async () => {
    for (const refusal of ['no', '', 'y', 'ok', 'overwrite']) {
      const output = await split(['yes', refusal]);
      expect(output, refusal).toContain('AGENTS.md exists');
      expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8'), refusal).toBe(bloated);
      rmSync(join(dir, 'docs'), { recursive: true, force: true });
    }
  });

  it('writes nothing at all before the final confirm', async () => {
    const output = await split(['no']);
    expect(output).toContain('Nothing was written');
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toBe(bloated);
    expect(existsSync(join(dir, 'docs'))).toBe(false);
  });

  it('leaves behind a tree the lint has nothing new to say about', async () => {
    await split(['yes', 'yes']);
    // The link inside the moved section pointed at README.md from the root; from
    // docs/ it must point at ../README.md, or the split has minted the exact finding
    // this verb's flagship rule reports.
    expect(readFileSync(join(dir, 'docs/style.md'), 'utf8')).toContain('](../README.md)');
    const after = lintAgents({ root: dir });
    expect(
      after.findings.filter((finding) => finding.reason.rule === 'dead-link'),
      'the split broke a link it moved — the tool minted its own flagship finding',
    ).toEqual([]);
    expect(readFileSync(join(dir, 'AGENTS.md'), 'utf8')).toContain('[Style](docs/style.md)');
  });

  it('refuses a directory that is not there, naming it — never an internal error', async () => {
    await expect(
      runAgentsSplit({
        input: Readable.from(['yes\n']),
        output: () => {},
        cwd: dir,
        dir: 'nope',
      }),
      'a missing directory escaped as an unhandled ENOENT — smelt blaming itself for a typo',
    ).rejects.toThrow(/cannot read directory "nope"/);
  });

  it('prints the judgment half as the guide’s own prompt, with the real sections in it', async () => {
    const output = await split(['no']);
    expect(output).toContain('"Style"');
    expect(output).toContain('"Testing"');
    expect(output).toContain('aihero.dev/a-complete-guide-to-agents-md');
    expect(
      output,
      'the seam stopped being stated — a user cannot tell what smelt refused to do',
    ).toContain('did NOT decide which sections are essential');
  });

  it('refuses to invent a partition for a file with no sections', () => {
    const plan = planSplit({
      path: 'AGENTS.md',
      name: 'AGENTS.md',
      dir: '',
      text: '# p\n\nOne paragraph, no headings.\n',
      bytes: 34,
      symlink: false,
    });
    expect(plan.files).toEqual([]);
    expect(plan.refusal).toContain('nothing to partition by');
  });

  it('never splits on a heading inside a fence, and never climbs a link twice', () => {
    const sections = readSections('# p\n\n```md\n## Not a heading\n```\n\n## Real\n\nbody\n');
    expect(sections.map((section) => section.title)).toEqual(['Real']);
    expect(rewriteLinks('[a](x.md) [b](../y.md) [c](https://e.com) [d](#z) [e](docs/w.md)')).toBe(
      '[a](../x.md) [b](../y.md) [c](https://e.com) [d](#z) [e](w.md)',
    );
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'agents-blanket-read-calls-a-prohibition-a-tour',
    file: 'agents/lint.ts',
    find: '    if (!READ_VERBS.test(text) || NEGATED_READ.test(text) || LEADING_OCCASION.test(text)) continue;',
    replace: '    if (!READ_VERBS.test(text) || LEADING_OCCASION.test(text)) continue;',
    why: 'blanket-read firing on "do not read `dist/bundle.js` and `pnpm-lock.yaml`" — a prohibition read as a tour, with an explanation that says the line "directs a read" it forbids; the installer\u2019s own block is written in exactly this shape',
  },
  {
    id: 'agents-blanket-read-counts-the-last-document',
    file: 'agents/lint.ts',
    find: '    const untriggered = documents\n      .slice(0, -1)',
    replace: '    const untriggered = documents\n      .slice(0)',
    why: 'the last document on the line asked for a trigger it cannot have — nothing follows it — so the article\u2019s own recommended shape, "use X for service boundaries, Y for schema changes", is reported as the tour it was written to replace',
  },
  {
    id: 'agents-rule-registry-key-flipped',
    file: 'agents/lint.ts',
    find: '  [DEAD_LINK_RULE]: {\n    id: DEAD_LINK_RULE,',
    replace: '  [DEAD_LINK_RULE]: {\n    id: DEAD_PATH_RULE,',
    why: 'a registry entry whose key names one rule and whose id names another — the published id list now carries dead-path twice and dead-link never, the help prints the wrong id beside the dead-link meaning, and the keyed-by-id check the other registries already live under is what sees the key and the entry disagree',
  },
  {
    id: 'agents-rule-asleep-in-the-registry',
    file: 'agents/lint.ts',
    find: "    scope: 'file',\n    find: findLanguageRules,",
    replace: "    scope: 'never' as 'file',\n    find: findLanguageRules,",
    why: 'a rule present in the registry that the fold never runs — the id is still published, the help still names it, and the language-rule fixture that must fire goes quiet; the per-rule fixture is what notices a rule asleep',
  },
  {
    id: 'agents-dead-path-stops-resolving',
    file: 'agents/instructions.ts',
    find: '    return reader.stat(join(root, token)) !== undefined;',
    replace: '    return true;',
    why: 'the tree resolution wired to `true` — every path in every instruction file is declared alive, so `dead-path` and `dead-link` stop firing and the one check nobody else makes reports a clean bill of health on a file full of paths that moved two refactors ago',
  },
  {
    id: 'agents-budget-defaults-silently',
    file: 'cli/subcommands/agents.ts',
    find: '  const budgetBytes = config?.config.agents?.budgetBytes;',
    replace: '  const budgetBytes = config?.config.agents?.budgetBytes ?? 2000;',
    why: 'the lint acquires a built-in budget — a repository that set none now fails CI at a number smelt invented, which is precisely the "measure, never threshold" ruling reversed and the reason --budget has no default either',
  },
  {
    id: 'agents-mirror-summed-as-a-level',
    file: 'agents/instructions.ts',
    find: '    totalBytes: levels.reduce((sum, level) => sum + level.primary.bytes, 0),',
    replace: '    totalBytes: found.reduce((sum, file) => sum + file.bytes, 0),',
    why: "the merged-set total sums every file rather than each level's primary — a repo with AGENTS.md and a CLAUDE.md mirror is reported as costing twice what any single agent loads, so the one number the whole verb exists to state is inflated by an alias",
  },
  {
    id: 'agents-strict-ignores-findings',
    file: 'cli/subcommands/agents.ts',
    find: '  if (run.strict && report.findings.length > 0) return EXIT.overBudget;',
    replace: '  // strict removed',
    why: '--strict stops failing on findings — a CI job that was added to catch a stale AGENTS.md goes green forever, and the flag is a setting the user believed was in force',
  },
  {
    id: 'agents-findings-drop-their-attribution',
    file: 'agents/guide.ts',
    find: '  return ` — ${source}: "${quote}"`;',
    replace: "  return '';",
    why: "every explanation stops attributing the guide — smelt starts asserting somebody else's opinions about house style as its own findings, and a reader has no way to tell which half of a sentence is measured and which half is borrowed",
  },
  {
    id: 'agents-dead-path-accuses-prose',
    file: 'agents/lint.ts',
    find: '  return fromCodeSpan && !PRODUCT_NAME.test(token) && CODE_FILE.test(token);',
    replace: '  return CODE_FILE.test(token);',
    why: 'the flagship rule starts statting bare dotted words in running prose again — `Node.js`, `Vue.js` and `Bun.sh` are each reported as resolving to nothing in the tree, so the one rule --strict gates CI on accuses ordinary English and every real finding beside it stops being believed',
  },
  {
    id: 'agents-restated-fires-across-siblings',
    file: 'agents/lint.ts',
    find: '    const ancestors = ancestorDirs(level.dir);',
    replace: '    const ancestors = [...stated.keys()].filter((dir) => dir !== level.dir);',
    why: 'restated-at-level folds every level into one map again, so a line `pkg/a` and `pkg/b` happen to share is reported against `pkg/b` with an explanation asserting the two merge — they do not, no agent loads both, and a finding whose sentence is false is worse than no finding',
  },
  {
    id: 'agents-per-request-sums-the-whole-tree',
    file: 'agents/instructions.ts',
    find: '    perRequestBytes: heaviestChainBytes(levels),',
    replace: '    perRequestBytes: levels.reduce((sum, level) => sum + level.primary.bytes, 0),',
    why: 'the per-request figure becomes the whole-tree sum, so a monorepo is told every request costs the total of every package’s instruction file — a number no request pays, printed under the heading that promises it is what an agent loads on every request',
  },
  {
    id: 'agents-split-overwrite-without-consent',
    file: 'cli/agents.ts',
    find: '    if (file.exists && !(await askOverwrite(file.name, ask))) {',
    replace: '    if (false) {',
    why: 'the per-file overwrite consent wired shut — `smelt agents split` would rewrite a hand-written AGENTS.md after any answer, the same helpful-looking break `smelt init` and `smelt hooks` are guarded against, on the one file this verb exists to touch',
  },
  {
    id: 'agents-split-leaves-links-behind',
    file: 'agents/split.ts',
    find: '      return `${open}../${cleaned}${close}`;',
    replace: '      return whole;',
    why: 'a section moved into docs/ keeps its root-relative links — every one of them now resolves one directory too high, so the split mints the exact `dead-link` finding this verb reports, in the file it just wrote',
  },
];
