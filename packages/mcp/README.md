<div align="center">
<img src="../../assets/smelt-mark.svg" width="72" alt="" />
</div>

# @smeltjs/mcp

**The [smelt](https://github.com/smeltjs/smelt) MCP server** — structure-aware,
reversible, offline context optimization as five tools over stdio. A resident process
wrapping [`@smeltjs/core`](https://www.npmjs.com/package/@smeltjs/core), so the
tree-sitter grammar cache is paid once per session instead of once per command.

**stdio-local, zero network.** The one dependency beyond the core is the official
`@modelcontextprotocol/sdk`, and only its stdio transport: the SDK's HTTP/SSE transports
never enter this package's import graph, and a guard
(`test/guards/no-network.test.ts`) pins the exact SDK subpaths the source may touch —
mutation-tested like every other guarantee in this repository.

## The five tools

| Tool                   | In                                                       | Out                                                                                                                                                               |
| ---------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smelt_file`           | `path` _or_ `text`, `budgetBytes`, `focus?`, `strategy?` | The smelted text, then a report of every elision (rule, lines, bytes, hash, explanation, and for structural cuts the names of the declarations behind the marker) |
| `smelt_retrieve`       | `hash` (from a marker's `retrieve("hash")`)              | The exact original bytes, verbatim. **Counted** — this is the expansion rate moving                                                                               |
| `smelt_retrieve_batch` | `hashes` (several, in one call)                          | One text block per hash, in order: a first line naming the hash and its size, then the exact bytes. Each hit **counted** exactly as a single call would count it  |
| `repo_map`             | `dir`, `budgetBytes`, `focus?`                           | A ranked symbol map of the tree, fitted to the budget by construction (modelled on Aider's repo map)                                                              |
| `smelt_stats`          | —                                                        | The store's `RetrieveStats`, verbatim JSON. An **uncounted** read: watching the counters never moves them                                                         |

`smelt_retrieve_batch` exists because of a measured cost, not a convenience: every tool
call is a new request and input tokens are billed per request, so a model expanding
eighteen markers one call at a time re-bills its whole transcript eighteen times (tier 4
of the bench saw the smelted arm's summed input exceed the raw arm's on five of nine
cases for exactly this reason). One request for eighteen blocks changes what that costs
and nothing about what the expansion rate means — `smelt_retrieve` is the frozen wire
surface and stays byte-identical beside it.

Every elided region leaves a one-line marker in band:

```
<<smelt/v1: collapsed 3 sibling functions (2224B) — retrieve("84998967370f38bc")>>
```

The server's `instructions` field tells the model the one thing it could not infer:
that a marker's `retrieve("hash")` maps to the `smelt_retrieve` tool. The marker format
and the `smelt_retrieve` contract are the frozen wire surface — stable from 0.1,
treated as 1.0.

## Wiring it into a harness

`smelt setup` and `smelt hooks install` write this registration automatically for
Claude Code, opencode, Codex and Grok — JSON or TOML, whichever the harness reads,
byte-faithfully beside any servers you already registered. The commands below are the
manual reference: what gets written, and how to wire it by hand into any other client.
Per-harness mechanisms surveyed against primary sources in
[`docs/research/2026-09-02-harness-capability-matrix.md`](../../docs/research/2026-09-02-harness-capability-matrix.md);
each snippet below is labelled with the doc that owns it.

### Claude Code

```sh
claude mcp add smelt -- npx @smeltjs/mcp
```

### Codex CLI

`[mcp_servers.<name>]` TOML in `~/.codex/config.toml` — per Codex's config reference
(<https://developers.openai.com/codex/config-reference>, cross-checked against the
`McpServerTransportConfig::Stdio` struct in
[`codex-rs/config/src/mcp_types.rs`](https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs),
verified 2026-09-08):

```toml
[mcp_servers.smelt]
command = "npx"
args = ["@smeltjs/mcp"]
```

### Grok CLI

Same TOML dialect, in Grok's settings — per xAI's settings reference
(<https://docs.x.ai/build/settings/reference>, verified 2026-09-08; official CLI =
`xai-org/grok-build`):

```toml
[mcp_servers.smelt]
command = "npx"
args = ["@smeltjs/mcp"]
```

Any other MCP client: the server is a plain stdio server — `npx @smeltjs/mcp`, run
from the project directory.

## One store with the CLI

The server discovers `smelt.config.json` exactly as the `smelt` CLI does — walking up
from the directory it was launched in, using the core's own exported config machinery —
so a directory store configured once serves both:

```sh
npx @smeltjs/core init      # choose a directory store
```

```json
{ "smeltConfig": 1, "store": { "kind": "directory", "path": ".smelt/store" } }
```

With that in place, a marker minted by `smelt_file` can be cashed in by
`smelt retrieve <hash>` from a shell — and vice versa — and both move the same
counters, so `smelt_stats` and `smelt stats` report one honest expansion rate for the
whole session.

**No config?** The server runs on an in-memory store: `smelt_file` → `smelt_retrieve`
works for the lifetime of the server process, but nothing survives a restart. An
unknown-hash error on a memory store says exactly that, and how to fix it. A malformed
`smelt.config.json` refuses startup loudly — a config silently skipped would be a
setting you believed was in force. The config's `strategy` is honored as the default
planner; an explicit `strategy` argument wins, same precedence as the CLI's flags.

## Requirements

- **Node** `^20.19 || >=22.12` — the same floor as `@smeltjs/core`.
- Nothing else. No key, no service, no network: everything runs on your machine, and a
  mutation-tested guard fails the build if any module in this package could reach the
  wire.

## License

[Apache-2.0](./LICENSE).
