/**
 * The lava palette — every byte of colour smelt writes, and the primitives that lay
 * text out under it. One adapter behind the output seam (ADR-0001: Node-native; the
 * charm.land palette, not its Go).
 *
 * The spike verdict this module embodies: clack and ink could not sit *inside* the
 * wizard loop. Their prompts own the terminal — raw mode, cursor surgery, direct
 * stdin reads — which is exactly what the injected `AnswerStream` exists to prevent:
 * the guards test every wizard in-process by scripting that stream, and a component
 * that bypasses it cannot be guard-tested at all. So the renderer went one seam
 * out: it decorates the bytes the wizards already emit, line-semantically, and
 * switches itself off unless a real, interactive, colour-honouring terminal is on
 * the other side. No dependency, no layout engine — and every wizard guard passes
 * byte-identical, because a palette that is off is the identity.
 *
 * **Why no `picocolors`.** It is the right package for the job it does, and it would
 * have to be added to `ALLOWED_PACKAGES`, to `THIRD-PARTY.md` and to the install of
 * every consumer — to spell eight SGR codes this file already spelled, and *not* to
 * spell the one thing the brand is actually made of: a truecolor gradient. A
 * dependency that carries none of the load is a dependency to refuse (Law 1's
 * neighbourhood: the smaller the tree, the less there is to audit).
 *
 * Three rules hold everything here together, and `test/guards/palette.test.ts` holds
 * this module to all three:
 *
 *   1. **Off is the identity.** Every role, every primitive and every glyph renders
 *      the same bytes with colour off that it rendered before this module existed.
 *      Every `--json` envelope, every `--yes` receipt and every pipe reads plain text.
 *   2. **ANSI wraps whole spans, never splits a word.** The substrings other guards
 *      assert (`wrote CLAUDE.md`, `wired (verified)`, `Nothing was written.`) stay
 *      contiguous inside the styled line, and padding is computed on the *unpainted*
 *      text — an escape sequence has zero width, so a column padded after painting is
 *      a column that does not line up.
 *   3. **A rendering may not round a non-zero to zero.** Law 4 reaches the formatter:
 *      {@link percent} prints `<0.1%` rather than `0.0%`, and {@link Palette.bar}
 *      never draws an empty bar for a rate that is not zero.
 */

/** Where the lava gradient starts and ends, in truecolor. */
const LAVA_FROM = [124, 45, 18] as const; // deep ember
const LAVA_TO = [245, 158, 11] as const; // amber

const CODE = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  amber: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

function truecolor([r, g, b]: readonly number[]): string {
  return `\x1b[38;2;${String(r)};${String(g)};${String(b)}m`;
}

/** The gradient stop at `t ∈ [0, 1]`, as an SGR sequence. */
function lavaStop(t: number): string {
  const at = (i: number): number => Math.round(LAVA_FROM[i]! + (LAVA_TO[i]! - LAVA_FROM[i]!) * t);
  return truecolor([at(0), at(1), at(2)]);
}

/**
 * The wordmark, in the **ANSI Shadow** figlet letterforms — drawn once, by hand, in
 * that font's shapes, and committed as this constant.
 *
 * Pinned as data on purpose: `figlet` at runtime would be a dependency, a font file to
 * resolve and a code path that reads something off disk in order to print a logo. The
 * logo does not change. A constant is the honest shape of a thing that does not change.
 */
const LOGO_UNICODE = [
  '███████╗███╗   ███╗███████╗██╗     ████████╗',
  '██╔════╝████╗ ████║██╔════╝██║     ╚══██╔══╝',
  '███████╗██╔████╔██║█████╗  ██║        ██║',
  '╚════██║██║╚██╔╝██║██╔══╝  ██║        ██║',
  '███████║██║ ╚═╝ ██║███████╗███████╗   ██║',
  '╚══════╝╚═╝     ╚═╝╚══════╝╚══════╝   ╚═╝',
] as const;

/**
 * The same wordmark in plain ASCII, for a terminal whose locale never promised it
 * could render the block-drawing set. Hand-drawn in the `small` figlet shapes.
 *
 * Not a nicety: a box-drawing character on a latin-1 terminal is mojibake in the very
 * first thing smelt ever shows a person.
 */
