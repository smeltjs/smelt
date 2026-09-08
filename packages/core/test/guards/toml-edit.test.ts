import { describe, expect, it } from 'vitest';

// Through @guard, so the mutation runner can point this at a deliberately broken copy
// of `src`. See scripts/mutate.mjs.
import { editTomlTable, hasTomlEntry, tomlStyle } from '@guard/text/toml-edit';
import type { TomlTable } from '@guard/text/toml-edit';

import type { GuardMutation } from './_mutations.ts';

/**
 * TOML-EDIT GUARD — `text/toml-edit.ts`'s half of the byte-faithful contract
 * `text/json-edit.ts` already carries for JSON: **the edit changes the table it was
 * asked to change, and no other byte.**
 *
 * Codex and Grok register MCP servers in `[mcp_servers.<name>]` TOML
 * (`text/toml-edit.ts`'s module doc cites both primary sources). A file this editor
 * touches is somebody else's config — comments, other servers, whatever dialect they
 * wrote their own entries in — and the promise is the same one the JSON editor makes:
 * the diff after an install is the `smelt` table and nothing else, and `remove` gives
 * the file back.
 *
 * Three assertions carry that, over a corpus of hand-shaped TOML the installer itself
 * never writes:
 *
 *  1. **Round trip.** Insert our table, then remove it: the original bytes back
 *     (trailing-newline-normalized, the same one-trailing-newline convention
 *     `upsertMarkerBlock`/`stripMarkerBlock` already establish for this codebase).
 *  2. **Every foreign byte rides through** — comments, a sibling table, a sibling
 *     registered via dotted keys instead of a header, an inline table, a multi-line
 *     array with a trailing comma, CRLF, no trailing newline.
 *  3. **Our own entry is found in either representation** a hand-edit could have left
 *     it in (header or dotted), and canonicalized to one table on the next install.
 *
 * The mutations below break each half and prove the guard notices.
 */

const ENTRY: TomlTable = { command: 'npx', args: ['-y', '@smeltjs/mcp'] };
const PATH = ['mcp_servers', 'smelt'] as const;

/** Foreign files, none in the shape this editor itself renders. */
const CORPUS: readonly { readonly label: string; readonly text: string }[] = [
  {
    label: 'comments and a sibling table, LF',
    text:
      '# global config\n' +
      'theme = "dark"\n' +
      '\n' +
      '[mcp_servers.other]\n' +
      '# a hand-registered server\n' +
      'command = "uvx"\n' +
      'args = ["some-server"]\n',
  },
  {
    label: 'a sibling registered via dotted keys, CRLF',
    text:
      'mcp_servers.other.command = "uvx"\r\n' +
      'mcp_servers.other.args = ["a", "b"]\r\n' +
      '\r\n' +
      '[some_other_table]\r\n' +
      'x = 1\r\n',
  },
  {
    label: 'inline table and a multi-line array with a trailing comma',
    text:
      '[mcp_servers.other]\n' +
      'env = { FOO = "bar", BAZ = "qux" }\n' +
      'args = [\n' +
      '  "a",\n' +
      '  "b",\n' +
      ']\n' +
      '\n' +
      '[unrelated]\n' +
      'y = 2\n',
  },
  { label: 'no trailing newline', text: 'theme = "dark"' },
  { label: 'empty file', text: '' },
];

