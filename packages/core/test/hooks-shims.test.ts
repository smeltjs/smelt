import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hasShim, shimAdapterOf } from '../src/harness/profile.ts';
import { HARNESSES } from '../src/harness/registry.ts';
import { DEFAULT_GUARD_SETTINGS } from '../src/hooks/guard-core.ts';
import type { GuardSettings } from '../src/hooks/guard-core.ts';
import { renderShimDecision, REWRITE_ANNOUNCEMENT_OPENING } from '../src/hooks/shim.ts';
import type { ShimAdapter } from '../src/hooks/shim.ts';
import { adapter as claudeCode } from '../src/hooks/shims/claude-code.ts';
import { adapter as codex } from '../src/hooks/shims/codex.ts';
import { adapter as cline } from '../src/hooks/shims/cline.ts';

import {
  envWithoutSmelt,
  envWithSmeltOnPath,
  FIXTURE_BY_HARNESS,
  harnessPayloads,
  valueAt,
} from './hooks-fixtures.ts';
import { packageRoot } from './guards/_source.ts';

/**
 * Schema-mapping tests — a **loop over the harness registry**, not a hand-written case
 * per harness. Every profile that ships a shim is exercised through
 * `renderShimDecision`, the exact function the shim processes run, against its own
 * recorded payloads (`test/fixtures/hooks/<id>.json`) and its declared expectations
 * (`test/hooks-fixtures.ts`). A new harness joins this suite by existing;
 * `test/guards/harness-registry.test.ts` is what makes that a rule rather than a habit.
 *
 * The harness-specific properties that are not table-shaped — Claude Code's payload
 * `cwd`, Codex's forbidden `"ask"`, Cline's nested input spelling — stay written out
 * below, where they can say why they matter.
 */

const stat = (path: string): { size: number; isFile: boolean } | undefined => {
  if (path === '/repo/big.ts') return { size: 20_000, isFile: true };
  if (path === '/repo/small.ts') return { size: 10, isFile: true };
  return undefined;
};

