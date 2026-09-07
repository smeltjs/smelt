# smelt bench — results

Measured by `bench/run.mjs` on the committed corpus (`bench/corpus/`,
`bench/cases.json`). Every row states what was measured, on which date, at which
corpus commit, under which tier — and, for token and retrieval rows, on which model,
because those numbers are model-specific. Rows are **append-only**: a re-run, or a
run on a newer model, adds rows and never edits one — tokenizers shift between
model generations (`docs/ARCHITECTURE.md` § Decision 8), and an edit would rewrite history.

Units mean exactly what they say: `bytes` is UTF-8 bytes of the input and the
smelted output; `tokens` is Anthropic's `/v1/messages/count_tokens` for the text
as a single user message on the named model (tier 2); `elisions retrieved` is
distinct elisions the named model asked back via `smelt_retrieve` out of the
distinct elisions stored (tier 3), where retrieving everything is a LOSS. Nothing
here is extrapolated, rounded up, or converted between units.

## run 2026-09-01 — tier 1 — corpus c03abf27bd4a

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 14339 | 3264   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 1090  | 858    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| multi-file-grep | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-01 | c03abf27bd4a  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-01 — tier 1 — corpus 3613beb4b650

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 22530 | 3289   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 1090  | 858    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| multi-file-grep | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-01 | 3613beb4b650  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-01 — tier 1 — corpus 2a383919c632

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 30643 | 3289   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 1090  | 858    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 689   | 360    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-01 | 2a383919c632  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 052bd3be2ed7

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 38267 | 3295   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 052bd3be2ed7  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 23cda4d958df

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 38267 | 3295   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 23cda4d958df  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 031510948db6

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 22432 | 3281   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 031510948db6  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 2675775cb1e3

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 22432 | 3281   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 2675775cb1e3  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 1f65ab089364

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 22462 | 3680   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 1f65ab089364  | —     | bytes | 6984  | 108    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 916469e794aa

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 22462 | 3680   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 542   | 389    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 916469e794aa  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-02 — tier 1 — corpus 6be404f0c24d

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                      |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ----------------------------------------- |
| large-ts-file   | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 22462 | 3680   | 2        | budget 4000 B, structural/v1              |
| tsx-component   | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes    | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1               |
| multi-file-grep | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                 |
| stack-trace     | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 452   | 344    | 1        | budget 400 B, lexical/v1                  |
| build-log       | tier 1 | 2026-09-02 | 6be404f0c24d  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                  |

## run 2026-09-03 — tier 1 — corpus 8d700b307c09

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                       |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ------------------------------------------ |
| large-ts-file   | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 27889 | 9632   | 3        | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component   | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET  |
| java-classes    | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1                |
| multi-file-grep | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                  |
| stack-trace     | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 452   | 344    | 1        | budget 400 B, lexical/v1                   |
| build-log       | tier 1 | 2026-09-03 | 8d700b307c09  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                   |

## run 2026-09-03 — tier 1 — corpus 15b5543f5515

| case            | tier   | date       | corpus commit | model | unit  | input | output | elisions | note                                       |
| --------------- | ------ | ---------- | ------------- | ----- | ----- | ----- | ------ | -------- | ------------------------------------------ |
| large-ts-file   | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 31229 | 10866  | 3        | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component   | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 1090  | 861    | 1        | budget 700 B, structural/v1 — OVER BUDGET  |
| java-classes    | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 689   | 366    | 2        | budget 400 B, structural/v1                |
| multi-file-grep | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 6451  | 986    | 2        | budget 1500 B, lexical/v1                  |
| stack-trace     | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 452   | 344    | 1        | budget 400 B, lexical/v1                   |
| build-log       | tier 1 | 2026-09-03 | 15b5543f5515  | —     | bytes | 16354 | 109    | 1        | budget 800 B, lexical/v1                   |

### Reading `large-ts-file` across the last three runs

