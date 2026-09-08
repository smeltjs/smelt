/**
 * Byte-faithful edits to somebody else's TOML file. `text/json-edit.ts`'s sibling and
 * the same contract: **change the one table you were asked to change and leave every
 * other byte alone** — comments, key order, quoting style, other people's tables and
 * dotted keys all ride through verbatim.
 *
 * Codex and Grok register MCP servers as a table keyed by server name —
 * `[mcp_servers.<name>]` with `command`/`args`/`env` in `~/.codex/config.toml`
 * (<https://developers.openai.com/codex/config-reference>, cross-checked against the
 * `McpServerTransportConfig::Stdio` struct at
 * <https://github.com/openai/codex/blob/main/codex-rs/config/src/mcp_types.rs>, which is
 * exactly `command: String, args: Vec<String>, env: Option<HashMap<String,String>>`) and
 * the same `[mcp_servers.<name>]` shape in Grok's `.grok/config.toml` / `~/.grok/config.toml`
 * (<https://docs.x.ai/build/settings/reference>, verified 2026-09-08). Both cited docs
 * agree on the table header and the `command`/`args`/`env` fields, so one editor serves
 * both harnesses.
 *
 * {@link editTomlTable} is the one export a harness profile's `mcp-registration` step
 * needs: replace, insert or remove **one table** named by a two-segment path (the
 * container key, then the server name — `['mcp_servers', 'smelt']`) in a TOML file's
 * source text.
 *
 * ## Scanner, not a parser
 *
 * Like `json-edit.ts`, this is a **scoped scanner**: it walks the file line by line,
 * classifying each line as a single-bracket table header (`[a.b]`), an array-of-tables
 * header (`[[a.b]]`), a key/value line (`a.b.c = …`, tracked against the table the
 * scan is currently inside), or an ordinary line it does not need to understand. Zero
 * new runtime dependencies — the same call the JSON editor made, for the same reason:
 * a full TOML tokenizer is a dependency `@smeltjs/core` would carry into every
 * consumer's tree for one install step, and the scoped scanner only ever needs to
 * recognise **its own path**; everything else is preserved by never being touched.
 *
 * What the scanner deliberately does not attempt, each because the shape does not occur
 * in an MCP registration and handling it would cost real complexity for no fixture that
 * exercises it:
 *
 *  - **Multi-line basic/literal strings** (`"""…"""`, `'''…'''`). A value this editor
 *    ever *writes* is a short command or arg, never a multi-line string, and the
 *    bracket-balance continuation tracker below only follows `[`/`]`, not `"""`, so a
 *    multi-line string containing an unbalanced `[` in its body could be misread as an
 *    open array. Out of scope for the same reason JSON's scanner refuses a non-object
 *    root rather than guessing.
 *  - **Dotted keys nested under an open table header** (`[mcp_servers]` followed by
 *    `smelt.command = …`) are still resolved correctly — the scanner tracks the
 *    *current table path* across headers and prefixes every key line's own dotted
 *    segments with it — but a key path is only as trustworthy as its quoting: an
 *    escape sequence inside a quoted key is decoded with `JSON.parse`, which accepts a
 *    strict superset of what TOML's basic-string escapes allow; a key that relies on
 *    the difference is refused (segment kept unparsed, so it fails to match) rather
 *    than mis-resolved.
 */

/** How a TOML file is laid out — the one convention a rendered table must match. */
export interface TomlStyle {
  /** `'\r\n'` when the file uses it anywhere, `'\n'` otherwise. */
  readonly newline: string;
}

/** The newline convention an existing file uses, detected once before any edit. */
export function tomlStyle(text: string): TomlStyle {
  return { newline: text.includes('\r\n') ? '\r\n' : '\n' };
}

/** A value this editor can render into TOML — everything an MCP registration needs. */
export type TomlScalar = string | number | boolean;
export type TomlValue = TomlScalar | readonly TomlScalar[];
/** The body of one table this editor writes: `{ command: 'npx', args: [...] }`. */
export type TomlTable = Readonly<Record<string, TomlValue>>;

