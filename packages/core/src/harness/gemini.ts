import type { HarnessHookSchema } from '../hooks/shim.ts';

import type { ShimmedHarnessProfile } from './profile.ts';

/**
 * Gemini CLI — EXPERIMENTAL tier. Schema, install and removal, end to end.
 *
 * The schema below is mapped from the capability matrix
 * (docs/research/2026-09-02-harness-capability-matrix.md, Gemini CLI row; primary
 * source <https://geminicli.com/docs/hooks/reference/>), and the field names were
 * additionally checked 2026-09-02 against the shipped `@google/gemini-cli` 0.58.0
 * bundle (installed headlessly for the shim's verification pass): the BeforeTool stdin
 * payload is `{ tool_name, tool_input }`, `read_file` takes `file_path` with
 * `start_line`/`end_line` windows, the shell tool is `run_shell_command` with
 * `command`, denial is `{ "decision": "deny", "reason": … }`, and
 * `hookSpecificOutput.tool_input` substitutes the input. What has NOT run is a live
 * end-to-end session (needs credentials this environment does not have), so the tier
 * stays experimental — treat surprises as shim bugs and please report them.
 *
 * Carried caveat from the matrix: Gemini's policy engine has an open bug where an
 * `allow` policy is ignored in non-interactive runs
 * (<https://github.com/google-gemini/gemini-cli/issues/20469>) — this preset uses
 * hooks, not the policy engine, but non-interactive behaviour is the least-tested
 * corner; verify before relying on it in CI.
 */
const HOOKS: HarnessHookSchema = {
  readTools: ['read_file', 'ReadFile', 'Read'],
  bashTools: ['run_shell_command', 'Shell', 'Bash'],
  toolNameKeys: ['tool_name'],
  toolInputKeys: ['tool_input'],
  deny: (reason) => ({ decision: 'deny', reason }),
  rewrite: {
    document: ({ input }) => ({
      hookSpecificOutput: { hookEventName: 'BeforeTool', tool_input: input },
    }),
    // The BeforeTool rewrite shape carries no reason field — announce on stderr.
    announce: 'stderr',
  },
};

export const gemini: ShimmedHarnessProfile = {
  id: 'gemini',
  name: 'Gemini CLI',
  shortName: 'Gemini',
  tier: 'experimental',
  detect: ['.gemini'],
  detectHome: ['.gemini'],
  instructionFile: 'GEMINI.md',
  // Verified 2026-09-09: user configuration lives in `~/.gemini/` — settings at
  // `~/.gemini/settings.json` (geminicli.com/docs/resources/faq) and the global
  // context file in the home directory beside it (.../docs/cli/gemini-md).
  userInstructionFile: '.gemini/GEMINI.md',
  instructions: 'snippet',
  caveats: [
    'Gemini policy-engine allow rules are ignored in non-interactive runs (google-gemini/gemini-cli#20469) — verify hook behaviour in CI before relying on it',
  ],
  hooks: HOOKS,
  install: [
    {
      kind: 'json-hooks',
      file: '.gemini/settings.json',
      event: 'BeforeTool',
      matchers: ['read_file', 'run_shell_command'],
      entry: 'command-list',
      lifecycle: false,
      user: { file: '.gemini/settings.json' },
    },
  ],
};
