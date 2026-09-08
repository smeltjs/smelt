import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

import { contentHash } from '../hash.ts';
import { fsCall } from './io.ts';
import type { DefinitionTag, FileTags, ReferenceTag } from './tags.ts';
import type { LanguageId } from '../types.ts';

/**
 * The repo map's disk cache — per-file tags, keyed by content hash, JSON on disk.
 *
 * Modelled on Aider's repo-map tags cache (https://aider.chat/docs/repomap.html),
 * with one deliberate substitution: Aider persists through SQLite; this repo ships
 * zero new runtime dependencies, so entries are plain JSON files under a directory
 * **the caller explicitly hands in**. smelt never writes outside a store or cache it
 * was handed — no default location, no home-directory guessing.
 *
 * The key is a content hash over the tag-format version, the language, and the file's
 * exact text. That is the whole invalidation story: edit a file and its key changes,
 * so the stale entry is simply never looked up again. Nothing needs a timestamp.
 *
 * A damaged entry is **discarded loudly, never trusted, and never fatal** — the entry
 * file is deleted (best effort), the tags are re-extracted from source, and the
 * caller's result carries a warning naming the file. Trusting a damaged cache would
 * silently drop symbols from the map, which is this project's signature failure mode;
 * crashing the whole map over one entry would be the overcorrection, since every tag
 * here is re-derivable from the file's own bytes. Two ways an entry can be damaged, and
 * `read()` names which one honestly rather than lumping them together — the same
 * discipline the elision store already applies to "damaged" versus "never existed":
 * **corrupt** (unparseable JSON, or JSON of the wrong shape — the entry was fully read
 * and cannot be trusted) and **unreadable** (`readFileSync` itself refused — `EISDIR`
 * because the entry path is now a directory, `EACCES` because the process lost
 * permission, or anything else that is not a plain `ENOENT` miss). Both discard the
 * same way and both report {@link CacheDiscard.deleted}, honestly, when the delete
 * itself could not land — an undeletable entry (e.g. a cache directory that turned
 * read-only mid-build) is offered for the same discard again on its next lookup, never
 * silently treated as gone.
 *
 * **It is bounded, and the bound is a sweep.** The key is a content hash, so an edit
 * does not replace an entry — it mints a new one and orphans the old, which is
 * invisible and permanent: every pre-edit version of every file the caller ever mapped
 * stays on disk for as long as the directory does. A long session therefore grew this
 * cache without limit while never reading most of it. So {@link TagsCache.sweep}
 * deletes every entry the build it just finished did not use, leaving exactly the tags
 * of the tree as it now stands. The policy is stated as a bound anyone can check: **an
 * entry survives a build only if that build used it**, so the cache is at most one
 * entry per mappable file in the tree — plus whatever a crash left mid-write, which
 * no sweep can safely reclaim; see {@link ENTRY_FILE}.
 *
 * Why that is safe, and the rule any other policy would also have to meet: **a miss
 * can only make a map slower, never wrong.** A missing entry is re-extracted from the
 * file's own bytes, and a present entry is only ever served for the exact content that
 * hashed to its key — so sweeping too much costs a re-parse and sweeping too little
 * costs disk, and neither can change a single symbol in the emitted map. The same rule
 * is why the sweep never throws: it runs after the map is finished, so a cache
 * directory that will not list postpones the bound to the next build rather than
 * turning a computed map into no map at all.
 *
 * The cost is paid by a caller who points *one* cache directory at *several* trees:
 * each build sweeps the others' entries, and every build then re-parses. That is a
 * slower map, not a wrong one, and it is measured rather than hidden — the sweep's
 * count rides back in `RepoMap.cache.pruned` and is printed in `smelt map`'s report.
 * One cache directory per tree is the shape this is tuned for.
 */

/** The format name every cache entry carries. */
export const TAGS_CACHE_FORMAT = 'smelt-repomap-tags';

/** Bump this when the tag shape changes: old entries then miss instead of misleading. */
export const TAGS_CACHE_VERSION = 1;

/**
 * The cache key for one file's tags. The version and language are part of the hashed
 * material, so a format bump or a re-detected language can never resurrect an entry
 * extracted under different rules.
 */
export function tagsCacheKey(language: LanguageId, content: string): string {
  return contentHash(`${TAGS_CACHE_FORMAT}/${String(TAGS_CACHE_VERSION)}\0${language}\0${content}`);
}

/**
 * An entry `read()` could not hand back as tags — discarded, and named honestly by
 * *why*, never lumped into one vague bucket. The distinction matters the way this
 * repo's stores already distinguish "damaged" from "never existed": `'corrupt'` is an
 * entry that was fully read and failed to parse or match the tags shape; `'unreadable'`
 * is an entry `readFileSync` itself refused — the tags-cache path is a directory
 * (`EISDIR`, e.g. another process or an editor left a directory where a `.json` file
 * should be), the process lacks permission (`EACCES`), or anything else the filesystem
 * can throw that is not a plain miss (`ENOENT`, which `read()` returns as `undefined`,
 * never as a discard).
 */
