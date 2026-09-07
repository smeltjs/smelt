import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLI_STATS_JSON_FORMAT, cliUsage, EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo, CliJsonEnvelope, CliStatsJsonEnvelope } from '../src/cli/run.ts';
import { DirectoryElisionStore } from '../src/store-dir.ts';
import type { RetrieveStats } from '../src/types.ts';

/**
 * `smelt retrieve` and `smelt stats` — the marker's loop closed from a shell, end to
 * end and in-process (the `runCli` pattern from `test/cli.test.ts`). The counting
 * law itself — retrieve counted, stats not, exact bytes out — is also pinned in
 * `test/guards/expansion-counter.test.ts`, where mutations prove it can go red; this
 * file covers the subcommands' plumbing: parsing, store resolution, the envelope,
 * the exit codes, and the round trip from a smelt run to the bytes coming back.
 */

const cwds: string[] = [];

afterEach(() => {
  for (const cwd of cwds.splice(0)) rmSync(cwd, { recursive: true, force: true });
});

/** A scratch cwd whose `smelt.config.json` names a directory store inside it. */
function directoryStoreCwd(): { cwd: string; storePath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-retrieve-'));
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

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(argv: readonly string[], cwd: string, stdin = ''): Promise<Captured> {
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
  };
  const code = await runCli(argv, io);
  return { code, stdout, stderr };
}

/** Long enough that a small budget forces elisions. */
function corpus(): string {
  return Array.from({ length: 200 }, (_, i) => `line ${String(i)} padding padding`).join('\n');
}

/** One smelt run through the CLI, returning a hash and the bytes it keys. */
async function smeltOneHash(cwd: string): Promise<{ hash: string; bytes: string }> {
  const { code, stdout } = await run(['--budget', '600', '--json'], cwd, corpus());
  expect(code).toBe(EXIT.ok);
  const envelope = JSON.parse(stdout) as CliJsonEnvelope;
  expect(envelope.result.elisions.length).toBeGreaterThan(0);
  const hash = envelope.result.elisions[0]!.hash;
  return { hash, bytes: envelope.elided[hash]! };
}

function parseStatsLines(stdout: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    fields[line.slice(0, space)] = line.slice(space + 1);
  }
  return fields;
}

describe('smelt retrieve closes the marker loop from a shell', () => {
  it('round-trips: smelt --json → retrieve prints the exact bytes → stats counted it', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const { hash, bytes } = await smeltOneHash(cwd);

    const retrieved = await run(['retrieve', hash], cwd);
    expect(retrieved.code).toBe(EXIT.ok);
    // The exact original bytes, and nothing else on stdout: no report, no framing,
    // no newline the store did not hold.
    expect(retrieved.stdout).toBe(bytes);

    const stats = await run(['stats'], cwd);
    expect(stats.code).toBe(EXIT.ok);
    const fields = parseStatsLines(stats.stdout);
    expect(fields['retrieveCalls']).toBe('1');
    expect(fields['uniqueRetrieved']).toBe('1');
    expect(Number(fields['expansionRate'])).toBeGreaterThan(0);
    // The CLI reports the same numbers the library reads off the same directory.
    expect(new DirectoryElisionStore(storePath).stats().retrieveCalls).toBe(1);
    // And the ledger beside them: the rule every elision was cut by, and how many of
    // that rule's cuts were asked for back — one `rule.<id>.<count>` line each.
    expect(fields['rule.head-tail.stored']).toBe(
      String(new DirectoryElisionStore(storePath).stats().elisionsStored),
    );
    expect(fields['rule.head-tail.retrieved']).toBe('1');
  });

  it('is byte-exact for content with no trailing newline — fidelity, not convention', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const content = 'const x = 1; // no trailing newline';
    const hash = new DirectoryElisionStore(storePath).put(content);

    const { code, stdout } = await run(['retrieve', hash], cwd);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toBe(content);
    expect(stdout.endsWith('\n')).toBe(false);
  });

  it('exits 3 with the UnknownHashError message for a hash never elided', async () => {
    const { cwd } = directoryStoreCwd();
    const { code, stdout, stderr } = await run(['retrieve', 'deadbeefdeadbeef'], cwd);
    expect(code).toBe(EXIT.refused);
    expect(stdout).toBe('');
    expect(stderr).toContain('UnknownHashError');
    expect(stderr).toContain('no stored content for hash "deadbeefdeadbeef"');
  });

  it('exits 3 with the distinct StoreCorruptionError message for damaged bytes', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const { hash } = await smeltOneHash(cwd);

    // Tamper with the blob behind the store's back — bytes that no longer hash to
    // their name must be refused as corruption, never returned as a retrieval and
    // never conflated with "never existed".
    const blobsDir = join(storePath, 'blobs');
    expect(readdirSync(blobsDir)).toContain(hash);
    writeFileSync(join(blobsDir, hash), 'tampered bytes');

    const { code, stdout, stderr } = await run(['retrieve', hash], cwd);
    expect(code).toBe(EXIT.refused);
    expect(stdout).toBe('');
    expect(stderr).toContain('StoreCorruptionError');
    expect(stderr).toContain('damaged, not merely unknown');
    expect(stderr).not.toContain('UnknownHashError');
  });

  it('needs exactly one hash, and takes no flags', async () => {
    const { cwd } = directoryStoreCwd();

    const missing = await run(['retrieve'], cwd);
    expect(missing.code).toBe(EXIT.usage);
    expect(missing.stderr).toMatch(/retrieve needs exactly one hash/);

    const two = await run(['retrieve', 'aaaa', 'bbbb'], cwd);
    expect(two.code).toBe(EXIT.usage);

    const json = await run(['retrieve', 'aaaa', '--json'], cwd);
    expect(json.code).toBe(EXIT.usage);
    expect(json.stderr).toMatch(/retrieve takes no flags/);
  });
});

