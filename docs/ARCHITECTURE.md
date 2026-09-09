<div align="center">
<img src="../assets/smelt-mark.svg" width="88" alt="" />
</div>

# smelt — architecture

The deep reference. What smelt is, why each of its four laws exists, the architecture
file by file, the contract any consumer can rely on, and the design decisions with the
reasoning behind them. Read it before the code — the laws explain the shape of
everything else.

---

## What smelt is

smelt is a Node/TypeScript library that shrinks what a coding agent sends to a model,
without lying about what it removed. Given a blob of text — a file, a grep result, a
stack trace, a diff — and a byte budget, it returns a smaller blob in which the parts the
task needs survive and everything else has been replaced by a one-line marker that says
what went, how big it was, and a hash to get it back. The removed bytes are stored
locally, and the model is given a `smelt_retrieve` tool. Every retrieval is counted, so
over-pruning shows up as a number instead of as a model that is quietly wrong. It makes
no network calls, and a test fails if it could. It is a **library**, not a proxy: it
transforms content its caller hands it and never intercepts anyone's traffic.

---

## The four laws, and why each one is load-bearing

These are not preferences. Each one exists because breaking it produces a library that
_looks_ like it works, and a contributor acting in good faith will break them helpfully
unless they understand why they are there.

### Law 1 — zero network

**smelt makes no external calls. Code never leaves the machine.** Scoring is structural
(tree-sitter WASM) and lexical. Reranking exists as a _pluggable stage interface_ a
consumer opts into explicitly, in a config file they wrote — never a default, never
bundled, never an environment variable smelt picks up on its own (ADR-0004).

_Why it is load-bearing:_ the natural way to make a context optimizer better is to ask a
model which parts matter. The moment that becomes a default, every consumer of smelt is
shipping their users' source code to a third party — and they find out from a changelog,
or a proxy log, or not at all. There is no way to opt out of a default you did not know
existed. The zero-network property is also the only reason smelt is usable inside
companies that will never approve an outbound call from a dev tool, which is a large
fraction of the people who need it most.

The subtle failure is not someone adding `fetch()` on purpose. It is a grammar cache:
`web-tree-sitter`'s `Language.load()` accepts `string | URL`, and "download the grammar
on first use" is a perfectly reasonable-looking optimisation that works flawlessly on the
machine that wrote it. That is why `src/plan/grammar.ts` reads the `.wasm` bytes itself
and hands tree-sitter a `Uint8Array` — removing the capability rather than documenting it
— and why `assertLocalResource()` rejects any non-`file:` scheme before that.

Enforced by `test/guards/no-network.test.ts`, which walks the real import graph and
classifies _every_ edge. The walk is one machine (`packages/guard-kit`, test-only and
never published); the ruling on what an edge may be is one small `classify()` per
package, so both packages defend Law 1 with the same defences and their own verdict.
See "How to prove a guard can fail" below.

The one adapter that _does_ reach the network — `@smeltjs/rerank-voyage` — is a separate
package a consumer installs themselves, and the rulings name it as **forbidden** rather
than merely unvetted. Its name lives in `net/policy.ts` as data
(`OPT_IN_RERANK_PACKAGES`), `rerank/load.ts` hands that value to `import()` when a
consumer's own `rerank` config block asks for it, and three mutations prove the
distinction is real: a static import of the adapter in either package goes red, and so
does respelling the loader's dynamic import with a string literal. That last one is the
important one — it changes nothing about the running code, and everything about whether
the adapter is in the graph.

### Law 2 — every elision is explainable

**Every removal can state what it removed, in words, from a named rule.** "collapsed 3
sibling functions, retrievable" — never a model's opinion, never "compressed by 62%".

_Why it is load-bearing:_ explainability is what makes the output debuggable and the
library trustworthy at the same time. When an agent gets an answer wrong, the first
question is "what did it not see?", and a marker that says `collapsed 3 sibling
functions` answers it while `[...truncated...]` does not. It also disciplines the
implementation: a rule you cannot describe in a sentence is a rule you do not understand,
and it will do something surprising. This is why `ElisionReason` has two fields — a
stable `rule` id for counters and an `explanation` a human reads — and why every planner
must fill in both.

The consequence people find surprising: **no learned distillation in v1.** A model-written
summary cannot satisfy this law. "The model condensed this" does not say what was
removed, and once the text has been rewritten there is nothing left to store under a
hash. The interface exists (`DistillStage`); the implementation does not.

### Law 3 — every elision is reversible

**What is elided is stored locally, keyed by content hash; the model gets a stub plus a
`retrieve(hash)` tool. Expansions are counted.**

_Why it is load-bearing:_ reversibility is what makes cutting safe enough to do
aggressively. But reversibility alone is trivially gameable — a library that hides 90% of
every file is "reversible" and useless — so the second sentence carries as much weight as
the first. **The expansion rate is the honest signal of over-pruning.** If the model keeps
calling `smelt_retrieve`, smelt cut material the task needed, and each round trip cost
more tokens than the elision saved. A retrieve counter that is not wired up leaves that
rate pinned at a flattering zero forever, which is precisely the shape of failure this
project exists to refuse — hence `test/guards/expansion-counter.test.ts` guarding an
increment.

Two design consequences worth understanding before you change them:

- `AppliedElision.outputRange` records where the marker landed in the _output_. Without
  it, "reversible" would mean parsing markers back out of text, which is a guess.
  Reversibility is a fact recorded at the moment of the cut.
- `MemoryElisionStore` has no eviction and no `clear()`. A store that can forget turns
  this law into "reversible, usually", and a `retrieve()` that fails after an eviction is
  indistinguishable to the model from a hallucinated hash.
- **Reversible until the user prunes — and the prune is itself counted.** One global
  store shared by every session accumulates blobs forever, so there has to be a way to
  reclaim the disk; every way that does it quietly (a size cap, an LRU, a TTL applied on
  open) buys the space by having smelt decide which of someone else's elisions stopped
  mattering, at a moment they did not choose, with no record of what went. So the only
  eviction in smelt is `smelt store prune`: a verb a user types, against a cut-off that
  user names, which journals `evict "<hash>" "<date>"` **before** it unlinks anything.
  Two consequences make it compatible with this law rather than an exception to it. A
  later `retrieve` of an evicted hash throws `EvictedHashError` — "you pruned it on
  <date>", never `UnknownHashError`'s "it was never elided" — so the model can still tell
  a lost blob from a hallucinated hash. And the counters do not move: `elisionsStored`
  keeps counting what was evicted, because a prune that shrank the denominator would
  raise the expansion rate for free, and the per-rule ledger is untouched, because the
  rule did make that cut and nobody asked for it back. Only `bytesStored` falls, because
  only `bytesStored` measures the disk. `test/guards/store-prune.test.ts` pins all four.

### Law 4 — claim no number that has not been measured

**Absolute.** Not in the README, not in a doc comment, not in a commit message, not in a
tweet.

_Why it is load-bearing:_ this is the entire differentiator. The pitch this project began
from claimed "80–94% token reduction" and a "90%+ cache hit rate". Both are unsupported:
the second conflates Anthropic's 0.1× _price_ for a cached read with a _hit rate_, which
are unrelated quantities, and no benchmark producing either figure exists. Publishing
them would have been the first thing a knowledgeable reader checked and the last thing
they believed.

What is honest to say instead: state the **mechanism** and the **class** of expected
saving _with its source_. The nearest real comparable is Headroom's own stated **21–57%
across its four proof scenarios** (their README, 2026-09).
LLMLingua's 20× results are on non-code benchmarks. Until smelt has run its own harness
on its own traffic, the README states mechanisms and cites other people's numbers as
other people's. The measurement harness (below) is what changes that.

---

## The architecture, file by file

Everything below is typechecked, linted, and covered. `pnpm verify` is the gate.

### The library