export interface CacheDiscard {
  readonly kind: 'corrupt' | 'unreadable';
  /** The measured reason, never invented — an OS errno code or the parse/shape failure. */
  readonly reason: string;
  /**
   * Whether `read()` actually deleted the entry file. `false` when the delete itself
   * failed (an undeletable entry — e.g. a read-only cache directory): the file is left
   * in place, still untrusted, and the next lookup for this key discards it again the
   * same way. A `deleted: true` this call did not earn would be exactly the "we don't
   * know" this repo's stores refuse to say about a damaged entry — `deleted` reports
   * what happened, never a guess.
   */
  readonly deleted: boolean;
}

/** What `read()` reports about one lookup. */
export type TagsCacheLookup = FileTags | CacheDiscard | undefined;

/**
 * An entry file's name, and the key inside it. Only a name of exactly this shape is
 * ever swept: a temp file from a write in flight (`<key>.json.tmp-<pid>`) does not
 * match, so a sweep cannot delete the file another process is at that moment renaming
 * into place.
 *
 * The price of that exclusion, stated rather than hidden: the bound above is over
 * *entries*, and a process killed between the `writeFileSync` and the `renameSync` in
 * {@link TagsCache.write} leaves a temp file no later sweep reclaims. Reclaiming one
 * safely needs a liveness test this cache cannot make — a pid can be reused, and an
 * mtime cutoff is a number smelt would have invented — and the alternative, deleting
 * a temp file a live writer is about to rename, fails that writer's build. So a
 * crash's leftovers are counted as the known cost of never racing a concurrent write.
 */
const ENTRY_FILE = /^([0-9a-f]+)\.json$/;

export class TagsCache {
  readonly #entriesDir: string;

  /** `dir` is the directory the caller handed in; entries live under `<dir>/tags/`. */
  constructor(dir: string) {
    this.#entriesDir = join(dir, 'tags');
    fsCall('create the tags cache directory', this.#entriesDir, () => {
      mkdirSync(this.#entriesDir, { recursive: true });
    });
  }

  /**
   * The cached tags under `key`: `undefined` on a plain miss, a {@link CacheDiscard}
   * when an entry existed but could not be trusted or even be read.
   *
   * **Every non-`ENOENT` failure here is a discard, never a throw.** `ENOENT` is the
   * only case this method treats as "nothing there" — a plain miss, answered by
   * re-extraction exactly as a first build would. Anything else `readFileSync` can
   * throw (`EISDIR` because the entry path is itself a directory, `EACCES` because the
   * process cannot read it, a truncated read, anything the filesystem invents) used to
   * escape through `fsCall` as a `RepoMapIoError` that crashed the whole map over one
   * damaged cache entry the map does not even need — the tags are always re-derivable
   * from the file's own bytes. So it is discarded exactly like a parse or shape
   * failure: named by `reason`, deleted best-effort, reported once by the caller as a
   * warning, and never re-read as truth.
   */
  read(key: string): TagsCacheLookup {
    const path = this.#entryPath(key);
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (error) {
      // Structural, not `NodeJS.ErrnoException`: this type reaches the shipped
      // declarations, and an ambient namespace there breaks a consumer compiling
      // with `skipLibCheck: false`.
      const code = (error as { code?: string }).code;
      if (code === 'ENOENT') return undefined; // a plain miss — nothing to discard
      return {
        kind: 'unreadable',
        reason: describeReadFailure(error),
        deleted: this.#discard(key),
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        kind: 'corrupt',
        reason: 'the entry is not valid JSON',
        deleted: this.#discard(key),
      };
    }
    const tags = validateEntry(parsed);
    if (tags === undefined) {
      return {
        kind: 'corrupt',
        reason: 'the entry JSON does not match the tags shape',
        deleted: this.#discard(key),
      };
    }
    return tags;
  }

  /**
   * Persist one file's tags. Written to a temp name and renamed into place, so a
   * concurrent reader never sees a half-written entry; both writers of the same key
   * are writing identical bytes (the key covers the content), so last-rename-wins is
   * harmless. No fsync: unlike the elision store, every entry here is derivable from
   * source, so losing one to a crash costs a re-parse, not a broken promise.
   *
   * **Best effort, same rule as {@link TagsCache.sweep}.** A write that cannot land —
   * the cache directory turned read-only under the build, or `#discard` above just
   * failed to remove a damaged entry at this exact key so the rename now lands on a
   * directory instead of replacing a file — costs this one file a re-parse on the next
   * build, never a build that crashed over an optimisation it does not need. This is
   * the write-side half of the same fact `read()`'s discard rests on: a miss can only
   * make a map slower, never wrong, and that has to hold whichever side fails.
   */
  write(key: string, tags: FileTags): void {
    const body = `${JSON.stringify({
      format: TAGS_CACHE_FORMAT,
      version: TAGS_CACHE_VERSION,
      defs: tags.defs,
      refs: tags.refs,
    })}\n`;
    const target = this.#entryPath(key);
    const temp = `${target}.tmp-${String(process.pid)}`;
    try {
      writeFileSync(temp, body, 'utf8');
      renameSync(temp, target);
    } catch {
      // Not cached this build — see the doc comment above.
    }
  }