describe('smelt stats reads the counters without touching them', () => {
  it('prints one "name value" per line, greppable and in a stable order', async () => {
    const { cwd } = directoryStoreCwd();
    await smeltOneHash(cwd);

    const { code, stdout, stderr } = await run(['stats'], cwd);
    expect(code).toBe(EXIT.ok);
    expect(stderr).toBe('');
    const names = stdout
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => line.split(' ')[0]);
    expect(names).toEqual([
      'elisionsStored',
      'bytesStored',
      'retrieveCalls',
      'uniqueRetrieved',
      'expansionRate',
      'allElisionsRetrieved',
      // Then the ledger, one rule at a time (sorted by rule id), two facts per rule.
      'rule.head-tail.stored',
      'rule.head-tail.retrieved',
    ]);
    const fields = parseStatsLines(stdout);
    expect(Number(fields['elisionsStored'])).toBeGreaterThan(0);
    expect(fields['retrieveCalls']).toBe('0');
    expect(fields['expansionRate']).toBe('0');
    expect(fields['allElisionsRetrieved']).toBe('false');
  });

  it('does not count reading stats as a retrieval — observing must never move the metric', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const { hash } = await smeltOneHash(cwd);
    await run(['retrieve', hash], cwd);

    const first = await run(['stats'], cwd);
    const second = await run(['stats'], cwd);
    expect(second.stdout).toBe(first.stdout);
    expect(parseStatsLines(second.stdout)['retrieveCalls']).toBe('1');
    expect(new DirectoryElisionStore(storePath).stats().retrieveCalls).toBe(1);
  });

  it('--json emits the RetrieveStats verbatim in its own versioned envelope', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const { hash } = await smeltOneHash(cwd);
    await run(['retrieve', hash], cwd);

    const { code, stdout } = await run(['stats', '--json'], cwd);
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(stdout) as CliStatsJsonEnvelope;
    expect(envelope.format).toBe(CLI_STATS_JSON_FORMAT);

    // Field for field what the library itself reads off the same directory — the
    // CLI reshapes, renames and derives nothing.
    const expected: RetrieveStats = new DirectoryElisionStore(storePath).stats();
    expect(envelope.stats).toEqual(JSON.parse(JSON.stringify(expected)));
    // The ledger rides beside the stats, verbatim too, under its own key.
    expect(envelope.format).toBe('smelt-stats-cli/v2');
    expect(envelope.ledger).toEqual(new DirectoryElisionStore(storePath).ledger());
    expect(envelope.ledger.length).toBeGreaterThan(0);
  });

  it('takes only --json, and no positionals', async () => {
    const { cwd } = directoryStoreCwd();

    const positional = await run(['stats', 'extra'], cwd);
    expect(positional.code).toBe(EXIT.usage);
    expect(positional.stderr).toMatch(/stats takes no further arguments/);

    const budget = await run(['stats', '--budget', '4000'], cwd);
    expect(budget.code).toBe(EXIT.usage);
    expect(budget.stderr).toMatch(/stats takes only --json/);
  });
});

describe('both subcommands refuse a store that cannot span runs', () => {
  const COMMANDS: readonly (readonly string[])[] = [['retrieve', 'deadbeefdeadbeef'], ['stats']];

  it.each(COMMANDS)(
    'with a memory-store config, `%s` is a usage error naming smelt init',
    async (...argv) => {
      const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-memory-'));
      cwds.push(cwd);
      writeFileSync(
        join(cwd, 'smelt.config.json'),
        `${JSON.stringify({ smeltConfig: 1, store: { kind: 'memory' } })}\n`,
      );

      const { code, stderr } = await run(argv, cwd);
      expect(code).toBe(EXIT.usage);
      expect(stderr).toMatch(/needs a persistent store/);
      expect(stderr).toMatch(/uses a memory store/);
      expect(stderr).toContain('`smelt init`');
    },
  );

  it.each(COMMANDS)('with no config at all, `%s` is the same usage error', async (...argv) => {
    const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-noconfig-'));
    cwds.push(cwd);

    const { code, stderr } = await run(argv, cwd);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toMatch(/needs a persistent store/);
    expect(stderr).toMatch(/no smelt\.config\.json here/);
    expect(stderr).toContain('`smelt init`');
  });
});

describe('the help text documents the loop', () => {
  it('names both subcommands and states that the marker\'s retrieve("hash") is this command', () => {
    const usage = cliUsage();
    expect(usage).toContain('smelt retrieve <hash>');
    expect(usage).toContain('smelt stats [--json]');
    expect(usage).toContain(`the marker's retrieve("hash") is this command`);
    expect(usage).toContain('NOT counted as a retrieval');
  });
});
