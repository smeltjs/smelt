import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { DirectoryElisionStore } from '@guard/store-dir';

import type { GuardMutation } from './_mutations.ts';

/**
 * STORE-PRUNE GUARD — Law 3 where it is most easily lost: the one place smelt deletes.
 *
 * Law 3 says every elision is reversible and counted. A store that never forgets
 * satisfies it trivially; a store that can forget satisfies it only if forgetting is
 * itself explainable and counted. `smelt store prune` is the only eviction there is,
 * and it earns the right to exist through four properties — each of which reads as a
 * harmless simplification and each of which, gone, turns a reversible elision into a
 * quiet loss:
 *
 *   1. **It evicts only what the user's cut-off reaches.** A prune that ignored
 *      `--older-than` would delete a session's own working set the moment someone ran
 *      it to reclaim last month's disk.
 *   2. **A dry run deletes nothing.** The flag exists to be trusted before the real
 *      run; a `--dry-run` that unlinked would be the single worst bug in this file.
 *   3. **An evicted lookup is its own error.** `UnknownHashError` says "it was never
 *      elided" — a false statement about bytes the user themselves removed, and one
 *      the model cannot tell from a hallucinated hash.
 *   4. **The counters do not flatter themselves.** `elisionsStored` counts what was
 *      evicted, so pruning cannot raise the expansion rate by shrinking its own
 *      denominator.
 *
 * Mutations: `pnpm mutate` breaks each of the four in `store-dir.ts`; this file must go
 * red every time.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'smelt-prune-guard-'));
  roots.push(root);
  return root;
}

const DAY = 24 * 60 * 60 * 1000;

/** Backdate a blob so an age cut can reach it. */
function age(root: string, hash: string, days: number): void {
  const when = new Date(Date.now() - days * DAY);
  utimesSync(join(root, 'blobs', hash), when, when);
}

/** The name of what a call threw — errors here are distinguished by class, so by name. */
function errorName(fn: () => unknown): string {
  try {
    fn();
    return '(did not throw)';
  } catch (error) {
    return (error as Error).name;
  }
}

const WEEK_AGO = (): Date => new Date(Date.now() - 7 * DAY);