| File                                        | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/core/src/types.ts`                | The vocabulary: `Planner`, `ElisionPlan`, `AppliedElision`, `ElisionStore`, `RetrieveStats`, `Measure`, `RerankStage`, `RerankAttribution`, `DistillStage`. Read this first — the doc comments carry the reasoning.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/src/rerank/protect.ts`       | The rerank **slot**, and its budget rung: between the planner's decision and the cut. The candidates are the planner's own proposed elisions; what a stage returns is what is spared, never added — best-first, and only while the predicted output still fits `budgetBytes` (`plan/budget.ts`, the arithmetic the planners' own rungs use). A K smelt invents is refused; a budget the user typed is honoured. Every way a stage can fail, throwing included, becomes a `RerankStageError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/src/rerank/load.ts`          | A `rerank` config block to a live stage. `undefined` in, `undefined` out; the opt-in adapter package is loaded by computed specifier and imported by nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/core/src/errors.ts`               | Every error is a `SmeltError`, so callers can tell "the library said no" from "something broke".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/core/src/hash.ts`                 | 16 hex chars of sha256. Short because the hash goes in every marker and the model pays for it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/core/src/detect.ts`               | Extension → language. `'unknown'` is a first-class answer, not a failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core/src/lang/`                   | One `LanguageProfile` per language — extensions, grammar wasm, marker leader, pins, structural node kinds, repo-map tag kinds. The registry is `Record<LanguageId, LanguageProfile>`, so totality is a compile error; every exported set is a derived view.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/src/store.ts`                | `MemoryElisionStore`: content-addressed, dedupes, refuses hash collisions, counts retrievals.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/core/src/store-dir.ts`            | `DirectoryElisionStore`: the persistent store — one file per content hash, atomic no-clobber writes, verify-on-read, counters in an append-only journal. See "The persistent store" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/src/stats.ts`                | `retrieveStats()` — the one derivation of the honesty arithmetic (`expansionRate`, `allElisionsRetrieved`) from a store's raw counters. Stores supply counts; they never derive the metric.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/src/retrieve.ts`             | `createRetrieveTool()` — the `smelt_retrieve` tool a consumer hands its model. Not MCP- or SDK-specific on purpose.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/src/apply.ts`                | `applyPlan()` (the only function that removes anything), `reconstruct()` (Law 3 as an equation), `MARKER_FORMAT_VERSION` — the wire surface, frozen — and `markerPricing()`, the one place a marker's byte cost is computed. No judgement at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/plan/lexical.ts`         | The lexical planner: focus-window and head-tail rules, a context ladder under budget pressure, profitability check so a marker never costs more than the lines it replaces. Deterministic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/src/plan/structural.ts`      | The structural planner for all fifteen supported languages. Refuses rather than falls back: an unmapped language or a failed grammar load throws `GrammarUnavailableError`, because output labelled `structural/v1` that is really line windows is undetectable from outside.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/core/src/plan/planners.ts`        | The `PLANNERS` registry, string → factory, and `DEFAULT_STRATEGY` beside it. Five entries now: `lexical`, `structural`, `auto`, `json` and `diff`. `createSmelter`, `--strategy`/config validation, the `--help` text, the `init` wizard's menu and the `smelt_file` tool schema all serve its keys.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/core/src/plan/auto.ts`            | The `auto` strategy: content kind first (`json`, `diff`), then structural where a grammar is bundled, lexical everywhere else — and the delegate's plan returned untouched so `result.planner` names what ran. A selector, not a fallback — a grammar-load failure travels out of it. See "Picking a planner" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/core/src/plan/kind.ts`            | `probeKind()` — the BlobKind probe: `'json'` when the text parses, `'diff'` when it carries a unified-diff header shape, `undefined` otherwise. A fact about the bytes, never a language sniff. See "Picking a planner" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/core/src/plan/json.ts`            | The JSON planner: members and elements as units, scanned with positions; runs of unmatched siblings collapse, matched containers are descended into, and with no focus the root is kept as a skeleton. Refuses non-JSON with `ContentKindError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/core/src/plan/diff.ts`            | The diff planner: files and hunks as units. Whole files the focus never touches collapse as a run; inside a matching file the non-matching hunks do. Refuses text without a diff header with `ContentKindError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/core/src/plan/offsets.ts`         | `utf8OffsetIndex()` — the one JS-index → UTF-8-byte conversion the structural and JSON planners share; every converted index is a unit boundary, so a range never splits a character.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/core/src/plan/budget.ts`          | What a plan costs once its markers land — `markerBytes`, `savingBytes`, `predictOutputBytes`, over the `MarkerPricing` seam. Every planner reads `budgetBytes` through it, and this is the one place any of them answers "how big is the output?".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/core/src/plan/grammar.ts`         | Loads a prebuilt grammar `.wasm` off disk, through `assertLocalResource`. Bundled copy first, `tree-sitter-wasms` as the source-checkout fallback. Cached.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/src/repomap/`                | `buildRepoMap()` — the ranked, budgeted whole-tree symbol map, read through the `RepoReader` seam in `repomap/reader.ts`. See "The repo map" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/src/agents/`                 | The `smelt agents` engine: the merged instruction set read through `RepoReader` (`instructions.ts`), the eight advisory rules and the measured report (`lint.ts`), the mechanical root/`docs` partition and the guide's refactor prompt (`split.ts`), and the guide's own phrasing quoted once (`guide.ts`). See "The `agents` verb" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/src/cache/prefix.ts`         | Cache-prefix hygiene: `findPrefixDivergence` and `detectCacheBreakers`. Pure functions; detect and warn, never rewrite.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/core/src/net/policy.ts`           | Law 1, written once: forbidden transports, forbidden globals, **and** the permitted sets — so the guard is a partition, not an allowlist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core/src/config.ts`               | `smelt.config.json`: versioned, found by walking up, defaults only, malformed is a loud usage error. Owns **both** directions — `parseConfig` and `renderConfig`, one key order — so the verbs that write the file cannot disagree about its shape. At the package root, not under `cli/`: the _file_ is a CLI concern, but the schema is read by `harness/`, `ops/` and `rerank/` too, and a module three layers depend on cannot live inside one of them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/src/cli/args.ts`             | `node:util.parseArgs`, zero new dependencies. Splits argv, answers `--help`/`--version`, looks the verb up in `SUBCOMMANDS`, and refuses every flag that verb does not own with one generated message — no per-verb branching left.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/src/cli/shell.ts`            | The CLI's edge, in one module: `CLI_NAME`, `CliIo` (the two sinks, their two colour switches and the colour depth the terminal reported), `AnswerStream` / `answerReader`, `EXIT`, and the closed-sink refusal — `closedSinkCode` / `refusingSink`, which turns `smelt hooks install                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | head`into one line and exit 2 rather than an EPIPE stack trace. **It imports nothing**, so every module under`cli/`can read it without making`args.ts → subcommands/* → args.ts`a cycle, and`AnswerStream`is stated structurally rather than as`NodeJS.ReadableStream`so the shipped declarations compile for a consumer with no`@types/node` in global scope. |
| `packages/core/src/cli/subcommands/`        | One `Subcommand` per verb — the flags it owns, its parse, its `Resolved*Run` merge, its run, its help block. `Record<Verb, Subcommand>`, so totality is a compile error; the USAGE block, the help sections and the flag refusals are derived views. `store.ts` is the eviction verb (`smelt store prune`) and the only thing in smelt that deletes an elision.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/core/src/cli/usage.ts`            | The help page and the front door, rendered from the registries rather than hand-arranged: each verb's USAGE line, its section, and the `map only.` / `hooks only.` prefix on the flags it owns come from `SUBCOMMANDS` and `CLI_FLAGS`, so a seventh verb or an eleventh flag reaches the help by existing. `test/__snapshots__/cli-usage.help.txt` pins the plain rendering, so a help change is a reviewable diff. The front door — bare `smelt` at a terminal — is the one list here deliberately _not_ derived: it is an opinion about the three commands a newcomer needs, not the ten the registry knows.                                                                                                                                                                                                                                                                                                                |
| `packages/core/src/cli/report.ts`           | Every rendering the CLI has — the stderr report, the map and prune reports, `smelt stats`. Every total is read off the `SmeltResult` or the store: two pieces of code counting the same bytes is how a report ends up disagreeing with its own library.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/core/src/cli/lava.ts`             | The **Palette**: every byte of colour smelt writes, and the primitives under it (`kv`, `table`, `bar`, `glyph`, `percent`, `logo`, and the `doneBlock` every wizard ends on). Roles, never colours, at a call site; off is the identity, padding is measured before painting, a non-zero never rounds to zero, and a closing block counts what was applied rather than what was planned. `colorDepth` asks how much colour the terminal has (`none`/16/256/truecolor) and the lava ramp resolves against it, so `38;2` reaches only a terminal that said it could render one.                                                                                                                                                                                                                                                                                                                                                  |
| `packages/core/src/cli/run.ts`              | The CLI as a function returning an exit code, so it runs in-process in tests. A lookup and a dispatch: the verb that parsed an invocation is the verb that resolves and runs it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/core/src/cli/init.ts`             | The `smelt init` wizard as a pure function over an input/output pair. See "`smelt init` and `smelt.config.json`" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/core/src/cli/hooks.ts`            | `smelt hooks install` / `remove` — the wizard, and only the wizard: the steps, the confirm, the prose. What both install verbs share moved out from under it — the plan (`harness/plan.ts`), the merge policy (`cli/merge-policy.ts`) and the installed toggles (`cli/installed.ts`) — so `setup` no longer imports a wizard to plan. See "The hooks preset" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/src/harness/plan.ts`         | What an install would write, and what `remove` takes back out: `planInstall` / `planRemove`, folds over `HarnessProfile.install` with no per-harness case, plus the hooks merge (which entries are ours, what a re-run replaces) and `renderConfigWithHooks`. In `harness/` because planning is not a verb; it imports nothing from `cli/` — the config schema it writes through is `src/config.ts`, at the root.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/cli/merge-policy.ts`     | The MergePolicy: one apply loop with a `Consent` adapter over it — `wizard` asks per file and takes a literal `yes`, `policy` reads `PlannedFile.ownership` (merged bytes are written, a whole-owned file that is not smelt's is refused, with a reason naming it). Both install verbs apply through it, because the loop that drifted would be the non-interactive one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/core/src/setup/recipe.ts`         | The **SetupRecipe**: the one true way to put smelt on a machine — the install commands, the recommended budget, the store default, the MCP run command, and the ordered setup steps — held as data, because prose is never the source. It names no harness: a _registration_ is `HarnessProfile.mcp`'s, so `mcp.run` (the stdio command any client registers) is the whole of its MCP block. It imports nothing and does nothing: it is the fact layer every setup surface reads, and the seam the `setup` verb, the skill pack and the site's fact generator hang off. `test/guards/setup-recipe.test.ts` pins everything that used to retype it — which is how the store default came to exist under three doc spellings, one of them wrong, and the MCP registration command in four places at once.                                                                                                                        |
| `packages/core/src/cli/setup.ts`            | `smelt setup` — the SetupRecipe applied end-to-end: config, the hooks preset over `planInstall` (which also carries the MCP registration, JSON or TOML, for every profile that declares one), the MCP step in the words that harness's own docs use (`HarnessProfile.mcp`) — Codex, Grok and opencode register through their own step, so the handover is _manual_ only where no selected harness carries a registration at all, and then it names none but `npx @smeltjs/mcp`, the plain stdio server any MCP client registers — with `mcp.commands` naming every registration a run is about, and a real smelt → retrieve round trip. One apply path under `--yes` and the wizard, and the merge policy is `cli/merge-policy.ts`'s, applied by policy consent: an existing file is merged, a whole-owned file that is not smelt's is refused. `smelt.config.json` is written once per run. A re-run is a byte-neutral no-op. |
| `packages/core/src/cli/wizard.ts`           | The wizard kit — the ask adapter, the step machine with real back, the confirms, the plan listing and the one write mechanic — shared by `init`, `hooks` and `setup`. Extracted (review II) because the third copy of the stream machinery was the one that raced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/core/src/cli/installed.ts`        | The one reader of InstalledState — blocks with stamps, hook wiring, MCP registrations, the config — behind doctor's verdicts and setup's repair policy, and the home of `presetToggles`, the reading a re-run edits its four toggles from.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/src/cli/doctor.ts`           | `smelt doctor` — the verdicts over InstalledState. The reading is `cli/installed.ts`'s; this module decides and reports: which blocks are behind the running binary, which pieces are orphans, whether each hook it can read actually fires (`probeHookCommand` → `wired (verified)` / `wired but inert` / `wired but missing`), what the store holds, and what the repair is. It writes no byte of your project (ADR-0003) — the oversized file a hook probe needs lives in a temp directory that is removed again — and the exit code carries the verdict, so the upgrade → doctor → setup loop needs no prose parsing.                                                                                                                                                                                                                                                                                                      |
| `packages/core/src/cli/agents.ts`           | The `smelt agents split` wizard — `init`'s consent discipline over the partition `agents/split.ts` computed. The only thing here that touches disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/src/text/json-edit.ts`       | The byte-faithful editors: `editTopLevelProperty` replaces, inserts or removes one top-level JSON property in the file's own bytes — every byte outside it rides through verbatim — and `upsertMarkerBlock` / `stripMarkerBlock` do the same for a delimited text block. Strings in, strings out; knows nothing about harnesses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `packages/core/src/text/toml-edit.ts`       | `json-edit.ts`'s TOML sibling (KOT-258): `editTomlTable` replaces, inserts or removes one `[a.b]` table — header form or dotted-key form — leaving every other byte, comment and dotted key verbatim. Codex's and Grok's `mcp_servers.<name>` registration, byte-faithfully.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/core/src/harness/`                | The `HarnessProfile` registry: one file per harness carrying its hook schema, detection paths, caveats, and what `install`/`remove` do — `Record<HarnessId, HarnessProfile>`, so totality is a compile error. Imports nothing from `cli/`, which is what lets `args.ts` derive the `--harness` list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/core/src/hooks/`                  | The zero-dependency guard core, the shim runtime (`shimFromSchema` turns a profile's schema into an adapter), and the runnable shim front doors it feeds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core/src/hooks/focus-terms.ts`    | `focusTermsFor(command)` — the one zero-import derivation of focus terms from a producer command, shared by the guard's rewrite wrap and the ops seam's `producer` hint. A search pattern only when the search prints context; nothing for a plain grep, a listing search, `cat` or a diff.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/src/harness/scope.ts`        | Where an install goes — project or machine — as one resolver: `locateStep(step, scope, {cwd, home})` returns the path, or a reason this harness documents none, or the command to run where the file is the harness's own to rewrite. Every writer and every reader goes through it, which is what stops doctor and setup agreeing on an install nothing is wired to. `locateFormer` is its read-only sibling: where a harness has renamed the directory it loads from, the step declares the old spelling and it is still read and still removed, never written.                                                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/harness/hook-command.ts` | What one hook entry says, as a value, and both directions over it: `renderHookCommand` is the only writer, `parseHookCommand` the only reader (three quotings, the `$(readlink -f …)` workaround, `undefined` for a foreign entry), and `probeHookCommand` runs the command against a payload built from the harness's own hook schema, in a scratch directory with the threshold pinned, so `smelt doctor` can say `wired (verified)` rather than `wired`. `probeOwnFile` is the same answer for a file smelt owns whole (Cline, Hermes, opencode), folding over the `HarnessOwnFileProbe` its profile declares: the command behind the renderer's own prefix, or an ES module loaded to prove its import graph resolves and it still exports the hook.                                                                                                                                                                       |
| `packages/core/src/hooks/invocation.ts`     | How smelt is re-invoked on this machine, answered once: `isSameFile` (realpath both sides, so a shim reached through a symlink is still the main module), `pathStability` (the verdict on one path plus the spelling to write — a keg rewritten to the `opt` alias `brew upgrade` re-points, and a recognised version-bearing segment reported as unstable), `smeltOnPath`, and `smeltInvocation()` — the ranked value every writer asks for instead of deriving a command of its own. Node builtins only, like its sibling guard core, which reads it.                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/core/src/ops/`                    | The operations seam, below both front doors: `smeltBlob`, `mapTree`, `retrieveBytes`, `readCounters` over already-resolved inputs (`ops/verbs.ts`), and the five laws an input must satisfy to be resolved (`ops/inputs.ts`). Exported from the barrel, so `@smeltjs/mcp` consumes it as a dependency instead of re-deriving it. See "The operations seam" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/cli/bin.ts`              | The `smelt` binary. Owns only what cannot be tested without a real process: the shebang, stdin on fd 0, the exit code.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/core/src/smelter.ts`              | `createSmelter()` — the smelter, its store and its stats, in one place. Outside `index.ts` so nothing under `src/` has to import the package barrel to build one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `packages/core/src/index.ts`                | The public surface, as a barrel. `createSmelter()` itself lives in `src/smelter.ts`, so nothing under `src/` imports the barrel to build a smelter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

### Stubs that throw (by design — read `CONTRIBUTING.md` § "A stub throws")

| File                          | Why it throws                                                                                                                         |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/stages.ts` | `unconfiguredRerankStage` and `unconfiguredDistillStage`. Both name the interface you were meant to implement. Out of v1 — see below. |

### The honesty machinery

One row per guard file in the repository, in the order `guards.json` lists them. How many
mutations each of them exports — and the totals over all of them — live in that file,
which the runner writes (`pnpm generate:guards`) and
`test/guards/guards-manifest.test.ts` keeps current. No count is retyped here, and no
digit for the tally appears anywhere in this document.

| Guard                                                   | What it guards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/guards/agents-lint.test.ts`         | Every claim `smelt agents` makes about somebody's instruction files. Each rule fires on its own fixture and no other rule is quietly doing the work; `dead-path` resolves against the real tree, counted call by call at the reader; the budget is the user's and there is no default; a mirror is not a level in the merged sum; every finding carries a published rule id, an explanation and an attribution; `--strict` is the only thing that turns a finding into a failure; and `split` neither overwrites without a per-file yes nor mints the finding it then reports.                                                                                                                    |
| `packages/core/test/guards/auto-strategy.test.ts`       | The `auto` strategy's two promises: every plan it returns carries the id of the planner that actually ran (never `auto/v1`), and a grammar that will not load comes back as `GrammarUnavailableError` rather than as line windows. The selector relabelling the plan it delegated, and the selector degrading into a `catch`-and-fall-back, both go red.                                                                                                                                                                                                                                                                                                                                          |
| `packages/core/test/guards/bench-results.test.ts`       | The harness's honesty: `RESULTS.md` rows carry date + corpus commit + tier (and model where required), stay append-only, never say "up to"; network shapes confined to `tier2.mjs`/`tier3.mjs`; `bench/` never enters the published `files` list.                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/core/test/guards/cache-hygiene.test.ts`       | Cache-prefix hygiene's promise: detect and warn, never rewrite — inputs stay unmutated, no export returns a "fixed" prompt, and no cache-hit-rate figure exists anywhere in `src`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/core/test/guards/config-writer.test.ts`       | The config file's two directions, and the one built-in strategy. `parseConfig(renderConfig(c))` equals `c` field for field for every shape a config can take, and the totality leg reads the key set out of the **reader's own refusal** — a key the reader learns and the writer forgets goes red without anyone remembering this file. `DEFAULT_STRATEGY` is pinned to the registry, to what a smelter given no strategy actually uses, and to the CLI's `builtin` provenance, with a scan refusing a second copy of the default anywhere in `src`.                                                                                                                                             |
| `packages/core/test/guards/doctor.test.ts`              | The update story's reader, held to its reading. A fresh install reports current at exit 0; an older binary over newer state reports behind at exit 3, naming `smelt setup --harness <id>` in both prose and receipt; a block that predates stamping is unversioned _behind_, never "not installed"; orphans are named; a clean tree is nothing-installed; and doctor never writes — every scenario asserts the tree is byte-identical afterwards (ADR-0003). The promise added when `wired` stopped being a fact about text: a wired hook is **run**, and reported `wired (verified)`, `wired but inert` or `wired but missing`.                                                                  |
| `packages/core/test/guards/expansion-counter.test.ts`   | The retrieve counter and `allElisionsRetrieved`, i.e. the observability half of Law 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/test/guards/guards-manifest.test.ts`     | The tally itself, as an artefact. Reruns the real mutation runner in `--print-guards` mode and fails when the committed `guards.json` differs; also refuses a document that has typed the digits back into its prose. An `artifact` mutation stales the committed copy and watches it go red.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/test/guards/harness-registry.test.ts`    | Harness totality: every profile the registry claims reaches the help text, every profile that ships a shim has a cited fixture (so the schema suite, which loops over the registry, tests it), and the one rewrite announcement stays one — including the copy spliced into the generated opencode plugin.                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/core/test/guards/hook-command.test.ts`        | The three promises a hook command makes to everything that has to read it again: `parseHookCommand(renderHookCommand(c, cwd))` is `c`, for every kind and both spellings; a command naming somebody else's script is **foreign** — the parser answers `undefined` and the merge that decides what a re-run may replace answers with it; and the one sanctioned spawn is `process.execPath` and nothing else, asserted over the source because that ruling is narrower than the `node:child_process` import Law 1 allows.                                                                                                                                                                          |
| `packages/core/test/guards/hooks-preset.test.ts`        | The hooks preset's promises: the size threshold wired to the config rather than a constant, and an installer that never overwrites an existing file — another tool's config included — without an explicit per-file yes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/core/test/guards/hooks-yes.test.ts`           | One merge policy behind both install verbs, driven through `runCli` because the flags are the interface being guarded. A merge keeps every foreign entry, indentation, key order and number spelling included; `--yes` merges rather than skipping, because a skip is how the one command an agent can drive fails to finish the install it started, silently, at exit 0; and `smelt.config.json` is written once per run, so no receipt names one file twice.                                                                                                                                                                                                                                    |
| `packages/core/test/guards/init-wizard.test.ts`         | `smelt init`'s one hard rule: an existing file is never overwritten without an explicit per-file yes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/core/test/guards/install-scope.test.ts`       | A machine install lands where the harnesses actually read, or is not written at all. A user-scope step goes to the harness's documented user-level location or is reported skipped — with no path to fall back to, so the old defect is unreachable rather than merely unwritten; the marker block says which _thing_ uses smelt; and doctor reads through the same resolver the writer wrote through. `home` is an injected temp directory in every case, because a user-scope plan writes into it.                                                                                                                                                                                              |
| `packages/core/test/guards/invocation.test.ts`          | How smelt is re-invoked, in three promises. A shim reached through a symlink still runs — the realpath compare, against a guard that otherwise exits 0 with empty stdout, which every harness schema reads as _allow_; a written command survives `brew upgrade`, so no hook entry holds the versioned keg an upgrade deletes; and where neither can be promised the warning is taken **per script written**, not from the invocation value, so the guard hook cannot go in bare while the lifecycle hooks report fine.                                                                                                                                                                           |
| `packages/core/test/guards/json-edit.test.ts`           | The byte-faithful JSON editor's one promise: the edit changes the property it was asked to change and no other byte. Insert-then-remove gives back the original bytes exactly, and with the property inserted the original text is the result with the inserted span cut out — rendered in the file's own indentation, which the round trip alone cannot see.                                                                                                                                                                                                                                                                                                                                     |
| `packages/core/test/guards/lava.test.ts`                | The wizards' renderer, held to the two properties that make the presentation seam safe: colour off is the identity — byte for byte what every other guard's assertions lean on — and styled text stays greppable, ANSI wrapping whole lines rather than splitting the substrings other guards assert. `--yes` and `--json` never style, however pretty the terminal.                                                                                                                                                                                                                                                                                                                              |
| `packages/core/test/guards/marker-format.test.ts`       | The wire surface. The rendered marker is pinned per version: the format cannot change without the version changing, and an unknown version fails.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/core/test/guards/mcp-registration.test.ts`    | The MCP registration as a profile fact, applied and removed byte-faithfully in whichever format the harness reads: an apply → remove round trip over a file that never carried the key lands byte-identical, a user's own servers ride through both directions, the written entry is the recipe's command split rather than a second spelling, a container that is not a JSON object is skipped loudly, and Codex's and Grok's TOML sibling composes with the `[features]` marker block on the same file instead of clobbering it.                                                                                                                                                                |
| `packages/core/test/guards/module-seams.test.ts`        | The install seam, in both directions. Nothing imports the wizard to plan — `cli/setup.ts`, `cli/installed.ts` and `harness/plan.ts` name `cli/hooks.ts` in no import; `harness/` stays free of `cli/` with no exception, the config schema having moved to `src/config.ts`; and each shared symbol is **declared once** in the whole of `src`, because an import edge that is merely absent is satisfied by a copy, and a copy is how the two verbs would come to disagree about whose file `CLAUDE.md` is.                                                                                                                                                                                       |
| `packages/core/test/guards/no-network.test.ts`          | Law 1. Walks the import graph from **every entrypoint the manifest advertises** (`exports` + `bin`, so the CLI is in the walk); classifies every edge; closes the vacuous-walk, unwalked-file, unvetted-dependency and unwalked-entrypoint holes; and rules on the opt-in `@smeltjs/rerank-voyage` adapter by name — an import of it is forbidden, not merely unclassified.                                                                                                                                                                                                                                                                                                                       |
| `packages/core/test/guards/ops-seam.test.ts`            | The operations seam, and the property it exists for: a law is stated once, and every front door goes through it. The law's own words appear in exactly one file under `src` — `ops/inputs.ts` — so a sentence copied back into a verb goes red even when the copy is correct; and the CLI's rendered refusal is compared against the ops law's own output, so a law changed in `ops/` and a front door that stopped calling it fail the same assertion from opposite directions. `packages/mcp/test/guards/ops-seam.test.ts` is the other end.                                                                                                                                                    |
| `packages/core/test/guards/packaging.test.ts`           | The tarball, audited as a consumer receives it: this guard packs the package and reads _that_, because each defect it exists for was true of the published bytes and of nothing under `src`. A declaration that only compiles in somebody else's configuration — checked by a compiler rather than a name list, building a scratch consumer around the real tarball with `strict`, `skipLibCheck: false` and `types: []`; source maps that resolve to files the tarball never carried; and a schema strict structured outputs will not register.                                                                                                                                                  |
| `packages/core/test/guards/palette.test.ts`             | The Palette, held to three properties, because a CLI that paints can lie in a new way. Off is the identity — every role, every primitive and the whole help page are the plain bytes, and `--json` is off whatever the terminal says, on every verb with an envelope. The switches are obeyed: `NO_COLOR` beats a terminal, `FORCE_COLOR` beats a pipe and names the depth, `--no-color` beats both, a non-TTY is plain, and the depth a terminal reports decides whether a ramp is truecolor, 256 or the sixteen. And a rendering may not round a non-zero to zero: `percent` prints `<0.1%` and the bar keeps one filled cell. The fourth, quieter one — padding is computed on unpainted text. |
| `packages/core/test/guards/persistent-store.test.ts`    | Law 3 across a process boundary. A damaged blob is refused as `StoreCorruptionError`, never returned; the retrieval counters survive a restart; "we hold damaged bytes" stays distinct from "never existed".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/core/test/guards/planner-registry.test.ts`    | The strategy seam. The `PLANNERS` registry carries exactly the shipped strategies, and the factory, `--strategy`/config validation and the help text all serve its keys — a dropped entry goes red on every face at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/core/test/guards/readme-numbers.test.ts`      | Law 4's first surface, cross-checked mechanically. Every Tier 1–4 figure the README quotes is looked up in `bench/RESULTS.md` by the corpus commit the README itself cites — never one hardcoded here — and the top-of-file summary must restate the same three numbers as the sections below it. The two "Sixty seconds" captures are not pinned prose either: the smelt transcript and the `smelt stats` block are both regenerated from the real binary, in a scratch project whose store is thrown away.                                                                                                                                                                                      |
| `packages/core/test/guards/repo-map.test.ts`            | The repo map's claims: the byte budget respected by construction, deterministic ranked output, content-hash cache invalidation, corrupt cache entries discarded loudly rather than trusted, and the walk counted call by call at the `RepoReader` seam — a symlink statted once and never read, an ignored path never statted.                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/test/guards/reversibility.test.ts`       | Law 3. `reconstruct(smelt(x)) === x` over multi-byte, CRLF, no-trailing-newline and one-20 kB-line inputs, plus every refusal.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/core/test/guards/setup-recipe.test.ts`        | The setup recipe is data, and it is owned once. Everything that used to retype the store default or the MCP registration command either imports `setup/recipe.ts` or is pinned to it — including each harness's own registration sentence, pinned against the section `packages/mcp/README.md` gives it. The recipe's MCP block is pinned to `run` alone, and Claude Code's CLI verb to the one profile that owns it.                                                                                                                                                                                                                                                                             |
| `packages/core/test/guards/setup-verb.test.ts`          | The one-command recipe, branch by branch: `--yes --json` applies the whole recipe with no prompts and names every file and every check; a re-run on a current machine is a byte-neutral no-op; the hard rule survives `--yes` — a file smelt writes whole and does not own is skipped, with the receipt saying so; a config that already carries choices keeps them; the refusals are the agent-facing interface (no stream without `--yes`, `--json` without `--yes`, an unknown harness answered with the known list); and the interactive wizard completes on Enter alone but for the final confirm.                                                                                           |
| `packages/core/test/guards/site-facts.test.ts`          | The site may only say what the packages say. The versions in the generated `site/src/generated/facts.json` are the two manifests' character for character, the generator refuses a missing or unparseable source rather than emitting a hole, and the tour's recorded-at version — the one string deliberately not generated, because it is provenance — never names a release the packages have not reached.                                                                                                                                                                                                                                                                                     |
| `packages/core/test/guards/skill-pack.test.ts`          | The published skill teaches only what the recipe and the MCP server say, and is the generator's output byte for byte: a hand edit to the committed `SKILL.md` is a red verify, the four MCP tool names are pinned to the server's own source, every command the recipe carries reaches the text, and Law 4 holds the prose — the only number in the skill is the recipe's budget.                                                                                                                                                                                                                                                                                                                 |
| `packages/core/test/guards/store-prune.test.ts`         | The one eviction Law 3 allows. `smelt store prune` evicts only what the user's cut-off reaches, a dry run deletes nothing, an evicted lookup throws `EvictedHashError` rather than claiming the hash was never elided, and `elisionsStored` keeps counting what went — so a prune cannot raise the expansion rate by shrinking its own denominator.                                                                                                                                                                                                                                                                                                                                               |
| `packages/core/test/guards/structural-totality.test.ts` | Tests for every claimed language: each id in `STRUCTURAL_LANGUAGES` must have a fixture, a committed snapshot and a doc-comment case — claiming a language without tests goes red.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/core/test/guards/structural.test.ts`          | The structural planner's claims: honest kinds and counts in every marker, no silent lexical fallback, doc comments attached, pins respected, a survivor that still parses in its own grammar, and the budget rung's over-budget escalation labelled by its own rule id, never silently.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/core/test/guards/subcommand-registry.test.ts` | The subcommand seam, and flag ownership. The `SUBCOMMANDS` registry carries exactly the shipped verbs with exactly the flags each documents, and **every verb is crossed with every flag it does not own** — each pair refused, with the usage exit code and a message naming the flag and the verb. A flag list widened to smuggle a foreign flag through, a verb dropped from the registry and the generated refusal removed from the parse all go red.                                                                                                                                                                                                                                         |
| `packages/core/test/guards/third-party.test.ts`         | Attribution. Reruns the real generator and fails if the committed `THIRD-PARTY.md` differs; also proves the generator refuses an unattributed grammar.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/core/test/guards/toml-edit.test.ts`           | `text/toml-edit.ts`'s half of the byte-faithful contract, over a corpus of hand-shaped TOML the installer itself never writes: insert-then-remove gives the file back, every foreign byte rides through (comments, a sibling table, a sibling registered by dotted keys, an inline table, a multi-line array with a trailing comma, CRLF, no trailing newline), and our own entry is found in either representation a hand edit could have left it in, then canonicalized to one table.                                                                                                                                                                                                           |
| `packages/mcp/test/guards/no-network.test.ts`           | The MCP server's stdio-local surface: the SDK's HTTP/SSE transports never enter the package's import graph, an SDK subpath off the explicit allowlist is forbidden rather than unclassified, and the forbidden lists are imported from `@smeltjs/core`'s `net/policy.ts` so the two packages cannot drift on what counts as a transport.                                                                                                                                                                                                                                                                                                                                                          |
| `packages/mcp/test/guards/ops-seam.test.ts`             | The operations seam from the far side, inside the package that once forked it: this server states no law of its own. The laws' words are absent, the machinery is absent — no stat, no blob read, no smelter, no store construction, no strategy fallback — and every ops function the package depends on is **named**, so a law dropped is as red as a law re-forked.                                                                                                                                                                                                                                                                                                                            |
| `packages/mcp/test/guards/packaging.test.ts`            | This package's half of the tarball audit, plus a re-fork check where the core's guard makes an assertion: `smelt_retrieve`'s schema is the core's, and this guard watches it stay the core's — one contract, never two documents a library caller and a model could be told apart by.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/rerank-voyage/test/guards/packaging.test.ts`  | The adapter's tarball, where the declarations defect bites hardest: an HTTP adapter's public surface is made of exactly the names a types package supplies — `AbortSignal`, `Response`, `Headers`, `Request` — and none of them announces itself with a dot, so the namespace rule is blind to them. The compiler check is what caught `AbortSignal` in an exported type in this package's first draft.                                                                                                                                                                                                                                                                                           |

And the machinery the guards run inside, which the tally does not count because none of
it exports mutations of its own:

| File                                   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/test/guards/_source.ts` | The package's guard anchor: one `guardAnchor(import.meta.url)` call into `packages/guard-kit`, which owns the helpers (`guardSrcRoot()`, `guardRoot()`, the string/comment stripper that stops `net/policy.ts` reporting its own word list), the `GuardMutation` shape, and `assertKeyedById` — the registry-key-is-the-id invariant applied to `LANGUAGE_PROFILES`, `HARNESS_PROFILES` and `SUBCOMMANDS`.                                                                                                                                                                                                                                                                                                      |
| `scripts/mutate.mjs`                   | **The meta-guard, as a thin runner.** Discovers the guard files — in every workspace package with a `test/guards/` directory — and applies each one's own `MUTATIONS` export, each of which must go red. A survivor is reported as a hole in the guard, not the mutation. It counts the tally rather than stating one: `guards.json` at the repository root holds the totals guard by guard, `pnpm generate:guards` writes it, and the runner refuses to start when the committed copy disagrees with the guard files — so no document here carries a digit that somebody has to reconcile.                                                                                                                     |
| `site/scripts/facts-data.mjs`          | Generates `site/src/generated/facts.json` — versions from both manifests, the tier table from `harnessesByTier()`, the structural language list and grammar set from the language registry, the tally from `guards.json`. A missing or unparseable source fails the build; nothing on the page is a package fact typed twice.                                                                                                                                                                                                                                                                                                                                                                                   |
| `scripts/bundle-grammars.mjs`          | Copies the grammars `WASM_BY_LANGUAGE` names into the package, so they ship. Reads the built map rather than keeping a second list.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `scripts/generate-third-party.mjs`     | Generates `THIRD-PARTY.md`. The grammar ↔ provenance mapping is a partition: an unattributed grammar throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `scripts/generate-skill.mjs`           | Renders the published `SKILL.md` from the built SetupRecipe, so the teaching channel for agents that never ran the installer cannot drift from the commands the installer runs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `scripts/generate-llms-txt.mjs`        | Renders `llms.txt` (the llmstxt.org index an agent fetches first) and `llms-full.txt` (every document that index names, inlined) from one document list and the built packages' own facts. The index is written twice, at the repository root and under `site/public/`, byte-identically; the companion is written once, under `site/public/`, because a second committed copy of the whole documentation set is a large regenerated blob in every docs diff. The ADRs are discovered rather than listed. `test/guards/llms-txt.test.ts` regenerates every committed copy, compares the index's two directly, refuses a companion at the root, and resolves every link in the index back to a file that exists. |
| `scripts/check-fresh-clone.sh`         | Installs and verifies from `git archive` output — tracked files only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `.github/workflows/ci.yml`             | `pnpm verify` on Node 20.19/22.12/24, plus the fresh-clone job.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

### What no number claims yet

- No dollar figure, and no rate from real agent traffic. The four tiers ran once
  (2026-09-07, corpus `10462aa46b8e`, `claude-opus-5`, logs committed): tokens measured
  on the model's own tokenizer, an expansion rate of 0.94 under deliberate
  read-the-whole-file framing — the alarm ringing as designed — and one judged A/B run
  (six ties, two raw-better, one artifact-tinged smelted-better). What is still
  deliberately unclaimed: cost in currency (no price table is committed; tokens are
  the measured unit), expansion on real agent sessions, and any aggregate beyond the
  committed corpus.
- Cross-file reasoning inside `smelt()` itself. The repo map covers the whole-tree
  shape as its own surface, but `smelt()` still sees one blob at a time.

---

## The subsystems

Each surface below is independently useful; together they are the library, its CLI, and
the measurement equipment that keeps the claims honest.

### The CLI

The smallest thing that makes the library visible: a `bin` on `@smeltjs/core`
(Decision 2), on `node:util.parseArgs`, with no new dependencies:

```sh
smelt src/server.ts --budget 4000 --focus handleRequest
smelt --budget 4000 --focus TypeError < build.log
```

Prints the smelted text to stdout, and a report to stderr so the two can be piped apart.

Below is a recorded run of the built binary on this repository's own `plan/lexical.ts`.
It is that session's capture, not a fresh one: `plan/lexical.ts` has grown since, so
these are the byte counts that run measured and not the ones the same command prints
today. It is kept as text rather than as a screenshot for exactly that reason — a stale
transcript is a diff a reviewer can read, and a stale image is a picture nobody can. The
README's transcript of this command is the one that cannot go stale at all:
`test/guards/readme-numbers.test.ts` regenerates it from the binary on every
`pnpm verify`.

```
smelt  packages/core/src/plan/lexical.ts  typescript  lexical/v1
in 7,297 B → out 985 B   (-86.5%, 3 elisions)

  rule          lines  bytes  hash              explanation
  focus-window     53  2,224  84998967370f38bc  collapsed 53 lines with no match for the focu…
  focus-window      4    253  cb63542ad561a25d  collapsed 4 lines with no match for the focus…
  focus-window    128  4,155  786640c78c602123  collapsed 128 lines with no match for the foc…
```

The properties the CLI holds, each pinned by a test:

- `smelt <file>` and stdin both work; `--budget` is required and its absence is an
  error, not a default.
- `--json` emits the `SmeltResult` verbatim, so it can be diffed in tests. It is nested
  in a versioned envelope alongside the elided bytes, because a result without its store
  is not reconstructible; `test/cli.test.ts` asserts the nested result equals the
  library's own, field for field.
- The report totals equal `inputBytes`/`outputBytes` from the result — no separate
  accounting.
- `--reconstruct` reads a `--json` result back and prints the original, proving the
  round trip from the command line. It verifies every hash against the bytes it keys and
  the reconstructed length against the recorded `inputBytes`, so an almost-right round
  trip fails.
- Exit code is non-zero when the plan came back over budget, and says so. Never silently
  over budget. Codes are distinct: 1 over budget, 2 usage, 3 refused, 4 unexpected.

**The seam: `Subcommand`.** A verb is one file under `src/cli/subcommands/`, and the
registry (`SUBCOMMANDS`) is `Record<Verb, Subcommand>` — the same shape as
`LANGUAGE_PROFILES` and `HARNESS_PROFILES`, so a verb without a file does not compile.
Each entry carries the flags that verb owns, its `parse`, its own `Resolved*Run` merge,
its `run`, and its help block; `parseSmeltArgs` looks the verb up by `positionals[0]`
and `runCli` is a lookup and a dispatch, with no per-verb branch in either.

The property this bought is **flag ownership**. There used to be no seam, only a
subcommand _shape_ restated in four modules, and its compounding cost was the refusals:
because no verb owned its flags, every verb refused every other verb's flags in prose —
`--harness` was refused in two places with two different sentences, `--ignore`/`--cache`
in a third, `--reconstruct` in a fourth, and `retrieve`/`stats`/`hooks` each re-derived
"which flags are mine" from `Object.entries(values)` with a bespoke exclusion list. An
eleventh flag edited five messages. Now ownership is declared once per verb and the
refusal is generated: it names the offending flag, the verb that refused it, where the
flag _does_ belong when exactly one verb owns it, and the one sentence that verb writes
about itself — at the same exit code (2) each hand-written refusal used.
`test/guards/subcommand-registry.test.ts` crosses every verb with every flag it does not
own, and three mutations prove the cross product can go red. The help follows the same
rule as `--strategy` and `--harness` already did: USAGE, the sections, and the
`map only.` prefix on an OPTIONS entry are rendered from the registries, and
`test/__snapshots__/cli-usage.help.txt` pins the bytes.

**Not in the CLI, deliberately:** no way to pass a `Measure`. A CLI flag cannot name a
function, and a plugin loader would be a dependency and an eval surface. The report
prints a measured line when the _library_ was given one.

### The operations seam

smelt has two front doors — the `smelt` binary and the `@smeltjs/mcp` server — and they
are not two products. They are two conventions for saying the same four things: cut this
blob, map this tree, give those bytes back, read the counters. The difference between
them is entirely at the edges: one reads argv and writes to two streams and returns an
exit code, the other validates a JSON Schema and returns a `CallToolResult`.

The middle was duplicated anyway. Some of it was shared correctly (`formatReport`, the
`PLANNERS` registry, `DirectoryElisionStore`, `loadNearestConfig`), but the law-carrying
half was not. **Five laws, two implementations each:**

1. a budget is a positive integer with no default;
2. an explicit strategy beats a configured one, and `lexical` fills last;
3. a tree reader refuses a file, and names the verb that wanted one;
4. a path is read, or the refusal names it;
5. a config decides a store.

The mechanical cause is one line of history: `src/index.ts` exported `resolveRun` and
`resolveMapRun` but **not** `resolveStoreRun`, so the MCP package could not import the
store law it needed and re-derived it — and once one law was being re-derived in that
package, the rest followed. That is the restatement the `ResolvedRun` seam had already
abolished inside the CLI, leaking across a package boundary because the seam it needed
sat on the wrong side of a barrel.

`src/ops/` is the seam, below both doors:

- **`ops/verbs.ts`** — `smeltBlob`, `mapTree`, `retrieveBytes`, `readCounters`, over
  **already-resolved** inputs, returning **data**: the smelted text and the values a
  report needs (`formatReport(outcome)` typechecks as written), a `RepoMap`, bytes,
  counters. An op never sees argv, never writes to a stream, never returns an exit code
  and knows nothing about `CallToolResult`.
- **`ops/inputs.ts`** — the five laws, each stated once. A law has two halves and only
  one can be shared honestly: the **rule and its reasoning** live here, the **naming**
  is the front door's and is passed in. `--budget` and `"budgetBytes"`, `map` and
  `repo_map`, `` `smelt <file>` `` and `smelt_file` — one sentence skeleton, two
  vocabularies, byte for byte what each surface printed before.

Nothing in `ops/inputs.ts` throws. The two doors refuse in different currencies — a
`CliUsageError` that exits 2, a tool error carrying `isError: true` — and a shared law
that threw would force one of them to catch and re-wrap the other's error type, which is
how an exit code changes by accident. A law that can refuse returns a `Ruling<T>`: the
value, or the sentence, for the caller to throw in its own currency. Nothing there
_finds_ a config either: `openStore` takes a decision `configuredStore()` already made,
so no library call's behaviour depends on the directory it was invoked from.

**`resolveStoreRun` is still not exported, on purpose.** The review named its absence as
the cause of the fork, and that is right about the cause and wrong about the fix: what
the MCP package needed was the store _decision_, not the CLI's _refusal_. The decision
(`configuredStore`) and its construction (`openStore`) are both exported now and both
packages use them. `resolveStoreRun` is the CLI's policy on top — `retrieve` and `stats`
refuse a memory store, because a fresh process cannot honestly read one — and the MCP
server deliberately rules the other way: it accepts a memory store, serves the whole
session from it (a resident process legitimately can) and appends its persistence hint at
the moment an unknown hash makes the difference bite. Exporting that refusal would have
offered the server the CLI's policy wearing the name of a shared law: the same fork,
running the other way.

**The guards are a pair**, because the mutation runner runs each mutation against exactly
one guard, in its own package. `packages/core/test/guards/ops-seam.test.ts` pins _stated
once_ over `src` and crosses it with the CLI's rendered refusals;
`packages/mcp/test/guards/ops-seam.test.ts` pins _states no law of its own_ over
`packages/mcp/src` and names every ops function the server must call. Break a law inside
`ops/` and the first goes red through the CLI; re-fork it in the server and the second
goes red through the tools. One law, two front doors, a guard watching from each.

### The structural planner

The reason smelt exists. `src/plan/structural.ts` parses with the language's grammar,
finds nodes matching `focus`, keeps each match's enclosing declaration — signature, doc
comment, body — and collapses its _siblings_ into one marker naming them. Fifteen
languages: TypeScript, TSX, JavaScript, Rust, Python, Go, Java, C, C++, C#, Ruby, PHP,
Kotlin, Swift and Bash — all from grammars `tree-sitter-wasms` prebuilds, zero new
dependencies, each grammar's licence verified (all MIT) and recorded in
`grammar-provenance.json`.

The properties it holds, each pinned by a fixture or guard:

- `collapsed 3 sibling functions` — the explanation names the _kind_ and the _count_,
  from the parse tree, not a line count.
- A kept declaration keeps its signature line and attached doc comment, always — in each
  language's own doc idiom (`///`, docstring, javadoc, PHPDoc, KDoc, `#`). A fixture
  asserts this on a file where the doc comment is 40 lines long.
- Ranges never split a multi-byte character and never cross a node boundary.
- Grammar load failure throws `GrammarUnavailableError`. It does **not** fall back to
  lexical. A caller who wants the fallback asks for it.
- Deterministic: same file, same focus, byte-identical plan. Asserted, not assumed.
- A snapshot test per fixture, so a plan change shows up as a reviewable diff, and a
  totality guard (`test/guards/structural-totality.test.ts`): every id in
  `STRUCTURAL_LANGUAGES` must have a fixture, a committed snapshot and a doc-comment
  case — claiming a language without tests goes red.
- **Non-goal, stated rather than hidden: units are root children only, one level.**
  `unitsOf` groups the parse tree's _root_ children and nothing deeper, so a class or
  object body is one opaque unit — kept whole the moment anything inside it matches
  the focus, collapsed whole otherwise, never split method by method. One very large
  class with one matching method and nothing else nearby to trade gets no elision at
  all under this planner; `--strategy lexical` covers that shape by lines, without a
  per-method name in the marker. Recursing into class bodies was considered and set
  aside — it would double the shapes the outline, the budget rung and the per-rule
  ledger all have to reason about, for a case the lexical planner already handles
  reasonably. `test/structural.test.ts` pins the behaviour with a fixture (one class
  the focus matches, one it does not) as a decision, not a bug to fix later.

Several rules were set by measuring a claim rather than trusting it, and each is guarded
by a mutation:

- **Every structural language lands its marker behind its own line-comment leader**
  (`# ` or `// `, `MARKER_LINE_COMMENT_LEADERS`). The plausible alternative —
  "brace-delimited languages keep their structure around an unparsable bare marker
  line" — was measured and is false: reparsing every language's fixture survivor with
  its own bundled grammar showed ERROR nodes spanning the kept declarations. Python's
  significant indentation makes the damage non-local; Ruby and Bash read the marker's
  own leading `<<` as a heredoc operator that swallows every kept declaration after it;
  PHP re-types the kept function into an expression operand. Only `'unknown'` — lexical
  text with no syntax to break — keeps the bare marker. The wire surface does not move:
  the leader wraps the frozen `<<smelt/v1: … >>` core, `outputRange` covers it, and
  reconstruction stays byte-exact. The guard reparses the post-`applyPlan` survivor for
  **every** structural fixture and asserts no ERROR or missing nodes the original parse
  did not have. Bare `applyPlan` follows the plan's language when picking its marker
  (`markerForLanguage`), so the documented `planStructural → applyPlan` composition
  keeps a survivor parsing without the caller wiring anything.
- **Rust outer attributes ride forward.** tree-sitter-rust parses `#[…]` as a top-level
  _sibling_ of the item it decorates, so a unit boundary between them would let a
  collapse strip `#[derive(…)]` — and the doc comment above it — off a kept
  declaration. Attributes (and their attached comments) attach unconditionally to the
  following item, the way the language means them.
- **A line-comment marker must own its whole line.** Python emits semicolon-separated
  top-level statements as separate nodes, the second starting mid-line; a `# `-led
  marker replacing the first would comment out the kept one. The planner refuses a
  collapse whose range does not end at end-of-line in such languages.
- **What governs a file never collapses.** The Go spec's mandatory blank line after
  `//go:build` means it can never attach to a declaration, and collapsing it silently
  changes which builds see the file — so it is pinned. So are shebang lines in every
  grammar shape (`#!…` as a comment in Python, a `hash_bang_line` in JavaScript and
  TypeScript, a `shebang_line` in Kotlin and Swift), Ruby's
  `# frozen_string_literal:` magic comment, PHP's `<?php` open tag, and C/C++'s
  `#pragma once` (a `preproc_call`, pinned by a per-type text pattern).
  `LanguageProfile` carries a `pinnedTypes` set for the non-comment cases.
- **A Ruby heredoc travels as one unit.** tree-sitter-ruby emits `heredoc_body` as a
  top-level _sibling_ of the statement holding the opener, so a focus matching the
  opener could keep it while the body collapsed — an unterminated heredoc that swallows
  every kept declaration after it, and tree-sitter reports **no ERROR node** for it at
  EOF, only a zero-width `heredoc_end`. The body extends the preceding unit
  (`ridesBackwardTypes`), and the survivor-reparse checker also flags zero-width tokens,
  so this whole failure class is visible to the guard.
- **Kotlin's import list does not swallow the next KDoc.** tree-sitter-kotlin extends
  the `import_list` node over a doc comment that directly follows it — the doc of the
  first documented declaration after the imports. The unit ends at the import list's
  last non-comment token and the trailing comment rides forward
  (`trailingCommentSplitTypes`); the kotlin fixture is exactly this shape.
- **Honest words where a grammar lumps kinds together.** tree-sitter-kotlin and
  tree-sitter-swift parse structs, classes, enums, interfaces and extensions all as
  `class_declaration`; the label is `type declaration`, because calling a Swift struct
  a class would be the marker overclaiming the tree. C/C++ preprocessor nodes are
  labelled `preprocessor directive`/`preprocessor conditional`; PHP's mixed-HTML `text`
  nodes are `html section`; Ruby's top-level control-flow blocks are `statement` — all
  counted as non-declarations by the mixed-heading rule.
- **The plan reads its own budget.** `planStructural` used to ignore `budgetBytes`
  entirely: it took every profitable maximal run and stopped. The review's case — 158
  bytes against a budget of 120 — showed what that costs. The maximal run there was a
  `VERSION = 1` statement and three classes, and pricing it whole earned a 106-byte
  marker against a 105-byte cut: one byte the wrong side of profitable, so nothing was
  elided and the plan came back over budget. The three classes _alone_ priced an
  82-byte marker against 92 bytes — a real 10-byte saving nobody was offered. So there
  is a **budget rung**, the structural answer to the lexical planner's context ladder:
  when, and only when, the plan is still over budget, each refused run is re-asked as
  its own best profitable sub-run, earliest first, stopping the moment the plan fits.
  Every candidate goes through the same `collapse` the first pass uses, which is what
  makes three things true by construction rather than by care — a focus-matched (or
  pinned) unit is in no run and therefore in no sub-run of one; nothing is minted whose
  marker is not strictly cheaper than what it removes, so the output cannot grow; and
  the enumeration is start-ascending, length-descending, so the plan stays
  byte-identical run to run. Budget pressure is the trigger rather than profitability
  because a maximal run is the better _explanation_: one marker naming everything it
  hid beats two naming halves of it, and trading that away is worth it to fit a budget
  and not worth it otherwise.

  **The escalation is stated, not inferred.** A cut the rung mints carries
  `sibling-collapse-pressure` on `ElisionReason.rule`, never the first pass's plain
  `sibling-collapse` — the sentence a human reads stays the same shape a first-pass cut
  of the same kind would earn, because `defaultMarker` renders `explanation` byte for
  byte and a longer sentence would spend the same bytes the review's own case counts
  on (its 92-byte cut prices against an 82-byte marker, ten bytes of room — the rule
  id costs the marker nothing, since `defaultMarker` never renders it). A plan that
  traded a maximal run's better explanation for a smaller cut under the same rule id
  as an ordinary profitable one would have changed its own rules silently: the CLI
  report's rule column, the `--json` envelope and the per-rule ledger (`ruleLedger()`
  in `stats.ts`) all key off that one field, so a caller reading any of them can tell
  an over-budget escalation from a first-pass cut without re-deriving which pass
  produced it. `test/guards/structural.test.ts` pins two mutants against this: one that
  makes the rung stop reading `budgetBytes` at all (the review's case goes back to zero
  elisions, over budget), and one that lets it fire when the plan already fits — the
  profitability floor `planLexical`'s ladder shares stays the only thing that runs
  under budget; the rung is over-budget-only by construction, and both breaks turn
  that into an accident.

