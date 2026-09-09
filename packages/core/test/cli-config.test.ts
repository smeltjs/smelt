import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONFIG_FILE_NAME, findConfigFile, parseConfig } from '../src/config.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';

/**
 * `smelt.config.json` supplies DEFAULTS to the CLI, and nothing else. These tests pin
 * the three properties that matter: the nearest config is found by walking up,
 * explicit flags always beat it, and a malformed config is a loud usage error — never
 * silently ignored, not even when every flag was given. The programmatic API never
 * reads it at all.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-config-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  argv: readonly string[],
  cwd: string,
  stdin = '',
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    stdin: () => stdin,
    version: '9.9.9-test',
    cwd,
    env,
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

function writeConfig(at: string, config: unknown): void {
  writeFileSync(join(at, CONFIG_FILE_NAME), `${JSON.stringify(config, null, 2)}\n`);
}

/** Big enough to force elisions at a small budget. */
function corpus(): string {
  const lines = Array.from(
    { length: 240 },
    (_, i) => `line ${String(i)} some padding text to make this worth collapsing`,
  );
  lines[120] = 'function handleRequest(req, res) { /* the one we care about */ }';
  return `${lines.join('\n')}\n`;
}

describe('the config supplies defaults', () => {
  it('defaultBudgetBytes makes --budget optional', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000 });
    const { code, stderr } = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(code).toBe(EXIT.ok);
    expect(stderr).not.toContain('OVER BUDGET');
  });

  it('is found by walking up from the cwd, like package.json', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000 });
    const nested = join(dir, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findConfigFile(nested)).toBe(join(dir, CONFIG_FILE_NAME));
    const { code } = await run([], nested, corpus());
    expect(code).toBe(EXIT.ok);
  });

  it('strategy comes from the config when the flag is absent', async () => {
    // Structural refuses stdin with no detectable language, so a refusal exit proves
    // the config's strategy was actually in force.
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000, strategy: 'structural' });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.refused);
    expect(stderr).toMatch(/GrammarUnavailableError/);
  });

  it('a directory store from the config persists elided bytes on disk', async () => {
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 400,
      store: { kind: 'directory', path: 'elision-store' },
    });
    const { code } = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(code).toBeLessThanOrEqual(EXIT.overBudget); // ok or over budget — both smelted
    // The store path resolves relative to the config file, and the blobs are real.
    expect(readdirSync(join(dir, 'elision-store', 'blobs')).length).toBeGreaterThan(0);
  });
});

describe('explicit flags always win', () => {
  it('--budget beats defaultBudgetBytes', async () => {
    // The config budget is unfittable; the flag budget fits. Exit codes tell them apart.
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 120 });
    const viaConfig = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(viaConfig.code).toBe(EXIT.overBudget);
    const viaFlag = await run(['--budget', '4000', '--focus', 'handleRequest'], dir, corpus());
    expect(viaFlag.code).toBe(EXIT.ok);
  });

  it('--strategy beats the config strategy', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000, strategy: 'structural' });
    const { code } = await run(['--strategy', 'lexical'], dir, corpus());
    expect(code).toBe(EXIT.ok);
  });
});

