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

## Unreleased

### Added

- **An opt-in rerank adapter is looked for beside the config that asks for it.**
  `rerank.kind: "voyage"` resolved `@smeltjs/rerank-voyage` from `@smeltjs/core`'s own
  location and, when it was not there, said `npm install @smeltjs/rerank-voyage`. With a
  `~/smelt.config.json` (`--scope user`) and a `smelt` from Homebrew or `npm -g`, that
  searched a keg nobody installs into and then named a command that installs into the
  shell's cwd — a third directory, which smelt never looks in. `src/rerank/resolve.ts` is
  the new **AdapterResolver**: the directory holding `smelt.config.json` first (so
  `~/node_modules` beside a user-scope config and a project's own `node_modules` are one
  rule), smelt's own install second, and otherwise **one** refusal naming both places and
  `npm install --prefix <configDir> <name>` — the command that puts the package in the
  directory searched first. Both kinds go through it: `voyage`, and `module` for a bare
  specifier that names no file beside the config (a relative or absolute path keeps the
  path rule the schema promises). It resolves and never imports — what comes back is a
  `file:` URL, so the specifier at every `import()` is still a value and Law 1's walk still
  finds no edge to an adapter; the zero-network guard's literal-specifier mutation is
  re-anchored to the new call shape and still goes red, and `rerank/resolve.ts` joined that
  guard's `mustVisit`. The question is asked under Node's `require` conditions, so the
  adapter contract is now written down: an adapter's `exports` map must answer under
  `default` or `require`, and one that answers only `import` is refused as **installed and
  unreachable** — a distinct refusal with no install command, because installing it again
  would change nothing. `test/guards/adapter-resolver.test.ts` holds the order, the
  fallback, the one-message refusal, the `file:` URL and that distinction, with six
  mutations. The install command quotes its directory, so it survives a path with a space
  in it.
- **`smelt doctor` says where the adapter is, and reads the `module` kind by the loader's
  rule.** The rerank line now carries `adapter from config dir`,
  `adapter from smelt's own install`, `adapter not installed:` with the install command for
  your config's directory, or `adapter installed but not loadable` — asked through the same
  resolver a run uses, and resolving only: nothing is imported to answer it.
  `{"kind":"module","path":"my-reranker"}` is a config every run loads and doctor reported
  as a missing file, orphan and exit 3, because it asked `existsSync` where the loader asks
  for a file **or** a package; it now asks the loader's question, absolute paths included.
  `smelt.doctor.v1` gains `rerank.adapterFrom`, `rerank.adapterProblem` and
  `rerank.install`, all optional; no existing field changed spelling or meaning, and the
  key's _value_ still never appears. A configured opt-in whose adapter is in neither place
  is an orphan with that command as its repair — the same treatment an unset key already
  had, for the same reason: every run that would rerank refuses instead. An installed but
  unreachable one is an orphan with no repair command, because there is no command that
  would repair it.
- **`smelt init`'s voyage answer prints a command that can work**:
  `npm install --prefix "<dir>" @smeltjs/rerank-voyage` for the directory it is writing the
  config into, rather than a bare `npm install` that lands wherever the reader's shell
  happens to be.

### Changed

- **The rerank slot now spares only as far as the budget reaches, and `topK` is a cap
  rather than a quantity.** The slot spared every region a stage returned and never saw
  `budgetBytes`, so a `topK` written in a config file decided how large the output got —
  a run that fitted before the reranker could stop fitting after it. `applyRerank` now
  takes the run's budget and its `MarkerPricing` across the seam, walks the stage's
  selection best score first, and stops at the first region that would push the predicted
  output past the ceiling. The prediction is `plan/budget.ts`'s, the same arithmetic the
  lexical planner picks a ladder rung with and the structural planner runs its own budget
  rung on, so the slot and the planners cannot disagree about what a marker costs. If the
  best-ranked region alone breaks the budget, nothing is spared at all: a plan that fits
  beats a plan that does not, and a stage cannot cut, so the only lever left is not
  sparing. The doctrine in one line, and it is written at the seam: a K smelt invents is
  refused; a budget the user typed is honoured. `test/guards/rerank-budget.test.ts` holds
  both halves, with mutations that remove the budget check and that fabricate the stop
  reason. A run whose plan is over budget before the stage is asked does not reach the
  stage at all — it could spare nothing whatever came back, and asking would send the
  caller's source to a third party for an answer refused before it arrived. That is a
  skip, not a stop: `skipped: 'plan-over-budget'` beside the existing two reasons, with
  the counts only a real run can take left absent.
