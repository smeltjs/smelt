import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterAll, describe, expect, it } from 'vitest';

import { DirectoryElisionStore } from '@guard/store-dir';
import { contentHash } from '@guard/hash';

import type { GuardMutation } from './_mutations.ts';

/**
 * PERSISTENT-STORE GUARD — Law 3, across a process boundary.
 *
 * A persistent store earns its keep on exactly the promises that are easiest to fake:
 * that a damaged blob is *refused* rather than returned (a torn write handed back as a
 * retrieval is the silent wrong answer this library exists to refuse), that the
 * retrieval counters survive a restart (an expansion rate that resets to a flattering
 * zero every process is no rate at all), and that "we hold damaged bytes" is
 * distinguishable from "never existed".
 *
 * The store keeps no state in memory — every read comes off the disk — so a second
 * instance over the same directory *is* the restart case, byte for byte. The real
 * two-process concurrency test lives in `test/store-dir.test.ts`; this guard stays
 * cheap because `pnpm mutate` runs it repeatedly.
 *
 * It also pins the **one fold**. The counters, the per-rule ledger and the store's own
 * size come out of a single traversal (`survey()`), because `smelt stats` — which the
 * Stop hook runs at the end of every session — used to walk the same two files three
 * times to answer them. Collapsing three reads into one is the kind of change that
 * loses an answer silently: the numbers that survive still look right, and the one that
 * went quiet reads as "no rule cut anything", which is indistinguishable from a store
 * nobody used.
 *
 * Mutations: `pnpm mutate` disables the verify-on-read branch, drops the journal
 * append, and drops the ledger out of the fold in `store-dir.ts`; this file must go red
 * every time.
 */

const roots: string[] = [];

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'smelt-persistent-guard-'));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The name of what a call threw — errors here are distinguished by class, so by name. */
function errorName(fn: () => unknown): string {
  try {
    fn();
    return '(did not throw)';
  } catch (error) {
    return (error as Error).name;
  }
}

/** A deliberately colliding "hash": the collision branch is unreachable with sha256. */
const collide = (): string => 'aaaaaaaaaaaaaaaa';

