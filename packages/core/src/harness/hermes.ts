import type { HarnessHookSchema } from '../hooks/shim.ts';

import { nodeCommand, shimScriptPath } from './paths.ts';
import type { HarnessInstallContext, ShimmedHarnessProfile } from './profile.ts';
import { SNIPPET_END_HASH, SNIPPET_START_HASH } from './snippet.ts';

/**
 * Hermes Agent — EXPERIMENTAL tier. Schema, install and removal, end to end.
 *
 * Schema mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Hermes Agent row; primary
 * source <https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks>), not
 * yet smoke-tested against the real binary.
 *
 *  - event: `pre_tool_call`; stdin carries the tool name and its arguments
 *    (`tool_name` + `args`, with `tool_input` accepted as a fallback spelling).
 *  - deny: `{ "action": "block", "reason": … }`.
 *  - rewrite: `{ "action": "modify", "args": { … } }` — a **shallow merge** into the
 *    tool's arguments, so this schema sends only the `command` key and the harness
 *    keeps the rest. The modify document has **no reason field**, so the substitution
 *    is announced on stderr — a rewrite must never be silent.
 *
 * Carried caveat from the matrix: Hermes has a known bypass where memory tools ignore
 * `disabled_toolsets` (<https://github.com/NousResearch/hermes-agent/issues/46171>) —
 * tool gating there is leaky at the edges, so treat this hook as best-effort steering,
 * not a boundary.
 */
const HOOKS: HarnessHookSchema = {
  readTools: ['read_file', 'Read', 'ReadFile'],
  bashTools: ['execute_command', 'terminal', 'bash', 'Bash', 'shell'],
  toolNameKeys: ['tool_name'],
  toolInputKeys: ['args', 'tool_input'],
  deny: (reason) => ({ action: 'block', reason }),
  rewrite: {
    // A shallow merge: only the key that changed travels, never the spliced whole.
    document: ({ suggestion }) => ({ action: 'modify', args: { command: suggestion } }),
    announce: 'stderr',
  },
};

/** Hermes hook config, as a mergeable snippet — their config is a home-level YAML. */
function hermesHooksYaml(ctx: HarnessInstallContext): string {
  return `${SNIPPET_START_HASH}
# Hermes Agent hook config for the smelt guard. EXPERIMENTAL tier: schema mapped from
# the capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, Hermes
# row), not yet smoke-tested against the real binary. If Hermes does not read this
# file directly, merge the \`hooks:\` section into ~/.hermes/config.yaml.
hooks:
  pre_tool_call:
    - command: ${nodeCommand(ctx.cwd, shimScriptPath(hermes, ctx.distDir))}
${SNIPPET_END_HASH}
`;
}

export const hermes: ShimmedHarnessProfile = {
  id: 'hermes',
  name: 'Hermes Agent',
  shortName: 'Hermes',
  tier: 'experimental',
  detect: ['.hermes', '.hermes.md'],
  detectHome: ['.hermes'],
  instructionFile: 'AGENTS.md',
  instructions: 'snippet',
  caveats: [
    'Hermes memory tools bypass disabled_toolsets (NousResearch/hermes-agent#46171) — treat tool gating there as leaky',
    'hook config may need merging into ~/.hermes/config.yaml by hand; the written file says how',
  ],
  hooks: HOOKS,
  install: [
    {
      kind: 'own-file',
      file: '.hermes/hooks.yaml',
      content: hermesHooksYaml,
      guardOnly: true,
    },
  ],
};
