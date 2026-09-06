# Contributing to smelt

Bug fixes, planners, languages, docs — all welcome. Before you write code, read the four
laws in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#the-four-laws-and-why-each-one-is-load-bearing).
They are not style preferences. Each one exists because breaking it produces a library
that _looks_ like it works, and a contributor acting in good faith will break them
helpfully unless they know why they are there.

## Dev setup

```sh
git clone https://github.com/smeltjs/smelt.git && cd smelt
pnpm install
pnpm verify        # the whole gate: format, lint, build, typecheck, test, mutate
```

Node `^20.19 || >=22.12`, pnpm 10.15. No native compilation, no Docker, no services.
`web-tree-sitter` is WASM and the grammars are prebuilt `.wasm` blobs, so there is
nothing to build and nothing to download at runtime.

| Command                             | What it does                                                           |
| ----------------------------------- | ---------------------------------------------------------------------- |
| `pnpm verify`                       | Everything below, in order, one verdict. **This is the green signal.** |
| `pnpm build`                        | `tsc` per package into `dist/`, then bundles the grammars              |
| `pnpm test`                         | vitest, all packages                                                   |
| `pnpm typecheck`                    | `tsc --noEmit`, including tests and `site/`                            |
| `pnpm lint`                         | oxlint, warnings are errors                                            |
| `pnpm format` / `pnpm format:check` | prettier                                                               |
| `pnpm mutate`                       | the mutation suite — see below                                         |
| `pnpm generate:third-party`         | rewrites `packages/core/THIRD-PARTY.md` (never edit it by hand)        |
| `bash scripts/check-fresh-clone.sh` | installs and verifies from `git archive` output (tracked files only)   |

### Generated files

Two things in this repository are generated, and neither is ever hand-edited:

- **`packages/core/grammars/*.wasm`** — filled by `pnpm build` from `tree-sitter-wasms`,
  gitignored, and packed into the tarball via `files`. This is what makes "no native
  compilation, works offline" true for someone who just `npm install`s the package.
- **`packages/core/THIRD-PARTY.md`** — produced by `scripts/generate-third-party.mjs`
  from installed package metadata, the bundled files, and `grammar-provenance.json`.
  Bundling the grammars is redistribution, so attribution is required; generating it is
  how the attribution stays true when a grammar is added. A stale copy fails `pnpm test`.
  The generator emits the file already in prettier's formatting, so `pnpm format` (or an
  editor's format-on-save, from any directory) is a no-op on it and can never make the
  committed copy disagree with the generator.

One more file is a **committed copy, kept in sync by a test** rather than generated:
`packages/core/LICENSE` is a byte-for-byte copy of the root `LICENSE`. npm only
auto-includes a licence file that lives inside the package directory, so without the
copy the published tarball ships no licence at all. Edit the root file, re-copy it
(`cp LICENSE packages/core/LICENSE`), and `test/manifest.test.ts` fails if the two ever
diverge.

### Trying the CLI

```sh
pnpm build
node packages/core/dist/cli/bin.js packages/core/src/plan/lexical.ts --budget 2000 --focus planLexical
```

Text on stdout, report on stderr. `--json` prints an envelope you can feed back with
`--reconstruct` to prove the round trip from a shell.

## Silence is the enemy

smelt's characteristic failure mode is one where **the failure and the success look
identical**. A compressor that drops the wrong lines still returns plausible text. A
retrieve counter that never increments still reports a number. A guard that walks an
empty graph still goes green. None of those announce themselves; you find out weeks
later, from a model that is subtly wrong about a file.

Three rules follow, and they are enforced rather than encouraged.

### 1. A stub throws

Never return `[]`, never return the input unchanged, never fall back to a planner that
happens to work. A stub that returns something plausible is indistinguishable from a
working implementation with nothing to say, and someone will ship it.

```ts
throw new NotImplementedError(
  'reranking',
  'docs/ARCHITECTURE.md § "Explicitly out of scope" — implement `RerankStage` in your own ' +
    'code, with your own key, so the network call is visible in your source',
);
```

The error names _what_ is missing and _where to read about it_. `test/stubs.test.ts`
asserts every stub throws, and that asking a smelter for a strategy that does not exist
fails loudly instead of quietly falling back to the lexical planner.

### 2. Where the code claims a guarantee, a test enforces it

"Reversible", "rejected", "impossible", "always local" are assertions about behaviour.
If a comment says one, a test asserts it or the comment gets reworded. `reconstruct()`
does not _document_ reversibility; `test/guards/reversibility.test.ts` asserts
`reconstruct(smelt(x)) === x`, byte for byte, over multi-byte text, CRLF, a file with no
trailing newline, and one 20 kB line.

