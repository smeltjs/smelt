# smelt — setting up and checking the install

Part of the smelt skill; the root `SKILL.md` covers reading, retrieving and mapping.

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

## Step by step (when `setup` is unavailable on an older install)

- `npm install -g @smeltjs/core` — install the CLI
- `smelt init` — write smelt.config.json
- `smelt hooks install` — wire the hooks preset
- `npx @smeltjs/mcp` — register the MCP server with your harness
- `smelt <file> --budget 4000 --focus <focus>` — prove the round trip on a real file

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

## Notes

- Zero network calls, ever — a test in smelt's own suite fails if that could change.
- The wire surface (the marker format, the tool contracts) is stable from 0.1.
