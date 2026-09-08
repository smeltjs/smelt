import { SUPPORTED_LANGUAGES } from '../../detect.ts';
import { CliUsageError } from '../../errors.ts';
import { HARNESS_IDS } from '../../harness/registry.ts';
import { INSTALL_SCOPES } from '../../harness/scope.ts';
import type { InstallScope } from '../../harness/scope.ts';
import { budgetFault, budgetMalformed } from '../../ops/inputs.ts';
import type { BudgetFault } from '../../ops/inputs.ts';
import { STRATEGIES, DEFAULT_STRATEGY } from '../../plan/planners.ts';
import { STRUCTURAL_LANGUAGES } from '../../plan/structural.ts';
import { DEFAULT_REPO_IGNORE } from '../../repomap/map.ts';
import { SETUP_RECIPE } from '../../setup/recipe.ts';
import { CONFIG_FILE_NAME } from '../config.ts';
import { CLI_NAME } from '../shell.ts';

/**
 * Every flag the CLI accepts, once.
 *
 * The table is the companion the {@link Subcommand} registry needs: a verb declares
 * the flags it owns as `FlagName[]`, so the type of that list — and therefore whether
 * a verb can claim a flag that does not exist — comes from here. It carries three
 * things that used to be written in three places:
 *
 *   1. **How `node:util.parseArgs` reads the flag.** The option table used to be a
 *      literal inside `parseSmeltArgs`.
 *   2. **The name.** `FlagName` is `keyof typeof CLI_FLAGS`, so an eleventh flag is
 *      spelled once and every verb's ownership list typechecks against it.
 *   3. **Its OPTIONS entry in `--help`.** Including the `map only.` / `hooks only.`
 *      prefix, which is *not* stored here: it is generated from the registry's
 *      ownership (see `renderOptions` in `cli/usage.ts`), because "which verb owns
 *      this flag" is a fact the registry already holds and prose that restates it is
 *      prose that can go stale.
 *
 * Key order is meaningful: it is the order the OPTIONS block renders and the order a
 * refusal lists flags in, so keep it stable and append new flags where they read best.
 */
export const CLI_FLAGS = {
  budget: { type: 'string' },
  focus: { type: 'string', multiple: true },
  producer: { type: 'string' },
  language: { type: 'string' },
  strategy: { type: 'string' },
  ignore: { type: 'string', multiple: true },
  cache: { type: 'string' },
  /**
   * Repeatable because `setup` wires several harnesses in one run. `hooks` takes one
   * per run and refuses a second id in its own parse — arity is a per-verb fact,
   * expressed where the verb validates, with the one generated refusal; the table
   * records how argv is read, not how many a verb accepts.
   */
  harness: { type: 'string', multiple: true },
  /**
   * `project` or `user` — which install the three install-seam verbs act on. One flag,
   * three verbs, because a setup at one scope and a doctor at the other would agree an
   * install is healthy while nothing is wired.
   */
  scope: { type: 'string' },
  'older-than': { type: 'string' },
  'keep-retrieved': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  yes: { type: 'boolean' },
  'no-mcp': { type: 'boolean' },
  /**
   * The four preset toggles, as `on|off` strings rather than as `--guard` /
   * `--no-guard` boolean pairs: the wizard asks each of them `(on/off)`, and a flag
   * that spells the same question differently is a second vocabulary for one setting.
   * A string also lets *absent* mean "leave it as the install found it", which a
   * boolean flag cannot say.
   */
  guard: { type: 'string' },
  stats: { type: 'string' },
  map: { type: 'string' },
  lint: { type: 'string' },
  strict: { type: 'boolean' },
  json: { type: 'boolean' },
  reconstruct: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
} as const;

/** Every flag name, as a type. A verb cannot claim a flag that is not in the table. */
export type FlagName = keyof typeof CLI_FLAGS;

/**
 * The flags answered *before* any verb, so no verb owns them and no verb may refuse
 * them: `smelt map --help` prints the help, exactly as it always has. Every other flag
 * belongs to at least one verb — `test/guards/subcommand-registry.test.ts` pins that.
 */
export const GLOBAL_FLAGS = ['help', 'version'] as const satisfies readonly FlagName[];

/** A flag a verb can own — everything but the two global ones. */
export type VerbFlag = Exclude<FlagName, (typeof GLOBAL_FLAGS)[number]>;

