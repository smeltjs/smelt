<div align="center">

<img src="assets/smelt-wordmark.svg" width="360" alt="smelt" />

**Structure-aware, reversible context optimization for coding agents.**
A library, not a proxy.

[![CI](https://img.shields.io/github/actions/workflow/status/smeltjs/smelt/ci.yml?style=for-the-badge&logo=githubactions&logoColor=EFEBE5&label=CI&labelColor=131417&color=E4602F)](https://github.com/smeltjs/smelt/actions/workflows/ci.yml)
[![network calls](https://img.shields.io/badge/network_calls-0-E4602F?style=for-the-badge&labelColor=131417)](#the-four-laws)
[![node](https://img.shields.io/badge/node-%5E20.19_%7C%7C_%3E%3D22.12-6E7783?style=for-the-badge&logo=nodedotjs&logoColor=EFEBE5&labelColor=131417)](#requirements)
[![License](https://img.shields.io/badge/license-Apache_2.0-6E7783?style=for-the-badge&labelColor=131417)](./LICENSE)

[Docs](docs/ARCHITECTURE.md) · [Vocabulary](CONTEXT.md) · [Changelog](CHANGELOG.md) · [Skill](skills/smelt/SKILL.md) · [llms.txt](llms.txt)

</div>

**Measured, in three numbers** — every row in [`bench/RESULTS.md`](packages/core/bench/RESULTS.md), logs committed:

| tokens sent, nine-case corpus                                                                     | expansion rate, whole-file tasks                                                                                                               | answer quality, A/B against raw                                                                                                                                                                                                    |
| :------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **−80%** · 109,348 → 21,696                                                                       | **0.94** · 17 of 18 blobs asked back                                                                                                           | **6 ties** · 2 raw better · 1 smelted better\*                                                                                                                                                                                     |
| Counted on the model's own tokenizer. _tier 2 · claude-opus-5 · 2026-09-07 · corpus 10462aa46b8e_ | The over-pruning alarm ringing where it should: 8 of 9 cases retrieved everything. _tier 3 · claude-opus-5 · 2026-09-07 · corpus 10462aa46b8e_ | Judged blind, one run, a model's opinion. \*The one "smelted better" is an artifact — [why](#tier-4--answer-quality--ab-one-judged-run-verdicts-are-a-models-opinion). _tier 4 · claude-opus-5 · 2026-09-07 · corpus 10462aa46b8e_ |

And the same honesty at your own keyboard — `smelt stats` after a session, per rule ([below](#sixty-seconds-from-a-shell)).

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

This is also the shape the vendors have arrived at from their side: Anthropic's
context-engineering guidance is to "maintain lightweight identifiers (file paths, stored
queries, web links, etc.) and use these references to dynamically load data into context
at runtime using tools"
([essay](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
The marker plus `smelt_retrieve` is that pattern — with every reference explained,
reversible, and counted.

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

## For agents

**AI agents / LLMs:** read [`llms.txt`](llms.txt) here — the summary, the four laws, the
three commands and the five MCP tool names, with a link list of everything else — or fetch
[`llms-full.txt`](llms-full.txt) (also served [from the site](https://smeltjs.github.io/smelt/llms-full.txt))
for every document in this list concatenated into one blob. Both are generated by
`pnpm generate:llms-txt` from the built packages; a hand edit fails `pnpm verify`.

There are exactly **two instruction channels**, and they teach the same commands from the
same [SetupRecipe](#one-command-smelt-setup) ([ADR-0002](docs/adr/0002-skill-pack-complements-marker-blocks.md)):
the **marker block** `smelt setup` writes beside the enforcement hooks, and the
**[SkillPack](skills/smelt/SKILL.md)**, which an agent's owner installs with
`npx skills add smeltjs/smelt`. Neither is written uninvited.

What an agent on 0.7.0 should actually do:

- **On Homebrew and upgrading from 0.6.0 or earlier, re-run `smelt setup`** — hooks written
  by those releases point at a Cellar path `brew upgrade` deletes.
- **`smelt setup --yes --scope user`** installs one config and one store for the whole
  machine instead of one per project ([below](#one-project-or-the-whole-machine)).
- **`smelt hooks install --yes`** is the non-interactive wiring, for CI and for any run
  with no terminal to answer a prompt.
- **`smelt doctor`** reports each wired artifact as `wired (verified)`, `wired but inert`
  or `wired but missing`, and exits 3 when something is behind — with the repair command
  named. Re-run `smelt setup`; never hand-edit what doctor names.
- **`smelt store prune --older-than 30d --dry-run`**, then the same line without
  `--dry-run`, is the only thing that deletes an elision. Nothing evicts on its own.
- **Reranking is opt-in and you write it down** — there is no default reranker, nothing is
  loaded unless a `rerank` key in your `smelt.config.json` says so, and the environment
  variable read is the one that config names
  ([below](#reranking-a-seam-and-an-opt-in-you-write-down)).

## Sixty seconds, from a shell

```sh
smelt src/server.ts --budget 4000 --focus handleRequest   # smelted text → stdout, report → stderr
smelt --budget 4000 --focus TypeError < build.log         # stdin works too
smelt big.log --budget 4000 > small.log                   # the two pipe apart
```

```
smelt packages/core/src/plan/lexical.ts --budget 4000 --focus planLexical
```

```
smelt  packages/core/src/plan/lexical.ts  typescript  lexical/v1
in 8,205 B → out 987 B   (-88.0%, 3 elisions)
focus  planLexical

  rule          lines  bytes  hash              explanation
  focus-window     49  2,077  8ce2e5af28e6d6f0  collapsed 49 lines with no match for the focu…
  focus-window     11    756  c35d231379780e11  collapsed 11 lines with no match for the focu…
  focus-window    141  4,715  9d211d0922e7bb2f  collapsed 141 lines with no match for the foc…
```

At the end of a session the store reports on itself — what it holds, the expansion rate,
the counters, then the ledger, one rule at a time. Real output of `smelt stats` after
`smelt packages/core/src/plan/lexical.ts --budget 4000 --focus planLexical --strategy
auto` and retrieving one of the two markers — the block below is regenerated from the
binary by `test/guards/readme-numbers.test.ts` on every `pnpm verify`, so it is this
build's output rather than a past release's:

```
smelt stats  /your/project/.smelt/store
2 blobs, 4.8 KB on disk

  expansion  ████████████░░░░░░░░░░░░  50.0%   1 of 2 elisions asked for back

  elisionsStored            2
  bytesStored           4,865
  retrieveCalls             1
  uniqueRetrieved           1
  misses                    0
  expansionRate           0.5
  allElisionsRetrieved  false

  rule              stored  retrieved   rate
  sibling-collapse       2          1  50.0%
```

In a terminal that is lava-coloured; in a pipe, in CI, under `NO_COLOR` or with
`--no-color`, it is exactly these bytes. `--json` is the surface to parse, and it never
carries a colour byte.

`expansionRate` is the fraction of what smelt hid that the model asked for back — the
honest signal of over-pruning, measured and never thresholded. The ledger is the same
signal per elision rule, so a rule whose every cut keeps getting asked back shows up as a
fact you can act on. Reading stats never moves them.

- `--strategy structural` parses the file and collapses whole sibling declarations,
  keeping every signature and doc comment. `--strategy lexical` (the default) uses focus
  windows — right for logs, traces, and anything that is not code. `--strategy json`
  cuts a JSON document by members and elements, `--strategy diff` cuts a unified diff by
  files and hunks, and each refuses any other content. `--strategy auto` picks by content
  kind first (json, diff), then by language (structural where a grammar is bundled,
  lexical otherwise), and labels what it ran — for a stream that is sometimes code,
  sometimes a build log, sometimes a diff.
- Every structural cut's report row carries an **outline** — the names of the
  declarations behind the marker — so you (or a model) can decide what to retrieve
  without retrieving it. `--producer '<cmd>'` names the command whose output you are
  piping, and derives the focus from it exactly as the hooks guard does.
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

The reranker question has three answers: `none` (the default — nothing is loaded and
nothing is called), a `module` of your own (the wizard writes a typed stub **into your
project** and points the config at it), or `voyage` (the separately-installed
`@smeltjs/rerank-voyage` adapter, keyed from an environment variable the wizard names and
never reads). Either non-default answer is written down as a `rerank` block in your own
config, because a reranker nobody opted into would ship your source to a third party. See
[Reranking](#reranking-a-seam-not-a-feature).

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
  store: new DirectoryElisionStore('.smelt/store'), // content-addressed, crash-safe, prune-only
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
harnesses it detects, the MCP registration for Claude Code, opencode, Codex and Grok
(JSON or TOML, whichever the harness reads), and a real
smelt → retrieve round trip to prove the loop. Interactive from a terminal — Enter
accepts every default. An existing file is **merged**, never overwritten: every entry
that is not smelt's is preserved, and every byte outside the region smelt edits is
unchanged. The
one file it will not write is one it would have to write whole (the opencode plugin,
Cline's hook wrapper) when the file there is somebody else's — that is reported
skipped, with the reason.

Every wizard — `setup`, `hooks install`, `hooks remove`, `init` — ends the same way: a
rule, a verdict counted off what was actually applied (`wrote 2, left 1 unchanged,
skipped 1 — 4 files in all`), and the two or three commands that follow from it. Under
`--json` the receipt is the whole output, as it always was.

For an agent, the whole interface is flags, and the receipt is the output:

```sh
npx @smeltjs/core setup --yes --harness claude-code --json
```

The four preset toggles are flags too, each `on|off`, on `setup` and on
`hooks install` alike. A toggle you do not name keeps whatever is already installed:

```sh
smelt setup --yes --harness claude-code --map on --lint on --json
```

Or hand the agent the skill, which teaches all of it in the agent's own vocabulary:

```sh
npx skills add smeltjs/smelt
```

Homebrew, from smelt's own tap:

```sh
brew install smeltjs/tap/smelt
```

The formula pulls Homebrew's own `node` by default. To use the Node already on your
PATH instead, `brew install --without-node smeltjs/tap/smelt` — that Node must clear
smelt's engines floor, `^20.19.0 || >=22.12.0`, and must live where Homebrew's build
environment can see it (e.g. `/usr/local/bin` or the Homebrew prefix), since a
version-manager shim (nvm, volta, fnm) that only your shell's `PATH` knows about is
invisible to the build.

Upgrading from 0.6.0 or earlier on Homebrew: **re-run `smelt setup`**. Hooks written by
those releases point at the versioned Cellar path `brew upgrade` deletes, and the guard
was inert through the `opt` symlink besides — it exited 0 with empty stdout, which every
harness reads as _allow_. A re-run rewrites both.

To see for yourself whether your guard fires, feed a shim the payload the harness would
send it. It reads stdin to EOF, so it needs one — running it bare just hangs:

```sh
# a file over the 8 KB threshold, and the PreToolUse payload for reading it
head -c 60000 /dev/zero | tr '\0' x > /tmp/smelt-probe.log
printf '%s' '{"hook_event_name":"PreToolUse","tool_name":"Read","tool_input":{"file_path":"/tmp/smelt-probe.log"},"cwd":"/tmp"}' \
  | node "$(realpath /opt/homebrew/opt/smelt/libexec/lib/node_modules/@smeltjs/core/dist/hooks/shims/claude-code.js)"
```

A `"permissionDecision":"deny"` document on stdout means the guard is live. **Empty
stdout means it is inert** — that is the 0.6.0 bug, and `smelt setup` is the fix.
(`realpath` ships with macOS 13+ and every Linux; on Linux `readlink -f` does the same,
and on older macOS drop the substitution — on any release carrying the fix above, the
`opt` path works directly.)

### One project, or the whole machine

Setup, `hooks install`/`remove` and `doctor` all take `--scope project|user`, and it
defaults to `user` when you run them from your home directory and `project` everywhere
else. The interactive wizards state what was detected and let you flip it.

A **machine** install is the one to reach for when you want one `smelt.config.json` and
one store behind every project: the config goes to `~/smelt.config.json`, which every
project below it finds because discovery walks up, and the store to `~/.smelt/store`.
Each harness file goes to that harness's **own documented user-level location** —
`~/.claude/settings.json` and `~/.claude/CLAUDE.md`, `~/.codex/hooks.json` and
`~/.codex/AGENTS.md`, `~/.gemini/settings.json` and `~/.gemini/GEMINI.md`,
`~/.cursor/hooks.json`, `~/.config/opencode/`, `~/.cline/` — not the project spelling
one directory up, which is a file nothing reads. A harness that documents no
user-level home for a file is listed as skipped, with the reason; it is never guessed.

```sh
cd ~ && smelt setup --yes --scope user --harness claude-code
smelt doctor --scope user
```

One step stays yours at machine scope: Claude Code's user-scope MCP registration lives
in `~/.claude.json`, a file Claude Code owns and rewrites, so setup prints the command
instead of editing it — `claude mcp add --scope user smelt -- npx @smeltjs/mcp` — and
doctor checks the key read-only and names the command when it is missing.

### Updating — and the other machine

An update is the same loop on every machine, forever:

```sh
smelt doctor
```

Doctor reads installed state and **never writes**: which release wrote the instruction
blocks, whether the config parses and its store directory exists, whether the MCP
registration is intact, and which pieces are orphans. It also **runs** every hook it
finds, for every harness, against an oversized file in a temporary directory, and says
what happened: `wired (verified)`, `wired but inert` (the command ran and allowed the
read, which is exactly what a shim reached through a symlink does) or `wired but
missing` (the script is gone, which is what `brew upgrade` leaves behind). That includes
the three harnesses whose hook is a file smelt owns whole rather than an entry in
somebody's JSON: Cline's wrapper and Hermes's YAML are run like any other shim, and
opencode's plugin is loaded — import graph and all — to prove it still exports its hook.
Exit 0 means current. When anything is behind or not firing, the report ends with the
exact repair command, which is always:

```sh
smelt setup
```

Setup is idempotent — a re-run on a current machine writes nothing and exits 0 — so
_upgrade, doctor, setup_ is the whole recovery story, whether "the other machine" is a
laptop or a teammate's.

Then tell your agent about it, in whatever standing-instructions file it reads
(`CLAUDE.md`, `AGENTS.md`, a system prompt — or their user-level siblings,
`~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`, if you want it everywhere):

```md
Reading a big file or a long tool output? Pipe it through
`smelt <file> --budget 4000 --focus <what you are looking for>` instead of reading it
raw. For orientation in an unfamiliar repo, `smelt map <dir> --budget 4000`. Every
elided region leaves a marker ending in `retrieve("hash")` — when you need those exact
bytes back, run `smelt retrieve <hash>`.
```

(The block `smelt setup` writes opens with "This project uses smelt" — or "This machine
uses smelt" at `--scope user`, since a block in `~/.claude/CLAUDE.md` is loaded in every
project on the machine.)

The marker's `retrieve("hash")` **is** that command, and it is counted like any other
retrieval — so at the end of a session, `smelt stats` prints the same honest numbers
(`expansionRate` with a bar, `allElisionsRetrieved`, the counters, then the ledger as a
table — stored, retrieved and rate per elision rule, so you can see which rule's cuts
keep getting asked for back; `--json` for the envelope) that
`smelter.stats()` and `smelter.store.ledger()` give a harness. The instruction pattern above works
with any agent that can run a command; the hooks preset below wires it in with real
enforcement.

### The hooks preset: `smelt hooks install`

```sh
smelt hooks install            # detects installed harnesses and offers them
smelt hooks install --harness claude-code
smelt hooks remove             # takes it all back out
```

Or without a terminal at all — the same install, answered up front:

```sh
smelt hooks install --yes --harness claude-code --map on --lint off
smelt hooks remove  --yes --harness claude-code
```

Three hooks, individually toggleable, written into the harness's own config with the
same discipline as `smelt init` — every file listed before a final confirm, nothing
overwritten without a per-file yes in the wizard, re-runs edit toggles. A merge into an
existing settings file preserves **every entry that is not smelt's**, and leaves every
byte outside the `hooks` key unchanged — your other top-level keys, their indentation,
their escapes and their number spellings ride through verbatim. (Inside `hooks`, the
value is re-serialised: a foreign entry keeps its content and may come back formatted
differently.) Under `--yes` there is nobody to ask, so the plan's own shape answers
instead: a file with a merge behind it is written, because no entry of yours can be
lost, and a file smelt would write whole is left alone unless it is already smelt's —
reported skipped, with the reason, and the run still exits 0. The install also points `smelt.config.json` at a directory store (unless
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

The preset is **cache-safe by construction**. smelt transforms a tool result before that
result first reaches the model and never rewrites a prefix a provider has already cached —
the geometry both Anthropic and OpenAI document as the trap (retroactive clearing
invalidates a warm prefix, and must save enough to pay for the re-write). And caching
discounts a re-read; it never frees what those bytes still occupy — the context window,
the rate limit, the plan quota. The economics worked on list prices:
[`docs/research/2026-09-06-platform-context-landscape.md`](docs/research/2026-09-06-platform-context-landscape.md).

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

[`@smeltjs/mcp`](packages/mcp/) serves the same library as a stdio MCP server — five
tools (`smelt_file`, `smelt_retrieve`, `smelt_retrieve_batch`, `repo_map`,
`smelt_stats`) over the same
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
  marker is only planned when it costs fewer bytes than it removes. Over budget, a
  pressure rung re-prices each refused run as its own best profitable sub-run — the
  structural sibling of the lexical ladder below — and the escalation is stated on the
  elision itself (`sibling-collapse-pressure` on `reason.rule`), never inferred.
- **Lexical planner** — focus windows, head-tail, a context ladder under budget pressure.
  For logs, traces, diffs, and every other blob that is not code.
- **Persistent store** — `DirectoryElisionStore`: one file per content hash, atomic
  no-clobber writes, bytes re-verified against their hash on every read, counters in an
  append-only journal. No _automatic_ eviction, ever — no cap, no LRU, no TTL, nothing
  that deletes because a store was opened: a store that can forget by itself turns
  "reversible" into "reversible, usually". The one deletion is `smelt store prune
--older-than 30d`, which you type: it journals every eviction before it unlinks, so a
  later `smelt retrieve` of a pruned hash says `EvictedHashError` with the date rather
  than "it was never elided", and the counters do not move — `elisionsStored` keeps
  counting what went, so a prune cannot flatter the expansion rate. `--dry-run` first.
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
  state back — running every hook it can read as an entry, so `wired` is a fact about
  behaviour and not about text — and names exactly what is behind, and the
  version-stamped instruction
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

From the committed measurement harness (`pnpm bench`). Each tier's rows come from the last
run that measured it, and say so: tier 1 from run 2026-09-07 on corpus `19b11585126f`
(eleven cases — this repo's own planner source, real tool outputs, byte-exact files from
django, scikit-learn and sympy at pinned upstream commits, and two content-kind probes);
tiers 2–4 from run 2026-09-07 on corpus `10462aa46b8e` (the nine cases before the probes
were added), tiers 3–4 run once on `claude-opus-5`, their logs committed beside the rows ([`bench/RESULTS.md`](packages/core/bench/RESULTS.md),
append-only; [`tier3-log/`](packages/core/bench/tier3-log/), [`ab-log/`](packages/core/bench/ab-log/)).

### Tier 1 — bytes · deterministic, offline · corpus `19b11585126f`

| case                           | planner       |      in (B) |    out (B) | reduction           |
| ------------------------------ | ------------- | ----------: | ---------: | ------------------- |
| large TS file                  | structural/v1 |      35,458 |     11,324 | −68.1%, over budget |
| TSX component                  | structural/v1 |       1,090 |        861 | −21.0%, over budget |
| java classes                   | structural/v1 |         689 |        366 | −46.9%              |
| multi-file grep                | lexical/v1    |       6,451 |        986 | −84.7%              |
| stack trace                    | lexical/v1    |         452 |        344 | −23.9%              |
| build log (labelled synthetic) | lexical/v1    |      16,354 |        109 | −99.3%              |
| django query_utils             | structural/v1 |      13,389 |      1,697 | −87.3%              |
| sklearn _ridge                 | structural/v1 |      91,082 |     31,951 | −64.9%              |
| sympy boolalg                  | structural/v1 |     114,180 |      8,151 | −92.9%              |
| git diff (content-kind probe)  | diff/v1       |       4,132 |      2,706 | −34.5%, over budget |
| JSON log (content-kind probe)  | json/v1       |      11,447 |      3,280 | −71.3%, over budget |
| **corpus total**               |               | **294,724** | **61,775** | **−79.0%**          |

The two probe rows are the honest trade the kind planners make: on the same bytes the
lexical planner left 1,516 B and 2,996 B (earlier rows, same corpus), and the kind planners
keep more — every file and hunk header of the diff, the JSON skeleton with an outline of
every hidden key. Both were over budget under either planner.

### Tier 2 — tokens · `count_tokens` on `claude-opus-5`

| case               |    in (tok) |  out (tok) |  reduction |
| ------------------ | ----------: | ---------: | ---------: |
| large TS file      |      11,768 |      4,036 |     −65.7% |
| TSX component      |         429 |        353 |     −17.7% |
| java classes       |         256 |        172 |     −32.8% |
| multi-file grep    |       2,835 |        426 |     −85.0% |
| stack trace        |         196 |        148 |     −24.5% |
| build log          |       9,090 |         58 |     −99.4% |
| django query_utils |       4,534 |        577 |     −87.3% |
| sklearn _ridge     |      34,962 |     12,365 |     −64.6% |
| sympy boolalg      |      45,278 |      3,561 |     −92.1% |
| **corpus total**   | **109,348** | **21,696** | **−80.2%** |

### Tier 3 — the expansion rate · the honest signal, and it rang

Aggregate **0.94**: asked to _"read this file to understand X before editing it"_, the model
retrieved **17 of 18** elided blobs back — a LOSS on 8 of 9 cases (the stack trace retrieved
none). That is the alarm working, not the product failing: whole-file comprehension is the one
task shape that genuinely needs everything, and smelt exists to make that visible instead of
silent. On the question-shaped reads of tier 4, the same model retrieved 0–2.

### Tier 4 — answer quality · A/B, one judged run, verdicts are a model's opinion

| case               | raw in (tok) | smelted in (tok) | retrieves | verdict          |
| ------------------ | -----------: | ---------------: | --------: | ---------------- |
| large TS file      |       11,820 |            4,671 |         0 | tie              |
| TSX component      |          472 |            2,300 |         1 | tie              |
| java classes       |          296 |            2,050 |         2 | smelted better\* |
| multi-file grep    |        2,886 |            5,091 |         2 | raw better       |
| stack trace        |          232 |            1,748 |         1 | tie              |
| build log          |        9,138 |           10,597 |         1 | raw better       |
| django query_utils |        4,584 |            1,210 |         0 | tie              |
| sklearn _ridge     |       35,024 |           49,082 |         2 | tie              |
| sympy boolalg      |       45,322 |           15,024 |         2 | tie              |

Six ties, two raw-better, one smelted-better. Three honest readings:

- **Quality held.** On answerable questions, the smelted blob tied the raw one in 6 of 9 cases
  at a fraction of the input — and on the zero-retrieve cases the raw arm paid 2.5–3.8× the
  smelted arm's tokens.
- **Round trips re-bill.** Where retrieves happened, each tool round re-sent the transcript, and
  on 5 of 9 cases the smelted arm's summed input exceeded the raw arm's. Retrieval is the cost
  lever — which is exactly why smelt counts it, surfaces it as `expansionRate`, and refuses to
  threshold it for you.
- \* The one "smelted better" is an artifact: that raw arm returned an empty answer (0 output
  tokens; the judge's reasons in the committed log say so outright). Reported as measured, with
  the caveat here.

What these are: measured bytes, measured tokens on a named model's tokenizer, counted
`smelt_retrieve` calls, and one judged A/B run — every row reproducible or committed. What they
are **not**: dollar savings (no price table is committed; tokens are the measured unit), rates
from real agent traffic (tier 3's framing is a lab task, chosen to ring the alarm on purpose),
or an aggregate claim beyond this corpus. The nearest real-traffic comparable remains
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

## Reranking: a seam, and an opt-in you write down

There is **no default reranker and never will be** — a default would ship every
consumer's source to a third party, including the consumers who never read the changelog.
With no `rerank` key in your `smelt.config.json`, nothing is loaded, nothing is imported
and nothing is called. That is what a default install does, and the zero-network guard
still walks the real import graph to prove it.

What you can do is opt in, in a file you own ([ADR-0004](docs/adr/0004-rerank-config-seam.md)):

```json
{ "rerank": { "kind": "module", "path": "./smelt.rerank.ts" } }
```

```json
{ "rerank": { "kind": "voyage", "model": "rerank-2.5", "apiKeyEnv": "VOYAGE_API_KEY", "topK": 8 } }
```

`module` loads a `RerankStage` of your own; `voyage` loads
[`@smeltjs/rerank-voyage`](packages/rerank-voyage/), a **separate package you install
yourself** and the only one in this repository that reaches the network. There is no
`SMELT_RERANK_API_KEY` and no environment variable smelt reads that your config did not
name. Every failure is a refusal that names what is missing — the path, the `topK` this
kind needs, the environment variable, the uninstalled package — never a quiet fall back
to an unranked run.

**What a stage is asked, and what it may do.** When the planner has decided which regions
to remove, the stage is handed _those regions_ and your focus terms, and **whatever it
returns is spared** from the cut — a selection, not a ranking of everything, so apply your
own cut-off (`topK`, a `.slice`). Returning all of them keeps all of them, and the run
emits its input unchanged. It can only spare, never cut, so the worst a bad answer can do
is cost you bytes — and bytes are already reported, including when a reranker turns an
in-budget run into an over-budget one.

A stage that throws — a timeout, a 401, a stub you have not filled in — is reported as the
refusal it is (`RerankStageError`, the CLI's refused exit code, an `isError` result from
`smelt_file`), never as a crash in smelt.

Every run that reranks says so, on a line of its own beneath the focus line — this is its
shape, not a measurement; the two counts are tallied per run and never estimated:

```
rerank  voyage/rerank-2.5  (<candidates> candidates, <kept> kept)
```

The same three facts ride in the `--json` envelope (`result.rerank`) and in
`smelt_file`'s report block, and `smelt doctor` says whether your key variable is set —
presence only, never the value.

Writing your own stage is unchanged:

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
   the real import graph from every entrypoint the manifest advertises — and that names
   the one opt-in adapter package **forbidden** as an import, so it can only ever arrive
   the way you chose it.
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

- **[Headroom](https://github.com/headroomlabs-ai/headroom)** — the closest peer, and it
  has grown: a Rust core behind Python and TS SDKs, a proxy wrapping sixteen-odd agents,
  JSON statistical crushing, image shaping — and a trained model in the prose cut path,
  retrieval that expires with a TTL, and telemetry beacons on by default. smelt's shape
  (a local store plus a retrieve tool) started from its early Python form, and its
  CacheAligner's detect-don't-rewrite decision is copied here outright. If you want a
  proxy today, use Headroom. Surveyed against its live docs, 2026-09:
  [`docs/research/2026-09-06-peer-tools-survey.md`](docs/research/2026-09-06-peer-tools-survey.md).
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

**What smelt actually adds**, re-checked against the live field 2026-09
([survey](docs/research/2026-09-06-peer-tools-survey.md)): the **zero-network guarantee**,
guard-enforced and claimed by no peer; the requirement that **every elision explains
itself in named-rule terms**; retrieval that is **reversible without eviction and
counted** — the expansion rate, which no peer and no platform reports at all; and the
**mutation-tested honesty machinery** that makes these claims checkable instead of
aspirational. The nearest peers match the honesty _culture_ (llmtrim's disclosed
regressions, Headroom's no-artifact-no-number rule) — not the machinery, and not the
counting.

## Documentation

| Doc                                                            | What is in it                                                                                                     |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)                 | The deep dive: the four laws and their reasoning, the architecture file by file, the consumer contract, decisions |
| [`CONTRIBUTING.md`](CONTRIBUTING.md)                           | Dev setup, the guard/mutation convention, the recorded transcript of the zero-network guard going red             |
| [`packages/core/bench/`](packages/core/bench/)                 | The measurement harness: corpus, tiers, and the append-only results table                                         |
| [`docs/research/`](docs/research/)                             | Dated primary-source surveys: harness capability, peer tools, platform context economics, positioning             |
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