### 3. A guard nobody has watched fail is not a guard

Every guard ships with at least one **mutation**: a specific break in the source that the
guard must catch, exported as `MUTATIONS` from the guard file itself — the break lives
beside the assertions that must notice it. `pnpm mutate` discovers guards in **every
workspace package** with a `test/guards/` directory (`packages/core` and `packages/mcp`
today), copies the owning package's `src` to a
scratch tree, applies one mutation, points the guard at the copy via `SMELT_GUARD_SRC`,
and asserts the guard goes **red**. A mutation the guard survives is reported as a hole
in the _guard_.

```
$ pnpm mutate

=== pristine source: every guard must be green ===

  PASS  core: test/guards/bench-results.test.ts
  PASS  core: test/guards/cache-hygiene.test.ts
  PASS  core: test/guards/expansion-counter.test.ts
  PASS  core: test/guards/hooks-preset.test.ts
  PASS  core: test/guards/init-wizard.test.ts
  PASS  core: test/guards/marker-format.test.ts
  PASS  core: test/guards/no-network.test.ts
  PASS  core: test/guards/persistent-store.test.ts
  PASS  core: test/guards/planner-registry.test.ts
  PASS  core: test/guards/repo-map.test.ts
  PASS  core: test/guards/reversibility.test.ts
  PASS  core: test/guards/structural.test.ts
  PASS  core: test/guards/structural-totality.test.ts
  PASS  core: test/guards/third-party.test.ts
  PASS  mcp: test/guards/no-network.test.ts

=== mutations: every guard must go red ===

  CAUGHT  law1-node-https-import
           mutation: a network transport imported directly into the elision path
           guard:    core: test/guards/no-network.test.ts
           red on:   AssertionError: Law 1 violation: smelt v1 makes zero network calls: expected [ Array(1) ] to deeply equal []
  …
```

The run ends with a `caught/total` tally, counted from the guard files themselves —
anything short of every mutation caught exits 1. The tally is written, never typed:
`guards.json` at the repository root holds it guard by guard, `pnpm generate:guards`
regenerates it, and the runner refuses to start when the committed copy has fallen
behind the guard files. Documents point at that file rather than repeating its digits.

**Adding a guard? The convention is three steps:**

1. Import the library through `@guard/…` rather than a relative path, so the alias in
   the owning package's `vitest.config.ts` can be redirected at a broken copy. If your
   guard reads a _committed artefact_ rather than source, read it through `guardRoot()`
   from `test/guards/_source.ts` so it can be redirected too. That file is the package's
   anchor — one `guardAnchor(import.meta.url)` call that binds the shared helpers in
   `packages/guard-kit` (test-only, `private`, never published) to this package's own
   root.
2. Export the mutations **from the guard file itself**: `export const MUTATIONS:
GuardMutation[] = […]` (the type lives in `packages/guard-kit`, re-exported from
   `test/guards/_mutations.ts`), each entry
   naming the exact source string to change and _why that break matters_ — beside the
   assertions that must catch it, so the check and its proof-of-failure travel
   together. Entries are literal data; a guard over an artefact takes
   `kind: 'artifact'` and its `file` is resolved against the owning package first and the
   repository root second (`guards.json` counts every package, so it belongs to none). The runner
   (`scripts/mutate.mjs`) discovers guard files by name — there is no list to update.
3. Run `pnpm mutate`. If the guard survives, the guard is wrong — fix the guard, not the
   mutation.

The `find` anchor must match **exactly once**. A mutation that silently no-ops because
the source moved is the same class of bug the guards exist to catch, so it is a hard
error rather than a warning.

Nothing a mutation does touches the working tree. Source mutations go to a copy of `src`;
artefact mutations copy the one file into a scratch root. A runner that edited tracked
files and then crashed would leave the repository broken, which is the opposite of what a
safe-to-fail check is for.

The guards today, and what each one would let through if it stopped working:

| Guard                                | If it silently stopped working                                                                                                                                                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `guards/no-network.test.ts`          | source leaving the machine — including from the CLI, a second front door                                                                                                                                     |
| `guards/reversibility.test.ts`       | `reconstruct()` returning almost-right text                                                                                                                                                                  |
| `guards/expansion-counter.test.ts`   | the expansion rate pinned at a flattering zero                                                                                                                                                               |
| `guards/marker-format.test.ts`       | the marker changing shape in everyone's prompts, with no error anywhere                                                                                                                                      |
| `guards/third-party.test.ts`         | a bundled grammar being redistributed with no licence notice                                                                                                                                                 |
| `guards/cache-hygiene.test.ts`       | cache hygiene quietly rewriting prompts, or a hit-rate claim reappearing                                                                                                                                     |
| `guards/structural.test.ts`          | structural markers that mislabel, cut, or approximate what the parse tree says                                                                                                                               |
| `guards/repo-map.test.ts`            | a repo map that overruns its budget, reorders on rank ties, serves stale tags after an edit, or silently trusts a corrupt cache entry                                                                        |
| `guards/persistent-store.test.ts`    | a damaged blob handed back as a faithful retrieval, or retrieval counters that reset to zero on restart                                                                                                      |
| `guards/structural-totality.test.ts` | a language claimed by the planner with no fixture, snapshot or doc-comment case behind it                                                                                                                    |
| `guards/bench-results.test.ts`       | an edited or extrapolated results row, a network call in the offline tier, or `bench/` slipping into the tarball                                                                                             |
| `guards/init-wizard.test.ts`         | `smelt init` overwriting a hand-written file without an explicit per-file yes                                                                                                                                |
| `guards/hooks-preset.test.ts`        | a size threshold silently unwired from the config, or `smelt hooks install` clobbering another tool's config file without a yes                                                                              |
| `guards/planner-registry.test.ts`    | a strategy vanishing from the `PLANNERS` registry while the factory, the flag/config validation, or the help text still claims it                                                                            |
| `guards/packaging.test.ts`           | a tarball that fights strict consumers — a shipped `.d.ts` naming an ambient namespace, a sourcemap pointing at a `src/` that was never packed, or a `smelt_retrieve` schema strict mode refuses to register |
| Guard                                | If it silently stopped working                                                                                                                                                                               |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------                                                                        |
| `guards/no-network.test.ts`          | source leaving the machine — including from the CLI, a second front door                                                                                                                                     |
| `guards/reversibility.test.ts`       | `reconstruct()` returning almost-right text                                                                                                                                                                  |
| `guards/expansion-counter.test.ts`   | the expansion rate pinned at a flattering zero                                                                                                                                                               |
| `guards/marker-format.test.ts`       | the marker changing shape in everyone's prompts, with no error anywhere                                                                                                                                      |
| `guards/third-party.test.ts`         | a bundled grammar being redistributed with no licence notice                                                                                                                                                 |
| `guards/cache-hygiene.test.ts`       | cache hygiene quietly rewriting prompts, or a hit-rate claim reappearing                                                                                                                                     |
| `guards/structural.test.ts`          | structural markers that mislabel, cut, or approximate what the parse tree says                                                                                                                               |
| `guards/repo-map.test.ts`            | a repo map that overruns its budget, reorders on rank ties, serves stale tags after an edit, or silently trusts a corrupt cache entry                                                                        |
| `guards/persistent-store.test.ts`    | a damaged blob handed back as a faithful retrieval, or retrieval counters that reset to zero on restart                                                                                                      |
| `guards/structural-totality.test.ts` | a language claimed by the planner with no fixture, snapshot or doc-comment case behind it                                                                                                                    |
| `guards/bench-results.test.ts`       | an edited or extrapolated results row, a network call in the offline tier, or `bench/` slipping into the tarball                                                                                             |
| `guards/init-wizard.test.ts`         | `smelt init` overwriting a hand-written file without an explicit per-file yes                                                                                                                                |
| `guards/hooks-preset.test.ts`        | a size threshold silently unwired from the config, or `smelt hooks install` clobbering another tool's config file without a yes                                                                              |
| `guards/planner-registry.test.ts`    | a strategy vanishing from the `PLANNERS` registry while the factory, the flag/config validation, or the help text still claims it                                                                            |
| `guards/auto-strategy.test.ts`       | the `auto` strategy stamping its own name over the planner that ran, or degrading into a silent fallback when a grammar fails to load                                                                        |

## Two promises, not one

**Read this before you "clean up" the marker format.**

smelt makes two stability promises with different strengths, and the split is not
bureaucracy:

- **The wire surface a model sees is stable from 0.1 and treated as 1.0.** That is the
  marker format — `<<smelt/v1: … (412B) — retrieve("…")>>` — and the `smelt_retrieve`
  tool contract.
- **The TypeScript API is `0.x` and may move.** Renames and signature changes between
  minors are expected.

Why the wire surface is the strict one: **the marker goes into prompts.** Changing it
changes model behaviour downstream, in every consumer, and that manifests as _worse
output with no error anywhere_ — no exception, no failing test on their side, no line in
a log. It is not a normal API break. It is this project's signature failure mode shipped
as a version bump, which is precisely the thing smelt exists to refuse to do to people.

