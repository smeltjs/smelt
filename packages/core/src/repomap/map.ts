import { join } from 'node:path';

import { detectLanguage } from '../detect.ts';
import { SmeltError } from '../errors.ts';
import type { LanguageId } from '../types.ts';

import { TagsCache, tagsCacheKey } from './cache.ts';
import { fsCall } from './io.ts';
import { rankDefinitions } from './rank.ts';
import type { FileTagsEntry, RankedDefinition } from './rank.ts';
import { nodeFsReader } from './reader.ts';
import type { RepoReader } from './reader.ts';
import { extractTags } from './tags.ts';
import type { FileTags } from './tags.ts';

/**
 * The repo-map builder — the cross-file shape.
 *
 * **Modelled on Aider's repo-map, and credited as such.** The whole design is prior
 * art: Paul Gauthier's Aider extracts tree-sitter definition/reference tags per file,
 * runs PageRank over the cross-file reference graph, fits the ranked result to a
 * budget, and caches tags on disk keyed by content — see
 * https://aider.chat/docs/repomap.html and `aider/repomap.py` in
 * https://github.com/Aider-AI/aider. Nothing about the approach is this project's
 * invention; what this module adds is only smelt's own house rules:
 *
 *  - **Local files only** (Law 1). The caller names the root; symlinks are never
 *    followed, so the walk cannot leave it; binary files are skipped; no network.
 *    The whole tree is read through one read-only seam, {@link RepoReader} — the
 *    default is `node:fs` and the interface has no writer, so the only bytes this
 *    module can write are the tags cache the caller asked for by name. A file's
 *    `stat` (the symlink check) and its `read` happen in the same walk step, never a
 *    second pass over the whole tree after every path is already vetted — see
 *    `scanFiles`'s own doc comment for the TOCTOU gap that closes.
 *  - **Every inclusion is explainable** (Law 2, applied to inclusion rather than
 *    elision): each symbol in the map carries a rule id and a sentence stating its
 *    definition site and the measured reference counts that ranked it.
 *  - **Deterministic**: fixed PageRank constants, sorted walks, a total tie-break by
 *    path, name, and line. Two runs over the same tree are byte-identical.
 *  - **The budget is bytes**, same contract as the planners, and it is respected by
 *    construction: symbols are added in rank order until the next line would not fit.
 *  - **The cache lives only in a directory the caller explicitly hands in**, and a
 *    damaged entry — corrupt content or one `readFileSync` itself refused (`EISDIR`,
 *    `EACCES`, anything but a plain miss) — is discarded loudly, named by which of the
 *    two it was, never trusted and never fatal: a cache is an optimisation this map
 *    does not need to survive, so a discard that cannot even delete its own entry, or
 *    a write that cannot land, costs a re-parse next time and nothing else. It is also
 *    bounded: each build sweeps the entries it did not use, so the superseded
 *    pre-edit version of every file does not accumulate forever. The sweep is
 *    housekeeping and never fatal: it runs after the map is computed, so a cache it
 *    cannot tidy costs a re-parse next time, never this map. See `cache.ts`.
 *  - **Every failure is a `SmeltError`**: the consumer contract's one promise about
 *    errors holds here too, so a missing root or an unreadable file arrives as
 *    {@link RepoMapIoError} naming the path, not as a raw Node `ENOENT`. Every
 *    filesystem call in this module goes through `fsCall` in `io.ts`.
 *
 * **What the ranking can and cannot resolve.** A reference binds to a definition **by
 * bare identifier** — the tags carry names, not resolved symbols — so every definition
 * of a name receives every reference to that name, wherever either lives. Two files
 * that both define `run` share one another's inbound references and therefore rank
 * alike; two overloads of one name each count the whole traffic to it, so a name is
 * counted once per definition of it; an identifier that happens to collide with an
 * unrelated one somewhere else in the tree lends it rank. This is Aider's design, not
 * a defect introduced here: resolving properly means per-language import and scope
 * resolution — a type checker per language — and the map is a *ranking heuristic* for
 * deciding what a human or a model should look at first, never a symbol resolver.
 * What it must not do is *claim* a resolution it did not perform, and it does not: the
 * receipt on each entry says what was actually measured — `refsIn` is the number of
 * references to that **name** across the scanned tree — so a reader who knows this
 * paragraph can read the numbers for exactly what they are. Anything that needs true
 * binding (rename, call graph, dead-code detection) needs a different tool.
 *
 * **Deliberately NOT a `Planner`.** `buildRepoMap` returns a {@link RepoMap},
 * not an `ElisionPlan`: nothing here is elided, nothing is stored under a hash, and
 * there is no original to reconstruct — the map is a *summary built up under a
 * budget*, not a *removal to be reversed*. Forcing the Planner interface onto it
 * would claim Law 3 (reversibility) about output that has no bytes to give back,
 * which is exactly the kind of lie the interface exists to prevent. The CLI serves
 * it as its own subcommand (`smelt map`), never as a `--strategy`.
 */