- **`RerankedCandidate.score` is load-bearing as an order.** The slot sorts a stage's
  selection score-descending, breaking ties by the order the candidates were sent, so
  which regions survive a tight budget no longer depends on how an adapter happened to
  serialise its response. The interface documents it; a stage that returns its selection
  unsorted now has a defined outcome rather than an incidental one. A score that is not a
  finite number is refused with a `RerankStageError`: `NaN` compares false against
  everything, so it would not disorder the ranking loudly but silently, and differently
  per engine.
- **The rerank attribution says what was asked for and where the sparing stopped.**
  `RerankAttribution` gains three optional fields, present exactly when the stage ran:
  `returned` (how many regions it asked to spare), `sparedBytes` (what those put back —
  the regions restored, less the markers that no longer land, priced through the same
  seam the plan was made with) and `stopped` — `budget`, `cap` or `exhausted`. A `topK`
  of 8 that reports 3 kept now carries the reason beside it instead of leaving the reader
  to guess whether their ranker or their budget made the decision. The stderr report line
  gains a `B back` clause and, on a budget stop, a clause naming the budget as the reason
  and how many regions the stage had offered. The `--json` envelope carries `result`
  verbatim, so `result.rerank` gains the three fields additively — nothing renamed,
  nothing dropped.

### Docs

- **`llms.txt` and `llms-full.txt`, for the agent that arrives before the install.** The
  llmstxt.org index now sits at the repository root and is served by the site: the summary,
  the four laws as its notes, the three commands a newcomer needs, the five MCP tool names,
  and link lists of every document — with `llms-full.txt` beside it inlining each of those
  documents for a reader that would rather spend the tokens than the round trips. Neither
  is hand-written. `scripts/generate-llms-txt.mjs` renders both from one document list and
  the built packages' own facts (the ADRs discovered rather than listed). The index is
  committed twice — the repository root and `site/public/`, byte-identically — so an agent
  reading the repo needs no fetch; the companion is committed once, under `site/public/`,
  because a second copy of the whole documentation set would be a large regenerated blob in
  the diff of every docs change, and the index already links its served URL.
  `test/guards/llms-txt.test.ts` regenerates every committed copy, compares the index's two
  directly, refuses a companion at the repository root, and resolves every link in the index
  back to a file that exists — because regenerating an index reproduces a dead link exactly.
  `pnpm generate:llms-txt` writes them; a hand edit is a red `pnpm verify`. Law 4 holds in
  the index as it does everywhere else: it states no measured figure and links
  `packages/core/bench/RESULTS.md` instead.
- **The SkillPack now teaches the 0.7.0 surface.** Four sections joined it, still rendered
  from the package rather than retyped: setting up (`smelt setup --yes` with
  `--scope user`, the repeatable `--harness` over the ids the registry carries, and the four
  toggles), checking the install (doctor's `wired (verified)` / `wired but inert` /
  `wired but missing`, and the refused exit meaning "re-run setup"), keeping the store
  small (`smelt store prune --older-than 30d --dry-run`, then the same line without it),
  and reranking (the config block, `module` or `voyage`, the environment variable your
  config names, and never a default).
- **A "For agents" section near the top of the README**, naming the two instruction
  channels and the one-line version of each 0.7.0 action; `AGENTS.md` points at `llms.txt`;
  the site footer links it.

## 0.7.0 — 2026-09-09

`@smeltjs/core@0.7.0` · `@smeltjs/mcp@0.6.0` · `@smeltjs/rerank-voyage@0.1.0` (first
publish — an opt-in package you install yourself; nothing loads it unless your
`smelt.config.json` says so)

The wire surface a model sees — the `<<smelt/v1: …>>` marker and the `smelt_retrieve`
contract — is unchanged. Everything below is the nine-PR install, rerank, store-prune and
CLI batch stacked on 0.6.0.

### Fixed