/**
 * Replace, insert or remove the table named by `path` (`['mcp_servers', 'smelt']`) in
 * `text`, leaving every other byte verbatim.
 *
 *  - `value` defined: an existing `[path[0].path[1]]` header — or, failing that, the
 *    scattered dotted-key lines that define the same path — is replaced by a freshly
 *    rendered `[path[0].path[1]]` table. Absent either, the table is appended after
 *    exactly one blank line (none, when the file is empty or blank).
 *  - `value === undefined`: the existing table (header form or dotted form) is
 *    removed; a path that is not there is a no-op and `text` comes back unchanged.
 *
 * `style` defaults to {@link tomlStyle} of `text`; pass it explicitly when making
 * several edits to one file, the same convention `editTopLevelProperty` follows.
 *
 * Returns `undefined` only when the path is genuinely ambiguous — both a table header
 * *and* dotted-key lines already define it, which is not valid TOML (a key cannot be
 * defined twice) and this editor refuses to guess which one the file's own tools would
 * honour.
 */
export function editTomlTable(
  text: string,
  path: readonly [string, string],
  value: TomlTable | undefined,
  style: TomlStyle = tomlStyle(text),
): string | undefined {
  const entries = scanTomlEntries(text);
  const header = entries.find(
    (entry): entry is TomlHeaderEntry => entry.kind === 'header' && pathEquals(entry.path, path),
  );
  const dotted = entries.filter(
    (entry): entry is TomlKeyEntry => entry.kind === 'key' && isDottedRedefinition(entry, path),
  );
  if (header !== undefined && dotted.length > 0) return undefined; // ambiguous: refuse

  if (value === undefined) {
    if (header !== undefined) {
      return (
        text.slice(0, header.start).replace(/(?:\r\n|\n)+$/, style.newline) + text.slice(header.end)
      );
    }
    if (dotted.length > 0) return removeSpans(text, dotted);
    return text; // nothing of ours here
  }

  const rendered = renderTomlTable(path, value, style.newline);
  if (header !== undefined) {
    return text.slice(0, header.start) + rendered + text.slice(header.end);
  }
  const base = dotted.length > 0 ? removeSpans(text, dotted) : text;
  return appendTomlBlock(base, rendered, style);
}

/**
 * Whether `path` is already defined in `text`, table-header form or dotted-key form —
 * the one predicate `smelt doctor`'s installed-state reader needs, over the same scan
 * {@link editTomlTable} uses rather than a second, looser check.
 */
export function hasTomlEntry(text: string, path: readonly [string, string]): boolean {
  return scanTomlEntries(text).some(
    (entry) =>
      (entry.kind === 'header' && pathEquals(entry.path, path)) ||
      (entry.kind === 'key' && isDottedRedefinition(entry, path)),
  );
}

/**
 * Whether a key/value line is itself a (partial or complete) *redefinition* of
 * `path`, as opposed to an ordinary field inside a table a header already opened.
 * `command = "npx"` inside `[mcp_servers.smelt]` has `path` `['mcp_servers','smelt',
 * 'command']` — a prefix match on its own — but its {@link TomlKeyEntry.contextDepth}
 * is 2, not less than `path`'s length, so it does not count: the header already
 * defined the table, and this is just one of its fields.
 */
function isDottedRedefinition(entry: TomlKeyEntry, path: readonly string[]): boolean {
  return entry.contextDepth < path.length && isPrefixPath(entry.path, path);
}

/* ------------------------------------------------------------------------------------
 * Rendering
 * ---------------------------------------------------------------------------------- */