Its `input` column moved 22462 → 27889 → 31229, and its `output` 3680 → 9632 → 10866.
None of that is the planner behaving differently. `large-ts-file`'s corpus file _is_
`packages/core/src/plan/structural.ts`, materialized from the working tree and
sha256-pinned — so every commit that edits the structural planner also edits the thing
being measured, and the corpus-commit column is where that shows. Comparing two of
these tables as a before/after of one input reads a change that did not happen.

What the last two runs did change: the structural planner grew a budget rung, and it
fires on none of these six cases. Planning each structural case twice — once at its
declared budget, once at a budget nothing can exceed — gives byte-identical plans, so
the two rows marked OVER BUDGET (large-ts-file 10866/4000, tsx-component 861/700) are
the maximal-run pass alone, over budget with no profitable sub-run left to take. The
rung's own case is a 158-byte fixture in `test/structural.test.ts`; this corpus does not
exercise it, and a case that does is worth adding.

## run 2026-09-07 — tier 1 + 2 + 3 + 4 — corpus 10462aa46b8e

| case | tier | date | corpus commit | model | unit | input | output | elisions | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large-ts-file | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 31229 | 10866 | 3 | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 1090 | 861 | 1 | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 689 | 366 | 2 | budget 400 B, structural/v1 |
| multi-file-grep | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 6451 | 986 | 2 | budget 1500 B, lexical/v1 |
| stack-trace | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 452 | 344 | 1 | budget 400 B, lexical/v1 |
| build-log | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 16354 | 109 | 1 | budget 800 B, lexical/v1 |
| django-query-utils | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 13389 | 1697 | 2 | budget 4000 B, structural/v1 |
| sklearn-ridge | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 91082 | 31951 | 2 | budget 40000 B, structural/v1 |
| sympy-boolalg | tier 1 | 2026-09-07 | 10462aa46b8e | — | bytes | 114180 | 8151 | 4 | budget 10000 B, structural/v1 |
| large-ts-file | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 11768 | 4036 | 3 | count_tokens, text as one user message |
| tsx-component | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 429 | 353 | 1 | count_tokens, text as one user message |
| java-classes | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 256 | 172 | 2 | count_tokens, text as one user message |
| multi-file-grep | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 2835 | 426 | 2 | count_tokens, text as one user message |
| stack-trace | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 196 | 148 | 1 | count_tokens, text as one user message |
| build-log | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 9090 | 58 | 1 | count_tokens, text as one user message |
| django-query-utils | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 4534 | 577 | 2 | count_tokens, text as one user message |
| sklearn-ridge | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 34962 | 12365 | 2 | count_tokens, text as one user message |
| sympy-boolalg | tier 2 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | tokens | 45278 | 3561 | 4 | count_tokens, text as one user message |
| large-ts-file | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 3 | 3 | — | expansion rate 1.00, 3 calls — LOSS: the model retrieved everything back |
| tsx-component | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 1 | 1 | — | expansion rate 1.00, 1 calls — LOSS: the model retrieved everything back |
| java-classes | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 2 | 2 | — | expansion rate 1.00, 2 calls — LOSS: the model retrieved everything back |
| multi-file-grep | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 2 | 2 | — | expansion rate 1.00, 2 calls — LOSS: the model retrieved everything back |
| stack-trace | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 1 | 0 | — | expansion rate 0.00, 0 calls |
| build-log | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 1 | 1 | — | expansion rate 1.00, 1 calls — LOSS: the model retrieved everything back |
| django-query-utils | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 2 | 2 | — | expansion rate 1.00, 2 calls — LOSS: the model retrieved everything back |
| sklearn-ridge | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 2 | 2 | — | expansion rate 1.00, 2 calls — LOSS: the model retrieved everything back |
| sympy-boolalg | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 4 | 4 | — | expansion rate 1.00, 4 calls — LOSS: the model retrieved everything back |
| ALL CASES | tier 3 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | elisions retrieved | 18 | 17 | — | aggregate expansion rate 0.94 over 9 completed case(s) |
| large-ts-file | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 11820 | 4671 | 3 | raw 11820 in/1521 out · smelted 4671 in/1117 out · 0 retrieve(s) · verdict: tie |
| tsx-component | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 472 | 2300 | 1 | raw 472 in/701 out · smelted 2300 in/809 out · 1 retrieve(s) · verdict: tie |
| java-classes | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 296 | 2050 | 2 | raw 296 in/0 out · smelted 2050 in/739 out · 2 retrieve(s) · verdict: smelted better |
| multi-file-grep | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 2886 | 5091 | 2 | raw 2886 in/1087 out · smelted 5091 in/1649 out · 2 retrieve(s) · verdict: raw better |
| stack-trace | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 232 | 1748 | 1 | raw 232 in/603 out · smelted 1748 in/278 out · 1 retrieve(s) · verdict: tie |
| build-log | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 9138 | 10597 | 1 | raw 9138 in/786 out · smelted 10597 in/674 out · 1 retrieve(s) · verdict: raw better |
| django-query-utils | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 4584 | 1210 | 2 | raw 4584 in/968 out · smelted 1210 in/825 out · 0 retrieve(s) · verdict: tie |
| sklearn-ridge | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 35024 | 49082 | 2 | raw 35024 in/1893 out · smelted 49082 in/1746 out · 2 retrieve(s) · verdict: tie |
| sympy-boolalg | tier 4 | 2026-09-07 | 10462aa46b8e | claude-opus-5 | A/B judged | 45322 | 15024 | 4 | raw 45322 in/1356 out · smelted 15024 in/2009 out · 2 retrieve(s) · verdict: tie |

