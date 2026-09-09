import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { EvictedHashError, UnknownHashError } from '../src/errors.ts';
import { contentHash } from '../src/hash.ts';
import { DirectoryElisionStore } from '../src/store-dir.ts';

/**
 * Concurrency, with two REAL processes — not two promises.
 *
 * Two interleaved promises share one event loop and never actually race on the
 * filesystem, so they cannot prove the property that matters: that a second *process*
 * writing the same directory at the same time corrupts nothing. So this test spawns two
 * `node` subprocesses that hammer one store directory simultaneously — both putting the
 * same shared blobs (to force the atomic-publish race) and each putting and retrieving
 * private ones — then audits the directory from the parent with the real store.
 *
 * The subprocesses run the real implementation: `src/store-dir.ts` and the modules it
 * imports, emitted type-erased by this repo's own `tsc` into a scratch directory —
 * because the supported engine range (^20.19 || >=22.12) includes Node versions that
 * cannot run TypeScript directly.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const tscBin = fileURLToPath(new URL('../node_modules/.bin/tsc', import.meta.url));

/** Emit the store and its imports as plain ESM for `node`; return the emit directory. */
function emitStoreModule(scratch: string): string {
  const outDir = join(scratch, 'out');
  const tsconfigPath = join(scratch, 'tsconfig.json');
  writeFileSync(
    tsconfigPath,
    JSON.stringify({
      compilerOptions: {
        target: 'es2023',
        module: 'nodenext',
        moduleResolution: 'nodenext',
        allowImportingTsExtensions: true,
        rewriteRelativeImportExtensions: true,
        verbatimModuleSyntax: true,
        types: [],
        skipLibCheck: true,
        noCheck: true,
        noEmit: false,
        outDir,
        rootDir: srcDir,
      },
      files: [join(srcDir, 'store-dir.ts')],
    }),
  );
  const emit = spawnSync(tscBin, ['-p', tsconfigPath], { encoding: 'utf8' });
  if (emit.status !== 0) {
    throw new Error(`tsc failed to emit the worker's modules: ${emit.stdout}${emit.stderr}`);
  }
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }));
  return outDir;
}

const WORKER_SOURCE = `
import { DirectoryElisionStore } from './out/store-dir.js';

const [root, seed] = process.argv.slice(2);
const store = new DirectoryElisionStore(root);
const report = [];
for (let i = 0; i < 25; i += 1) {
  // Both workers put these exact bytes, concurrently: the atomic-publish race.
  const shared = 'shared blob ' + String(i) + ' — both workers write these exact bytes';
  const own = 'worker ' + seed + ' private blob ' + String(i) + ' with some padding bytes';
  const sharedHash = store.put(shared);
  const ownHash = store.put(own);
  if (store.retrieve(ownHash) !== own) throw new Error('retrieve returned wrong bytes');
  report.push({ sharedHash, shared, ownHash, own });
}
process.stdout.write(JSON.stringify(report));
`;

interface WorkerBlob {
  readonly sharedHash: string;
  readonly shared: string;
  readonly ownHash: string;
  readonly own: string;
}

function runWorker(
  workerPath: string,
  storeRoot: string,
  seed: string,
): Promise<readonly WorkerBlob[]> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerPath, storeRoot, seed], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(JSON.parse(stdout) as readonly WorkerBlob[]);
      else rejectPromise(new Error(`worker ${seed} exited ${String(code)}: ${stderr}`));
    });
  });
}

describe('DirectoryElisionStore under two real concurrent processes', () => {
  it('two processes writing one directory corrupt nothing and lose no counter', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smelt-two-process-'));
    roots.push(scratch);
    const storeRoot = join(scratch, 'store');
    const workerPath = join(scratch, 'worker.mjs');
    emitStoreModule(scratch);
    writeFileSync(workerPath, WORKER_SOURCE);

    // Launched together, unawaited until both are running: a genuine race, from the
    // concurrent creation of the store directory itself onward.
    const [a, b] = await Promise.all([
      runWorker(workerPath, storeRoot, 'A'),
      runWorker(workerPath, storeRoot, 'B'),
    ]);

    // Audit every blob file on disk: each must hash to its own name. A torn or
    // clobbered write would fail this for some file.
    const blobsDir = join(storeRoot, 'blobs');
    const blobFiles = readdirSync(blobsDir);
    for (const file of blobFiles) {
      expect(contentHash(readFileSync(join(blobsDir, file), 'utf8'))).toBe(file);
    }

    // 25 shared + 25 private each: 75 distinct blobs, every one still retrievable.
    const store = new DirectoryElisionStore(storeRoot);
    for (const blob of [...a, ...b]) {
      expect(store.peek(blob.sharedHash)).toBe(blob.shared);
      expect(store.peek(blob.ownHash)).toBe(blob.own);
    }

    // Counters merged across both processes: 25 successful retrieves per worker, none
    // lost to the concurrent appends — and all of it visible to this third process,
    // which never retrieved anything itself.
    const stats = store.stats();
    expect(blobFiles).toHaveLength(75);
    expect(stats.elisionsStored).toBe(75);
    expect(stats.retrieveCalls).toBe(50);
    expect(stats.uniqueRetrieved).toBe(50);
    expect(stats.misses).toBe(0);
    expect(stats.expansionRate).toBe(50 / 75);
    expect(stats.bytesStored).toBe(
      blobFiles.reduce((sum, file) => sum + statSync(join(blobsDir, file)).size, 0),
    );
  }, 60_000);
});

