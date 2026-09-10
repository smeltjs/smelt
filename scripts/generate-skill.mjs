#!/usr/bin/env node
/**
 * Renders the SkillPack — `skills/smelt/SKILL.md`, the artifact
 * `npx skills add smeltjs/smelt` installs (ADR-0002: the second adapter over the
 * instruction content, complementing the marker block beside the enforcement hooks).
 *
 * Generated, not hand-written, for the same reason the site's facts are: the commands
 * it teaches are the SetupRecipe's, and a skill that retyped them would drift from
 * the CLI the first time a default moved. The committed file is the renderer's output,
 * byte for byte — `test/guards/skill-pack.test.ts` regenerates and compares, so a
 * hand edit to the skill is a red verify, not a suggestion.
 *
 * Law 4 governs the prose: every claim is a mechanism (reversible, counted, offline),
 * never a saving. The only numbers are facts about the tool itself — the recipe's
 * budget, doctor's refused exit code, an example age for a prune — never a measurement,
 * and never a percentage. Measured figures live in `packages/core/bench/RESULTS.md`
 * with their dates and corpus commits, and no teaching surface quotes them.
 *
 * The sources: the **built** `@smeltjs/core` (a workspace devDependency), so
 * `pnpm --filter "@smeltjs/site..." build` — or any core build — must run first.
 * `renderSkill()` is exported and throws; the guard calls it the way it calls the
 * site's `renderFacts`. Only run directly does a refusal become exit 1.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = join(here, '..', 'skills', 'smelt', 'SKILL.md');
const CORE_ENTRY = join(here, '..', 'packages', 'core', 'dist', 'index.js');

/**
 * The skill, rendered from the built package's SetupRecipe. Throws on anything
 * missing — a skill that quietly rendered `undefined` for the budget would teach an
 * agent a command nobody's CLI accepts.
 */
export async function renderSkill() {
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

  return `---
name: smelt
description: Shrink oversized files and tool output before they hit your context window — structure-aware, reversible, offline. Use when a file, log, grep result, diff or stack trace is too big to read raw — smelt keeps the parts the task needs and replaces the rest with one-line markers you can retrieve by hash.
---

# smelt

smelt keeps large tool output out of your context window, reversibly: the parts the
task needs survive, everything else becomes one line saying what was removed, how big
it was, and a hash to get it back. It makes zero network calls.

## Reading big files

Instead of reading a large file raw:

    smelt <file> --budget ${budget} --focus <what you are looking for>

Repeat \`--focus\` once per term. Focused regions survive verbatim; the rest collapses
into one-line markers. The budget is a soft ceiling in bytes.

## Retrieving what was cut

Every marker ends in \`retrieve("hash")\`. The exact original bytes come back from:

    smelt retrieve <hash>

Retrievals are counted, and \`smelt stats\` reports the expansion rate — the honest
signal of over-pruning. Retrieve what you actually need.

## Orienting in an unfamiliar tree

    smelt map <dir> --budget ${budget}

prints a ranked symbol map of the repository. The budget is met by construction.

## If a guard denies a raw read

This project may run a smelt guard hook: raw reads over a size threshold are denied,
and the denial names the exact \`smelt\` replacement command. Run that command, then
\`smelt retrieve\` any marker you need expanded. The deny teaches the replacement —
that pairing is the design, not an obstacle.

## Step by step (when \`setup\` is unavailable on an older install)

${steps}

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

## Keeping the store small

Nothing is ever evicted on its own: no timer, no size cap, nothing on opening a store.
Deleting elided bytes is one explicit command, and it refuses without an age you named.
Plan it first, then run it:

    smelt store prune --older-than 30d --dry-run
    smelt store prune --older-than 30d

Read the dry run before the real one. A pruned hash is gone, and a later
\`smelt retrieve\` on it refuses and says when it was pruned rather than pretending the
bytes were never there.

The age can be written down instead of retyped, inside the store block of
\`smelt.config.json\`:

    "store": { "kind": "directory", "path": "${recipe.store.defaultDir}",
               "retention": { "olderThan": "30d", "keepRetrieved": true } }

That is a number, not a schedule: nothing prunes because it is there. \`--older-than\`
overrides it, the prune report says which of the two chose the age, and with neither
present the command still refuses.

## Reranking

There is no default reranker and never will be. Nothing is loaded, imported or called
unless a \`rerank\` key in \`smelt.config.json\` says so:

    { "rerank": { "kind": "module", "path": "./smelt.rerank.ts" } }
    { "rerank": { "kind": "voyage", "apiKeyEnv": "<the variable holding your key>", "topK": 8 } }

\`module\` loads a stage of your own; \`voyage\` loads \`@smeltjs/rerank-voyage\`, a
separate package installed by hand. The environment variable read is the one your config
names — there is no key smelt reads that you did not write down. A stage may only spare
regions from the cut, never cut more, and a stage that throws is reported as the refusal
it is, never as a quiet unranked run.

\`topK\` is a cap under the budget, not a quantity: smelt walks what the stage returns
best score first and spares while the output still fits the budget, so a \`topK\` of 8 can
come back as 3 kept. The report line names the wall the walk hit, and the \`--json\`
receipt carries it as \`result.rerank.stopped\` (\`budget\`, \`cap\` or \`exhausted\`).

## MCP

If the project registers smelt over MCP, five tools exist: \`smelt_file\` (shrink a
file under a byte budget with a focus), \`repo_map\` (a ranked whole-tree symbol map),
\`smelt_retrieve\` (elided bytes back by hash), \`smelt_retrieve_batch\` (several
hashes back in one call — prefer it when more than one marker matters, because every
call re-bills the conversation) and \`smelt_stats\` (retrieval counters). The
config's store is shared with the CLI, so a hash a marker gave you is the same hash
either surface retrieves.

## Notes

- Zero network calls, ever — a test in smelt's own suite fails if that could change.
- The wire surface (the marker format, the tool contracts) is stable from 0.1.
- This skill complements the marker-block instructions that \`smelt hooks install\`
  writes beside the enforcement hooks. If both are present, they teach the same
  commands from the same recipe; if only this skill is present, nothing is enforced —
  the discipline above is yours to follow.
`;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let skill;
  try {
    skill = await renderSkill();
  } catch (error) {
    console.error(`generate-skill: ${error.message}`);
    process.exit(1);
  }
  if (process.argv.includes('--print')) {
    process.stdout.write(skill);
  } else {
    mkdirSync(dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, skill);
    console.log(`generate-skill: skills/smelt/SKILL.md rendered`);
  }
}
