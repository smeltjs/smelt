# Setting up smelt — the operator guide

Everything about getting smelt into a coding agent's loop and keeping it there: the one
command, what it writes and where, machine-wide installs, the upgrade loop, the hooks
preset harness by harness, the MCP server, the instruction-file linter, the reranker
opt-in, and how to wire the library into a harness of your own. The
[README](../README.md) is the short version; [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)
is why each piece is shaped the way it is.

Two facts hold on every page of this guide. **Nothing here is written uninvited** —
every wizard lists what it will write and confirms before it does, `--yes` answers the
listing up front and never widens it. And **every command reports what it actually
did**, counted off the plan (`wrote 2, left 1 unchanged, skipped 1 — 4 files in all`),
under `--json` as the whole output.

## One command: `smelt setup`

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

## One project, or the whole machine

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

## Updating — and the other machine

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

## The hooks preset: `smelt hooks install`

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
[`docs/research/2026-09-06-platform-context-landscape.md`](research/2026-09-06-platform-context-landscape.md).

One guard core, thin per-harness shims, three honesty tiers
(survey: [`docs/research/2026-09-02-harness-capability-matrix.md`](research/2026-09-02-harness-capability-matrix.md)):

The tier table itself lives in the [README](../README.md#setup-in-one-command), and only
there.

That table is written by hand, and deliberately: `--help`, the install wizard and the
site all render the tier grouping from `HarnessProfile.tier`, so a mis-tiered profile
would move every one of them together and they would go on agreeing with each other.
This is the outside voice — `test/guards/harness-registry.test.ts` reads it and fails
when it and the registry disagree, and `pnpm mutate` promotes a harness to watch that
happen. A generated copy of the registry could not catch the registry being wrong.

Every install also writes the harness's instruction file (`CLAUDE.md`, `AGENTS.md`,
`GEMINI.md`, `CONVENTIONS.md`) with the pattern above — belt and braces, and the part
that teaches `smelt retrieve` after a deny.

## As an MCP server

[`@smeltjs/mcp`](../packages/mcp/) serves the same library as a stdio MCP server — five
tools (`smelt_file`, `smelt_retrieve`, `smelt_retrieve_batch`, `repo_map`,
`smelt_stats`) over the same
`smelt.config.json`-discovered store the CLI uses, so `smelt retrieve <hash>` from a
shell and the model's `smelt_retrieve` hit one store and move one set of counters. What
the server says before a model has asked it anything — five descriptions and its
`instructions` — is measured and held under a stated ceiling by a guard, because it is
the one context budget smelt spends on its own account in every session:

```sh
claude mcp add smelt -- npx @smeltjs/mcp
```

