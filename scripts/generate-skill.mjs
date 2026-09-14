#!/usr/bin/env node
/**
 * Renders the SkillPack — `skills/smelt/`, the directory `npx skills add smeltjs/smelt`
 * installs (ADR-0002: the second adapter over the instruction content, complementing
 * the marker block beside the enforcement hooks).
 *
 * The pack is a **router and its references**. `SKILL.md` is loaded on every
 * invocation of the skill, relevant or not, so it carries only what an agent mid-task
 * needs — read a big file, retrieve a marker, orient, obey a guard denial, the MCP
 * names — and one link line per operator workflow. Setup and doctor, the store's
 * prune, and the reranker opt-in live in `references/*.md`, read only by the agent
 * doing that job. The root is held under {@link ROOT_BUDGET_BYTES}; a root that
 * outgrows it is a refusal here and a red guard, never a warning.
 *
 * Generated, not hand-written, for the same reason the site's facts are: the commands
 * it teaches are the SetupRecipe's, and a skill that retyped them would drift from
 * the CLI the first time a default moved. The committed files are the renderer's
 * output, byte for byte — `test/guards/skill-pack.test.ts` regenerates and compares
 * the whole directory, so a hand edit to any file, or a stray file, is a red verify.
 *
 * Law 4 governs the prose: every claim is a mechanism (reversible, counted, offline),
 * never a saving. The only numbers are facts about the tool itself — the recipe's
 * budget, doctor's refused exit code, an example age for a prune — never a measurement,
 * and never a percentage. Measured figures live in `packages/core/bench/RESULTS.md`
 * with their dates and corpus commits, and no teaching surface quotes them.
 *
 * The sources: the **built** `@smeltjs/core` (a workspace devDependency), so
 * `pnpm --filter "@smeltjs/site..." build` — or any core build — must run first.
 * `renderSkillPack()` is exported and throws; the guard runs this script with
 * `--print-json` and compares. Only run directly does a refusal become exit 1.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/**
 * The repository this script renders for. Normally the one it lives in; the skill-pack
 * guard overrides it so a *copy* of this script in the mutation runner's scratch root
 * still finds the built core and the pack — otherwise a broken copy would fail on
 * "core not built" before the break it carries was ever rendered, and the guard would
 * go red for the wrong reason.
 */
const REPO_ROOT = process.env['SMELT_REPO_ROOT'] ?? join(here, '..');
const PACK_DIR = join(REPO_ROOT, 'skills', 'smelt');
const CORE_ENTRY = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');

/**
 * The root's byte budget. The root is what every invocation of the skill loads, so it
 * is the one file in the pack whose size is a cost paid on every task; the references
 * are paid for only by the agent doing that job. The number is this pack's own — a
 * budget for its own prose, not a claim about any harness's limit.
 */
export const ROOT_BUDGET_BYTES = 2048;

/**
 * The pack, rendered from the built package's SetupRecipe: a map of file path
 * (relative to `skills/smelt/`) to text, plus the root's measurement. Throws on anything
 * missing — a skill that quietly rendered `undefined` for the budget would teach an
 * agent a command nobody's CLI accepts — and on a root over its budget.
 */