/**
 * The one race the prune ordering leaves open, run for real.
 *
 * `prune` journals `evict "<hash>"` and *then* unlinks, because the other order loses
 * information — bytes gone with no receipt read back as {@link UnknownHashError}, "it
 * never existed", for an elision the user themselves deleted. The order it does use can
 * leave the opposite state: another process `put`ting the same content between the
 * append and the unlink takes put's existing-blob fast path, gets the hash back, and
 * this loop then deletes the bytes underneath it.
 *
 * The store's own doc calls every outcome from there honest. This is that claim under
 * two real processes hammering one directory — one putting, one pruning everything old
 * enough, which with a cut-off in the future is everything:
 *
 *   - no blob file on disk is ever torn: each still hashes to its own name;
 *   - a hash a `put` returned is **never** {@link UnknownHashError}. That is the whole
 *     point of journalling first, and the one answer that would be a lie;
 *   - it is either the exact bytes, or an {@link EvictedHashError} that names the date;
 *   - and a re-`put` of the same content brings it back, because `retrieve` reads the
 *     blob before it reads the journal.
 */
const PRUNER_SOURCE = `
import { DirectoryElisionStore } from './out/store-dir.js';

const [root, want] = process.argv.slice(2);
const store = new DirectoryElisionStore(root);
// Until it has actually taken bytes the other process wrote (or a ceiling passes, so
// this can never hang a suite). A round count alone would let a slow start finish every
// round against an empty directory and call that a race.
const deadline = Date.now() + 20_000;
let evicted = 0;
while (evicted < Number(want) && Date.now() < deadline) {
  // A cut-off in the future: every blob on disk is old enough, so the loop is racing
  // the other process's puts for every byte it wrote.
  const report = store.prune({ olderThan: new Date(Date.now() + 3600_000), keepRetrieved: false, dryRun: false });
  evicted += report.evicted.length;
}
process.stdout.write(JSON.stringify({ evicted }));
`;

const PUTTER_SOURCE = `
import { DirectoryElisionStore } from './out/store-dir.js';

const [root, count] = process.argv.slice(2);
const store = new DirectoryElisionStore(root);
const put = [];
for (let i = 0; i < Number(count); i += 1) {
  const text = 'racing blob ' + String(i) + ' — put while another process prunes';
  put.push({ hash: store.put(text), text });
}
process.stdout.write(JSON.stringify(put));
`;

/** Run one worker script and return its parsed stdout. */
function runScript<T>(workerPath: string, args: readonly string[]): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [workerPath, ...args], { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString('utf8')));
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      if (code === 0) resolvePromise(JSON.parse(stdout) as T);
      else rejectPromise(new Error(`worker exited ${String(code)}: ${stderr}`));
    });
  });
}

