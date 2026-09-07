---
name: smelt
description: Shrink oversized files and tool output before they hit your context window — structure-aware, reversible, offline. Use when a file, log, grep result, diff or stack trace is too big to read raw — smelt keeps the parts the task needs and replaces the rest with one-line markers you can retrieve by hash.
---

# smelt

smelt keeps large tool output out of your context window, reversibly: the parts the
task needs survive, everything else becomes one line saying what was removed, how big
it was, and a hash to get it back. It makes zero network calls.

## Reading big files

Instead of reading a large file raw:

    smelt <file> --budget 4000 --focus <what you are looking for>

Repeat `--focus` once per term. Focused regions survive verbatim; the rest collapses
into one-line markers. The budget is a soft ceiling in bytes.

## Retrieving what was cut

Every marker ends in `retrieve("hash")`. The exact original bytes come back from:

    smelt retrieve <hash>

Retrievals are counted, and `smelt stats` reports the expansion rate — the honest
signal of over-pruning. Retrieve what you actually need.

## Orienting in an unfamiliar tree

    smelt map <dir> --budget 4000

prints a ranked symbol map of the repository. The budget is met by construction.

## If a guard denies a raw read

This project may run a smelt guard hook: raw reads over a size threshold are denied,
and the denial names the exact `smelt` replacement command. Run that command, then
`smelt retrieve` any marker you need expanded. The deny teaches the replacement —
that pairing is the design, not an obstacle.

## Step by step (when `setup` is unavailable on an older install)

- `npm install -g @smeltjs/core` — install the CLI
- `smelt init` — write smelt.config.json
- `smelt hooks install` — wire the hooks preset
- `claude mcp add smelt -- npx @smeltjs/mcp` — register the MCP server
- `smelt <file> --budget 4000 --focus <focus>` — prove the round trip on a real file

## Installing, updating, repairing

    npm install -g @smeltjs/core
    npx @smeltjs/core setup --yes [--harness <id>]... [--no-mcp] [--json]

`smelt setup` applies the whole recipe idempotently — a re-run on a current machine
writes nothing and exits 0. `smelt doctor` reads installed state and names exactly
what is behind and what to run; `smelt hooks remove` takes the wiring back out.

## MCP

If the project registers smelt over MCP, five tools exist: `smelt_file` (shrink a
file under a byte budget with a focus), `repo_map` (a ranked whole-tree symbol map),
`smelt_retrieve` (elided bytes back by hash), `smelt_retrieve_batch` (several
hashes back in one call — prefer it when more than one marker matters, because every
call re-bills the conversation) and `smelt_stats` (retrieval counters). The
config's store is shared with the CLI, so a hash a marker gave you is the same hash
either surface retrieves.

## Notes

- Zero network calls, ever — a test in smelt's own suite fails if that could change.
- The wire surface (the marker format, the tool contracts) is stable from 0.1.
- This skill complements the marker-block instructions that `smelt hooks install`
  writes beside the enforcement hooks. If both are present, they teach the same
  commands from the same recipe; if only this skill is present, nothing is enforced —
  the discipline above is yours to follow.