/** The id stamped on every map this module emits. */
export const REPO_MAP_ID = 'repomap/v1';

/**
 * Rule id for a symbol something in the scanned tree references — its own file
 * included, so its rank may still be zero when every reference is same-file (only
 * cross-file references move rank).
 */
export const REPO_MAP_RANKED_RULE = 'ranked-definition';

/** Rule id for a definition nothing in the scanned tree references. */
export const REPO_MAP_UNREFERENCED_RULE = 'unreferenced-definition';

/**
 * Rule id for a definition promoted because it matches a caller-supplied focus term.
 * The rank stays the measured PageRank share — focus moves a symbol's *place in the
 * fill order*, never its numbers.
 */
export const REPO_MAP_FOCUS_RULE = 'focus-match';

/** Rule id for a file listed by path because no definitions were extracted from it. */
export const REPO_MAP_PATH_ONLY_RULE = 'path-only';

/** Rule id for the warning left behind when a corrupt cache entry is discarded. */
export const REPO_MAP_CACHE_CORRUPT_RULE = 'cache-entry-corrupt';

/**
 * Rule id for the warning left behind when a cache entry that could not even be read
 * (a directory where a `.json` file should be, a permission refusal, anything that is
 * not a plain miss) is discarded. Distinct from {@link REPO_MAP_CACHE_CORRUPT_RULE} on
 * purpose — the entry was never trusted either way, but *why* differs, and this
 * project never lumps distinct failure reasons under one vague label.
 */
export const REPO_MAP_CACHE_UNREADABLE_RULE = 'cache-entry-unreadable';

/**
 * The ignore list used when the caller supplies none.
 *
 * Two kinds of directory are on it, for one reason: **including them makes the map
 * wrong, not merely large.** `.git` is object storage and `node_modules` is other
 * people's code — neither is the repository's own source. The rest are build outputs,
 * and they are the sharper case: a built TypeScript repo carries `dist/foo.js` and
 * `dist/foo.d.ts` beside `src/foo.ts`, so *every* symbol was ranked and rendered three
 * times, the duplicates referenced each other, and the default map of the commonest
 * repo shape in this ecosystem was a third source and two-thirds its own compiler
 * output. The names here (`dist`, `build`, `out`, `coverage`) are the conventional
 * output directories of the toolchains this map is most often pointed at; a repo that
 * builds somewhere else passes its own list.
 *
 * Deliberately still tiny, and deliberately **not** a `.gitignore` parser: an ignore
 * list smelt cannot state in one sentence is one nobody can predict.
 *
 * A caller with opinions passes its own list, which *replaces* this one — it is not
 * merged with it. Replacement is the documented contract because a merge means there
 * is no way to say "map my `dist`, I meant it", and a default you cannot turn off is
 * not a default.
 */
export const DEFAULT_REPO_IGNORE: readonly string[] = [
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
];

/** Why an entry is in the map — same two-register shape as {@link ElisionReason}. */
export interface RepoMapReason {
  /** Stable machine id, e.g. `'ranked-definition'`. */
  readonly rule: string;
  /** A sentence a human can read: definition site and the counts that ranked it. */
  readonly explanation: string;
}

