<div align="center">

<img src="assets/smelt-wordmark.svg" width="360" alt="smelt" />

**Structure-aware, reversible context optimization for coding agents.**
A library, not a proxy.

[![CI](https://img.shields.io/github/actions/workflow/status/smeltjs/smelt/ci.yml?style=for-the-badge&logo=githubactions&logoColor=EFEBE5&label=CI&labelColor=131417&color=E4602F)](https://github.com/smeltjs/smelt/actions/workflows/ci.yml)
[![network calls](https://img.shields.io/badge/network_calls-0-E4602F?style=for-the-badge&labelColor=131417)](#the-four-laws)
[![node](https://img.shields.io/badge/node-%5E20.19_%7C%7C_%3E%3D22.12-6E7783?style=for-the-badge&logo=nodedotjs&logoColor=EFEBE5&labelColor=131417)](#requirements)
[![License](https://img.shields.io/badge/license-Apache_2.0-6E7783?style=for-the-badge&labelColor=131417)](./LICENSE)

</div>

## What it does

**smelt shrinks what your coding agent sends to a model, without lying about what it
removed.**

Hand it a blob of text — a file, a grep result, a stack trace, a build log — and a byte
budget. You get back a smaller blob in which the parts the task needs survive, and
everything else has been replaced by a single line saying what went, how big it was, and a
hash to get it back:

```
<<smelt/v1: collapsed 3 sibling functions (2224B) — retrieve("84998967370f38bc")>>
```

The removed bytes are kept locally, content-addressed. The model gets a `smelt_retrieve`
tool. **Every retrieval is counted**, so cutting too much shows up as a rising number
rather than as a model that is quietly wrong about your code.

| What your agent does today                         | What smelt does instead                                                           |
| -------------------------------------------------- | --------------------------------------------------------------------------------- |
| Sends the whole 40 kB file, or its first 200 lines | Keeps the declarations your focus matched, with their signatures and doc comments |
| `[...output truncated...]`                         | `<<smelt/v1: collapsed 3 sibling functions (2224B) — retrieve("8499…")>>`         |
| Truncated content is gone                          | Stored locally, keyed by hash, one tool call away                                 |
| No idea whether the cut hurt                       | An expansion rate you can watch move                                              |
| Asks a hosted model which lines matter             | Never leaves the machine                                                          |

## Install

```sh
npm install @smeltjs/core     # or: pnpm add @smeltjs/core · bun add @smeltjs/core · yarn add @smeltjs/core
```

Or run the CLI without installing anything:

```sh
npx @smeltjs/core src/server.ts --budget 4000 --focus handleRequest
# also: pnpm dlx @smeltjs/core …  ·  bunx @smeltjs/core …
```

One runtime dependency (`web-tree-sitter`); the parsers ship inside the tarball. No native
build step, no post-install download, no Docker, no service, no API key.

## Sixty seconds, from a shell

```sh
smelt src/server.ts --budget 4000 --focus handleRequest   # smelted text → stdout, report → stderr
smelt --budget 4000 --focus TypeError < build.log         # stdin works too
smelt big.log --budget 4000 > small.log                   # the two pipe apart
```

```
smelt  packages/core/src/plan/lexical.ts  typescript  lexical/v1
in 7,297 B → out 985 B   (-86.5%, 3 elisions)

  rule          lines  bytes  hash              explanation
  focus-window     53  2,224  84998967370f38bc  collapsed 53 lines with no match for the focu…
```

- `--strategy structural` parses the file and collapses whole sibling declarations,
  keeping every signature and doc comment. `--strategy lexical` (the default) uses focus
  windows — right for logs, traces, and anything that is not code. `--strategy auto`
  picks between them on the language and labels what it ran, for a stream that is
  sometimes code and sometimes a build log.
- `--json` prints a versioned envelope; `--reconstruct` reads it back and prints the
  original, byte for byte. Reversibility you can run from a shell.
- `smelt map <dir> --budget 4000` prints a ranked symbol map of a whole repository —
  tree-sitter tags, deterministic PageRank, every included symbol stating why it ranked.
  Modelled on Aider's repo-map, credited as such. The map fits itself to the budget by
  construction.
- `smelt agents lint` measures the other blob an agent loads on every request: your
  `AGENTS.md`. See [`smelt agents`](#smelt-agents--the-file-that-loads-on-every-request).
- The exit code is non-zero when the plan came back over budget, and the report says so.
  `1` over budget, `2` usage, `3` refused, `4` unexpected.

## `smelt init` — the setup wizard

```sh
npx @smeltjs/core init
```

Walks you through your defaults one question at a time — budget, store, strategy, an
optional tokenizer hook, an optional reranker adapter — and writes a `smelt.config.json`
the CLI reads for defaults from then on. Every step accepts `back`; re-running it loads
your current answers and edits one choice at a time; **nothing is written until a final
confirm, and no existing file is ever overwritten without an explicit per-file yes.**

If you opt into a reranker, the wizard generates the adapter **into your project** — your
file, your env var, your review — because a bundled reranker would ship your source to a
third party. See [Reranking](#reranking-a-seam-not-a-feature).

## The library

```ts
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({ defaultBudgetBytes: 8_000 });

// 1. Shrink tool output on its way to the model.
const result = await smelter.smelt(toolOutput, {
  path: 'src/server.ts', // language detection
  focus: ['handleRequest'], // what you were actually looking for
  budgetBytes: 4_000,
  strategy: 'structural', // parse-tree collapse; 'lexical' for non-code, 'auto' to pick
});

result.text; // send this
result.elisions; // what was cut: rule, explanation, bytes, hash — per elision
result.outputBytes; // check it: the budget is a target, never a silent guarantee

// 2. Give the model the way back.
const { name, description, inputSchema, invoke } = smelter.tool;
//   name === 'smelt_retrieve'  →  invoke({ hash }) returns the exact original bytes

// 3. Watch whether you cut too much.
smelter.stats().expansionRate; // 0 = the model never needed anything back
```

Long-lived sessions outlive processes, so elisions can too:

```ts
import { DirectoryElisionStore } from '@smeltjs/core';

const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  store: new DirectoryElisionStore('.smelt/store'), // content-addressed, crash-safe, no eviction
});
// A smelt_retrieve in a later turn — or a later process — still gets its bytes back.
// Retrieval counters survive restarts, so expansionRate stays meaningful across a session.
```

## Wiring it into an agent harness

Three steps, SDK-agnostic:

```ts
import { createSmelter, DirectoryElisionStore } from '@smeltjs/core';

// once, at session start — the persistent store keeps bytes AND counters
// across turns and processes, so the honest signal spans the whole session
const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  store: new DirectoryElisionStore('.smelt/store'),
});

// 1 — every tool result passes through smelt on its way into the context
const result = await smelter.smelt(rawToolOutput, {
  path: 'src/server.ts', // structural planning for supported languages
  focus: [whatTheModelAskedFor], // the grep pattern, the symbol, the error
  budgetBytes: 4_000,
});
pushToolResult(result.text);

// 2 — register the way back as a normal tool
const { name, description, inputSchema, invoke } = smelter.tool; // 'smelt_retrieve'
tools.push({ name, description, input_schema: inputSchema }); // Anthropic shape shown
// in your dispatcher:
//   if (call.name === 'smelt_retrieve') return invoke(call.input); // exact bytes back

// 3 — report the stats wherever you surface metrics
const s = smelter.stats();
// s.expansionRate          the number to watch: fraction of hidden blobs asked back for
// s.retrieveCalls          round trips you paid for
// s.elisionsStored         how much smelt hid
// s.allElisionsRetrieved   true means the cutting saved nothing — loosen budgets
```

`expansionRate` is the whole feedback loop: 0 means every cut was right; a rising rate
means the budget is too aggressive for this task shape. Surface it next to your token
counts — it is the honest signal this library exists to provide, and the persistent
store is what makes it a session-level fact rather than a per-turn one.

Prefer your own planner or a hosted reranker? `createSmelter({ planner })` accepts any
`Planner` implementation, and `RerankStage` is the seam for relevance — both are yours
to wire, in your source, with your key.

### One command: `smelt setup`

Install the CLI, then run one command:

```sh
npm install -g @smeltjs/core
smelt setup
```

`smelt setup` applies the whole recipe: `smelt.config.json`, the hooks preset for the
harnesses it detects, the MCP registration for Claude Code and opencode, and a real
smelt → retrieve round trip to prove the loop. Interactive from a terminal — Enter
accepts every default. Existing files are never overwritten: they are skipped with a
note, and `smelt hooks install` (below) edits them, asking per file.

For an agent, the whole interface is flags, and the receipt is the output:

```sh
npx @smeltjs/core setup --yes --harness claude-code --json
```

Or hand the agent the skill, which teaches all of it in the agent's own vocabulary:

```sh
npx skills add smeltjs/smelt
```

Homebrew, from smelt's own tap:

```sh
brew install smeltjs/tap/smelt
```

### Updating — and the other machine

An update is the same loop on every machine, forever:

```sh
smelt doctor
```

Doctor reads installed state and **never writes**: which release wrote the instruction
blocks, whether the config parses and its store directory exists, whether the MCP
registration is intact, and which pieces are orphans. Exit 0 means current. When
anything is behind, the report ends with the exact repair command, which is always:

```sh
smelt setup
```

Setup is idempotent — a re-run on a current machine writes nothing and exits 0 — so
_upgrade, doctor, setup_ is the whole recovery story, whether "the other machine" is a
laptop or a teammate's.

Then tell your agent about it, in whatever standing-instructions file it reads
(`CLAUDE.md`, `AGENTS.md`, a system prompt):

```md
Reading a big file or a long tool output? Pipe it through
`smelt <file> --budget 4000 --focus <what you are looking for>` instead of reading it
raw. For orientation in an unfamiliar repo, `smelt map <dir> --budget 4000`. Every
elided region leaves a marker ending in `retrieve("hash")` — when you need those exact
bytes back, run `smelt retrieve <hash>`.
```

The marker's `retrieve("hash")` **is** that command, and it is counted like any other
retrieval — so at the end of a session, `smelt stats` prints the same honest numbers
(`expansionRate`, `allElisionsRetrieved`, one `name value` per line; `--json` for the
envelope) that `smelter.stats()` gives a harness. The instruction pattern above works
with any agent that can run a command; the hooks preset below wires it in with real
enforcement.

### The hooks preset: `smelt hooks install`

```sh
smelt hooks install            # detects installed harnesses and offers them
smelt hooks install --harness claude-code
smelt hooks remove             # takes it all back out
```

Three hooks, individually toggleable, written into the harness's own config with the
same discipline as `smelt init` — every file listed before a final confirm, no
existing file ever overwritten without a per-file yes, re-runs edit toggles, and a
merge into an existing settings file leaves every byte outside smelt's own entries
untouched. The install also points `smelt.config.json` at a directory store (unless
the config already chose one), so the `smelt retrieve` the guard teaches actually
works across processes:

- **PreToolUse size-guard** (default on): a zero-dependency node script stats the
  target and refuses raw reads above a threshold (default 8192 bytes,
  `hooks.thresholdBytes` in `smelt.config.json`) with a reason naming the **exact**
  replacement — `smelt <that file> --budget <n>` — and the `smelt retrieve` way back.
  Windowed reads (offset/limit) always pass; so does anything the guard cannot judge
  whole. Malformed input fails open with a warning: a guard must never brick a
  session.
- **stats on Stop** (default on): `smelt stats` at session end — the expansion rate
  where the turn ends. Observation only.
- **repo map on SessionStart** (opt-in): a budgeted `smelt map` as opening context.
- **instruction-file lint on SessionStart** (opt-in): `smelt agents lint .` — a report
  on the AGENTS.md/CLAUDE.md/GEMINI.md that session is about to load on every request.
  Advisory; never blocks. See [`smelt agents`](#smelt-agents--the-file-that-loads-on-every-request).

Enforcement defaults to **deny-with-reason**: the transcript stays truthful and the
model learns to run the replacement itself. `"hooks": {"enforcement": "rewrite"}`
opts into in-flight substitution on harnesses whose hooks can modify tool input
(cat of an oversized file replaced by the smelt run; grep piped through smelt, no
`--focus` on the searched pattern — that would protect every matching line and elide
nothing). A substitution is never silent: it is announced in the decision reason
where the harness's rewrite schema carries one (Claude Code, Codex), on stderr where
it does not (Gemini, Cursor, Hermes, opencode), and falls back to deny where rewrite
is impossible.

One guard core, thin per-harness shims, three honesty tiers
(survey: [`docs/research/2026-09-02-harness-capability-matrix.md`](docs/research/2026-09-02-harness-capability-matrix.md)):

| Tier         | Harnesses                                     | What the tier means                                                                        |
| ------------ | --------------------------------------------- | ------------------------------------------------------------------------------------------ |
| verified     | Claude Code, Codex                            | hook schema verified against primary docs and pinned by recorded fixtures                  |
| experimental | Gemini, Grok, Hermes, Cursor, opencode, Cline | schema mapped from the capability matrix, **not yet smoke-tested against the real binary** |
| advisory     | KiloCode, Aider                               | no usable hook API — instructions only, and nothing enforces them                          |

This table is written by hand, and deliberately: `--help`, the install wizard and the
site all render the tier grouping from `HarnessProfile.tier`, so a mis-tiered profile
would move every one of them together and they would go on agreeing with each other.
This is the outside voice — `test/guards/harness-registry.test.ts` reads it and fails
when it and the registry disagree, and `pnpm mutate` promotes a harness to watch that
happen. A generated copy of the registry could not catch the registry being wrong.

Every install also writes the harness's instruction file (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`, `CONVENTIONS.md`) with the pattern above — belt and braces, and the part
that teaches `smelt retrieve` after a deny.

### As an MCP server

[`@smeltjs/mcp`](packages/mcp/) serves the same library as a stdio MCP server — four
tools (`smelt_file`, `smelt_retrieve`, `repo_map`, `smelt_stats`) over the same
`smelt.config.json`-discovered store the CLI uses, so `smelt retrieve <hash>` from a
shell and the model's `smelt_retrieve` hit one store and move one set of counters:

```sh
claude mcp add smelt -- npx @smeltjs/mcp
```

Codex and Grok TOML snippets, the tool contract, and the stdio-local guarantee (the
SDK's HTTP transports never enter the import graph — guard-enforced):
[`packages/mcp/README.md`](packages/mcp/README.md).

## `smelt agents` — the file that loads on every request

Your `AGENTS.md` is the one blob a coding agent pays for on **every single request**,
relevant or not. That is a context-budget problem, which is smelt's whole subject — so
smelt measures it:

```sh
smelt agents lint              # measure and explain; exit 0
smelt agents lint . --strict   # any finding exits 1, for CI
smelt agents lint . --json     # the versioned envelope
smelt agents split             # the mechanical half of the guide's refactor
```

It lints the **merged set** — every `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` in the
tree, because a nested one merges with the root. A merge runs _up_ the tree and never
across it, so two numbers come back and each says which question it answers: **per
request (worst case)**, the heaviest level plus its ancestors, which is what one agent
actually loads; and **whole tree**, every level summed, which is the repository's
instruction surface and a cost nobody pays in one request. Plus bytes per level and an
imperative count labelled a heuristic. Then eight advisory rules, each with a stable id
and an explanation citing the guide it applies
([aihero.dev/a-complete-guide-to-agents-md](https://www.aihero.dev/a-complete-guide-to-agents-md)):

| Rule                    | What it notices                                                           |
| ----------------------- | ------------------------------------------------------------------------- |
| `dead-path`             | a path-like token that resolves to nothing in the real tree               |
| `dead-link`             | a Markdown link whose relative target has moved or gone                   |
| `forcing-language`      | "always", "never", ALL-CAPS shouting                                      |
| `structure-dump`        | a directory tree, or a run of bare path lines                             |
| `generated-boilerplate` | init-script fingerprints (**the softest rule, and its own text says so**) |
| `language-rule`         | a const/let, interface-vs-type or quote-style rule loaded every request   |
| `mirror-drift`          | a `CLAUDE.md`/`GEMINI.md` that has diverged from its `AGENTS.md`          |
| `restated-at-level`     | the same line written at a level and at one of its ancestors              |

`dead-path` and `dead-link` are the point. Everyone else is linting Markdown; the
thing that has rotted is the repository the Markdown describes, and a renamed
`src/auth/handlers.ts` is not an invalid file — it is a lie the agent believes on
every request. A path with a separator is checked wherever it appears; a bare dotted
word is checked only inside backticks, because `Node.js` and `aihero.dev/…` are shaped
exactly like paths and one confident false accusation costs more trust than a dozen
real findings earn.

**No built-in size limit.** The guide's cited "~150-200 instructions" is printed as a
citation and compared to nothing. Set `{"agents": {"budgetBytes": 2000}}` in
`smelt.config.json` and exceeding **your** number exits 1, exactly as every other smelt
budget does — measured against the whole tree, the stricter of the two figures, so it
cannot be met by moving bytes into another package. Findings alone exit 0 unless you
pass `--strict`.

**There is no `smelt agents init`, and there will not be one.** The guide says in as
many words never to auto-generate an AGENTS.md, and smelt will not build the thing its
own source warns against. `smelt agents split` does the _mechanical_ half of the
guide's refactor — partition by `##` heading into `docs/`, rewrite the relative links
that moved a directory deeper, leave a link list behind, under `smelt init`'s consent
discipline — and then prints the guide's own refactor prompt with your real section
headings filled in, for you to hand to your own agent. Deciding which sections are
essential is a reading of your project; that needs a model, and smelt has none by law.

smelt's own [`AGENTS.md`](AGENTS.md) is written by hand to the guide's minimum
checklist and linted by this command, with [`CLAUDE.md`](CLAUDE.md) as the symlink the
guide recommends.

## Fine print on the API

Three things that look like bugs and are not:

- **`budgetBytes` is required** (unless `smelt.config.json` sets a default). A budget
  smelt invented would be smelt deciding how much of your context to throw away.
- **An unsupported language under `strategy: 'structural'` is refused, never
  approximated.** No silent downgrade to line windows wearing a `structural/v1` label.
  `strategy: 'auto'` is the way to ask for the choice to be made for you, and its
  results say which planner ran — a selector, not a fallback: a grammar that fails to
  load still raises, under `auto` exactly as under `structural`.
- **There is no expansion-rate warning threshold.** smelt measures the rate; policy is
  yours. The one computed fact is `stats().allElisionsRetrieved` — true when every blob
  smelt hid was asked for again, i.e. the elision saved nothing and cost a round trip.

## What is in the box

- **Structural planner** — parses with bundled tree-sitter grammars for **fifteen
  languages** (`typescript`, `tsx`, `javascript`, `rust`, `python`, `go`, `java`, `c`,
  `cpp`, `c_sharp`, `ruby`, `php`, `kotlin`, `swift`, `bash`), keeps focus-matched
  declarations whole — signature, doc comment, body — and collapses sibling runs into
  markers that name the kind and count from the parse tree. The Python survivor still
  parses; shebangs, Go build tags, Rust attributes and `#pragma once` stay pinned; a
  marker is only planned when it costs fewer bytes than it removes.
- **Lexical planner** — focus windows, head-tail, a context ladder under budget pressure.
  For logs, traces, diffs, and every other blob that is not code.
- **Persistent store** — `DirectoryElisionStore`: one file per content hash, atomic
  no-clobber writes, bytes re-verified against their hash on every read, counters in an
  append-only journal. No eviction, ever — a store that can forget turns "reversible"
  into "reversible, usually".
- **Cache-prefix hygiene** — `findPrefixDivergence` and `detectCacheBreakers` report the
  byte offset where two prompt prefixes diverge and the silent cache-breakers worth
  fixing (timestamps/UUIDs in system prompts, unsorted JSON keys, varying tool sets).
  **Detect and warn only — smelt never rewrites your prompt.**
- **Repo-map planner** — a ranked, budgeted symbol map of a whole repository: tree-sitter
  tags, deterministic PageRank over the reference graph, a caller-owned disk cache.
  Modelled on [Aider's repo-map](https://aider.chat/2023/10/22/repomap.html) and credited
  as such. Every included symbol can say why it ranked.
- **The setup surface** — `smelt setup` applies the whole recipe in one command (config,
  hooks preset, MCP registration, a proven round trip), `smelt doctor` reads installed
  state back and names exactly what is behind, and the version-stamped instruction
  blocks make "is this machine current?" answerable from pure shell. The recipe's facts
  live as data; the skill pack (`npx skills add smeltjs/smelt`) and this README render
  from it or are guard-pinned to it.
- **The hooks preset** — `smelt hooks install`: a zero-dependency guard core plus thin
  shims that wire the size-guard, stats-on-stop and map-on-start into agent harnesses,
  tiered honestly (verified / experimental / advisory — see the harness guide above).
  Deny-with-reason by default; rewrite opt-in and always announced — in the decision
  reason where the harness has one, on stderr where it does not.
- **The honesty machinery** — a guard suite per law and per guarantee, in the core and
  around the MCP server's stdio-local surface and the shared operations seam, that walk
  the real import graph, assert byte-exact reversibility, pin the wire format, and
  re-derive the attribution file; plus a mutation runner (`pnpm mutate`) that breaks the
  source on purpose — every mutation watched going red — and fails if a guard does not
  notice. The tally it counted last is committed in [`guards.json`](guards.json), guard
  by guard: the runner writes that file and refuses to run when it is stale, so the
  number is measured wherever it is read and stated nowhere else. Every guarantee in
  this README has a guard.

## Measured numbers

From the committed measurement harness (`pnpm bench`), tier 1 — bytes and elision counts,
deterministic, offline, reproducible by anyone from a fresh clone. Corpus commit
`1f65ab089364`, run 2026-09-02, `@smeltjs/core` at the same commit:

| case                            | planner       | in (B) | out (B) |             reduction |
| ------------------------------- | ------------- | -----: | ------: | --------------------: |
| large TS file (this repo's own) | structural/v1 | 22,462 |   3,680 |                −83.6% |
| multi-file grep result          | lexical/v1    |  6,451 |     986 |                −84.7% |
| java classes                    | structural/v1 |    689 |     366 |                −46.9% |
| stack trace                     | lexical/v1    |    542 |     389 |                −28.2% |
| build log (synthetic, labelled) | lexical/v1    |  6,984 |     108 |                −98.5% |
| TSX component (budget 700 B)    | structural/v1 |  1,090 |     861 | over budget, reported |

What these are: byte reductions on [a small committed corpus](packages/core/bench/), each
row reproducible with `pnpm bench`. What they are **not**: token savings, cost savings, or
an aggregate claim — the corpus is six cases, the build-log row is a synthetic
best-case and says so in its header, and one case came back over budget and is reported
as exactly that. Token counts (tier 2) and the **expansion rate** — the fraction of
hidden bytes the model asks back for, counted from real `smelt_retrieve` calls (tier 3) —
have not been run yet; when they are, the rows land in
[`bench/RESULTS.md`](packages/core/bench/RESULTS.md) with the date, corpus commit, and
model named, append-only. Until then this README claims nothing about them.

For the class of saving to expect on real agent traffic, the honest comparable remains
**Headroom's stated 21–57% across its four proof scenarios** (their README, 2026-09) — their
numbers, on their corpus, cited as exactly that.

## On units: bytes, and why that is the strength

**Budgets are UTF-8 bytes, permanently.** Bytes are the only unit computable **locally,
for every model** — the same property that makes the zero-network guarantee possible.
There is no local tokenizer for Claude (only a counting endpoint), and token budgets
silently redefine themselves between model generations (Anthropic: _"the same input text
produces approximately 30 percent more tokens"_ on newer tokenizers). A byte budget means
the same thing in five years.

Want the number in your own unit? Bring the counter you already have:

```ts
import { encode } from 'gpt-tokenizer'; // any local tokenizer you already ship

const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  measure: { id: 'gpt-tokenizer/o200k_base', unit: 'tokens', count: (t) => encode(t).length },
});
// result.measured = { measure, unit, input, output } — labelled, because a token count
// without its tokenizer named is not a measurement.
```

## Reranking: a seam, not a feature

There is no bundled reranker — a default reranker would ship every consumer's source to a
third party, including the consumers who never read the changelog. The `RerankStage`
interface is the whole offering: implement it in your code, with your key, so the
outbound call is visible in your own diff. `smelt init` will generate the skeleton into
your project if you want a head start.

```ts
import type { RerankStage } from '@smeltjs/core';

const myReranker: RerankStage = {
  id: 'my-hosted-reranker',
  async rerank(candidates, query) {
    // Your call, your key, your process. Visible here, in your source.
    const scored = await myClient.rerank({ query, documents: candidates.map((c) => c.text) });
    return scored.map(({ index, score }) => ({ ...candidates[index]!, score }));
  },
};
```

## Two stability promises, not one

- **The wire surface a model sees is stable from 0.1 and treated as 1.0** — the marker
  format `<<smelt/v1: … >>` and the `smelt_retrieve` tool contract. The marker carries
  its version in band; a future format arrives as `smelt/v2`, never as a quiet
  substitution. The marker goes into prompts: changing its shape would change model
  behaviour in every consumer as _worse output with no error anywhere_, which is the one
  thing smelt must never do.
- **The TypeScript API is `0.x` and may move.** Expect renames between minors. Snapshot
  the properties (round-trips, under budget, focus preserved), not the exact elisions.

## The four laws

The reasoning — _why_ breaking each produces a library that still looks like it works —
is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-four-laws-and-why-each-one-is-load-bearing):

1. **Zero network.** No external calls, in any code path, enforced by a guard that walks
   the real import graph from every entrypoint the manifest advertises.
2. **Every elision is explainable.** A named rule and a sentence a human can read in a
   diff. Never a model's opinion.
3. **Every elision is reversible, and expansions are counted.** Reversibility without
   counting is how "90% reduction" gets claimed while the model quietly asks for all of
   it back.
4. **Claim no number that has not been measured.** Absolute — which is why the numbers
   section above is a table with a date and a corpus commit, not a headline.

## Requirements

- **Node** `^20.19 || >=22.12`
- **pnpm** 10.15, for development only
- Nothing else. No database, no Docker, no compiler, no API key.

`@smeltjs/core` is an **ESM package**. From ESM, `import` it; from CommonJS, plain
`require('@smeltjs/core')` works too — the supported Node range above is exactly the
range where Node loads ES modules through `require()` without a flag, which is why the
engines floor sits where it does.

## Prior art, credited honestly

smelt's architecture is **close to Headroom's**, and it would be dishonest to imply
otherwise.

- **[Headroom](https://github.com/headroomlabs-ai/headroom)** — Python, same core shape:
  local store, a retrieve tool, BM25. Its CacheAligner's detect-don't-rewrite decision is
  copied here outright. If you need this today, in Python, use Headroom.
- **[Aider's repo-map](https://aider.chat/2023/10/22/repomap.html)** — the proven prior
  art the repo-map planner is modelled on: tree-sitter tags + PageRank + a budget + a
  cache.
- **[LLMLingua](https://github.com/microsoft/LLMLingua)** — the prompt-compression
  research line; its numbers are on non-code benchmarks.
- **[SweRank](https://arxiv.org/abs/2505.07849)**,
  **[LocAgent](https://arxiv.org/abs/2503.09089)**,
  **[Agentless](https://github.com/OpenAutoCoder/Agentless)** — learned code
  localization; a v2 conversation, because each puts a model in the retrieval path.
- **[Tree-sitter](https://tree-sitter.github.io/)** — the parsers under all of it.

**What smelt actually adds** — the whole list: the **zero-network guarantee**, the
requirement that **every elision explains itself in named-rule terms**, and the
**mutation-tested honesty machinery** that makes both claims checkable instead of
aspirational.

## Documentation

| Doc                                                            | What is in it                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                 | The deep dive: the four laws and their reasoning, the architecture file by file, the consumer contract, decisions |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                           | Dev setup, the guard/mutation convention, the recorded transcript of the zero-network guard going red             |
| [`packages/core/bench/`](packages/core/bench/)                 | The measurement harness: corpus, tiers, and the append-only results table                                         |
| [`packages/core/THIRD-PARTY.md`](packages/core/THIRD-PARTY.md) | Generated attribution for the bundled grammars. Never hand-edited; a stale copy fails `pnpm test`.                |
| [`assets/PALETTE.md`](assets/PALETTE.md)                       | The palette, the marks, and how to regenerate the rasters                                                         |

## Contributing

Contributions welcome — planners, languages, docs, and especially benchmark corpus cases.
Read [`CONTRIBUTING.md`](CONTRIBUTING.md) first: dev setup is two commands
(`pnpm install && pnpm verify`), but the convention around _guards that can fail_ is the
part that matters. `pnpm verify` is the gate; Conventional Commits.

## License

[Apache-2.0](./LICENSE). The consumer contract — the stable surface and the guarantees
any consumer can rely on — is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-consumer-contract).

<div align="center">
<br />
<img src="assets/smelt-mark.svg" width="40" alt="" />
<br />
<sub>Cut hard. Explain everything. Keep the ore.</sub>
</div>
