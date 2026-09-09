# smelt — domain vocabulary

The names the code uses, with their exact meanings. Architecture reviews and refactors
use these terms; drift is a bug. Module/interface/seam/adapter vocabulary follows the
codebase-design glossary.

## Core domain

- **Blob**: the text a caller hands to `smelt()` — a file, grep result, trace, log. smelt
  never fetches one itself.
- **Budget**: a soft output ceiling in UTF-8 bytes. A target planners aim under, never a
  silent guarantee; overrunning it is reported, not hidden.
- **Elision**: a planned removal of a byte range, carrying an `ElisionReason` (stable
  `rule` id + human `explanation`). Applied elisions are reversible by construction.
- **Marker**: the one-line stand-in `<<smelt/v1: … — retrieve("hash")>>` that replaces
  elided bytes. Part of the frozen wire surface; it goes into prompts.
- **Marker leader**: the language-specific line-comment prefix (`// `, `# `) a marker
  needs so the survivor still parses.
- **Survivor**: what remains of a blob after `applyPlan`. For structural plans the
  survivor must still parse in its language.
- **Planner**: a module that turns a blob + budget + focus into an `ElisionPlan` without
  removing any bytes itself. `applyPlan` is the only byte-remover.
- **Focus**: the caller's statement of what the task is actually about; focus-matched
  regions survive planning.
- **Store**: content-addressed home of elided bytes (`ElisionStore`). No _automatic_
  eviction: a store that can forget by itself turns "reversible" into "reversible,
  usually". The one deletion is **Prune**, below, and it is a verb the user types.
- **Expansion rate**: retrieved-back fraction of what smelt hid — the honest signal of
  over-pruning. Measured, never thresholded. The marker's `retrieve("hash")` is a real
  command — `smelt retrieve <hash>` — so the rate moves (and is measurable, via
  `smelt stats`) from pure shell, not only through the `smelt_retrieve` tool.
- **Prune** (`smelt store prune`): the only eviction in smelt, and the reason a store
  that deletes can still satisfy Law 3. Explicit (a user typed the verb; nothing prunes
  on a timer, a size cap, or when a store is opened), bounded by a cut-off that user
  named (`--older-than <n>d|h|w`, no default), journalled **before** the bytes go
  (`evict "<hash>" "<date>"`, `fsync`ed, then the unlink), and counted: `elisionsStored`
  keeps counting what was evicted, so pruning cannot raise the **Expansion rate** by
  shrinking its own denominator, and the **Ledger** is untouched — the rule did make
  that cut. Only `bytesStored` falls, because only `bytesStored` measures the disk. A
  later `retrieve` of an evicted hash raises **`EvictedHashError`**, never
  `UnknownHashError`: "you pruned it on <date>" and "it was never elided" are different
  answers, and the second one would be false. That lookup **still counts as a miss** —
  `retrieveCalls` and `misses` move exactly as they would for a hash nobody ever stored,
  because the model asked for material back and did not get it; only the error text
  differs, because only the error is read by a person deciding what went wrong. `has()`
  answers `false` — a boolean has no room for a reason. _Avoid_: eviction policy, GC,
  LRU, TTL.
- **Ledger**: the per-rule half of the same honesty — for each `ElisionReason.rule`,
  how many distinct cuts it made in a store and how many of them were retrieved
  (`RuleLedgerEntry { rule, stored, retrieved }`). The rule is persisted at put time by
  the one byte-remover, derived once by `ruleLedger()` in `stats.ts`, read by
  `store.ledger()`, `smelt stats` and `smelt_stats`, and handed to planners as opt-in
  `PlanInput.ruleHistory`. `retrieved === stored` for a rule is a fact, never a
  threshold: the rule's every cut was asked for back. _Avoid_: score, penalty.
- **Outline**: the names of the declarations one structural elision collapsed
  (`PlannedElision.names`, carried onto `AppliedElision.names`), rendered beneath the
  elision's report row and in the `--json` envelope — never in the marker, whose bytes
  and price do not move. What is behind a marker, by name, so a model can decide
  whether to retrieve without retrieving.
- **Producer**: the command whose output a blob is (`grep -C 3 foo src`). `focusTermsFor`
  in `src/hooks/focus-terms.ts` derives from it the terms that distinguish output lines
  the task is about — nothing for a plain grep, whose every line matches — and the
  guard's rewrite wrap, `smelt --producer` and `smelt_file`'s `producer` all resolve
  through it. A caller's own focus always wins; the report attributes whose focus cut.
- **Batched retrieve**: `smelt_retrieve_batch` / `retrieveMany` — N hashes, one round
  trip, one `RetrievedBlock` per hash. Changes what an expansion _costs_ (every tool
  call re-bills the transcript), never what the expansion rate _means_: each hit inside
  a batch journals exactly as a single call would. Additive beside the frozen
  `smelt_retrieve`.
- **Guard**: a test that pins a law or guarantee, proven non-vacuous by mutations.
- **Mutation**: a deliberate minimal break that its guard must catch (`pnpm mutate`).
- **Guard tally**: `guards.json` at the repository root — how many guards, how many
  mutations, guard by guard. Written by the runner (`pnpm generate:guards`), refused by
  it when stale, and read by everything that wants the number. It exists because the
  number was prose in four documents, one of them worded past the drift regex meant to
  catch exactly that, and reconciling it took five commits in a day. Law 4 turned on the
  repository's own numbers: state no figure that has not been measured, including this
  one.
