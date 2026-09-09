import type { HarnessHookSchema } from '../hooks/shim.ts';

import { MCP_RUN_ARGS, SETUP_RECIPE } from '../setup/recipe.ts';
import type { ShimmedHarnessProfile } from './profile.ts';

/**
 * Claude Code — VERIFIED tier. Schema, install and removal, end to end.
 *
 * Schema per <https://code.claude.com/docs/en/hooks> (verified 2026-09-02; the deep
 * dive is docs/research/2026-09-02-agent-enforcement.md § 1):
 *
 *  - stdin: `{ hook_event_name: "PreToolUse", tool_name, tool_input, cwd }`. For
 *    `Read`, `tool_input.file_path` is already absolute and `offset`/`limit` mark a
 *    windowed read; for `Bash`, `tool_input.command` is the full command string, and
 *    a relative path in it resolves against the payload's `cwd` — the *session's*
 *    working directory, which after the model `cd`s differs from the hook process's
 *    own cwd.
 *  - deny: `hookSpecificOutput.permissionDecision: "deny"` with
 *    `permissionDecisionReason` — which is **shown to the model**, so the guard's
 *    reason (the exact replacement command, the `smelt retrieve` contract) lands in
 *    the transcript as steering.
 *  - rewrite (opt-in, `hooks.enforcement: "rewrite"`): `updatedInput` replaces the
 *    entire input object of the *same* tool (v2.0.10+), so a Bash command can be
 *    substituted but a Read can never become a Bash call — Reads deny in every mode.
 */
const HOOKS: HarnessHookSchema = {
  readTools: ['Read'],
  bashTools: ['Bash'],
  toolNameKeys: ['tool_name'],
  toolInputKeys: ['tool_input'],
  cwdKey: 'cwd',
  deny: (reason) => ({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
  rewrite: {
    document: ({ input, announcement }) => ({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: announcement,
        // updatedInput replaces the whole input object — unchanged fields ride along.
        updatedInput: input,
      },
    }),
    announce: 'reason',
  },
};

// The registration's bytes come from the SetupRecipe's run command (MCP_RUN_ARGS,
// derived once beside the fact) — so the CLI command the README teaches and the file
// setup writes cannot disagree.

/**
 * Registration as Claude Code's CLI spells it — this harness's fact, composed from the
 * one command the recipe owns rather than retyped, so the verb a person is told to run
 * and the server smelt actually wires can never name different packages.
 *
 * `MCP_REGISTER_USER` is the same registration for the whole machine. Claude Code's
 * user scope is the top-level `mcpServers` key of `~/.claude.json` — a file Claude Code
 * owns and rewrites, and whose docs say to manage it through `/config` and this CLI
 * rather than by editing — so at user scope smelt prints this instead of writing a
 * byte. Verified 2026-09-09 against code.claude.com/docs/en/mcp and .../mcp-quickstart
 * ("Where servers are saved").
 *
 * Both lived in `SETUP_RECIPE.mcp` as though a `claude` verb were every harness's
 * registration; five renderings read them from there, and one of them printed this at
 * somebody wiring Codex. The recipe keeps `mcp.run` — true of every MCP client — and
 * the spelling belongs to the harness that reads it.
 */
const MCP_REGISTER = `claude mcp add smelt -- ${SETUP_RECIPE.mcp.run}`;

/** The same, for the whole machine. See {@link MCP_REGISTER}. */
const MCP_REGISTER_USER = `claude mcp add --scope user smelt -- ${SETUP_RECIPE.mcp.run}`;

export const claudeCode: ShimmedHarnessProfile = {
  id: 'claude-code',
  name: 'Claude Code',
  tier: 'verified',
  detect: ['.claude'],
  detectHome: ['.claude'],
  instructionFile: 'CLAUDE.md',
  // Verified 2026-09-09: `~/.claude/CLAUDE.md` is the user-scope memory file
  // (code.claude.com/docs/en/glossary, .../memory), and `~/.claude/settings.json` the
  // user settings file (.../settings-reference).
  userInstructionFile: '.claude/CLAUDE.md',
  instructions: 'snippet',
  // The registration, as a person performs it — Claude Code's own CLI verb, and its
  // `--scope user` spelling for the machine. Owned here, beside the step that writes
  // the same thing: this exact string had four owners once.
  mcp: { manual: MCP_REGISTER, manualUser: MCP_REGISTER_USER },
  caveats: [],
  hooks: HOOKS,
  install: [
    {
      kind: 'json-hooks',
      file: '.claude/settings.json',
      event: 'PreToolUse',
      matchers: ['Read', 'Bash'],
      entry: 'command-list',
      lifecycle: true,
      user: { file: '.claude/settings.json' },
    },
    {
      kind: 'mcp-registration',
      file: '.mcp.json',
      path: ['mcpServers', 'smelt'],
      entry: () => ({ command: MCP_RUN_ARGS[0], args: MCP_RUN_ARGS.slice(1) }),
      // `.mcp.json` is the *project* scope and is ours to merge into. The user scope
      // is the top-level `mcpServers` key of `~/.claude.json`, which Claude Code owns
      // and rewrites — so it is a printed command, checked read-only by doctor.
      user: { file: '.claude.json', manual: MCP_REGISTER_USER },
    },
  ],
};