**Size, measured** (2026-09-02, `ls -l packages/core/grammars/` after `pnpm build`):
the whole `grammars/` directory is 28,316,720 bytes ≈ 27.0 MiB, which is what
`bundle-grammars` prints — cpp 4.4, kotlin 3.9, c_sharp 3.8, swift 3.0, typescript 2.3,
ruby 2.0, bash 1.3, php 0.8, c 0.8, javascript 0.6, java 0.4 MiB among them. That is
the accepted tarball cost of "works offline" for fifteen languages.

### Picking a planner: the `auto` strategy

`lexical` and `structural` are both right answers to questions a caller may not be able
to ask once. A consumer smelting whatever a tool handed it — a `.ts` file this call, a
build log the next — had to name a strategy per call or accept the wrong one every other
call, and the two wrong answers are not symmetric: `lexical` on TypeScript is a working
planner doing a weak job, while `structural` on a build log is a `GrammarUnavailableError`.
So most callers picked `lexical` and never got the planner this library exists for.

`auto` (`src/plan/auto.ts`) is the third registry entry, and it is a **selector, not a
fallback** — the distinction is the whole design:

- It decides on a **fact**: whether the language carries a bundled grammar
  (`isStructuralLanguage`, the same membership test the structural refusal uses, stated
  once). That is knowable before a byte is parsed.
