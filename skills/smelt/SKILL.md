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
- `npx @smeltjs/mcp` — register the MCP server with your harness
- `smelt <file> --budget 4000 --focus <focus>` — prove the round trip on a real file

## Setting up

    npm install -g @smeltjs/core
    smelt setup --yes [--harness <id>]... [--scope user] [--guard on|off] [--stats on|off]
      [--map on|off] [--lint on|off] [--no-mcp] [--json]

Nothing installed at all? `npx @smeltjs/core setup --yes [--harness <id>]... [--no-mcp] [--json]` runs the same recipe.

`smelt setup` applies the whole recipe idempotently — the config, the hooks preset for
the harnesses you name, the MCP registration step, and a real smelt → retrieve round trip
to prove the loop. A re-run on a current machine writes nothing and exits 0, so re-running
is always safe; `smelt hooks remove` takes the wiring back out.

- `--yes` answers every question up front. Without a terminal it is what makes the
  command runnable at all, so from CI or a hook use `smelt hooks install --yes`.
- `--harness <id>` is repeatable. The ids are: claude-code, codex, gemini, grok, hermes, cursor, opencode, cline, kilocode, aider.
- `--scope user` installs once for the machine — one config and one store for every
  project — instead of once per project, which is the default.
- The four toggles each take `on` or `off`; one you do not name keeps whatever is
  already installed.
- `--json` prints a receipt: every file, every check, and what the exit meant.

If you upgraded smelt (`brew upgrade smelt`, `npm update -g`), run
`smelt setup` again. The loop is: upgrade → `smelt doctor` → `smelt setup`.

## Checking the install

    smelt doctor [--scope user] [--json]

Doctor reads installed state and reports it; it writes nothing, ever, so it is always
safe to run. Each wired artifact comes back as one of three verdicts:

- **wired (verified)** — smelt ran the thing and it behaved as installed.
- **wired but inert** — it is on disk, but nothing loads or runs it.
- **wired but missing** — the wiring names a script that is not there.

Exit 0 means current, or nothing is installed. Exit 3 means something is
behind or broken, and the report names the exact repair command — `smelt setup`, per
harness. Run that; do not hand-edit the files doctor names.

## Keeping the store small

Nothing is ever evicted on its own: no timer, no size cap, nothing on opening a store.
Deleting elided bytes is one explicit command, and it refuses without an age you named.
Plan it first, then run it:

    smelt store prune --older-than 30d --dry-run
    smelt store prune --older-than 30d

Read the dry run before the real one. A pruned hash is gone, and a later
`smelt retrieve` on it refuses and says when it was pruned rather than pretending the
bytes were never there.

## Reranking

There is no default reranker and never will be. Nothing is loaded, imported or called
unless a `rerank` key in `smelt.config.json` says so:

    { "rerank": { "kind": "module", "path": "./smelt.rerank.ts" } }
    { "rerank": { "kind": "voyage", "apiKeyEnv": "<the variable holding your key>", "topK": 8 } }

`module` loads a stage of your own; `voyage` loads `@smeltjs/rerank-voyage`, a
separate package installed by hand. The environment variable read is the one your config
names — there is no key smelt reads that you did not write down. A stage may only spare
regions from the cut, never cut more, and a stage that throws is reported as the refusal
it is, never as a quiet unranked run.

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
