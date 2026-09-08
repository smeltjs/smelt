# A reranker is an explicit config opt-in, never a default

This reopens one line of "Explicitly out of scope" and no more. `RerankStage` stays a
seam and smelt still bundles no reranker: with no `rerank` key in `smelt.config.json`,
nothing is loaded, nothing is imported and nothing is called — which is what every
default install does. What changes is that a consumer can now say _yes, this adapter,
under this key_ in a file they wrote, instead of only in code they wrote. The original
ruling refused a default, an env-var switch and a bundled adapter; all three stay
refused. There is no `SMELT_RERANK_API_KEY`, the adapter (`@smeltjs/rerank-voyage`) is a
separate package the consumer installs, and every refusal names the thing that is
missing rather than falling back to an unranked run.

Law 1 is not reopened. The adapter reaches the network, so it is named in
`net/policy.ts` as **data** and loaded through a computed specifier — and both
zero-network guards classify any _import_ of that name as forbidden, with mutations
proving each half goes red. `smelt doctor` reports the opt-in and whether its named
environment variable is set (presence only, never the value), so "does this machine talk
to anyone?" stays answerable from pure shell.

## Considered Options

- **Nothing (the pre-existing ruling)** (rejected): the seam existed and nothing could
  reach it. `smelt init` wrote a `smelt.rerank.ts` stub that no code path loaded, which
  is worse than refusing outright — a feature the user watched themselves configure.
- **A bundled adapter with an env-var switch** (rejected, again): "zero network unless
  an environment variable is set" is not the claim, and an env var is a switch nobody
  writes down.
- **A config key plus a separately-installed adapter package** (chosen): the opt-in is a
  line in the consumer's own repository, the network client is a package they chose to
  install, and the guards can still prove the default graph is clean.
