# smelt bench — the measurement harness

Until this directory existed, Law 4 forbade smelt every number. This is the harness
that earns them: a committed corpus of real tool outputs, a runner, and an
append-only results file. It lives **outside `src/`** on purpose — it is not part of
the library, it ships in no tarball (`files` in `package.json` excludes it), and the
zero-network guard's walk of `src/` never sees it. Its tier 2/3 network calls are the
harness's own, made explicitly, from files nothing in the library can import.

## Running it

```sh
pnpm build        # the harness measures the built dist/
pnpm bench        # tier 1: bytes + elisions. Offline, deterministic, no key.
ANTHROPIC_API_KEY=… pnpm bench              # + tier 2: token counts (count_tokens, free)
ANTHROPIC_API_KEY=… pnpm bench -- --tier3   # + tier 3: expansion rate (PAID — run once, log committed)
ANTHROPIC_API_KEY=… pnpm bench -- --tier4   # + tier 4: answer-quality A/B (PAID — run once, log committed)
```

Rows land in [`RESULTS.md`](RESULTS.md), append-only. Tier 3 additionally writes a
retrieval log per case to `tier3-log/`, to be committed alongside its rows so the
expansion rate is checkable from a file rather than from trust. The log is the full
transcript — the initial prompt with the smelted text the model saw, every
assistant response, and every tool_result payload — because tier 3 is run once and
the committed file is the only evidence. A run cut off at the round cap while the
model was still calling tools is flagged `truncated` in its log, marked TRUNCATED
in its row, and excluded from the aggregate. Tier 4 writes the same full-transcript
log per case to `ab-log/`: both arms' conversations, the judge's call with both
answers in blind order, and the judge's reasons. `SMELT_BENCH_MODEL` overrides the
model (default `claude-opus-5`); every tier 2/3/4 row names the model it used,
because token counts are model-specific.

## The corpus, and where each file came from

Every entry is a real tool output or honestly labelled as derived; none is invented
to flatter the planner. Three entries are byte-exact source files from three large
OSS projects (django, sympy, scikit-learn) at pinned upstream commits — the corpus's
first files from outside this repository, real-world Python in the size range agents
actually open. `cases.json` declares each case's realistic task: the logical path,
the focus terms, and the byte budget an agent would have used.

