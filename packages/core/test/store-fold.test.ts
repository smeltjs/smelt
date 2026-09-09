import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { ruleLedger } from '../src/stats.ts';
import type { RawRetrieveCounters } from '../src/stats.ts';
import { DirectoryElisionStore, readStoreSize } from '../src/store-dir.ts';
import type { RuleLedgerEntry } from '../src/types.ts';

/**
 * ONE FOLD, THE SAME NUMBERS.
 *
 * `smelt stats` — which the Stop hook runs at the end of every session — used to walk
 * a store three times: `rawCounters()` (a `readdir` plus a `stat` per blob, then the
 * whole journal), `ledger()` (the whole journal again) and `readStoreSize()` (the
 * `readdir` and the `stat`s again). `survey()` answers all three in one traversal.
 *
 * The change is pure locality — no cache, no new state, nothing derived differently —
 * so the property that matters is that **nothing moved**. The oracle below is the old
 * three-traversal implementation, transcribed, and the fixture is deliberately full of
 * the cases where a fold is easy to get subtly wrong: a hash put under two rules, a
 * hash put twice under one, an evicted hash, an evicted hash that came back, a miss, a
 * corrupt read, a torn journal tail from a crash, and a `.DS_Store` sitting in
 * `blobs/`.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const KEY_PATTERN = /^[0-9a-f]{4,128}$/;
const LOG_LINE = /^(hit|miss|corrupt) ("(?:[^"\\]|\\.)*")$/;
const PUT_LINE = /^put ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;
const EVICT_LINE = /^evict ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;

/** `rawCounters()` as it was before the fold — a blob scan, then a journal fold. */
function oracleCounters(root: string): RawRetrieveCounters {
  let elisionsStored = 0;
  let bytesStored = 0;
  const onDisk = new Set<string>();
  for (const entry of readdirSync(join(root, 'blobs'))) {
    if (!KEY_PATTERN.test(entry)) continue;
    onDisk.add(entry);
    elisionsStored += 1;
    bytesStored += statSync(join(root, 'blobs', entry)).size;
  }

  let retrieveCalls = 0;
  let misses = 0;
  const hits = new Set<string>();
  const evicted = new Set<string>();
  for (const line of readLog(root).split('\n')) {
    const evict = EVICT_LINE.exec(line);
    if (evict !== null) {
      evicted.add(JSON.parse(evict[1]!) as string);
      continue;
    }
    const match = LOG_LINE.exec(line);
    if (match === null) continue;
    retrieveCalls += 1;
    if (match[1] === 'miss') misses += 1;
    else if (match[1] === 'hit') hits.add(JSON.parse(match[2]!) as string);
  }
  for (const hash of evicted) if (!onDisk.has(hash)) elisionsStored += 1;

  return { elisionsStored, bytesStored, retrieveCalls, uniqueRetrieved: hits.size, misses };
}

/** `ledger()` as it was before the fold — its own pass over the same journal. */
function oracleLedger(root: string): readonly RuleLedgerEntry[] {
  const puts: { hash: string; rule: string }[] = [];
  const hits = new Set<string>();
  for (const line of readLog(root).split('\n')) {
    const put = PUT_LINE.exec(line);
    if (put !== null) {
      puts.push({ hash: JSON.parse(put[1]!) as string, rule: JSON.parse(put[2]!) as string });
      continue;
    }
    const counter = LOG_LINE.exec(line);
    if (counter !== null && counter[1] === 'hit') hits.add(JSON.parse(counter[2]!) as string);
  }
  return ruleLedger(puts, hits);
}