- **The plan labels what ran.** `auto` returns the delegate's plan untouched, so
  `result.planner` reads `structural/v1` or `lexical/v1` and never `auto/v1`. The id
  `AUTO_PLANNER_ID` names the selector object and is guarded against ever reaching an
  `ElisionPlan`, because `result.planner` is the only place the mechanism is stated.
- It never decides on an **accident**. A grammar that fails to load on a language smelt
  claims to support is a broken install, and `GrammarUnavailableError` travels straight
  out of `auto` exactly as it does under `strategy: 'structural'`. Catching it and
  answering with line windows would turn a loud environment fault into quietly worse
  output — Law 2's no-silent-downgrade reasoning arriving through a friendlier door.
- It changes **nothing** about an explicit `strategy: 'structural'`, which still refuses
  an unsupported language. A caller who named the planner asked for _its_ guarantees,
  and a refusal is the only answer that does not fabricate them. `auto` is a different
  request — "pick for me" — answered in the open.

**Kind before language.** One fact was not enough: a piped diff is path-less, detects
`unknown`, and could only ever reach the lexical planner, which sees lines and not hunks;
a JSON tool result reached the same planner, which sees lines and not members — and a
pretty-printed log's biggest values are single lines a line planner cannot cut at all.
That was a hypothesis until the bench measured it (rows `git-diff` and `json-tool-result`
at corpus `226c91db4f95`: lexical over budget on both — 1516 B against 1200, 2996 B
against 1500). So `auto` asks a second fact first: `probeKind()` in `src/plan/kind.ts`
answers `'json'` when `JSON.parse` accepts the text and `'diff'` when it carries a
unified-diff header shape, and `undefined` otherwise — a parse and a line shape, never
a sniff, and never a _language_ guess (`lang/registry.ts`'s refusal of that stands; a
content kind is a different fact). Two planners sit behind the same `Planner`
interface: `json/v1` (`src/plan/json.ts`) takes members and elements as units, collapses
runs of unmatched siblings, descends into matched containers, and with no focus keeps
the root as a skeleton with each container's keys on the outline; `diff/v1`
(`src/plan/diff.ts`) takes files and hunks, collapsing whole files a focus never touches,
inside a matching file the hunks that do not match, and inside a matching hunk the line
runs no match sits near — the lexical window, confined to the hunk, so it never keeps
more of a hunk than a line planner would (the bench's real diff mentions its focus term
in every hunk; without that third rule the planner cut nothing). Each refuses any other content
with `ContentKindError`, for the structural planner's reason, and each labels its plan.
The rows after the lexical ones in `bench/RESULTS.md` measure them on the same bytes, and
the honest reading is a trade, not a win: at corpus `19b11585126f`, `diff/v1` left 2706 B
(8 elisions) where lexical left 1516, and `json/v1` left 3280 B (5 elisions) where
lexical left 2996 — both still over the probe budgets. What the extra bytes buy is
structure the line planner cannot keep: every file header and hunk header of the diff,
so a kept `+` line still says which file it is in; the JSON document's skeleton, with an
outline naming every key behind every marker. On the probe cases the binding cost was a
single matched value in both planners' reach — the judge prompt's 2.2 KB string, the
one hunk every match sat in — which no member- or hunk-level cut can shorten. If a
byte-tightest survivor is what a caller wants on these kinds, `lexical` is one flag
away and `auto` has not moved the default.