const LOGO_ASCII = [
  ' ___ __  __ ___ _  _____',
  '/ __|  \\/  | __| ||_   _|',
  '\\__ \\ |\\/| | _|| |__| |',
  '|___/_|  |_|___|____|_|',
] as const;

/** The widest line of a block, in characters. */
function widest(lines: readonly string[]): number {
  return lines.reduce((wide, line) => Math.max(wide, [...line].length), 0);
}

/**
 * Whether this environment's locale says it can render more than ASCII.
 *
 * Read from the three variables every POSIX locale uses, in the precedence the C
 * library itself uses (`LC_ALL` over `LC_CTYPE` over `LANG`). A terminal that has not
 * said it can is treated as one that cannot: the fallbacks are always readable, and
 * mojibake is not.
 *
 * It is read once, in `bin.ts`, and handed to the CLI as a boolean — never read inside
 * a verb. A verb reads its environment by name only, and only for a name a config file
 * supplied (see `CliIo.env`).
 */
export function supportsUnicode(env: Readonly<Record<string, string | undefined>>): boolean {
  const locale = env['LC_ALL'] ?? env['LC_CTYPE'] ?? env['LANG'] ?? '';
  return /utf-?8/iu.test(locale);
}

/**
 * Whether ANSI may be written to a stream, given what the process was told.
 *
 * `NO_COLOR` wins over everything (no-color.org: *any* non-empty value), then
 * `FORCE_COLOR` — which is how a person asks for colour through a pipe, into `less -R`
 * or a CI log that renders it — and only then the question of whether this stream is a
 * terminal at all.
 */
export function colorAllowed(
  env: Readonly<Record<string, string | undefined>>,
  isTty: boolean,
): boolean {
  const no = env['NO_COLOR'];
  if (no !== undefined && no !== '') return false;
  const force = env['FORCE_COLOR'];
  if (force !== undefined && force !== '' && force !== '0') return true;
  return isTty;
}

/**
 * What a span of text *is*, rather than what colour it should be.
 *
 * Roles, not colours, because the caller that knows a token is a hash does not know —
 * and must not decide — that hashes are dim. That is the whole reason no verb builds
 * an escape sequence inline: the day the brand changes, it changes here.
 */
export type Role =
  | 'plain'
  | 'brand'
  | 'heading'
  | 'rule'
  | 'hash'
  | 'number'
  | 'path'
  | 'good'
  | 'bad'
  | 'warn'
  | 'dim'
  | 'strong';

/** The status marks every verb shares. The ASCII fallbacks are not second-class. */
export type Glyph = 'ok' | 'bad' | 'warn' | 'info' | 'bullet';

/** One `name  value` row. The `role` paints the value; the name is always plain. */
export interface KvRow {
  readonly name: string;
  readonly value: string;
  readonly role?: Role;
}

/** One column of a rendered table: its header, its side, and what its cells are. */
export interface Column {
  readonly header: string;
  readonly align?: 'left' | 'right';
  readonly role?: Role;
}

/** A table, as data: the palette pads it (unpainted) and then paints it. */
export interface TableSpec {
  readonly columns: readonly Column[];
  readonly rows: readonly (readonly string[])[];
  /** Spaces before every line. Defaults to two — the report's own indent. */
  readonly indent?: number;
}

/**
 * The palette: every colour decision and every layout primitive smelt has, behind one
 * interface that is the identity when colour is off.
 */
export interface Palette {
  /** Whether ANSI is being written at all. */
  readonly on: boolean;
  /** Whether the glyph set may use anything above ASCII. */
  readonly unicode: boolean;
  /** Paint one span. The text is never split or re-cased — only wrapped in codes. */
  paint(role: Role, text: string): string;
  /** A section heading. */
  heading(text: string): string;
  /** The status mark for a line, already painted: `✓`, `✗`, `⚠` — or `+`, `x`, `!`. */
  glyph(glyph: Glyph): string;
  /** A proportional bar, `width` cells wide. Never empty for a non-zero fraction. */
  bar(fraction: number, width: number): string;
  /** A fraction as a percentage, never rounding a non-zero to zero. */
  percent(fraction: number): string;
  /** An aligned `name   value` block. */
  kv(rows: readonly KvRow[], indent?: number): string;
  /** An aligned table with a header row. */
  table(spec: TableSpec): string;
  /** The wordmark, over the lava gradient when colour is on. */
  logo(): string;
  /** A horizontal lava rule, `width` cells wide. */
  divider(width: number): string;
}

