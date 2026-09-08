import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { EvictedHashError, UnknownHashError } from '../src/errors.ts';
import { DirectoryElisionStore, readStoreSize } from '../src/store-dir.ts';

/**
 * `smelt store prune` at the store level — the one eviction Law 3 allows.
 *
 * Every assertion here is about the difference between "the bytes are gone because you
 * asked" and every other reason a hash might not come back. The eviction is explicit
 * (a user typed the verb), journalled (`evict "<hash>" "<date>"`), and counted (the
 * expansion rate does not move because bytes left the disk) — and a retrieval of an
 * evicted hash is its own error, never {@link UnknownHashError}.
 *
 * The CLI half lives in `test/cli-store-prune.test.ts`; the law with its mutations is
 * `test/guards/store-prune.test.ts`.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'smelt-prune-'));
  roots.push(root);
  return root;
}

/** Backdate a blob's mtime — the store reads age off the file, not off the journal. */
function age(root: string, hash: string, msAgo: number): void {
  const when = new Date(Date.now() - msAgo);
  utimesSync(join(root, 'blobs', hash), when, when);
}

const DAY = 24 * 60 * 60 * 1000;

/** The journal's bytes — `''` when nothing has ever been journalled here. */
function journalText(root: string): string {
  return existsSync(join(root, 'retrievals.log'))
    ? readFileSync(join(root, 'retrievals.log'), 'utf8')
    : '';
}

/** The journal, as lines — the artefact an old reader would fold. */
function journal(root: string): readonly string[] {
  return journalText(root)
    .split('\n')
    .filter((line) => line !== '');
}

describe('prune evicts by age, and only by age', () => {
  it('evicts what is older than the cut and keeps what is not', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const old = store.put('bytes elided a fortnight ago');
    const fresh = store.put('bytes elided this morning');
    age(root, old, 14 * DAY);

    const report = store.prune({
      olderThan: new Date(Date.now() - 7 * DAY),
      keepRetrieved: false,
      dryRun: false,
    });

    expect(report.scanned).toBe(2);
    expect(report.kept).toBe(1);
    expect(report.dryRun).toBe(false);
    expect(report.evicted.map((one) => one.hash)).toEqual([old]);
    expect(report.bytesFreed).toBe(Buffer.byteLength('bytes elided a fortnight ago', 'utf8'));
    expect(report.evicted[0]?.bytes).toBe(report.bytesFreed);
    // The only timestamp the store holds for a blob is the file's own mtime.
    expect(report.evicted[0]?.putAt.slice(0, 10)).toBe(
      new Date(Date.now() - 14 * DAY).toISOString().slice(0, 10),
    );

    expect(store.retrieve(fresh)).toBe('bytes elided this morning');
    expect(readdirSync(join(root, 'blobs'))).toEqual([fresh]);
  });

  it('evicts nothing when nothing is old enough, and says so honestly', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    store.put('recent bytes');
    const report = store.prune({
      olderThan: new Date(Date.now() - 7 * DAY),
      keepRetrieved: false,
      dryRun: false,
    });
    expect(report).toMatchObject({ scanned: 1, kept: 1, bytesFreed: 0, evicted: [] });
    // Nothing evicted, nothing journalled: a no-op prune leaves no trace at all.
    expect(journal(root).filter((line) => line.startsWith('evict'))).toEqual([]);
  });

  it('keeps a retrieved hash under --keep-retrieved, however old it is', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const asked = store.put('bytes the model asked for back');
    const ignored = store.put('bytes nobody ever wanted');
    store.retrieve(asked);
    age(root, asked, 30 * DAY);
    age(root, ignored, 30 * DAY);

    const kept = store.prune({
      olderThan: new Date(Date.now() - 7 * DAY),
      keepRetrieved: true,
      dryRun: false,
    });
    expect(kept.evicted.map((one) => one.hash)).toEqual([ignored]);
    expect(kept.kept).toBe(1);
    expect(store.retrieve(asked)).toBe('bytes the model asked for back');

    // Without the flag, age is the only question asked.
    const all = store.prune({
      olderThan: new Date(Date.now() - 7 * DAY),
      keepRetrieved: false,
      dryRun: false,
    });
    expect(all.evicted.map((one) => one.hash)).toEqual([asked]);
  });
});

describe('a dry run is a measurement, not a deletion', () => {
  it('reports exactly what a real run would evict and writes not one byte', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const old = store.put('bytes that would go');
    age(root, old, 30 * DAY);
    const before = journalText(root);

    const dry = store.prune({
      olderThan: new Date(Date.now() - 7 * DAY),
      keepRetrieved: false,
      dryRun: true,
    });
    expect(dry.dryRun).toBe(true);
    expect(dry.evicted.map((one) => one.hash)).toEqual([old]);
    expect(dry.bytesFreed).toBe(Buffer.byteLength('bytes that would go', 'utf8'));

    // The bytes are still there, the journal is byte-identical, and the hash still
    // retrieves — a dry run that moved anything would be a dry run in name only.
    expect(readdirSync(join(root, 'blobs'))).toEqual([old]);
    expect(journalText(root)).toBe(before);
    expect(store.retrieve(old)).toBe('bytes that would go');
  });
});