## run 2026-09-07 — tier 1 — corpus 226c91db4f95

| case | tier | date | corpus commit | model | unit | input | output | elisions | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large-ts-file | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 36204 | 11324 | 3 | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 1090 | 861 | 1 | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 689 | 366 | 2 | budget 400 B, structural/v1 |
| multi-file-grep | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 6451 | 986 | 2 | budget 1500 B, lexical/v1 |
| stack-trace | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 452 | 344 | 1 | budget 400 B, lexical/v1 |
| build-log | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 16354 | 109 | 1 | budget 800 B, lexical/v1 |
| django-query-utils | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 13389 | 1697 | 2 | budget 4000 B, structural/v1 |
| sklearn-ridge | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 91082 | 31951 | 2 | budget 40000 B, structural/v1 |
| sympy-boolalg | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 114180 | 8151 | 4 | budget 10000 B, structural/v1 |
| git-diff | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 4132 | 1516 | 7 | budget 1200 B, lexical/v1 — OVER BUDGET |
| json-tool-result | tier 1 | 2026-09-07 | 226c91db4f95 | — | bytes | 11447 | 2996 | 4 | budget 1500 B, lexical/v1 — OVER BUDGET |

## run 2026-09-07 — tier 1 — corpus 19b11585126f

| case | tier | date | corpus commit | model | unit | input | output | elisions | note |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| large-ts-file | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 35458 | 11324 | 3 | budget 4000 B, structural/v1 — OVER BUDGET |
| tsx-component | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 1090 | 861 | 1 | budget 700 B, structural/v1 — OVER BUDGET |
| java-classes | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 689 | 366 | 2 | budget 400 B, structural/v1 |
| multi-file-grep | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 6451 | 986 | 2 | budget 1500 B, lexical/v1 |
| stack-trace | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 452 | 344 | 1 | budget 400 B, lexical/v1 |
| build-log | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 16354 | 109 | 1 | budget 800 B, lexical/v1 |
| django-query-utils | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 13389 | 1697 | 2 | budget 4000 B, structural/v1 |
| sklearn-ridge | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 91082 | 31951 | 2 | budget 40000 B, structural/v1 |
| sympy-boolalg | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 114180 | 8151 | 4 | budget 10000 B, structural/v1 |
| git-diff | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 4132 | 4132 | 0 | budget 1200 B, diff/v1 — OVER BUDGET |
| json-tool-result | tier 1 | 2026-09-07 | 19b11585126f | — | bytes | 11447 | 3280 | 5 | budget 1500 B, json/v1 — OVER BUDGET |