/** How each role is painted when colour is on. Off, every one of them is the identity. */
const ROLE_CODES: Readonly<Record<Role, string>> = {
  plain: '',
  brand: lavaStop(0.75),
  heading: CODE.bold,
  rule: CODE.cyan,
  hash: CODE.dim,
  number: lavaStop(1),
  path: CODE.magenta,
  good: CODE.green,
  bad: CODE.red,
  warn: CODE.amber,
  dim: CODE.dim,
  strong: CODE.bold,
};

/** The two glyph sets, as one table so a third mark cannot be added to only one. */
const GLYPHS: Readonly<Record<Glyph, { readonly unicode: string; readonly ascii: string }>> = {
  ok: { unicode: '✓', ascii: '+' },
  bad: { unicode: '✗', ascii: 'x' },
  warn: { unicode: '⚠', ascii: '!' },
  info: { unicode: '·', ascii: '-' },
  bullet: { unicode: '•', ascii: '*' },
};

/** Which role paints which glyph. */
const GLYPH_ROLE: Readonly<Record<Glyph, Role>> = {
  ok: 'good',
  bad: 'bad',
  warn: 'warn',
  info: 'dim',
  bullet: 'dim',
};

/** The bar's two cells, and their ASCII fallbacks. */
const BAR = {
  filled: { unicode: '█', ascii: '#' },
  empty: { unicode: '░', ascii: '.' },
} as const;

/**
 * The widest bar smelt draws. Beyond this a bar stops being a comparison and becomes
 * wallpaper — and it has to fit an 80-column terminal beside its own number.
 */
export const BAR_WIDTH = 40;

/** How the palette is built. */
export interface PaletteOptions {
  /** ANSI may be written. Defaults to false — the plain rendering. */
  readonly color?: boolean;
  /** The glyph set may go above ASCII. Defaults to true — what smelt has always printed. */
  readonly unicode?: boolean;
}

/**
 * Build a palette. `color: false` (the default) returns one whose every method is the
 * plain rendering — the property every other guard in this repository leans on.
 */
export function palette(options: PaletteOptions = {}): Palette {
  const on = options.color === true;
  const unicode = options.unicode !== false;
  const glyphOf = (glyph: Glyph): string => GLYPHS[glyph][unicode ? 'unicode' : 'ascii'];

  const paint = (role: Role, text: string): string => {
    if (!on || text === '') return text;
    const code = ROLE_CODES[role];
    return code === '' ? text : `${code}${text}${CODE.reset}`;
  };

  return {
    on,
    unicode,
    paint,
    heading: (text) => paint('heading', text),
    glyph: (glyph) => paint(GLYPH_ROLE[glyph], glyphOf(glyph)),
    bar: (fraction, width) => renderBar(fraction, width, unicode, paint),
    percent,
    kv: (rows, indent = 2) => renderKv(rows, indent, paint),
    table: (spec) => renderTable(spec, paint),
    logo: () => renderLogo(on, unicode),
    divider: (width) => renderDivider(width, on, unicode),
  };
}

/** The plain palette, for every caller that has no colour decision to make. */
export const PLAIN: Palette = palette();

/**
 * The palette a verb writes to **stdout** with, and the one it writes to **stderr**
 * with — two functions rather than one, because the two streams are answered
 * separately (see `CliIo.colorErr`).
 *
 * Both take the whole io rather than a boolean so that a verb never has to remember
 * which of the two switches applies to the stream it is writing to: `stdoutPalette(io)`
 * is the right answer for the smelted text's report block, `stderrPalette(io)` for the
 * report beside it. A verb printing a `--json` envelope uses neither — it uses
 * {@link PLAIN}, because an envelope is bytes for a machine.
 */
export function stdoutPalette(io: PaletteSource): Palette {
  return palette({ color: io.color === true, unicode: io.unicode !== false });
}

