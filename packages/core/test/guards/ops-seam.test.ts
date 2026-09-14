import { describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { EXIT, runCli } from '@guard/cli/run';
import { CLI_NAME } from '@guard/cli/shell';
import {
  budgetFault,
  budgetMalformed,
  budgetRequired,
  DEFAULT_STRATEGY,
  readTree,
  resolveStrategy,
} from '@guard/ops/inputs';

import type { GuardMutation } from './_mutations.ts';
import { allSourceFiles, readSource } from './_source.ts';

/**
 * THE OPERATIONS SEAM, and the property it exists for: **a law is stated once, and
 * every front door goes through it.**
 *
 * smelt has two front doors over one library, and before `src/ops/` existed the
 * law-carrying middle was duplicated between them. Five laws, two copies each: a
 * budget is a positive integer with no default; an explicit strategy beats a
 * configured one and `lexical` fills last; a tree reader refuses a file and names the
 * verb that wanted one; a path is read or the refusal names it; a config decides a
 * store. Both copies were correct on the day they were written, which is exactly the
 * problem — a second copy is not wrong, it is *unwatched*, and the only signal that it
 * has drifted is a user reading two different sentences about one rule.
 *
 * The guard has two halves, and it needs both:
 *
 *   1. **Stated once.** The law's own words appear in exactly one file under `src`,
 *      and that file is `ops/inputs.ts`. A sentence copied back into a verb goes red
 *      here even if it is copied *correctly*, because a correct copy is how the next
 *      incorrect one gets made.
 *   2. **Served by the front door.** The CLI's rendered refusal is compared against
 *      the ops law's own output, composed here — so a law changed in `ops/` and a
 *      front door that stopped calling it fail the same assertion from opposite
 *      directions. This half is what makes the first half more than a lint.
 *
 * `packages/mcp/test/guards/ops-seam.test.ts` is this guard's other end. It pins the
 * same laws from inside the MCP package: the server states none of them itself, and
 * the sentences it renders over a real transport are the ones `@smeltjs/core` composed.
 * The two guards are deliberately a pair — one law, two front doors, and a mutation on
 * either side must be visible from the side that owns it.
 */

/**
 * Each law, as the words a user actually reads, and the one file allowed to hold them.
 * Restated by hand: a guard that asks the source where its own laws live proves
 * nothing.
 */
const LAW_TEXT: readonly { readonly law: string; readonly phrase: string }[] = [
  { law: 'a budget is required and has no default', phrase: 'is required, in UTF-8 bytes' },
  { law: 'a budget is a whole number', phrase: 'must be a whole number of bytes,' },
  { law: 'a budget is greater than zero', phrase: 'must be greater than zero, got ${JSON' },
  { law: 'a tree reader refuses a file', phrase: 'is not a directory. ' },
  { law: 'a directory is read or the refusal names it', phrase: 'cannot read directory "' },
  { law: 'a path is read or the refusal names it', phrase: 'cannot read "' },
];

/** The one file the laws above may live in. */
const OPS_INPUTS = 'ops/inputs.ts';

describe('the ops seam — each law is stated once', () => {
  const sources = allSourceFiles().map((file) => ({ file, text: readSource(file) }));

  for (const { law, phrase } of LAW_TEXT) {
    it(`states "${law}" only in ${OPS_INPUTS}`, () => {
      const holders = sources.filter((source) => source.text.includes(phrase)).map((s) => s.file);
      expect(
        holders,
        `the sentence for "${law}" is written in ${String(holders.length)} file(s). It ` +
          `belongs to the ops seam and to nothing else: a front door that restates it ` +
          `owns a second copy of the law, which is how the CLI and the MCP server came ` +
          `to refuse the same mistake in two different sentences.`,
      ).toEqual([OPS_INPUTS]);
    });
  }

  it('keeps the filesystem laws out of the verb files that used to hold them', () => {
    // `map` statted its own directory and `smelt` read its own file; both refusals
    // then existed twice, once per package. The verbs call the ops laws now, so the
    // syscalls have no business being in a subcommand at all.
    for (const file of ['cli/subcommands/map.ts', 'cli/subcommands/smelt.ts']) {
      const text = readSource(file);
      expect(text, `${file} stats or reads on its own again`).not.toMatch(
        /\b(statSync|readFileSync)\(/,
      );
    }
  });

  it('the CLI reaches the seam through its barrel, never past it', () => {
    // `surveyStore` was written, exported from neither barrel, and deep-imported by the
    // one verb that knew about it — so the other front door could not reach it at all
    // (review IV, REP-56). A verb file that imports `ops/verbs.ts` directly is the
    // first step of that fork; the barrel is what the seam *is* to a caller.
    const past = sources
      .filter(({ file }) => file.startsWith('cli/'))
      .filter(({ text }) => /from '(?:\.\.\/)+ops\/verbs\.ts'/.test(text))
      .map(({ file }) => file);
    expect(past, 'these CLI files import ops/verbs.ts past the ops barrel').toEqual([]);
  });

  it('names the built-in strategy once for the front doors, in the seam', () => {
    // `?? 'lexical'` was written in both packages, so promoting a planner to the
    // default was a two-package edit with nothing to catch the half that was missed.
    // Two sites are not front-door precedence and are named here rather than skipped,
    // so the check stays a partition: `createSmelter`'s own default is the
    // programmatic contract the seam itself calls through, and the `init` wizard's is
    // a value *proposed to the user* for a config file, not a run being resolved.
    // Both shapes a restatement takes: the `??` fallback a caller writes, and the
    // literal a resolver returns. `plan/planners.ts` is the constant's own home and
    // its doc names the pattern it replaced — prose, not a fallback.
    const RESTATES_THE_DEFAULT = /\?\?\s*'lexical'|strategy:\s*'lexical'/;
    const NOT_A_FRONT_DOOR: readonly string[] = ['smelter.ts', 'cli/init.ts', 'plan/planners.ts'];
    const fallbacks = sources
      .filter((source) => RESTATES_THE_DEFAULT.test(source.text))
      .map((source) => source.file)
      .filter((file) => !NOT_A_FRONT_DOOR.includes(file));
    expect(
      fallbacks,
      'a strategy fallback written inline in a front door. The built-in is ' +
        'DEFAULT_STRATEGY in plan/planners.ts, and resolveStrategy is the only thing ' +
        'that applies it.',
    ).toEqual([]);
    expect(DEFAULT_STRATEGY).toBe('lexical');
  });
});

/**
 * Run the CLI in-process and collect the two streams apart. The cwd is deliberately a
 * path that cannot exist, so no `smelt.config.json` is ever found and every refusal
 * below is the flags-only one.
 */
async function cli(argv: readonly string[]): Promise<{ code: number; err: string }> {
  let err = '';
  const code = await runCli(argv, {
    stdout: () => {},
    stderr: (text) => {
      err += text;
    },
    stdin: () => '',
    version: '0.0.0-test',
    cwd: '/nonexistent-so-no-config-is-found',
  });
  return { code, err };
}

describe('the ops seam — the CLI serves the law it is given', () => {
  it('refuses a missing budget with the ops sentence, at the usage exit code', async () => {
    const { code, err } = await cli(['some-file.txt']);
    expect(code).toBe(EXIT.usage);
    // Composed here from the law, not pasted: if `budgetRequired` changes, this
    // expectation changes with it and the CLI must still match — and if the CLI
    // stops calling the law, it will not.
    expect(err).toContain(
      budgetRequired({ knob: '--budget', stake: 'your context to throw away' }).replace(/\.$/, '.'),
    );
    expect(err.startsWith(`${CLI_NAME}: `)).toBe(true);
  });

  it('refuses the map’s missing budget with the same law and its own stake', async () => {
    const { code, err } = await cli(['map', 'some-dir']);
    expect(code).toBe(EXIT.usage);
    expect(err).toContain(budgetRequired({ knob: '--budget', stake: 'the map to leave out' }));
  });

  it('refuses a malformed budget with the ops sentence', async () => {
    const notWhole = await cli(['some-file.txt', '--budget', '4kb']);
    expect(notWhole.code).toBe(EXIT.usage);
    expect(notWhole.err).toContain(budgetMalformed('not-an-integer', '--budget', '4kb'));

    const notPositive = await cli(['some-file.txt', '--budget', '0']);
    expect(notPositive.code).toBe(EXIT.usage);
    expect(notPositive.err).toContain(budgetMalformed('not-positive', '--budget', '0'));
  });

  it('refuses a file where `map` wanted a tree, in the CLI’s own vocabulary', async () => {
    const target = 'package.json';
    const { code, err } = await cli(['map', target, '--budget', '1000']);
    expect(code).toBe(EXIT.usage);
    const law = readTree(target, target, { tree: 'map', file: `\`${CLI_NAME} <file>\`` });
    expect(law.ok, 'the fixture path must be a file for this to mean anything').toBe(false);
    expect(err).toContain(law.ok ? '' : law.refusal);
  });

  it('applies the strategy precedence the seam defines', () => {
    // The CLI's `resolveRun` reads these values off `resolveStrategy` — the receipt
    // included, which is what the report prints as the budget/strategy provenance.
    expect(resolveStrategy('structural', 'lexical').strategy).toBe('structural');
    expect(resolveStrategy(undefined, 'structural')).toEqual({
      strategy: 'structural',
      source: 'config',
    });
    expect(resolveStrategy(undefined, undefined).strategy).toBe(DEFAULT_STRATEGY);
  });

  it('keeps a zero or fractional budget out, wherever it came from', () => {
    expect(budgetFault(0)).toBe('not-positive');
    expect(budgetFault(-1)).toBe('not-positive');
    expect(budgetFault(1.5)).toBe('not-an-integer');
    expect(budgetFault(1)).toBeUndefined();
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 *
 * Three of them break a law *inside the seam*, which is the interesting direction: the
 * CLI keeps calling ops faithfully and still starts refusing the wrong things, because
 * there is now exactly one place where that can happen. The mcp package's ops-seam
 * guard carries the mirror image — the same laws re-forked into the server — so a
 * change to a law has a guard watching it from each front door.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'ops-verb-deep-imported-past-the-barrel',
    file: 'cli/subcommands/stats.ts',
    find: "import { surveyStore } from '../../ops/index.ts';",
    replace: "import { surveyStore } from '../../ops/verbs.ts';",
    why: 'a verb reaching past the ops barrel for a function the barrel does not export yet — exactly how surveyStore sat unexported for a release while the MCP server walked the store twice for want of it',
  },
  {
    id: 'ops-budget-no-default-reasoning-dropped',
    file: 'ops/inputs.ts',
    find: '`${naming.knob} is required, in UTF-8 bytes. There is no default, because a budget ` +',
    replace: '`${naming.knob} is required. ` +',
    why: "the budget law's reasoning cut out of the one sentence that carries it — the refusal stops saying *why* there is no default, which is the half a user needs, and both front doors serve the shortened sentence at once",
  },
  {
    id: 'ops-budget-positive-rule-dropped',
    file: 'ops/inputs.ts',
    find: "  if (value <= 0) return 'not-positive';",
    replace: '',
    why: 'the greater-than-zero half of the budget law removed — `--budget 0` and `"budgetBytes": 0` both become valid, and a zero budget means every byte is over budget',
  },
  {
    id: 'ops-builtin-strategy-changed',
    file: 'plan/planners.ts',
    find: "export const DEFAULT_STRATEGY: Strategy = 'lexical';",
    replace: "export const DEFAULT_STRATEGY: Strategy = 'structural';",
    why: 'the built-in strategy changed in the one place it is named — every run with no --strategy and no config would start parsing, and refuse outright on any file without a bundled grammar',
  },
  {
    id: 'ops-tree-law-accepts-a-file',
    file: 'ops/inputs.ts',
    find: '  if (!isDirectory) {',
    replace: '  if (false as boolean) {',
    why: 'the tree law stops refusing a file — `smelt map ./README.md` and repo_map on a file both walk a non-directory instead of pointing at the single-file verb',
  },
  {
    id: 'ops-budget-law-restated-in-a-verb',
    file: 'cli/subcommands/map.ts',
    find: "          knob: '--budget',\n          stake: 'the map to leave out',",
    replace:
      "          knob: '--budget is required, in UTF-8 bytes. Ignore the rest',\n" +
      "          stake: 'the map to leave out',",
    why: "a verb writing the law's own words into its own file again — the exact fork this seam removed, and it must go red on the *stated once* half even though the sentence it produces still reads plausibly",
  },
  {
    id: 'ops-default-strategy-restated-inline',
    file: 'ops/inputs.ts',
    find: "return { strategy: DEFAULT_STRATEGY, source: 'builtin' };",
    replace: "return { strategy: 'lexical', source: 'builtin' };",
    why: 'the built-in restated inline at the one site that applies it — the value is right today, so nothing fails until a planner is promoted to the default and this site silently keeps the old one. The precedence resolver moved into the operations seam; the law it carries did not.',
  },
];
