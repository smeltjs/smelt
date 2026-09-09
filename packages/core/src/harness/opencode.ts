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
/**
 * The hook opencode calls, spelled once: the key of the table the plugin returns, and
 * the event `smelt doctor` reports this file's probe under.
 */
const HOOK_KEY = 'tool.execute.before';

/** The export opencode calls to get that table, and the binding the core's path is in. */
const PLUGIN_FACTORY = 'SmeltGuard';
const GUARD_CORE_BINDING = 'GUARD_CORE';

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
// Thin adapter: maps ${HOOK_KEY} onto the smelt guard core (zero
// dependencies), which owns every decision. Deny mode throws (opencode surfaces the
// reason to the model); rewrite mode substitutes the faithful replacement command —
// announced on stderr, because the plugin API has no reason channel on a rewrite
// and a substitution must never be silent. Both announcements below are spliced in
// from the shims' own constants, so this copy cannot drift from theirs.
import { pathToFileURL } from 'node:url';

const ${GUARD_CORE_BINDING} = ${JSON.stringify(guardCore)};
const core = await import(pathToFileURL(${GUARD_CORE_BINDING}).href);

export const ${PLUGIN_FACTORY} = async () => ({
  '${HOOK_KEY}': async (input, output) => {
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
const MCP_ENTRY = { type: 'local', command: [...MCP_RUN_ARGS] } as const;

/** Where the registration goes, at each scope — one owner for both spellings. */
const CONFIG_JSON = 'opencode.json';
const USER_CONFIG_JSON = '.config/opencode/opencode.json';

/**
 * The entry as a person pastes it, exactly as `packages/mcp/README.md` prints it —
 * the same value the `mcp-registration` step merges in, under the same key.
 */
const MCP_JSON =
  `"mcp": { "smelt": { "type": "${MCP_ENTRY.type}", ` +
  `"command": ["${MCP_ENTRY.command.join('", "')}"] } }`;

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
  // The registration, as a person would add it — the same JSON value the step below
  // merges in, under the same key, in the file that scope reads.
  mcp: {
    manual: `add this to ${CONFIG_JSON}:\n${MCP_JSON}`,
    manualUser: `add this to ~/${USER_CONFIG_JSON}:\n${MCP_JSON}`,
  },
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
      // The one harness with no shim: what is verified is that the module still loads
      // — its top-level import of the built guard core included — and still exports the
      // hook opencode calls. Every name here is the renderer's own, above.
      probe: {
        kind: 'esm-plugin',
        event: HOOK_KEY,
        core: GUARD_CORE_BINDING,
        factory: PLUGIN_FACTORY,
      },
    },
    {
      kind: 'mcp-registration',
      file: CONFIG_JSON,
      user: { file: USER_CONFIG_JSON },
      path: ['mcp', 'smelt'],
      entry: () => ({ ...MCP_ENTRY, command: [...MCP_ENTRY.command] }),
    },
  ],
};