describe('the byte-faithful TOML editor changes one table and nothing else', () => {
  for (const { label, text } of CORPUS) {
    it(`round trip — insert then remove restores the bytes: ${label}`, () => {
      const inserted = editTomlTable(text, PATH, ENTRY);
      expect(inserted).toBeDefined();
      expect(inserted).toContain('[mcp_servers.smelt]');
      expect(inserted).toContain('command = "npx"');
      expect(inserted).toContain('args = ["-y", "@smeltjs/mcp"]');
      expect(hasTomlEntry(inserted!, PATH)).toBe(true);

      const removed = editTomlTable(inserted!, PATH, undefined);
      // The same normalization `stripMarkerBlock` already establishes: a blank-line
      // separator this editor itself added on insert does not survive removal, and a
      // file with no trailing newline at all gains exactly one, in the file's own
      // newline convention — never a hardcoded '\n' regardless of what the file uses.
      const normalized =
        text.trim() === '' ? text : text.replace(/(?:\r\n|\n)*$/, tomlStyle(text).newline);
      expect(
        removed,
        'remove after insert must give back the original bytes (trailing newline normalized)',
      ).toBe(normalized);
    });

    it(`every foreign byte rides through untouched: ${label}`, () => {
      if (text.trim() === '') return; // nothing foreign in an empty file
      const inserted = editTomlTable(text, PATH, ENTRY)!;
      for (const line of text.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        expect(inserted, `line dropped or altered: ${JSON.stringify(line)}`).toContain(line);
      }
    });
  }

  it('replaces an existing header-form entry in place, siblings untouched', () => {
    const text =
      '[mcp_servers.other]\n' +
      'command = "uvx"\n' +
      '\n' +
      '[mcp_servers.smelt]\n' +
      'command = "old-command"\n' +
      'args = ["old"]\n' +
      '\n' +
      '[zzz]\n' +
      'after = true\n';
    const edited = editTomlTable(text, PATH, ENTRY)!;
    expect(edited).toContain('[mcp_servers.other]\ncommand = "uvx"');
    expect(edited).toContain('[zzz]\nafter = true');
    expect(edited).not.toContain('old-command');
    expect(edited).toContain('[mcp_servers.smelt]\ncommand = "npx"\nargs = ["-y", "@smeltjs/mcp"]');
  });

  it('a nested sub-table under our own header is swallowed by removal, not orphaned', () => {
    const text =
      '[mcp_servers.smelt]\n' +
      'command = "npx"\n' +
      '\n' +
      '[mcp_servers.smelt.env]\n' +
      'FOO = "bar"\n' +
      '\n' +
      '[after]\n' +
      'x = 1\n';
    const removed = editTomlTable(text, PATH, undefined)!;
    expect(removed).not.toContain('mcp_servers.smelt');
    expect(removed).toContain('[after]\nx = 1\n');
  });

  it('finds a dotted-key registration and canonicalizes it to one table on insert', () => {
    const text =
      'mcp_servers.smelt.command = "old"\n' +
      'mcp_servers.smelt.args = ["old"]\n' +
      '\n' +
      '[after]\n' +
      'x = 1\n';
    expect(hasTomlEntry(text, PATH)).toBe(true);
    const edited = editTomlTable(text, PATH, ENTRY)!;
    expect(edited).not.toContain('mcp_servers.smelt.command');
    expect(edited).toContain('[mcp_servers.smelt]\ncommand = "npx"');
    expect(edited).toContain('[after]\nx = 1\n');
  });

  it('removes a dotted-key registration entirely, leaving the rest untouched', () => {
    const text =
      '# note\n' +
      'mcp_servers.smelt.command = "old"\n' +
      'mcp_servers.smelt.args = ["old"]\n' +
      '\n' +
      'kept = 1\n';
    const removed = editTomlTable(text, PATH, undefined)!;
    expect(removed).not.toContain('mcp_servers.smelt');
    expect(removed).toContain('# note\n');
    expect(removed).toContain('kept = 1\n');
  });

  it('a path defined both as a header and dotted keys is refused, not guessed', () => {
    // The dotted line must sit at the root (before any header) to be a genuine
    // second definition of the same table — the same line written *inside*
    // `[mcp_servers.smelt]` would just be an ordinary (oddly-named) field of it,
    // which `isDottedRedefinition`'s `contextDepth` check exists to tell apart.
    const text =
      'mcp_servers.smelt.command = "old"\n' +
      '\n' +
      '[mcp_servers.smelt]\n' +
      'args = ["also-here"]\n';
    expect(editTomlTable(text, PATH, ENTRY)).toBeUndefined();
    expect(editTomlTable(text, PATH, undefined)).toBeUndefined();
  });

  it('a path nobody registered removes as a no-op', () => {
    const text = '[other]\nx = 1\n';
    expect(editTomlTable(text, PATH, undefined)).toBe(text);
    expect(hasTomlEntry(text, PATH)).toBe(false);
  });

  it('a stray bracket inside a quoted sibling value never swallows the next header', () => {
    // `weird`'s value contains a literal, unmatched `[` — a bracket count that does
    // not skip quoted spans would read this line as opening a multi-line array and
    // swallow the very next line (our own header) as if it were that array's
    // continuation, so the header search below it would never find it.
    const text =
      '[mcp_servers.other]\n' +
      'weird = "contains a [ bracket"\n' +
      '\n' +
      '[mcp_servers.smelt]\n' +
      'command = "old"\n';
    const edited = editTomlTable(text, PATH, ENTRY)!;
    expect(edited).toContain('weird = "contains a [ bracket"');
    // Replaced in place — exactly one [mcp_servers.smelt] header, the old command gone.
    expect(edited.match(/\[mcp_servers\.smelt\]/g)).toHaveLength(1);
    expect(edited).not.toContain('"old"');
    expect(edited).toContain('command = "npx"');
  });

  it('quotes a key segment that is not a bare identifier', () => {
    const edited = editTomlTable('', ['mcp servers', 'my.server'] as const, { command: 'x' })!;
    expect(edited).toBe('["mcp servers"."my.server"]\ncommand = "x"\n');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'toml-edit-bracket-delta-ignores-quotes',
    file: 'text/toml-edit.ts',
    find: "    if (ch === '\"' || ch === \"'\") {\n      const quote = ch;\n      i += 1;\n      while (i < text.length && text[i] !== quote) {\n        if (quote === '\"' && text[i] === '\\\\') i += 2;\n        else i += 1;\n      }\n      i += 1;\n      continue;\n    }\n    if (ch === '[') depth += 1;",
    replace: "    if (ch === '[') depth += 1;",
    why: 'a literal `[` or `]` inside a quoted value counted as a real array bracket — a sibling entry whose string value happens to contain one would be misjudged as an unclosed multi-line array, and the next physical line (which could be the header this editor is looking for) would be silently swallowed into the wrong entry’s span',
  },
  {
    id: 'toml-edit-header-span-ignores-nesting',
    file: 'text/toml-edit.ts',
    find: '      if (!isPrefixPath(other.path, h.path)) {',
    replace: '      if (true) {',
    why: 'every later header treated as a boundary, including our own table’s nested sub-tables (`[mcp_servers.smelt.env]`) — removing our registration would leave an orphaned, dangling sub-table behind instead of taking the whole thing out cleanly',
  },
  {
    id: 'toml-edit-remove-leaves-double-blank-line',
    file: 'text/toml-edit.ts',
    find: '        text.slice(0, header.start).replace(/(?:\\r\\n|\\n)+$/, style.newline) +',
    replace: '        text.slice(0, header.start) +',
    why: 'the blank-line separator this editor itself added on insert surviving its own removal — an apply→remove round trip would leave a stray blank line the user never asked for, the same normalization `stripMarkerBlock` already guarantees for the JSON/instruction-file case',
  },
];