**For Homebrew users upgrading from 0.6.0 or earlier: re-run `smelt setup`.** Hooks
written by those releases point at a versioned Cellar path `brew upgrade` deletes, and
the guard was inert through the `opt` symlink besides — a re-run rewrites both.

- **The guard was silently inert on any install reached through a symlink.** Node
  realpaths the ESM main entry, so a shim run through Homebrew's `opt` alias (or a
  `pnpm link`, or any other link) compared two spellings of the same file and decided it
  was not the main module: it exited 0 with empty stdout, which every harness schema
  reads as _allow_, and every oversized read passed while the transcript looked exactly
  as it does when the guard is working. `isMainModule` now compares by realpath.
- **Hook commands written on a Homebrew install died at the next `brew upgrade`.** Every
  script path was derived from `import.meta.url`, which under Homebrew names the
  versioned Cellar keg that an upgrade deletes — so every installed hook failed with
  "Cannot find module" until setup was re-run, and nothing said so. Commands are now
  written through the `<prefix>/opt/<name>` alias Homebrew re-points, for any prefix
  (`/opt/homebrew`, `/usr/local`, `/home/linuxbrew/.linuxbrew`).
- **opencode's plugin directory is `plugins/`, not `plugin/`.** opencode documents
  `.opencode/plugins/` for a project and `~/.config/opencode/plugins/` for the machine
  (opencode.ai/docs/plugins § "From local files", and the same two names in its load
  order and its v2 config spec); smelt wrote the singular `.opencode/plugin/`, so the
  guard plugin sat in a directory opencode does not load from. The documented spelling
  is what is written now. An install already at the old name is still **read** — doctor
  reports it as the install it is, a re-run reads your toggles back off it — and
  `smelt hooks remove` takes it out. An install writes only the new name and names the
  old file; once both are on disk, `smelt doctor` calls the old one an orphan — it says
  where an earlier release wrote it and that opencode does not load it — and names the
  command that removes it, which costs `current`, because a file smelt wrote and no
  longer maintains is exactly that. One artefact, two names: nothing is orphaned by
  accident and nothing is silently duplicated.
- **`smelt setup` run from your home directory installed into files no harness reads.**
  Every path the installer wrote was a project-relative path joined to the working
  directory, so from `$HOME` it produced `~/CLAUDE.md`, `~/.mcp.json`, `~/AGENTS.md`,
  `~/GEMINI.md`, `~/opencode.json` and `~/.opencode/plugin/…` — inert, every one of them.
  `smelt doctor` read from those same wrong places, so the writer and the reader agreed
  the install was healthy while nothing was wired. Where an install goes is now a
  per-harness fact on the profile and one resolver every writer and every reader goes
  through; a project install is unchanged, byte for byte.
- The marker block written at machine scope now says **"This machine uses smelt"**. A
  block in `~/.claude/CLAUDE.md` is loaded in every project on the machine, so "This
  project" was a claim about a project the reader is not necessarily in.
- **`smelt setup --json` reported `smelt.config.json` twice on a fresh directory** —
  once `written` by setup and again `updated: repaired` by the hooks plan re-rendering
  the same file. The config is written once per run, and `config.action` and the files
  list now agree.
- Law 1's guards now rule on the opt-in `@smeltjs/rerank-voyage` adapter by name:
  `OPT_IN_RERANK_PACKAGES` in `net/policy.ts` names it as data, and both packages'
  `classify()` treat an _import_ of it as **forbidden** rather than merely
  unclassified — a static import in either package goes red, and so does respelling
  the loader's dynamic import with a string literal, which changes nothing about the
  running code and everything about whether the adapter is in the graph. The bench
  guard gained the same rule for its non-tier modules.
- A reranker that fails — a timeout, a 401, an unreachable host, a stub nobody has
  filled in — is now reported as the refusal it is (`RerankStageError`, the CLI's
  refused exit code, an `isError` result from `smelt_file`). It used to escape as a
  plain `Error`, which the CLI printed as "unexpected internal error — this is a bug,
  please report it" and the MCP server rethrew past its own envelope: smelt taking the
  blame for somebody else's API being down.
