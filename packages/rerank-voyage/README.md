<div align="center">
<img src="../../assets/smelt-mark.svg" width="72" alt="" />
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

```sh
npm install @smeltjs/rerank-voyage
export VOYAGE_API_KEY=...
```

```json
{
  "smeltConfig": 1,
  "defaultBudgetBytes": 4000,
  "rerank": { "kind": "voyage", "model": "rerank-2.5", "apiKeyEnv": "VOYAGE_API_KEY", "topK": 8 }
}
```

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

What comes back is a relevance score per region; smelt spares the top `topK` from the
cut and reports what happened on its own report line:

```
rerank  voyage/rerank-2.5  (23 candidates, 8 kept)
```

A reranker here can only **spare** a region, never cause one to be cut — so the worst a
bad answer can do is cost you bytes, and bytes are already reported (`OVER BUDGET`, in
so many words).

## Wire contract

`POST https://api.voyageai.com/v1/rerank`, `Authorization: Bearer $VOYAGE_API_KEY`,
`{"query", "documents", "model", "top_k"}` in, `{"data": [{"index", "relevance_score"}],
"model", "usage"}` out. Verified against the live API on 2026-09-08 and against
[Voyage's reference](https://docs.voyageai.com/reference/reranker-api).

Requests are batched at Voyage's documented **maximum of 1,000 documents** per request,
scored candidates are sorted by score descending with **ties broken by original order**
(so one input gives one output), and each request is aborted after 30s by default —
`timeoutMs` if that is wrong for you. The API key rides in a header and is never echoed
into an error, a report or a receipt.

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
package's own tests run against a recorded fixture and touch the network exactly as
often as every other suite in the repository: never.

## Licence

Apache-2.0. See [LICENSE](./LICENSE).