describe('the only eviction in smelt is the one a user asked for', () => {
  it('evicts what the cut-off reaches and nothing else', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const stale = store.put('elided a month ago');
    const current = store.put('elided this morning');
    age(root, stale, 30);

    const report = store.prune({ olderThan: WEEK_AGO(), keepRetrieved: false, dryRun: false });

    expect(report.evicted.map((one) => one.hash)).toEqual([stale]);
    expect(report.kept).toBe(1);
    // The working set is still here. A prune that ignored the cut-off would have taken
    // this blob too, and the user asked for last month's disk back, not this one.
    expect(store.retrieve(current)).toBe('elided this morning');
    expect(existsSync(join(root, 'blobs', current))).toBe(true);
    expect(existsSync(join(root, 'blobs', stale))).toBe(false);
  });

  it('deletes nothing at all in a dry run', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const stale = store.put('what a dry run only describes');
    age(root, stale, 30);

    const report = store.prune({ olderThan: WEEK_AGO(), keepRetrieved: false, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.evicted.map((one) => one.hash)).toEqual([stale]);

    // The bytes, the name, and the retrieval all survive. `--dry-run` is the flag a
    // user reaches for *before* trusting this command; one that deleted would be worse
    // than no dry run at all.
    expect(existsSync(join(root, 'blobs', stale))).toBe(true);
    expect(store.retrieve(stale)).toBe('what a dry run only describes');
    expect(readFileSync(join(root, 'retrievals.log'), 'utf8')).not.toContain('evict');
  });

  it('says "evicted", never "never existed", for a hash it deleted', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const stale = store.put('bytes the user deliberately removed');
    age(root, stale, 30);
    store.prune({ olderThan: WEEK_AGO(), keepRetrieved: false, dryRun: false });

    // The whole reason a prune is allowed to exist: the two absences stay two facts.
    expect(errorName(() => store.retrieve(stale))).toBe('EvictedHashError');
    expect(errorName(() => store.retrieve('feedfacefeedface'))).toBe('UnknownHashError');
    expect(() => store.retrieve(stale)).toThrow(/was evicted on .* by `smelt store prune`/);
    // And the receipt is on disk, so a later process says the same thing.
    expect(errorName(() => new DirectoryElisionStore(root).peek(stale))).toBe('EvictedHashError');
  });

  it('keeps the expansion rate exactly where the prune found it', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const asked = store.put('alpha');
    for (const [i, content] of ['beta', 'gamma', 'delta'].entries()) {
      age(root, store.put(content), 30 + i);
    }
    store.retrieve(asked);

    const before = store.stats();
    expect(before.elisionsStored).toBe(4);
    expect(before.expansionRate).toBe(0.25);

    const report = store.prune({ olderThan: WEEK_AGO(), keepRetrieved: false, dryRun: false });
    expect(report.evicted).toHaveLength(3);
    expect(readdirSync(join(root, 'blobs'))).toEqual([asked]);

    const after = store.stats();
    // One blob left on disk and one unique retrieval: a store that counted only what
    // it still holds would report an expansion rate of 1.0 — "every elision was asked
    // for back" — for a session in which three of four never were.
    expect(after.elisionsStored).toBe(before.elisionsStored);
    expect(after.expansionRate).toBe(before.expansionRate);
    expect(after.allElisionsRetrieved).toBe(false);
    // Only the number that measures the disk moved, and by exactly what was freed.
    expect(after.bytesStored).toBe(before.bytesStored - report.bytesFreed);
  });

  it('leaves the journal readable by a reader that predates evict lines', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const kept = store.put('kept', { rule: 'head-tail', explanation: 'x' });
    const gone = store.put('gone', { rule: 'head-tail', explanation: 'x' });
    store.retrieve(kept);
    age(root, gone, 30);
    store.prune({ olderThan: WEEK_AGO(), keepRetrieved: false, dryRun: false });

    // The two patterns a pre-evict reader folds with. An `evict` line must match
    // neither — the same skip a `put` line already relies on, and the reason a
    // directory pruned by this version reads as the same counters under the last one.
    const counter = /^(hit|miss|corrupt) ("(?:[^"\\]|\\.)*")$/u;
    const put = /^put ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/u;
    const evictions = readFileSync(join(root, 'retrievals.log'), 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('evict'));
    expect(evictions.length).toBeGreaterThan(0);
    for (const line of evictions) {
      expect(counter.test(line), line).toBe(false);
      expect(put.test(line), line).toBe(false);
    }
    // The ledger the fold produces is untouched: the rule did make that cut, and
    // nobody asked for it back — which is exactly the fact worth keeping.
    expect(store.ledger()).toEqual([{ rule: 'head-tail', stored: 2, retrieved: 1 }]);
  });

  it('refuses a cut-off it cannot read, rather than treating every blob as old', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('bytes an unreadable cut-off must not reach');

    // An Invalid Date's getTime() is NaN, and `mtimeMs >= NaN` is false for every blob
    // in the store — so a cut-off that cannot be read does not evict nothing, it evicts
    // everything. `--older-than 200000000d` produced exactly this Date, and emptied a
    // store written seconds earlier.
    expect(() =>
      store.prune({ olderThan: new Date(NaN), keepRetrieved: false, dryRun: false }),
    ).toThrow(/not a date/);
    expect(
      errorName(() =>
        store.prune({ olderThan: new Date(NaN), keepRetrieved: false, dryRun: false }),
      ),
    ).toBe('SmeltError');

    // Nothing was scanned, nothing was journalled, and the bytes are still here.
    expect(existsSync(join(root, 'blobs', hash))).toBe(true);
    expect(store.retrieve(hash)).toBe('bytes an unreadable cut-off must not reach');
    // A dry run is refused too: it reports what a real run *would* take, so a dry run
    // that answered "all of it" would be the same lie one command earlier.
    expect(() =>
      store.prune({ olderThan: new Date(NaN), keepRetrieved: false, dryRun: true }),
    ).toThrow(/not a date/);
  });

  it('spares a retrieved hash when asked, and only when asked', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const asked = store.put('material the model came back for');
    store.retrieve(asked);
    age(root, asked, 30);

    expect(
      store.prune({ olderThan: WEEK_AGO(), keepRetrieved: true, dryRun: false }).evicted,
    ).toEqual([]);
    expect(
      store
        .prune({ olderThan: WEEK_AGO(), keepRetrieved: false, dryRun: false })
        .evicted.map((one) => one.hash),
    ).toEqual([asked]);
  });
});

