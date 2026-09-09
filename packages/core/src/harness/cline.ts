import type { HarnessHookSchema } from '../hooks/shim.ts';

import { nodeCommand, shimScriptPath } from './paths.ts';
import { renderRoot } from './scope.ts';
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

/**
 * Cline's pre-tool event, spelled once: it is both the **name of the file** Cline runs
 * (hooks are executables under `hooks/`, named for their event) and the event
 * `smelt doctor` reports this file's probe under.
 */
const PRE_TOOL_EVENT = 'PreToolUse';

/**
 * What the renderer writes in front of the hook command below — and therefore what a
 * reader takes off to get the command back. Declared beside the renderer, and handed to
 * `harness/hook-command.ts` as the step's probe, so the file is read by the one reader
 * rather than grepped a second way.
 */
const EXEC_PREFIX = 'exec ';

/** Cline's hook is an executable file; this two-liner hands it to the cline shim. */
function clineHookSource(ctx: HarnessInstallContext): string {
  return `#!/bin/sh
# smelt:hooks v1 — Cline ${PRE_TOOL_EVENT} hook. EXPERIMENTAL tier: schema mapped from the
# capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, Cline row),
# not yet smoke-tested against the real binary. Written by \`smelt hooks install\`.
${EXEC_PREFIX}${nodeCommand(renderRoot(ctx.scope, ctx), shimScriptPath(cline, ctx.distDir))}
`;
}

export const cline: ShimmedHarnessProfile = {
  id: 'cline',
  name: 'Cline',
  tier: 'experimental',
  detect: ['.clinerules'],
  detectHome: [],
  instructionFile: '.clinerules/smelt.md',
  // Verified 2026-09-09: docs.cline.bot/cli/configuration lays out `~/.cline/` with
  // `rules/` (global rules) and `hooks/` (global hooks) beside each other.
  userInstructionFile: '.cline/rules/smelt.md',
  instructions: 'snippet',
  caveats: ['deny-only hooks: input rewrite is not supported, so rewrite mode falls back to deny'],
  hooks: HOOKS,
  install: [
    {
      kind: 'own-file',
      file: `.clinerules/hooks/${PRE_TOOL_EVENT}`,
      user: { file: `.cline/hooks/${PRE_TOOL_EVENT}` },
      content: clineHookSource,
      mode: 0o755,
      guardOnly: true,
      // Read back through the same prefix it was written with: the line behind `exec `
      // is a hook command, and `parseHookCommand` is the reader for those.
      probe: { kind: 'command-line', event: PRE_TOOL_EVENT, prefix: EXEC_PREFIX },
    },
  ],
};
