# The barrel exports what is documented, consumed, reachable or reasoned — and nothing else

`packages/core/src/index.ts` is the whole of `@smeltjs/core`'s public surface: the one
entry the package's `exports` map points a consumer at. Before this decision it
re-exported about 280 names, of which the documented consumer contract used about a
dozen and the two workspace consumers named nine plus the operations seam. Seventy-odd
names had no consumer anywhere — the receipt shapes of `smelt doctor`, the PageRank
constants, the store's on-disk format tag — and four were dead: a type nothing
referenced, an interface whose only adapter threw, a cache reset only tests called.
Every one of them was a promise the `0.x` API had made by accident and would one day
have to break on purpose.

The rule, from here on: **a name is exported from the barrel when, and only when, it
is one of these four things.**

1. **Documented.** Named in the README, `docs/ARCHITECTURE.md`, `docs/SETUP.md` or a
   package README. Writing a name into the docs is what makes it a promise, so the docs
   are the first authority.
2. **Consumed.** Imported from `@smeltjs/core` by a workspace package (`@smeltjs/mcp`,
   `@smeltjs/rerank-voyage`) or read off the barrel by a generator the repository runs
   (`scripts/*.mjs`, `site/scripts/*.mjs`). A consumer that builds is a fact, not an
   opinion.
3. **Reachable.** A type that appears in the signature of anything public under 1, 2
   or 4 — the options a public function takes, the receipt it returns, the fields of
   that receipt. A consumer who can call `buildRepoMap` can name `RepoMapOptions`, or
   the export is a promise with a hole in it.
4. **Reasoned.** Listed by name in `test/guards/public-surface.test.ts` under a
   one-line reason a reader can check: the built-in planners a consumer composes with
   `createSmelter({ planner })`, the `--json` envelopes the README says to parse, the
   rule ids a consumer switches on, the zero-network policy as data.

Everything else is un-exported, and the guard holds the line in both directions: a
barrel export that fits none of the four is red, and a consumed name the barrel no
longer carries is red. Reachability is computed over the emitted declaration files
(`dist/**/*.d.ts`), which is why the guard runs after the build like the README's
transcript guard does — TypeScript 7 ships no programmatic checker to ask instead.

## Considered Options

- **Export everything, as before** (rejected): every internal that leaks becomes a
  compatibility promise, and `0.x` is the only time removing one costs a minor rather
  than a major. Waiting makes the same cut more expensive on every release.
- **Export only the documented contract** (rejected): the operations seam and the
  setup recipe are consumed by the MCP server and the site without a sentence of
  consumer-facing prose each, and a rule that forces prose for every consumed name
  produces prose written to satisfy a guard.
- **A hand-written allowlist alone** (rejected): the list would restate what the docs
  and the consumers already say, and a restated fact drifts. The list is kept for the
  one clause — a reasoned keep — that no other artefact can witness.
- **The four clauses, guard-enforced** (chosen): three of them are read from artefacts
  that exist for other reasons, the fourth is short and carries its reasons, and the
  guard makes the next accidental export a red test rather than a future breaking
  release.

## Consequences

- `0.10.0` removes the names listed under Changed in the CHANGELOG. None was documented,
  none was consumed in this workspace, and each is still importable from its module
  path by anyone vendoring the source — the barrel is the API, the modules are not.
- `Reconstructor`, `DistillStage`, `unconfiguredDistillStage` and `clearGrammarCache`
  are deleted, not un-exported. The distillation stage's shape is now written down in
  `docs/ARCHITECTURE.md` § "Explicitly out of scope" as prose, which is where a shape
  nobody may fill in quietly belongs; an exported interface was an invitation.
- Adding an export now means one of: documenting it, consuming it, making it reachable,
  or writing its reason next to its name. The guard's failure message says which.