- The rerank attribution no longer reports `0 candidates` for a run where the planner
  proposed regions but the stage was never asked. `candidates` is the measured size of
  the candidate set, and a new `skipped` field names the missing precondition.

### Added

- `hooks/invocation.ts` — one module answering "how is smelt re-invoked on this
  machine", ranked: a `smelt` on PATH, this package's own binary in the spelling that
  survives an upgrade, and — when neither can be promised — the versioned path plus a
  note saying so. Node builtins only, beside the guard core that reads it.
  `smelt hooks install` and `smelt setup` now check every script path they write — the
  guard shim, the guard core and the CLI binary, each on its own — and say so when one
  is version-bearing (a Homebrew keg with no `opt` alias, a pnpm store entry, an
  nvm/volta per-Node tree): "hook command uses an unstable path (<why>) — re-run setup
  after upgrading". They also say when the `smelt` on PATH is not the install that wrote
  the command. `smelt.setup.v1` gains an optional `notes` array carrying those lines.
- **`smelt setup`, `smelt hooks install`/`remove` and `smelt doctor` take
  `--scope project|user`.** A _machine_ install is the one to reach for when you want
  one `smelt.config.json` and one store behind every project: the config goes to
  `~/smelt.config.json` — which every project below it finds, because discovery walks up
  — the store to `~/.smelt/store`, and each harness file to that harness's **own
  documented user-level location**. The scope defaults to `user` when you run the
  command from your home directory and `project` everywhere else; the wizards say which
  they detected and let you flip it. Both receipts (`smelt.setup.v1`, `smelt.doctor.v1`)
  now carry `scope`.
- A harness that documents **no** user-level home for a file is listed as skipped, with
  the reason, and nothing is written for it — never the project spelling one directory
  up, which is a file nothing reads. Today that is Hermes, KiloCode and Aider entirely,
  plus Grok's hook file and Grok's and Cursor's instruction layer.
- **`smelt doctor` now runs the hooks it can read.** `wired` used to be a fact about
  text — this file carries an entry of ours — which reads exactly the same for a working
  install and for a guard that is silently doing nothing. Doctor now spawns each hook
  command it finds in a harness's JSON hook file, against an oversized file in a
  temporary directory with the guard's threshold pinned beside it, with a payload built
  from that harness's own hook schema, and reports what came back: `wired (verified)`,
  `wired but inert` (it ran and allowed the read — what a shim reached through a symlink
  does), or `wired but missing` (the script is gone — what `brew upgrade` leaves
  behind). A hook that is not firing costs `current`, exits 3, and names `smelt setup
--harness <id>` as the repair. That covers every harness: Cline, Hermes and opencode
  wire the guard through a file smelt owns whole rather than through hook entries, and
  those are verified as files — the command behind Cline's `exec` and Hermes's
  `- command:` is run like any other shim, and opencode's plugin is loaded, its import of
  the built guard core included, to prove it still exports the hook opencode calls.
  Doctor still writes no byte of your project (ADR-0003): the file it oversizes lives in
  a temp directory that is removed again.
- **`smelt hooks install --yes` — the whole install, without a terminal.** The verb had
  one flag and asked everything else, so an agent with no TTY could not run it at all.
  `--yes` applies the install with no question, and `smelt hooks remove --yes` takes it
  back out.
- **Four toggle flags, on both install verbs:** `--guard`, `--stats`, `--map` and
  `--lint`, each `on|off`, accepted by `smelt setup` and `smelt hooks install` alike. A
  toggle you do not name keeps whatever is already installed; where nothing is, the
  defaults are the wizard's — guard on, stats on, map off, lint off. Without `--yes`
  they pre-answer the wizard's questions rather than bypassing it.
- **A reranker you can switch on, in a file you own.** `smelt.config.json` takes a
  `rerank` block — `{"kind":"module","path":"./smelt.rerank.ts"}` for a `RerankStage` of
  your own, or `{"kind":"voyage","model":"rerank-2.5","apiKeyEnv":"VOYAGE_API_KEY","topK":8}`
  for the new `@smeltjs/rerank-voyage` adapter. With no `rerank` key — every default
  config — nothing is loaded, nothing is imported and nothing is called. There is no
  default reranker, no `SMELT_RERANK_API_KEY`, and no environment variable smelt reads
  that your config did not name. See ADR-0004.
