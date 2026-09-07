# Changelog

Every release, what changed in it, and why. Two promises govern what may appear here:
the **wire surface** a model sees — the `<<smelt/v1: … >>` marker and the
`smelt_retrieve` tool contract — is stable from 0.1 and treated as 1.0, so a change to
it would arrive as a new marker version, never as a quiet edit. The **TypeScript API**
is `0.x` and may move; anything that moved is listed under Changed with its reason.

No number appears here that was not measured. Byte figures come from the committed
tier-1 rows in `packages/core/bench/RESULTS.md`, each carrying its date and corpus
commit; the mutation tally is whatever `guards.json` says, and that file is written by
the runner rather than by hand.

## 0.6.0 — 2026-09-07

`@smeltjs/core@0.6.0` · `@smeltjs/mcp@0.5.0`

The wire surface a model sees — the `<<smelt/v1: …>>` marker and the `smelt_retrieve`
contract — is unchanged. Everything below is additive beside it, and every one of the
five changes came out of the 2026-09-07 architecture review of the measured tiers 1–4.

### Added

- **`smelt_retrieve_batch`** (`retrieveMany`, `createRetrieveBatchTool`) — N hashes,
  one round trip, one block per hash, a refusal riding inside its block rather than
  failing the batch. Tier 4 measured the cost lever: every one-hash call is a new
  request that re-bills the transcript, and on five of nine cases the smelted arm's
  summed input exceeded the raw arm's. Each hit inside a batch journals exactly as a
  single call would, so the expansion rate keeps its meaning.
- **The elision outline** — `PlannedElision.names` / `AppliedElision.names`: the names
  of the declarations a structural cut collapsed, read off the tree, rendered beneath
  the elision's report row (`↳ names: parseConfig, normalisePath`), in the `--json`
  envelope and in `smelt_file`'s report block. Out of band: the marker and its priced
  cost do not move by one byte (guarded, with a mutation).
- **Producer-aware focus** — `src/hooks/focus-terms.ts`, one zero-import derivation of
  focus terms from the command that produced a blob. The hooks guard's rewrite wrap now
  carries the literal `--focus <term>` it already parsed, for searches that print
  context (`-C`, `-A`, `-B`); a plain grep stays unfocused because every line already
  matches. `smelt --producer '<cmd>'` and `smelt_file`'s `producer` resolve through the
  same function; the caller's own focus always wins; the report attributes whose focus
  cut (`focus  handleRequest   (from --producer)`).
- **The elision ledger** — the rule an elision was cut by is persisted at put time
  (`put(content, reason)`; a `put "<hash>" "<rule>"` journal line the counter fold
  skips, so a directory written by 0.6 reads as the same counters under 0.5).
  `store.ledger()` and the `readLedger` op fold it into `{ rule, stored, retrieved }`
  rows; `smelt stats` prints `rule.<id>.stored` / `rule.<id>.retrieved`; `smelt_stats`
  returns the ledger as a second block; `createSmelter` hands it to planners as opt-in
  `PlanInput.ruleHistory`. Data a caller's planner may weigh — never a threshold smelt
  applies (Decision 4).
- **Content-kind planning** — `probeKind()` states two facts about the bytes (a JSON
  parse succeeded; a unified-diff header shape is present) and never sniffs a language.
  `json/v1` cuts by members and elements; `diff/v1` by files, hunks, and line windows
  inside a matched hunk. Each refuses any other content with `ContentKindError`, and
  `auto` now routes kind first, then language. `DEFAULT_STRATEGY` stays `lexical`.
  Built because two new probe corpus cases (a real git diff, a real tier-4 JSON log)
  measured lexical over budget; the honest result is a trade — at corpus
  `19b11585126f`, `diff/v1` leaves 2706 B where lexical leaves 1516, `json/v1` 3280 B
  where lexical leaves 2996 — in exchange for every file and hunk header, and the JSON
  skeleton with an outline of every hidden key.
- **The bench ships the report block** — tiers 3 and 4 now show the model the smelted
  text _and_ its report, the two blocks `smelt_file` returns; log formats
  `smelt-bench-tier3-log/v3` and `smelt-bench-tier4-log/v2` mark the change. Earlier
  logs measured an ergonomics the product never had.

### Changed

- `smelt stats --json` is `smelt-stats-cli/v2`: `stats` verbatim as before, plus
  `ledger`.
- `ElisionStore.put` accepts an optional `reason`; `ElisionStore.ledger?()` is an
  optional method — a custom store need not implement either.