export async function renderSkillPack() {
  if (!existsSync(CORE_ENTRY)) {
    throw new Error(
      `@smeltjs/core is not built (${CORE_ENTRY} is missing). The skill renders the ` +
        `package's own recipe, so the package must be built first — \`pnpm build\`.`,
    );
  }
  const smelt = await import(pathToFileURL(CORE_ENTRY).href);
  const recipe = smelt.SETUP_RECIPE;
  for (const [key, value] of Object.entries({
    installLibrary: recipe.install?.library,
    installGlobal: recipe.install?.globalInstall,
    oneShot: recipe.install?.oneShot,
    budget: recipe.recommendedBudgetBytes,
    storeDir: recipe.store?.defaultDir,
    brewInstall: recipe.install?.brewInstall,
    brewUpgrade: recipe.install?.brewUpgrade,
    harnessIds: smelt.HARNESS_IDS?.join(', '),
    refusedExit: smelt.EXIT?.refused,
    rerankVoyagePackage: smelt.RERANK_VOYAGE_PACKAGE,
  })) {
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `the recipe fact "${key}" is missing — the skill cannot render a fact the package does not state`,
      );
    }
  }

  const budget = String(recipe.recommendedBudgetBytes);
  const steps = smelt.SETUP_STEPS.map((step) => '- `' + step.command + '` — ' + step.title).join(
    '\n',
  );
  const setupLine = `${recipe.install.oneShot} setup --yes [--harness <id>]... [--no-mcp] [--json]`;
  const harnessIds = smelt.HARNESS_IDS.join(', ');
  const refusedExit = String(smelt.EXIT.refused);
  const rerankVoyagePackage = smelt.RERANK_VOYAGE_PACKAGE;
  // Mirrors `installCommand` in `src/rerank/resolve.ts`: `npm install --prefix "<dir>"
  // <name>` puts the adapter in `<dir>/node_modules`, which is exactly where
  // `resolveAdapter` looks first — beside the config file, not beside smelt's own
  // install. `installCommand` itself is not part of the package's public surface, so
  // this spells the same format rather than importing it.
  const machineScopeInstall = `npm install --prefix "$HOME" ${rerankVoyagePackage}`;

  const root = `---
name: smelt
description: Use when a file, log, diff or grep result is too big to read raw, or when a marker's retrieve("hash") needs expanding — smelt keeps what the task needs and makes the rest retrievable.
---

# smelt

smelt keeps large tool output out of your context window, reversibly: what the task
needs survives; everything else becomes one line naming what was removed, its size, and
a hash to get it back. It makes zero network calls.

## Reading big files

Instead of reading a large file raw:

    smelt <file> --budget ${budget} --focus <what you are looking for>

Repeat \`--focus\` once per term. Focused regions survive verbatim; the rest collapses
into one-line markers. The budget is a soft ceiling in bytes.

## Retrieving what was cut

Every marker ends in \`retrieve("hash")\`. The exact original bytes come back from:

    smelt retrieve <hash>

Retrievals are counted; \`smelt stats\` reports the expansion rate. Retrieve what you
actually need.

## Orienting in an unfamiliar tree

    smelt map <dir> --budget ${budget}

prints a ranked symbol map of the repository, fitted to the budget by construction.

## If a guard denies a raw read

Run the exact \`smelt\` replacement command the denial names, then \`smelt retrieve\` any
marker you need expanded. The deny teaches the replacement.

## MCP

Over MCP the same loop is five tools: \`smelt_file\`, \`smelt_retrieve\`,
\`smelt_retrieve_batch\` (several hashes in one call — prefer it when more than one marker
matters), \`repo_map\` and \`smelt_stats\`. The store is shared with the CLI.

## Operator workflows — read only the one for the job at hand

- [references/setup.md](references/setup.md) — install, \`smelt setup\`, \`smelt doctor\`, upgrading.
- [references/store.md](references/store.md) — \`smelt store prune\` and the retention cut-off.
- [references/rerank.md](references/rerank.md) — the opt-in reranker and its adapter.

This skill enforces nothing by itself; the marker block \`smelt setup\` writes beside the
hooks teaches the same commands from the same recipe.
`;

  const setup = `# smelt — setting up and checking the install

Part of the smelt skill; the root \`SKILL.md\` covers reading, retrieving and mapping.

## Setting up

    ${recipe.install.globalInstall}
    smelt setup --yes [--harness <id>]... [--scope user] [--guard on|off] [--stats on|off]
      [--map on|off] [--lint on|off] [--no-mcp] [--json]

Nothing installed at all? \`${setupLine}\` runs the same recipe.

\`smelt setup\` applies the whole recipe idempotently — the config, the hooks preset for
the harnesses you name, the MCP registration step, and a real smelt → retrieve round trip
to prove the loop. A re-run on a current machine writes nothing and exits 0, so re-running
is always safe; \`smelt hooks remove\` takes the wiring back out.

- \`--yes\` answers every question up front. Without a terminal it is what makes the
  command runnable at all, so from CI or a hook use \`smelt hooks install --yes\`.
- \`--harness <id>\` is repeatable. The ids are: ${harnessIds}.
- \`--scope user\` installs once for the machine — one config and one store for every
  project — instead of once per project, which is the default.
- The four toggles each take \`on\` or \`off\`; one you do not name keeps whatever is
  already installed.
- \`--json\` prints a receipt: every file, every check, and what the exit meant.

If you upgraded smelt (\`${recipe.install.brewUpgrade}\`, \`npm update -g\`), run
\`smelt setup\` again. The loop is: upgrade → \`smelt doctor\` → \`smelt setup\`.

## Step by step (when \`setup\` is unavailable on an older install)

${steps}

## Checking the install

    smelt doctor [--scope user] [--json]

Doctor reads installed state and reports it; it writes nothing, ever, so it is always
safe to run. Each wired artifact comes back as one of three verdicts:

- **wired (verified)** — smelt ran the thing and it behaved as installed.
- **wired but inert** — it is on disk, but nothing loads or runs it.
- **wired but missing** — the wiring names a script that is not there.

Exit 0 means current, or nothing is installed. Exit ${refusedExit} means something is
behind or broken, and the report names the exact repair command — \`smelt setup\`, per
harness. Run that; do not hand-edit the files doctor names.

## Notes

- Zero network calls, ever — a test in smelt's own suite fails if that could change.
- The wire surface (the marker format, the tool contracts) is stable from 0.1.
`;

  const store = `# smelt — keeping the store small

Part of the smelt skill; the root \`SKILL.md\` covers reading, retrieving and mapping.

Nothing is ever evicted on its own: no timer, no size cap, nothing on opening a store.
Deleting elided bytes is one explicit command, and it refuses unless an age was named —
on the command line or, since 0.8.0, in the config. Plan it first, then run it:

    smelt store prune --older-than 30d --dry-run
    smelt store prune --older-than 30d

Read the dry run before the real one. A pruned hash is gone, and a later
\`smelt retrieve\` on it refuses and says when it was pruned rather than pretending the
bytes were never there.

The age can be written down instead of retyped, inside the store block of
\`smelt.config.json\`:

    "store": { "kind": "directory", "path": "${recipe.store.defaultDir}",
               "retention": { "olderThan": "30d", "keepRetrieved": true } }

That is a number, not a schedule: nothing prunes because it is there. It supplies the
default age; \`--older-than\` on the command line overrides it, and the prune report
names which of the two chose the age. A configured \`keepRetrieved: true\` is added to
\`--keep-retrieved\`, never overridden by its absence — a flag with no negative spelling
cannot delete more than the config asked to spare. With no age on either the flag or in
the config, the command still refuses.
`;

  const rerank = `# smelt — the opt-in reranker

Part of the smelt skill; the root \`SKILL.md\` covers reading, retrieving and mapping.

There is no default reranker and never will be. Nothing is loaded, imported or called
unless a \`rerank\` key in \`smelt.config.json\` says so:

    { "rerank": { "kind": "module", "path": "./smelt.rerank.ts" } }
    { "rerank": { "kind": "voyage", "apiKeyEnv": "<the variable holding your key>", "topK": 8 } }

\`module\` loads a stage of your own; \`voyage\` loads \`${rerankVoyagePackage}\`, a
separate package installed by hand. The environment variable read is the one your config
names — there is no key smelt reads that you did not write down. A stage may only spare
regions from the cut, never cut more, and a stage that throws is reported as the refusal
it is, never as a quiet unranked run.

The adapter is looked for beside \`smelt.config.json\` first, smelt's own install
second — so at machine scope (\`~/smelt.config.json\`), install it there, not into
whatever project you happen to be standing in:

    ${machineScopeInstall}

\`topK\` is a cap under the budget, not a quantity: smelt walks what the stage returns
best score first and spares while the output still fits the budget, so a \`topK\` of 8 can
come back as 3 kept. The report line names the wall the walk hit, and the \`--json\`
receipt carries it as \`result.rerank.stopped\` (\`budget\`, \`cap\` or \`exhausted\`).
`;

  const rootBytes = Buffer.byteLength(root, 'utf8');
  if (rootBytes > ROOT_BUDGET_BYTES) {
    throw new Error(
      `SKILL.md renders to ${rootBytes} B, over its ${ROOT_BUDGET_BYTES} B budget. The root ` +
        `is loaded on every invocation of the skill; move operator prose into references/.`,
    );
  }

  return {
    files: {
      'SKILL.md': root,
      'references/setup.md': setup,
      'references/store.md': store,
      'references/rerank.md': rerank,
    },
    rootBytes,
    rootBudgetBytes: ROOT_BUDGET_BYTES,
  };
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let pack;
  try {
    pack = await renderSkillPack();
  } catch (error) {
    console.error(`generate-skill: ${error.message}`);
    process.exit(1);
  }
  if (process.argv.includes('--print-json')) {
    process.stdout.write(JSON.stringify(pack));
  } else if (process.argv.includes('--print')) {
    process.stdout.write(pack.files['SKILL.md']);
  } else {
    for (const [path, text] of Object.entries(pack.files)) {
      const target = join(PACK_DIR, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
    console.log(
      `generate-skill: skills/smelt/ rendered (${Object.keys(pack.files).length} files, root ${pack.rootBytes} B of ${ROOT_BUDGET_BYTES})`,
    );
  }
}