- **The four laws**: zero network · every elision explainable · every elision reversible
  (and counted) · no unmeasured numbers. Reasoning in `docs/ARCHITECTURE.md`.

## Deepened modules

- **LanguageProfile**: the single adapter carrying every per-language fact — extensions,
  grammar wasm, marker leader, pinned comments, structural node kinds, repo-map tag
  kinds, licence provenance. One file per language in `src/lang/`; the registry
  (`LANGUAGE_PROFILES` in `src/lang/registry.ts`) is `Record<LanguageId, LanguageProfile>`,
  so totality is a compile error. The seam is `profileFor(id)`, `profileForPath(path)`
  and `structuralLanguages()`; every rendered list and every exported set
  (`SUPPORTED_LANGUAGES`, `WASM_BY_LANGUAGE`, `STRUCTURAL_LANGUAGES`,
  `MARKER_LINE_COMMENT_LEADERS`) is a derived view. Consumers read it, never own a
  slice of it. "Structural language" = a profile with a `structure` section;
  `grammar-provenance.json` holds the licence facts, its key set guard-pinned to the
  registry's wasm set.
- **HarnessProfile**: the single adapter carrying every per-harness fact — tier and
  caveats, the paths that detect it, its instruction file, its native hook schema as
  data (`HarnessHookSchema`: read/bash tool names, payload keys, the deny and rewrite
  documents), and its install steps, each step's kind being also how `remove` takes it
  back out. One file per harness in `src/harness/`; the registry (`HARNESS_PROFILES` in
  `src/harness/registry.ts`) is `Record<HarnessId, HarnessProfile>`, so totality is a
  compile error. It imports nothing from `cli/` — that cycle is why the `--harness` help
  list used to be hand-typed — and every rendered list and derived set (`HARNESS_IDS`,
  `MANAGED_EVENTS`, `GUARD_EVENTS`, `JSON_HOOK_FILES`, `GUARD_ONLY_FILES`) is a view
  over it. `planInstall`/`planRemove` (**InstallPlan**, `src/harness/plan.ts`) fold over
  `profile.install`; they hold no per-harness case. `profile.mcp` is the same discipline
  for the MCP server: a profile that registers smelt carries the registration _as a
  person performs it_ (`{manual, manualUser?}`) beside the step that writes it — Claude
  Code's CLI verb, Codex's and Grok's `[mcp_servers.smelt]` table, opencode's `mcp` key
  — each the snippet a person pastes, composed from `MCP_RUN_ARGS` so it and the bytes
  smelt writes cannot drift. The guard reads `packages/mcp/README.md` **one section at a
  time**: every file a manual names and every line of its snippet must be in that
  harness's own section, because the TOML table is identical in two of them and a
  whole-file search stays green while a profile points at somebody else's config.
  `smelt setup` printed the recipe's Claude Code command for _every_ harness before it,
  which is a command about a file Codex does not read; and its receipt now carries
  `mcp.commands`, every registration a run is about, because `mcp.command` can only name
  one and a run wiring two harnesses had the second read as "not registered". `shimFromSchema(schema)` builds the **ShimAdapter** a shim script runs and owns
  what every shim shares — the rewrite-input splice, the deny fallback, and the one
  rewrite announcement (also spliced into the generated opencode plugin). ShimAdapter
  stays public as the escape hatch for a harness a table cannot express. The **tier
  grouping** is a view too: `harnessesByTier()` folds `profile.tier` into
  `{tier, honesty, harnesses}` rows in `TIER_HONESTY`'s key order, and the `hooks` help
  body, the wizard and the site's table and prompt badges render it — it was hand-typed
  in five places, so a promoted harness stayed under its old tier in four of them. `wiresLifecycle(profile)`
  is its sibling and the correction of a confusion: the stats/map toggles wire wherever a
  JSON hook step declares `lifecycle`, which the wizard called "verified-tier harnesses"
  because the two sets happen to coincide. Because every _rendered_ grouping now derives
  from the same field, `README.md`'s tier table is deliberately **not** generated: it is
  the outside witness the guard reads, and a mis-tiered profile is caught there or
  nowhere.
- **Invocation**: the one answer to "how is smelt re-invoked on this machine"
  (`src/hooks/invocation.ts`). Everything smelt writes into somebody else's config file
  is ultimately a command that has to still work tomorrow — a hook entry, the opencode
  plugin's absolute import, the deny reason's replacement — and three files used to
  derive it three ways from `import.meta.url`. The seam is `smeltInvocation(options)`,
  returning `{ kind: 'path' | 'node', command, script?, bin, stable, why }`, ranked:
  a `smelt` on PATH (a name no upgrade moves) · this package's own `dist/cli/bin.js` in
  its stable spelling · the versioned path, with `stable: false` and a `why` a receipt
  prints. It owns three facts nobody else may re-derive: `isSameFile` (realpath both
  sides — node realpaths the ESM main entry, so `isMainModule`'s old string compare said
  "not main" through any symlink and the guard exited 0 with empty stdout, which every
  harness schema reads as _allow_); `pathStability` (below); and `smeltOnPath` (a stat
  per PATH directory, never a spawn). Rung 1 also carries a `caveat` when the `smelt` it
  found does not realpath to this install's own bin — the ranking does not move, but a
  machine with two smelts must not look like a machine with one. It imports **node
  builtins only**, like its sibling `guard-core.ts`, which reads it — and reads it
  _lazily_, when a deny reason is rendered rather than at module load (memoised per
  process, the memo bypassed by any injected call), so the command reflects the
  environment the hook actually runs in and a test can inject `env` and `fs` instead of
  the real machine. `harness/paths.ts` keeps its exported names and delegates.