- The `--strategy` set is `lexical, structural, auto, json, diff` on every face (flag,
  config, wizard, `smelt_file` schema, bench).
- `docs/ARCHITECTURE.md`'s file-by-file table and guards table were pasted four and
  two times with drift; one copy each now.

## 0.5.0 — 2026-09-05

`@smeltjs/core@0.5.0` · `@smeltjs/mcp@0.4.0` (lockstep — the mcp package itself is
unchanged; the pair releases together because the publish pipeline's one tag carries
both)

The wire surface a model sees — the `<<smelt/v1: …>>` marker and the `smelt_retrieve`
contract — is unchanged.

### Added

- **`smelt setup`** — the whole recipe in one command: config, the hooks preset, the
  MCP registration, and a real smelt → retrieve round trip as the check that makes
  "set up" a claim with evidence. Interactive from a terminal (Enter accepts every
  default); for an agent, everything is a flag — `setup --yes --harness <id>... [--no-mcp]
[--json]` — and the refusal names the flags. Idempotent; repairs only smelt's own
  entries in files it finds, never a foreign byte.
- **`smelt doctor`** — the read-only half of the install seam: which release wrote the
  instruction blocks (a version stamp inside each block), whether the config parses and
  its store directory exists, whether the MCP registration is intact, and which pieces
  are orphans. Exit 0 when current; the report ends with the exact repair command.
  Doctor never writes.
- **The SetupRecipe** — the setup facts (install commands, the 4000-byte recommended
  budget, the store default, the MCP commands, the brew tap, the skill install) owned
  as data in one module; the site's facts and the README are derived or guard-pinned,
  never retyped.
- **MCP registration as an install-step kind** — `smelt setup` writes the registration
  byte-faithfully (claude-code's `.mcp.json`, opencode's `opencode.json`), beside any
  servers you already registered; `smelt hooks remove` lifts it back out.
- **The SkillPack** — `skills/smelt/SKILL.md`, generated from the recipe, installable
  with `npx skills add smeltjs/smelt`; the marker-block channel is unchanged.
- **The lava renderer** — the wizards' presentation as a zero-dependency ANSI adapter
  behind the output seam (ADR-0001: Node-native); `--yes`, `--json`, pipes and
  `NO_COLOR` emit exactly the bytes they always have.
- **Tag-and-watch publishing** — a tag verifies, packs, publishes the exact bytes it
  hashed, and renders the Homebrew formula from them (`brew install smeltjs/tap/smelt`).

### Changed

- `--harness` is repeatable for `setup`; `hooks` still takes one per run.
- `smelt hooks install` stamps the release into the instruction block, so doctor can
  read it back.
- The README quickstart is two commands (install + `smelt setup`); recovery after any
  upgrade is two (`smelt doctor`, then `smelt setup` only if it names something).

## 0.4.0 — 2026-09-03

`@smeltjs/core@0.4.0` · `@smeltjs/mcp@0.3.0`

### Added