function readLog(root: string): string {
  try {
    return readFileSync(join(root, 'retrievals.log'), 'utf8');
  } catch {
    return '';
  }
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * A store carrying every shape the journal and the blob directory can hold. Returned
 * with the hashes, so the assertions can name them.
 */
function fixtureStore(): { root: string; store: DirectoryElisionStore } {
  const root = mkdtempSync(join(tmpdir(), 'smelt-fold-'));
  roots.push(root);
  const store = new DirectoryElisionStore(root);

  const kept = store.put('a blob the model came back for', {
    rule: 'head-tail',
    explanation: 'x',
  });
  // The same hash under a second rule: both rules did make that cut.
  store.put('a blob the model came back for', { rule: 'focus-window', explanation: 'x' });
  const twice = store.put('a blob put under one rule twice', {
    rule: 'head-tail',
    explanation: 'x',
  });
  store.put('a blob put under one rule twice', { rule: 'head-tail', explanation: 'x' });
  const unloved = store.put('a blob nobody asked for', {
    rule: 'sibling-collapse',
    explanation: 'x',
  });
  const returning = store.put('a blob evicted and put back', {
    rule: 'head-tail',
    explanation: 'x',
  });
  const anonymous = store.put('a blob put with no rule at all');

  store.retrieve(kept);
  store.retrieve(kept); // twice: retrieveCalls moves, uniqueRetrieved does not
  store.retrieve(twice);
  try {
    store.retrieve('feedfacefeedface'); // a miss
  } catch {
    /* the miss is the point */
  }

  // A corrupt blob: the bytes on disk stop hashing to their name.
  const damaged = store.put('a blob about to be damaged', { rule: 'json-fold', explanation: 'x' });
  writeFileSync(join(root, 'blobs', damaged), 'not what this hash promises');
  try {
    store.retrieve(damaged);
  } catch {
    /* the corrupt line is the point */
  }

  // Two evictions: one that stays gone, one whose content is put back afterwards.
  for (const hash of [unloved, returning]) {
    const when = new Date(Date.now() - 30 * DAY);
    utimesSync(join(root, 'blobs', hash), when, when);
  }
  store.prune({ olderThan: new Date(Date.now() - 7 * DAY), keepRetrieved: false, dryRun: false });
  store.put('a blob evicted and put back', { rule: 'head-tail', explanation: 'x' });

  // A torn tail from a crash mid-append, and a stray file that is not a blob.
  appendFileSync(join(root, 'retrievals.log'), '\nhit "half a li');
  writeFileSync(join(root, 'blobs', '.DS_Store'), 'not a blob');

  expect(anonymous).not.toBe('');
  return { root, store };
}

describe('one traversal answers the counters, the ledger and the size', () => {
  it('agrees with the three-traversal implementation, field for field', () => {
    const { root, store } = fixtureStore();
    const survey = store.survey();

    expect(survey.counters).toStrictEqual(oracleCounters(root));
    expect(survey.ledger).toStrictEqual(oracleLedger(root));
    expect(survey.size).toStrictEqual(readStoreSize(root));
  });

  it('leaves the three published interfaces answering exactly what they did', () => {
    const { root, store } = fixtureStore();

    expect(store.rawCounters()).toStrictEqual(oracleCounters(root));
    expect(store.ledger()).toStrictEqual(oracleLedger(root));
    // `stats()` is the derived half over the same counters — the arithmetic is
    // `retrieveStats`'s and is not this fold's to change.
    const stats = store.stats();
    const raw = oracleCounters(root);
    expect(stats).toMatchObject(raw);
    expect(stats.expansionRate).toBe(raw.uniqueRetrieved / raw.elisionsStored);
  });

  it('carries a fixture store byte-identically across the change', () => {
    // The numbers themselves, restated by hand: an equivalence proved only against a
    // transcribed oracle proves the two implementations agree, not that either is
    // right. These are what a reader can check against the fixture above.
    const { store } = fixtureStore();
    const survey = store.survey();

    // Six distinct contents put; two were evicted, one of which came back. So five
    // blobs on disk beside the `.DS_Store`, and six elisions still counted.
    expect(survey.size.blobs).toBe(5);
    expect(survey.counters.elisionsStored).toBe(6);
    // Three hits (one hash twice), one miss, one corrupt: five journalled calls.
    expect(survey.counters.retrieveCalls).toBe(5);
    expect(survey.counters.uniqueRetrieved).toBe(2);
    expect(survey.counters.misses).toBe(1);
    expect(survey.ledger).toStrictEqual([
      { rule: 'focus-window', stored: 1, retrieved: 1 },
      { rule: 'head-tail', stored: 3, retrieved: 2 },
      { rule: 'json-fold', stored: 1, retrieved: 0 },
      { rule: 'sibling-collapse', stored: 1, retrieved: 0 },
    ]);
    // The pruned rows are still there: the rule did make that cut, and nobody asked
    // for it back. That is exactly the fact the ledger exists to keep.
    expect(survey.ledger.find((row) => row.rule === 'sibling-collapse')?.stored).toBe(1);
  });

  it('answers the ledger from the journal alone — no blob scan on the per-run path', () => {
    // `smelter.ts` asks for the ledger on *every* smelt run, to hand planners
    // `PlanInput.ruleHistory`. Every fact in it comes out of `retrievals.log`, so a
    // `ledger()` routed through the whole survey would make each run `readdir` blobs/
    // and `stat` every file in it to answer a question about a log — the entire cost of
    // the survey spent on none of its answers.
    //
    // Proved by taking `blobs/` away: a scan of it cannot succeed, and the ledger still
    // does. The `survey()` assertion is what keeps this non-vacuous — it shows the
    // directory really is gone and a scan really would have failed.
    const { root, store } = fixtureStore();
    const expected = store.ledger();
    expect(expected.length).toBeGreaterThan(0);

    rmSync(join(root, 'blobs'), { recursive: true, force: true });

    expect(store.ledger()).toStrictEqual(expected);
    expect(() => store.survey()).toThrow();
  });

  it('answers an empty store without inventing anything', () => {
    const root = mkdtempSync(join(tmpdir(), 'smelt-fold-empty-'));
    roots.push(root);
    const store = new DirectoryElisionStore(root);

    expect(store.survey()).toStrictEqual({
      counters: {
        elisionsStored: 0,
        bytesStored: 0,
        retrieveCalls: 0,
        uniqueRetrieved: 0,
        misses: 0,
      },
      ledger: [],
      size: { blobs: 0, bytes: 0 },
    });
  });
});