describe('nothing evicts on its own', () => {
  it('opens, puts, retrieves and reads stats over an ancient store without deleting a byte', () => {
    const root = newRoot();
    const first = new DirectoryElisionStore(root);
    const ancient = first.put('a blob from a year ago');
    age(root, ancient, 365);

    // Every path that touches this directory, short of the verb itself.
    const second = new DirectoryElisionStore(root);
    second.put('something new');
    second.stats();
    second.ledger();
    second.has(ancient);

    expect(existsSync(join(root, 'blobs', ancient))).toBe(true);
    expect(second.retrieve(ancient)).toBe('a blob from a year ago');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'prune-accepts-an-unreadable-cut-off',
    file: 'store-dir.ts',
    find: '    if (Number.isNaN(cutOff)) {',
    replace: '    if (false as boolean) {',
    why: 'the byte-deleter stops refusing a cut-off it cannot read — an Invalid Date makes every `mtimeMs >= NaN` false, so the scan reads "every blob is old enough" and empties the whole store, which is what `--older-than 200000000d` did before both halves of this were bounded',
  },
  {
    id: 'prune-ignores-older-than',
    file: 'store-dir.ts',
    find: '      if (journalFailed || retrieved.has(entry) || stat.mtimeMs >= cutOff) {',
    replace: '      if (journalFailed || retrieved.has(entry)) {',
    why: "the age cut stops being consulted — every blob in the store is evicted whatever the user typed, so `smelt store prune --older-than 30d` run to reclaim last month's disk takes this session's working set with it",
  },
  {
    id: 'prune-dry-run-deletes',
    file: 'store-dir.ts',
    find: '      if (options.dryRun) {\n        evicted.push(blob);',
    replace: '      if (false as boolean) {\n        evicted.push(blob);',
    why: '--dry-run unlinks — the flag a user reaches for to find out what a prune would do becomes the prune itself, which is the single worst outcome this verb can produce',
  },
  {
    id: 'evicted-reported-as-unknown',
    file: 'store-dir.ts',
    find: '      const evictedAt = this.#evictedAt(hash);\n      if (evictedAt !== undefined) throw new EvictedHashError(hash, evictedAt);\n      throw new UnknownHashError(hash);',
    replace: '      throw new UnknownHashError(hash);',
    why: 'a retrieval of a pruned hash goes back to claiming it was never elided — a false statement about bytes the user themselves deleted, and indistinguishable to the model from a hallucinated hash, which is exactly the distinction that made an eviction permissible at all',
  },
  {
    id: 'prune-shrinks-the-expansion-denominator',
    file: 'store-dir.ts',
    find: '    for (const hash of evicted) if (!onDisk.has(hash)) elisionsStored += 1;',
    replace: '',
    why: 'elisionsStored stops counting evicted hashes — the same numerator over a smaller denominator, so a prune raises the expansion rate for free and a store where three of four elisions were never asked for back reports that every one of them was',
  },
  {
    id: 'prune-never-journals-the-eviction',
    file: 'store-dir.ts',
    find: "      this.#appendLog('evict', entry, at);",
    replace: '',
    why: 'the eviction receipt is never written — the bytes go with no record, so the next lookup reports UnknownHashError and the loss is silent. It pins that the eviction is journalled at all; the *ordering* (journal, then unlink) is a crash-window property no in-process mutation can observe, and is argued in the prune doc rather than pinned here',
  },
];