`DEFAULT_STRATEGY` stays `lexical`, deliberately. Promoting `auto` would change which
planner runs, and therefore what `result.planner` says, for every existing caller who
never named a strategy: a behaviour change delivered to people who asked for nothing.
`auto` is opt-in, through `--strategy auto`, `"strategy": "auto"`, the `init` wizard's
third choice, or the `smelt_file` tool argument — every one of them a rendered view of
the `PLANNERS` registry, which is why the third entry cost one line of prose per face
and no new plumbing — and so are `json` and `diff`, the fourth and fifth.

### The measurement harness

The harness that lets smelt say a number — until it existed, Law 4 forbade all of them.
It lives at `packages/core/bench/` — outside `src/`, so the zero-network guard's walk is
untouched, and outside `files`, so it ships in no tarball. A committed corpus of real
tool outputs (`bench/corpus/`, provenance per file in `bench/README.md`), a runner
(`pnpm bench`, node + built dist, zero dependencies), and an append-only
`bench/RESULTS.md`. Network access exists only in `tier2.mjs`/`tier3.mjs`/`tier4.mjs`,
loaded dynamically on their tiers; tier 1 is offline by construction, and
`test/guards/bench-results.test.ts` plus its mutations keep it that way.

Four tiers, per Decision 8 — `count_tokens` is free, which is what makes the split
affordable: tier 1 is bytes and elision counts, deterministic, no key, reproducible by
any contributor offline. Tier 2 adds token counts through `count_tokens` — free, needs
any key. Tiers 3 and 4 are the paid parts: tier 3 is expansion rate, tier 4 is
answer-quality A/B (the same question against the raw blob and the smelted one, a
judge holding the raw blob as reference) — each run once, with its log committed as an
artifact so every reading is checkable from a committed file. Every row names its
model, and re-running on a newer model is a **new row, not an edit** — Claude's
tokenizer changed by ~30% between generations, and an edit would silently rewrite
history.

The properties it holds:

- The corpus is committed, reproducible by a stranger; the runner refuses to run against
  uncommitted corpus changes, so every row's corpus commit is real.
- Bytes _and_ tokens, never a byte count converted to tokens with a fudge factor. Tokens
  come only from `count_tokens` (tier 2, key-gated) and every token row names its model;
  no conversion exists anywhere in the harness.
- Tier 3 (`bench/tier3.mjs`) makes real model calls, counts `smelt_retrieve` calls
  through the store's own counters, writes a per-case retrieval log, and reports a case
  where the model retrieved everything back as a **LOSS**, with its input. It has
  deliberately not been run — it is the paid tier, run once with its log committed — so
  no expansion-rate number exists yet, and none is claimed.
- Output is a committed markdown table with the date, the corpus commit, and the model
  used. A number without those three is not a measurement. `bench/RESULTS.md`,
  append-only, guarded — and the guard forbids "up to" in the results file itself.
- The README's numbers section is written from this table or stays empty.
- The harness has no network access on the smelt side. Model calls are the harness's
  own, made explicitly, outside the library; `src/` cannot reach `bench/`.

### The persistent store

Elisions in memory die with the process; a long-lived agent session outlives the
process. `DirectoryElisionStore` (`src/store-dir.ts`) is a second `ElisionStore` over a
content-addressed directory, `node:fs` only — SQLite would have been either a new
runtime dependency (`better-sqlite3`) or `node:sqlite`, which is not stable across the
supported engine range. The storage layout is documented on the class.

The properties it holds, each pinned by a guard:

- The interface does not change: the reversibility and expansion-counter guards run
  against both stores.
- Still no _automatic_ eviction — no cap, no LRU, no TTL, and nothing that deletes a
  blob because a store was opened. The one eviction is `smelt store prune`, a verb (see
  Law 3 above and `src/cli/subcommands/store.ts`): it evicts only blobs older than a
  cut-off the user typed, `--keep-retrieved` spares the hashes the journal shows were
  asked for back, `--dry-run` frees nothing, and each eviction is journalled before the
  unlink so nothing goes unrecorded. Retrieval of an evicted hash therefore throws a
  _distinct_ `EvictedHashError` naming the date, never `UnknownHashError` — the model
  must be able to tell "never existed" from "we lost it". The same distinction already
  exists for damage: a blob whose bytes no longer hash to their name throws
  `StoreCorruptionError`, never `UnknownHashError`, and reads verify bytes against the
  hash so a torn write can never be handed back as a faithful retrieval.
- The prune's own honesty, stated once: **journal, then unlink**. The other order loses
  bytes with no receipt, which reads back as "never elided" for an elision the user
  themselves removed. The opposite failure — a receipt for bytes still present, left by
  an unlink that failed — is harmless, because `retrieve()` reads the blob before it
  reads the journal, so bytes this store is holding are always served; the failed unlink
  is counted as _kept_ and named on `process.emitWarning`
  (`SmeltPruneUnlinkFailure`). `readStoreSize()` beside it is the read-only half `smelt
doctor` uses, so reporting on a store never authors one.
- Counters survive a restart: every retrieval appends one fsynced line to an append-only
  journal, and `stats()` is a fold over it, so `expansionRate` stays meaningful across a
  session.
- The **ledger** survives with them: `applyPlan` — the one function that removes bytes —
  hands each cut's rule to `put(content, reason)`, the store journals `put "<hash>"
