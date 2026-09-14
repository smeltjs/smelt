import { describe, expect, it } from 'vitest';

import type { GuardMutation } from './_mutations.ts';
import { allSourceFiles, readSource } from './_source.ts';

/**
 * THE OPERATIONS SEAM, from the far side — the other end of
 * `packages/core/test/guards/ops-seam.test.ts`.
 *
 * This package used to hold its own copy of the law-carrying half of smelt. Not by
 * accident and not by carelessness: `resolveStoreRun` was never exported from
 * `@smeltjs/core`, so the store law could not be imported, and once one law was being
 * re-derived here the rest followed — a budget check, a strategy fallback, a directory
 * stat, a file read, each written a second time in a second package. Every copy was
 * correct. Every copy was also unwatched, and the only thing that would ever have
 * reported a drift is a user reading two different sentences about one rule.
 *
 * So this guard pins the property that replaced them, from inside the package that
 * forked: **this server states no law of its own.** Three checks, and the third is
 * what makes the first two more than a lint:
 *
 *   1. **The laws' words are absent.** A sentence copied back here goes red on sight,
 *      even a correct copy — a correct copy is how the next incorrect one gets made.
 *   2. **The machinery is absent.** No stat, no blob read, no smelter, no repo map, no
 *      store construction, no strategy fallback. Each of those is something the ops
 *      seam already does, once, for both front doors.
 *   3. **The seam is called by name.** Absence alone would be satisfied by a server
 *      that does nothing; every ops function this package depends on is named here,
 *      so a law *dropped* rather than re-forked is just as red as one re-forked.
 *
 * **Why this guard reads source instead of driving the server.** The mutation runner
 * copies the owning package's `src` to a scratch tree and points the guard at it, so a
 * guard that *imports* the mutant would fail on module resolution rather than on the
 * mutation — red, but red for a reason that has nothing to do with the break, which is
 * the vacuous guard this repository refuses everywhere. `test/guards/no-network.test.ts`
 * reads source for the same reason. The behavioural half of the claim — that the
 * sentence a model reads over a real transport is byte-for-byte the one `@smeltjs/core`
 * composed — is asserted in `test/tools.test.ts`, which always runs against the real
 * tree and composes its expectations from the core's own law rather than pasting it.
 *
 * The two ops-seam guards are deliberately a pair, because the runner runs each
 * mutation against exactly one guard: break a law inside `ops/` and the core's guard
 * goes red through the CLI; re-fork it here and this one goes red through the server.
 * One law, two front doors, a guard watching from each.
 */

/**
 * The laws, as the words a user reads. None may appear in this package's source: they
 * belong to `@smeltjs/core`'s ops seam, and this server supplies only its own
 * vocabulary (`"budgetBytes"`, `repo_map`, `smelt_file`) into them.
 */
const LAW_TEXT: readonly { readonly law: string; readonly phrase: string }[] = [
  { law: 'a budget is required and has no default', phrase: 'is required, in UTF-8 bytes' },
  { law: 'a budget is a whole number', phrase: 'must be a whole number of bytes' },
  { law: 'a budget is greater than zero', phrase: 'must be greater than zero' },
  { law: 'a tree reader refuses a file', phrase: 'is not a directory' },
  { law: 'a directory is read or the refusal names it', phrase: 'cannot read directory' },
  { law: 'a path is read or the refusal names it', phrase: 'cannot read "' },
];

/**
 * Machinery whose presence means a verb is being rebuilt here rather than called.
 * Restated by hand, and deliberately blunt: the point is not that any of these is
 * dangerous, it is that the ops seam already does each one, once, for both front doors.
 */
const REBUILT_HERE: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: 'a directory stat of its own (readTree does this)', pattern: /\bstatSync\b/ },
  { what: 'a blob read of its own (readBlob does this)', pattern: /\breadFileSync\(\s*resolve/ },
  { what: 'a smelter of its own (smeltBlob does this)', pattern: /\bcreateSmelter\b/ },
  { what: 'a repo map of its own (mapTree does this)', pattern: /\bbuildRepoMap\b/ },
  {
    what: 'a store of its own (openStore does this)',
    pattern: /\bnew (Memory|Directory)ElisionStore\b/,
  },
  {
    what: 'a store path resolution of its own (configuredStore does this)',
    pattern: /\bresolveStorePath\b/,
  },
  {
    what: 'a strategy fallback of its own (resolveStrategy does this)',
    pattern: /\?\?\s*'lexical'/,
  },
];

