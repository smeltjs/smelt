import { describe, expect, it } from 'vitest';

import { allSourceFiles, importSpecifiers, readSource } from './_source.ts';
import type { GuardMutation } from './_mutations.ts';

/**
 * MODULE-SEAMS GUARD — the two install verbs share a plan and a policy, never a wizard.
 *
 * `smelt hooks install` and `smelt setup` do the same three things: work out what
 * would be written, decide whether an existing file may be written over, and read the
 * toggles back off what is installed. All three used to live inside `cli/hooks.ts`
 * beside the interactive wizard, so `cli/setup.ts` imported the wizard's module to
 * plan — a ~1200-line file whose reader could not tell which half they were in, and
 * whose every future change to a prompt sat in the same module as the code that
 * writes into other people's config files.
 *
 * The split is the property this guard holds, in both directions:
 *
 *   1. **Nothing imports the wizard to plan.** `cli/setup.ts`, `cli/installed.ts` and
 *      `harness/plan.ts` name `cli/hooks.ts` in no import. The wizard is a leaf: it
 *      imports the plan, the policy and the toggle reader, and nothing imports it back
 *      except the verb (`cli/subcommands/hooks.ts`) that is its front door.
 *   2. **`harness/` stays free of `cli/`.** The registry's oldest rule (`cli/hooks.ts`
 *      imported `CLI_NAME` from `cli/args.ts`, so the `--harness` help list could not
 *      be derived and was hand-typed five times) now covers the planner that moved in
 *      beside it. The one exception is `cli/config.ts` — the config schema, its reader
 *      and its one writer, which `planInstall` goes through so that a key added to the
 *      schema reaches the installer and `init` together or not at all.
 *   3. **Each shared symbol is declared once.** An import edge that is merely absent
 *      can be satisfied by a copy, and a copy is how the two verbs would come to
 *      disagree about whose file `CLAUDE.md` is. So the declarations themselves are
 *      counted: exactly one `planInstall`, one `applyPlanFiles`, one `presetToggles`
 *      in the whole of `src`.
 *
 * The third half is what makes the first two more than a lint: the seam is not that
 * setup avoids a module, it is that both verbs run the same code.
 */

/** Every `.ts` under `src`, as paths relative to it — the guard kit's own walk. */
const SOURCE = allSourceFiles();

/** The relative specifiers `file` imports, resolved to the same `src`-relative form. */
function importedModules(file: string): readonly string[] {
  const dir = file.split('/').slice(0, -1);
  return importSpecifiers(readSource(file))
    .filter((specifier) => specifier.startsWith('.'))
    .map((specifier) => {
      const parts = [...dir, ...specifier.split('/')];
      const out: string[] = [];
      for (const part of parts) {
        if (part === '.') continue;
        if (part === '..') out.pop();
        else out.push(part);
      }
      return out.join('/');
    });
}

describe('the install verbs share a plan and a policy, not a wizard', () => {
  it('nothing reaches for the wizard module to plan, apply or read state', () => {
    const wizardOnly = 'cli/hooks.ts';
    for (const importer of ['cli/setup.ts', 'cli/installed.ts', 'harness/plan.ts']) {
      expect(
        importedModules(importer),
        `${importer} imports ${wizardOnly}. The plan is harness/plan.ts, the merge ` +
          `policy is cli/merge-policy.ts and the installed toggles are cli/installed.ts; ` +
          `importing the wizard for any of them is how the ~1200-line file came about.`,
      ).not.toContain(wizardOnly);
    }
  });

  it('only the verb imports the wizard', () => {
    const importers = SOURCE.filter((file) => importedModules(file).includes('cli/hooks.ts'));
    expect(importers.toSorted()).toEqual(['cli/subcommands/hooks.ts']);
  });

  it('harness/ imports nothing from cli/ but the config schema', () => {
    for (const file of SOURCE.filter((one) => one.startsWith('harness/'))) {
      const cliImports = importedModules(file).filter((one) => one.startsWith('cli/'));
      expect(
        cliImports.toSorted(),
        `${file} imports ${cliImports.join(', ')} from cli/. A harness fact that needs ` +
          `a verb is a fact in the wrong module — that cycle is why the --harness help ` +
          `list was hand-typed. cli/config.ts is the one exception, and it is the ` +
          `config schema, not a verb.`,
      ).toEqual(cliImports.length === 0 ? [] : ['cli/config.ts']);
    }
  });

  it('each shared symbol is declared exactly once, in the module that owns it', () => {
    const owners: readonly { readonly declaration: string; readonly file: string }[] = [
      { declaration: 'export function planInstall(', file: 'harness/plan.ts' },
      { declaration: 'export function planRemove(', file: 'harness/plan.ts' },
      { declaration: 'export function renderConfigWithHooks(', file: 'harness/plan.ts' },
      { declaration: 'export async function applyPlanFiles(', file: 'cli/merge-policy.ts' },
      { declaration: 'export function fileIsOursToRepair(', file: 'cli/merge-policy.ts' },
      { declaration: 'export function presetToggles(', file: 'cli/installed.ts' },
      { declaration: 'export async function runHooks(', file: 'cli/hooks.ts' },
    ];
    for (const { declaration, file } of owners) {
      const found = SOURCE.filter((one) => readSource(one).includes(declaration));
      expect(
        found,
        `"${declaration}" is declared in ${found.join(', ') || 'nothing'}. One copy of ` +
          `the plan or the policy per verb is how the two would come to disagree about ` +
          `whose file it is — and the copy nobody watches is the non-interactive one.`,
      ).toEqual([file]);
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this
 * file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'src',
    id: 'seam-setup-plans-through-the-wizard',
    file: 'cli/setup.ts',
    find: "import { applyPlanFiles } from './merge-policy.ts';",
    replace:
      "import { applyPlanFiles } from './merge-policy.ts';\n" +
      "import { runHooks } from './hooks.ts';",
    why: 'setup reaching back into the wizard module — the edge the split removed, and the one that made a prompt change and a write into somebody else’s settings file the same file’s business',
  },
  {
    kind: 'src',
    id: 'seam-plan-imports-a-verb',
    file: 'harness/plan.ts',
    find: "import { SETUP_RECIPE } from '../setup/recipe.ts';",
    replace:
      "import { SETUP_RECIPE } from '../setup/recipe.ts';\n" +
      "import { CLI_NAME } from '../cli/shell.ts';",
    why: 'the planner importing a verb — the cycle the registry’s no-cli rule exists to refuse, arriving through the module that moved in beside it',
  },
  {
    kind: 'src',
    id: 'seam-plan-copied-into-setup',
    file: 'cli/setup.ts',
    find: 'async function applySetup(choices: SetupChoices, io: SetupIo): Promise<ApplyOutcome> {',
    replace:
      'export function planInstall(): never {\n' +
      "  throw new Error('a second planner');\n" +
      '}\n\n' +
      'async function applySetup(choices: SetupChoices, io: SetupIo): Promise<ApplyOutcome> {',
    why: 'a second planner declared beside the verb that used to import one — an absent import edge is satisfied by a copy, and a copy is how the two verbs come to disagree about whose file it is',
  },
];