- **`@smeltjs/rerank-voyage`**, a new package you install yourself: the Voyage AI
  reranker adapter, and the only package in this repository that reaches the network. It
  batches at Voyage's documented 1,000-document maximum, breaks score ties by original
  order so one input gives one plan, times out at 30s with the reason stated, and
  refuses an answer it cannot read rather than returning an empty ranking.
- **The rerank stage has a slot.** It is handed the regions the planner had already
  decided to remove, plus your focus terms, and its top-ranked answers are **spared**
  from the cut. It can only spare, never cut — the worst a bad answer does is cost
  bytes, and bytes are already reported.
- **The outbound rerank call is visible everywhere the run is.** A new report line
  (`rerank  voyage/rerank-2.5  (23 candidates, 8 kept)`), a `rerank` field inside the
  `--json` envelope's `result`, the same line in `smelt_file`'s report block, and a
  `rerank` line and receipt field in `smelt doctor` — which reports whether your key
  variable is _set_, never its value.
- `smelt_file` honours the same `rerank` opt-in from the same nearest
  `smelt.config.json` the CLI reads.
- A tier-3 bench arm comparing lexical against lexical+rerank on the committed corpus,
  gated on `VOYAGE_API_KEY` and the adapter being installed. It has not been run: no
  `+rerank` row is committed, and `bench/RESULTS.md` says the row is unmeasured.
- **`smelt store prune --older-than <n>d|<n>h|<n>w [--keep-retrieved] [--dry-run]
[--json]`** — the only command that deletes an elision, and the only eviction smelt
  has. Nothing prunes on a timer, on a size cap, or when a store is opened; you name the
  age cut (no default), and every blob last written before it is evicted unless
  `--keep-retrieved` spares the hashes the journal shows were asked for back.
  `--dry-run` prints the same report and frees nothing. `--older-than` refuses an age
  that reaches further back than a date can go, naming the furthest one that works, and
  refuses an unreadable cut-off before it lists a blob. Its own envelope,
  `smelt-store-prune-cli/v1`.
- `EvictedHashError` — a retrieval of a pruned hash names the date it went and the verb
  that took it, never `UnknownHashError`'s "it was never elided". `has()` answers
  `false`. Both front doors render it: the CLI exits 3, and `smelt_retrieve` /
  `smelt_retrieve_batch` return the same `isError` shape an unknown hash gets, with the
  evicted sentence.
- `DirectoryElisionStore.prune()` and `readStoreSize()` on the public surface, with
  `PruneOptions`, `PrunedBlob` and `PruneReport`.
- `smelt doctor` reports the store's size — `store.blobs` and `store.bytes`, two new
  optional fields on the `smelt.doctor.v1` receipt, and the config line renders them.
  Read without opening the store, so doctor still writes nothing.
- **A front door.** `smelt` with no arguments at a terminal prints the wordmark over the
  lava gradient, what smelt is, and the three commands a newcomer needs — `smelt setup`,
  `smelt <file> --budget 4000`, `smelt doctor` — with `smelt --help` for the rest. Those
  three are hand-picked and deliberately not derived: the registry knows ten verbs, and a
  generated list of ten is the help page, which is one keystroke away. Every line of it
  fits inside 80 columns. A pipe is not a person — the front door appears only when
  somebody is at both ends of the process, so `cat log | smelt` reads stdin exactly as it
  always has, and no logo is ever written into somebody's data.
- **`smelt --help` opens with the wordmark**, and its headings — `USAGE`, `OPTIONS`,
  `EXIT CODES` and each verb's section — are bold, with the `smelt` that opens each
  synopsis line and each flag label in ember. The page itself is unchanged: the same
  words in the same order, still derived from the subcommand and flag registries, and
  still pinned byte for byte as the plain rendering, so a help change stays a reviewable
  diff.