- **PathStability** (`pathStability(path)` in `src/hooks/invocation.ts`): the verdict on
  one path smelt is about to write into somebody else's config file — `{ path, stable,
why }`, where `path` is the spelling to write. It is asked **per script actually
  named** — the guard shim, the guard core the opencode plugin imports, `cli/bin.js` —
  never of the invocation value, which is stable whenever `smelt` is on PATH: judging
  the value reported the lifecycle hooks fine while writing the guard hook, the
  security-relevant one, as a bare Cellar path with nothing said. Unstable means a
  recognised **version-bearing segment**: a Homebrew keg with no `opt` alias resolving to
  it, a `/.pnpm/<name>@<version>/` store entry, a `/versions/node/<v>/` tree. Stable is
  deliberately the weaker claim — nothing here can know a packaging manager's policy, so
  the `why` says "nothing here proves an upgrade moves it — nor that it keeps it" and
  never that anything is replaced in place. `smelt hooks install` and `smelt setup`
  print the unstable ones (`smelt.setup.v1`'s optional `notes`).
- **HookCommand**: what one entry in a harness's hook config _says_, as a value, and
  both directions over it (`src/harness/hook-command.ts`). A guard command is
  `{ kind: 'guard', script }`; the three lifecycle commands are
  `{ kind: 'stats' | 'map' | 'lint', invocation: 'path' | 'node', script?, args }` —
  the Invocation's two spellings, carried rather than re-derived. `renderHookCommand`
  is the only writer and `parseHookCommand` the only reader, and
  `parseHookCommand(renderHookCommand(c, cwd))` equalling `c` is a guard, because the
  string used to have one writer and _three_ substring readers (the ownership check the
  merge runs, the toggle reader that tells the opening map from the instruction lint,
  and `cli/installed.ts`'s per-file "is this ours"), each carrying its own needle.
  `undefined` is load-bearing: it means **foreign**, and a re-run may only ever replace
  entries it can prove are its own — which is why the parser accepts three quotings and
  the `$(readlink -f …)` workaround people have on disk today, and refuses
  `node other.js`. **The probe** is the module's second half and the reason `smelt
