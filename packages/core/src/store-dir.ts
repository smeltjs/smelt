import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import process from 'node:process';

import {
  EvictedHashError,
  HashCollisionError,
  SmeltError,
  StoreCorruptionError,
  StoreFormatError,
  UnknownHashError,
} from './errors.ts';
import { contentHash } from './hash.ts';
import { retrieveStats, ruleLedger } from './stats.ts';
import type { RawRetrieveCounters } from './stats.ts';
import type { ElisionReason, ElisionStore, RetrieveStats, RuleLedgerEntry } from './types.ts';

/**
 * The format marker every store directory carries, and the one version this code
 * understands. A future layout is a new version, refused loudly by old code — never a
 * quiet reinterpretation of someone's stored bytes.
 */
export const DIRECTORY_STORE_FORMAT = 'smelt-elision-store';
export const DIRECTORY_STORE_VERSION = 1;

/**
 * What a storage key may look like. `contentHash` produces 16 lowercase hex characters;
 * the pattern is wider so an injected test hash still works, and strict enough that a
 * key can never traverse out of `blobs/` or collide with `format.json`.
 */
const KEY_PATTERN = /^[0-9a-f]{4,128}$/;

/** One counter line: a kind, a space, and the hash as a JSON string literal. */
const LOG_LINE = /^(hit|miss|corrupt) ("(?:[^"\\]|\\.)*")$/;

/**
 * One ledger line: `put`, the hash, and the rule id — both JSON string literals. A
 * separate pattern from {@link LOG_LINE} on purpose: the counter fold matches only
 * counter lines and skips these, exactly as a reader that predates the ledger skips a
 * line it does not know, so a directory written by this version reads as the same
 * counters under the previous one (`test/ledger.test.ts` pins that).
 */
const PUT_LINE = /^put ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;

/**
 * One eviction line: `evict`, the hash, and the ISO-8601 instant the blob was
 * unlinked — both JSON string literals, like every other field in this journal.
 *
 * A third pattern for the same reason there is a second: neither the counter fold nor
 * the ledger fold matches it, so a reader that predates `evict` skips the line exactly
 * as it already skips a `put` — the precedent `test/ledger.test.ts` pins, and the
 * reason a directory pruned by this version still reads as the same counters and the
 * same ledger under the previous one.
 */
const EVICT_LINE = /^evict ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/;

/**
 * A `tmp/` entry `#writeTemp` could have written: the pid that wrote it, then a hyphen,
 * then the 16 hex characters of `randomBytes(8).toString('hex')`. `#sweepStaleTemp`
 * matches only this shape — see its doc comment for why the pid is what makes a safe
 * sweep possible at all.
 */
const TEMP_FILE = /^(\d+)-[0-9a-f]{16}$/;

/**
 * Whether a process with this pid is running right now — `kill(pid, 0)` sends no
 * signal, only asks the kernel. `ESRCH` is the one answer that means "no such
 * process"; anything else (it exists, or `EPERM` because it exists under another
 * user) is read as alive, the conservative direction for a check that decides whether
 * to delete someone else's in-flight file.
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code !== 'ESRCH';
  }
}

/**
 * What one {@link DirectoryElisionStore.prune} run was asked to do. Every field is
 * required and none has a default: a prune deletes bytes a caller could otherwise
 * still retrieve, so a cut-off, a keep rule or a dry run that smelt invented would be
 * smelt deciding what to forget.
 */
export interface PruneOptions {
  /**
   * The age cut. A blob whose mtime is strictly before this instant is a candidate;
   * everything at or after it is kept. The caller computes the instant (the CLI turns
   * `--older-than 30d` into one), so nothing here reads a clock to decide what is old.
   */
  readonly olderThan: Date;
  /**
   * Keep any hash the journal shows was retrieved at least once, whatever its age —
   * `--keep-retrieved`. A blob the model has asked for once is a blob it may ask for
   * again, and the journal already knows which those are.
   */
  readonly keepRetrieved: boolean;
  /** Measure and report; unlink nothing, journal nothing. `--dry-run`. */
  readonly dryRun: boolean;
}

/** One blob a prune evicted (or, in a dry run, would have). */
export interface PrunedBlob {
  readonly hash: string;
  /** The blob file's size, and therefore what evicting it frees. */
  readonly bytes: number;
  /**
   * When the blob file was last written, as ISO-8601 — the age the cut was applied to.
   *
   * It is the file's `mtime`, and it is named `putAt` because for a blob that is what
   * an mtime is: this store writes a blob once, atomically, and never touches it
   * again. It is not read from the journal, because a `put` line carries no timestamp
   * and giving new ones one would be a fourth field on a line the current `PUT_LINE`
   * pattern matches to end-of-line — the reader shipped today would stop recognising
   * its own attribution, and a ledger going quiet is exactly the failure this journal's
   * skip rule exists to prevent. The filesystem already records the fact, for every
   * blob, whichever version of smelt wrote it.
   */
  readonly putAt: string;
}

/**
 * What one prune did. Every number is counted at the moment it happened — nothing here
 * is estimated, and a dry run reports the same fields with `dryRun: true` so the two
 * runs can be compared field for field.
 */