- **`--no-color`**, beside `--help` and `--version`: plain bytes for one invocation,
  however pretty the terminal. `NO_COLOR` and `FORCE_COLOR` are honoured too, and stdout
  and stderr are decided separately — `smelt big.log --budget 4000 > small.log` leaves
  the report on your terminal in colour and the payload in the file in bytes. **How
  much** colour is asked of the terminal rather than assumed: `NO_COLOR` (any non-empty
  value) beats everything, then `FORCE_COLOR` read as a _level_ (`0` off, `1` sixteen
  colours, `2` 256, `3` truecolor, any other non-empty value sixteen), then `COLORTERM`,
  then a `TERM` naming `256color`, then `TERM=dumb` for none. The lava ramp resolves
  against that depth, so a terminal that does not speak truecolor gets the 256-colour
  cube, or the sixteen every ANSI terminal has had since 1979, instead of `38;2;…`
  printed at it as garbage.
- **`smelt stats` is a report.** The store it read and what that store holds on disk, the
  expansion rate with a proportional bar, the counters as an aligned block — including
  `misses`, which the store has always counted and never printed — and the per-rule
  ledger as a table (rule, stored, retrieved, rate) sorted by what each rule cut. An
  empty store says so in one line instead of printing a page of zeroes.
- **`smelt doctor` marks every line** — `✓`, `✗`, `⚠` — and sets the repair block apart
  from the findings it repairs. Same information, same sentences, no line removed.
- **The ASCII fallback reaches the punctuation, on the pages this release added.** A
  terminal whose locale never promised UTF-8 was already given `+`/`x`/`!` for the marks
  and `-` for the rule, and then an em dash three bytes wide in the middle of the
  sentence. The palette now owns that character too (`dash()`), so `smelt doctor`,
  `smelt stats` and the four closing blocks carry nothing above ASCII at all where the
  locale said so. smelt's prose keeps its em dash everywhere a terminal can render one.
- **Every wizard ends with the same block.** `smelt setup`, `smelt hooks install`,
  `smelt hooks remove` and `smelt init` close on a lava rule, a verdict counted off what
  they actually applied (`wrote 2, skipped 2 — 4 files in all`), the one sentence that
  verb owes you, and the two or three commands that follow from it. A file you declined,
  and a file refused because it is somebody else's to write whole, are each counted as
  what they were and never as a file written. Under `--json` the receipt is still the
  whole output, and in a pipe the block is the same bytes without the paint.
- **Everything smelt draws falls back to ASCII where the locale never said it could
  render more.** The check marks become `+ x !`, the rules and the bar become ASCII
  cells, and the wordmark has a plain twin — through every wizard and through `doctor`,
  not only the report. Prose punctuation is deliberately untouched: an em dash is still
  an em dash, and that is the boundary the end-to-end test states rather than pretends is
  somewhere else.

### Changed

- The three session-lifecycle hooks (`stats`, `map`, `agents lint`) are written as
  `smelt <verb>` where `smelt` is on PATH, and `node "<binary>"` where it is not. Both
  spellings carry the `# smelt:hooks` ownership token and both are recognised by a
  re-run's toggle reader, so an upgrade never duplicates or orphans an entry. The guard
  hook stays `node "<shim>"`: a shim is a script, not a bin.
- The guard's deny reason picks its replacement command when the reason is rendered
  rather than when the module loads, so it reflects the environment the hook actually
  runs in.
- The Homebrew verification snippet in the README now pipes a real hook payload, so it
  returns a decision instead of waiting on stdin.
- **A hook command is a value, not a string.** `harness/hook-command.ts` owns both
  directions: one writer (`renderHookCommand`) and one reader (`parseHookCommand`), with
  the round trip pinned by a guard. Before, one writer emitted the string and three
  substring searches re-recognised it — the ownership check that decides what a re-run
  may replace, the toggle reader that tells the opening map from the instruction lint,
  and the installed-state reader — each with its own needle, so a change to the spelling
  would have left all three quietly matching the old one. The reader also now recognises
  the `node "$(readlink -f …)"` form people applied by hand as a workaround for the
  symlink bug, so a re-run replaces those entries instead of duplicating them.
- An entry whose command the reader does not recognise is _foreign_, and
  `smelt hooks install` may not touch it. That was already the intent; it is now a
  property of one function with a mutation proving it can be broken.