"<rule>"` beside the counter lines, and `ledger()` folds puts against hits into
  `{ rule, stored, retrieved }` rows through the one shared `ruleLedger()` derivation
  in `stats.ts` (both stores; neither derives it privately). The counter fold matches
  only `hit`/`miss`/`corrupt` lines and skips the rest, exactly as a reader that
  predates the ledger skips a line it does not know — so a directory written by this
  version reads as the same counters under the previous one, and `test/ledger.test.ts`
  pins that. The loop this closes was open by data absence, not wiring: retrievals were
  journalled per hash but the `ElisionReason` was never persisted, so "which rule's
  cuts get asked for back" was derivable from no artefact. It reaches the planner as
  opt-in `PlanInput.ruleHistory`, filled by `createSmelter` like `MarkerPricing` — data
  a caller's planner may weigh, never a threshold smelt applies (Decision 4) — and
  reaches a person through `smelt stats` (the ledger table: rule, stored, retrieved,
  rate) and `smelt_stats`'s second block.
- Concurrent writers do not corrupt the store. Tested with two processes, not two
  promises — `test/store-dir.test.ts` spawns two real `node` subprocesses against one
  directory. Writes are write-temp → fsync → `link(2)` (atomic, no-clobber), and
  `pnpm mutate` proves the verify-on-read and counter-persistence guards can go red.

### Cache-prefix hygiene

Provider prompt caches invalidate on any prefix byte change, so a context optimizer that
reorders or rewrites a prompt prefix can cost more than it saves. Headroom's CacheAligner
detects and warns about this volatility; **it never rewrites**, and neither does this.

`src/cache/prefix.ts` — pure functions, zero new dependencies, exported from the package
entrypoint. Provider cache facts (byte-matched prefix over tools → system → messages,
≈1024-token minimum, 4 breakpoints, 5 min/1 h TTL, 1.25×/2× write and ≈0.1× read
pricing) are encoded as cited constants naming Anthropic's docs and the date they were
verified. Guarded by `test/guards/cache-hygiene.test.ts`, with two mutations proving it
goes red.

The properties it holds:

- `findPrefixDivergence()` reports the byte offset of first divergence between two
  successive prompt prefixes and what changed — UTF-8 byte offsets, excerpts that never
  split a multi-byte character.
- Warnings only. No automatic rewriting of anybody's prompt — an optimizer that silently
  edits a prefix to help a cache is exactly the class of magic this library refuses.
  `detectCacheBreakers()` names each silent breaker (system-prompt timestamps and
  UUIDs, unsorted JSON keys, a tool set that varies between calls) with the
  `ElisionReason`-style rule id + explanation pair; the guard asserts on frozen inputs
  that nothing is ever mutated or "fixed".
- No claim about cache hit rates anywhere. See Law 4; this is the specific claim that
  was wrong in the pitch this project began from. The guard scans every source file for
  the phrase and a mutation proves the scan can go red.

### The repo map

smelt sees one blob. Aider's repo-map is the proven prior art for the other shape: whole
repository, tree-sitter tags, PageRank over the reference graph, a token budget, and a
cache.

`src/repomap/` (`buildRepoMap()`, exported from the entrypoint) is **modelled on Aider's
repo-map, credited as such** — the design is Paul Gauthier's
([aider.chat/docs/repomap.html](https://aider.chat/docs/repomap.html), `aider/repomap.py`
in [Aider-AI/aider](https://github.com/Aider-AI/aider)), not this project's; the module
doc comment says so. What smelt adds is its own house rules: local files only (the walk
never follows a symlink, skips binary files, honors a caller-supplied ignore list),
deterministic ranking (fixed damping and iteration count, sorted walks, a total
tie-break by rank → path → name → line — no `Math.random`, no `Date`), and Law 2 applied
to _inclusion_: every symbol in the map carries a rule id and a sentence naming its
definition site and the measured reference counts that ranked it. The tags cache is
plain JSON keyed by content hash — Aider persists through SQLite, but this repo ships
zero new runtime dependencies — and it lives **only** in a directory the caller
explicitly hands in; a damaged entry is deleted (best effort) and reported as a warning
in the result, never trusted and never fatal — named honestly as **corrupt** (unparseable
JSON, or the wrong shape) or **unreadable** (`readFileSync` itself refused: `EISDIR`, the
entry path is now a directory; `EACCES`, permission lost; anything that is not a plain
`ENOENT` miss), the same "damaged, not unknown" discipline the elision store already
applies. Both a discard that cannot delete its own entry and a write that cannot land
cost the next build a re-parse, never this one a crash — `read()` used to let a
non-`ENOENT` failure escape through `fsCall` as a `RepoMapIoError` that crashed the whole
map over one damaged cache entry the map never needed. Guarded by
`test/guards/repo-map.test.ts`, whose mutations prove that the budget, the tie-break,
cache invalidation, the corrupt-entry discard, the unreadable-entry discard, the symlink
refusal, the default ignore list, the error wrap, the cache bound and the two statements
of the resolution limit can each go red.

**php, kotlin and bash are path-only, and the map says so.** All three carry
`defKinds: {}` in their `LanguageProfile` — the extraction walk reads only node kinds
whose `name` field is itself an identifier node, and none of php's `name` nodes,
kotlin's field-less declarations or bash's `word` function names fit that shape, so
they are omitted rather than guessed at (`RepoMapFacts`'s doc comment in
`lang/profile.ts`). This is not a special case anywhere in `repomap/map.ts`: any file
whose extracted tags come back with zero definitions — an unmapped language, or one of
these three — falls into the same `pathOnly` list, under `REPO_MAP_PATH_ONLY_RULE`,
that a file smelt cannot detect the language of already uses. The file still appears in
the map, honestly labelled path-only, rather than looking like a structurally-supported
language that simply had nothing to report. `test/guards/repo-map.test.ts` fixtures a
php, a kotlin and a bash file and asserts both ends: `extractTags` itself returns
no definitions, and `buildRepoMap` renders the file into `pathOnly`, never into a
name-less, rank-less regular entry.

**What the ranking resolves, and what it does not.** A reference binds to a definition
**by bare identifier**. The tags carry names, not resolved symbols, so every definition
of a name receives every reference to that name wherever either lives: two files that
both define `run` share one another's inbound references and rank alike, two overloads
of a name each count the whole traffic to it, and a common identifier (`get`, `main`)
collects references that in truth belong to something else. This is Aider's design,
inherited on purpose — resolving properly means per-language import and scope
resolution, which is a type checker per language, and the map is a _ranking heuristic_
for what to read first, not a symbol resolver. What matters under Law 4 is that nothing
claims otherwise: `refsIn` and `refsInFiles` are honestly the references to, and the
files mentioning, the **name**, and each receipt says so. Anything that needs true
binding — rename, call graph, dead-code detection — needs a different tool. The
statement lives in the doc comments on `repomap/map.ts` and `repomap/rank.ts`, pinned
by mutation `repomap-ranking-limit-undocumented`. It is a decision, not an oversight left
unexamined: splitting rank shares per definer would mean per-language import/scope
resolution — exactly the type-checker-per-language cost the paragraph above rules out —
so the design stays Aider's, on Aider's own terms, and both halves of it are behaviour,
not only prose. `test/guards/repo-map.test.ts` pins the cross-file half (two files that
each define `shared`: identical `rank`, `refsIn`, `refsInFiles`) and, separately, the
same-file half — two definitions of one name in a single file, matching how a real
TypeScript overload set or a duplicated declaration parses (tree-sitter has no
duplicate-declaration check; it emits one `defs` entry per declaration it sees): both
definitions carry the same measured `refsIn`, so a caller reading the map meets the
"each counts the whole traffic to it" sentence as a fact about the numbers, not only a
warning in a doc comment. A change that split the shares — the alternative this section
rejected — would turn both assertions red.

**The default ignore list is `.git`, `node_modules`, `dist`, `build`, `out`,
`coverage`.** The first two are object storage and other people's code; the rest are
build outputs, and they are the sharper case. On a built TypeScript repo `dist/x.js`
and `dist/x.d.ts` sit beside `src/x.ts`, so a default list without them ranked and
rendered every symbol three times over, the copies referencing each other — the default
map of the commonest repo shape in this ecosystem was two-thirds its own compiler
output. It is still deliberately tiny and deliberately not a `.gitignore` parser, and a
caller-supplied list still **replaces** it wholesale rather than adding to it: a merge
leaves no way to say "map my `dist`, I meant it", and a default that cannot be turned
off is not a default. `--ignore`'s help text reads the list off `DEFAULT_REPO_IGNORE`
rather than restating it.

**Every failure is a `SmeltError`.** The consumer contract makes exactly one promise
about errors, and the repo map is the module most able to break it, because it walks a
whole tree the caller named: `buildRepoMap({ root: '/nonexistent' })` threw the raw
`ENOENT` from `readdirSync`, straight past a consumer catching `SmeltError` exactly as
documented. Every `node:fs` call under `src/repomap/` — the walk's `list`/`stat`/`read`,
and the tags cache's own reads and writes — now goes through `fsCall` in
`repomap/io.ts`, which raises `RepoMapIoError` naming the path and keeping the original
as `cause`. It adds no behaviour: the call fails at the same moment for the same reason,
inside the contract instead of beside it. A `SmeltError` from a caller's own
`RepoReader` passes through untouched.

**The tags cache is bounded, and the bound is a sweep.** Because the key is a content
hash, an edit does not replace an entry — it mints a new one and orphans the old, which
is invisible and permanent, so a long session accumulated the pre-edit version of every
file it ever mapped. Each build now deletes every entry it did not use, leaving exactly
the tags of the tree as it stands: an entry survives a build only if that build used it,
so the cache is at most one entry per mappable file. The safety rule any policy here has
to meet is that **a miss can only make a map slower, never wrong** — a missing entry is
re-extracted from the file's own bytes and a present one is only ever served for the
content that hashed to its key — so sweeping too much costs a re-parse and sweeping too
little costs disk, and neither can change a symbol in the map. The cost falls on a
caller pointing one cache directory at several trees, which is why the sweep's count
rides back in `RepoMap.cache.pruned` and is printed in `smelt map`'s report rather than
being hidden: one cache directory per tree is the shape this is tuned for.

**The seam: `RepoReader`.** The map reads its tree through one small, optional,
read-only interface — `list(dir)`, `read(path)`, `stat(path)` in
`src/repomap/reader.ts` — defaulting to `nodeFsReader()`, exactly the `readdirSync` /
`lstatSync` / `readFileSync` calls `buildRepoMap` used to make in-line. It is the same
move `decide(request, settings, cwd, statFile?)` makes for the hooks guard, and for the
same reason: with the filesystem injectable, the cases that used to need a temp
directory (an empty repo, a single file, a binary file, an unreadable file, a stale
cache key) are a table of literals, and the two claims that are really about _calls_
can be asserted by counting them. The symlink refusal is the sharp one: on a real
filesystem an `lstat` of a link reports neither file nor directory, so a walk with no
refusal at all still skips it — the guarantee was true by accident. A stub reader whose
`stat` _resolves_ the link removes the accident, and mutation
`repomap-symlink-refusal-dropped` proves the refusal can now be watched failing.
Read-only by construction: the interface has no writer, so the only bytes the map can
put on disk are the tags cache the caller named.

**The stat-then-read gap, and how far this closes it.** Refusing a symlink on
`isSymlink` at scan time stops the walk from ever following one it has seen — but the
scan used to run as two whole-tree phases: collect every vetted path first, then loop
back over the finished list to read each one's bytes. A path cleared by its `stat` early
in a large tree could sit unread for as long as the rest of the scan took, and nothing
stops the filesystem from putting something else at that path in the meantime — a file
swapped for a symlink escaping `root` would have its target's bytes read straight into
the map, past a refusal that had already run and already said no (a genuine, if
low-severity, TOCTOU: the audit's finding, KOT-205 §6). `scanFiles` now reads a file in
the same walk step that just proved it is not a symlink — `stat` and `read` are adjacent
calls for that one path, never separated by every other path's `stat` in the tree — which
closes the gap this module actually controlled. What is left is the single
`stat`-then-`read` pair itself: no injectable `RepoReader` can make that pair atomic
without an `O_NOFOLLOW` open the interface does not expose, which is the same residual
gap any program accepts when it opens a path by name on a POSIX filesystem, and is
accepted here rather than closed, deliberately, because the root is a path the map's
caller named and trusts — closing it fully would mean growing `RepoReader` to carry file
descriptors, a change with no test that could tell "closed" from "still open" without a
real concurrent writer racing the test process. `test/guards/repo-map.test.ts` proves the
adjacency itself: a stub tree's full call log shows every file's `stat` immediately
followed by its own `read`, with no other path's `stat` or `list` between them, and
mutation `repomap-read-not-fused-with-stat` reverts to the two-phase scan and watches the
adjacency assertion go red.

**The front door: `smelt map`.**

```sh
smelt map src --budget 4000 --focus handleRequest --ignore vendor --cache .smelt-tags
```

The ranked map goes to stdout, a short report (files scanned, symbols ranked, bytes
used against the budget, cache counts) to stderr, and `--json` emits the `RepoMap`
verbatim in its own versioned envelope (`smelt-map-cli/v1`). `--budget` follows the
same philosophy as everywhere else — required, no built-in default,
`defaultBudgetBytes` from `smelt.config.json` accepted, the refusal owned by
`resolveMapRun` in `src/cli/subcommands/map.ts` (`ResolvedRun`'s sibling, not a
contortion of it — the two commands share only the budget leg, so they share the seam
that owns precedence rather than a struct). `--focus` promotes matching symbols to the front of
the fill order with a `focus-match` receipt naming the term; ranks and counts are
never altered. One exit-code difference, documented in `--help`: **`map` never exits
1** — a smelt plan can come back over budget because smelt refuses to cut regions the
caller asked to keep, but the map fits itself to the budget by construction, so no
over-budget outcome exists to report. The report's "bytes used" figure is read off
`RepoMap.outputBytes` and guard-pinned to the actual stdout byte count, with mutation
`repomap-map-report-bytes-invented` proving the pin can go red.

**Deliberately NOT a planner strategy.** `buildRepoMap` returns a `RepoMap`, not an
`ElisionPlan` — nothing is elided, nothing is stored under a hash, nothing is
reversible — so it does not implement `Planner` and does not appear in the `PLANNERS`
registry. Forcing that interface would claim Law 3 about output that has no bytes to
give back; the module doc comment on `src/repomap/map.ts` states the same decision.

The properties it holds:

- Reads a repo, emits a ranked symbol map inside a byte budget. The budget is respected
  by construction — symbols are appended in rank order until the next line would not
  fit — and `outputBytes` is measured off the rendered text.
- Ranking is deterministic and explainable — every included symbol can say why it
  ranked. Two runs are byte-identical (asserted, with and without a warm cache), and
  each entry's `reason` states the definition site, references in (and from how many
  files), and its file's references out.
- Cached on disk, invalidated by content hash, bounded by a sweep, no network. The key
  hashes format version + language + file content, so an edit is a miss by construction
  and its superseded entry is deleted by the build that noticed; the module is
  reachable from the entrypoint and classified by the zero-network guard.
- Credits Aider's repo-map explicitly, in the code and in this document; the README's
  prior-art section carries the same credit.

### The hooks preset

`smelt hooks install` wires smelt into agent harnesses: one zero-dependency guard core
(`src/hooks/guard-core.ts`), thin per-harness shims mapping each harness's native hook
schema onto it, and an installer that writes the harness config — plus an
instruction-file snippet as belt and braces, because the snippet is also what teaches
the model to run `smelt retrieve` after a deny. Harnesses are tiered honestly —
verified / experimental / advisory — against the primary-source survey in
[`docs/research/2026-09-02-harness-capability-matrix.md`](research/2026-09-02-harness-capability-matrix.md).
Enforcement defaults to deny-with-reason; rewrite is opt-in and never silent. The
README's harness section is the user-facing walkthrough.

The guard is the **producer expert** — to decide anything about a `grep` it has already
parsed the pattern — and that knowledge used to die inside it: the deny reason printed
`--focus <?>` and the model reinvented what the guard knew. `src/hooks/focus-terms.ts`
is the one derivation, a zero-import sibling of the guard core (the guard's
no-library-import rule is a latency budget, so the derivation had to be a sibling
rather than an exception): `focusTermsFor(command)` answers _which terms distinguish the
output lines the task is about_ — a search pattern only when the search also prints
non-matching lines (`-C`, `-A`, `-B`), nothing for a plain grep whose every line already
matches, nothing for a listing search, nothing for `cat` or a diff. The rewrite wrap
carries the literal `--focus <term>` it derives, and `smeltBlob` applies the same
function to a `producer` hint (`smelt --producer <cmd>`, `smelt_file`'s `producer`),
filling only what the caller's own `--focus` left unsaid — so the guard and both front
doors cannot disagree about which terms a command names. The report attributes the
focus it planned with (`focus  handleRequest   (from --producer)`).

A harness is **one file**, `src/harness/<id>.ts`: its tier and caveats, the paths that
detect it, its instruction file, its hook schema as data (tool names, payload keys, the
deny and rewrite documents), and its install steps — each step's kind being also how
`remove` takes it back out (a JSON hook file is merged and strip-merged, a marker block
upserted and stripped, a file that is entirely ours written and deleted). The registry
is `Record<HarnessId, HarnessProfile>`, so a new id without a profile does not compile,
and it imports nothing from `cli/` — which is what lets `cli/args.ts` derive the
`--harness` id list instead of hand-typing it under two lists that were already derived.
`shimFromSchema` turns a schema into the adapter the shim script runs, and owns the
parts that used to be copied per shim: the rewrite-input splice, the deny fallback, and
the one announcement a rewrite makes on stderr — the constant the generated opencode
plugin splices in too, rather than carrying a fourth hand-typed copy where nothing could
see it drift. `ShimAdapter` stays public as the escape hatch for a harness a table
cannot express. Its MCP registration is on the profile too, twice over: the step that
writes it — `mcp-registration` in JSON, `toml-mcp-registration` in TOML — and
`HarnessProfile.mcp`, the same registration in the words a person would use to add it
by hand. `smelt setup` used to print the recipe's Claude Code command whatever harness
you named, which is a command about a file Codex and Grok do not read; it now prints
the fact of the harness that carries it, and where no selected harness carries one, the
plain stdio command any MCP client registers. The recipe no longer holds that command
at all — `claude mcp add smelt -- …` is composed in `harness/claude-code.ts` from
`SETUP_RECIPE.mcp.run`, so the verb a person is told to run and the server smelt wires
name one package by construction.

**Two install verbs, one plan and one policy.** `smelt hooks install` and `smelt setup`
answer the same three questions — what would be written, may an existing file be
written over, and what is installed already — so none of the three lives in either
verb. `harness/plan.ts` holds the fold over `profile.install`; `cli/merge-policy.ts`
holds the one apply loop and the `Consent` adapter over it; `cli/installed.ts` holds
the reading a re-run edits its toggles from. `cli/hooks.ts` is the wizard, and the only
module that imports it is its own verb. That seam is pinned in both directions by
`test/guards/module-seams.test.ts`: the import edges, and — because an absent import is
satisfied by a copy — the count of the declarations themselves.

### The `agents` verb

An `AGENTS.md` is the one blob a coding agent loads on **every single request**,
relevant or not. That is a context-budget fact, and a context-budget fact is what this
whole repository is about — so `smelt agents lint` measures it, using exactly the moves
the rest of smelt uses, and the source it lints against is one article:
[aihero.dev/a-complete-guide-to-agents-md](https://www.aihero.dev/a-complete-guide-to-agents-md).
Its phrasing is quoted once, in `src/agents/guide.ts`, and every explanation ends with
an attributed fragment of it, so a reader can always tell smelt's measurement from the
guide's opinion.

**It lints the merged set, and reports two numbers rather than one.** The guide's rule
is that a nested instruction file _merges with_ the root one — but a merge runs **up**
the tree and never across it, and a monorepo makes that difference visible. An agent
working in `pkg/a` loads the root file and `pkg/a`'s; it never loads `pkg/b`'s. So
`src/agents/instructions.ts` computes both, and each is printed under the question it
answers: `perRequestBytes`, the heaviest ancestor chain, which is the per-request cost
the guide's whole argument is about; and `totalBytes`, every level summed, which is the
repository's instruction surface. Summing siblings and calling the result a per-request
cost would be the same over-count this module already refuses for mirrors, and it would
be the one number the whole verb exists to state. The walk goes through `RepoReader` —
the repo map's seam, so every claim about the walk is asserted by counting calls against
a stub — and arranges what it finds by level. At each level the **primary** is the file
that level costs (`AGENTS.md`, or whichever mirror stands alone); a `CLAUDE.md` or
`GEMINI.md` beside one is a **mirror**, counted for drift and never for bytes, because
one agent loads one of them and summing all three would triple a cost nobody pays.

**Three rulings shape it, and each one is a rule this codebase already lives under:**

- **Measure, never threshold.** Bytes per level, the per-request worst case, the
  whole-tree surface, and an imperative count reported as `imperatives (heuristic)` —
  labelled, because "Run `pnpm verify`" counts and "The gate is `pnpm verify`" does not,
  and both are one instruction. The guide's cited "~150-200 instructions" is printed as
  a citation and compared to nothing, read from `guide.ts` rather than retyped in the
  renderer. The only number that can fail a run is `agents.budgetBytes` in
  `smelt.config.json`, which is the user's; exceeding it exits 1, the same over-budget
  code a `smelt` run uses. There is no default, for the reason `--budget` has none.
- **Explain every finding.** A finding is an `ElisionReason` — a stable `rule` id and a
  sentence — exactly like an elision. Eight rules: `dead-path`, `dead-link`,
  `forcing-language`, `structure-dump`, `generated-boilerplate` (the softest, and its
  own explanation says so), `language-rule`, `mirror-drift`, `restated-at-level`.
  Findings exit 0; `--strict` makes any of them exit 1 for CI, because rules about
  somebody's house style are advisory until that somebody opts in.
- **Resolve against the real tree.** `dead-path` and `dead-link` are the flagship and
  the reason to run this at all. Everyone else lints Markdown; the thing that rotted is
  the repository the Markdown describes. A renamed `src/auth/handlers.ts` does not make
  the file invalid — it makes it a lie the agent believes on every request. Resolution
  goes through the same reader as the walk, so a guard can prove the difference between
  a dead token and a live one is made by a `stat` and not by a string. The filters are
  half the rule: a scheme-less domain (`aihero.dev/…` — the guide smelt itself cites)
  and a product name (`Node.js`, `Bun.sh`) are shaped exactly like paths, so a token
  with no separator is a candidate only inside backticks, where the author has said
  "this is a thing in my repository". A false accusation on the flagship rule costs more
  than the finding it replaces is worth.

**`smelt agents split` states a seam rather than straddling it.** The guide's refactor
has a mechanical half — find the `##` sections, name their files, move the bytes, fix
the relative links that just moved a directory deeper, leave a link list behind — and a
judgment half: _which sections are essential?_ The first has a right answer and lives in
`src/agents/split.ts`, under `smelt init`'s consent discipline in `src/cli/agents.ts`
(every file listed, one confirm, an existing file never overwritten without its own
`yes`). The second is a reading of a specific project by someone who knows it, which
means a model, which Law 1 forbids — so smelt prints the guide's own refactor prompt
with the file's real section headings filled in and hands it over. That is the
unconfigured-rerank-stage pattern, applied to prose.