export interface PruneReport {
  /** Blobs the scan looked at. */
  readonly scanned: number;
  /** What went, in the order the scan found it. Empty for a prune that evicted nothing. */
  readonly evicted: readonly PrunedBlob[];
  /** Blobs left in place — too new, retrieved, or impossible to remove. */
  readonly kept: number;
  /** Bytes the eviction actually freed. Zero for a dry run's *effect*, never for its report. */
  readonly bytesFreed: number;
  /** Whether this was a measurement. `true` means nothing on disk moved. */
  readonly dryRun: boolean;
}

/**
 * The blob count and total bytes of a store directory, read **without opening it** —
 * `undefined` when the directory holds no `blobs/`.
 *
 * It exists for `smelt doctor`, whose whole contract is that it never writes
 * (ADR-0003). Constructing a {@link DirectoryElisionStore} to ask it for `stats()`
 * would create `blobs/`, `tmp/` and `format.json`, so a doctor run against a
 * misconfigured path would author the very store it was reporting was missing. This is
 * the read-only half, and it makes exactly two syscalls per blob more than a directory
 * listing.
 */
export function readStoreSize(root: string): { blobs: number; bytes: number } | undefined {
  const blobsDir = join(resolve(root), 'blobs');
  let entries: string[];
  try {
    entries = readdirSync(blobsDir);
  } catch {
    return undefined; // not a store directory, or not readable right now
  }
  let blobs = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!KEY_PATTERN.test(entry)) continue; // `.DS_Store` and friends are not blobs
    try {
      bytes += statSync(join(blobsDir, entry)).size;
    } catch {
      continue; // vanished between the listing and the stat — not a blob we hold
    }
    blobs += 1;
  }
  return { blobs, bytes };
}

/**
 * Everything one traversal of a store directory can answer: the counters, the per-rule
 * ledger, and the directory's own size. What {@link DirectoryElisionStore.survey}
 * returns, and the shape `smelt stats` renders.
 *
 * `size.blobs` and `counters.elisionsStored` are different numbers on purpose. The
 * first is what is on disk right now; the second is every distinct elision this store
 * has ever held, evicted ones included, because a prune that shrank the expansion
 * rate's denominator would flatter the metric over bytes the user deleted. They agree
 * in a store nobody has pruned, and a reader who needs "how much disk" wants the first
 * while a reader who needs "how much did smelt hide" wants the second.
 */
export interface StoreSurvey {
  readonly counters: RawRetrieveCounters;
  readonly ledger: readonly RuleLedgerEntry[];
  /** The same two integers {@link readStoreSize} answers, from the same scan. */
  readonly size: { readonly blobs: number; readonly bytes: number };
}

/** See {@link MemoryElisionStoreOptions} in `store.ts` — same escape hatch, same reason. */
export interface DirectoryElisionStoreOptions {
  /**
   * Override the hash function, so the collision branch — unreachable with sha256 —
   * can be tested. Production has no reason to pass this.
   */
  readonly hash?: (content: string) => string;
}

