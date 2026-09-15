---
name: smelt
description: Use when a file, log, diff or grep result is too big to read raw, or when a marker's retrieve("hash") needs expanding — smelt keeps what the task needs and makes the rest retrievable.
---

# smelt

smelt keeps large tool output out of your context window, reversibly: what the task
needs survives; everything else becomes one line naming what was removed, its size, and
a hash to get it back. It makes zero network calls.

## Reading big files

Instead of reading a large file raw:

    smelt <file> --budget 4000 --focus <what you are looking for>

Repeat `--focus` once per term. Focused regions survive verbatim; the rest collapses
into one-line markers. The budget is a soft ceiling in bytes.

## Retrieving what was cut

Every marker ends in `retrieve("hash")`. The exact original bytes come back from:

    smelt retrieve <hash>

Retrievals are counted; `smelt stats` reports the expansion rate. Retrieve what you
actually need.

## Orienting in an unfamiliar tree

    smelt map <dir> --budget 4000

prints a ranked symbol map of the repository, fitted to the budget by construction.

## If a guard denies a raw read

Run the exact `smelt` replacement command the denial names, then `smelt retrieve` any
marker you need expanded. The deny teaches the replacement.

## MCP

Over MCP the same loop is five tools: `smelt_file`, `smelt_retrieve`,
`smelt_retrieve_batch` (several hashes in one call — prefer it when more than one marker
matters), `repo_map` and `smelt_stats`. The store is shared with the CLI.

## Operator workflows — read only the one for the job at hand

- [references/setup.md](references/setup.md) — install, `smelt setup`, `smelt doctor`, upgrading.
- [references/store.md](references/store.md) — `smelt store prune` and the retention cut-off.
- [references/rerank.md](references/rerank.md) — the opt-in reranker and its adapter.

This skill enforces nothing by itself; the marker block `smelt setup` writes beside the
hooks teaches the same commands from the same recipe.