function renderTomlTable(
  path: readonly [string, string],
  value: TomlTable,
  newline: string,
): string {
  const header = `[${renderKeySegment(path[0])}.${renderKeySegment(path[1])}]`;
  const lines = [
    header,
    ...Object.entries(value).map(([key, v]) => `${renderKeySegment(key)} = ${renderTomlValue(v)}`),
  ];
  return lines.join(newline) + newline;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

function renderKeySegment(segment: string): string {
  return BARE_KEY.test(segment) ? segment : JSON.stringify(segment);
}

function renderTomlValue(value: TomlValue): string {
  if (Array.isArray(value)) return `[${value.map(renderTomlScalar).join(', ')}]`;
  return renderTomlScalar(value as TomlScalar);
}

function renderTomlScalar(value: TomlScalar): string {
  if (typeof value === 'string') return JSON.stringify(value);
  return String(value);
}

/**
 * Append `block` after `base`, separated by exactly one blank line — none when `base`
 * is empty or blank, mirroring {@link upsertMarkerBlock}'s fallback branch. `block`
 * already ends in one `newline`; `base`'s own trailing newlines are dropped first so
 * the separator is exactly two, once, regardless of what `base` had (nothing, one, or
 * several) or lacked (a file with no trailing newline at all).
 */
function appendTomlBlock(base: string, block: string, style: TomlStyle): string {
  if (base.trim() === '') return block;
  const trimmed = base.replace(/(?:\r\n|\n)+$/, '');
  return `${trimmed}${style.newline}${style.newline}${block}`;
}

/** Delete each entry's exact span from `text`, in one linear pass over the original. */
function removeSpans(
  text: string,
  spans: readonly { readonly start: number; readonly end: number }[],
): string {
  const sorted = spans.toSorted((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  for (const span of sorted) {
    result += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

function pathEquals(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

function isPrefixPath(full: readonly string[], prefix: readonly string[]): boolean {
  return full.length >= prefix.length && prefix.every((segment, i) => full[i] === segment);
}

/* ------------------------------------------------------------------------------------
 * The scan
 * ---------------------------------------------------------------------------------- */

interface TomlHeaderEntry {
  readonly kind: 'header';
  readonly path: readonly string[];
  /** Offset of the header line's first character. */
  readonly start: number;
  /** Offset of the next sibling-or-shallower header, or `text.length`. */
  readonly end: number;
}

interface TomlKeyEntry {
  readonly kind: 'key';
  /** The table path this key resolves to: the table it sits in, plus its own dots. */
  readonly path: readonly string[];
  /**
   * How many of {@link path}'s segments came from the *enclosing table*, rather than
   * from this line's own dots. A field of an already-open table (`command = "npx"`
   * inside `[mcp_servers.smelt]`, context depth 2) is not a competing definition of
   * that table — only a line whose own dots *reach into* a path from shallower than
   * it (context depth less than the path's length) can be one, which is what tells
   * `mcp_servers.smelt.command = …` at the root apart from an ordinary field of a
   * table already named by a header.
   */
  readonly contextDepth: number;
  readonly start: number;
  /** One past this assignment's last byte, following any multi-line array it opens. */
  readonly end: number;
}

type TomlEntry = TomlHeaderEntry | TomlKeyEntry;

/** One physical line, with the exact bytes that terminate it (`''` at EOF). */
interface TomlLine {
  readonly content: string;
  readonly eol: string;
}

function splitTomlLines(text: string): TomlLine[] {
  const lines: TomlLine[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n') {
      const crlf = i > start && text[i - 1] === '\r';
      const contentEnd = crlf ? i - 1 : i;
      lines.push({ content: text.slice(start, contentEnd), eol: text.slice(contentEnd, i + 1) });
      start = i + 1;
    }
  }
  if (start < text.length) lines.push({ content: text.slice(start), eol: '' });
  return lines;
}

/**
 * Walk `text` once, producing every table header and every key/value assignment as an
 * offset-located entry. Table-header spans are resolved in a second pass, once every
 * header's start is known, so a header's body correctly swallows its own nested
 * sub-tables (`[mcp_servers.smelt.env]` is inside `[mcp_servers.smelt]`'s span) but
 * stops at the next header that is not one of its descendants.
 */
function scanTomlEntries(text: string): TomlEntry[] {
  const lines = splitTomlLines(text);
  const keys: TomlKeyEntry[] = [];
  const headerStarts: { path: string[]; start: number }[] = [];

  let offset = 0;
  let currentPath: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const lineStart = offset;
    const lineEnd = offset + line.content.length + line.eol.length;
    const trimmed = line.content.trim();

    const header = matchTomlHeader(trimmed);
    if (header !== undefined) {
      currentPath = [...header];
      headerStarts.push({ path: [...header], start: lineStart });
      offset = lineEnd;
      i += 1;
      continue;
    }

    const key = matchTomlKeyLine(line.content);
    if (key !== undefined) {
      let depth = netBracketDelta(key.valueTail);
      let entryEnd = lineEnd;
      let j = i + 1;
      while (depth > 0 && j < lines.length) {
        const cont = lines[j]!;
        depth += netBracketDelta(cont.content);
        entryEnd += cont.content.length + cont.eol.length;
        j += 1;
      }
      keys.push({
        kind: 'key',
        path: [...currentPath, ...key.segments],
        contextDepth: currentPath.length,
        start: lineStart,
        end: entryEnd,
      });
      offset = entryEnd;
      i = j;
      continue;
    }

    offset = lineEnd;
    i += 1;
  }

  const headers: TomlHeaderEntry[] = headerStarts.map((h, index) => {
    let end = text.length;
    for (let k = index + 1; k < headerStarts.length; k += 1) {
      const other = headerStarts[k]!;
      if (!isPrefixPath(other.path, h.path)) {
        end = other.start;
        break;
      }
    }
    return { kind: 'header', path: h.path, start: h.start, end };
  });

  return [...keys, ...headers].toSorted((a, b) => a.start - b.start);
}

/** `[a.b]` or `[[a.b]]`, trailing comment allowed — `undefined` for anything else. */
function matchTomlHeader(trimmed: string): readonly string[] | undefined {
  const array = /^\[\[(.*)\]\]\s*(?:#.*)?$/.exec(trimmed);
  const inner = array !== undefined && array !== null ? array[1]! : singleHeaderInner(trimmed);
  if (inner === undefined) return undefined;
  const parsed = parseTomlKeyPath(inner, 0);
  if (parsed === undefined || inner.slice(parsed.end).trim() !== '') return undefined;
  return parsed.segments;
}

function singleHeaderInner(trimmed: string): string | undefined {
  const m = /^\[(.*)\]\s*(?:#.*)?$/.exec(trimmed);
  return m?.[1];
}

/** A `key.path = value` line: the parsed key segments and the raw value text. */
function matchTomlKeyLine(
  content: string,
): { readonly segments: readonly string[]; readonly valueTail: string } | undefined {
  const leading = /^[ \t]*/.exec(content)![0].length;
  const parsed = parseTomlKeyPath(content, leading);
  if (parsed === undefined) return undefined;
  let i = parsed.end;
  while (i < content.length && (content[i] === ' ' || content[i] === '\t')) i += 1;
  if (content[i] !== '=') return undefined;
  return { segments: parsed.segments, valueTail: content.slice(i + 1) };
}

/**
 * A dotted key path starting at `from` — bare (`[A-Za-z0-9_-]+`) or quoted segments,
 * joined by `.`. Returns the segments and the offset one past the last one consumed;
 * `undefined` when `from` is not the start of a key path at all (blank line, comment,
 * a value line, anything not shaped like a key).
 */
function parseTomlKeyPath(
  raw: string,
  from: number,
): { readonly segments: string[]; readonly end: number } | undefined {
  const segments: string[] = [];
  let i = from;
  for (;;) {
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i += 1;
    if (i >= raw.length) return undefined;
    const ch = raw[i];
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      let value = '';
      while (j < raw.length && raw[j] !== ch) {
        if (ch === '"' && raw[j] === '\\' && j + 1 < raw.length) {
          value += raw[j]! + raw[j + 1]!;
          j += 2;
        } else {
          value += raw[j];
          j += 1;
        }
      }
      if (j >= raw.length) return undefined; // unterminated quote
      segments.push(ch === '"' ? unescapeBasicString(value) : value);
      i = j + 1;
    } else {
      const start = i;
      while (i < raw.length && /[A-Za-z0-9_-]/.test(raw[i]!)) i += 1;
      if (i === start) return undefined; // not a key token at all
      segments.push(raw.slice(start, i));
    }
    while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i += 1;
    if (i < raw.length && raw[i] === '.') {
      i += 1;
      continue;
    }
    return { segments, end: i };
  }
}

/**
 * TOML basic-string escapes decode as JSON's do for every sequence TOML defines
 * (`\"`, `\\`, `\n`, `\t`, `\r`, `\b`, `\f`, `\uXXXX`); `JSON.parse` accepts a strict
 * superset, so a segment that only resolves under the extra cases (a bare control
 * character JSON tolerates but TOML would not have produced) is vanishingly unlikely
 * from a real TOML writer. A key this cannot decode is left unparsed — a segment that
 * therefore fails to match anything, so the file is preserved rather than mis-edited.
 */
function unescapeBasicString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
  } catch {
    return value;
  }
}

/**
 * Net `[`/`]` depth of a line's tail, skipping quoted spans so a literal bracket
 * inside a string is not counted. TOML inline tables (`{ … }`) are single-line by
 * spec, so only `[`/`]` — the array bracket — can leave a line's depth non-zero.
 */
function netBracketDelta(text: string): number {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '#') break; // a comment runs to end of line, outside any string here
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (quote === '"' && text[i] === '\\') i += 2;
        else i += 1;
      }
      i += 1;
      continue;
    }
    if (ch === '[') depth += 1;
    else if (ch === ']') depth -= 1;
    i += 1;
  }
  return depth;
}
