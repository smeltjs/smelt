# @smeltjs/core

Structure-aware, reversible context optimization for coding agents. Zero network calls.

This is the library package. The project README, the four laws and their reasoning, the
architecture and the consumer contract all live in the repository root:
**https://github.com/smeltjs/smelt**

```ts
import { createSmelter } from '@smeltjs/core';

const smelter = createSmelter({ defaultBudgetBytes: 8_000 });

const result = await smelter.smelt(toolOutput, {
  path: 'src/server.ts',
  focus: ['handleRequest'],
  budgetBytes: 4_000,
});

result.text; // send this to the model
smelter.tool; // the `smelt_retrieve` tool that gives it the rest back
smelter.stats().expansionRate; // whether you cut too much
```

There is also a CLI, installed as `smelt` (or run via `npx @smeltjs/core`):

```sh
smelt src/server.ts --budget 4000 --focus handleRequest   # text on stdout, report on stderr
smelt --budget 4000 --focus TypeError < build.log
smelt --strategy structural src/api.ts --budget 4000       # parse-tree collapse for code
smelt --reconstruct result.json                            # the round trip, from a shell
smelt init                                                 # the setup wizard: defaults, back-navigation, smelt.config.json
```

**Budgets are UTF-8 bytes, permanently** — the only unit computable locally for every
model, which is what makes the zero-network guarantee possible. Pass a `measure` if you
want a token count in the result as well; the budget stays bytes.

**Two stability promises.** The marker format (`<<smelt/v1: … >>`) and the
`smelt_retrieve` tool name are stable from 0.1 and treated as 1.0, because markers go into
prompts and a silent change to one shows up as worse model output with no error anywhere.
The TypeScript API is `0.x` and may move.

The parsers ship inside this tarball — no native build step, no post-install download.
That makes smelt a redistributor, so [`THIRD-PARTY.md`](./THIRD-PARTY.md) carries the
licences, generated from package metadata rather than written by hand.

**0.x.** In the box: structural planning (tree-sitter, with signatures and doc comments
always kept), the lexical planner, a persistent content-addressed store, cache-prefix
hygiene (detect, never rewrite), a repo-map planner modelled on Aider's, and a committed
measurement harness. An unsupported language under `strategy: 'structural'` is refused,
never approximated.

The CLI that goes with it: `smelt setup` wires the whole recipe into the harnesses you
use in one command (`--yes` for an agent, no terminal needed); `smelt doctor` reads that
install back and **runs** the hooks it finds, so `wired` is a fact about behaviour rather
than about text; both take `--scope project|user`, and a machine install goes to each
harness's own documented user-level location; `smelt store prune` is the only eviction
there is — explicit, journalled before it deletes, reported blob by blob; `smelt init`
writes the config; and a `rerank` block in that config is the one opt-in that can send
context off the machine, so nothing loads without it and `smelt doctor` says whether it
is configured and whether its key variable is set. See
[`docs/ARCHITECTURE.md`](https://github.com/smeltjs/smelt/blob/main/docs/ARCHITECTURE.md).

Apache-2.0.
