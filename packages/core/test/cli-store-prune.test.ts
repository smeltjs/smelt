import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_PRUNE_JSON_FORMAT, EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo, CliPruneJsonEnvelope } from '../src/cli/run.ts';
import { DirectoryElisionStore } from '../src/store-dir.ts';

/**
 * `smelt store prune` as a command — the parse, the refusals, the envelope and the
 * exit codes, in-process (the `runCli` pattern from `test/cli.test.ts`).
 *
 * The eviction law itself is `test/store-prune.test.ts` and, with its mutations,
 * `test/guards/store-prune.test.ts`. What is here is everything a user can type wrong,
 * and the one thing the verb must never do: prune without being asked to.
 */

const cwds: string[] = [];
afterEach(() => {
  for (const cwd of cwds.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

/** A scratch cwd whose `smelt.config.json` names a directory store inside it. */
function directoryStoreCwd(): { cwd: string; storePath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-prune-'));
  cwds.push(cwd);
  writeFileSync(
    join(cwd, 'smelt.config.json'),
    `${JSON.stringify({
      smeltConfig: 1,
      store: { kind: 'directory', path: '.smelt-store' },
    })}\n`,
  );
  return { cwd, storePath: join(cwd, '.smelt-store') };
}

/** A scratch cwd whose config names a memory store — the one prune must refuse. */
function memoryStoreCwd(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-prune-mem-'));
  cwds.push(cwd);
  writeFileSync(
    join(cwd, 'smelt.config.json'),
    `${JSON.stringify({ smeltConfig: 1, store: { kind: 'memory' } })}\n`,
  );
  return cwd;
}

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(argv: readonly string[], cwd: string): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIo = {
    stdout: (text) => void (stdout += text),
    stderr: (text) => void (stderr += text),
    stdin: () => '',
    version: '9.9.9-test',
    cwd,
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

const DAY = 24 * 60 * 60 * 1000;

/** One blob in the configured store, backdated so an age cut can reach it. */
function agedBlob(storePath: string, content: string, daysAgo: number): string {
  const hash = new DirectoryElisionStore(storePath).put(content);
  const when = new Date(Date.now() - daysAgo * DAY);
  utimesSync(join(storePath, 'blobs', hash), when, when);
  return hash;
}

describe('smelt store prune evicts what the user named, and reports it', () => {
  it('prunes by age and leaves the rest, printing what went', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const old = agedBlob(storePath, 'bytes elided a month ago', 30);
    const fresh = agedBlob(storePath, 'bytes elided today', 0);

    const { code, stdout } = await run(['store', 'prune', '--older-than', '7d'], cwd);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('scanned 2 blobs');
    expect(stdout).toContain('evicted 1');
    expect(stdout).toContain('kept 1');
    expect(stdout).toContain(old);
    expect(stdout).not.toContain(fresh);

    expect(readdirSync(join(storePath, 'blobs'))).toEqual([fresh]);
  });

  it('emits its own versioned envelope under --json', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const old = agedBlob(storePath, 'bytes elided a month ago', 30);

    const { code, stdout } = await run(['store', 'prune', '--older-than', '2w', '--json'], cwd);
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.format).toBe(CLI_PRUNE_JSON_FORMAT);
    expect(envelope.storePath).toBe(storePath);
    // What was asked for, beside what happened — a receipt records both.
    expect(envelope.olderThan).toBe('2w');
    expect(envelope.keepRetrieved).toBe(false);
    expect(envelope.prune).toMatchObject({ scanned: 1, kept: 0, dryRun: false });
    expect(envelope.prune.evicted).toHaveLength(1);
    expect(envelope.prune.evicted[0]?.hash).toBe(old);
    expect(envelope.prune.bytesFreed).toBe(Buffer.byteLength('bytes elided a month ago', 'utf8'));
  });

  it('--dry-run measures and deletes nothing', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const old = agedBlob(storePath, 'bytes that stay put', 30);

    const { code, stdout } = await run(
      ['store', 'prune', '--older-than', '1d', '--dry-run', '--json'],
      cwd,
    );
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.prune.dryRun).toBe(true);
    expect(envelope.prune.evicted.map((one) => one.hash)).toEqual([old]);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([old]);
  });

  it('--keep-retrieved spares what the model asked for back', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const asked = agedBlob(storePath, 'bytes retrieved once', 30);
    const ignored = agedBlob(storePath, 'bytes nobody wanted', 30);
    expect((await run(['retrieve', asked], cwd)).code).toBe(EXIT.ok);

    const { code, stdout } = await run(
      ['store', 'prune', '--older-than', '1d', '--keep-retrieved', '--json'],
      cwd,
    );
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.keepRetrieved).toBe(true);
    expect(envelope.prune.evicted.map((one) => one.hash)).toEqual([ignored]);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([asked]);
  });

  it('makes a later retrieve say "evicted", not "never elided" — exit 3 either way', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const old = agedBlob(storePath, 'bytes with a receipt', 30);
    await run(['store', 'prune', '--older-than', '1d'], cwd);

    const evicted = await run(['retrieve', old], cwd);
    expect(evicted.code).toBe(EXIT.refused);
    expect(evicted.stderr).toContain('EvictedHashError');
    expect(evicted.stderr).toContain('smelt store prune');
    expect(evicted.stdout).toBe('');

    const unknown = await run(['retrieve', 'feedfacefeedface'], cwd);
    expect(unknown.code).toBe(EXIT.refused);
    expect(unknown.stderr).toContain('UnknownHashError');
  });
});