export interface RepoMapOptions {
  /** The repository root to read. Local files only; symlinks are never followed. */
  readonly root: string;
  /** Ceiling for the rendered map, in UTF-8 bytes. Respected, not aimed at. */
  readonly budgetBytes: number;
  /**
   * What the task is actually about — same meaning as a planner's focus. A
   * definition whose name or path contains a term (case-insensitive, like the
   * lexical planner's default) is promoted to the front of the fill order, so it
   * survives a tight budget. Promotion only: the measured rank and reference
   * counts are never altered, and each promoted entry says which term it matched.
   */
  readonly focus?: readonly string[];
  /**
   * Paths to skip, replacing {@link DEFAULT_REPO_IGNORE}. An entry containing `/` is
   * matched as a root-relative path prefix — a trailing slash counts, so `build/`
   * means the root-level `build` tree, never every `build` segment anywhere; a bare
   * name matches any path segment.
   */
  readonly ignore?: readonly string[];
  /**
   * Directory for the tags cache. **Only** when this is passed is anything written
   * to disk — smelt never writes outside a store or cache it was explicitly handed.
   */
  readonly cacheDir?: string;
  /**
   * The filesystem the map reads through. Defaults to {@link nodeFsReader} — plain
   * `node:fs`, the calls this module used to make in-line — so callers that do not
   * care never mention it. Hand in a {@link RepoReader} to map a tree that is not on
   * this disk, or to watch, call by call, exactly what the walk touched. Read-only
   * by construction: the interface has no writer.
   */
  readonly reader?: RepoReader;
}

/** One symbol included in the rendered map, with the receipt for its inclusion. */
export interface RepoMapEntry {
  readonly path: string;
  readonly name: string;
  readonly kind: string;
  /** 1-based line of the definition. */
  readonly line: number;
  /** PageRank share this definition attracted. `0` for unreferenced definitions. */
  readonly rank: number;
  /** Measured: total references to this name across the scanned tree. */
  readonly refsIn: number;
  /** Measured: distinct files holding those references. */
  readonly refsInFiles: number;
  /** Measured: references the defining file makes to names defined elsewhere. */
  readonly refsOut: number;
  readonly reason: RepoMapReason;
}

/** A file listed by path because no definitions were extracted from it. */
export interface RepoMapPathEntry {
  readonly path: string;
  readonly reason: RepoMapReason;
}

/** Something worth telling the caller that is not worth failing the build over. */
export interface RepoMapWarning {
  readonly rule: string;
  readonly explanation: string;
}

/** Measured cache activity for one build. Counts only — smelt claims no rates. */
export interface RepoMapCacheCounts {
  /** Lookups answered from disk. */
  readonly hits: number;
  /** Lookups that found nothing and re-extracted from source. */
  readonly misses: number;
  /** Corrupt entries deleted and re-extracted; each one also left a warning. */
  readonly discarded: number;
  /**
   * Entries this build swept because it did not use them — the bound on the cache,
   * made visible. A non-zero count on a repeat build over an unchanged tree means the
   * cache directory is shared with another tree, which costs re-parses.
   */
  readonly pruned: number;
}

export interface RepoMap {
  readonly id: typeof REPO_MAP_ID;
  /** The rendered map. Always at most `budgetBytes` UTF-8 bytes. */
  readonly text: string;
  readonly outputBytes: number;
  readonly budgetBytes: number;
  /** The symbols that fit, in fill order (focus matches first, then rank). */
  readonly entries: readonly RepoMapEntry[];
  /** Path-only files that fit, after the symbols, in path order. */
  readonly pathOnly: readonly RepoMapPathEntry[];
  /** All ranked definitions found, before the budget cut anything. */
  readonly definitionsTotal: number;
  /** All path-only candidates found, before the budget cut anything. */
  readonly pathOnlyTotal: number;
  /** Regular files examined under the root, after the ignore list. */
  readonly filesScanned: number;
  /** Files skipped because their bytes contain a NUL — binary, not mappable. */
  readonly binarySkipped: number;
  readonly warnings: readonly RepoMapWarning[];
  /** Present only when the caller handed in a `cacheDir`. Never invented. */
  readonly cache?: RepoMapCacheCounts;
}

/**
 * Build a ranked symbol map of the repository under `options.root`.
 *
 * Reads local files only. Deterministic: two runs over the same tree, with or without
 * a warm cache, produce byte-identical maps — asserted by the guard in
 * `test/guards/repo-map.test.ts`, not assumed.
 *
 * @throws {SmeltError} when `budgetBytes` is not a positive integer.
 * @throws {RepoMapIoError} when a filesystem call fails — a root that is not there, a
 *   directory that will not list, a file that will not read. Never a raw Node error:
 *   the contract says every error smelt throws is a `SmeltError`, and a repo map that
 *   let `ENOENT` past would be the exception that made the promise worthless.
 * @throws {GrammarUnavailableError} when a supported language's grammar cannot load —
 *   never a silent skip that would make the map quietly incomplete.
 */