**There is no `smelt agents init`.** The guide says never to auto-generate an
AGENTS.md, and a tool that built the thing its own source warns against would be worth
less than no tool. smelt's own [`AGENTS.md`](../AGENTS.md) is therefore written by hand
to the guide's minimum checklist, with `CLAUDE.md` as the symlink the guide recommends,
and linted by the command it tests.

### The MCP server

[`@smeltjs/mcp`](../packages/mcp/) serves the same library as a stdio MCP server — five
tools (`smelt_file`, `smelt_retrieve`, `smelt_retrieve_batch`, `repo_map`,
`smelt_stats`) over the same
`smelt.config.json`-discovered store the CLI uses, so a marker minted anywhere can be
cashed in anywhere and one set of counters moves. Its stdio-local guarantee — the SDK's
HTTP transports never enter the import graph — is guard-enforced in its own package.
`smelt_file` honours the same `rerank` opt-in the CLI does, by handing the config block
to the core's loader; the server imports no adapter of its own, and its guard says so.

### The opt-in reranker adapter

[`@smeltjs/rerank-voyage`](../packages/rerank-voyage/) is the **one package in this
workspace that reaches the network**, which is why it is a package at all rather than a
module. It is not a dependency of `@smeltjs/core` — it peer-depends on it — and both
zero-network guards name it forbidden as an import, so it can only ever arrive the way a
consumer chose: `npm install @smeltjs/rerank-voyage` plus a `rerank` block in their own
config. It sends the query and the text of the regions the planner had already decided
to remove, and nothing else. See ADR-0004.

---

## How to run, test, lint

```sh
pnpm install
pnpm verify        # format:check → lint → build → typecheck → test → mutate
```

(Build precedes typecheck because `@smeltjs/mcp` typechecks against the core's built
declarations — on a fresh clone, typecheck-first would fail before the types exist. The
same order is what lets `typecheck` reach `site/`: its generator imports the built core,
and the site's components consume the core's shape through the JSON that generator
writes, so a renamed field is red here rather than on the deployed page.)

Individual gates: `pnpm build`, `pnpm test`, `pnpm typecheck`, `pnpm lint`,
`pnpm format`, `pnpm mutate`. Generated files: `pnpm generate:third-party` rewrites
`packages/core/THIRD-PARTY.md`, and `pnpm build` refills `packages/core/grammars/` —
neither is hand-edited, and a stale `THIRD-PARTY.md` fails `pnpm test`. Fresh-clone check:
`bash scripts/check-fresh-clone.sh` (installs from `git archive` output — tracked files
only). CI runs `pnpm verify` on Node 20.19/22.12/24 plus the fresh-clone job.

### How to prove a guard can fail

This is the part not to skip, and it is why `pnpm mutate` exists:

```sh
pnpm mutate
```

It copies `packages/core/src` to a scratch tree, applies one deliberate break, points the
guard at the copy via `SMELT_GUARD_SRC`, and asserts the guard goes **red**. Every guard
file exports its own `MUTATIONS`, beside the assertions that must catch them, and the
runner discovers and counts them — the totals it prints are the measurement; a survivor
is reported as a hole in the guard, not in the mutation.

Not every guard guards source code, so there is a second mutation kind: an `artifact`
mutation stales a _committed artefact_ — `THIRD-PARTY.md`, for instance — in a scratch
root the guard reads through `SMELT_GUARD_ROOT`. Nothing in the working tree is touched
either way, which is the point: a mutation runner that edits tracked files and then
crashes leaves the repository broken, and a failure here has to be safe.