describe('an eviction is journalled, and a lookup of it says so', () => {
  it('writes one `evict "<hash>" "<ISO date>"` line per blob it removed', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('bytes with a receipt');
    age(root, hash, 30 * DAY);
    store.prune({ olderThan: new Date(), keepRetrieved: false, dryRun: false });

    const evictions = journal(root).filter((line) => line.startsWith('evict'));
    expect(evictions).toHaveLength(1);
    expect(evictions[0]).toMatch(
      new RegExp(`^evict "${hash}" "\\d{4}-\\d{2}-\\d{2}T[\\d:.]+Z"$`, 'u'),
    );
  });

  it('distinguishes "you pruned it" from "it never existed"', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('bytes that were reversible until you pruned them');
    age(root, hash, 30 * DAY);
    store.prune({ olderThan: new Date(), keepRetrieved: false, dryRun: false });

    expect(() => store.retrieve(hash)).toThrow(EvictedHashError);
    expect(() => store.retrieve(hash)).toThrow(/was evicted on .* by `smelt store prune`/);
    expect(() => store.retrieve(hash)).toThrow(/the elision was reversible until then/);
    expect(() => store.retrieve('feedfacefeedface')).toThrow(UnknownHashError);
    expect(() => store.peek(hash)).toThrow(EvictedHashError);
    // has() answers the question it was asked — "can the next retrieve return bytes?"
    // — and the answer is no. The *reason* is retrieve's to tell, not a boolean's.
    expect(store.has(hash)).toBe(false);
    expect(store.has('feedfacefeedface')).toBe(false);
  });

  it('survives a restart: the eviction is on disk, not in memory', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('bytes evicted in an earlier process');
    age(root, hash, 30 * DAY);
    store.prune({ olderThan: new Date(), keepRetrieved: false, dryRun: false });

    expect(() => new DirectoryElisionStore(root).retrieve(hash)).toThrow(EvictedHashError);
  });

  it('serves the bytes again when a hash is re-put after its eviction', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const content = 'bytes elided twice, evicted once';
    const hash = store.put(content);
    age(root, hash, 30 * DAY);
    store.prune({ olderThan: new Date(), keepRetrieved: false, dryRun: false });
    expect(store.put(content)).toBe(hash);

    // The blob is what is asked for, so the blob is what answers: an evict line older
    // than the bytes on disk must never refuse bytes this store is holding right now.
    expect(store.retrieve(hash)).toBe(content);
    expect(store.has(hash)).toBe(true);
  });
});

describe('the counters stay honest across a prune', () => {
  it('keeps elisionsStored and the expansion rate exactly where they were', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const asked = store.put('alpha', { rule: 'head-tail', explanation: 'x' });
    const dropped = store.put('beta', { rule: 'head-tail', explanation: 'x' });
    store.retrieve(asked);
    age(root, dropped, 30 * DAY);

    const before = store.stats();
    const ledgerBefore = store.ledger();
    const report = store.prune({
      olderThan: new Date(Date.now() - 7 * DAY),
      keepRetrieved: false,
      dryRun: false,
    });
    const after = store.stats();

    // The denominator does not move. A prune that shrank elisionsStored would raise
    // the expansion rate for free — the metric flattering itself over bytes the user
    // deleted, which is precisely the silent failure Law 3's counters exist to refuse.
    expect(after.elisionsStored).toBe(before.elisionsStored);
    expect(after.expansionRate).toBe(before.expansionRate);
    expect(after.retrieveCalls).toBe(before.retrieveCalls);
    expect(after.uniqueRetrieved).toBe(before.uniqueRetrieved);
    expect(after.misses).toBe(before.misses);
    // The one number that does move is the one that measures the disk.
    expect(after.bytesStored).toBe(before.bytesStored - report.bytesFreed);
    // And the per-rule ledger is untouched: the rule still made that cut.
    expect(store.ledger()).toEqual(ledgerBefore);
  });

  it('counts a retrieval of an evicted hash as a miss — the model asked and got nothing', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('bytes that will be pruned');
    age(root, hash, 30 * DAY);
    store.prune({ olderThan: new Date(), keepRetrieved: false, dryRun: false });

    expect(() => store.retrieve(hash)).toThrow(EvictedHashError);
    const stats = store.stats();
    expect(stats.retrieveCalls).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.uniqueRetrieved).toBe(0);
  });
});

describe('an evict line is invisible to a reader that predates it', () => {
  it('is skipped by the counter fold and by the ledger fold alike', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const kept = store.put('kept bytes', { rule: 'head-tail', explanation: 'x' });
    const gone = store.put('gone bytes', { rule: 'head-tail', explanation: 'x' });
    store.retrieve(kept);
    age(root, gone, 30 * DAY);
    store.prune({ olderThan: new Date(Date.now() - 7 * DAY), keepRetrieved: false, dryRun: false });

    // The two patterns a reader written before `evict` existed folds with — the same
    // skip `put` lines already rely on (`test/ledger.test.ts`).
    const counter = /^(hit|miss|corrupt) ("(?:[^"\\]|\\.)*")$/u;
    const put = /^put ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/u;
    const lines = journal(root);
    expect(lines.some((line) => line.startsWith('evict'))).toBe(true);
    for (const line of lines.filter((one) => one.startsWith('evict'))) {
      expect(counter.test(line), line).toBe(false);
      expect(put.test(line), line).toBe(false);
    }
    // Which is exactly what the two folds this store ships do with them.
    expect(store.stats().retrieveCalls).toBe(1);
    expect(store.ledger()).toEqual([{ rule: 'head-tail', stored: 2, retrieved: 1 }]);
  });
});

describe('readStoreSize reads a store directory without becoming its author', () => {
  it('counts the blobs and their bytes, ignoring what is not one', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    store.put('one');
    store.put('two');
    writeFileSync(join(root, 'blobs', '.DS_Store'), 'finder dropping');
    expect(readStoreSize(root)).toEqual({ blobs: 2, bytes: 6 });
  });

  it('answers undefined for a directory that is not a store, and creates nothing', () => {
    const root = newRoot();
    expect(readStoreSize(join(root, 'never-made'))).toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });
});