/** See {@link stdoutPalette}. Falls back to the stdout switch when stderr has none. */
export function stderrPalette(io: PaletteSource): Palette {
  return palette({ color: io.colorErr ?? io.color === true, unicode: io.unicode !== false });
}

/**
 * The three fields the two palette builders read off `CliIo`. Stated structurally so
 * this module keeps importing nothing at all — `shell.ts` is the CLI's edge and
 * everything under `cli/` may read it, but a palette that imported it would make the
 * brand depend on the plumbing rather than the other way round.
 */
export interface PaletteSource {
  readonly color?: boolean;
  readonly colorErr?: boolean;
  readonly unicode?: boolean;
}

/**
 * A fraction as a percentage — and Law 4 at the last inch before a person reads it.
 *
 * A rate of 0.0004 is not zero. Printed as `0.0%` it becomes a claim smelt did not
 * measure, in the one direction that matters: "nothing was asked for back" is exactly
 * the comfortable answer. So a non-zero below the last printed digit prints `<0.1%`,
 * and the same in the other direction for a negative delta.
 */
export function percent(fraction: number): string {
  if (!Number.isFinite(fraction)) return '—';
  const value = fraction * 100;
  if (value === 0) return '0.0%';
  if (value > 0 && value < 0.05) return '<0.1%';
  if (value < 0 && value > -0.05) return '>-0.1%';
  return `${value.toFixed(1)}%`;
}

/**
 * The bar, with the same law applied to a picture: a non-zero fraction always gets at
 * least one filled cell, and a fraction below 1 never fills the bar. A bar that reads
 * "none" for a rate that is not none, or "all" for a rate that is not all, is a
 * rounding that hides the number the bar exists to show.
 */
function renderBar(
  fraction: number,
  width: number,
  unicode: boolean,
  paint: (role: Role, text: string) => string,
): string {
  const cells = Math.max(0, Math.min(BAR_WIDTH, Math.trunc(width)));
  const clamped = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  let filled = Math.round(clamped * cells);
  if (clamped > 0 && filled === 0) filled = 1;
  if (clamped < 1 && cells > 0 && filled === cells) filled = cells - 1;
  const cell = unicode
    ? { filled: BAR.filled.unicode, empty: BAR.empty.unicode }
    : { filled: BAR.filled.ascii, empty: BAR.empty.ascii };
  return (
    paint('number', cell.filled.repeat(filled)) + paint('dim', cell.empty.repeat(cells - filled))
  );
}

/** `name   value`, aligned on the value. Padding is measured before anything is painted. */
function renderKv(
  rows: readonly KvRow[],
  indent: number,
  paint: (role: Role, text: string) => string,
): string {
  if (rows.length === 0) return '';
  const nameWidth = rows.reduce((wide, row) => Math.max(wide, row.name.length), 0);
  const valueWidth = rows.reduce((wide, row) => Math.max(wide, row.value.length), 0);
  const pad = ' '.repeat(Math.max(0, indent));
  return rows
    .map(
      (row) =>
        `${pad}${row.name.padEnd(nameWidth)}  ` +
        `${paint(row.role ?? 'plain', row.value.padStart(valueWidth))}`,
    )
    .join('\n');
}

/** An aligned table. Same rule: pad the plain text, then paint the padded cell. */
function renderTable(spec: TableSpec, paint: (role: Role, text: string) => string): string {
  const { columns, rows } = spec;
  const pad = ' '.repeat(Math.max(0, spec.indent ?? 2));
  const widths = columns.map((column, index) =>
    rows.reduce((wide, row) => Math.max(wide, (row[index] ?? '').length), column.header.length),
  );
  const lay = (text: string, index: number): string =>
    columns[index]?.align === 'right'
      ? text.padStart(widths[index] ?? 0)
      : text.padEnd(widths[index] ?? 0);

  const header = `${pad}${columns.map((column, index) => lay(column.header, index)).join('  ')}`;
  const body = rows.map((row) =>
    `${pad}${columns
      .map((column, index) => paint(column.role ?? 'plain', lay(row[index] ?? '', index)))
      .join('  ')}`.trimEnd(),
  );
  return [paint('dim', header.trimEnd()), ...body].join('\n');
}

/**
 * The wordmark. Painted column by column, so the gradient runs across the letters the
 * way lava runs downhill — and left exactly as drawn when colour is off, which is what
 * the help snapshot pins.
 */
