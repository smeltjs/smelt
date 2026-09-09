<div align="center">
<img src="https://raw.githubusercontent.com/smeltjs/smelt/main/assets/smelt-mark.svg" width="72" alt="" />
</div>

# @smeltjs/rerank-voyage

**The opt-in [Voyage AI](https://docs.voyageai.com/docs/reranker) reranker adapter for
[smelt](https://github.com/smeltjs/smelt).**

> ⚠️ **This package makes network calls.** It is the only package in the smelt workspace
> that does, and that is the whole reason it is a separate package rather than a module
> in `@smeltjs/core`.

`@smeltjs/core` and `@smeltjs/mcp` reach nothing outside your machine, and their Law 1
guards walk the real import graph on every run of `pnpm verify` to prove it — including
a ruling that classifies **this package's name as a forbidden import**, so neither of
them can ever come to depend on it. The only way your source reaches Voyage is that you
installed this package yourself and wrote a `rerank` block into your own
`smelt.config.json`. There is no default reranker, no `SMELT_RERANK_API_KEY`, and no
environment variable this package reads on its own.

## Install and configure

Install it **beside the `smelt.config.json` that asks for it**: smelt looks in that
file's own directory first and in its own install second, so a `~/smelt.config.json`
works with a `smelt` from Homebrew or `npm -g`.

```sh
npm install @smeltjs/rerank-voyage                  # config at your project root
npm install --prefix ~ @smeltjs/rerank-voyage       # config at ~/smelt.config.json
export VOYAGE_API_KEY=...
```

If it is in neither place, smelt refuses and names both directories and the exact
command for yours.

```json
{
  "smeltConfig": 1,
  "defaultBudgetBytes": 4000,
  "rerank": { "kind": "voyage", "model": "rerank-2.5", "apiKeyEnv": "VOYAGE_API_KEY", "topK": 8 }
}
```

### The adapter contract: `default` or `require`

smelt asks where an adapter is with `createRequire(...).resolve()`, so **an adapter's
`exports` map must reach its entry under a `default` or a `require` condition** — this
package states `default`, and any adapter written against the same seam should. A package
that exports only an `import` condition is _installed and unreachable_, which smelt
reports as exactly that rather than telling you to install it again. A dual package
resolves to its `require` entry, so an adapter whose two builds differ in behaviour has
to say so here.

`smelt init` writes that block for you if you answer `voyage` at the reranker step, and
`smelt doctor` tells you whether `VOYAGE_API_KEY` is set (presence only — never the
value). `topK` has no default: it decides how much of your context survives, and a
number smelt invented would decide that for you.

## What it sends, exactly

When a planner has decided which regions to remove, smelt asks the stage which of them
the task actually needs. So each request carries:

- **the query** — your `--focus` terms, joined;
- **the documents** — the text of the regions **the planner already decided to cut**.
  Never the whole file, and never the regions that survive.

What comes back is a relevance score per region. **What this stage returns is what smelt
spares** — not a ranking of everything it was given — so `topK` is the whole of the
cut-off, and it is required for that reason: returning every candidate would spare every
candidate, leaving the output equal to the input on a run that exits 0. smelt reports
what happened on its own report line:

```
rerank  voyage/rerank-2.5  (23 candidates, 8 kept)
```

A reranker here can only **spare** a region, never cause one to be cut — so the worst a
bad answer can do is cost you bytes, and bytes are already reported (`OVER BUDGET`, in
so many words).

## Wire contract

`POST https://api.voyageai.com/v1/rerank`, `Authorization: Bearer $VOYAGE_API_KEY`,
`{"query", "documents", "model", "top_k"}` in, `{"data": [{"index", "relevance_score"}],
"model", "usage"}` out.

**Transcribed from [Voyage's published reference](https://docs.voyageai.com/reference/reranker-api)
(read 2026-09-08), and not exercised against the live API from this repository.** No
request has left a machine in this package's history, and the test fixture is a
hand-written transcription of the documented response shape rather than a recording of a
real one. The strict validation below is the consequence: if the documented shape and
the real one have diverged, you will get an error naming the offending entry rather than
a plan that quietly kept the wrong regions.

Requests are batched at Voyage's documented **maximum of 1,000 documents** per request,
scored candidates are sorted by score descending with **ties broken by original order**
(so one input gives one output), and a response is refused rather than half-read when an
`index` is out of range or repeated, or a `relevance_score` is not finite.

**The 30s timeout is per request, not per call.** A candidate set larger than 1,000 is
split into batches and each batch gets its own budget, so N batches can take up to N ×
`timeoutMs`. Cap `topK` and your candidate set, or wrap the call in your own deadline, if
you need a ceiling on the whole thing.

The API key rides in a header and is never echoed into an error, a report or a receipt.

## Using it directly

```ts
import { createVoyageRerankStage } from '@smeltjs/rerank-voyage';
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({
  defaultBudgetBytes: 4_000,
  rerank: createVoyageRerankStage({
    apiKey: process.env.VOYAGE_API_KEY!,
    model: 'rerank-2.5',
    topK: 8,
  }),
});
```

`fetch` is injectable (`createVoyageRerankStage({ ..., fetch })`), which is how this
package's own tests run against the transcribed fixture and touch the network exactly as
often as every other suite in the repository: never.

## Licence

Apache-2.0. See [LICENSE](./LICENSE).