const DENY: GuardSettings = DEFAULT_GUARD_SETTINGS;
const REWRITE: GuardSettings = { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' };

/** The replacement the guard names for the oversized fixture file, in every harness. */
const REPLACEMENT = 'smelt /repo/big.ts --budget 8000';

function run(
  adapter: ShimAdapter,
  raw: unknown,
  settings: GuardSettings,
): { stdout: string; stderr?: string; exitCode: number; json: unknown } {
  const output = renderShimDecision(adapter, raw, settings, '/repo', stat);
  return {
    ...output,
    json: output.stdout === '' ? undefined : (JSON.parse(output.stdout) as unknown),
  };
}

describe.each(HARNESSES.filter(hasShim).map((profile) => [profile.id, profile] as const))(
  '%s shim',
  (id, profile) => {
    const adapter = shimAdapterOf(profile);
    const fixture = FIXTURE_BY_HARNESS[profile.id];
    const cases = harnessPayloads(id);

    it(`(${profile.tier}) has a recorded fixture — a shim with none is an untested shim`, () => {
      expect(fixture, `${id}: no entry in FIXTURE_BY_HARNESS`).toBeDefined();
    });

    it('denies an oversized Read in its own schema, with the steering reason where the model reads it', () => {
      const { json, exitCode } = run(adapter, cases[fixture!.readBigCase], DENY);
      expect(exitCode).toBe(0);
      expect(json).toMatchObject(fixture!.denyShape);
      const reason = valueAt(json, fixture!.reasonKeyPath);
      expect(reason, `${id}: no reason at ${fixture!.reasonKeyPath.join('.')}`).toContain(
        REPLACEMENT,
      );
      expect(reason).toContain('smelt retrieve');
    });

    it('passes what the guard has no opinion on', () => {
      for (const name of fixture!.passCases) {
        expect(run(adapter, cases[name], DENY), `${id}: ${name}`).toEqual({
          stdout: '',
          exitCode: 0,
          json: undefined,
        });
      }
    });

    it('denies an oversized cat in deny mode — never a silent rewrite', () => {
      const { json } = run(adapter, cases[fixture!.catCase], DENY);
      expect(json).toMatchObject(fixture!.denyShape);
      if (fixture!.rewrite !== undefined) {
        expect(valueAt(json, fixture!.rewrite.commandKeyPath)).toBeUndefined();
      }
    });

    it('rewrite mode substitutes the replacement and announces it — or falls back to the deny', () => {
      const output = run(adapter, cases[fixture!.catCase], REWRITE);
      const rewrite = fixture!.rewrite;
      if (rewrite === undefined) {
        // A deny-only harness: the input is read-only to its hooks, so rewrite mode
        // must land on the deny whose reason still carries the exact replacement —
        // never on nothing.
        expect(output.json).toMatchObject(fixture!.denyShape);
        expect(valueAt(output.json, fixture!.reasonKeyPath)).toContain(REPLACEMENT);
        return;
      }
      expect(output.json).toMatchObject(rewrite.shape);
      expect(valueAt(output.json, rewrite.commandKeyPath)).toBe(REPLACEMENT);
      // What lands in the input slot, exactly: the whole input object with `command`
      // replaced, or — where the harness shallow-merges — only the key that changed.
      // Sending the whole object into a shallow merge would overwrite arguments the
      // harness was keeping; sending only `command` where the whole object is
      // expected would drop them.
      const payloadInput = valueAt(cases[fixture!.catCase], fixture!.inputKeyPath);
      expect(valueAt(output.json, rewrite.commandKeyPath.slice(0, -1))).toEqual(
        rewrite.input === 'whole'
          ? { ...(payloadInput as Record<string, unknown>), command: REPLACEMENT }
          : { command: REPLACEMENT },
      );
      if (rewrite.announce === 'stderr') {
        // No reason channel in this document, so the substitution is announced on
        // stderr — through the one shared constant, never a per-shim copy.
        expect(output.stderr).toBeDefined();
        expect(output.stderr!.startsWith(REWRITE_ANNOUNCEMENT_OPENING)).toBe(true);
        expect(output.stderr).toContain(REPLACEMENT);
      } else {
        expect(output.stderr).toBeUndefined();
        expect(valueAt(output.json, fixture!.reasonKeyPath)).toContain('rewrote');
      }
    });
  },
);

describe('claude-code shim (VERIFIED) — the properties only its schema has', () => {
  const cases = harnessPayloads('claude-code');

  it('rewrite mode replaces the whole input object, so unchanged fields ride along', () => {
    const { json } = run(claudeCode, cases['bashCatBig'], REWRITE);
    expect(json).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: {
          command: REPLACEMENT,
          // unchanged fields ride along — updatedInput replaces the entire object
          description: 'Read the big file',
        },
      },
    });
  });

  it('rewrite mode wraps grep through smelt — no --focus on the searched pattern', () => {
    const { json } = run(claudeCode, cases['bashGrep'], REWRITE);
    expect(json).toMatchObject({
      hookSpecificOutput: {
        permissionDecision: 'allow',
        updatedInput: {
          command: 'grep -rn handleRequest src | smelt --budget 8000',
        },
      },
    });
  });

  it("resolves a relative Bash path against the payload's cwd, not the hook process's", () => {
    // Claude Code's hook stdin carries `cwd` — the session's working directory. After
    // the model `cd`s, a relative `cat` must be judged against that, not our cwd.
    const raw = {
      hook_event_name: 'PreToolUse',
      cwd: '/repo',
      tool_name: 'Bash',
      tool_input: { command: 'cat big.ts' },
    };
    const denied = renderShimDecision(claudeCode, raw, DENY, '/somewhere/else', stat);
    expect(denied.stdout).toContain('"permissionDecision":"deny"');
    // Without the payload cwd the same call would stat /somewhere/else/big.ts: a miss.
    const missed = renderShimDecision(
      claudeCode,
      { ...raw, cwd: undefined },
      DENY,
      '/somewhere/else',
      stat,
    );
    expect(missed.stdout).toBe('');
  });

  it('rewrite mode still DENIES an oversized Read — updatedInput cannot turn a Read into a Bash call', () => {
    const { json } = run(claudeCode, cases['readBig'], REWRITE);
    expect(json).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
});

