import { HashCollisionError, UnknownHashError } from './errors.ts';
import { contentHash } from './hash.ts';
import { retrieveStats, ruleLedger } from './stats.ts';
import type { RawRetrieveCounters } from './stats.ts';
import type { ElisionReason, ElisionStore, RetrieveStats, RuleLedgerEntry } from './types.ts';

/**
 * The default store: in-process, content-addressed, no eviction.
 *
 * In-process is the right default because it is the only one with no failure modes to
 * explain. A consumer that needs elisions to survive a process restart (a long-lived
 * agent session, say) hands `createSmelter()` a {@link DirectoryElisionStore} — or
 * implements {@link ElisionStore} over storage of its own; the interface is five
 * methods wide for exactly that reason.
 *
 * There is no `clear()`, no LRU and no prune. A store that can forget turns Law 3 into
 * "reversible, usually", and a `retrieve()` that failed after an eviction would be
 * indistinguishable to the model from a hallucinated hash. {@link DirectoryElisionStore}
 * is the one place that ever deletes a blob, and only because it can leave a receipt: a
 * journalled `evict` line, and {@link EvictedHashError} at the next lookup. This store
 * has no journal to write one in and dies with its process anyway, so eviction here
 * would be exactly the forgetting Law 3 refuses.
 */
export interface MemoryElisionStoreOptions {
  /**
   * Override the hash function. The only reason this exists: the collision branch in
   * {@link MemoryElisionStore.put} is unreachable with sha256, and an untestable branch
   * is a branch nobody knows works. A test injects a colliding hash and watches it
   * throw. Production has no reason to pass this.
   */
  readonly hash?: (content: string) => string;
}

export class MemoryElisionStore implements ElisionStore {
  readonly #blobs = new Map<string, string>();
  readonly #hash: (content: string) => string;
  #bytesStored = 0;
  #retrieveCalls = 0;
  #misses = 0;
  readonly #retrievedHashes = new Set<string>();
  /** Every attributed put, in order — the ledger's facts. */
  readonly #puts: { readonly hash: string; readonly rule: string }[] = [];

  constructor(options: MemoryElisionStoreOptions = {}) {
    this.#hash = options.hash ?? contentHash;
  }

  put(content: string, reason?: ElisionReason): string {
    const hash = this.#hash(content);
    const existing = this.#blobs.get(hash);
    if (existing !== undefined) {
      if (existing !== content) throw new HashCollisionError(hash);
      if (reason !== undefined) this.#puts.push({ hash, rule: reason.rule });
      return hash;
    }
    this.#blobs.set(hash, content);
    this.#bytesStored += Buffer.byteLength(content, 'utf8');
    if (reason !== undefined) this.#puts.push({ hash, rule: reason.rule });
    return hash;
  }

  peek(hash: string): string | undefined {
    return this.#blobs.get(hash);
  }

  retrieve(hash: string): string {
    this.#retrieveCalls += 1;
    const content = this.#blobs.get(hash);
    if (content === undefined) {
      this.#misses += 1;
      throw new UnknownHashError(hash);
    }
    this.#retrievedHashes.add(hash);
    return content;
  }

  /**
   * True exactly when `retrieve(hash)` would return bytes. Nothing to verify: `put`
   * hashed the content itself and no one else can reach the map, so a key here cannot
   * name bytes that stopped matching it — unlike a directory on someone's disk, where
   * {@link DirectoryElisionStore.has} re-hashes for this same promise.
   */
  has(hash: string): boolean {
    return this.#blobs.has(hash);
  }

  /** The five directly-observed counts. See {@link RawRetrieveCounters} — no derivation here. */
  rawCounters(): RawRetrieveCounters {
    return {
      elisionsStored: this.#blobs.size,
      bytesStored: this.#bytesStored,
      retrieveCalls: this.#retrieveCalls,
      uniqueRetrieved: this.#retrievedHashes.size,
      misses: this.#misses,
    };
  }

  stats(): RetrieveStats {
    return retrieveStats(this.rawCounters());
  }

  /** The per-rule ledger, derived by the shared `ruleLedger()` — see {@link RuleLedgerEntry}. */
  ledger(): readonly RuleLedgerEntry[] {
    return ruleLedger(this.#puts, this.#retrievedHashes);
  }
}