So the marker carries its own version **in band**, and `MARKER_FORMAT_VERSION` in
`src/apply.ts` is the single source of it. A future format is _additive and
identifiable_: `smelt/v2` markers can sit next to `smelt/v1` ones in a transcript and a
consumer parsing them can tell which is which. It is never a substitution.

`test/guards/marker-format.test.ts` enforces exactly that. It pins the rendered marker
per version, so the format cannot move unless the version moves; and it fails on a
version it does not know, so a new format has to arrive as a **new row, never an edit** —
old markers stay valid in caches, transcripts and other people's prompts forever.

If you need a different marker for your own use, pass `marker` to `createSmelter()`. That
is your format in your process, and nothing here is in your way.

## Publishing (a maintainer action)

**Do not publish by hand. Do not run `npm login`.** Publishing is a maintainer action,
not a contributor's and not an agent's — and since the publish workflow exists, it is
also not something a maintainer does at a keyboard: **a maintainer tags, and watches**.

**The ordering rule, and why it is a rule:** npm restricts unpublishing after **72
hours** — after that only `npm deprecate` remains. A publish is therefore effectively
permanent. So tag **after** the CLI actually runs on a real file on your machine, never
to "reserve the name".

Before pushing the tag:

- [ ] `pnpm verify` green on the commit you are about to tag — the workflow runs it
      again on that exact commit, and npm gets nothing from a red tick.
- [ ] `node packages/core/dist/cli/bin.js --version` prints the version in the
      manifest, and that binary smelts a real file. The workflow cannot judge "runs
      well"; you can.
- [ ] The version in both manifests is deliberate. `0.0.0` is the placeholder; the
      first real publish picks a number and lives with it.

Then: **push the tag.** `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow
(`.github/workflows/publish.yml`) verifies, builds, packs, publishes core then mcp from
the packed tarballs, computes the tarball sha256 it just served, and renders
`packaging/homebrew/smelt.rb` from those two facts. The MCP `workspace:^` publish guard
runs inside the pipeline — explicit, because publishing a packed tarball skips
lifecycle scripts, and 0.1.0 is the reason the guard exists.

One-time owner setup, and the tap:

1. Register each package's **trusted publisher** on npmjs.com (npmjs.com → the
   package → Settings → Trusted publishers → Add): repository owner `smeltjs`,
   repository name `smelt`, workflow filename `publish.yml`, environment `release` —
   once for `@smeltjs/core` and once for `@smeltjs/mcp`. No npm token is stored
   anywhere; the registry authenticates the publish job by its OIDC identity.
2. Create the tap repository `smeltjs/tap`, and seed it from the workflow's
   `homebrew-formula` artifact (or render locally:
   `node scripts/render-formula.mjs <version> <sha256>` — the same pair the workflow
   computed):

   ```sh
   brew tap-new smeltjs/tap
   cp packaging/homebrew/smelt.rb "$(brew --repository)/Library/Taps/smeltjs/homebrew-tap/Formula/smelt.rb"
   cd "$(brew --repository)/Library/Taps/smeltjs/homebrew-tap" && git add . && git commit -m "smelt 0.4.0" && git push
   ```

3. From then on: `brew install smeltjs/tap/smelt`, and a release is
   `brew upgrade smelt` on every machine — followed by `smelt doctor`, and `smelt
setup` if doctor names anything behind.

The workflow's formula artifact is deliberately not auto-committed: one token that can
push to two repositories is more write access than a formula is worth. The version
window the site advertises (site versions are read from the manifests, before npm is
checked) still applies — publish, then merge the bump; the gap is the length of that
window.

Files that carry the package name, should it ever need to change: `packages/core/package.json`,
`packages/core/README.md`, the root `README.md`, `CONTRIBUTING.md`, `docs/ARCHITECTURE.md`. The
CLI's binary name is `smelt` and is independent of the package name — it is defined once,
as `CLI_NAME` in `src/cli/args.ts`.

## The recorded failure: watching the zero-network guard go red

The mutation suite mechanises this forever, but the guard was first proven by hand, the
way any new guard should be: break a real code path, run it, read what it says, put it
back. Here is that transcript, verbatim.

**The break.** Added to `packages/core/src/plan/lexical.ts` — a module the guard reaches
from the entrypoint, on the elision path itself:

```diff
+import { request } from 'node:https';
+
 export function planLexical(input: PlanInput, options: LexicalPlannerOptions = {}): ElisionPlan {
+  // DELIBERATE LAW 1 VIOLATION — added to watch the guard fail, then removed.
+  void request;
+  void fetch('https://example.invalid/rerank', { method: 'POST' });
   const lines = splitLines(input.text);
```

**What it printed:**

```
$ pnpm --filter @smeltjs/core exec vitest run test/guards/no-network.test.ts

 RUN  v4.1.11 /Users/…/smelt/packages/core

 ❯ test/guards/no-network.test.ts (7 tests | 2 failed) 12ms
     × imports no network transport, anywhere in the graph 4ms
     × never touches a network global 4ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  test/guards/no-network.test.ts > Law 1 — zero network > imports no network transport, anywhere in the graph
AssertionError: Law 1 violation: smelt v1 makes zero network calls: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "plan/lexical.ts → node:https: \"node:https\" is a network transport",
+ ]

 ❯ test/guards/no-network.test.ts:148:78

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/2]⎯

 FAIL  test/guards/no-network.test.ts > Law 1 — zero network > never touches a network global
