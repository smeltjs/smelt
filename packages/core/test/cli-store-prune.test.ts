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

/** A scratch cwd whose config also writes down the age a prune should cut at. */
function retentionCwd(retention: Record<string, unknown>): { cwd: string; storePath: string } {
  const cwd = mkdtempSync(join(tmpdir(), 'smelt-cli-prune-ret-'));
  cwds.push(cwd);
  writeFileSync(
    join(cwd, 'smelt.config.json'),
    `${JSON.stringify({
      smeltConfig: 1,
      store: { kind: 'directory', path: '.smelt-store', retention },
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

  it('says why nothing went, and does not blame age when the flag spared it', async () => {
    const { cwd, storePath } = directoryStoreCwd();
    const asked = agedBlob(storePath, 'bytes retrieved once, long ago', 30);
    await run(['retrieve', asked], cwd);

    const spared = await run(['store', 'prune', '--older-than', '1d', '--keep-retrieved'], cwd);
    expect(spared.code).toBe(EXIT.ok);
    // It was old enough. It was kept for the other reason, and the report must say so
    // rather than repeating a sentence that is now false.
    expect(spared.stdout).toContain('nothing was both old enough and unretrieved');
    expect(spared.stdout).not.toContain('nothing was old enough —');

    const young = await run(['store', 'prune', '--older-than', '365d'], cwd);
    expect(young.stdout).toContain('nothing was old enough —');
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

  it('needs an age from somewhere, and names both places it can be written', async () => {
    const { cwd } = directoryStoreCwd();
    const { code, stderr } = await run(['store', 'prune'], cwd);
    expect(code).toBe(EXIT.usage);
    // Both spellings, because with neither present the user has two ways to fix it and
    // the refusal that named only one used to send them back for the other.
    expect(stderr).toContain('--older-than');
    expect(stderr).toContain('store.retention');
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

  it('refuses an age further back than a date can go, without touching the store', async () => {
    // The reported bug, pinned at the CLI end: `200000000d` overflowed the Date range,
    // `new Date(Date.now() - ms)` became an Invalid Date, every `mtimeMs >= NaN` was
    // false, and a prune meant to reclaim last decade's disk emptied a store written
    // seconds earlier. Both ends refuse it now; this is the one a user meets.
    const { cwd, storePath } = directoryStoreCwd();
    const fresh = agedBlob(storePath, 'bytes written seconds ago', 0);

    for (const age of ['200000000d', '9999999999999999999w', '999999999999h']) {
      const { code, stderr } = await run(['store', 'prune', `--older-than=${age}`], cwd);
      expect(code, age).toBe(EXIT.usage);
      expect(stderr, age).toContain('further back than a date can go');
      // The ceiling it names is derived from the representable range, not invented.
      expect(stderr, age).toMatch(/At most \d+[dhw]\./u);
      expect(stderr, age).toContain('<n>d, <n>h or <n>w');
    }

    // The blob a broken cut-off would have taken is still there.
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([fresh]);
    expect((await run(['retrieve', fresh], cwd)).code).toBe(EXIT.ok);
  });

  it('accepts the largest age that is still a date', async () => {
    // The bound is a real limit rather than a round number somebody liked: an age just
    // inside the representable range still runs, so the refusal above cannot be a
    // blanket "big numbers are suspicious".
    const { cwd, storePath } = directoryStoreCwd();
    const fresh = agedBlob(storePath, 'bytes written seconds ago', 0);
    const furthest = Math.floor((Date.now() + 8_640_000_000_000_000) / (24 * 60 * 60 * 1000));
    const { code, stdout } = await run(
      ['store', 'prune', `--older-than=${String(furthest)}d`, '--json'],
      cwd,
    );
    expect(code).toBe(EXIT.ok);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    // A cut-off at the dawn of representable time reaches nothing, which is the honest
    // answer — and emphatically not "everything is older than this".
    expect(envelope.prune).toMatchObject({ scanned: 1, kept: 1, bytesFreed: 0 });
    expect(envelope.prune.evicted).toEqual([]);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([fresh]);
  });

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

describe('store.retention is the cut-off written down, and the flag still wins', () => {
  it('prunes at the configured age when no flag was typed, and says where it came from', async () => {
    const { cwd, storePath } = retentionCwd({ olderThan: '7d' });
    const old = agedBlob(storePath, 'bytes elided a month ago', 30);
    const fresh = agedBlob(storePath, 'bytes elided today', 0);

    const { code, stdout } = await run(['store', 'prune'], cwd);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('older than 7d');
    // The receipt names the file, because a prune that took more than expected has to
    // be traceable to whichever of the two spellings chose the number.
    expect(stdout).toContain('smelt.config.json: store.retention');
    expect(stdout).toContain(old);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([fresh]);
  });

  it('carries the provenance in the envelope too', async () => {
    const { cwd, storePath } = retentionCwd({ olderThan: '7d' });
    agedBlob(storePath, 'bytes elided a month ago', 30);

    const { stdout } = await run(['store', 'prune', '--json'], cwd);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.olderThan).toBe('7d');
    expect(envelope.olderThanSource).toBe('config');
  });

  it('lets --older-than override the configured age, and says the flag won', async () => {
    const { cwd, storePath } = retentionCwd({ olderThan: '1d' });
    const old = agedBlob(storePath, 'a fortnight old', 14);

    const { stdout } = await run(['store', 'prune', '--older-than', '365d', '--json'], cwd);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.olderThan).toBe('365d');
    expect(envelope.olderThanSource).toBe('flag');
    // The configured 1d would have taken it. The flag the user typed did not.
    expect(envelope.prune.evicted).toEqual([]);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([old]);
  });

  it('spares retrieved hashes when the config says so, without the flag', async () => {
    const { cwd, storePath } = retentionCwd({ olderThan: '1d', keepRetrieved: true });
    const asked = agedBlob(storePath, 'bytes retrieved once', 30);
    const ignored = agedBlob(storePath, 'bytes nobody wanted', 30);
    expect((await run(['retrieve', asked], cwd)).code).toBe(EXIT.ok);

    const { stdout } = await run(['store', 'prune', '--json'], cwd);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.keepRetrieved).toBe(true);
    expect(envelope.keepRetrievedSource).toBe('config');
    expect(envelope.prune.evicted.map((one) => one.hash)).toEqual([ignored]);
  });

  it('attributes the sparing as well as the age, in the header and the envelope', async () => {
    // "This kept blobs I never asked it to keep" is the question a receipt has to be
    // able to answer, and a header that only ever said "keeping retrieved" could not.
    const { cwd, storePath } = retentionCwd({ olderThan: '1d', keepRetrieved: true });
    const asked = agedBlob(storePath, 'bytes retrieved once', 30);
    await run(['retrieve', asked], cwd);

    const fromConfig = await run(['store', 'prune', '--dry-run'], cwd);
    expect(fromConfig.stdout).toContain('keeping retrieved (smelt.config.json: store.retention)');

    const fromBoth = await run(['store', 'prune', '--keep-retrieved', '--dry-run'], cwd);
    expect(fromBoth.stdout).toContain(
      'keeping retrieved (--keep-retrieved, and smelt.config.json: store.retention)',
    );
    const bothJson = await run(['store', 'prune', '--keep-retrieved', '--dry-run', '--json'], cwd);
    expect((JSON.parse(bothJson.stdout) as CliPruneJsonEnvelope).keepRetrievedSource).toBe('both');

    // A flag the user typed themselves needs no attribution, and a prune that spared
    // nothing says nothing about sparing.
    const { cwd: plain, storePath: plainStore } = directoryStoreCwd();
    const kept = agedBlob(plainStore, 'bytes retrieved once', 30);
    await run(['retrieve', kept], plain);
    const flagOnly = await run(
      ['store', 'prune', '--older-than', '1d', '--keep-retrieved', '--dry-run'],
      plain,
    );
    expect(flagOnly.stdout).toContain('keeping retrieved');
    expect(flagOnly.stdout).not.toContain('store.retention');
    const flagOnlyJson = await run(
      ['store', 'prune', '--older-than', '1d', '--keep-retrieved', '--dry-run', '--json'],
      plain,
    );
    expect((JSON.parse(flagOnlyJson.stdout) as CliPruneJsonEnvelope).keepRetrievedSource).toBe(
      'flag',
    );

    const none = await run(['store', 'prune', '--older-than', '1d', '--dry-run', '--json'], plain);
    expect((JSON.parse(none.stdout) as CliPruneJsonEnvelope).keepRetrievedSource).toBe('none');
  });

  it('keeps sparing when the flag supplies the age and the config supplies the mercy', async () => {
    // `--keep-retrieved` has no negative spelling, so the two are OR-ed: typing an age
    // must not silently delete more than the written-down policy asked for.
    const { cwd, storePath } = retentionCwd({ olderThan: '365d', keepRetrieved: true });
    const asked = agedBlob(storePath, 'bytes retrieved once', 30);
    const ignored = agedBlob(storePath, 'bytes nobody wanted', 30);
    expect((await run(['retrieve', asked], cwd)).code).toBe(EXIT.ok);

    const { stdout } = await run(['store', 'prune', '--older-than', '1d', '--json'], cwd);
    const envelope = JSON.parse(stdout) as CliPruneJsonEnvelope;
    expect(envelope.olderThanSource).toBe('flag');
    expect(envelope.keepRetrieved).toBe(true);
    expect(envelope.keepRetrievedSource).toBe('config');
    expect(envelope.prune.evicted.map((one) => one.hash)).toEqual([ignored]);
  });

  it('still refuses a memory store, retention or no retention', async () => {
    const cwd = memoryStoreCwd();
    const { code, stderr } = await run(['store', 'prune'], cwd);
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('store prune needs a persistent store');
  });

  it('changes nothing about what runs on its own: a written-down age prunes nothing', async () => {
    // The whole doctrine in one test. A config with a retention, a store full of
    // ancient blobs, and every other verb in the CLI run over it — nothing goes until
    // somebody types the verb.
    const { cwd, storePath } = retentionCwd({ olderThan: '1h' });
    const ancient = agedBlob(storePath, 'a blob from a year ago', 365);

    await run(['stats'], cwd);
    await run(['retrieve', ancient], cwd);
    await run(['doctor'], cwd);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([ancient]);

    const { code } = await run(['store', 'prune'], cwd);
    expect(code).toBe(EXIT.ok);
    expect(readdirSync(join(storePath, 'blobs'))).toEqual([]);
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
