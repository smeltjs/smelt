/**
 * Focus terms, derived from the command that produced a blob — one derivation, zero
 * imports, shared by the hooks guard and the ops seam.
 *
 * The guard is the producer expert: to decide anything about a `grep` it has already
 * parsed the pattern out of the command. Before this file that knowledge died inside
 * the guard — the deny reason printed `--focus <?>` and the model reinvented what the
 * guard knew. Now the derivation lives here, beside the guard and importing nothing
 * (the guard's latency budget is a stat and an exit, so this must stay a
 * zero-dependency sibling rather than an exception to its no-library-import rule),
 * and `smeltBlob` applies the same function to a caller's `producer` hint — so the
 * guard's rewrite wrap, `smelt --producer` and the `smelt_file` tool cannot disagree
 * about which terms a command names.
 *
 * The question it answers is narrower than "what did the command search for". It is:
 * **which terms, if any, distinguish the output lines the task is about from the ones
 * it is not.** Focus is what the lexical planner keeps; a term every output line
 * carries keeps everything and cuts nothing, exactly when the output is large. So:
 *
 *  - a plain `grep`/`rg` prints only matching lines — every line has the pattern, the
 *    pattern distinguishes nothing, and the answer is no terms (the planner's
 *    head-and-tail rule is the right cut);
 *  - a search with context (`-C`, `-A`, `-B`, `--context`…) prints non-matching lines
 *    around each hit, and there the pattern is exactly the focus;
 *  - a listing search (`-l`, `-c`, `--files-with-matches`…) prints no matching lines
 *    at all, so its pattern names nothing in the output;
 *  - a producer that states no term (`cat`, `git diff`, `sed`) yields none, and so
 *    does a command this parser cannot see whole — unsure means no terms, the same
 *    fail-open rule the guard lives under.
 *
 * Every rule above is a fact about what the command prints, stated as data in
 * {@link SEARCH_PROGRAMS}, {@link CONTEXT_FLAGS} and {@link LISTING_FLAGS} — never a
 * guess about the text.
 */

/** The search programs whose first non-flag word (or every `-e`) is a pattern. */
const SEARCH_PROGRAMS: ReadonlySet<string> = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack']);

/** Flags under which a search prints lines that do *not* match — where focus pays. */
const CONTEXT_FLAGS: ReadonlySet<string> = new Set([
  '-A',
  '-B',
  '-C',
  '--after-context',
  '--before-context',
  '--context',
]);

/** Flags under which a search prints no matching lines at all. */
const LISTING_FLAGS: ReadonlySet<string> = new Set([
  '-l',
  '-L',
  '-c',
  '--files-with-matches',
  '--files-without-match',
  '--count',
  '--count-matches',
  '--files',
]);

/**
 * The terms a producer command names that distinguish output lines the task is about.
 * `[]` whenever the honest answer is "none" — see the module doc. Never throws.
 */
export function focusTermsFor(command: string | undefined): readonly string[] {
  if (command === undefined) return [];
  const words = simpleCommandWords(command.trim());
  if (words === undefined || words.length === 0) return [];
  const search = searchWords(words);
  if (search === undefined) return [];
  if (!printsContext(search)) return [];
  if (isListing(search)) return [];
  return searchPatterns(search);
}

/**
 * The words of the search invocation, with `git grep` normalised to `grep`, or
 * `undefined` when the program is not a search at all.
 */
function searchWords(words: readonly string[]): readonly string[] | undefined {
  const program = words[0]!.split('/').at(-1)!;
  if (program === 'git' && words[1] === 'grep') return ['grep', ...words.slice(2)];
  return SEARCH_PROGRAMS.has(program) ? words : undefined;
}

/** True when a context flag is present — spaced (`-C 3`), compact (`-C3`) or `=`-joined. */
function printsContext(words: readonly string[]): boolean {
  return words.slice(1).some((word) => {
    if (CONTEXT_FLAGS.has(word)) return true;
    const long = word.startsWith('--') ? word.split('=')[0]! : undefined;
    if (long !== undefined) return CONTEXT_FLAGS.has(long);
    return /^-[ABC]\d+$/.test(word);
  });
}

function isListing(words: readonly string[]): boolean {
  return words.slice(1).some((word) => LISTING_FLAGS.has(word.split('=')[0]!));
}

/**
 * Split a command into words IF it is one simple command: no pipes, no logic, no
 * redirects, no substitutions, no expansions this code would have to model. Anything
 * else returns `undefined` and the caller treats the command as unknowable — the guard
 * allows, this derivation names no terms.
 */
export function simpleCommandWords(command: string): readonly string[] | undefined {
  const words: string[] = [];
  let current = '';
  let started = false;
  let i = 0;
  const push = (): void => {
    if (started) words.push(current);
    current = '';
    started = false;
  };
  while (i < command.length) {
    const ch = command[i]!;
    if ('|&;<>()`$\\\n*?~{}!'.includes(ch)) return undefined; // shell would interpret it
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      started = true;
      while (i < command.length && command[i] !== quote) {
        if (quote === '"' && (command[i] === '$' || command[i] === '`' || command[i] === '\\')) {
          return undefined; // expansions inside double quotes — not simple
        }
        current += command[i]!;
        i += 1;
      }
      if (i >= command.length) return undefined; // unterminated quote
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      push();
      i += 1;
      continue;
    }
    current += ch;
    started = true;
    i += 1;
  }
  push();
  return words;
}

/** Flags that consume the next word, so it is never mistaken for the pattern. */
const TAKES_VALUE: ReadonlySet<string> = new Set([
  '-e',
  '--regexp',
  '-f',
  '--file',
  '-m',
  '--max-count',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-d',
  '--directories',
  '-D',
  '--devices',
  '--include',
  '--exclude',
  '--exclude-dir',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-g',
  '--glob',
  '--iglob',
  '-j',
  '--threads',
  '--color',
  '--colour',
]);

/**
 * Every pattern a grep/rg invocation searches for: each explicit `-e`/`--regexp`
 * value if any are given, else the first word that is not a flag or a flag's value.
 * Empty when the parse is not sure.
 */
export function searchPatterns(words: readonly string[]): readonly string[] {
  const explicit: string[] = [];
  let positional: string | undefined;
  let i = 1;
  while (i < words.length) {
    const word = words[i]!;
    if (word === '--') {
      positional ??= words[i + 1];
      break;
    }
    if (word === '-e' || word === '--regexp') {
      const value = words[i + 1];
      if (value !== undefined) explicit.push(value);
      i += 2;
      continue;
    }
    if (word.startsWith('--') && word.includes('=')) {
      i += 1;
      continue;
    }
    if (word.startsWith('-') && word.length > 1) {
      i += TAKES_VALUE.has(word) ? 2 : 1;
      continue;
    }
    if (positional === undefined && explicit.length === 0) positional = word;
    i += 1;
  }
  if (explicit.length > 0) return explicit;
  return positional === undefined ? [] : [positional];
}

/** The first pattern of {@link searchPatterns}; `undefined` when there is none. */
export function searchPattern(words: readonly string[]): string | undefined {
  return searchPatterns(words)[0];
}

/** Single-quote a value for `sh` unless it is plainly safe bare. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