doctor` can now say _verified_: `probeHookCommand` runs the command — for a guard,
  against a payload built from the harness's own `HarnessHookSchema` naming an
  oversized file in a fresh temp directory, beside a `smelt.config.json` pinning the
  threshold so the walk up to the filesystem root cannot change the premise — and
  answers `fires` / `inert` / `missing`. It reads **entries**, so the JSON hook files are
  probed and the whole-owned guard-only files (Cline's, Hermes's, the opencode plugin)
  are not: they carry no event-to-entry table, and doctor keeps saying plain `wired`.
  `wired` used to be a text fact, and the two defects Invocation fixed (an inert shim
  through a symlink, a keg path `brew upgrade` deleted) both leave that text exactly as
  it was; `inert` is the dangerous verdict, because empty stdout is how every harness
  schema spells _allow_. Probing is a read, so ADR-0003 holds — doctor still writes no
  byte of the project, and the one thing it spawns is `process.execPath` (the narrower
  ruling under which `node:child_process` is on the Law 1 allowlist at all).
- **InstallScope** (`src/harness/scope.ts`): where an install goes — `'project'` or
  `'user'`. Every artefact the installer writes used to be a bare relative path joined
  to `cwd`, at write time and, separately, at read time. That is right for a project and
  wrong for the only way to get one config and one store for every project on a machine,
  which is to install from `$HOME`: config discovery walks up, so a config at `~` is the
  one every project below it finds. Run from there, the installer wrote `~/CLAUDE.md`,
  `~/.mcp.json`, `~/AGENTS.md`, `~/GEMINI.md` and `~/opencode.json` — files no harness
  reads at that level (Claude Code reads `~/.claude/CLAUDE.md`, Codex
  `~/.codex/AGENTS.md`, Gemini `~/.gemini/GEMINI.md`, opencode
  `~/.config/opencode/opencode.json`) — and doctor read from the same wrong places, so
  the writer and the reader agreed the install was healthy while nothing was wired. The
  user-level location is therefore a **per-harness fact**, `HarnessUserLocation` on the
  profile beside the project path, and the seam is one resolver:
  `locateStep(step, scope, {cwd, home})` → `{ path?, name?, skipped?, manual? }`. Project
  scope returns exactly `join(cwd, step.file)`, so a project install is unchanged;
  user scope returns the location that harness's own documentation names. `path` is
  absent **exactly when** `skipped` is set, which is what makes the old defect
  unreachable rather than merely unwritten: there is no path to fall back to, and the
  compiler says so. `planInstall`, `planRemove`, `readInstalledState`, `presetToggles`,
  doctor and the snippet all go through it. `manual` is the third answer — a location
  that exists but is not smelt's to write, because the harness owns and rewrites the
  file: Claude Code's user-scope MCP registration lives under the top-level `mcpServers`
  key of `~/.claude.json`, so setup prints `claude mcp add --scope user …` and doctor
  checks the key read-only. At user scope the config is `~/smelt.config.json` (decided,
  not discovered) with the store at `~/.smelt/store`, and the marker block says "This
  machine uses smelt" rather than "This project". Selection is `--scope` on `setup`,
  `hooks install/remove` and `doctor`, defaulting to `user` when `cwd` realpaths to the
  home directory; both receipts carry it. A harness that documents no user-level home
  for an artefact is **project-only** and reported skipped with the reason — today
  Hermes, KiloCode and Aider entirely, plus Grok's and Cursor's instruction layers and
  Grok's hook file.
- **InstallPlan** (`src/harness/plan.ts`): every file an install would write, and every
  one `remove` would take back out, computed against the disk and writing nothing —
  `planInstall(cwd, choices)` → `{files, skipped, notes, manual}` and its mirror
  `planRemove`. Both are folds over `HarnessProfile.install` with no per-harness case:
  what to write is the profile's, where it goes is `locateStep`'s, what a hook entry
  says is `harness/hook-command.ts`'s, and the byte-faithful edit is `text/json-edit.ts`
  or `text/toml-edit.ts`. It sits in `harness/` because **planning is not a verb**: both
  install verbs plan identically and differ only in who consents to the write
  (**MergePolicy**). While the fold sat inside the hooks wizard's module, `smelt setup`
  imported that wizard to plan, and the file was ~1200 lines of two unrelated jobs.
  Its one `cli/` import is `cli/config.ts` — the config schema and its one writer,
  because `smelt.config.json` is what the install is _for_, and a key added to the
  schema must reach the installer and `init` together or not at all.
  `test/guards/module-seams.test.ts` pins both halves: the import edges, and the count
  of the declarations, because an import edge that is merely absent is satisfied by a
  copy.
- **MarkerPricing**: the seam through which planners ask what a marker will cost in
  bytes — `costBytes(reason, elidedBytes)`, required on every `PlanInput`. Owned and
  built by `apply.ts`: `markerPricing(language, marker)` is the one adapter, built from
  the exact builder `applyPlan` will use (a caller's custom `MarkerBuilder` prices with
  its own rendering, so a longer marker makes small cuts unprofitable and the planner
  sees it). Planners never estimate independently; `createSmelter` and the CLI construct
  the pricing centrally, and a JS caller who omits it gets `MissingMarkerPricingError`,
  never a guessed cost.
- **Subcommand**: the single adapter carrying every per-verb fact — the flags it owns
  (`readonly FlagName[]`), its `parse`, its `resolve`, its `run`, its `usage` block and
  the one sentence a refusal ends with. One file per verb in `src/cli/subcommands/`;
  the registry (`SUBCOMMANDS` in `src/cli/subcommands/registry.ts`) is
  `Record<Verb, Subcommand>`, so totality is a compile error. The seam is
  `subcommandFor(positionals)` — `parseSmeltArgs` looks a verb up and lets it validate
  itself, `runCli` is a lookup and a dispatch, and every rendered view (the USAGE
  block, the help's sections, the `map only.` prefix on an OPTIONS entry) is derived.
  **Flag ownership is the property it exists for**: a flag outside the chosen verb's
  list is refused by ONE generated message naming the flag, the verb, and — when
  exactly one verb owns it — where it does belong, replacing the five hand-written
  refusals in which every verb refused every other verb's flags. `CLI_FLAGS` in
  `subcommands/flags.ts` is the companion table: it types `FlagName`, tells
  `parseArgs` how to read each flag, and carries its OPTIONS entry.
  `test/guards/subcommand-registry.test.ts` crosses every verb with every flag it does
  not own.
- **ResolvedRun**: the default verb's single merge of flags + config + built-ins
  (`resolveRun` in `src/cli/subcommands/smelt.ts`); the only place that verb's
  precedence lives, each value carrying its provenance (`flag`/`config`/`builtin`). It
  owns the budget-required refusal, and the verb's `run` executes it straight-line with
  no `??` of its own.
- **retrieveStats**: the one exported derivation within `src/` of the honesty
  arithmetic (`expansionRate`, `allElisionsRetrieved`) from a store's
  **RawRetrieveCounters** — a free function in `src/stats.ts`, not a base class. A
  store implements `rawCounters()` and delegates `stats()` to it; adapters supply
  counters, never derive the metric. Consumers see only `stats()`; the seam is for
  adapter authors. (`bench/lib.mjs`, deliberately import-free, re-derives the same
  formula; `test/bench.test.ts` pins the two copies to each other.)
- **PLANNERS**: the one registry of planner strategies (`src/plan/planners.ts`), string →
  factory over the lexical/structural option bags. `createSmelter`, `--strategy` and
  config validation, the help text, the `init` wizard's menu and the `smelt_file` tool
  schema all serve its keys; a constructed `planner` on `SmelterConfig` wins over any
  strategy name. **`DEFAULT_STRATEGY`** lives beside them:
  the strategy a caller who names none gets, read by `createSmelter`, the `smelt` verb's
  merge, the `init` wizard and the MCP server's `smelt_file` — the names were derived
  while the default stayed hand-typed in four places across two packages.
- **Selector** (`auto`): the third strategy, and not a planner — it picks one
  (`src/plan/auto.ts`). Structural where the language carries a bundled grammar
  (`isStructuralLanguage`, the one membership test, shared with the structural refusal),
  lexical everywhere else, and it returns the delegate's plan **untouched**, so
  `result.planner` reads `lexical/v1` or `structural/v1` and never `auto/v1`. It decides
  on a fact (the language), never on an accident: a grammar that fails to load still
  raises `GrammarUnavailableError`, and an explicit `strategy: 'structural'` still
  refuses an unsupported language exactly as before. `DEFAULT_STRATEGY` stays `lexical`
  — `auto` is opt-in, because a changed default is a behaviour change delivered to
  callers who asked for nothing.
- **Budget rung** (structural): the second pass in `planStructural`, and the reason it
  reads `input.budgetBytes` at all. When the first pass — every maximal sibling run,
  collapsed where that pays for its marker — comes back over budget, each run it
  _refused_ is re-asked as that run's best profitable sub-run, earliest first, stopping
  the moment the plan fits. Every candidate is minted by the same `collapse`, so a
  focus-matched or pinned unit is unreachable (it is in no run), the output cannot grow
  (nothing is minted whose marker is not strictly cheaper than the cut), and the
  enumeration is start-ascending, length-descending, so the plan stays deterministic.
  It fires only when the plan is still over budget after the first pass — never merely
  because a profitable sub-cut exists — and every cut it mints says so: `sibling-collapse-pressure`
  on the `ElisionReason.rule`, `sibling-collapse` for everything the first pass alone
  produced. The escalation is stated where every consumer of a plan already reads a
  rule from — the CLI report's rule column, the `--json` envelope, the per-rule
  ledger — never inferred from which pass happened to run. The lexical planner's
  context ladder is the sibling of this idea, and `src/plan/budget.ts` is the
  arithmetic they share.
- **Unit** (structural, `unitsOf` in `src/plan/structural.ts`): one root-level sibling
  the structural planner can match or collapse — a top-level declaration plus its
  attached comment/attribute prefix. **Root children only, one level, a stated
  non-goal**: a class or object body one level down is never re-grouped into units of
  its own, so a class is one opaque unit — kept whole the moment anything inside it
  matches the focus, collapsed whole otherwise, and never split method by method. The
  honest minimum this planner claims for one very large class with one matching method
  and nothing else nearby to trade: no elision at all. `--strategy lexical` covers
  that case by lines, without a per-method name. `test/structural.test.ts` pins the
  behaviour (`'does not descend into a class body — a stated non-goal'`) as a fixture,
  not a bug.
- **RepoMap**: the ranked whole-tree symbol map `buildRepoMap` returns — deliberately
  **not** an `ElisionPlan` and its builder deliberately not a Planner: nothing is
  elided, stored, or reversible, so the Planner interface would claim laws the map
  cannot honour. Its CLI front door is the `smelt map` subcommand, never a
  `--strategy` name; the map fits itself to its byte budget by construction, so
  `map` has no over-budget exit. **Path-only** (`map.pathOnly`, `REPO_MAP_PATH_ONLY_RULE`)
  is what an unmapped-language file gets, and — by the same mechanism, no special case
  — what php, kotlin and bash get too: their `LanguageProfile.repomap.defKinds` is `{}`
  (their definitions are not the identifier-shaped nodes the walk reads, so they are
  omitted rather than guessed at), which means zero defs, which is the one condition
  `buildRepoMap` checks. The file still appears in the map, honestly labelled, never as
  a name-less, rank-less regular entry.
- **ResolvedMapRun**: `smelt map`'s single merge of flags + config + built-ins
  (`resolveMapRun` in `src/cli/subcommands/map.ts`) — ResolvedRun's sibling, sharing
  the seam that owns precedence (`Subcommand.resolve`) and the budget-required
  refusal, not the struct.
- **Focus promotion** (repo map): a focus term moves matching symbols to the front
  of the map's fill order with a `focus-match` receipt naming the term; the measured
  rank and reference counts are never altered.
- **RepoReader**: the repo map's whole door to the filesystem — `list(dir)`,
  `read(path)`, `stat(path)` in `src/repomap/reader.ts`, optional on
  `RepoMapOptions` and defaulting to `nodeFsReader()` (the `readdirSync` /
  `lstatSync` / `readFileSync` calls the map used to make in-line). `decide`'s
  `statFile` is the sibling seam and the precedent. Read-only by construction:
  **there is no writer on it**, so the only bytes `buildRepoMap` can put on disk are
  the tags cache a caller named with `cacheDir`. Because it is injectable, the walk's
  claims are asserted by _counting calls_ — a symlink is statted once and never read
  (refused on `isSymlink`, not on the accident that an `lstat` of a link is neither
  file nor directory), an ignored path is never statted at all, and a file's `stat`
  and `read` are adjacent calls for that one path — never a second whole-tree pass
  over paths a first pass already vetted, which is what closes the stat-then-read
  TOCTOU window this module actually controls (KOT-205 §6).
- **CacheDiscard**: what `TagsCache.read()` in `src/repomap/cache.ts` returns for an
  entry it could not hand back as tags — named honestly by _why_, the same "damaged,
  never unknown" discipline the elision store applies to its own corruption. `'corrupt'`
  is an entry fully read and found unparseable or wrongly shaped; `'unreadable'` is one
  `readFileSync` itself refused (`EISDIR`, `EACCES`, anything but the plain `ENOENT` a
  miss already answers as `undefined`) — a case that used to escape as a raw
  `RepoMapIoError` and crash the whole map over one damaged cache entry the map never
  needed (KOT-205 §5). Both discard the same way and both report `deleted` honestly:
  `false` when the delete itself failed (an undeletable entry, e.g. a cache directory
  that turned read-only mid-build), never claimed as gone when it is still there.
- **Ops**: the operations seam under both front doors (`src/ops/`) — `smeltBlob`,
  `mapTree`, `retrieveBytes`, `readCounters` (`ops/verbs.ts`) as library functions over
  **already-resolved** inputs, returning data (text, the values a report needs, a
  `RepoMap`, bytes, counters); plus the laws an input must satisfy to be resolved
  (`ops/inputs.ts`). An op never touches argv, stdout, exit codes or MCP result shapes.
  Both front doors are adapters over it: the CLI's subcommand `run` bodies
  parse/resolve → call an op → render; the MCP tools validate their JSON Schema → call
  an op → wrap a `CallToolResult`. Five laws live in `ops/inputs.ts` because both
  packages held a copy of each: the budget (positive integer, no default), strategy
  precedence and the `lexical` built-in (`BUILT_IN_STRATEGY`, `resolveStrategy`), the
  not-a-directory refusal (`readTree`), read-a-path-or-name-it (`readBlob`), and opening
  a store decision (`openStore`, over `configuredStore`'s `ConfiguredStore`). A law
  states its **rule and reasoning** once and takes the caller's **naming** as an
  argument — `--budget` versus `"budgetBytes"`, `map` versus `repo_map` — so the two
  surfaces stay byte-identical to what each printed before. Nothing in `ops/` throws for
  a refusable law: it returns a **Ruling** (`{ok, value}` or `{ok: false, refusal}`),
  because the doors refuse in different currencies (`CliUsageError`/exit 2 versus
  `isError: true`) and a shared exception would make one of them wrong. Deliberate
  divergences stay in the adapters — `smelt retrieve`/`stats` refuse a memory store,
  the MCP server accepts one and hints — which is why `resolveStoreRun` stays
  unexported: it is the CLI's policy, not a shared law.
- **Rerank slot**: where a `RerankStage` actually bites — `src/rerank/protect.ts`,
  between the planner's decision and the cut. The **candidates** are the planner's own
  proposed elisions (the regions actually at stake), the **query** is the run's focus
  terms joined, and **what the stage returns is what smelt spares**: those entries are
  dropped from the plan, so they survive into the output as if a focus term had matched
  them. The returned list is a _selection_, not a ranking of everything — a stage that
  returns every candidate spares every candidate, and the run emits its input unchanged
  and exits 0, which is the one implementation mistake here that fails silently. A stage
  can only spare, never add, so a run may come back **over budget**, reported in the words
  a too-large focus window already earns. No candidates or no query and the stage is not
  called at all; every way a stage can fail — including throwing, which a hosted one
  ordinarily does — comes back as a `RerankStageError`, never as an unhandled crash. What
  it did comes back as a **RerankAttribution** (`{adapter, model?, candidates, kept,
skipped?}`) on `SmeltResult`, which the stderr report, the `--json` envelope and
  `smelt_file`'s report block all render from — one value, three surfaces, no front door
  counting anything itself. `candidates` is always the measured size of the candidate set
  and `skipped` names the missing precondition when the stage was not called, so a receipt
  never carries a count nobody took. _Avoid_: "rerank filters", "rerank cuts" — it only
  ever keeps.
- **Rerank opt-in**: the `rerank` block in `smelt.config.json` (ADR-0004), and the only
  smelt setting that can send a caller's source to a third party. Two kinds: `module`
  (an ESM file of the consumer's own, resolved against the config file, default-exporting
  a `RerankStage`) and `voyage` (`@smeltjs/rerank-voyage`, which the consumer installs).
  **Absent means nothing happens** — no import, no call — and that is what every default
  config says. `loadRerankStage` (`src/rerank/load.ts`) is the one loader for both front
  doors; every failure is a usage error naming the missing thing (the path, the `topK`
  this kind requires, the environment **variable**, the uninstalled package) and never a
  silent fall back to an unranked run. There is no `SMELT_RERANK_API_KEY` and no
  environment variable smelt reads that a config did not name. _Avoid_: "the rerank flag"
  (there is none), "enable reranking".
- **Opt-in rerank bucket**: `OPT_IN_RERANK_PACKAGES` in `src/net/policy.ts` — adapter
  packages a config block may **load** at runtime and no smelt module may **import**.
  The name is data here and nowhere else in `src`; `load.ts` hands it to `import()`, so
  the Law 1 walk finds no edge, and both packages' `classify()` rule an import of it
  **forbidden** rather than unclassified. The rule in one line: _smelt may know this
  package's name; smelt may not depend on it._
- **guard-kit**: the guards' shared machine — `packages/guard-kit`, test-only,
  `private: true`, never published and never more than a devDependency. It owns the
  import-graph **walker** (`walkImportGraph`, `assertNoNetwork`) that both packages'
  Law 1 guards run on, carrying the four vacuity defences and the reasoning for each,
  plus the source helpers (`guardSrcRoot`, `guardRoot`, `allSourceFiles`, `readSource`,
  `stripStringsAndComments`). The seam is `classify(edge): Classification` — one small
  function per package holding only that package's **ruling** (the core partitions
  against `net/policy.ts`; the mcp package adds a stdio-only SDK subpath allowlist).
  Each package's `test/guards/_source.ts` stays as its anchor, and the anchor is one
  call: `guardAnchor(import.meta.url)` derives `packageRoot()`/`repoRoot()` from the
  anchor's own location and returns the bound helpers, so nothing in the anchor is
  package-local but the `import.meta.url` it passes (the two anchors used to carry a
  byte-identical `packageRoot()` each). `GuardMutation` lives in the kit too; each
  package's `_mutations.ts` re-exports it, so a guard's import and the runner's
  textual anchor are unchanged. `SMELT_GUARD_SRC` / `SMELT_GUARD_ROOT` keep exactly
  the semantics `scripts/mutate.mjs` sets them with. The kit also owns the one
  registry invariant no `Record<Id, Profile>` can type-check — `assertKeyedById(
registry, idField)`: the key **is** the id, and the entry's id field agrees, so a
  by-key lookup (`profileFor`, `subcommandFor`) and a by-field one (`harnessById`,
  `HARNESS_IDS`) name one profile per id. It is an assertion applied to each registry,
  not a shared Registry module (ruling: a module fails the deletion test; the
  registries stay plain objects). It also owns the
  **packaging** machine — `packPackage`, which runs the real `npm pack` and extracts
  it, plus the three rules that read the result: no shipped declaration names an
  ambient global namespace, no sourcemap points outside the tarball, and a tool schema
  satisfies strict-mode structured outputs. Those are properties of _published bytes_,
  which no repo-level check can see.
- **SmeltConfig**: the parsed shape of `smelt.config.json`, and the module that owns the
  schema (`src/cli/config.ts`) owns **both** directions — `parseConfig` reads,
  `renderConfig` writes, one key order. What goes into a config stays each verb's
  **policy**: the `init` wizard always writes the strategy and store it asked about,
  `hooks install` injects a directory store when a config carries none (the deny reasons
  promise `smelt retrieve <hash>`, which a memory store cannot honour across processes).
  The round trip — `parseConfig(renderConfig(c))` equals `c` field for field — is the
  property that could not be expressed while two modules hand-built the file, and the
  guard reads the key set out of the reader's own refusal, so a field the writer forgets
  goes red rather than becoming a setting the user believed was in force.
- **Byte-faithful editor**: `src/text/json-edit.ts`. `editTopLevelProperty` replaces, inserts or removes (`value === undefined`) **one top-level property** of a JSON object
  in its source text, and `upsertMarkerBlock` / `stripMarkerBlock` do the same for a
  block between two marker lines. The contract is the whole interface: change what you
  were asked to and leave every other byte alone — indentation, key order, escapes,
  number spellings, unknown keys. It knows nothing about harnesses or hooks;
  `cli/hooks.ts` decides _what_ the merged `hooks` value is and hands it over. Under
  `src/text/`, not `cli/`, because it is strings in, strings out — no argv, no stdout,
  no CLI import. `test/guards/json-edit.test.ts` pins the round trip. Its sibling,
  `src/text/toml-edit.ts` (KOT-258), carries the same contract for TOML —
  `editTomlTable` replaces, inserts or removes one `[a.b]` table, header form or
  dotted form, for Codex's and Grok's `mcp_servers.<name>` registration —
  pinned by `test/guards/toml-edit.test.ts`.
- **Instruction set** (`smelt agents`): the `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` an
  agent loads on **every request**, as `src/agents/instructions.ts` finds them —
  through `RepoReader`, so the walk is injectable and its claims are asserted by
  counting calls. The guide's rule is that a nested file _merges with_ the root — a
  merge that runs **up** the tree and never across it, which makes two different
  numbers: the **per-request** cost (`perRequestBytes`, the heaviest level plus its
  ancestors — what one agent actually loads) and the **whole-tree surface**
  (`totalBytes`, every level summed — what a team maintains). Siblings never merge, so
  summing them and calling the result a per-request cost states a cost nobody pays.
  Each directory contributes one **primary** (its `AGENTS.md`, or whichever file stands
  alone there) and any number of **mirrors** — the other two names beside it. A mirror
  is counted for **drift** and never for bytes: one agent loads one of them, so summing
  all three would triple a cost nobody pays, and a symlinked mirror (the arrangement
  the guide recommends) cannot drift at all.
- **Finding** (`smelt agents lint`): what the lint noticed at one place, carrying an
  `ElisionReason` — the same stable `rule` id plus explanation an elision carries, for
  the same reason. Eight rules, in `src/agents/lint.ts`; the explanation always ends
  with an attributed fragment of the guide, so smelt's measurement and the guide's
  opinion are never mistaken for each other. Findings are **advisory** — exit 0 —
  until `--strict`.
- **Imperatives (heuristic)**: the count of instruction-looking lines, reported beside
  the byte total and never as a precise figure. It is a companion measurement, not a
  finding: an instruction file is _made_ of imperatives, so counting them as defects
  would make `--strict` red on every real file. The guide's cited "~150–200
  instructions" is printed as a citation and compared to nothing — expansion rate's
  ruling, applied to prose.
- **Split seam** (`smelt agents split`): the line between the guide's refactor's
  mechanical half — partition by `##` heading, rewrite the links that moved a directory
  deeper, write nothing without a per-file `yes` — and its judgment half, _which
  sections are essential_. The second needs a reading of the project, which needs a
  model, which Law 1 forbids; so smelt does the first and prints the guide's own
  refactor prompt, filled in with the file's real headings, for the user's own agent.
  The unconfigured rerank stage, applied to prose.
