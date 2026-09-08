import type { HarnessHookSchema } from '../hooks/shim.ts';

import type { ShimmedHarnessProfile } from './profile.ts';

/**
 * Cursor — EXPERIMENTAL tier. Schema, install and removal, end to end.
 *
 * Schema mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Cursor row; primary source
 * <https://cursor.com/docs/agent/hooks>), not yet smoke-tested against the real binary.
 *
 *  - event: `preToolUse` (the broad hook — unlike `beforeShellExecution`, it supports
 *    input rewrite), fired for every tool, so the hook file carries one matcher-less
 *    entry; stdin `{ tool_name, tool_input }`, and the settings file is versioned
 *    (`"version": 1`).
 *  - deny: `{ "permission": "deny", "agentMessage": … }` — `agentMessage` reaches the
 *    model, `userMessage` the human; the guard's steering text goes to the model.
 *  - rewrite: `{ "permission": "allow", "updated_input": { … } }` (snake_case, the
 *    whole input object), with no message field — announced on stderr instead.
 *
 * Cursor has no static permission-config file — gating is entirely hook code — so this
 * shim plus the instruction file is the whole enforcement story there.
 */
const HOOKS: HarnessHookSchema = {
  readTools: ['read_file', 'Read', 'ReadFile'],
  bashTools: ['run_terminal_cmd', 'Shell', 'Bash', 'shell'],
  toolNameKeys: ['tool_name'],
  toolInputKeys: ['tool_input'],
  deny: (reason) => ({ permission: 'deny', agentMessage: reason }),
  rewrite: {
    document: ({ input }) => ({ permission: 'allow', updated_input: input }),
    // The allow/updated_input shape carries no message field — announce on stderr.
    announce: 'stderr',
  },
};

export const cursor: ShimmedHarnessProfile = {
  id: 'cursor',
  name: 'Cursor',
  tier: 'experimental',
  detect: ['.cursor'],
  detectHome: ['.cursor'],
  instructionFile: 'AGENTS.md',
  instructions: 'snippet',
  caveats: ['Cursor has no static permission config — gating is entirely hook code'],
  hooks: HOOKS,
  install: [
    {
      kind: 'json-hooks',
      file: '.cursor/hooks.json',
      event: 'preToolUse',
      matchers: [undefined],
      entry: 'bare-command',
      lifecycle: false,
      shape: { version: 1 },
      // Verified 2026-09-09: cursor.com/docs/hooks documents `~/.cursor/hooks.json`
      // as the global user hooks file. Cursor documents no home-level AGENTS.md, so
      // the instruction layer stays project-only.
      user: { file: '.cursor/hooks.json' },
    },
  ],
};