describe('the persistent store keeps Law 3 across restarts', () => {
  it('retrieval counters survive a restart, so the expansion rate stays meaningful', () => {
    const root = newRoot();
    const before = new DirectoryElisionStore(root);
    const kept = before.put('alpha content that was elided');
    before.put('beta content that was elided');
    before.retrieve(kept);
    expect(() => before.retrieve('deadbeefdeadbeef')).toThrow(/no stored content/);

    // A fresh instance over the same directory reads the same disk state — the store
    // holds nothing in memory, so this is exactly what a process restart sees.
    const after = new DirectoryElisionStore(root);
    expect(after.stats()).toMatchObject({
      elisionsStored: 2,
      retrieveCalls: 2,
      uniqueRetrieved: 1,
      misses: 1,
      expansionRate: 0.5,
      allElisionsRetrieved: false,
    });
    expect(after.retrieve(kept)).toBe('alpha content that was elided');
    expect(after.stats().retrieveCalls).toBe(3);
  });

  it('verifies bytes against the hash on read: a damaged blob is refused, loudly', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('the original bytes, exactly as elided');

    // Damage the blob behind the store's back — what a torn or tampered write leaves.
    writeFileSync(join(root, 'blobs', hash), 'not the original bytes at all');

    expect(() => store.retrieve(hash)).toThrow(/do not hash to/);
    expect(() => store.peek(hash)).toThrow(/do not hash to/);
  });

  it('distinguishes "we hold damaged bytes" from "never existed"', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('content that will be damaged');
    writeFileSync(join(root, 'blobs', hash), 'damaged');

    expect(errorName(() => store.retrieve(hash))).toBe('StoreCorruptionError');
    expect(errorName(() => store.retrieve('feedfacefeedface'))).toBe('UnknownHashError');
    // A re-put of the original content sees damaged bytes under its hash: that is
    // corruption, and must never be misreported as a hash collision.
    expect(errorName(() => store.put('content that will be damaged'))).toBe('StoreCorruptionError');
  });

  /**
   * `has()` is the cheap question a consumer asks *before* the expensive one, so its
   * answer has to mean the same thing. It used to skip verification while `peek()` and
   * `retrieve()` re-hashed: a damaged blob answered `true` and then threw on the next
   * line, which is a lie told by the call whose whole job is to prevent that throw.
   */
  it('answers has() with the same verification retrieve() does, so a check cannot lie', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('the bytes a consumer will check for before retrieving');
    expect(store.has(hash)).toBe(true);

    writeFileSync(join(root, 'blobs', hash), 'damaged behind the store’s back');

    // Not `true` — the answer that would send a consumer straight into the throw.
    expect(errorName(() => store.has(hash))).toBe('StoreCorruptionError');
    expect(errorName(() => store.peek(hash))).toBe('StoreCorruptionError');
    expect(errorName(() => store.retrieve(hash))).toBe('StoreCorruptionError');
    // And damage stays distinct from absence here too: a hash never stored is `false`,
    // not an error, exactly as `peek()` returns undefined rather than throwing.
    expect(store.has('feedfacefeedface')).toBe(false);
  });

  it('does not count a check as a retrieval, damaged or not', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const kept = store.put('bytes that stay intact');
    const damaged = store.put('bytes that will be damaged');
    writeFileSync(join(root, 'blobs', damaged), 'damaged');

    store.has(kept);
    expect(errorName(() => store.has(damaged))).toBe('StoreCorruptionError');
    // A check journals nothing: counting one would inflate retrieveCalls, and with it
    // the expansion rate — the number this library exists to keep honest.
    expect(store.stats()).toMatchObject({ retrieveCalls: 0, misses: 0, uniqueRetrieved: 0 });
  });

  it('a torn journal tail costs only its own record, never the next one', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hash = store.put('content whose retrieval must still be counted');
    store.retrieve(hash);
    // What a crash mid-append leaves: a partial record with no trailing newline.
    appendFileSync(join(root, 'retrievals.log'), 'hit "aaaa');

    store.retrieve(hash);
    expect(store.stats()).toMatchObject({ retrieveCalls: 2, uniqueRetrieved: 1, misses: 0 });
  });

  it('refuses a hash collision, including one discovered only after a restart', () => {
    const root = newRoot();
    const first = new DirectoryElisionStore(root, { hash: collide });
    first.put('one blob');
    expect(() => first.put('a different blob')).toThrow(/hash collision/);

    const second = new DirectoryElisionStore(root, { hash: collide });
    expect(() => second.put('yet another different blob')).toThrow(/hash collision/);
    expect(second.put('one blob')).toBe('aaaaaaaaaaaaaaaa'); // identical bytes dedupe
  });

  it('refuses a store directory whose format it does not understand', () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-persistent-guard-'));
    roots.push(root);
    writeFileSync(
      join(root, 'format.json'),
      JSON.stringify({ format: 'smelt-elision-store', version: 999 }),
    );
    expect(() => new DirectoryElisionStore(root)).toThrow(/version 999/);
    // Refused before mutated: the unrecognized directory gains no blobs/ or tmp/.
    expect(existsSync(join(root, 'blobs'))).toBe(false);
    expect(existsSync(join(root, 'tmp'))).toBe(false);
  });

  it('ignores what is not a blob: staging leftovers and finder droppings', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    store.put('the one real blob');
    // A torn write dies in tmp/; a .DS_Store is not content. Neither is an elision.
    writeFileSync(join(root, 'tmp', '12345-deadbeef'), 'torn write remnant');
    writeFileSync(join(root, 'blobs', '.DS_Store'), 'finder dropping');
    expect(store.stats().elisionsStored).toBe(1);
    expect(store.stats().bytesStored).toBe(Buffer.byteLength('the one real blob', 'utf8'));
  });

  it('never treats a hash as a path: traversal-shaped hashes are simply unknown', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    mkdirSync(join(root, 'outside'), { recursive: true });
    writeFileSync(join(root, 'outside', 'secret'), 'bytes outside the store');
    expect(store.has('../outside/secret')).toBe(false);
    expect(store.peek('../outside/secret')).toBeUndefined();
    expect(() => store.retrieve('../outside/secret')).toThrow(/no stored content/);
  });

  it('still holds everything ever put — nothing evicts but the prune verb', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const hashes = Array.from({ length: 50 }, (_, i) =>
      store.put(`elided blob number ${String(i)}`),
    );
    const reopened = new DirectoryElisionStore(root);
    for (const [i, hash] of hashes.entries()) {
      expect(reopened.retrieve(hash)).toBe(`elided blob number ${String(i)}`);
      expect(hash).toBe(contentHash(`elided blob number ${String(i)}`));
    }
    expect(reopened.stats().elisionsStored).toBe(50);
  });

  it('answers the counters, the ledger and the size from one traversal', () => {
    const root = newRoot();
    const store = new DirectoryElisionStore(root);
    const asked = store.put('material the model came back for', {
      rule: 'head-tail',
      explanation: 'x',
    });
    store.put('material nobody wanted', { rule: 'sibling-collapse', explanation: 'x' });
    store.retrieve(asked);

    const survey = store.survey();
    // All three, out of the same pass. A fold that dropped the ledger would leave the
    // counters looking perfectly right while `smelt stats` reported that no rule ever
    // cut anything — the same output a store nobody has used produces.
    expect(survey.ledger).toStrictEqual([
      { rule: 'head-tail', stored: 1, retrieved: 1 },
      { rule: 'sibling-collapse', stored: 1, retrieved: 0 },
    ]);
    expect(survey.counters.elisionsStored).toBe(2);
    expect(survey.counters.uniqueRetrieved).toBe(1);
    expect(survey.size.blobs).toBe(2);

    // And the three published interfaces are views over it, never a second reading
    // that could disagree with the first.
    expect(store.ledger()).toStrictEqual(survey.ledger);
    expect(store.rawCounters()).toStrictEqual(survey.counters);
    expect(store.stats()).toMatchObject(survey.counters);

    // Reading is still not counting: the survey journals nothing, so watching the
    // expansion rate cannot move it.
    expect(store.survey().counters).toStrictEqual(survey.counters);
  });

  it('sweeps a temp file a dead process leaked, and leaves a live one alone', () => {
    const root = newRoot();
    mkdirSync(join(root, 'tmp'), { recursive: true });

    // A pid guaranteed dead by the time this line returns: spawnSync blocks until the
    // child has already exited, so its temp file is exactly what a crash between
    // #writeTemp's fsync and its own cleanup would leak.
    const deadPid = spawnSync(process.execPath, ['-e', '0']).pid;
    if (deadPid === undefined) throw new Error('spawnSync did not report a pid');
    const leaked = `${String(deadPid)}-aaaaaaaaaaaaaaaa`;
    const inFlight = `${String(process.pid)}-bbbbbbbbbbbbbbbb`; // this test process: alive
    writeFileSync(join(root, 'tmp', leaked), 'orphaned by a crash');
    writeFileSync(join(root, 'tmp', inFlight), 'a write this process has not finished yet');

    const opened = new DirectoryElisionStore(root); // construction sweeps tmp/
    expect(opened).toBeInstanceOf(DirectoryElisionStore);

    expect(existsSync(join(root, 'tmp', leaked))).toBe(false);
    expect(existsSync(join(root, 'tmp', inFlight))).toBe(true);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'law3-dir-store-verify-skipped',
    file: 'store-dir.ts',
    find: "    if (this.#hash(content) !== hash) {\n      this.#appendLogCounting('corrupt', hash);",
    replace: "    if (false) {\n      this.#appendLogCounting('corrupt', hash);",
    why: 'verify-on-read disabled — a torn blob would be handed back as a faithful retrieval',
  },
  {
    id: 'law3-dir-store-counters-die-with-process',
    file: 'store-dir.ts',
    find: "    this.#appendLogCounting('hit', hash);",
    replace: "    // this.#appendLogCounting('hit', hash);",
    why: 'the retrieval journal never written — the expansion rate resets to a flattering zero on every restart',
  },
  {
    id: 'law3-dir-store-has-skips-verify',
    file: 'store-dir.ts',
    find: '    return this.peek(hash) !== undefined;',
    replace: '    return this.#readBlob(hash) !== undefined;',
    why: 'has() back to an existence check that skips the hash — a corrupt blob answers true and then throws StoreCorruptionError on the next line, so the consumer that checked first was told a lie by the call whose job was to prevent that throw',
  },
  {
    id: 'stats-fold-drops-the-ledger',
    file: 'store-dir.ts',
    find: '      ledger: ruleLedger(puts, hits),',
    replace: '      ledger: [],',
    why: 'the one traversal stops answering one of its three questions — the counters still look right and `smelt stats` reports that no rule ever cut anything, which is exactly what a store nobody used reports, so the per-rule half of Law 3\u2019s honesty goes quiet with no error anywhere',
  },
  {
    id: 'law3-dir-store-stale-temp-not-swept',
    file: 'store-dir.ts',
    find: '    this.#claimFormat(markerPath);\n    this.#sweepStaleTemp();',
    replace: '    this.#claimFormat(markerPath);',
    why: 'construction no longer sweeps tmp/ — a temp file a crashed process leaked accumulates on every later open instead of being discarded',
  },
];