describe('a malformed config is a usage error, never silently ignored', () => {
  it('even when every flag was given explicitly', async () => {
    writeFileSync(join(dir, CONFIG_FILE_NAME), '{ this is not json');
    const { code, stderr } = await run(['--budget', '4000'], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('malformed');
    expect(stderr).toContain(join(dir, CONFIG_FILE_NAME));
  });

  it('refuses an unknown schema version instead of half-reading it', async () => {
    writeConfig(dir, { smeltConfig: 2, defaultBudgetBytes: 4000 });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('version');
  });

  it('refuses unknown keys — a typo is not a setting', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetByte: 4000 });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('defaultBudgetByte');
  });

  it('validates types and ranges like the flags do', () => {
    for (const bad of [
      { smeltConfig: 1, defaultBudgetBytes: 0 },
      { smeltConfig: 1, defaultBudgetBytes: 4.5 },
      { smeltConfig: 1, strategy: 'psychic' },
      { smeltConfig: 1, store: { kind: 'cloud' } },
      { smeltConfig: 1, store: { kind: 'directory' } },
      { smeltConfig: 1, store: { kind: 'memory', path: 'x' } },
      { smeltConfig: 1, store: { kind: 'memory', retention: { olderThan: '30d' } } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: {} } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: { olderThan: '30' } } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: { olderThan: '0d' } } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: { olderThan: '30m' } } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: { olderThan: '' } } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: { olderThan: 30 } } },
      {
        smeltConfig: 1,
        store: { kind: 'directory', path: 's', retention: { olderThan: '200000000d' } },
      },
      {
        smeltConfig: 1,
        store: { kind: 'directory', path: 's', retention: { olderThan: '30d', keep: true } },
      },
      {
        smeltConfig: 1,
        store: {
          kind: 'directory',
          path: 's',
          retention: { olderThan: '30d', keepRetrieved: 'yes' },
        },
      },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: 'forever' } },
      { smeltConfig: 1, store: { kind: 'directory', path: 's', retention: [] } },
      { smeltConfig: 1, rerank: { kind: 'psychic' } },
      { smeltConfig: 1, rerank: { kind: 'module' } },
      { smeltConfig: 1, rerank: { kind: 'module', path: '' } },
      { smeltConfig: 1, rerank: { kind: 'module', path: './x.ts', topK: 4 } },
      { smeltConfig: 1, rerank: { kind: 'voyage', topK: 0 } },
      { smeltConfig: 1, rerank: { kind: 'voyage', topK: 2.5 } },
      { smeltConfig: 1, rerank: { kind: 'voyage', topK: '4' } },
      { smeltConfig: 1, rerank: { kind: 'voyage', model: '' } },
      { smeltConfig: 1, rerank: { kind: 'voyage', apiKeyEnv: 3 } },
      { smeltConfig: 1, rerank: { kind: 'voyage', nope: 1 } },
      { smeltConfig: 1, rerank: 'voyage' },
      { smeltConfig: 1, rerank: [] },
    ]) {
      expect(() => parseConfig(JSON.stringify(bad), 'x.json'), JSON.stringify(bad)).toThrow();
    }
  });

  it('no config at all is fine — flags alone are a complete interface', async () => {
    const { code } = await run(['--budget', '4000'], dir, corpus());
    expect(code).toBe(EXIT.ok);
  });

  it('still requires a budget when neither flag nor config has one, naming both fixes', async () => {
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/--budget is required/);
    expect(stderr).toContain('defaultBudgetBytes');
    expect(stderr).toContain('smelt init');
  });
});

describe('store.retention — a written-down cut-off, never a schedule', () => {
  /**
   * The key that supplies `smelt store prune`'s number when the user did not type one.
   * What is pinned here is the parse: the age is held to the same grammar the flag is,
   * an absent block is absent rather than a default, and a retention on a memory store
   * is refused rather than accepted as a setting that can never apply.
   */

  it('parses the block and defaults nothing it was not given', () => {
    const parsed = parseConfig(
      JSON.stringify({
        smeltConfig: 1,
        store: { kind: 'directory', path: '.smelt/store', retention: { olderThan: '30d' } },
      }),
      'x.json',
    );
    expect(parsed.store).toStrictEqual({
      kind: 'directory',
      path: '.smelt/store',
      retention: { olderThan: '30d' },
    });
  });

  it('carries keepRetrieved when it is written down', () => {
    const parsed = parseConfig(
      JSON.stringify({
        smeltConfig: 1,
        store: {
          kind: 'directory',
          path: 's',
          retention: { olderThan: '2w', keepRetrieved: true },
        },
      }),
      'x.json',
    );
    expect(parsed.store).toStrictEqual({
      kind: 'directory',
      path: 's',
      retention: { olderThan: '2w', keepRetrieved: true },
    });
  });

  it('holds the age to the same grammar the flag is held to', () => {
    for (const age of ['30d', '12h', '2w', '1h']) {
      expect(() =>
        parseConfig(
          JSON.stringify({
            smeltConfig: 1,
            store: { kind: 'directory', path: 's', retention: { olderThan: age } },
          }),
          'x.json',
        ),
      ).not.toThrow();
    }
    // And the refusal shows that grammar, exactly as `--older-than` does — one
    // spelling of "how old is old enough", refused the same way in both places.
    expect(() =>
      parseConfig(
        JSON.stringify({
          smeltConfig: 1,
          store: { kind: 'directory', path: 's', retention: { olderThan: '30 days' } },
        }),
        'x.json',
      ),
    ).toThrow(/<n>d, <n>h or <n>w/);
  });

  it('refuses a retention on a memory store rather than keeping a setting that cannot apply', () => {
    expect(() =>
      parseConfig(
        JSON.stringify({
          smeltConfig: 1,
          store: { kind: 'memory', retention: { olderThan: '30d' } },
        }),
        'x.json',
      ),
    ).toThrow(/"memory" takes no other keys/);
  });

  it('leaves the store shape alone when no retention is written', () => {
    const parsed = parseConfig(
      JSON.stringify({ smeltConfig: 1, store: { kind: 'directory', path: 's' } }),
      'x.json',
    );
    expect(parsed.store).toStrictEqual({ kind: 'directory', path: 's' });
  });
});