The hand-run transcript of the zero-network guard failing — a real `node:https` import and
a real `fetch()` added to `plan/lexical.ts`, the exact output, then reverted — is in
[`CONTRIBUTING.md` § "The recorded failure"](../CONTRIBUTING.md#the-recorded-failure-watching-the-zero-network-guard-go-red).
Read it before you add a guard of your own; the convention for new guards is in the same
file.

---

## The consumer contract

smelt is a library, and every consumer — an agent harness, an app, a shell user — gets
the same surface. Nothing in this repository depends on, references, or requires access
to any particular consumer. This section is the contract.

**What a consumer depends on — the stable surface:**

```ts
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  // store: myPersistentStore,   // optional; see "The persistent store"
});

// 1. Shrink tool output before it reaches the model.
const result = await smelter.smelt(toolOutput, {
  path: 'src/server.ts', // language detection
  focus: ['handleRequest'], // what the caller was actually looking for
  budgetBytes: 4_000, // per-call override
});
// → result.text            what you send
// → result.elisions        what was cut, each with rule, explanation, bytes, hash
// → result.inputBytes / result.outputBytes

// 2. Expose the retrieval tool to the model, in your own SDK's shape.
const { name, description, inputSchema, invoke } = smelter.tool;
//   name === 'smelt_retrieve'; invoke({ hash }) → the exact original bytes
//   inputSchema is strict-mode shaped (additionalProperties: false, every property
//   required), so it registers as-is under OpenAI structured outputs
//   throws UnknownHashError on an unknown hash, and StoreCorruptionError when a
//   DirectoryElisionStore holds bytes that no longer hash to their own name —
//   surface either to the model as a tool error, never as empty text

// 3. Watch the honest signal.
const { expansionRate, retrieveCalls, elisionsStored, allElisionsRetrieved } = smelter.stats();
//   allElisionsRetrieved === true means every blob smelt hid was asked for again: the
//   elision saved nothing and cost a round trip. There is no threshold below that,
//   deliberately — see Decision 4.
```

**Optional: count in your own unit.** Budgets stay bytes (Decision 1). If you want tokens
in the result as well, hand smelt the counter you already have:

```ts
const smelter = createSmelter({
  defaultBudgetBytes: 8_000,
  measure: { id: 'tiktoken/o200k_base', unit: 'tokens', count: (text) => encode(text).length },
});
// → result.measured = { measure, unit, input, output }
```

**Also stable to consume: cache-prefix hygiene.** `src/cache/prefix.ts` is a
consumer-facing surface in its own right — pure functions, exported from the
entrypoint, composed with nothing else in smelt on purpose: cache hygiene is a
property of the request _you_ assemble, which smelt never sees or intercepts. Use it
from your own send path:

```ts
import { detectCacheBreakers, findPrefixDivergence } from '@smeltjs/core';

const warnings = detectCacheBreakers({ tools, system }, { tools: previousTools });
// → CacheWarning[]: a rule id + sentence per silent cache-breaker (a system-prompt
//   timestamp or UUID, unsorted tool JSON keys, a tool set that varies between
//   calls). Warnings only — your prompt is never rewritten, and no hit rate is
//   ever claimed.

const divergence = findPrefixDivergence(previousPrefix, nextPrefix);
// → undefined when the cached prefix survived (identical, or a pure append), else
//   { byteOffset, invalidatedBytes, description } — where it broke and what it cost.
```

**Also available:** the `smelt` binary, for seeing all of the above from a shell without
writing a script. `smelt <file> --budget <bytes> --focus <term>` prints the text on stdout
and the report on stderr; `--json` and `--reconstruct` round-trip through a file; and
`smelt map <dir> --budget <bytes>` renders the whole-tree ranked symbol map with the
same stdout/stderr split.

**Guarantees a consumer may rely on:**

1. `smelt()` makes no network calls of its own, ever, in any version. If that changes,
   the package name changes. (A `measure` or `RerankStage` you supply is your code
   running in your process; smelt's guard covers smelt's modules, not yours.)
2. `smelt()` does not mutate its input and is deterministic for a given input, options
   and version.
3. The tool name is `smelt_retrieve` and will not be renamed.
4. Every `AppliedElision` has a non-empty `reason.rule` and `reason.explanation`.
5. `reconstruct(result)` returns the original text byte for byte, as long as the store
   still holds the bytes.
6. Every thrown error is an `instanceof SmeltError`. That covers the whole exported
   surface, `buildRepoMap()` included: a filesystem failure under the repo map arrives
   as `RepoMapIoError` naming the path, never as a raw Node `ENOENT`, and a grammar
   that resolves but will not load — unreadable, truncated, half-extracted — arrives as
   `GrammarUnavailableError` naming the `.wasm`, never as a raw `EACCES` or a V8
   `CompileError`, because a promise with one undocumented exception is no promise at
   all.
7. **The marker format is stable from 0.1 and treated as 1.0.** `<<smelt/v1: … >>` will
   not change shape. A future format arrives as `smelt/v2`, identifiable in band, never
   as a quiet substitution — see Decision 3, and the guard that enforces it.
8. Budgets are UTF-8 bytes, permanently. A `Measure` you supply adds a labelled second
   number to the result; it never changes what the budget means.

**Two promises, not one.** The **wire surface a model sees** — the marker format and the
`smelt_retrieve` tool contract — is stable now. The **TypeScript API** is `0.x` and may
move: expect renames and signature changes in the type surface between minors.

**What is explicitly _not_ stable pre-1.0:** the TypeScript API, the rule ids, the
lexical planner's tuning constants, and the exact set of elisions for a given input.
A consumer that snapshot-tests smelt's output will break on a planner improvement —
snapshot the _properties_ (round-trips, under budget, focus preserved) instead. Note what
is **no longer** on this list: the marker string. It moved to the guarantees, because
consumers put it in prompts.

**What smelt will never do to a consumer:** intercept its traffic, read its config, write
outside a store it was handed, or require a key.

---

## Explicitly out of scope

**A _default_ reranker.** Still out, and permanently. A default reranker breaks Law 1 for
every consumer at once, including the ones who never read the changelog — there is no way
to opt out of a default you did not know existed. There is no `SMELT_RERANK_API_KEY` and
no environment variable smelt reads on its own: an env-var switch turns a zero-network
library into a library that is zero-network unless configured, which is not the same
claim, and it is a switch nobody writes down.

**The reranker as an explicit config opt-in** is _in_, and ADR-0004 records the reopening.
The difference from the ruling above is the whole of it: a consumer writes a `rerank`
block into a `smelt.config.json` they own, installs the adapter package themselves, and
names the environment variable their own key lives in. With no `rerank` key — every
default install — nothing is loaded, nothing is imported and nothing is called. `smelt
doctor` prints the opt-in and whether that variable is set (presence only, never the
value), and every run that reranks says so on its own report line, in the `--json`
envelope and in the `smelt_file` report block. The stage may only **spare** regions the
planner had already decided to cut, and only as far as the caller's own `budgetBytes`
reaches: the slot walks the stage's ranking best-first and stops at the first region that
would not fit, so a bad answer costs at most the bytes the budget already allowed. `topK`
is the cap the caller wrote and smelt still invents none; the budget is the ceiling the
caller also wrote, and a stage's opinion does not outrank it. The gap that leaves — a
`topK` of 8 that yielded 3 — is reported rather than left to be guessed at: the
attribution carries what the stage asked for, what the spares put back in bytes, and
which of the three walls the walk hit. Every way a stage can fail, including the throw a
hosted reranker performs on a timeout or a 401, arrives as a `RerankStageError`: a
refusal, rendered as one, rather than a plain `Error` the CLI would call an internal bug
and the MCP handler would crash past.

**An example reranker in the repository.** Still out, and Decision 5 is unchanged — but
`packages/rerank-voyage` is not that. An `examples/` file importing an HTTP client either
breaks the zero-network guard or gets excluded from it, and **excluding a file from an
honesty guard to accommodate an example is how a guard erodes.** A published package with
its own manifest, its own README, its own tests and a `peerDependency` on the core is
_not_ excluded from anything: it is outside the walk because it is outside the package,
and the core's ruling names it forbidden by name so it can never quietly come inside. The
vendor-dating objection stands and is answered the same way — the name is in one package
and one config key, so a second adapter is a second package rather than an edit to
smelt's graph.

**The learned distillation stage.** Out for a reason beyond the network: a model-written
summary cannot satisfy Law 2. "The model condensed this" is not a statement of what was
removed, and a rewritten paragraph leaves nothing to store under a hash, so Law 3 goes
too. If this ever ships, it stores the original, explains itself in the same rule-named
terms every other elision uses, and is reversible — or it does not ship.
`DistillStage` exists so that shape is written down, not so it can be filled in quietly.

**Learned localization** (SweRank, LocAgent, Agentless). Genuinely better at finding the
right code than lexical scoring, and genuinely a v2 conversation: it means a model in the
retrieval path, which is both laws again. Named in the README as prior art precisely so
nobody thinks smelt invented structural retrieval.

**Being a proxy.** A proxy can be built _on top of_ this library. The library never
intercepts requests it was not handed, because "we rewrote your agent's traffic" and "we
transformed the string you gave us" have very different failure modes and only one of
them is debuggable.

---

## Design decisions

Each decision below is recorded with its reasoning, and each has a home in the code or
the docs. Where a decision is enforced by a check, the check is named.

### Decision 1 — budgets are UTF-8 bytes, permanently, in the core

Not a caveat. **Bytes are the only unit computable locally for every model**, which is
exactly why they are the core's unit — the same property that makes Law 1 possible.

Three facts settled it, verified against Anthropic's documentation on 2026-09-01:

- **There is no local tokenizer for Claude.** Anthropic ships only the
  `/v1/messages/count_tokens` **endpoint** — no downloadable tokenizer, no BPE
  vocabulary. A token budget inside `smelt()` would require a network call, which is
  Law 1 gone.
- **A token budget silently redefines itself across model generations.** Verbatim from
  Anthropic's docs: _"Claude 4.7 and later models and Claude Mythos Preview use a newer
  tokenizer. The same input text produces approximately 30 percent more tokens than on
  earlier models."_ A byte budget means the same thing in five years. A token budget
  quietly got 30% tighter with nothing erroring anywhere — this project's own failure
  class, arriving as someone else's model release.
- Per-provider tokenizers multiply the dependency cost on every consumer, and a coding
  agent talks to more than one provider.

**In the code:** a `measure` hook on the public API (`Measure` in `src/types.ts`,
`SmelterConfig.measure`). A consumer supplies its own counter — anyone calling a model
already has one — and the result carries `measured: { measure, unit, input, output }`
alongside the byte counts. `id` and `unit` are **required**, because a token count
without the tokenizer named is not a measurement; the 30% shift above is precisely why.

The hook **does not relax Law 1.** smelt imports no transport, and the guard proves that
about smelt's modules; it cannot prove it about a function you hand in. A `count()` that
calls an API makes _your_ process call an API, from a line in _your_ source — the same
arrangement `RerankStage` already describes. `count` is synchronous on purpose: local
tokenizers are synchronous and network clients are not.

### Decision 2 — the CLI is a `bin` on `@smeltjs/core`, with zero new dependencies

`node:util.parseArgs`, stable in Node 20, which `engines` already requires. The case for
a second package was dependency-tree size, and it dissolves when the CLI adds nothing.
One package, one version, one install.

### Decision 3 — two promises, not one, and this constrains everything

- **The wire surface a model sees** — the marker format and the `smelt_retrieve` tool
  contract — is **stable from 0.1 and treated as 1.0.**
- **The TypeScript API** is `0.x` and may move.

Why, spelled out in `CONTRIBUTING.md` § "Two promises, not one" so a contributor does
not "clean up" the marker format: **the marker goes into prompts.** Changing it changes
model behaviour downstream and manifests as _worse output with no error anywhere_. That
is not a normal API break; it is this project's signature failure mode shipped as a
version bump.

**In the code:** the marker carries its own version in band — `<<smelt/v1: … >>` — so a
future format is additive and identifiable rather than a silent substitution.
`MARKER_FORMAT_VERSION` lives in `src/apply.ts`, and
`test/guards/marker-format.test.ts` pins the exact rendering per version: the format
cannot move without the version moving, and an unknown version fails rather than
passing, so a new format is a new row and never an edit. Two mutations
(`marker-format-silent-change`, `marker-version-not-frozen`) prove both halves go red.

### Decision 4 — measure the expansion rate; never threshold it

No default threshold. It would be a policy claim smelt has no basis for, the right rate
depends on how aggressive a budget the consumer chose, and a library printing warnings
into someone else's process is bad manners.

**In the code:** `RetrieveStats.allElisionsRetrieved` — the one non-arbitrary case,
exposed as a computed fact rather than a preference. When every distinct blob smelt hid
has been asked for again, the elision achieved nothing and cost a round trip. That is
arithmetic, not an opinion, and what to do about it is the caller's call. Guarded in
`test/guards/expansion-counter.test.ts`; mutation `degenerate-outcome-never-fires` wires
the flag to a constant and the guard goes red.

### Decision 5 — no example reranker in the repo, and no adapter inside the core

A README snippet and the stage interface, and **nothing under `examples/`**. The
zero-network guard requires every discovered `.ts` file to be reachable from a manifest
entrypoint or explicitly justified. A file importing an HTTP client either breaks that
guard or gets excluded from it — and **excluding a file from an honesty guard to
accommodate an example is how a guard erodes.**

ADR-0004 did not weaken this; it took the other route out. The Voyage adapter is a
**separate published package** (`@smeltjs/rerank-voyage`), so no `.ts` file inside
`packages/core/src` imports a transport, no file is excluded from any walk, and the core's
`classify()` names the adapter package **forbidden** rather than unvetted. The
vendor-dating objection is answered by the same shape: the vendor's name appears in one
package name and one config `kind`, and a second vendor is a second package rather than a
second import.

### Decision 6 — the grammars are bundled, and `THIRD-PARTY.md` is generated

The WASM grammars **ship inside the npm tarball** — that is what makes "zero native
compilation, works offline" true. Before this, `tree-sitter-wasms` was an _optional peer
dependency_, so a consumer installing `@smeltjs/core` got no parsers at all and found
out from a `GrammarUnavailableError` on someone else's machine. `pnpm build` copies them
into `packages/core/grammars/` and `files` packs them.

Bundling is redistribution, so attribution is required rather than polite.
`scripts/generate-third-party.mjs` produces `THIRD-PARTY.md` from installed package
metadata, the bundled files themselves, and `grammar-provenance.json` — which holds only
the facts with no machine-readable source here. It is **never hand-written**, because a
hand-written notices file is a promise that decays: a grammar gets added, the file does
not, and nothing fails. `tree-sitter-wasms` is Unlicense (the packaging); each grammar
inside carries its own licence, and all fifteen are MIT, verified against the npm
registry and each repository's `LICENSE` on the date `grammar-provenance.json`
records (2026-09-02). Even the MIT body is quoted from an installed
`LICENSE` rather than typed into the generator.

`test/guards/third-party.test.ts` reruns the real generator and fails if the committed
copy differs, so staleness is loud rather than silent. Downstream reason to get this
right: an app that bundles smelt takes its licence-screen text from here.

### Decision 7 — publishing is a maintainer action

Publishing `@smeltjs/*` is deliberate and manual — never a side effect of a
contribution, and never an agent's action. `CONTRIBUTING.md` carries the publish
checklist, and the ordering rule in it matters: **npm unpublish is restricted after 72
hours**, after which only deprecate remains, so a mistaken publish is effectively
permanent. Publish only what has been run against a real file, never to reserve a
version number.

### Decision 8 — benchmark tiers

`count_tokens` is **free** — _"Token counting is free to use but subject to requests per
minute rate limits"_, 5,000 RPM at the Start tier, with limits independent of message
creation — which is what makes a four-tier split affordable:

| Tier | What it reports                                                  | Cost | Key needed | Who can reproduce it     |
| ---- | ---------------------------------------------------------------- | ---- | ---------- | ------------------------ |
| 1    | Bytes and elision counts                                         | none | none       | any contributor, offline |
| 2    | Token counts, via `count_tokens`                                 | free | any key    | anyone with a key        |
| 3    | Expansion rate — real model calls                                | paid | any key    | anyone, from the log     |
| 4    | Answer-quality A/B — raw vs smelted, judged against the raw blob | paid | any key    | anyone, from the log     |

Tier 1 is deterministic and needs no key, so a stranger can reproduce the table's
structural half exactly. Tiers 3 and 4 are the paid parts: run each once and **commit
the log as an artifact** (the retrieval log, the A/B log), so every reading is
verifiable from a committed file rather than from trust. The harness implements all
four tiers; tiers 2–4 have not yet been run — see "The measurement harness".

Tier 4's verdict deserves its own sentence, because it is the one reading in the file
that is a model's opinion: the judge is the instrument, its reasons live in the
committed log, a verdict that does not parse is reported UNJUDGED rather than guessed,
and a run cut off at the round cap claims no verdict at all. An instrument reading,
labelled as one, is Law 4; a number dressed as a measurement is not.

**The trap, written down:** tokenizers differ by model, so every table row names its
model, and re-running on a newer model is a **new row, not an edit**. See Decision 1 —
the 30% shift between Claude tokenizer generations would otherwise silently rewrite
history.

---

## `smelt init` and `smelt.config.json`

The CLI has a setup wizard and a defaults file. Both are **CLI-only surfaces**: the
programmatic API never reads a config file — `createSmelter()` takes explicit
arguments, and a library whose behaviour depends on where it was invoked from would be
an invisible input.

**`smelt init`** walks through five choices — default byte budget, store (memory or a
persistent directory plus path), default planner strategy, a measure-hook stub, and a
reranker (`none`, a `module` of your own, or `voyage`) — one question at a time. Every step accepts `back`. A re-run over an
existing config shows the current values and edits one choice at a time. **Nothing is
written until a final confirm** that lists exactly what will be written, and an
existing file is **never overwritten without an explicit per-file yes** — enforced by
`test/guards/init-wizard.test.ts`, with mutation `init-overwrite-without-consent`
proving the guard goes red. The wizard is a pure function over an input/output pair
(`runInit` in `src/cli/init.ts`), driven in-process by `test/init.test.ts`;
`bin.ts` only wires the real stdio.

**`smelt.config.json`** is versioned (`{"smeltConfig": 1, …}`) and found by walking up
from the working directory, like `package.json`. It supplies **defaults only** —
`defaultBudgetBytes`, `strategy`, `store` — and an explicit flag always wins. A
malformed config is a usage error even when every flag was given: a config silently
skipped would be a setting the user believed was in force. `test/cli-config.test.ts`
pins the precedence and the strict parse.

Its one non-default key is `rerank` (ADR-0004): the explicit opt-in to a relevance
stage, absent from every default config, and refused loudly when it names a module that
is not there, a `topK` it needs, an environment variable that is unset, or an adapter
package that is not installed — never a quiet fallback to an unranked run. It is
**additive and does not bump `smeltConfig`**: the schema version exists so a _mismatch_
is visible rather than half-understood, and an older build reading this key refuses it
loudly as unknown, which is exactly the behaviour that makes the strict parse worth
having. Bumping would break every config in the field to announce a key nobody set.

**The generated stubs** (`smelt.measure.ts`, `smelt.rerank.ts`) implement `Measure`
and `RerankStage` against the real exported types — `test/init-stub-typecheck.test.ts`
compiles the wizard's actual output with the real `tsc`. The reranker stub sketches
the outbound HTTP call as a marked TODO **in the consumer's file**, reading the
consumer's own env var, and the wizard now also writes the `rerank` config block that
loads it — a stub nothing points at was a file the user watched themselves ask for and
never got used. smelt's own import graph gains no HTTP client, and the
templates are string literals the zero-network guard's string-stripper ignores. This
does not reopen Decision 5: nothing under `examples/`, nothing in smelt's graph — the
sketch only ever exists in a file the consumer asked the wizard to write, outside this
repository.
