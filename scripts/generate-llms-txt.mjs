#!/usr/bin/env node
/**
 * Renders the agent-facing index — `llms.txt` (llmstxt.org: an H1, a blockquote
 * summary, prose sections of key facts, H2-delimited link lists of
 * `- [title](url): note`, and an `## Optional` H2 for the secondary links) — and its
 * companion `llms-full.txt`, which inlines every document the index names so an agent
 * that can spend the tokens fetches one URL instead of twelve.
 *
 * **One renderer, two outputs, four files.** The index and the full text walk the same
 * {@link DOCUMENTS} list, so a document cannot be named in one and missing from the
 * other; each output is then written to two byte-identical places — the repository
 * root, where an agent reading the repo finds it, and `site/public/`, where the built
 * site serves it. Two copies are a drift risk, which is exactly why nothing here is
 * hand-written and `test/guards/llms-txt.test.ts` regenerates and byte-compares all
 * four.
 *
 * The facts come from the **built** packages, never retyped: `@smeltjs/core` for the
 * SetupRecipe's install commands, its recommended budget and its store default, and
 * `@smeltjs/mcp` for the five tool names the server actually registers. So
 * `pnpm build` must run first, and a missing fact throws rather than rendering
 * `undefined` — an agent that reads a command nobody's CLI accepts loops on it.
 *
 * Law 4 governs the prose the same way it governs the SkillPack: the only numbers in
 * `llms.txt` are the recipe's own budget and the marker version. Every measured figure
 * lives in `packages/core/bench/RESULTS.md` with its date and corpus commit, and the
 * index links it rather than quoting it.
 *
 * `renderIndex()` and `renderFull()` are exported and throw; only run directly does a
 * refusal become exit 1. `--print` writes the index to stdout, `--print-full` the
 * full text — the two spellings the guard reads them through.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, '..');
const CORE_ENTRY = join(REPO_ROOT, 'packages', 'core', 'dist', 'index.js');
const MCP_ENTRY = join(REPO_ROOT, 'packages', 'mcp', 'dist', 'index.js');

/** Where the index lands. Both copies are the renderer's output, byte for byte. */
export const INDEX_PATHS = ['llms.txt', 'site/public/llms.txt'];
/** Where the inlined companion lands. Same rule. */
export const FULL_PATHS = ['llms-full.txt', 'site/public/llms-full.txt'];

/**
 * The three URL shapes the index is allowed to link, and nothing else.
 *
 * `raw` is what an agent should fetch — the Markdown itself, not GitHub's HTML around
 * it. `tree` names a directory. `site` is the deployed page: a GitHub Pages *project*
 * site, so its root is `/smelt/`, not `/`, and `site/public/llms.txt` is served at
 * `<site>llms.txt`. Every link in the rendered index maps back to a path in this
 * repository, which is the property the guard checks — a link nothing can resolve is
 * a link nobody can verify.
 */
export const RAW_BASE = 'https://raw.githubusercontent.com/smeltjs/smelt/main/';
export const TREE_BASE = 'https://github.com/smeltjs/smelt/tree/main/';
export const SITE_BASE = 'https://smeltjs.github.io/smelt/';

/** The index's H2 link lists, in the order they are rendered. `Optional` is last. */
export const SECTIONS = ['Docs', 'Reference', 'Packages', 'Changelog', 'Optional'];

/**
 * The documents an agent is pointed at, and which of them the full text inlines.
 *
 * `inline: true` means "this file's bytes are part of `llms-full.txt`" — the guard
 * holds every inlined document to appearing under its own `# <path>` header there, so
 * naming a document in the index and forgetting it in the full text is red. The
 * `Optional` entries are deliberately not inlined: `RESULTS.md` is evidence to be read
 * at its source with its dates intact, and the bench harness is a directory.
 */
