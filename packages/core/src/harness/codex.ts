import type { HarnessHookSchema } from '../hooks/shim.ts';

import { MCP_RUN_ARGS } from '../setup/recipe.ts';
import type { ShimmedHarnessProfile } from './profile.ts';
import { SNIPPET_END_HASH, SNIPPET_START_HASH } from './snippet.ts';

/**
 * Codex CLI — VERIFIED tier. Schema, install and removal, end to end.
 *
 * Codex's experimental hooks (`features.hooks`, rust-v0.114.0+, on by default from
 * 0.150.1) deliberately mirror Claude Code's schema — the survey is
 * docs/research/2026-09-02-agent-enforcement.md § 3, primary source
 * <https://developers.openai.com/codex/hooks>:
 *
 *  - stdin: `{ tool_name, tool_input }`; shell input arrives as `tool_name: "Bash"`,
 *    `tool_input.command`.
 *  - deny: `hookSpecificOutput.permissionDecision: "deny"` + reason (or exit 2).
 *  - rewrite: `permissionDecision: "allow"` with `updatedInput` — for Bash,
 *    `updatedInput` **must include a string `command` field**, which the shared splice
 *    always does.
 *
 * Two documented differences from Claude Code, both honoured here:
 * `permissionDecision: "ask"` is NOT supported (a parse error — the tool proceeds),
 * and this schema never emits it; project-layer hooks only run once the project is
 * trusted, which the installer's output says out loud, and which the `[features]`
 * block below is what enables.
 */
const HOOKS: HarnessHookSchema = {
  readTools: ['Read'],
  bashTools: ['Bash', 'shell'],
  toolNameKeys: ['tool_name'],
  toolInputKeys: ['tool_input'],
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
        updatedInput: input,
      },
    }),
    announce: 'reason',
  },
};

/** The Codex `config.toml` block: enables the hooks feature, marker-bracketed. */
function codexConfigTomlBlock(): string {
  return `${SNIPPET_START_HASH}
# Enables Codex's hooks feature so .codex/hooks.json is honored. Project-level hooks
# run only once this project is trusted. Written by \`smelt hooks install\`.
[features]
hooks = true
${SNIPPET_END_HASH}
`;
}

// The registration's bytes come from the SetupRecipe's run command (MCP_RUN_ARGS,
// derived once beside the fact it comes from) — TOML per <https://developers.openai.com/codex/config-reference>,
// cross-checked against codex-rs's `McpServerTransportConfig::Stdio` struct (`command`,
// `args`, `env`), so the CLI command the README teaches and the file setup writes
// cannot disagree.

export const codex: ShimmedHarnessProfile = {
  id: 'codex',
  name: 'Codex CLI',
  shortName: 'Codex',
  tier: 'verified',
  detect: ['.codex'],
  detectHome: ['.codex'],
  instructionFile: 'AGENTS.md',
  // Verified 2026-09-09: `~/.codex/AGENTS.md` is loaded unconditionally by the
  // CodexHome user-instructions provider (codex-rs/codex-home/src/instructions), and
  // the User config layer's `.codex/` folder is where `hooks.json` is read from
  // (codex-rs/config/src/state.rs `hooks_config_folder`).
  userInstructionFile: '.codex/AGENTS.md',
  instructions: 'snippet',
  caveats: [
    'project-level Codex hooks run only once the project is trusted (features.hooks; see docs/research/2026-09-02-agent-enforcement.md § 3)',
  ],
  hooks: HOOKS,
  install: [
    {
      kind: 'json-hooks',
      file: '.codex/hooks.json',
      event: 'PreToolUse',
      matchers: ['Read', 'Bash'],
      entry: 'command-list',
      lifecycle: true,
      user: { file: '.codex/hooks.json' },
    },
    {
      kind: 'marker-block',
      file: '.codex/config.toml',
      user: { file: '.codex/config.toml' },
      block: codexConfigTomlBlock,
      start: SNIPPET_START_HASH,
      end: SNIPPET_END_HASH,
      skipWhen: {
        contains: '[features]',
        why: 'already has a [features] table — add `hooks = true` to it yourself',
      },
    },
    {
      kind: 'toml-mcp-registration',
      file: '.codex/config.toml',
      user: { file: '.codex/config.toml' },
      path: ['mcp_servers', 'smelt'],
      entry: () => ({ command: MCP_RUN_ARGS[0]!, args: MCP_RUN_ARGS.slice(1) }),
    },
  ],
};
