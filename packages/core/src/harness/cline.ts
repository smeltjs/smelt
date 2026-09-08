import type { HarnessHookSchema } from '../hooks/shim.ts';

import { nodeCommand, shimScriptPath } from './paths.ts';
import type { HarnessInstallContext, ShimmedHarnessProfile } from './profile.ts';

/**
 * Cline — EXPERIMENTAL tier. Schema, install and removal, end to end.
 *
 * Schema mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Cline row; primary source
 * <https://docs.cline.bot/features/hooks>), not yet smoke-tested against the real
 * binary.
 *
 *  - event: `PreToolUse`, delivered to an executable under `.clinerules/hooks/` —
 *    hence the two-line wrapper below, which is the file Cline runs; stdin carries the
 *    tool call (accepted spellings: `tool_name`/`tool_input`, `toolName`/`toolInput`,
 *    or nested under `preToolUse`).
 *  - deny: `{ "cancel": true, "errorMessage": … }`. **Deny-only**: the response has no
 *    input-modification field, so under `hooks.enforcement: "rewrite"` this harness
 *    falls back to the deny, whose reason still carries the exact replacement pipeline.
 */
const HOOKS: HarnessHookSchema = {
  readTools: ['Read', 'read_file', 'readFile'],
  bashTools: ['Bash', 'execute_command', 'executeCommand', 'shell'],
  toolNameKeys: ['tool_name', 'toolName', 'preToolUse.toolName', 'preToolUse.tool'],
  toolInputKeys: ['tool_input', 'toolInput', 'preToolUse.toolInput', 'preToolUse.input'],
  deny: (reason) => ({ cancel: true, errorMessage: reason }),
};

/** Cline's hook is an executable file; this two-liner hands it to the cline shim. */
function clineHookSource(ctx: HarnessInstallContext): string {
  return `#!/bin/sh
# smelt:hooks v1 — Cline PreToolUse hook. EXPERIMENTAL tier: schema mapped from the
# capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, Cline row),
# not yet smoke-tested against the real binary. Written by \`smelt hooks install\`.
exec ${nodeCommand(ctx.cwd, shimScriptPath(cline, ctx.distDir))}
`;
}

export const cline: ShimmedHarnessProfile = {
  id: 'cline',
  name: 'Cline',
  tier: 'experimental',
  detect: ['.clinerules'],
  detectHome: [],
  instructionFile: '.clinerules/smelt.md',
  instructions: 'snippet',
  caveats: ['deny-only hooks: input rewrite is not supported, so rewrite mode falls back to deny'],
  hooks: HOOKS,
  install: [
    {
      kind: 'own-file',
      file: '.clinerules/hooks/PreToolUse',
      content: clineHookSource,
      mode: 0o755,
      guardOnly: true,
    },
  ],
};