describe('codex shim (VERIFIED) — the two documented differences from Claude Code', () => {
  const cases = harnessPayloads('codex');

  it('never emits the unsupported "ask" decision', () => {
    const { json } = run(codex, cases['readBig'], DENY);
    expect(JSON.stringify(json)).not.toContain('"ask"');
  });

  it('rewrites Bash with a string `command` in updatedInput, as Codex requires', () => {
    const { json } = run(codex, cases['bashCatBig'], REWRITE);
    const updated = (json as { hookSpecificOutput: { updatedInput: { command: unknown } } })
      .hookSpecificOutput.updatedInput;
    expect(typeof updated.command).toBe('string');
  });

  it('maps the `shell` tool spelling too', () => {
    expect(run(codex, cases['shellGrep'], DENY).stdout).toBe('');
  });
});

describe('cline shim (EXPERIMENTAL) — the nested input spelling', () => {
  const cases = harnessPayloads('cline');

  it('cancels on a tool call nested under preToolUse, not only the flat spelling', () => {
    expect(run(cline, cases['readBigNested'], DENY).json).toMatchObject({ cancel: true });
  });
});

describe('the built shim scripts are runnable front doors', () => {
  const script = join(packageRoot(), 'dist', 'hooks', 'shims', 'claude-code.js');

  it('dist/hooks/shims/claude-code.js answers a real spawned request (isMainModule wiring)', () => {
    const spawned = spawnSync(process.execPath, [script], {
      input: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo hello' },
      }),
      encoding: 'utf8',
    });
    expect(spawned.status).toBe(0);
    expect(spawned.stdout).toBe(''); // allow: no output
  });

  it('malformed stdin → allow with a warning on stderr and exit 0 — fail open, never brick a session', () => {
    const spawned = spawnSync(process.execPath, [script], { input: 'not json', encoding: 'utf8' });
    expect(spawned.status).toBe(0);
    expect(spawned.stdout).toBe(''); // an allow is silence, in this schema
    expect(spawned.stderr).toContain('allowing the call');
  });

  /**
   * The defect this whole module exists for, reproduced end to end.
   *
   * Node **realpaths** the ESM main entry, so a shim reached through any symlink — a
   * Homebrew `opt` alias, a `pnpm link`, the plain `dist` alias below — had
   * `pathToFileURL(argv[1]).href !== import.meta.url`, `isMainModule` said no,
   * `runShimMain` never ran, and the process exited 0 with empty stdout. Empty stdout
   * is how this schema spells *allow*: the guard was silently inert on exactly the
   * installs that reach it through a link, and every oversized read passed.
   */
  describe('a shim invoked through a symlink still denies', () => {
    let dir: string;
    let big: string;
    let linked: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'smelt-shim-symlink-'));
      symlinkSync(join(packageRoot(), 'dist'), join(dir, 'dist'));
      big = join(dir, 'big.log');
      writeFileSync(big, 'x'.repeat(60_000));
      linked = join(dir, 'dist', 'hooks', 'shims', 'claude-code.js');
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const payload = (): string =>
      JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        tool_input: { file_path: big },
        cwd: dir,
      });

    function denyThrough(env: Record<string, string>): string {
      const spawned = spawnSync(process.execPath, [linked], {
        input: payload(),
        encoding: 'utf8',
        env,
      });
      expect(spawned.status, spawned.stderr).toBe(0);
      expect(spawned.stdout, 'empty stdout is an allow — the shim never ran').not.toBe('');
      const decision = JSON.parse(spawned.stdout) as {
        hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string };
      };
      expect(decision.hookSpecificOutput.permissionDecision).toBe('deny');
      return decision.hookSpecificOutput.permissionDecisionReason;
    }

    it('denies, and names node <bin> when no `smelt` is on PATH', () => {
      const reason = denyThrough(envWithoutSmelt());
      expect(reason).toContain(big);
      // Never the versioned keg: a command the next `brew upgrade` deletes.
      expect(reason).not.toContain('/Cellar/');
      expect(reason).toContain('cli/bin.js');
      expect(reason).toContain(`--budget ${String(DEFAULT_GUARD_SETTINGS.budgetBytes)}`);
    });

    it('names the bare `smelt` when one is on PATH', () => {
      const bin = mkdtempSync(join(tmpdir(), 'smelt-shim-bin-'));
      try {
        const reason = denyThrough(envWithSmeltOnPath(bin));
        expect(reason).toContain(
          `smelt ${big} --budget ${String(DEFAULT_GUARD_SETTINGS.budgetBytes)}`,
        );
        expect(reason).not.toContain('cli/bin.js');
      } finally {
        rmSync(bin, { recursive: true, force: true });
      }
    });
  });
});