AssertionError: Law 1 violation: network-capable global in the elision path: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- []
+ [
+   "plan/lexical.ts references `fetch`",
+ ]

 ❯ test/guards/no-network.test.ts:172:87

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯

 Test Files  1 failed (1)
      Tests  2 failed | 5 passed (7)
   Duration  150ms
```

Two independent assertions caught it — the import walk and the global scan — and both
named the offending file. **Then the change was reverted and the guard went green again**
(7 passed), which is the other half of the exercise: a check that fails on clean source
is just as useless as one that passes on broken source.

That transcript is a recording, not a template: it is left byte-for-byte as it printed.
The walk has since moved into `packages/guard-kit` so both packages share it, which
renamed two of those assertions and moved their line numbers — the two failures, and
what they name, are unchanged.

Note what the run _does not_ say: nothing about `example.invalid` being unreachable, no
DNS error, no timeout. The guard is static. It fails on the _capability_, not on the
call succeeding — because a network call that fails in CI and succeeds on a user's
laptop is the worst possible outcome.

## Style

- **Every elision needs a sentence.** If you cannot write `explanation` for a rule in
  plain words — "collapsed 3 sibling functions" — the rule does not ship. That sentence
  is what the model reads and what a human reads in a diff.
- **Determinism.** Same input, same plan. No timestamps, no `Math.random`, no map
  iteration order leaking into output. Planners are pure functions of their input.
- **Comments explain _why_.** What the code does is visible; why it is allowed to do it,
  and what happens if someone changes it, is not.
- Conventional Commits.
- Bytes, not characters. Budgets, ranges and counters are UTF-8 bytes. `'🔥'.length` is
  2; it costs 4. Budgets are bytes **permanently** — the reasoning, including why there is
  no local Claude tokenizer and why a token budget silently retunes itself between model
  generations, is in [`docs/ARCHITECTURE.md` § "Design decisions"](docs/ARCHITECTURE.md#design-decisions).
  If you want a token count in the result, supply a `measure`; do not change the unit.
- **Never touch the marker format** without reading "Two promises, not one" above.

## Adding a language

1. Add the id to `LanguageId` in `src/types.ts`. The registry in `src/lang/registry.ts`
   is typed `Record<LanguageId, LanguageProfile>`, so this immediately fails to compile
   until you write the language's profile — the id list and the facts cannot drift.
2. Write the profile: one file, `src/lang/<id>.ts`, carrying every per-language fact —
   extensions, grammar `wasm`, `markerLeader`, the `structure` section (node kinds,
   pins, doc-comment attachment) and the `repomap` section. Register it in
   `LANGUAGE_PROFILES`. The extension map, `SUPPORTED_LANGUAGES`, `WASM_BY_LANGUAGE`,
   `STRUCTURAL_LANGUAGES`, the marker leaders and the repo-map tag tables are all
   derived from the registry — there is no second table to edit.
3. Add the grammar's entry to `packages/core/grammar-provenance.json` — the
   third-party guard pins its key set to the registry's wasm set, and the generator
   refuses an unattributed grammar.
4. `test/detect.test.ts` asserts a grammar resolves on disk for every language in
   `SUPPORTED_LANGUAGES`. It will fail until the grammar is real.
5. A profile with a `structure` section claims the language for the structural
   planner, so add a fixture proving a sibling collapse on it — the totality guard
   (`test/guards/structural-totality.test.ts`) fails until the fixture, snapshot and
   doc-comment case all exist.

## Opening a PR

Run `pnpm verify` first — it is the same gate CI runs. If you touched a user-facing
surface, say what you ran and what you saw; if you added a guard, paste the `pnpm mutate`
line showing it caught its mutation. "Tests pass" is not evidence that a _new_ check
works.