- **Claude Code's MCP registration at machine scope is a printed command, not a file
  edit.** Its user scope lives under the top-level `mcpServers` key of `~/.claude.json`,
  a file Claude Code owns and rewrites and whose docs say to manage it through `/config`
  and the `claude mcp` CLI. `smelt setup --scope user` prints
  `claude mcp add --scope user smelt -- npx @smeltjs/mcp` and writes nothing;
  `smelt doctor --scope user` checks the key read-only and names the command when it is
  absent.
  The project registration (`.mcp.json`) is unchanged.
- Hook commands written at machine scope name every path absolutely. A project-scope
  command spells a script inside the repo relative to it, because that config travels
  with the repo; a machine-scope hook runs with its working directory set to whatever
  project the agent opened, where a relative path names a file that is not there.
- **`smelt setup --yes` and `smelt hooks install --yes` now merge an existing file,
  never overwrite it.** `smelt setup` used to skip any existing file that was not
  already smelt's, with a note telling you to run `smelt hooks install` — which meant
  the one command an agent can drive could not finish the install it had started. Both
  verbs now apply one merge policy: a file whose new content was computed _from_ the
  existing bytes (a JSON hooks merge, a marker-block append, an MCP registration edit)
  is written, because every **entry** that is not smelt's is already in it — outside the
  region smelt edits (the `hooks` key, its marker block, its server entry) the file is
  byte-identical, and inside it a foreign entry keeps its content though not necessarily
  its formatting. A file smelt writes _whole_ — the opencode plugin, Cline's hook
  wrapper — is left alone unless it is already smelt's.
- **A file smelt would write whole and does not own is reported skipped with the
  reason, and the run still exits 0** — a refused file is a reported fact, the way a
  skipped file in `smelt setup`'s receipt always has been, not a failed install.
  `--json` carries it in `files[].action`, and `smelt doctor` is the verb whose exit
  code answers "is this wired".
- **A closed output stream is a refusal, not a crash.** `smelt hooks install | head`,
  or answering a wizard with `yes`, left the process writing prompts into a stream
  nobody was reading; unheard, that is a Node stack trace and an exit code nobody chose.
  It is now one line and exit 2.
- **The MCP registration step names the harness you are wiring.** `smelt setup` printed
  `claude mcp add smelt -- npx @smeltjs/mcp` as _the_ MCP step whatever harness you
  named — a command about a file Codex and Grok do not read, run through a binary you
  may not have, and printed even for the TOML table setup had just written itself. Each
  harness now carries its own registration as a person performs it, beside the step that
  writes it, and setup prints that: Claude Code's CLI verb, Codex's and Grok's
  `[mcp_servers.smelt]` table, opencode's `mcp` key — with the machine-wide spelling
  where the harness has a different one. Where no chosen harness carries a registration
  at all, the step names none: `npx @smeltjs/mcp`, the plain stdio server any MCP client
  registers. `smelt.setup.v1`'s `mcp.command` keeps its shape and changes its value
  accordingly — for Codex, Grok and opencode it is now that harness's own registration
  rather than Claude Code's, and with no registering harness selected it is the plain
  stdio command — and `mcp` also carries `commands: readonly string[]`, every
  registration a run is about, because a run that wires two registering harnesses has
  two and the single `command` field (kept, as `commands[0]`) could only ever name the
  first. `packages/mcp/README.md` gains the opencode section, and a guard pins each
  harness's section against the profile that claims one.
- **The installer is three modules and a wizard, where it was one file.**
  `smelt hooks install` and `smelt setup` answer the same three questions — what would
  be written, may an existing file be written over, what is installed already — and all three
  answers used to live inside the hooks _wizard_, so setup imported a wizard to plan.
  The plan is `harness/plan.ts` now, the merge policy `cli/merge-policy.ts`, the toggle
  reading `cli/installed.ts`; `cli/hooks.ts` is the wizard and nothing else. No
  behaviour changed — the same functions write the same bytes.
- `smelt init`'s reranker question now has three answers (`none`, `module`, `voyage`)
  and **writes the config block that loads your choice**. Previously it generated a
  `smelt.rerank.ts` that nothing read. `none` writes no key at all.
- `docs/ARCHITECTURE.md`'s "no bundled adapter, no env-var opt-in" ruling is rewritten
  around ADR-0004: a _default_ reranker is still refused permanently, and so is an
  env-var switch; what is new is that consent can be written in a config file.
