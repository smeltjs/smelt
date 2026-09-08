import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect } from 'vitest';

import type { HarnessId } from '../src/harness/profile.ts';

import { packageRoot } from './guards/_source.ts';

/**
 * The recorded schema fixtures, one entry per harness that ships a shim.
 *
 * Two halves: a payload file (`test/fixtures/hooks/<id>.json`) whose cases were
 * recorded from the harness's own docs — each citing the row of
 * docs/research/2026-09-02-harness-capability-matrix.md (or the § of the enforcement
 * research note) it came from — and, here, the *expectations*: the deny document this
 * harness wants back, where in it the model reads the guard's reason, and what a
 * rewrite looks like where the schema supports one.
 *
 * The registry lives in `src/`; this table lives in test-land on purpose, the same way
 * `structural-fixtures.ts` does: the mutation runner redirects only the library
 * (`@guard`), so a mutant registry that claims a new harness — or drops one — is
 * measured against the real, committed fixtures and goes red in
 * `test/guards/harness-registry.test.ts`.
 */
export interface HarnessShimFixture {
  /** The case name, in the payload file, of an oversized raw read. */
  readonly readBigCase: string;
  /** The case name of an oversized `cat` — the one a rewrite may substitute. */
  readonly catCase: string;
  /** Cases that must pass through untouched, in deny mode. */
  readonly passCases: readonly string[];
  /** The deny document, minus the reason: what the harness's schema wants back. */
  readonly denyShape: Record<string, unknown>;
  /** Where in the deny document the guard's steering reason reaches the model. */
  readonly reasonKeyPath: readonly string[];
  /** Where the tool's input object lives in this harness's recorded payloads. */
  readonly inputKeyPath: readonly string[];
  /**
   * The rewrite document for {@link catCase}, minus the substituted command, or
   * `undefined` for a deny-only harness — one whose hook cannot modify tool input, and
   * which must therefore fall back to a deny whose reason still names the replacement.
   */
  readonly rewrite?: {
    readonly shape: Record<string, unknown>;
    /** Where the substituted command lands in that document. */
    readonly commandKeyPath: readonly string[];
    /**
     * What the harness expects in that slot: `'whole'` — the tool's entire input
     * object with `command` replaced (Claude Code, Codex, Gemini, Cursor), or
     * `'changed-key-only'` — a shallow merge, where sending anything but the changed
     * key would overwrite arguments the harness was keeping (Hermes).
     */
    readonly input: 'whole' | 'changed-key-only';
    /** Where the substitution is announced: the model's reason, or stderr. */
    readonly announce: 'reason' | 'stderr';
  };
}

const CLAUDE_STYLE_DENY = {
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
};

const CLAUDE_STYLE_REWRITE = {
  shape: { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } },
  commandKeyPath: ['hookSpecificOutput', 'updatedInput', 'command'],
  input: 'whole',
  announce: 'reason',
} as const;

/** Every harness that ships a shim, keyed by id. Totality is guarded, not assumed. */
export const FIXTURE_BY_HARNESS: Readonly<Partial<Record<HarnessId, HarnessShimFixture>>> = {
  'claude-code': {
    readBigCase: 'readBig',
    catCase: 'bashCatBig',
    passCases: ['readWindowed', 'readSmall', 'otherTool', 'bashGrep'],
    denyShape: CLAUDE_STYLE_DENY,
    reasonKeyPath: ['hookSpecificOutput', 'permissionDecisionReason'],
    inputKeyPath: ['tool_input'],
    rewrite: CLAUDE_STYLE_REWRITE,
  },
  codex: {
    readBigCase: 'readBig',
    catCase: 'bashCatBig',
    passCases: ['shellGrep'],
    denyShape: CLAUDE_STYLE_DENY,
    reasonKeyPath: ['hookSpecificOutput', 'permissionDecisionReason'],
    inputKeyPath: ['tool_input'],
    rewrite: CLAUDE_STYLE_REWRITE,
  },
  gemini: {
    readBigCase: 'readBig',
    catCase: 'shellCatBig',
    passCases: ['readWindowed'],
    denyShape: { decision: 'deny' },
    reasonKeyPath: ['reason'],
    inputKeyPath: ['tool_input'],
    rewrite: {
      shape: { hookSpecificOutput: { hookEventName: 'BeforeTool' } },
      commandKeyPath: ['hookSpecificOutput', 'tool_input', 'command'],
      input: 'whole',
      announce: 'stderr',
    },
  },
  grok: {
    readBigCase: 'readBig',
    catCase: 'bashCatBig',
    passCases: [],
    denyShape: { decision: 'deny' },
    reasonKeyPath: ['reason'],
    inputKeyPath: ['tool_input'],
  },
  hermes: {
    readBigCase: 'readBig',
    catCase: 'bashCatBig',
    passCases: [],
    denyShape: { action: 'block' },
    reasonKeyPath: ['reason'],
    inputKeyPath: ['args'],
    rewrite: {
      shape: { action: 'modify' },
      commandKeyPath: ['args', 'command'],
      input: 'changed-key-only',
      announce: 'stderr',
    },
  },
  cursor: {
    readBigCase: 'readBig',
    catCase: 'terminalCatBig',
    passCases: [],
    denyShape: { permission: 'deny' },
    reasonKeyPath: ['agentMessage'],
    inputKeyPath: ['tool_input'],
    rewrite: {
      shape: { permission: 'allow' },
      commandKeyPath: ['updated_input', 'command'],
      input: 'whole',
      announce: 'stderr',
    },
  },
  cline: {
    readBigCase: 'readBig',
    catCase: 'bashCatBig',
    passCases: [],
    denyShape: { cancel: true },
    reasonKeyPath: ['errorMessage'],
    inputKeyPath: ['toolInput'],
  },
};

/** The recorded payloads for one harness, with their citation asserted. */
export function harnessPayloads(id: string): Record<string, unknown> {
  const path = join(packageRoot(), 'test', 'fixtures', 'hooks', `${id}.json`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  expect(parsed['_cites'], `${id}.json must cite the matrix row it was recorded from`).toContain(
    'docs/research/2026-09-02',
  );
  return parsed;
}

/** The value at a key path inside a rendered decision document. */
export function valueAt(document: unknown, path: readonly string[]): unknown {
  let value: unknown = document;
  for (const key of path) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/**
 * A spawn environment whose PATH holds no `smelt`.
 *
 * The guard's deny reason ranks `smelt` on PATH above `node "<script>"`, so a machine
 * that happens to have smelt installed globally — the developer's, and every machine
 * where this bug was found — would otherwise decide which branch these tests exercise.
 * PATH is the seam, so PATH is what the test sets.
 */
export function envWithoutSmelt(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  env['PATH'] = join(packageRoot(), 'test', 'fixtures', 'no-such-bin-dir');
  return env;
}

/**
 * The other half: a PATH holding one executable named `smelt`, so a spawned guard
 * takes the top rung of the ranking and quotes the bare name.
 */
export function envWithSmeltOnPath(dir: string): Record<string, string> {
  const bin = join(dir, 'smelt');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  chmodSync(bin, 0o755);
  const env = envWithoutSmelt();
  env['PATH'] = dir;
  return env;
}