describe('a put racing a prune, in two real processes', () => {
  it('never answers "it never existed" for bytes it took, and never serves wrong ones', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'smelt-prune-race-'));
    roots.push(scratch);
    const storeRoot = join(scratch, 'store');
    emitStoreModule(scratch);
    const putterPath = join(scratch, 'putter.mjs');
    const prunerPath = join(scratch, 'pruner.mjs');
    writeFileSync(putterPath, PUTTER_SOURCE);
    writeFileSync(prunerPath, PRUNER_SOURCE);

    // The store exists before either starts, so the pruner has a directory to walk
    // from its first round and the two overlap for the whole run.
    new DirectoryElisionStore(storeRoot).put('the blob that made the directory');

    const [put, pruned] = await Promise.all([
      runScript<readonly { hash: string; text: string }[]>(putterPath, [storeRoot, '400']),
      runScript<{ evicted: number }>(prunerPath, [storeRoot, '50']),
    ]);
    // The interleaving is what this case is about, so it is asserted rather than hoped
    // for: the pruner took bytes out while the putter was still putting them in.
    expect(pruned.evicted).toBeGreaterThanOrEqual(50);

    // Whatever survived is intact: a torn or half-published write fails this.
    const blobsDir = join(storeRoot, 'blobs');
    for (const file of readdirSync(blobsDir)) {
      expect(contentHash(readFileSync(join(blobsDir, file), 'utf8')), file).toBe(file);
    }

    const store = new DirectoryElisionStore(storeRoot);
    let evicted = 0;
    for (const blob of put) {
      try {
        // The bytes, exactly — a hash whose blob is still there always serves them,
        // because `retrieve` reads the blob before it reads the journal.
        expect(store.retrieve(blob.hash)).toBe(blob.text);
      } catch (error) {
        // Or the receipt. Never `UnknownHashError`: "it never existed" about bytes this
        // store took and this store deleted is the silent loss the ordering refuses.
        expect(error, blob.hash).toBeInstanceOf(EvictedHashError);
        expect((error as Error).message).toContain('was evicted on');
        expect((error as Error).message).toContain('smelt store prune');
        evicted += 1;

        // And it comes back: the same content re-put restores the blob and is served.
        expect(store.put(blob.text)).toBe(blob.hash);
        expect(store.retrieve(blob.hash)).toBe(blob.text);
      }
    }
    // And the putter is holding hashes whose bytes that prune took — which is the
    // state the whole case exists to ask about.
    expect(evicted).toBeGreaterThan(0);
  }, 60_000);
});

describe('the store root is pinned at construction', () => {
  it('resolves a relative root immediately, so a later chdir cannot re-target the store', () => {
    // A store constructed with `.smelt/store` and then a `process.chdir()` used to
    // start reading and writing a DIFFERENT directory: bytes put before the chdir
    // became unretrievable — indistinguishable from data loss — and new blobs landed
    // in a second store nobody asked for.
    const base = mkdtempSync(join(tmpdir(), 'smelt-chdir-base-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'smelt-chdir-elsewhere-'));
    roots.push(base, elsewhere);
    const original = process.cwd();
    try {
      process.chdir(base);
      const store = new DirectoryElisionStore('relative-store');
      const hash = store.put('bytes that must stay findable');

      process.chdir(elsewhere);
      expect(store.retrieve(hash)).toBe('bytes that must stay findable');
      const second = store.put('written after the chdir');
      expect(readFileSync(join(base, 'relative-store', 'blobs', second), 'utf8')).toBe(
        'written after the chdir',
      );
      expect(
        existsSync(join(elsewhere, 'relative-store')),
        'the chdir re-targeted the store to a second directory',
      ).toBe(false);
    } finally {
      process.chdir(original);
    }
  });
});

describe('a failed journal append never withholds bytes', () => {
  it('returns verified bytes when the journal is read-only, surfacing the counting failure as a warning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-ro-journal-'));
    roots.push(root);
    const store = new DirectoryElisionStore(root);
    const hash = store.put('intact, verified bytes');
    store.retrieve(hash); // a writable journal first, so the file exists to chmod
    const before = store.stats();
    expect(before.retrieveCalls).toBe(1);

    chmodSync(join(root, 'retrievals.log'), 0o444);
    try {
      // The load-bearing claim: intact, hash-verified bytes come back even though
      // the count cannot be written. Refusing here would turn a bookkeeping failure
      // into Law 3 breaking.
      const warned = new Promise<Error>((resolve) => process.once('warning', resolve));
      expect(store.retrieve(hash)).toBe('intact, verified bytes');
      const warning = await warned;
      expect(warning.name).toBe('SmeltCounterWriteFailure');
      expect(warning.message).toContain('retrievals.log');
      expect(warning.message).toContain('UNDER-report');

      // The count is honestly lost, not faked: stats still read the journal.
      expect(store.stats().retrieveCalls).toBe(before.retrieveCalls);

      // And a miss still reports the store's own error, never the journal's EACCES.
      const missWarned = new Promise<Error>((resolve) => process.once('warning', resolve));
      expect(() => store.retrieve('deadbeefdeadbeef')).toThrow(UnknownHashError);
      expect((await missWarned).name).toBe('SmeltCounterWriteFailure');
    } finally {
      chmodSync(join(root, 'retrievals.log'), 0o644);
    }

    // Journal writable again: counting resumes from where the journal left off.
    store.retrieve(hash);
    expect(store.stats().retrieveCalls).toBe(before.retrieveCalls + 1);
  });
});