/** Every ops function this package must reach for, and the file that must reach for it. */
const CALLS_THE_SEAM: readonly { readonly file: string; readonly call: string }[] = [
  { file: 'server.ts', call: 'budgetRequired(' },
  { file: 'server.ts', call: 'budgetMalformed(' },
  { file: 'server.ts', call: 'budgetFault(' },
  { file: 'server.ts', call: 'resolveStrategy(' },
  { file: 'server.ts', call: 'readBlob(' },
  { file: 'server.ts', call: 'readTree(' },
  { file: 'server.ts', call: 'smeltBlob(' },
  { file: 'server.ts', call: 'mapTree(' },
  { file: 'server.ts', call: 'retrieveBytes(' },
  { file: 'server.ts', call: 'surveyStore(' },
  { file: 'store.ts', call: 'configuredStore(' },
  { file: 'store.ts', call: 'openStore(' },
];

describe('the ops seam — this server states no law of its own', () => {
  const sources = allSourceFiles().map((file) => ({ file, text: readSource(file) }));

  for (const { law, phrase } of LAW_TEXT) {
    it(`does not restate "${law}"`, () => {
      const holders = sources.filter((source) => source.text.includes(phrase)).map((s) => s.file);
      expect(
        holders,
        `this package writes the sentence for "${law}" itself. That sentence belongs to ` +
          `@smeltjs/core's ops seam, which the CLI serves too — a copy here is a second ` +
          `law wearing the first one's words, and nothing would ever report the day they ` +
          `stopped agreeing.`,
      ).toEqual([]);
    });
  }

  for (const { what, pattern } of REBUILT_HERE) {
    it(`does not build ${what}`, () => {
      const holders = sources.filter((source) => pattern.test(source.text)).map((s) => s.file);
      expect(holders, `${what} — call the op instead`).toEqual([]);
    });
  }
});

describe('the ops seam — this server calls it by name', () => {
  for (const { file, call } of CALLS_THE_SEAM) {
    it(`${file} calls ${call}…)`, () => {
      expect(
        readSource(file),
        `${file} no longer calls ${call}). A law dropped is as bad as a law re-forked: ` +
          `the CLI would go on refusing what this tool quietly accepts.`,
      ).toContain(call);
    });
  }
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `packages/mcp/src` and asserts this file goes red — see `_mutations.ts`.
 *
 * Every one is the same shape, because there is only one shape worth guarding against
 * here: a law brought back into this package. They are written the way the fork
 * actually happened — as plausible, locally-correct code — because the fork this seam
 * removed was plausible and locally correct too.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'mcp-ops-stats-walks-the-store-twice',
    file: 'server.ts',
    find: '  const reading = surveyStore({ store: resolved.store });',
    replace:
      '  const reading = {\n' +
      '    counters: resolved.store.stats(),\n' +
      '    ledger: resolved.store.ledger?.(),\n' +
      '  };',
    why: 'smelt_stats reading the store through two calls of its own instead of the one surveying verb both front doors share — two traversals of the same journal per Stop hook, and the seam the CLI already reaches sitting unused one barrel away, which is exactly how the original fork began',
  },
  {
    id: 'mcp-ops-budget-law-reforked',
    file: 'server.ts',
    find: "      budgetRequired({ knob: '\"budgetBytes\"', stake: 'your context to throw away' }),",
    replace:
      '      \'"budgetBytes" is required, in UTF-8 bytes. There is no default, because a \' +\n' +
      "        'budget smelt invented would silently decide how much of your context to ' +\n" +
      "        'throw away.',",
    why: "the budget law pasted back into the server as a literal — a copy that reads correctly today and is nobody's job to keep correct tomorrow, which is exactly how the two packages came to hold two budget laws",
  },
  {
    id: 'mcp-ops-tree-law-reforked',
    file: 'server.ts',
    find:
      '  const root = take(\n' +
      '    readTree(resolve(cwd, dir), dir, { tree: REPO_MAP_TOOL_NAME, file: SMELT_FILE_TOOL_NAME }),\n' +
      '  );',
    replace: '  const root = resolve(cwd, dir);',
    why: 'the tree law dropped from repo_map — a file is walked as if it were a directory instead of pointing the caller at smelt_file, and the refusal the CLI still gives disappears from this surface only',
  },
  {
    id: 'mcp-ops-strategy-fallback-reforked',
    file: 'server.ts',
    find: '  const { strategy } = resolveStrategy(optionalStrategy(args), resolved.defaultStrategy);',
    replace: "  const strategy = optionalStrategy(args) ?? resolved.defaultStrategy ?? 'lexical';",
    why: 'the strategy precedence written out again with the built-in inline — the exact line this seam replaced, and the one that makes promoting a planner to the default a two-package edit',
  },
  {
    id: 'mcp-ops-store-law-reforked',
    file: 'store.ts',
    find: '      store: openStore(decision),',
    replace: '      store: new DirectoryElisionStore(decision.path),',
    why: 'the store construction re-derived here instead of opened through the seam — the original fork, and the one whose cause was an unexported function rather than a wrong opinion',
  },
];