  /**
   * Delete every entry that is not in `live` — the bound on this cache, described in
   * full in the module comment above. `live` is the set of keys the build that just
   * finished actually used, so what survives is exactly the tags of the tree as it
   * now stands, and the superseded pre-edit entries a content-hash key would otherwise
   * accumulate forever are gone.
   *
   * Returns how many entries were removed, so the caller can report a measured number
   * rather than a claim.
   *
   * **The whole sweep is best effort, listing included.** A directory that will not
   * list — an unreadable cache directory, or one an external cleaner removed between
   * the last write and this call — reports `0` pruned and leaves the map alone. It
   * runs after the tree has been walked, ranked and rendered, so a throw here would
   * destroy a finished map over housekeeping smelt only wanted to do: no map at all
   * instead of a slower one, which is the trade this cache is forbidden to make.
   * Deleting one entry is best effort for the same reason. Nothing is lost by
   * skipping a sweep — the entries are offered again on the next build, and until
   * then nothing reads them, because nothing will ever look up a key no file hashes
   * to.
   */
  sweep(live: ReadonlySet<string>): number {
    let names: string[];
    try {
      names = readdirSync(this.#entriesDir);
    } catch {
      return 0;
    }
    let pruned = 0;
    for (const name of names.toSorted()) {
      const key = ENTRY_FILE.exec(name)?.[1];
      if (key === undefined || live.has(key)) continue;
      try {
        unlinkSync(join(this.#entriesDir, name));
        pruned += 1;
      } catch {
        // Already gone, or undeletable. Either way it is one stale entry that will be
        // offered for sweeping again on the next build; nothing reads it meanwhile,
        // because nothing will ever look up a key no file hashes to.
      }
    }
    return pruned;
  }

  #entryPath(key: string): string {
    return join(this.#entriesDir, `${key}.json`);
  }

  /**
   * Delete a damaged entry — corrupt content or unreadable — so it can never be
   * re-read as truth. Best effort: reports whether the delete actually landed, so
   * {@link CacheDiscard.deleted} can say so honestly rather than assuming success.
   */
  #discard(key: string): boolean {
    try {
      unlinkSync(this.#entryPath(key));
      return true;
    } catch {
      // Already gone, or undeletable (e.g. the cache directory itself turned
      // read-only mid-build). Either way the caller is told via `deleted: false` —
      // never claimed as a success this call did not earn — and the entry is offered
      // for discard again, the same way, on its next lookup.
      return false;
    }
  }
}

/** The measured reason `read()` could not use an entry's bytes at all — never invented. */
function describeReadFailure(error: unknown): string {
  const code = (error as { code?: string } | null | undefined)?.code;
  if (typeof code === 'string' && code !== '') return code;
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

/** The parsed entry as `FileTags`, or `undefined` when its shape cannot be trusted. */
function validateEntry(parsed: unknown): FileTags | undefined {
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const entry = parsed as { format?: unknown; version?: unknown; defs?: unknown; refs?: unknown };
  if (entry.format !== TAGS_CACHE_FORMAT || entry.version !== TAGS_CACHE_VERSION) return undefined;
  if (!Array.isArray(entry.defs) || !Array.isArray(entry.refs)) return undefined;

  const defs: DefinitionTag[] = [];
  for (const item of entry.defs as unknown[]) {
    const def = item as { name?: unknown; kind?: unknown; line?: unknown };
    if (typeof def.name !== 'string' || def.name === '') return undefined;
    if (typeof def.kind !== 'string' || def.kind === '') return undefined;
    if (typeof def.line !== 'number' || !Number.isInteger(def.line) || def.line < 1) {
      return undefined;
    }
    defs.push({ name: def.name, kind: def.kind, line: def.line });
  }
  const refs: ReferenceTag[] = [];
  for (const item of entry.refs as unknown[]) {
    const ref = item as { name?: unknown; count?: unknown };
    if (typeof ref.name !== 'string' || ref.name === '') return undefined;
    if (typeof ref.count !== 'number' || !Number.isInteger(ref.count) || ref.count < 1) {
      return undefined;
    }
    refs.push({ name: ref.name, count: ref.count });
  }
  return { defs, refs };
}