function renderLogo(on: boolean, unicode: boolean): string {
  const lines = unicode ? LOGO_UNICODE : LOGO_ASCII;
  if (!on) return lines.join('\n');
  const span = Math.max(1, widest(lines) - 1);
  return lines
    .map(
      (line) =>
        `${[...line]
          .map((glyph, column) => (glyph === ' ' ? glyph : `${lavaStop(column / span)}${glyph}`))
          .join('')}${CODE.reset}`,
    )
    .join('\n');
}

/** A horizontal rule under the gradient — the banner's bar, on its own. */
function renderDivider(width: number, on: boolean, unicode: boolean): string {
  const cell = unicode ? '━' : '-';
  const cells = Math.max(0, Math.trunc(width));
  if (!on) return cell.repeat(cells);
  const span = Math.max(1, cells - 1);
  const painted = Array.from({ length: cells }, (_, i) => `${lavaStop(i / span)}${cell}`).join('');
  return `${painted}${CODE.reset}`;
}

/**
 * How wide a wizard's closing rule is drawn. Wide enough to be a line rather than a
 * dash, narrow enough for an 80-column terminal with room to spare.
 */
const DONE_WIDTH = 60;

/** The closing block a wizard ends on: what happened, and what to run next. */
export interface DoneBlock {
  /** Whether what just ran succeeded — the mark the block opens with. */
  readonly ok: boolean;
  /** What finished, in the words a person typed: `smelt setup`. */
  readonly what: string;
  /**
   * What it did, **counted** — `wrote 3, skipped 1 — 4 files in all`, unterminated
   * (the block ends the sentence). The caller counts it off what it actually applied,
   * never off what it planned: a closing block that says "wrote 4 files" for a run
   * that skipped one is the most quietly wrong line a wizard can print, because it is
   * the line people believe and stop reading at.
   */
  readonly summary: string;
  /** The sentence this verb owes the reader about what it just wrote. Optional. */
  readonly note?: string;
  /** What to run next: the command, and the one line that says why. */
  readonly next: readonly (readonly [command: string, why: string])[];
}

/**
 * The block every wizard ends on — `init`, `hooks install`, `hooks remove`, `setup`.
 *
 * Three wizards used to stop at `Done.` and a sentence, each phrased its own way, and
 * a person who had just installed smelt was left with no answer to the only question
 * they had: *what do I type now?* This is that answer, in the shape every one of them
 * shares — a rule, a verdict, what was measured, and the two or three commands that
 * follow from it.
 *
 * Rendered through the palette like everything else, and `PLAIN` (the default) is the
 * plain text a pipe, a `--yes` receipt and every guard reads. The wizards pass no
 * palette: their bytes go through the {@link colorize} sink at the verb boundary,
 * which paints the rule's gradient there — one switch, one place, as ADR-0001 has it.
 */
export function doneBlock(block: DoneBlock, lava: Palette = PLAIN): string {
  const width = block.next.reduce((wide, [command]) => Math.max(wide, command.length), 0);
  return [
    '',
    lava.divider(DONE_WIDTH),
    `  ${lava.glyph(block.ok ? 'ok' : 'bad')} Done. ${block.what} ${block.summary}.`,
    ...(block.note === undefined ? [] : [`    ${lava.paint('dim', block.note)}`]),
    ...(block.next.length === 0
      ? []
      : [
          '',
          `  ${lava.heading('Next')}`,
          ...block.next.map(
            ([command, why]) =>
              `    ${lava.paint('brand', command.padEnd(width))}  ${lava.paint('dim', why)}`,
          ),
        ]),
    '',
  ].join('\n');
}

/**
 * What one action did to one file — the four outcomes every apply loop in this CLI
 * has, stated once so three wizards cannot spell the same tally three ways.
 */
export type FileAction = 'written' | 'updated' | 'unchanged' | 'skipped';

/**
 * How each outcome reads on its own, and beside the others. Two phrasings because
 * English needs them: `left 2 files unchanged` alone, `left 2 unchanged` in a list
 * whose total is stated at the end.
 */
const TALLY: Readonly<
  Record<FileAction, { alone: (n: string, files: string) => string; beside: (n: string) => string }>