| file                           | provenance                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corpus/structural.ts`         | materialized at run time from this repo's `packages/core/src/plan/structural.ts`, sha256-pinned by the committed `corpus/structural.ts.json` reference — a hash mismatch is refused, with instructions to re-pin                                                                                                                                                                                                                                                                                                                                                                                                           |
| `corpus/toolbar.tsx`           | the `MIXED_TSX` fixture from `packages/core/test/structural-fixtures.ts`, materialized to disk unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `corpus/request-handler.java`  | the `FUNCTIONS_JAVA` fixture from `packages/core/test/structural-fixtures.ts`, materialized to disk unchanged — the path through a prebuilt grammar                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `corpus/grep-elision.txt`      | real output of `grep -rn "elision" src` run in `packages/core`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `corpus/stack-trace.txt`       | stderr of `node -e "import('./dist/index.js').then(async (smelt) => { const store = new smelt.MemoryElisionStore(); store.put('const x = 1;\n'); store.retrieve('feedfacedeadbeef'); });"` after `pnpm build`, captured once in one working copy of this repo (one machine, one Node version), then the capture's absolute paths rewritten to the neutral root `/home/smelt/repo` — nothing else was altered. Frame numbers, the Node banner and the error text are verbatim from that run, and are specific to it: a re-run, even here, will not byte-match. The committed bytes are canonical, and tier 1 measures those |
| `corpus/build.log`             | generated by `bench/gen-build-log.mjs` from this repo's `pnpm-lock.yaml` — package names and versions are real, the cargo framing is synthetic and says so in the log's own header                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `corpus/django-query-utils.py` | `django/db/models/query_utils.py` from `django/django` at `c8eb9a7c451f7935a9eaafbb195acf2aa9fa867d` (tag 4.1), fetched 2026-09-06, BSD-3-Clause — byte-exact, sha256 in `cases.json`                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `corpus/sklearn-ridge.py`      | `sklearn/linear_model/_ridge.py` from `scikit-learn/scikit-learn` at `093e0cf14aff026cca6097e8c42f83b735d26358` (tag 1.3.2), fetched 2026-09-06, BSD-3-Clause — byte-exact, sha256 in `cases.json`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `corpus/sympy-boolalg.py`      | `sympy/logic/boolalg.py` from `sympy/sympy` at `8059df7394f648bf4be5a51752e6d343003c92e6` (tag sympy-1.12), fetched 2026-09-06, BSD (see LICENSE at that commit) — byte-exact, sha256 in `cases.json`                                                                                                                                                                                                                                                                                                                                                                                                                      |

The corpus is committed, so a stranger reproduces tier 1 exactly from a fresh clone.
Changing a corpus file changes the corpus commit every subsequent row names; the
runner refuses to run against uncommitted corpus **or `src/`** changes, and against
a `dist/` older than `src/` — a row measured from edited or stale code names a
commit that cannot reproduce its numbers.

One entry is committed **by reference** instead of as bytes: `corpus/structural.ts`
mirrors this repository's own source, so a byte-copy would be a second copy that
drifts. Its committed artefact is `corpus/structural.ts.json` — the source path and
its pinned sha256 — and the runner materializes the real file from the working tree
before validating cases. When the source has moved since the pin, the runner
**refuses** and says to update the pinned hash; that refusal is the provenance
discipline that used to be the byte-copy guard. The materialized file is gitignored;
the reference lives under `corpus/`, so the corpus commit in every row covers it,
and `test/bench.test.ts` keeps the pin honest at `pnpm test` time.

## The tiers (`docs/ARCHITECTURE.md` § Decision 8)

| tier | reports                                      | cost | key  | reproducible by          |
| ---- | -------------------------------------------- | ---- | ---- | ------------------------ |
| 1    | bytes + elision counts                       | none | none | any contributor, offline |
| 2    | token counts via `count_tokens`              | free | any  | anyone with a key        |
| 3    | expansion rate — real `smelt_retrieve` calls | paid | any  | anyone, from the log     |
| 4    | answer-quality A/B — raw vs smelted, judged  | paid | any  | anyone, from the log     |

Tier 3 reports a case where the model retrieved every elision back as a **LOSS**:
the elision saved nothing and cost a round trip. There is no threshold below that —
see `docs/ARCHITECTURE.md` § Decision 4.

Tier 4 asks each case's `abQuestion` twice — once against the raw blob (no tools),
once against the smelted one with `smelt_retrieve` wired — records both arms' token
usage from the API's own usage fields, and asks a judge (the same named model,
temperature 0, the raw blob as reference) which answer is better through a tool
call. The answers reach the judge blind (`answer_1`/`answer_2`, order reversing on
odd case indices), a verdict that does not parse is **UNJUDGED** rather than
guessed, and a smelted arm cut off at the round cap claims no verdict. The verdict
is a model's opinion — an instrument reading, which is why the log with the judge's
reasons is committed beside the row. A tier-4 row's `input` column is the raw arm's
summed input tokens and its `output` column the smelted arm's; the note carries
both arms' full usage, the retrieve count, and the verdict.

## What this harness refuses to do

- Convert bytes to tokens with a fudge factor. Tokens come from `count_tokens` or
  they do not appear.
- Print a number without its date, corpus commit, and tier — or a token/retrieval
  number without its model.
- Edit an existing row. Re-runs append.
- Publish a verdict the judge did not make through its tool, or any verdict at all
  for an arm that was cut off mid-task.
- Say "up to", or anything about cache hit rates.

`test/guards/bench-results.test.ts` enforces the shape of `RESULTS.md`, the network
confinement to `tier2.mjs`/`tier3.mjs` (including that non-tier modules spawn no
subprocess other than a literal `git` — a spawned `curl` reaches the wire without
any network shape appearing in the file), and that `bench/` never enters the
published `files` list; `pnpm mutate` proves each of those can go red.