function documents(adrs) {
  return [
    {
      section: 'Docs',
      path: 'README.md',
      title: 'README',
      note: 'What smelt is, how to install it, the sixty-second round trip, how it wires into each harness, and the measured tables with their dates and corpus commits.',
      inline: true,
    },
    {
      section: 'Docs',
      path: 'skills/smelt/SKILL.md',
      title: 'SkillPack (skills/smelt/SKILL.md)',
      note: 'The instructions an agent runs on, installed by its owner. Generated from the SetupRecipe, never hand-written.',
      inline: true,
    },
    {
      section: 'Docs',
      path: 'site/public/llms-full.txt',
      url: `${SITE_BASE}llms-full.txt`,
      title: 'llms-full.txt',
      note: 'Every document listed below, concatenated, for one-shot context. Fetch this one when you can spend the tokens.',
      inline: false,
    },
    {
      section: 'Reference',
      path: 'CONTEXT.md',
      title: 'CONTEXT.md',
      note: 'The domain vocabulary — every term the code uses, with its exact meaning and what to avoid calling it. Read it before renaming anything.',
      inline: true,
    },
    {
      section: 'Reference',
      path: 'docs/ARCHITECTURE.md',
      title: 'docs/ARCHITECTURE.md',
      note: 'The four laws and why each is load-bearing, the module map, the seams, and the consumer contract.',
      inline: true,
    },
    ...adrs,
    {
      section: 'Packages',
      path: 'packages/core/README.md',
      title: '@smeltjs/core',
      note: 'The library and the `smelt` CLI: planners, the marker, the ElisionStore, the setup verbs.',
      inline: true,
    },
    {
      section: 'Packages',
      path: 'packages/mcp/README.md',
      title: '@smeltjs/mcp',
      note: 'The MCP server: the same operations seam as the CLI, over stdio, as the five tools above.',
      inline: true,
    },
    {
      section: 'Packages',
      path: 'packages/rerank-voyage/README.md',
      title: '@smeltjs/rerank-voyage',
      note: 'The opt-in rerank adapter you install yourself — the only package in this repository that reaches the network, and nothing loads it unless your config names it.',
      inline: true,
    },
    {
      section: 'Changelog',
      path: 'CHANGELOG.md',
      title: 'CHANGELOG.md',
      note: 'Every release, what changed in it, and why — including which upgrades need a `smelt setup` re-run.',
      inline: true,
      /** The full text carries the newest release only; the link carries all of it. */
      heading: 'CHANGELOG.md (newest release section)',
      slice: newestReleaseSection,
    },
    {
      section: 'Optional',
      path: 'packages/core/bench/RESULTS.md',
      title: 'bench/RESULTS.md',
      note: 'Every measured row, append-only, each with its date and the corpus commit it ran against. The only place smelt states a number; quote it from here or not at all.',
      inline: false,
    },
    {
      section: 'Optional',
      path: 'packages/core/bench',
      url: `${TREE_BASE}packages/core/bench`,
      title: 'The bench harness',
      note: 'The corpus, the four tiers, and the runner that writes those rows.',
      inline: false,
    },
    {
      section: 'Optional',
      path: 'CONTRIBUTING.md',
      title: 'CONTRIBUTING.md',
      note: 'Dev setup, the one-command gate, and the guard-and-mutation convention every new guarantee ships under.',
      inline: false,
    },
    {
      section: 'Optional',
      path: 'site/index.html',
      url: SITE_BASE,
      title: 'smeltjs.github.io/smelt',
      note: 'The project page: the install, the harness tiers, and the measured tables rendered from the packages themselves.',
      inline: false,
    },
  ];
}

/**
 * The ADRs, discovered rather than listed — a new decision record joins the index by
 * existing, which is the same rule `scripts/mutate.mjs` applies to guards. The title
 * is the file's own H1, so a record whose ruling was reworded cannot keep an old
 * summary here.
 */