- **`smelt agents lint`** — audits the instruction files an agent loads on every
  request: `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, and the nested files that merge with
  them. Eight advisory rules, each a stable id with an explanation citing its source:
  `dead-path`, `dead-link`, `forcing-language`, `structure-dump`,
  `generated-boilerplate`, `language-rule`, `mirror-drift`, `restated-at-level`.
  `--strict` turns any finding into exit 1 for CI; `--json` emits a versioned envelope.
  It reports bytes and a labelled imperative heuristic against a budget **you** set in
  `smelt.config.json` — never a default, on the same reasoning that keeps the expansion
  rate un-thresholded.
- **`smelt agents split`** — the mechanical half of a refactor: it proposes a
  root/`docs` partition, rewrites the links, and writes nothing without the
  per-file confirmation `smelt init` uses. Deciding which sections are essential is
  judgment, so it belongs to your agent, not to smelt; the command hands you the prompt
  rather than guessing. There is deliberately **no `agents init`** — auto-generating
  these files is the practice the guidance this rule set follows warns against.
- **A `SessionStart` hook** (opt-in) that lints the repo's instruction files as a
  session opens.
- **smelt's own `AGENTS.md`**, hand-written to the minimum — one sentence, the package
  manager, the one non-standard gate, and two pointers — with `CLAUDE.md` as a symlink
  to it. It passes the lint it ships with.

### Fixed

- **The site can no longer contradict the packages.** It had been advertising
  `core v0.2.0 · mcp v0.1.0` through a 0.3.0 release, because `site/` held no dependency
  on the packages and neither the gate nor the deploy paths could make it red. Versions,
  the harness tier table, the structural language list and the guard tally are now
  generated from the registries at build time, and a guard forbids any site component
  from stating a tier of its own.
- **The mutation tally left prose for `guards.json`.** The number had lived in three
  documents plus a fourth copy on the site worded past the drift check; the runner now
  writes the file and refuses to run against a stale one.
- **Harness tiers are derived everywhere they are rendered.** The wizard's two sentences
  had named a tier to describe a capability they only correlated with; they now name the
  capability they test.

### Changed

- `SmeltOptions` removed — a published type nothing produced or consumed; the live type
  is `SmeltCallOptions`.
- The byte-faithful JSON editor moved out of the hooks installer to `src/text/`, where
  it is tested on strings rather than only through a harness install.
- New public surface for the site's generator to read: `harnessesByTier`, `harnessNames`,
  `HARNESSES`, `HARNESS_IDS`, `harnessLabel`, `HARNESS_TIERS`, `TIER_HONESTY`.

## 0.3.0 — 2026-09-03

`@smeltjs/core@0.3.0`

### Added

- **`strategy: 'auto'`** — structural where the language is supported, lexical
  otherwise, with the result labelling which planner ran. An explicit
  `strategy: 'structural'` still refuses an unsupported language: auto is a labelled
  choice, never a silent downgrade.
- **The structural planner reads its budget.** A pressure rung collapses runs whose real
  rendered marker costs less than the cut, so the planner no longer returns over budget
  having elided nothing while a profitable cut existed.
- `smelt map` ignores build output (`dist`, `build`, `out`, `coverage`) by default; a
  built TypeScript repository no longer triplicates every symbol.

### Fixed

- **The published declarations no longer name `NodeJS`, `Buffer` or `URL`**, so a
  project compiling with `skipLibCheck: false` and no `@types/node` can build against
  smelt. Proven by a guard that packs the real tarball and typechecks it in a scratch
  consumer.
- Sourcemaps inline their sources instead of pointing at `src/`, which the tarball
  excludes.
- `smelt_retrieve`'s schema carries `additionalProperties: false`, so it registers under
  OpenAI strict mode.
- `smelt init` and `smelt hooks install` exit when they finish — a stream wrapper had
  been holding stdin open on a real terminal.
- Grammar loads, repo-map filesystem calls and cache reads all fail as `SmeltError`,
  keeping the documented guarantee true.
- `--reconstruct` refuses the flags it had silently ignored; `has()` and `retrieve()`
  agree about a corrupt blob.

### Changed

- `./hooks/guard-core` no longer self-invokes as a script. Nothing smelt installs used
  that path — the guard is reached through the shims.

## 0.2.1 — 2026-09-02

`@smeltjs/mcp@0.1.1`

### Fixed

- **`npx @smeltjs/mcp` was broken for everyone.** `npm publish` shipped
  `"@smeltjs/core": "workspace:^"` verbatim, so installing it failed with
  `EUNSUPPORTEDPROTOCOL`. Republished with the range resolved, and a `prepublishOnly`
  guard now refuses a publish that would repeat it.

## 0.2.0 — 2026-09-02

`@smeltjs/core@0.2.0` · `@smeltjs/mcp@0.1.0`

### Added

- **`smelt hooks install`** — a guard preset for agent harnesses. A fail-open size guard
  (8 KB default, stat-only fast path) denies an oversized raw read with a reason naming
  the exact replacement command; rewrite mode is opt-in and always announced. Verified
  shims for Claude Code and Codex; experimental shims for Gemini, Grok, Hermes, Cursor
  and Cline, plus an opencode plugin; advisory documentation for KiloCode and Aider.
- **`@smeltjs/mcp`** — a stdio MCP server exposing `smelt_file`, `smelt_retrieve`,
  `repo_map` and `smelt_stats`, sharing the CLI's store through the same config
  discovery.
- Ten more structural languages, bringing the total to fifteen.

## 0.1.0 — 2026-09-02

`@smeltjs/core@0.1.0` — the first published version.

### Added

- The plan/apply/store/retrieve pipeline, with `reconstruct(smelt(x)) === x` asserted
  byte for byte.
- The structural planner (tree-sitter) and the lexical planner.
- `DirectoryElisionStore`: content-addressed, crash-safe, bytes re-verified against
  their hash on read, counters surviving a restart, and no eviction.
- Cache-prefix hygiene — detect and warn, never rewrite.
- The repo-map planner, modelled on Aider's and credited as such.
- `smelt init`, `smelt map`, `smelt retrieve`, `smelt stats`, and the `smelt` CLI.
- The measurement harness, its committed corpus, and the append-only results table.