describe('the rerank opt-in', () => {
  /**
   * The one config key that can send a caller's source to a third party. What is
   * pinned here is the shape of the opt-in itself: an absent key does nothing at all,
   * a present one is loaded before the cut, and every way of naming something that is
   * not there is a refusal that names it — never a quiet fallback to an unranked run.
   */

  it('parses both kinds, and defaults nothing it was not given', () => {
    expect(
      parseConfig(
        JSON.stringify({ smeltConfig: 1, rerank: { kind: 'module', path: './r.ts' } }),
        'x.json',
      ).rerank,
    ).toEqual({ kind: 'module', path: './r.ts' });
    // `model` and `apiKeyEnv` have documented defaults, and they are applied at *load*
    // time, not baked into the parsed config: a parse that invented them would make
    // `renderConfig(parseConfig(x))` write keys the user never set.
    expect(
      parseConfig(JSON.stringify({ smeltConfig: 1, rerank: { kind: 'voyage' } }), 'x.json').rerank,
    ).toEqual({ kind: 'voyage' });
  });

  it('does nothing whatsoever when the key is absent', async () => {
    writeConfig(dir, { smeltConfig: 1, defaultBudgetBytes: 4000 });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.ok);
    expect(stderr).not.toContain('rerank');
  });

  it('loads a configured module stage, applies it, and attributes it in the report', async () => {
    // The whole path, through the real CLI: config → loader → ops → smelter → report.
    writeFileSync(
      join(dir, 'stage.mjs'),
      `export default {
         id: 'ignored-in-favour-of-the-path',
         async rerank(candidates) {
           return candidates.slice(0, 1).map((c) => ({ ...c, score: 1 }));
         },
       };\n`,
    );
    // Roomy on purpose: the budget rung is pinned in `rerank.test.ts`, and what this
    // test is about is the whole path reaching the report at all. A budget too tight to
    // afford the one region the stage asks for would assert that path through a run
    // where the stage's answer was refused, which is a different thing to prove.
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 8000,
      rerank: { kind: 'module', path: './stage.mjs' },
    });
    const { code, stderr } = await run(['--focus', 'handleRequest'], dir, corpus());
    expect([EXIT.ok, EXIT.overBudget]).toContain(code);
    expect(stderr).toMatch(
      /rerank {2}module\/\.\/stage\.mjs {2}\(\d+ candidates, 1 kept, [\d,]+ B back\)/,
    );
  });

  it('puts the same attribution inside the --json envelope, additively', async () => {
    writeFileSync(
      join(dir, 'stage.mjs'),
      `export default { id: 's', async rerank(c) { return c.slice(0, 1).map((x) => ({ ...x, score: 1 })); } };\n`,
    );
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 8000,
      rerank: { kind: 'module', path: './stage.mjs' },
    });
    const { stdout } = await run(['--focus', 'handleRequest', '--json'], dir, corpus());
    const envelope = JSON.parse(stdout) as { result: { rerank?: { adapter: string } } };
    expect(envelope.result.rerank).toEqual({
      adapter: 'module/./stage.mjs',
      candidates: expect.any(Number) as number,
      returned: 1,
      kept: 1,
      sparedBytes: expect.any(Number) as number,
      // The stage's own `.slice(0, 1)` ended the walk, and the receipt says so — the
      // envelope carries the reason, not just the counts.
      stopped: 'cap',
    });
  });

  it('refuses, exit 2, when the configured module is not there', async () => {
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 4000,
      rerank: { kind: 'module', path: './gone.mjs' },
    });
    const { code, stderr } = await run([], dir, corpus());
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('./gone.mjs');
  });

  it('a stage that throws exits like a refusal, not like a smelt bug', async () => {
    // The failure mode this pins: a reranker's ordinary failures (a timeout, a 401, an
    // unimplemented stub) throw plain Errors from the consumer's own adapter. Unwrapped,
    // they reach `bin.ts`'s last-resort handler — "unexpected internal error — this is a
    // bug, please report it", a stack trace, exit 4 — which blames smelt for somebody
    // else's API being down and sends the user to the wrong issue tracker.
    writeFileSync(
      join(dir, 'boom.mjs'),
      `export default {
         id: 'voyage',
         async rerank() { throw new Error('api.voyageai.com answered 401: invalid key'); },
       };\n`,
    );
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 800,
      rerank: { kind: 'module', path: './boom.mjs' },
    });
    const { code, stderr } = await run(['--focus', 'handleRequest'], dir, corpus());
    expect(code).toBe(EXIT.refused);
    expect(stderr).toContain('RerankStageError');
    expect(stderr).toContain('module/./boom.mjs');
    expect(stderr).toContain('answered 401');
    expect(stderr).not.toContain('please report it');
    expect(stderr).not.toContain('unexpected internal error');
  });

  it('refuses, naming the variable, when the voyage key is unset', async () => {
    writeConfig(dir, {
      smeltConfig: 1,
      defaultBudgetBytes: 4000,
      rerank: { kind: 'voyage', topK: 4, apiKeyEnv: 'SOME_KEY' },
    });
    const { code, stderr } = await run([], dir, corpus(), {});
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('SOME_KEY is not set');
    expect(stderr).not.toContain('unranked output.');
  });
});