- The elision journal gains a fourth line kind, `evict "<hash>" "<date>"`, written and
  `fsync`ed **before** the blob is unlinked. It is invisible to a reader that predates
  it, exactly as `put` lines already are, so a directory pruned by this version reads as
  the same counters and the same ledger under the previous one.
- `elisionsStored` now counts evicted hashes as well as the blobs on disk, so a prune
  cannot raise the expansion rate by shrinking its own denominator. The per-rule ledger
  is untouched by a prune — the rule did make that cut. `bytesStored` is the one counter
  a prune moves, because it is the one that measures the disk.
- The store's documented promise sharpens from "no eviction" to "no _automatic_
  eviction", in the README, the site, `ElisionStore`'s own doc and
  `docs/ARCHITECTURE.md` — a claim the code no longer supported unqualified.
- The Homebrew formula's `node` dependency is now `:recommended` rather than required:
  `brew install --without-node smeltjs/tap/smelt` installs against the Node already on
  `PATH` (which must satisfy smelt's engines floor, `^20.19.0 || >=22.12.0`, and must
  live somewhere Homebrew's superenv build environment can see — e.g. `/usr/local/bin`
  or the Homebrew prefix, not just a version-manager shell shim) instead of pulling
  Homebrew's own `node`.
- **One palette, and no verb builds an escape sequence.** `cli/lava.ts` is now the
  Palette: named roles (headings, rule ids, hashes, byte counts, paths, warnings) and the
  primitives under them, with the wordmark as a committed constant in the ANSI Shadow
  letterforms — smelt runs no figlet, and adds no dependency to paint. The default verb's
  report, `smelt map`, `smelt store prune`, `smelt agents lint`, the help page and the
  wizards all render through it. Colour off is byte-for-byte the old rendering, so every
  `--json` envelope, every `--yes` receipt and every pipe is unchanged — stderr included,
  which a `--json` run now leaves unpainted as well, refusals and all.
- **`smelt stats`'s text output is no longer `name value` lines.** The counter names and
  values are still one per line and still greppable; the ledger is a table rather than
  `rule.<id>.stored` keys. `--json` — unchanged, `smelt-stats-cli/v2` — is the surface to
  parse, and the help now says so.
- A rendering may not round a non-zero to zero: a real 0.04% expansion rate prints
  `<0.1%`, and its bar keeps one filled cell. Law 4 reaches the formatter.
- The README's `smelt stats` capture is regenerated from the binary rather than pinned by
  hand, the way the "Sixty seconds" transcript beside it already was: a guard runs the
  real CLI in a scratch project whose store is thrown away, normalises the store path to
  the README's own spelling, and compares byte for byte. It was the last hand-typed
  rendering of real counters on that page, and it can no longer drift silently.
- **The config schema moved out of `cli/`** — `SmeltConfig`, `parseConfig`,
  `renderConfig`, `findConfigFile`, `loadNearestConfig`, `configuredStore` and the two
  config constants are `@smeltjs/core`'s `src/config.ts` rather than `src/cli/config.ts`.
  Every exported name and every re-export from the package root is unchanged, so nothing
  a consumer imports moved; what moved is which layer owns the file. Three layers that
  are not the CLI read the schema — the install planner, the store seam and the rerank
  loader — and a module three layers depend on cannot live inside one of them.
  `harness/` now imports nothing from `cli/` at all, with no exception left in the seam
  guard.
- **`SETUP_RECIPE.mcp.register` is gone.** The recipe held Claude Code's
  `claude mcp add smelt -- npx @smeltjs/mcp` as though a `claude` CLI verb were every
  harness's registration, and five renderings read it from there. Registration is a
  `HarnessProfile.mcp` fact — one per harness, in that harness's own words — and what
  the recipe keeps is `mcp.run`: `npx @smeltjs/mcp`, the plain stdio command any MCP
  client registers and the only MCP sentence true without naming a harness. The
  recipe's ordered `mcp` step and the generated `skills/smelt/SKILL.md` line now carry
  that instead of a `claude` verb; Claude Code's two spellings live in its own profile,
  composed from `mcp.run` rather than retyped. Both READMEs are byte-identical — they
  document Claude Code, and are now pinned to the profile that owns what they show.

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