/** Every ownable flag, in table order: the list a refusal checks a verb against. */
export const VERB_FLAGS: readonly VerbFlag[] = Object.keys(CLI_FLAGS).filter(
  (name): name is VerbFlag => !(GLOBAL_FLAGS as readonly string[]).includes(name),
);

/**
 * `--a`, `--a and --b`, `--a, --b and --c` — in flag-table order, always.
 *
 * Every refusal that names more than one flag spells the list this way: the
 * ownership refusal in `./registry.ts`, and the default verb's `--reconstruct`
 * refusal in `./smelt.ts`. It lives with the table because the *order* is the
 * table's — a refusal that listed flags in the order the user happened to type them
 * would read differently every time, and two refusals disagreeing about how to spell
 * the same pair is the kind of drift this file exists to remove.
 */
export function flagList(flags: readonly VerbFlag[]): string {
  const spelled = VERB_FLAGS.filter((flag) => flags.includes(flag)).map((flag) => `--${flag}`);
  if (spelled.length <= 1) return spelled.join('');
  return `${spelled.slice(0, -1).join(', ')} and ${spelled.at(-1) ?? ''}`;
}

/** What one flag's parsed value looks like, derived from how `parseArgs` was told to read it. */
type FlagValue<F> = F extends { readonly type: 'boolean' }
  ? boolean
  : F extends { readonly multiple: true }
    ? readonly string[]
    : string;

/**
 * The parsed flags, as every `Subcommand.parse` sees them: one optional field per
 * flag, typed by the table above. Absent means the user did not type it — which is
 * the only thing a refusal needs to know, and the only thing a verb may act on.
 */
export type FlagValues = { readonly [K in FlagName]?: FlagValue<(typeof CLI_FLAGS)[K]> };

/** How one flag appears in the OPTIONS block of `--help`. */
export interface FlagHelp {
  /** The left column, e.g. `--budget <bytes>` or `-h, --help`. */
  readonly label: string;
  /**
   * The description, already wrapped to the OPTIONS column — a function because three
   * entries render a registry (`SUPPORTED_LANGUAGES`, `STRATEGIES` +
   * `STRUCTURAL_LANGUAGES`, `HARNESS_IDS`) rather than a hand-typed list. The
   * ownership prefix is not here; it is generated.
   */
  body(): readonly string[];
}

/**
 * A comma-separated list under an OPTIONS entry's hanging indent, wrapped where the
 * hand-typed version wrapped. `--strategy` and `--language` render their registries on
 * one line because they fit; the harness ids do not, and a list long enough to wrap is
 * exactly the list nobody keeps in sync by hand.
 */