function adrDocuments() {
  const dir = join(REPO_ROOT, 'docs', 'adr');
  if (!existsSync(dir)) {
    throw new Error(`docs/adr is missing (${dir}) — the index names every decision record`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .toSorted();
  if (files.length === 0) throw new Error('docs/adr holds no records — the index would name none');
  return files.map((name) => {
    const path = `docs/adr/${name}`;
    const heading = /^#\s+(.+)$/mu.exec(readFileSync(join(REPO_ROOT, path), 'utf8'));
    if (heading === null) {
      throw new Error(`${path} has no H1 — the index takes each record's title from it`);
    }
    const number = /^(\d+)-/u.exec(name);
    if (number === null) throw new Error(`${path} is not named <number>-<slug>.md`);
    return {
      section: 'Reference',
      path,
      title: `ADR-${number[1]}`,
      note: `${heading[1].trim()}.`,
      inline: true,
    };
  });
}

/**
 * The newest release section of the changelog — the heading that names a version and
 * a date, through to the next `##`. An `## Unreleased` block above it is skipped
 * deliberately: what the full text owes an agent is the release it is running, and an
 * unreleased note describes a build nobody has.
 */
function newestReleaseSection(text) {
  const heading = /^## \d+\.\d+\.\d+ — .+$/mu.exec(text);
  if (heading === null) {
    throw new Error('CHANGELOG.md has no `## <version> — <date>` section to inline');
  }
  const rest = text.slice(heading.index + heading[0].length);
  const next = /^## /mu.exec(rest);
  return (heading[0] + (next === null ? rest : rest.slice(0, next.index))).trimEnd() + '\n';
}

/** A document's URL: its explicit one, or the raw GitHub URL for its path. */
function urlFor(document) {
  return document.url ?? RAW_BASE + document.path;
}

/** One `- [title](url): note` line, the llmstxt.org link shape. */
function linkLine(document) {
  return `- [${document.title}](${urlFor(document)}): ${document.note}`;
}

/** The recipe and tool facts, read from the built packages or refused. */
async function facts() {
  for (const [entry, what] of [
    [CORE_ENTRY, '@smeltjs/core'],
    [MCP_ENTRY, '@smeltjs/mcp'],
  ]) {
    if (!existsSync(entry)) {
      throw new Error(
        `${what} is not built (${entry} is missing). llms.txt renders the packages' own ` +
          `commands and tool names, so the packages must be built first — \`pnpm build\`.`,
      );
    }
  }
  const core = await import(pathToFileURL(CORE_ENTRY).href);
  const mcp = await import(pathToFileURL(MCP_ENTRY).href);
  const recipe = core.SETUP_RECIPE;
  const found = {
    globalInstall: recipe.install?.globalInstall,
    oneShot: recipe.install?.oneShot,
    brewInstall: recipe.install?.brewInstall,
    skillInstall: recipe.install?.skillInstall,
    budget: recipe.recommendedBudgetBytes,
    storeDir: recipe.store?.defaultDir,
    mcpRun: recipe.mcp?.run,
    smeltFile: mcp.SMELT_FILE_TOOL_NAME,
    retrieve: mcp.RETRIEVE_TOOL_NAME,
    retrieveBatch: mcp.RETRIEVE_BATCH_TOOL_NAME,
    repoMap: mcp.REPO_MAP_TOOL_NAME,
    stats: mcp.SMELT_STATS_TOOL_NAME,
  };
  for (const [key, value] of Object.entries(found)) {
    if (value === undefined || value === null || value === '') {
      throw new Error(
        `the package fact "${key}" is missing — llms.txt cannot state a fact the packages do not`,
      );
    }
  }
  return found;
}

/** The index — `llms.txt`, in the llmstxt.org shape. */
export async function renderIndex() {
  const fact = await facts();
  const all = documents(adrDocuments());
  const lists = SECTIONS.map((section) => {
    const lines = all.filter((document) => document.section === section).map(linkLine);
    if (lines.length === 0) throw new Error(`the "${section}" section would render empty`);
    return `## ${section}\n\n${lines.join('\n')}\n`;
  }).join('\n');

  return `# smelt

> Structure-aware, reversible, offline context optimization for AI coding agents. Hand
> smelt a blob — a source file, a log, a diff, a grep result — and a byte budget, and it
> returns a smaller blob in which the regions the task needs survive verbatim and every
> removed region is one marker line naming the rule that removed it, how many bytes it
> took, and a hash that brings the exact original back. Published as \`@smeltjs/core\`
> (the library and the \`smelt\` CLI) and \`@smeltjs/mcp\` (the MCP server), Apache-2.0.
> It makes zero network calls.

smelt is a library, not a proxy: nothing is interposed between an agent and its model,
and no hosted model is asked which lines matter. A planner decides what to keep from the
file's own structure, the removed bytes go to a content-addressed ElisionStore on the
same machine (\`${fact.storeDir}\` by default), and a marker stands where they were:

    <<smelt/v1: collapsed 3 sibling functions (2224B) — retrieve("84998967370f38bc")>>

The budget is in bytes, because bytes are what smelt can count without shipping a
tokenizer it would have to guess with.

## Important notes

The four laws. \`docs/ARCHITECTURE.md\` carries the reasoning for each — why breaking one
produces a library that still looks like it works.

- **Zero network.** No external call in any code path, enforced by a guard that walks the
  real import graph from every entrypoint the manifests advertise.
- **Every elision is explainable.** A named rule and a sentence a human can read in a
  diff, never a model's opinion about what mattered.
- **Every elision is reversible, and expansions are counted.** \`smelt stats\` reports the
  expansion rate, so cutting too much surfaces as a rising number rather than as a model
  that is quietly wrong about the code.
- **Claim no number that has not been measured.** This file therefore states none. Every
  figure smelt publishes is a dated, corpus-pinned row in \`packages/core/bench/RESULTS.md\`,
  linked under Optional below — quote it from there, with its date and corpus commit, or
  not at all.

## Three commands

- \`${fact.globalInstall}\` — the CLI onto the machine. \`${fact.oneShot}\` runs it
  without installing anything, and \`${fact.brewInstall}\` is the Homebrew path.
- \`smelt setup --yes\` — applies the whole SetupRecipe idempotently: \`smelt.config.json\`,
  the hooks preset for the harnesses you name, the MCP registration step, and a real
  smelt → retrieve round trip to prove the loop. \`--scope user\` installs once for the
  machine instead of once per project. \`smelt doctor\` then reads installed state back
  and names the exact repair; it never writes.
- \`smelt <file> --budget ${fact.budget} --focus <term>\` — the round trip itself:
  smelted text on stdout, the report on stderr. \`smelt retrieve <hash>\` brings back any
  marker's exact original bytes, and every retrieval is counted.

An agent's owner installs the SkillPack with \`${fact.skillInstall}\`; it and the
marker block \`smelt setup\` writes beside the enforcement hooks are the two instruction
channels (ADR-0002), and they teach the same commands from the same recipe.

## MCP tools

\`${fact.mcpRun}\` serves five tools. The config's store is shared with the CLI, so a hash
a marker gave you retrieves the same bytes from either surface.

- \`${fact.smeltFile}\` — smelt a file under a byte budget with a focus.
- \`${fact.retrieve}\` — the elided bytes back, by hash. This contract and the marker
  format are the wire surface, stable from 0.1 and treated as 1.0.
- \`${fact.retrieveBatch}\` — several hashes in one call. Prefer it when more than one
  marker matters: every call re-bills the conversation.
- \`${fact.repoMap}\` — a ranked symbol map of a directory tree, inside a byte budget.
- \`${fact.stats}\` — the retrieval counters, including the expansion rate.

${lists}`;
}

/** The companion — every inlined document, each under a rule and its repository path. */
export async function renderFull() {
  const all = documents(adrDocuments()).filter((document) => document.inline);
  if (all.length === 0) throw new Error('llms-full.txt would inline nothing');
  const blocks = all.map((document) => {
    const file = join(REPO_ROOT, document.path);
    if (!existsSync(file)) {
      throw new Error(`llms.txt names ${document.path}, which does not exist in this repository`);
    }
    const raw = readFileSync(file, 'utf8');
    const body = (document.slice === undefined ? raw : document.slice(raw)).trimEnd();
    return `---\n\n# ${document.heading ?? document.path}\n\n${body}\n`;
  });

  return `# smelt — llms-full.txt

> Every document \`llms.txt\` names, concatenated in that order, each under a rule and
> its path in the smeltjs/smelt repository. The index itself — the summary, the four
> laws, the commands and the MCP tool names — is \`llms.txt\` beside this file.

${blocks.join('\n')}`;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  let index;
  let full;
  try {
    index = await renderIndex();
    full = await renderFull();
  } catch (error) {
    console.error(`generate-llms-txt: ${error.message}`);
    process.exit(1);
  }
  if (process.argv.includes('--print')) {
    process.stdout.write(index);
  } else if (process.argv.includes('--print-full')) {
    process.stdout.write(full);
  } else {
    for (const [paths, text] of [
      [INDEX_PATHS, index],
      [FULL_PATHS, full],
    ]) {
      for (const path of paths) {
        const out = join(REPO_ROOT, path);
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, text);
      }
    }
    console.log(`generate-llms-txt: ${[...INDEX_PATHS, ...FULL_PATHS].join(', ')} rendered`);
  }
}