/**
 * A persistent {@link ElisionStore} over a content-addressed directory. `node:fs` only —
 * no SQLite, no new dependency, nothing that phones home. Elisions put here outlive the
 * process, so a long-lived agent session can `retrieve()` across restarts.
 *
 * ## Storage layout
 *
 * ```text
 * <root>/
 *   format.json      { "format": "smelt-elision-store", "version": 1 } — refused if unknown
 *   blobs/<hash>     one file per elision: the exact UTF-8 bytes, named by their content hash
 *   tmp/             staging for atomic writes; never read, safe to sweep
 *   retrievals.log   append-only journal: `hit "<hash>"` | `miss "<hash>"` | `corrupt "<hash>"`
 *                    | `put "<hash>" "<rule>"` (the ledger: which rule cut what)
 *                    | `evict "<hash>" "<date>"` (the receipt a prune leaves)
 * ```
 *
 * **Nothing lives in memory.** Every read — `stats()` included — comes off the disk, so
 * two instances over the same directory (two processes, or one process before and after
 * a restart) always agree. `stats()` is a scan; elision counts per session are small and
 * retrieval is the model asking for material back, which is rare by design.
 *
 * ## Durability
 *
 * - **Writes are crash-safe.** A blob is written to `tmp/`, `fsync`ed, then `link(2)`ed
 *   into `blobs/` — an atomic, no-clobber publish. A torn write dies in `tmp/`, where
 *   nothing looks; a name in `blobs/` always refers to a fully written file.
 * - **`fsync` is only as strong as the platform makes it.** Every flush here is Node's
 *   `fsyncSync`, which is libuv's `uv_fs_fsync`, and what that reaches the hardware with
 *   differs by platform. On Apple it is strong: libuv knows macOS's own `fsync(2)` only
 *   hands the write to the drive, so its `__APPLE__` branch issues
 *   `fcntl(fd, F_FULLFSYNC)` — a real drive-cache flush — before falling back to
 *   `F_BARRIERFSYNC` and then plain `fsync(2)`. Measured here (Node 26, libuv 1.52,
 *   internal APFS SSD): an 11-byte append costs 0.01 ms unflushed, 5.5 ms through
 *   `fsyncSync`, and 0.10 ms through a raw `fsync(2)` against 4.8 ms through a raw
 *   `F_FULLFSYNC` — the cost says which syscall is being made. Everywhere else libuv
 *   calls plain `fsync(2)`, which is as durable as the drive's honesty about its own
 *   write cache. So a **power loss** can lose a blob or a journal line this code has
 *   already `fsync`ed and reported as written on any non-Apple platform whose drive
 *   lies, and on Apple only where `F_FULLFSYNC` itself fails and libuv degrades
 *   silently — some non-APFS and network mounts. A **process** crash cannot lose one
 *   anywhere: the bytes are in the page cache and the publish is still atomic. Nothing
 *   is ever handed back unverified either way, so the worst a lost blob can produce is
 *   {@link UnknownHashError} — never wrong bytes presented as right ones. "Crash-safe"
 *   is the claim, deliberately not "power-loss-proof": the durability is real, it is
 *   just not unconditional.
 * - **Reads verify.** `retrieve()`, `peek()` and `has()` re-hash the bytes and refuse a
 *   mismatch with {@link StoreCorruptionError} — a damaged blob is never handed back as
 *   a retrieval nor reported as present, and "we hold damaged bytes" is distinct from
 *   {@link UnknownHashError}'s "never existed". The guard in
 *   `test/guards/persistent-store.test.ts` watches this.
 * - **Counters survive a restart.** Every `retrieve()` appends one `fsync`ed line to
 *   `retrievals.log`, and `stats()` is a fold over it — so `expansionRate` stays
 *   meaningful across a whole session, not just one process. A crash in the middle of
 *   an append can tear at most that one line; a torn tail is skipped, costing at most
 *   the single count that was being written when the process died.
 * - **Concurrent writers are safe.** `link(2)` refuses to clobber, so two processes
 *   putting at once race to publish and the loser verifies byte-for-byte agreement with
 *   the winner — identical content dedupes, different content under one hash is a
 *   {@link HashCollisionError}. Journal appends use `O_APPEND`. Tested with two real
 *   processes in `test/store-dir.test.ts`.
 * - **A crash's leaked temp files are swept, not accumulated.** A blob's staging file
 *   in `tmp/` outlives its writer only when the process dies between the `fsync` and
 *   the `finally`'s own cleanup — see `#putBlob`. Every later construction of a
 *   store over the same directory sweeps `tmp/` for entries whose pid is provably dead
 *   (`#sweepStaleTemp`) and deletes them, named on `process.emitWarning`
 *   (`SmeltStaleTempDiscard`); a file whose writer might still be running is left
 *   alone rather than raced.
 *
 * ## No automatic eviction
 *
 * No cap, no LRU, no TTL, no `clear()`, and nothing anywhere in smelt that deletes a
 * blob on its own — not a smelt run, not a hook, not opening this store. A store that
 * could forget by itself would turn Law 3 into "reversible, usually", and there is no
 * moment at which this code is entitled to decide which of someone else's elisions
 * stopped mattering.
 *
 * The one exception is {@link DirectoryElisionStore.prune}, and every clause of it is
 * load-bearing: it runs only when a user typed `smelt store prune`, it evicts only
 * against a cut-off that user named, it journals `evict "<hash>" "<date>"` **before**
 * it unlinks anything, and a later lookup of an evicted hash throws
 * {@link EvictedHashError} — never {@link UnknownHashError}. So the model can tell "you
 * pruned it" from "it never existed", the counters can tell what was hidden from what
 * is still held, and the eviction is as explainable and as counted as the elision was.
 * With one global store shared by every session the blobs would otherwise accumulate
 * forever; the answer is a verb the user runs, not a rule smelt applies.
 *
 * ## Two deliberate choices around the edges
 *
 * - **The root is resolved to an absolute path at construction.** Every later path is
 *   joined from that, so a `process.chdir()` after construction cannot silently
 *   re-target the store — the bytes a relative-rooted store put before a chdir would
 *   otherwise be unreachable after it, which reads exactly like data loss.
 * - **A failed journal append never withholds intact bytes.** `retrieve()`'s order of
 *   business is: read, verify, count, return. When the *count* cannot be written (a
 *   read-only journal, a full disk), the bytes are still returned — they are verified
 *   and the caller asked for them; refusing would turn a bookkeeping failure into
 *   Law 3 breaking. The failure is surfaced distinctly instead: a
 *   `process.emitWarning` with name `SmeltCounterWriteFailure`, so "your retrieval
 *   worked" and "your counters just went quiet" stay two separate facts. The same
 *   applies to the `miss`/`corrupt` journal lines: the store's own error for the
 *   lookup still wins over the journal's I/O error.
 */
export class DirectoryElisionStore implements ElisionStore {
  readonly #blobsDir: string;
  readonly #tmpDir: string;
  readonly #logPath: string;
  readonly #hash: (content: string) => string;