- **Palette** (`src/cli/lava.ts`): every byte of colour smelt writes, and the primitives
  that lay text out under it, behind one interface. The seam is `palette(options)` —
  plus `stdoutPalette(io)` and `stderrPalette(io)`, which answer the two streams
  separately, because `smelt big.log --budget 4000 > small.log` leaves the report on a
  terminal while stdout is a file. It owns **roles** (`heading`, `rule`,
  `hash`, `number`, `path`, `good`, `bad`, `warn`, `dim`, `strong` — what a span _is_,
  never what colour it should be), the **primitives** (`kv`, `table`, `bar`, `glyph`,
  `percent`, `divider`, `logo`) and — one composition above them — the **done block**
  every wizard ends on (`doneBlock`, with `countedFiles` for its verdict: a rule, what
  the run did counted off what it _applied_, and the commands that follow). Nothing
  else: no verb builds an ANSI sequence inline, so the day the brand changes it changes
  in one file. Three rules make it safe,
  and `test/guards/palette.test.ts` holds all three. **Off is the identity** — colour
  off is byte-for-byte the plain rendering, which is what every `--json` envelope, every
  `--yes` receipt, every pipe, `NO_COLOR`, `--no-color` and every guard's assertion
  gets. **Padding is measured before painting** — an escape sequence has zero width on
  screen and a dozen bytes in a string, so a cell padded after painting is a column that
  does not line up. **A rendering may not round a non-zero to zero** — `percent` prints
  `<0.1%` and `bar` keeps one filled cell for a rate that is not zero, which is Law 4 at
  the last inch before a person reads it. The **glyph set** (`✓ ✗ ⚠ · •`) and the bar's
  block cells fall back to ASCII where the locale never said it could render more
  (`supportsUnicode`), and the **wordmark** is a committed constant in the ANSI Shadow
  letterforms with a plain-ASCII twin — smelt runs no figlet. _Avoid_: "theme",
  "styling helper"; and never a colour name at a call site.