export async function buildRepoMap(options: RepoMapOptions): Promise<RepoMap> {
  const { root, budgetBytes } = options;
  if (!Number.isInteger(budgetBytes) || budgetBytes < 1) {
    throw new SmeltError(
      `smelt: budgetBytes must be a positive integer, got ${String(budgetBytes)}. ` +
        `There is no default budget — a budget smelt invented would silently decide ` +
        `how much of the map to throw away.`,
    );
  }
  const ignore = options.ignore ?? DEFAULT_REPO_IGNORE;
  const reader = options.reader ?? nodeFsReader();
  const cacheDir = options.cacheDir;
  const cache =
    cacheDir === undefined
      ? undefined
      : fsCall('open the tags cache directory', cacheDir, () => new TagsCache(cacheDir));
  const cacheCounts = { hits: 0, misses: 0, discarded: 0, pruned: 0 };
  // The keys this build used. Everything else under the cache directory is a
  // superseded entry — the pre-edit version of a file, or another tree's tags — and
  // is swept once the walk is done. See the bound in `cache.ts`.
  const liveKeys = new Set<string>();
  const warnings: RepoMapWarning[] = [];

  const files = scanFiles(reader, root, ignore);
  let binarySkipped = 0;
  const parsed: FileTagsEntry[] = [];
  const pathOnlyPaths: string[] = [];

  for (const { rel, bytes } of files) {
    if (bytes.includes(0)) {
      binarySkipped += 1;
      continue;
    }
    const language = detectLanguage(rel);
    if (language === 'unknown') {
      pathOnlyPaths.push(rel);
      continue;
    }
    // `RepoReader.read` promises `Uint8Array`, not `Buffer` (its own note says why),
    // and `ignoreBOM` keeps this byte-for-byte what `Buffer.toString('utf8')` did: a
    // leading U+FEFF stays in the text instead of being silently eaten.
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    const tags = await tagsFor(text, language, cache, cacheCounts, liveKeys, warnings, rel);
    if (tags.defs.length === 0) pathOnlyPaths.push(rel);
    if (tags.defs.length > 0 || tags.refs.length > 0) parsed.push({ path: rel, tags });
  }

  if (cache !== undefined) cacheCounts.pruned = cache.sweep(liveKeys);

  const ranked = rankDefinitions(parsed);
  const focus = (options.focus ?? []).filter((term) => term.length > 0);
  const ordered = orderWithFocus(ranked, focus);

  // Fit to the budget: ranked symbols first — focus matches promoted to the front,
  // each partition in rank order — then path-only files, in path order. Filling
  // stops at the first line that does not fit, so the included set is always a
  // prefix of that order — a map that skipped its #2 symbol to squeeze in its #9
  // would be lying about what mattered.
  const lines: string[] = [];
  let bytes = 0;
  const tryAppend = (line: string): boolean => {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // its trailing newline
    if (bytes + lineBytes > budgetBytes) return false;
    lines.push(line);
    bytes += lineBytes;
    return true;
  };

  const entries: RepoMapEntry[] = [];
  for (const { definition, focusTerm } of ordered) {
    if (!tryAppend(renderDefinition(definition))) break;
    entries.push(toEntry(definition, focusTerm));
  }
  const pathOnly: RepoMapPathEntry[] = [];
  if (entries.length === ordered.length) {
    for (const rel of pathOnlyPaths) {
      if (!tryAppend(`${rel} [path only]`)) break;
      pathOnly.push({
        path: rel,
        reason: {
          rule: REPO_MAP_PATH_ONLY_RULE,
          explanation: `no definitions extracted from ${rel}; listed by path so the file stays visible`,
        },
      });
    }
  }

  const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`;
  return {
    id: REPO_MAP_ID,
    text,
    outputBytes: Buffer.byteLength(text, 'utf8'),
    budgetBytes,
    entries,
    pathOnly,
    definitionsTotal: ranked.length,
    pathOnlyTotal: pathOnlyPaths.length,
    filesScanned: files.length,
    binarySkipped,
    warnings,
    ...(cache === undefined ? {} : { cache: { ...cacheCounts } }),
  };
}

/** One file's tags — from the cache when possible, from the grammar when not. */
async function tagsFor(
  text: string,
  language: LanguageId,
  cache: TagsCache | undefined,
  counts: { hits: number; misses: number; discarded: number; pruned: number },
  liveKeys: Set<string>,
  warnings: RepoMapWarning[],
  rel: string,
): Promise<FileTags> {
  if (cache === undefined) return extractTags(text, language);

  const key = tagsCacheKey(language, text);
  // Recorded before the lookup, not after: this key is what the tree holds now, so it
  // survives the sweep whether it was a hit, a miss, or a discard-and-rewrite.
  liveKeys.add(key);
  const found = cache.read(key);
  if (found !== undefined && 'kind' in found) {
    counts.discarded += 1;
    const deletedClause = found.deleted
      ? 'the entry file was deleted so it cannot be read again'
      : 'the entry file could not be deleted, so it will be discarded the same way again on its next lookup';
    warnings.push({
      rule: found.kind === 'corrupt' ? REPO_MAP_CACHE_CORRUPT_RULE : REPO_MAP_CACHE_UNREADABLE_RULE,
      explanation:
        `discarded ${found.kind === 'corrupt' ? 'a corrupt' : 'an unreadable'} cache entry ` +
        `for ${rel} (${found.reason}) and re-extracted its tags from source; ${deletedClause}`,
    });
  } else if (found !== undefined) {
    counts.hits += 1;
    return found;
  } else {
    counts.misses += 1;
  }
  const tags = await extractTags(text, language);
  cache.write(key, tags);
  return tags;
}

/** One regular file the walk found and read, in the same step it vetted it. */
interface ScannedFile {
  readonly rel: string;
  readonly bytes: Uint8Array;
}

/**
 * Walk the tree under `root`, depth-first in sorted order, reading every regular file
 * that survives the ignore list as it is found.
 *
 * Symlinks are skipped outright — file or directory, in-root or out. Never following
 * one is the simplest true implementation of "never follow a symlink out of the
 * root": there is no resolution step to get wrong. The refusal is stated on
 * `isSymlink`, not left to the accident that an `lstat` of a link is neither file
 * nor directory — so a reader whose `stat` resolves the target is refused just the
 * same, and the guard can watch the refusal happen by counting reader calls.
 *
 * The ignore list is applied before the entry is statted, so an ignored path costs
 * nothing and is never even looked at.
 *
 * **A file is read in the same walk step that just proved it is not a symlink, never
 * in a second pass over the whole tree afterward.** This used to be two phases: scan
 * the entire tree collecting vetted paths, then loop back over every one of them to
 * read its bytes — so a path this walk had already cleared could, on a large tree,
 * sit unread for as long as the rest of the scan took. Nothing stops the filesystem
 * from changing what is at that path in the meantime: a file swapped for a symlink
 * escaping `root` between the two phases would have its target's bytes read straight
 * into the map, past a symlink refusal that had already run and already said no. The
 * two calls this makes for a file — `stat`, then `read` — are now adjacent in the walk
 * for that one path, which closes the gap this module actually controls: the time
 * between "the whole tree has been vetted" and "this one file that was vetted a while
 * ago gets read". What is left is the single `stat`-then-`read` pair itself, which no
 * injectable `RepoReader` can make atomic without an `O_NOFOLLOW` open this interface
 * does not expose — an accepted, much narrower residue of the same class of race,
 * identical to what opening any path by name always carries on a POSIX filesystem.
 */
function scanFiles(
  reader: RepoReader,
  root: string,
  ignore: readonly string[],
): readonly ScannedFile[] {
  const found: ScannedFile[] = [];
  const walk = (dir: string, relDir: string): void => {
    const listed = fsCall('list the directory', dir, () => reader.list(dir));
    for (const entry of listed.map((item) => item.name).toSorted()) {
      const rel = relDir === '' ? entry : `${relDir}/${entry}`;
      if (isIgnored(rel, ignore)) continue;
      const full = join(dir, entry);
      const stat = fsCall('stat', full, () => reader.stat(full));
      if (stat === undefined) continue; // the reader has nothing there
      if (stat.isSymlink) continue;
      if (stat.isDirectory) walk(full, rel);
      else if (stat.isFile) {
        const bytes = fsCall('read the file', full, () => reader.read(full));
        found.push({ rel, bytes });
      }
    }
  };
  walk(root, '');
  return found;
}

/** See {@link RepoMapOptions.ignore} for the two match modes. */
function isIgnored(rel: string, ignore: readonly string[]): boolean {
  for (const entry of ignore) {
    const cleaned = entry.replace(/\/+$/, '');
    if (cleaned === '') continue;
    // Prefix mode is decided on the entry AS WRITTEN, before the trailing slash is
    // trimmed: `build/` contains a `/` and so is the documented root-relative prefix
    // (the root-level `build` tree), not a bare name that would match a `build`
    // segment at any depth.
    if (entry.includes('/')) {
      if (rel === cleaned || rel.startsWith(`${cleaned}/`)) return true;
    } else if (rel.split('/').includes(cleaned)) {
      return true;
    }
  }
  return false;
}

/** One ranked definition in fill order, with the focus term that promoted it, if any. */
interface OrderedDefinition {
  readonly definition: RankedDefinition;
  readonly focusTerm?: string;
}

/**
 * The fill order: focus-matched definitions first, then the rest, each partition
 * keeping the ranker's total order. A stable partition of a deterministic order is
 * itself deterministic, so the map's byte-for-byte claim survives focus untouched.
 * The match is a case-insensitive substring over name and path — the lexical
 * planner's default, so "focus" means the same thing in both places — and the
 * *first* matching term in caller order is the one the receipt names.
 */
function orderWithFocus(
  ranked: readonly RankedDefinition[],
  focus: readonly string[],
): readonly OrderedDefinition[] {
  if (focus.length === 0) return ranked.map((definition) => ({ definition }));
  const needles = focus.map((term) => term.toLowerCase());
  const matched: OrderedDefinition[] = [];
  const rest: OrderedDefinition[] = [];
  for (const definition of ranked) {
    const haystack = `${definition.path}\0${definition.name}`.toLowerCase();
    const index = needles.findIndex((needle) => haystack.includes(needle));
    if (index === -1) rest.push({ definition });
    else matched.push({ definition, focusTerm: focus[index]! });
  }
  return [...matched, ...rest];
}

/** One rendered map line. Everything in it is measured, nothing estimated. */
function renderDefinition(definition: RankedDefinition): string {
  return (
    `${definition.path}:${String(definition.line)} ${definition.kind} ${definition.name} ` +
    `[${String(definition.refsIn)} in from ${String(definition.refsInFiles)} ` +
    `${plural('file', definition.refsInFiles)}, ${String(definition.refsOut)} out]`
  );
}

/** Law 2, applied to inclusion: the receipt every included symbol carries. */
function toEntry(definition: RankedDefinition, focusTerm?: string): RepoMapEntry {
  const site = `defined at ${definition.path}:${String(definition.line)}`;
  const counts =
    `${String(definition.refsIn)} ${plural('reference', definition.refsIn)} in ` +
    `from ${String(definition.refsInFiles)} ${plural('file', definition.refsInFiles)}; ` +
    `its file makes ${String(definition.refsOut)} ` +
    `${plural('reference', definition.refsOut)} out`;
  const reason: RepoMapReason =
    focusTerm !== undefined
      ? {
          rule: REPO_MAP_FOCUS_RULE,
          explanation: `${site}; matches focus "${focusTerm}"; ${counts}`,
        }
      : definition.refsIn === 0
        ? {
            rule: REPO_MAP_UNREFERENCED_RULE,
            explanation: `${site}; no references to it anywhere in the scanned tree`,
          }
        : {
            rule: REPO_MAP_RANKED_RULE,
            explanation: `${site}; ${counts}`,
          };
  return {
    path: definition.path,
    name: definition.name,
    kind: definition.kind,
    line: definition.line,
    rank: definition.rank,
    refsIn: definition.refsIn,
    refsInFiles: definition.refsInFiles,
    refsOut: definition.refsOut,
    reason,
  };
}

function plural(word: string, count: number): string {
  return count === 1 ? word : `${word}s`;
}