Codex and Grok TOML snippets, the tool contract, and the stdio-local guarantee (the
SDK's HTTP transports never enter the import graph — guard-enforced):
[`packages/mcp/README.md`](../packages/mcp/README.md).

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
[Reranking](#reranking-a-seam-and-an-opt-in-you-write-down).

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
imperative count labelled a heuristic. Then nine advisory rules, each with a stable id
and an explanation citing its source — the guide it applies
([aihero.dev/a-complete-guide-to-agents-md](https://www.aihero.dev/a-complete-guide-to-agents-md)),
or for `blanket-read` OpenAI's note on rewriting instruction files for a more capable
model ([developers.openai.com](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)):

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
| `blanket-read`          | "read A, B and C" with no occasion for any of them — every request pays   |

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

smelt's own [`AGENTS.md`](../AGENTS.md) is written by hand to the guide's minimum
checklist and linted by this command, with [`CLAUDE.md`](../CLAUDE.md) as the symlink the
guide recommends.

## Reranking: a seam, and an opt-in you write down

There is **no default reranker and never will be** — a default would ship every
consumer's source to a third party, including the consumers who never read the changelog.
With no `rerank` key in your `smelt.config.json`, nothing is loaded, nothing is imported
and nothing is called. That is what a default install does, and the zero-network guard
still walks the real import graph to prove it.

What you can do is opt in, in a file you own ([ADR-0004](adr/0004-rerank-config-seam.md)):

```json
{ "rerank": { "kind": "module", "path": "./smelt.rerank.ts" } }
```

```json
{ "rerank": { "kind": "voyage", "model": "rerank-2.5", "apiKeyEnv": "VOYAGE_API_KEY", "topK": 8 } }
```

`module` loads a `RerankStage` of your own; `voyage` loads
[`@smeltjs/rerank-voyage`](../packages/rerank-voyage/), a **separate package you install
yourself** and the only one in this repository that reaches the network. There is no
`SMELT_RERANK_API_KEY` and no environment variable smelt reads that your config did not
name. Every failure is a refusal that names what is missing — the path, the `topK` this
kind needs, the environment variable, the uninstalled package — never a quiet fall back
to an unranked run.

**Install the adapter beside the config that asks for it.** smelt looks in the directory
holding your `smelt.config.json` first and in its own install second, so a `~/smelt.config.json`
works with a `smelt` from Homebrew or `npm -g` — install into the directory that owns the
config:

```sh
npm install --prefix ~ @smeltjs/rerank-voyage    # for ~/smelt.config.json
npm install @smeltjs/rerank-voyage               # for a config at your project root
```

If it is in neither place, the refusal names both of them and the exact command for
yours. Reading the config's directory is the same trust you already gave that file: a
`smelt.config.json` chooses code smelt imports the moment it uses the `module` kind, and
nothing is loaded from either directory unless the config carries a `rerank` block —
nor does anything leave your machine until the environment variable it names is set.

An adapter's `exports` map must reach its entry under `default` or `require` (smelt asks
through `createRequire`). One that answers only `import` is reported as _installed and
unreachable_ rather than missing, because installing it again would change nothing.

**What a stage is asked, and what it may do.** When the planner has decided which regions
to remove, the stage is handed _those regions_ and your focus terms, and **whatever it
returns is spared** from the cut — a selection, not a ranking of everything, so apply your
own cut-off (`topK`, a `.slice`). It can only spare, never cut, so the worst a bad answer
can do is cost you bytes.

**And it spares only as far as your budget reaches.** The list you return is also an
_order_: smelt walks it best score first and spares while the output still fits the budget
you asked for, stopping at the first region that would not. So the head of your list is
what survives a tight run, and `topK` is a **cap** rather than a quantity — smelt never
fills it, and if the best-ranked region alone would break the budget, nothing is spared at
all. A plan that fits beats a plan that does not, and a reranker cannot cut, so the only
lever left is not sparing. The rule in one line: a K smelt invents is refused; a budget you
typed is honoured.

Stopping is deliberate rather than packing: a lower-ranked region might have fitted in the
headroom left behind, and taking it would re-rank your answer by size instead of by
relevance. What you get back is a **prefix of your own ranking**, which is the version you
can reconstruct from the report. And if the planner could not meet your budget in the first
place, your reranker is **not called at all** — nothing could have been spared, so nothing
of your source is sent anywhere to find that out; the report line says so.

A stage that throws — a timeout, a 401, a stub you have not filled in — is reported as the
refusal it is (`RerankStageError`, the CLI's refused exit code, an `isError` result from
`smelt_file`), never as a crash in smelt.

Every run that reranks says so, on a line of its own beneath the focus line — this is its
shape, not a measurement; every count is tallied per run and never estimated:

```
rerank  voyage/rerank-2.5  (<candidates> candidates, <kept> kept, <bytes> B back)
rerank  voyage/rerank-2.5  (<candidates> candidates, <kept> kept, <bytes> B back)   stopped at the budget: the stage offered <returned>
```

The second shape is the one to read closely: your `topK` came back with more regions than
the budget could afford, and the clause says so rather than leaving a number smaller than
the one you configured with no explanation beside it. The same facts ride in the `--json`
envelope (`result.rerank`, which also names `stopped` as `budget`, `cap` or `exhausted`)
and in `smelt_file`'s report block, and `smelt doctor` says whether your key variable is
set and where the adapter resolved from (`adapter from config dir`, `adapter from smelt's
own install`, `adapter not installed:` with the command, or `adapter installed beside
smelt.config.json but not loadable`, which also says smelt's own install was not tried and
why) — presence only, never the value. It reads the `module` kind by the same rule
the loader uses, so a config naming a package rather than a file is not reported as a
missing file.

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

## Wiring the library into a harness of your own

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
