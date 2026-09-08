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
 * ## No eviction
 *
 * Same rule as {@link MemoryElisionStore}: no cap, no LRU, no `clear()`. A store that
 * can forget turns Law 3 into "reversible, usually". Elided text is smaller than the
 * session that produced it; if disk pressure ever forces a cap, retrieval of an evicted
 * hash must throw a distinct "evicted" error — never {@link UnknownHashError} — so the
 * model can tell "we lost it" from "never existed". Today there is no such error because
 * there is no such cap.
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

  peek(hash: string): string | undefined {
    const content = this.#readBlob(hash);
    if (content === undefined) return undefined;
    if (this.#hash(content) !== hash) throw new StoreCorruptionError(hash);
    return content;
  }

  retrieve(hash: string): string {
    const content = this.#readBlob(hash);
    if (content === undefined) {
      this.#appendLogCounting('miss', hash);
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
   * @throws {StoreCorruptionError} when the stored bytes do not hash to their name.
   */
  has(hash: string): boolean {
    return this.peek(hash) !== undefined;
  }

  /**
   * The five directly-observed counts, every one read off the disk — a scan of
   * `blobs/` plus a fold over `retrievals.log`. See {@link RawRetrieveCounters}; the
   * derived half of the stats comes from the shared `retrieveStats()`, never here.
   */
  rawCounters(): RawRetrieveCounters {
    let elisionsStored = 0;
    let bytesStored = 0;
    for (const entry of readdirSync(this.#blobsDir)) {
      if (!KEY_PATTERN.test(entry)) continue; // `.DS_Store` and friends are not blobs
      elisionsStored += 1;
      bytesStored += statSync(join(this.#blobsDir, entry)).size;
    }

    let retrieveCalls = 0;
    let misses = 0;
    const hits = new Set<string>();
    for (const line of this.#readLog().split('\n')) {
      const match = LOG_LINE.exec(line);
      if (match === null) continue; // a torn tail from a crash mid-append, or blank
      retrieveCalls += 1;
      if (match[1] === 'miss') misses += 1;
      else if (match[1] === 'hit') hits.add(JSON.parse(match[2]!) as string);
    }

    return { elisionsStored, bytesStored, retrieveCalls, uniqueRetrieved: hits.size, misses };
  }

  stats(): RetrieveStats {
    return retrieveStats(this.rawCounters());
  }

  /**
   * The per-rule ledger: a fold over the journal's `put` lines against its `hit`
   * lines, derived by the shared `ruleLedger()`. Uncounted, and read off the disk
   * like everything else here, so two processes agree.
   */
  ledger(): readonly RuleLedgerEntry[] {
    const puts: { hash: string; rule: string }[] = [];
    const hits = new Set<string>();
    for (const line of this.#readLog().split('\n')) {
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
   */
  #appendLog(kind: 'hit' | 'miss' | 'corrupt' | 'put', hash: string, rule?: string): void {
    const fd = openSync(this.#logPath, 'a');
    try {
      const fields =
        rule === undefined
          ? [kind, JSON.stringify(hash)]
          : [kind, JSON.stringify(hash), JSON.stringify(rule)];
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