> = {
  written: { alone: (n, files) => `wrote ${n} ${files}`, beside: (n) => `wrote ${n}` },
  updated: { alone: (n, files) => `updated ${n} ${files}`, beside: (n) => `updated ${n}` },
  unchanged: {
    alone: (n, files) => `left ${n} ${files} unchanged`,
    beside: (n) => `left ${n} unchanged`,
  },
  skipped: { alone: (n, files) => `skipped ${n} ${files}`, beside: (n) => `skipped ${n}` },
};

/**
 * `wrote 3, skipped 1 — 4 files in all` — what a run did, counted off what it did.
 *
 * Takes the applied outcomes rather than the plan, and names only the buckets that are
 * not empty, so the sentence is short when the run was simple and complete when it was
 * not. The three wizards share it for the same reason they share the block: three
 * hand-counted summaries are three chances to say "wrote 4 files" about three.
 */
export function countedFiles(actions: readonly FileAction[]): string {
  const files = actions.length === 1 ? 'file' : 'files';
  const buckets = (Object.keys(TALLY) as FileAction[])
    .map((action) => ({ action, n: actions.filter((one) => one === action).length }))
    .filter((bucket) => bucket.n > 0);
  if (buckets.length === 0) return 'wrote nothing';
  const only = buckets[0];
  if (buckets.length === 1 && only !== undefined) {
    return TALLY[only.action].alone(String(only.n), only.n === 1 ? 'file' : 'files');
  }
  return (
    `${buckets.map((bucket) => TALLY[bucket.action].beside(String(bucket.n))).join(', ')}` +
    ` — ${String(actions.length)} ${files} in all`
  );
}

/**
 * Style one block of wizard output. `on === false` returns the text untouched —
 * the property every guard's byte-identity leans on.
 *
 * The rules are line-shaped, never word-shaped: ANSI codes wrap whole lines, so the
 * text a guard asserts (`wrote CLAUDE.md`, `Nothing was written.`) stays contiguous
 * inside the styled line. `--yes`, `--json`, piped stdin and `NO_COLOR` all mean
 * plain bytes — a machine parsing wizard output must never parse around escape
 * sequences.
 *
 * This is the **sink** the wizards' prose passes through, not something a wizard calls
 * per line: `init`, `hooks`, `agents split` and `setup` write the words, and the verb
 * that owns each of them wraps its output stream in this. That is why no wizard file
 * holds a colour decision, and why the palette is one import away from all of them.
 */
export function colorize(text: string, on: boolean): string {
  if (!on) return text;
  const lava = palette({ color: true });
  return text
    .split('\n')
    .map((line) => {
      if (line === '') return line;
      if (line.includes('✓') || line.trim().startsWith('Done.')) return lava.paint('good', line);
      if (
        line.includes('✗') ||
        line.includes('ORPHAN') ||
        line.includes('MALFORMED') ||
        line.includes('MISSING')
      ) {
        return lava.paint('bad', line);
      }
      // The closing block's rule, drawn plain by `doneBlock` and painted here: the
      // wizards write words and the sink paints them, so this is where the gradient
      // belongs. `lavaBanner` already paints its own, and a painted line is no longer
      // all-`━`, so neither one can be painted twice.
      if (/^━{4,}$/u.test(line)) return lava.divider(line.length);
      if (line.trim().startsWith('note:')) return lava.paint('warn', line);
      if (line.endsWith('> ') || /»/u.test(line)) return lava.paint('strong', line);
      // The file listing every wizard prints: what happened to a file is the fact a
      // reader scans for, so it is the fact that carries the colour.
      if (/^\s{2,}(wrote|merged|updated) /u.test(line)) return lava.paint('good', line);
      if (/^\s{2,}(skipped|unchanged) /u.test(line)) return lava.paint('dim', line);
      return line;
    })
    .join('\n');
}

/**
 * The banner an interactive wizard opens with: the title over a lava gradient bar.
 * Returns plain text when `on` is false.
 */
export function lavaBanner(title: string, on: boolean): string {
  const lava = palette({ color: on });
  const bar = lava.divider(24);
  return `${bar}\n  ${lava.paint('strong', title)}\n${bar}`;
}