## Setup and distribution

Decided in the Sep 2026 architecture review; ADRs 0001–0004 carry the reasoning.

- **SetupRecipe**: the one true way to put smelt on a machine — install, init choices,
  hooks, MCP registration, verification — held as data, from which every rendering
  (README fragments, site prompts, the `setup` verb) derives, or is guard-pinned against
  it. Prose is never the source.
- **Setup** (`smelt setup`): the one-command, idempotent application of the recipe for
  chosen harnesses, at an **InstallScope** — interactive when a TTY is present,
  fully scriptable when an agent runs it, and the only repair path for installed state.
  Scriptable is load-bearing, not a convenience: the repair path an agent cannot drive
  is a repair path that does not happen. `--yes` answers every question, and the four
  toggles (`--guard`, `--stats`, `--map`, `--lint`, each `on|off`) answer the preset's;
  `smelt hooks install` takes the same four and the same `--yes`. From the home
  directory it detects a machine-wide install, says so, and lets you flip it; everywhere
  else it is the project's. The `init` wizard remains the deliberate sibling, not the
  repair path. _Avoid_: installer, `smelt init` (that is the careful wizard).
- **MergePolicy** (`Consent` in `cli/merge-policy.ts`): the one answer to "may this run write
  over a file that already exists", behind both install verbs. There are two ways to
  consent and one apply loop, because two loops drift and the one that drifts is the
  non-interactive path nobody watches. A **wizard** consent asks per file and takes
  nothing but a literal `yes`. A **policy** consent — what `--yes` and `smelt setup`
  use — reads the plan's own shape: a file whose planned bytes were computed _from_ the
  existing bytes (a JSON hooks merge, a marker-block upsert, a registration edit) is
  written, because **every entry that is not smelt's is already in it**; a file smelt
  writes _whole_ is refused unless it is already smelt's, and the refusal names it. The
  claim a merge makes is about entries, not bytes: outside the edited region — the
  `hooks` key, our marker block, our server entry — the file is byte-identical, but the
  edited region is re-serialised, so a foreign entry inside `hooks` keeps its content
  and can come back formatted differently. Recorded on
  `PlannedFile.ownership` (`'merged' | 'whole'`), so the question is answered by data
  the planner produced rather than by a list of filenames. It is its own module because
  it is one idea with two consenters: while it sat inside the hooks wizard, `setup`
  imported a wizard to apply. _Avoid_: "overwrite" for the merged case — nothing of
  anybody else's is overwritten.
- **InstalledState**: what smelt has written for one **InstallScope** — hook entries
  (found by their ownership marker), the config, the MCP registration, the binary
  version. Every path it reads is resolved by `locateStep`, the same resolver the
  installer wrote through, so a machine install is read back from `~/.claude/settings.json`
  and a project install from `.claude/settings.json`; a reader with its own list of
  names is how doctor came to agree with a writer that had moved. `smelt doctor` reads
  it and never writes it — including the registrations that are the harness's own file
  to rewrite, which it checks and names but never edits; orphaned pieces are reported
  facts, never silently cleaned. `presetToggles` lives with it (`cli/installed.ts`), for
  the same reason: what a re-run's four toggles start from is a reading of what is
  installed, not a wizard's memory.
- **SkillPack**: the opt-in, published teaching artifact an agent's owner installs by
  consent (`npx skills add smeltjs/smelt`) — the second adapter over the instruction
  content, beside the marker block. Distinct from R1's refused act (ADR-0002): smelt
  still never writes an agent's files uninvited.