export function optionList(items: readonly string[], width: number): readonly string[] {
  const lines: string[] = [];
  let line = '';
  items.forEach((item, index) => {
    const word = index === items.length - 1 ? `${item}.` : `${item},`;
    const candidate = line === '' ? word : `${line} ${word}`;
    if (line !== '' && candidate.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  lines.push(line);
  return lines;
}

/** The width an OPTIONS description wraps within, once its 23-column indent is removed. */
const OPTION_BODY_WIDTH = 65;

/**
 * The OPTIONS entry for every flag. `Record<FlagName, FlagHelp>` on purpose: a flag
 * added to {@link CLI_FLAGS} without a help entry is a compile error, so the help text
 * cannot fall behind what the parser accepts.
 */
export const FLAG_HELP: Readonly<Record<FlagName, FlagHelp>> = {
  budget: {
    label: '--budget <bytes>',
    body: () => [
      'Required, unless smelt.config.json sets defaultBudgetBytes.',
      'Soft ceiling for the output, in UTF-8 bytes (for map: a hard',
      'ceiling, met by construction). No built-in default: a budget',
      `${CLI_NAME} invented would decide for you.`,
    ],
  },
  focus: {
    label: '--focus <term>',
    body: () => [
      'What you were looking for. Repeatable. Matching regions and',
      'their context survive; the runs between them collapse. For',
      'map: symbols matching a term (by name or path) are promoted',
      'to the front of the fill order, ranks unchanged.',
    ],
  },
  producer: {
    label: '--producer <cmd>',
    body: () => [
      'The command whose output this is, e.g. "grep -C 3 foo src". When',
      'no --focus is given, the focus is derived from it exactly as the',
      'hooks guard derives it: a search pattern, only when the output',
      'also holds non-matching lines (context flags). cat, diffs and',
      'logs name no term; the head and tail are kept instead.',
    ],
  },
  language: {
    label: '--language <id>',
    body: () => [`Override detection. One of: ${[...SUPPORTED_LANGUAGES, 'unknown'].join(', ')}.`],
  },
  strategy: {
    label: '--strategy <id>',
    body: () => [
      `${STRATEGIES.join(', ')}. Defaults to ${DEFAULT_STRATEGY}, unless`,
      'smelt.config.json says otherwise. structural parses',
      `${STRUCTURAL_LANGUAGES.join(', ')};`,
      'any other language is refused, never approximated. json cuts',
      'members and elements; diff cuts files and hunks; each refuses',
      'any other content. auto picks by content kind first (json,',
      'diff), then structural for those languages and lexical for the',
      'rest, and the report names whichever one actually ran.',
    ],
  },
  ignore: {
    label: '--ignore <entry>',
    body: () => [
      'Repeatable. Replaces the default ignore list',
      // Read off DEFAULT_REPO_IGNORE, never re-typed: help text that lists a default
      // by hand is help text that will one day describe a different default.
      `(${DEFAULT_REPO_IGNORE.join(', ')}): a bare name matches any path segment,`,
      'an entry containing / is a root-relative prefix.',
    ],
  },
  cache: {
    label: '--cache <dir>',
    body: () => [
      'Directory for the tags cache, keyed by content',
      'hash. Only when given does the map write to disk at all.',
    ],
  },
  harness: {
    label: '--harness <id>',
    body: () => [
      'Skip harness detection and target one id:',
      ...optionList(HARNESS_IDS, OPTION_BODY_WIDTH),
      'Repeatable for setup; hooks takes one per run.',
    ],
  },
  scope: {
    label: '--scope <where>',
    body: () => [
      `${INSTALL_SCOPES.join(' | ')}. Where the install lives: this project, or this`,
      'machine. Defaults to user when the working directory is your home',
      'directory, project everywhere else. At user scope the config is',
      `~/${CONFIG_FILE_NAME} — which every project below finds, since`,
      `discovery walks up — the store is ~/${SETUP_RECIPE.store.defaultDir},`,
      "and each harness file goes to that harness's own documented",
      'user-level location; one that documents none is reported skipped,',
      'never guessed.',
    ],
  },
  'older-than': {
    label: '--older-than <age>',
    body: () => [
      'Required by prune: the age cut, as <n>d, <n>h or <n>w',
      '(whole numbers, at least 1). Blobs last written before it',
      'are evicted. There is no default — a cut-off',
      `${CLI_NAME} invented would decide which of your elisions stop`,
      'being reversible.',
    ],
  },
  'keep-retrieved': {
    label: '--keep-retrieved',
    body: () => [
      'Spare any hash the journal shows was retrieved at',
      'least once, however old it is: material the model has',
      'asked for once it may ask for again.',
    ],
  },
  'dry-run': {
    label: '--dry-run',
    body: () => [
      'List what would be evicted and free nothing. The',
      'report is otherwise identical, so the two runs compare',
      'field for field.',
    ],
  },
  yes: {
    label: '--yes',
    body: () => [
      "Answer everything up front: the recipe's defaults for setup,",
      "the install's current toggles for hooks, printed loudly as",
      'they are applied. An existing file is merged, never',
      'overwritten; one smelt would write whole is skipped unless it',
      "is already smelt's.",
    ],
  },
  'no-mcp': {
    label: '--no-mcp',
    body: () => [
      'Setup only: skip the MCP registration step — the',
      'printed command and its note — for a hooks-only',
      'setup.',
    ],
  },
  guard: {
    label: '--guard on|off',
    body: () => ['The PreToolUse size-guard. Answers the wizard question of', 'the same name.'],
  },
  stats: {
    label: '--stats on|off',
    body: () => ['`smelt stats` when a session ends — observation only,', 'never blocking.'],
  },
  map: {
    label: '--map on|off',
    body: () => ['An opening `smelt map` at session start, so the agent', 'starts oriented.'],
  },
  lint: {
    label: '--lint on|off',
    body: () => [
      '`smelt agents lint .` at session start, reporting on the',
      'instruction files this session loads.',
    ],
  },
  strict: {
    label: '--strict',
    body: () => [
      'Turn any lint finding into exit 1, for CI. Findings are',
      'advisory by default: the rules are heuristics about somebody',
      "else's house style, and enforcing them uninvited would be",
      `${CLI_NAME} deciding it. A budget you set yourself is different —`,
      'exceeding agents.budgetBytes exits 1 with or without --strict.',
    ],
  },
  json: {
    label: '--json',
    body: () => [
      'Print a JSON envelope on stdout instead of the text:',
      '{ format, result, elided } for a smelt run — `result` is',
      'the SmeltResult verbatim, `elided` carries the bytes, so',
      'the envelope can be reconstructed; feed it back with',
      '--reconstruct. For map: { format, map }, the RepoMap',
      'structure verbatim. For agents lint: { format, report },',
      'the measured levels and every finding with its rule id.',
    ],
  },
  reconstruct: {
    label: '--reconstruct',
    body: () => [
      'Read a --json envelope and print the original text, byte for',
      'byte. This is Law 3 you can run from a shell.',
    ],
  },
  help: { label: '-h, --help', body: () => ['This text.'] },
  version: { label: '--version', body: () => ['The package version.'] },
};

/**
 * `--budget` has no built-in default, for the same reason `smelt()` has none: a budget
 * smelt invented would be smelt deciding how much of the caller's context to throw
 * away, silently, at a number nobody chose. A *missing* flag is not an error here,
 * though — `smelt.config.json` may carry a `defaultBudgetBytes` the user chose
 * explicitly, and the verb's `resolve` errors only when neither exists. A malformed
 * value is always an error.
 *
 * It lives with the flag rather than with a verb because two verbs own `--budget`, and
 * the two of them agreeing on what "4kb" means is not something to leave to chance.
 *
 * The *lexing* is the CLI's own and stays here — argv carries strings, so `4kb` and a
 * leading `-` are answered by a digits-only test before anything numeric happens. The
 * *rule* and *the sentence that refuses it* come from `ops/inputs.ts`, which is also
 * where the `smelt_file` tool gets them: two surfaces, one law, spelled `--budget`
 * here and `"budgetBytes"` there.
 */
export function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw refuseBudget('not-an-integer', raw);
  const value = Number(raw);
  const fault = budgetFault(value);
  if (fault !== undefined) throw refuseBudget(fault, raw);
  return value;
}

/** The malformed-budget refusal, in the CLI's currency: prefixed, and exit 2. */
function refuseBudget(fault: BudgetFault, raw: string): CliUsageError {
  return new CliUsageError(`${CLI_NAME}: ${budgetMalformed(fault, '--budget', raw)}`);
}

/**
 * `--guard on|off` and its three siblings, or `undefined` when nobody typed one —
 * which is not the same as `off`: absent means *leave it as the install found it*,
 * and both verbs read the installed state for that answer (`presetToggles`).
 *
 * It lives with the flags rather than with a verb because two verbs own these four,
 * and both of them meaning the same thing by `on` is the whole point: `smelt setup
 * --yes --map on` and `smelt hooks install --yes --map on` must wire the same hook.
 */
export function parseToggle(flag: string, raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'on') return true;
  if (raw === 'off') return false;
  throw new CliUsageError(`${CLI_NAME}: --${flag} takes on or off, got "${raw}".`);
}

/**
 * `--scope project|user`, or `undefined` when nobody typed it — which is not the same
 * as `project`: absent means *detect*, and the three verbs that own this flag detect
 * the same way (`resolveScope` in `harness/scope.ts`).
 *
 * It lives with the flag rather than with a verb because three verbs own it, and the
 * three of them agreeing on what `user` means is the whole point: a setup at one scope
 * and a doctor at the other would report a healthy install with nothing wired.
 */
export function parseScope(raw: string | undefined): InstallScope | undefined {
  if (raw === undefined) return undefined;
  if ((INSTALL_SCOPES as readonly string[]).includes(raw)) return raw as InstallScope;
  throw new CliUsageError(
    `${CLI_NAME}: --scope takes ${INSTALL_SCOPES.join(' or ')}, got "${raw}".`,
  );
}
