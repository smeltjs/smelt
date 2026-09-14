# smelt — the opt-in reranker

Part of the smelt skill; the root `SKILL.md` covers reading, retrieving and mapping.

There is no default reranker and never will be. Nothing is loaded, imported or called
unless a `rerank` key in `smelt.config.json` says so:

    { "rerank": { "kind": "module", "path": "./smelt.rerank.ts" } }
    { "rerank": { "kind": "voyage", "apiKeyEnv": "<the variable holding your key>", "topK": 8 } }

`module` loads a stage of your own; `voyage` loads `@smeltjs/rerank-voyage`, a
separate package installed by hand. The environment variable read is the one your config
names — there is no key smelt reads that you did not write down. A stage may only spare
regions from the cut, never cut more, and a stage that throws is reported as the refusal
it is, never as a quiet unranked run.

The adapter is looked for beside `smelt.config.json` first, smelt's own install
second — so at machine scope (`~/smelt.config.json`), install it there, not into
whatever project you happen to be standing in:

    npm install --prefix "$HOME" @smeltjs/rerank-voyage

`topK` is a cap under the budget, not a quantity: smelt walks what the stage returns
best score first and spares while the output still fits the budget, so a `topK` of 8 can
come back as 3 kept. The report line names the wall the walk hit, and the `--json`
receipt carries it as `result.rerank.stopped` (`budget`, `cap` or `exhausted`).