describe('smelt store refuses what it cannot honestly do', () => {
  it('needs an action, and names the only one there is', async () => {
    const { cwd } = directoryStoreCwd();
    const bare = await run(['store'], cwd);
    expect(bare.code).toBe(EXIT.usage);
    expect(bare.stderr).toContain('store needs an action — prune');

    const wrong = await run(['store', 'clear'], cwd);
    expect(wrong.code).toBe(EXIT.usage);
    expect(wrong.stderr).toContain('"clear" is not it');
  });

  it('needs --older-than, and says why there is no default', async () => {
    const { cwd } = directoryStoreCwd();
    const { code, stderr } = await run(['store', 'prune'], cwd);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('needs --older-than');
    expect(stderr).toContain('stop being reversible');
    expect(stderr).toContain('<n>d, <n>h or <n>w');
  });

  // `=` rather than a space, so a value starting with a dash reaches this verb's own
  // refusal instead of parseArgs's "argument is ambiguous" — the grammar is what the
  // user needs to see, and it must be the same grammar for every malformed spelling.
  it.each([['30'], ['30 days'], ['0d'], ['-1d'], ['1.5d'], ['30m'], ['d'], ['']])(
    'refuses --older-than %j and shows the grammar',
    async (raw) => {
      const { cwd } = directoryStoreCwd();
      const { code, stderr } = await run(['store', 'prune', `--older-than=${raw}`], cwd);
      expect(code, raw).toBe(EXIT.usage);
      expect(stderr, raw).toContain('<n>d, <n>h or <n>w');
    },
  );

  it('takes no further arguments — the store to prune is the configured one', async () => {
    const { cwd } = directoryStoreCwd();
    const { code, stderr } = await run(
      ['store', 'prune', 'somewhere-else', '--older-than', '1d'],
      cwd,
    );
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('takes no further arguments');
  });

  it('refuses a memory store, exactly as retrieve and stats do', async () => {
    const cwd = memoryStoreCwd();
    const { code, stderr } = await run(['store', 'prune', '--older-than', '1d'], cwd);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('store prune needs a persistent store');
  });

  it('refuses when there is no config at all, rather than pruning something', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-prune-none-'));
    cwds.push(cwd);
    const { code, stderr } = await run(['store', 'prune', '--older-than', '1d'], cwd);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('needs a persistent store');
    // And it created nothing while refusing.
    expect(readdirSync(cwd)).toEqual([]);
  });
});

describe('nothing else in the CLI evicts anything', () => {
  it('leaves every blob alone across a smelt run, a retrieve and a stats', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const ancient = agedBlob(storePath, 'a blob from a year ago', 365);

    const corpus = Array.from({ length: 200 }, (_, i) => `line ${String(i)} padding`).join('\n');
    let stdout = '';
    await runCli(['--budget', '600'], {
      stdout: (text) => void (stdout += text),
      stderr: () => {},
      stdin: () => corpus,
      version: '9.9.9-test',
      cwd,
    });
    await run(['stats'], cwd);
    await run(['retrieve', ancient], cwd);

    // A year old, never retrieved until now, and still here: the only eviction in
    // smelt is the one a user types.
    expect(existsSync(join(storePath, 'blobs', ancient))).toBe(true);
  });
});