  constructor(root: string, options: DirectoryElisionStoreOptions = {}) {
    this.#hash = options.hash ?? contentHash;
    // Resolve NOW, against the working directory the caller constructed with — a
    // later chdir must never re-point an already-constructed store. See the class doc.
    const absoluteRoot = resolve(root);
    this.#blobsDir = join(absoluteRoot, 'blobs');
    this.#tmpDir = join(absoluteRoot, 'tmp');
    this.#logPath = join(absoluteRoot, 'retrievals.log');
    const markerPath = join(absoluteRoot, 'format.json');
    // Validate before mutating: a directory carrying a marker this code does not
    // understand is refused with the directory exactly as it was found — no blobs/,
    // no tmp/, no staged temp file created inside someone else's layout.
    const existing = this.#readMarker(markerPath);
    if (existing !== undefined) this.#verifyMarker(markerPath, existing);
    mkdirSync(this.#blobsDir, { recursive: true });
    mkdirSync(this.#tmpDir, { recursive: true });
    this.#claimFormat(markerPath);
    this.#sweepStaleTemp();
  }

  /**
   * Delete `tmp/` entries left by a process that crashed between writing (and
   * `fsync`ing) a staged blob and its own `unlinkSync(tmpPath)` — see the class doc's
   * Durability section, and `#putBlob`'s own `finally`. A leaked temp file costs
   * nothing but disk (`tmp/` is never read by any other path — {@link readBlob} only
   * ever looks in `blobs/`), but nothing ever reclaimed it before now, so a directory
   * that outlived a few crashes accumulated forever.
   *
   * The bar is the same one {@link TagsCache} states for its own leftovers
   * (`src/repomap/cache.ts`, `ENTRY_FILE`): reclaiming an entry safely needs a
   * liveness test, not an invented number — "a temp file older than N seconds" would
   * be a threshold this code made up, and could delete a slow write still in
   * progress. `#writeTemp` names every entry `<pid>-<hex>`, and a PID *is* a real
   * liveness test: `process.kill(pid, 0)` sends no signal and only asks the kernel
   * whether that process exists. `ESRCH` means it does not — provably orphaned, safe
   * to delete. Anything else (the process exists, or exists under another user and
   * answers `EPERM`) is left alone; the file might be mid-write right now. A name that
   * does not match the `<pid>-<hex>` shape at all is left alone too — this store never
   * writes another shape into `tmp/`, so it is not this store's to touch.
   *
   * Best-effort like every other sweep in this codebase: a failure to list or delete
   * postpones the cleanup to the next open rather than failing construction over
   * leftover disk. Every actual discard is named on `process.emitWarning`, the same
   * way a lost counter is (`SmeltCounterWriteFailure`) — a silent delete of bytes
   * nobody asked for would be exactly the kind of quiet loss this project refuses.
   */
  #sweepStaleTemp(): void {
    let entries: string[];
    try {
      entries = readdirSync(this.#tmpDir);
    } catch {
      return; // cannot list tmp/ right now — try again on the next open
    }
    for (const entry of entries) {
      const match = TEMP_FILE.exec(entry);
      if (match === null) continue; // not this store's naming — never touched
      const pid = Number(match[1]);
      if (processAlive(pid)) continue; // might be mid-write; never race a live writer
      const path = join(this.#tmpDir, entry);
      try {
        unlinkSync(path);
      } catch {
        continue; // gone already, or undeletable right now — next open tries again
      }
      process.emitWarning(
        `smelt: discarded stale temp file "${entry}" in ${this.#tmpDir} — its writer ` +
          `(pid ${String(pid)}) is no longer running, so the file was leaked by a ` +
          `crash between writing and cleanup. The blob it staged is safe: a publish ` +
          `only reaches blobs/ after an atomic link, so this file was never referenced ` +
          `by name and nothing is reachable through it.`,
        'SmeltStaleTempDiscard',
      );
    }
  }

  put(content: string, reason?: ElisionReason): string {
    const hash = this.#putBlob(content);
    // The ledger line, after the bytes are safe: attribution is bookkeeping, and a
    // failure to write it is surfaced as a warning rather than a failed put.
    if (reason !== undefined) this.#appendLogCounting('put', hash, reason.rule);
    return hash;
  }

  /** The publish itself: verify or write the blob, return its hash. */
  #putBlob(content: string): string {
    const hash = this.#hash(content);
    if (!KEY_PATTERN.test(hash)) {
      throw new SmeltError(
        `smelt: hash "${hash}" is not usable as a storage key — it must match ` +
          `${String(KEY_PATTERN)} so it can name a file inside blobs/ and nothing else.`,
      );
    }
    const existing = this.#readBlob(hash);
    if (existing !== undefined) {
      // Verify the stored bytes before comparing: a damaged blob is corruption, not a
      // collision. Only intact bytes that still differ earn HashCollisionError.
      if (this.#hash(existing) !== hash) throw new StoreCorruptionError(hash);
      if (existing !== content) throw new HashCollisionError(hash);
      return hash;
    }
    const tmpPath = this.#writeTemp(content);
    try {
      // link(2) is the atomic, no-clobber publish: it fails with EEXIST rather than
      // overwrite, so a concurrent writer can never silently replace someone's bytes.
      linkSync(tmpPath, join(this.#blobsDir, hash));
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error;
      // Another writer published this hash between our existence check and our link.
      // Same bytes: idempotent put, done. Damaged or vanished bytes: corruption — the
      // store was torn or edited outside smelt. Intact different bytes: a collision.
      const winner = this.#readBlob(hash);
      if (winner === undefined || this.#hash(winner) !== hash) {
        throw new StoreCorruptionError(hash);
      }
      if (winner !== content) throw new HashCollisionError(hash);
    } finally {
      unlinkSync(tmpPath);
    }
    fsyncDirBestEffort(this.#blobsDir);
    return hash;
  }

  /**
   * @throws {EvictedHashError} when a `smelt store prune` deleted these bytes — the
   *   journal's receipt, rather than the silence of `undefined`. Absence with a receipt
   *   and absence without one are different facts, and a caller that read `undefined`
   *   for both would report "never elided" for bytes its own user deleted.
   */
  peek(hash: string): string | undefined {
    const content = this.#readBlob(hash);
    if (content === undefined) {
      const evictedAt = this.#evictedAt(hash);
      if (evictedAt !== undefined) throw new EvictedHashError(hash, evictedAt);
      return undefined;
    }
    if (this.#hash(content) !== hash) throw new StoreCorruptionError(hash);
    return content;
  }

  retrieve(hash: string): string {
    const content = this.#readBlob(hash);
    if (content === undefined) {
      // A miss either way, and journalled either way: the model asked for material
      // back and did not get it, so `retrieveCalls` and `misses` move exactly as they
      // would for a hash that was never stored. An eviction that quietly stopped
      // counting would let a prune improve the expansion rate, which is the one number
      // this library exists to keep honest. Only the *error* differs — because only
      // the error is read by a human deciding what went wrong.
      this.#appendLogCounting('miss', hash);
      const evictedAt = this.#evictedAt(hash);
      if (evictedAt !== undefined) throw new EvictedHashError(hash, evictedAt);
      throw new UnknownHashError(hash);
    }
    if (this.#hash(content) !== hash) {
      this.#appendLogCounting('corrupt', hash);
      throw new StoreCorruptionError(hash);
    }
    this.#appendLogCounting('hit', hash);
    return content;
  }

  /**
   * Whether this hash can be **retrieved** — verified, exactly as {@link peek} and
   * {@link retrieve} verify, because it is `peek()`.
   *
   * `has()` used to be the one read that skipped verification: a damaged blob answered
   * `true` and then threw {@link StoreCorruptionError} on the very next line, so a
   * consumer that checked before retrieving was told a lie by the cheaper call. The two
   * answers now come from one place and cannot drift: `true` means the bytes are there
   * and hash to their name, `false` means this store never held them, and damage is
   * raised rather than hidden behind a boolean — the same distinction `peek()` draws
   * between "we hold damaged bytes" and "never existed".
   *
   * It stays uncounted: a check is not the model asking for material back, and counting
   * one would inflate `retrieveCalls` and with it the expansion rate, which is the one
   * number this library exists to keep honest. So no journal line is written here, not
   * even for the corrupt case — `retrieve()` journals that when the model asks.
   *
   * An **evicted** hash answers `false`, not an error. `has()` asks one question — can
   * the next `retrieve` return bytes? — and for a pruned hash the answer is no, the
   * same no a hash that was never stored gets, because in both cases this store holds
   * nothing. The distinction between them is a *reason*, and a reason is what
   * `retrieve()` and `peek()` are for; a boolean has no room to carry one, and a
   * consumer that checked first and then never retrieved would never be told it.
   *
   * @throws {StoreCorruptionError} when the stored bytes do not hash to their name.
   */
  has(hash: string): boolean {
    try {
      return this.peek(hash) !== undefined;
    } catch (error) {
      if (error instanceof EvictedHashError) return false;
      throw error;
    }
  }

  /**
   * **Everything a reader can learn about this store, from one traversal.**
   *
   * The counters, the per-rule ledger and the directory's own size are three questions
   * over two files — `blobs/` and `retrievals.log` — and they used to be three walks.
   * `smelt stats` asked all three (and the Stop hook runs `smelt stats` at the end of
   * every session), so a store of 5,500 blobs was read twice and its journal parsed
   * twice to answer one command. Nothing about *what* is counted changes here; the
   * three answers simply come out of one pass, and {@link rawCounters}, {@link ledger}
   * and {@link stats} are views over it.
   *
   * There is no cache, and the measurement is why. On a scratch store of 5,500 puts and
   * 500 retrievals (a 226,500-byte journal over 21 MB of blobs; Node 26, macOS 15, APFS
   * SSD, 2026-09-09) the three traversals cost 47-59 ms and this one costs 24-28 ms,
   * inside a `smelt stats` that runs end to end in 0.11-0.14 s. A cached tail would be a
   * second copy of numbers whose whole value is that they are read off the disk every
   * time — two instances over one directory agree precisely because neither remembers
   * anything — bought against a cost nobody is paying. If a store an order of magnitude
   * larger ever changes that, the cache is an offset-keyed tail keyed on the journal's
   * size and mtime and discarded on any mismatch; it is not written until a measurement
   * asks for it.
   *
   * **A prune moves `bytesStored` and nothing else.** `elisionsStored` is *distinct
   * blobs put into this store*, so an evicted hash still counts: the blobs on disk,
   * plus every hash the journal says was evicted and is not back on disk. Counting only
   * what is left would let a prune raise the expansion rate for free — the same
   * numerator over a smaller denominator, the metric flattering itself over bytes the
   * user deleted — which is precisely the silent failure Law 3's counters exist to
   * refuse. `bytesStored` is the honest exception: it measures what this directory is
   * actually holding, so freeing disk is exactly what it should show. The ledger is
   * untouched by a prune for its own reason, stated on {@link ledger}.
   */
  survey(): StoreSurvey {
    let blobs = 0;
    let bytesStored = 0;
    const onDisk = new Set<string>();
    for (const entry of readdirSync(this.#blobsDir)) {
      if (!KEY_PATTERN.test(entry)) continue; // `.DS_Store` and friends are not blobs
      let size;
      try {
        size = statSync(join(this.#blobsDir, entry)).size;
      } catch {
        // Vanished between the listing and the stat — another process pruned it while
        // this scan was running, so it is not a blob this store holds. This is
        // `readStoreSize`'s rule rather than the throw the counters used to take: one
        // traversal must have one answer about what is on disk, and the tolerant one is
        // the right answer for a directory a concurrent `smelt store prune` may be
        // emptying underneath it.
        continue;
      }
      onDisk.add(entry);
      blobs += 1;
      bytesStored += size;
    }

    let retrieveCalls = 0;
    let misses = 0;
    const hits = new Set<string>();
    const evicted = new Set<string>();
    const puts: { hash: string; rule: string }[] = [];
    for (const line of this.#readLog().split('\n')) {
      const put = PUT_LINE.exec(line);
      if (put !== null) {
        puts.push({ hash: JSON.parse(put[1]!) as string, rule: JSON.parse(put[2]!) as string });
        continue;
      }
      const evict = EVICT_LINE.exec(line);
      if (evict !== null) {
        evicted.add(JSON.parse(evict[1]!) as string);
        continue;
      }
      const match = LOG_LINE.exec(line);
      if (match === null) continue; // a torn tail from a crash, or a blank line
      retrieveCalls += 1;
      if (match[1] === 'miss') misses += 1;
      else if (match[1] === 'hit') hits.add(JSON.parse(match[2]!) as string);
    }
    let elisionsStored = blobs;
    // A hash evicted and later re-put is on disk and already counted once; counting it
    // again here would invent an elision nobody made.
    for (const hash of evicted) if (!onDisk.has(hash)) elisionsStored += 1;

    return {
      counters: {
        elisionsStored,
        bytesStored,
        retrieveCalls,
        uniqueRetrieved: hits.size,
        misses,
      },
      ledger: ruleLedger(puts, hits),
      size: { blobs, bytes: bytesStored },
    };
  }

  /**
   * The five directly-observed counts, every one read off the disk. See
   * {@link RawRetrieveCounters}; the derived half of the stats comes from the shared
   * `retrieveStats()`, never here. A view over {@link survey} — the counting itself,
   * and the reasoning behind every one of these five numbers, lives there.
   */
  rawCounters(): RawRetrieveCounters {
    return this.survey().counters;
  }

  /**
   * **The only eviction in smelt**, and the only one there will be: explicit, invoked
   * by a user through `smelt store prune`, journalled before it deletes, and reported
   * blob by blob.
   *
   * The order of business is the whole design. For each blob old enough to go (and not
   * spared by `keepRetrieved`) the `evict` line is appended and `fsync`ed **first**,
   * and only then is the blob unlinked. The other order loses information: bytes gone
   * with no receipt read back as {@link UnknownHashError} — "it never existed" — for an
   * elision the user themselves deleted, which is the silent loss this whole file is
   * built to refuse. Journalling first can only leave the opposite state, a receipt for
   * bytes still present, and that is harmless because {@link retrieve} reads the blob
   * before it reads the journal: bytes this store is holding are always served.
   *
   * A blob whose unlink fails (a read-only directory, a vanished file) is counted as
   * **kept** and named on `process.emitWarning`, never as evicted — `bytesFreed` must
   * be bytes that were actually freed. A later prune tries again.
   *
   * **The one race the ordering leaves open**, stated because it is real rather than
   * because it is bad: another process `put`ting the *same content* between the `evict`
   * append and the `unlink` takes {@link put}'s existing-blob fast path — it verifies
   * the bytes already on disk, returns the hash, and writes nothing — and this loop then
   * deletes them. The winner is left holding a hash whose bytes are gone, and every
   * outcome from there is honest: the lookup raises {@link EvictedHashError} naming the
   * date, and a re-`put` of the same content restores the blob and serves it again
   * (`retrieve` reads the blob before the journal). The only artefact is a receipt whose
   * date precedes a put — true of the eviction it records, and not of the bytes that
   * came back. Making this impossible would need a lock across the whole directory, and
   * this store's every other guarantee is built out of atomic operations instead.
   *
   * **A journal that stops accepting lines stops the eviction**, it does not silently
   * continue it: the failure is named on `process.emitWarning`
   * (`SmeltPruneJournalFailure`), that blob and every blob after it is counted as
   * **kept**, and the report comes back describing exactly what did happen. Throwing
   * would lose the record of the blobs already unlinked, which is the one piece of
   * information the caller cannot reconstruct.
   *
   * `dryRun` short-circuits both writes: nothing is appended, nothing is unlinked, and
   * the report is otherwise identical, so `--dry-run` and the real thing can be
   * compared field for field.
   *
   * @throws {SmeltError} when `olderThan` is not a readable instant. See the guard at
   *   the top of the body: this is the only code in smelt that unlinks a blob, and an
   *   unreadable cut-off makes every age comparison false, which reads as "everything
   *   is old enough".
   */
  prune(options: PruneOptions): PruneReport {
    // Before anything is listed, let alone unlinked. An Invalid Date's `getTime()` is
    // NaN, and every `mtimeMs >= NaN` is false — so a cut-off that cannot be read would
    // not evict *nothing*, it would evict *everything*. The one function in smelt that
    // deletes bytes refuses an input it cannot interpret rather than picking the
    // interpretation that happens to fall out of IEEE-754 comparison.
    const cutOff = options.olderThan.getTime();
    if (Number.isNaN(cutOff)) {
      throw new SmeltError(
        `smelt: prune was given a cut-off that is not a date, so no blob's age can be ` +
          `compared against it. Refusing to scan: every comparison against an unreadable ` +
          `instant is false, which would read as "every blob is old enough" and empty the ` +
          `store. Pass a real Date — \`smelt store prune\` derives one from --older-than.`,
      );
    }
    const at = new Date().toISOString();
    const retrieved = options.keepRetrieved ? this.#retrievedHashes() : new Set<string>();
    const evicted: PrunedBlob[] = [];
    let scanned = 0;
    let kept = 0;
    let bytesFreed = 0;
    // Set the moment the journal refuses a line. From then on this run evicts nothing
    // and counts what is left as kept: an eviction it could not record is one it must
    // not make, and the blobs already unlinked still deserve a report.
    let journalFailed = false;

    for (const entry of readdirSync(this.#blobsDir).toSorted()) {
      if (!KEY_PATTERN.test(entry)) continue; // never this store's to delete
      const path = join(this.#blobsDir, entry);
      let stat;
      try {
        stat = statSync(path);
      } catch {
        continue; // vanished between the listing and the stat — nothing to scan
      }
      scanned += 1;
      if (journalFailed || retrieved.has(entry) || stat.mtimeMs >= cutOff) {
        kept += 1;
        continue;
      }
      const blob: PrunedBlob = {
        hash: entry,
        bytes: stat.size,
        putAt: new Date(stat.mtimeMs).toISOString(),
      };
      if (options.dryRun) {
        evicted.push(blob);
        bytesFreed += blob.bytes;
        continue;
      }
      // The receipt, durably, before the bytes go. A failure here stops the eviction:
      // deleting bytes this store could not promise to explain is the one outcome
      // worse than not pruning at all.
      try {
        this.#appendLog('evict', entry, at);
      } catch (error) {
        journalFailed = true;
        kept += 1;
        process.emitWarning(
          `smelt: could not journal the eviction of "${entry}" in ${this.#logPath} ` +
            `(${error instanceof Error ? error.message : String(error)}). This prune ` +
            `stopped there: the bytes are still here, and the blobs it had already ` +
            `evicted are in the report. An eviction smelt cannot record is one it must ` +
            `not make — a later retrieve would call those bytes "never elided".`,
          'SmeltPruneJournalFailure',
        );
        continue;
      }
      try {
        unlinkSync(path);
      } catch (error) {
        kept += 1;
        process.emitWarning(
          `smelt: could not evict blob "${entry}" from ${this.#blobsDir} ` +
            `(${error instanceof Error ? error.message : String(error)}). The eviction is ` +
            `journalled but the bytes are still here, so they still retrieve; the next ` +
            `\`smelt store prune\` will try again.`,
          'SmeltPruneUnlinkFailure',
        );
        continue;
      }
      evicted.push(blob);
      bytesFreed += blob.bytes;
    }

    if (evicted.length > 0 && !options.dryRun) fsyncDirBestEffort(this.#blobsDir);
    return { scanned, evicted, kept, bytesFreed, dryRun: options.dryRun };
  }

  /** Every hash the journal shows was retrieved at least once — `--keep-retrieved`. */
  #retrievedHashes(): ReadonlySet<string> {
    const hits = new Set<string>();
    for (const line of this.#readLog().split('\n')) {
      const match = LOG_LINE.exec(line);
      if (match !== null && match[1] === 'hit') hits.add(JSON.parse(match[2]!) as string);
    }
    return hits;
  }

  /**
   * When a prune evicted this hash, or `undefined` if none did — the last such line,
   * because a hash evicted, re-put and evicted again went most recently at the second
   * date, and a receipt naming the earlier one would misreport how long the bytes were
   * available. Read only on the miss path, so the common case pays nothing for it.
   */
  #evictedAt(hash: string): string | undefined {
    let at: string | undefined;
    for (const line of this.#readLog().split('\n')) {
      const match = EVICT_LINE.exec(line);
      if (match === null) continue;
      if ((JSON.parse(match[1]!) as string) === hash) at = JSON.parse(match[2]!) as string;
    }
    return at;
  }

  stats(): RetrieveStats {
    return retrieveStats(this.rawCounters());
  }

  /**
   * The per-rule ledger: the journal's `put` lines folded against its `hit` lines by
   * the shared `ruleLedger()`, out of the one traversal {@link survey} makes.
   * Uncounted, and read off the disk like everything else here, so two processes agree.
   *
   * A prune does not touch it. The rule *did* make that cut, and it was *not* asked
   * for back; deleting the row when the bytes go would erase the evidence that a rule
   * is cutting material nobody wants, which is the one thing this ledger is for.
   */
  ledger(): readonly RuleLedgerEntry[] {
    return this.survey().ledger;
  }

  /** The blob's exact content, or `undefined` when no such blob is stored. */
  #readBlob(hash: string): string | undefined {
    if (!KEY_PATTERN.test(hash)) return undefined; // never a path component
    try {
      return readFileSync(join(this.#blobsDir, hash), 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Write content to a unique file in `tmp/`, fsynced, and return its path. */
  #writeTemp(content: string): string {
    const tmpPath = join(this.#tmpDir, `${String(process.pid)}-${randomBytes(8).toString('hex')}`);
    const fd = openSync(tmpPath, 'wx');
    try {
      // writeSync may write fewer bytes than asked; loop, or a short write would be
      // fsynced and published under the full content's hash as a torn blob.
      const bytes = Buffer.from(content, 'utf8');
      let written = 0;
      while (written < bytes.length) {
        written += writeSync(fd, bytes, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tmpPath;
  }

  /**
   * A journal append on the `retrieve()` path — counting, not custody. A failure here
   * must never decide whether the caller gets its verified bytes (or its true error),
   * so it is caught and surfaced as a distinct `process.emitWarning` — see the class
   * doc, and the read-only-journal case in `test/store-dir.test.ts`.
   */
  #appendLogCounting(kind: 'hit' | 'miss' | 'corrupt' | 'put', hash: string, rule?: string): void {
    try {
      this.#appendLog(kind, hash, rule);
    } catch (error) {
      process.emitWarning(
        `smelt: could not journal a "${kind}" for hash "${hash}" in ${this.#logPath} ` +
          `(${error instanceof Error ? error.message : String(error)}). The retrieval ` +
          `itself is unaffected, but this count is lost — retrieveCalls and ` +
          `expansionRate now UNDER-report until the journal is writable again.`,
        'SmeltCounterWriteFailure',
      );
    }
  }

  /**
   * One durable journal line. The hash is JSON-encoded because `retrieve()` takes it
   * from the model verbatim — a hash containing a newline must not forge a second line.
   * The record starts with its own newline so a torn tail from an earlier crash — a
   * partial record with no trailing newline — can never bleed into this one: the tear
   * stays on its own line and is skipped by `stats()`, as blank lines are.
   *
   * `detail` is the line's second string field where its kind has one: the rule id on a
   * `put`, the ISO-8601 instant on an `evict`. One append path for every kind, so every
   * line in this journal is written the same way and `fsync`ed the same way.
   */
  #appendLog(
    kind: 'hit' | 'miss' | 'corrupt' | 'put' | 'evict',
    hash: string,
    detail?: string,
  ): void {
    const fd = openSync(this.#logPath, 'a');
    try {
      const fields =
        detail === undefined
          ? [kind, JSON.stringify(hash)]
          : [kind, JSON.stringify(hash), JSON.stringify(detail)];
      const record = Buffer.from(`\n${fields.join(' ')}\n`, 'utf8');
      let written = 0;
      while (written < record.length) {
        written += writeSync(fd, record, written);
      }
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  #readLog(): string {
    try {
      return readFileSync(this.#logPath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return '';
      throw error;
    }
  }

  /**
   * Write the format marker if this directory has none, or verify the one it has.
   * Creation is atomic (write to `tmp/`, then `link`), so a concurrent creator never
   * observes a half-written marker. The constructor pre-verified any pre-existing
   * marker; the verify here catches only a concurrent creator's claim.
   */
  #claimFormat(markerPath: string): void {
    const claim = (): string | undefined => {
      const body = `${JSON.stringify({
        format: DIRECTORY_STORE_FORMAT,
        version: DIRECTORY_STORE_VERSION,
      })}\n`;
      const tmpPath = this.#writeTemp(body);
      try {
        linkSync(tmpPath, markerPath);
        return undefined; // claimed by us; nothing to verify
      } catch (error) {
        if ((error as { code?: string }).code !== 'EEXIST') throw error;
        return readFileSync(markerPath, 'utf8');
      } finally {
        unlinkSync(tmpPath);
      }
    };

    const existing = claim();
    if (existing === undefined) return;
    this.#verifyMarker(markerPath, existing);
  }

  /** The marker's body, or `undefined` when the directory carries none. */
  #readMarker(markerPath: string): string | undefined {
    try {
      return readFileSync(markerPath, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  /** Refuse a marker this version of smelt does not understand. */
  #verifyMarker(markerPath: string, existing: string): void {
    let parsed: { format?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(existing) as { format?: unknown; version?: unknown };
    } catch {
      throw new StoreFormatError(
        `smelt: "${markerPath}" is not parseable JSON, so this directory cannot be ` +
          `trusted as an elision store. Refusing to read or write it.`,
      );
    }
    if (parsed.format !== DIRECTORY_STORE_FORMAT || parsed.version !== DIRECTORY_STORE_VERSION) {
      throw new StoreFormatError(
        `smelt: "${markerPath}" declares format ${JSON.stringify(parsed.format)} ` +
          `version ${JSON.stringify(parsed.version)}; this code understands ` +
          `"${DIRECTORY_STORE_FORMAT}" version ${String(DIRECTORY_STORE_VERSION)}. ` +
          `Refusing to reinterpret someone else's layout.`,
      );
    }
  }
}

/**
 * Flush the directory entry after a publish, so the *name* survives a crash as well as
 * the bytes. Where the platform refuses to fsync a directory (Windows does), the publish
 * is still atomic — only the durability of the directory entry falls back to the OS's
 * own schedule. Only that refusal is swallowed: a real I/O failure (`EIO`) propagates,
 * because "the disk could not flush" must never be reported as a successful put.
 *
 * Where it does work it is the same `fsyncSync` the blob's own flush uses, and so is
 * exactly as strong as that — see the durability note on {@link DirectoryElisionStore}
 * for what that means per platform.
 */
function fsyncDirBestEffort(path: string): void {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return; // the platform refuses to even open a directory for reading (Windows)
  }
  try {
    fsyncSync(fd);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // EINVAL/ENOTSUP/EPERM/EBADF: the platform refuses to fsync a directory — see the
    // doc comment. Anything else (EIO above all) is a genuine write failure.
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EPERM' && code !== 'EBADF') {
      throw error;
    }
  } finally {
    closeSync(fd);
  }
}
