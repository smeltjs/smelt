import {
  DENIED_WITHOUT_REASON,
  REWRITE_ANNOUNCEMENT_JOIN,
  REWRITE_ANNOUNCEMENT_OPENING,
} from '../hooks/shim.ts';

import { MCP_RUN_ARGS } from '../setup/recipe.ts';
import { guardCoreScriptPath, portablePath } from './paths.ts';
import { renderRoot } from './scope.ts';
import type { HarnessInstallContext, HarnessProfile } from './profile.ts';

/**
 * opencode — EXPERIMENTAL tier. Install and removal, end to end.
 *
 * The one harness with no shim script: its hook API is a JavaScript plugin, not a
 * stdin schema, so what the installer writes *is* the adapter. The plugin imports the
 * built guard core directly (the same module every shim calls) and maps
 * `tool.execute.before` onto it, so all policy still lives in exactly one place.
 *
 * Its two announcements — the rewrite sentence and the reasonless deny — are spliced
 * in from `hooks/shim.ts`'s constants rather than hand-typed into the template, where
 * nothing could see them drift from what the shims print.
 */
function opencodePluginSource(ctx: HarnessInstallContext): string {
  const guardCore = portablePath(renderRoot(ctx.scope, ctx), guardCoreScriptPath(ctx.distDir));
  return `// smelt:hooks v1 — opencode plugin shim. EXPERIMENTAL tier: mapped from the
// capability matrix (docs/research/2026-09-02-harness-capability-matrix.md, opencode
// row; https://opencode.ai/docs/plugins/). This template's deny/pass/window paths
// were exercised directly against the built guard core (verified
// 2026-09-02), but a live opencode session has not been smoke-tested — that needs
// provider credentials. Caveat carried from the matrix: MCP tools can bypass plugin
// hooks (sst/opencode#2319) — this guard sees built-in tools only.
//
// Thin adapter: maps tool.execute.before onto the smelt guard core (zero
// dependencies), which owns every decision. Deny mode throws (opencode surfaces the
// reason to the model); rewrite mode substitutes the faithful replacement command —
// announced on stderr, because the plugin API has no reason channel on a rewrite
// and a substitution must never be silent. Both announcements below are spliced in
// from the shims' own constants, so this copy cannot drift from theirs.
import { pathToFileURL } from 'node:url';

const GUARD_CORE = ${JSON.stringify(guardCore)};
const core = await import(pathToFileURL(GUARD_CORE).href);

export const SmeltGuard = async () => ({
  'tool.execute.before': async (input, output) => {
    const tool = input?.tool;
    const args = output?.args ?? {};
    let request;
    if (tool === 'read' && typeof args.filePath === 'string') {
      request = {
        tool: 'Read',
        input: {
          path: args.filePath,
          offsetLimited: args.offset !== undefined || args.limit !== undefined,
        },
      };
    } else if (tool === 'bash' && typeof args.command === 'string') {
      request = { tool: 'Bash', input: { command: args.command } };
    } else {
      return;
    }
    const warn = (text) => process.stderr.write(text + '\\n');
    const settings = core.readGuardSettings(process.cwd(), warn);
    const decision = core.decide(request, settings, process.cwd());
    if (decision.action !== 'deny') return;
    if (
      settings.enforcement === 'rewrite' &&
      request.tool === 'Bash' &&
      decision.suggestion !== undefined
    ) {
      warn(
        ${JSON.stringify(REWRITE_ANNOUNCEMENT_OPENING)} +
          decision.suggestion +
          ${JSON.stringify(REWRITE_ANNOUNCEMENT_JOIN)} +
          (decision.reason ?? ''),
      );
      output.args.command = decision.suggestion;
      return;
    }
    throw new Error(decision.reason ?? ${JSON.stringify(DENIED_WITHOUT_REASON)});
  },
});
`;
}

// Same derivation as claude-code's, from the one place it lives (MCP_RUN_ARGS):
// the recipe's run command in opencode's spawn shape (a single `command` array,
// `type: "local"`).

export const opencode: HarnessProfile = {
  id: 'opencode',
  name: 'opencode',
  tier: 'experimental',
  detect: ['.opencode', 'opencode.json'],
  detectHome: ['.config/opencode'],
  instructionFile: 'AGENTS.md',
  // Verified 2026-09-09: global config is `~/.config/opencode/opencode.json`
  // (opencode.ai/docs/config § Locations), global rules `~/.config/opencode/AGENTS.md`
  // (.../docs/rules), and the global plugin directory `~/.config/opencode/plugins/`
  // (.../docs/plugins § "From local files"). Note the plural: today's docs spell the
  // *project* directory `.opencode/plugins/` too, while smelt has always written
  // `.opencode/plugin/`. Changing the project path is not this change's to make.
  userInstructionFile: '.config/opencode/AGENTS.md',
  instructions: 'snippet',
  caveats: [
    'MCP tools can bypass opencode plugin hooks (sst/opencode#2319) — the guard sees built-in tools only',
  ],
  install: [
    {
      kind: 'own-file',
      file: '.opencode/plugin/smelt-guard.js',
      user: { file: '.config/opencode/plugins/smelt-guard.js' },
      content: opencodePluginSource,
      guardOnly: true,
    },
    {
      kind: 'mcp-registration',
      file: 'opencode.json',
      user: { file: '.config/opencode/opencode.json' },
      path: ['mcp', 'smelt'],
      entry: () => ({ type: 'local', command: [...MCP_RUN_ARGS] }),
    },
  ],
};
