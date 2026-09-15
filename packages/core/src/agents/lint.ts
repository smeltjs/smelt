import { nodeFsReader } from '../repomap/reader.ts';
import type { RepoReader } from '../repomap/reader.ts';
import type { ElisionReason } from '../types.ts';

import { ARTICLE, ARTICLE_TITLE, citing, GUIDE } from './guide.ts';
import { ancestorDirs, readInstructionSet, resolvesInTree } from './instructions.ts';
import type { InstructionFile, InstructionLevel, InstructionSet } from './instructions.ts';

/**
 * `smelt agents lint` — the audit of the blob an agent loads on **every** request.
 *
 * smelt's whole subject is what a context window is spent on, and an instruction file
 * is the one blob every request pays for whether or not it is relevant. So the lint is
 * the same three moves smelt makes everywhere else, aimed at a file nobody measures:
 *
 *  1. **Measure, never threshold** (ruling R2). Bytes per level, the most any single
 *     request loads, and the repository-wide surface — three numbers, each labelled
 *     with the question it answers, because a monorepo makes the last two differ and
 *     printing one under the other's heading is a lie about a cost. Plus an imperative
 *     count that says out loud it is a heuristic. The only number that can fail a run
 *     is `agents.budgetBytes` in `smelt.config.json` — *the user's own*. There is no
 *     built-in budget, for exactly the reason `--budget` has none.
 *  2. **Explain every finding** (Law 2, in the {@link ElisionReason} discipline). A
 *     finding is a stable `rule` id plus a sentence, and the sentence ends in a phrase
 *     from the guide it is applying, attributed — see `./guide.ts`.
 *  3. **Resolve against the real tree** (ruling R3). `dead-path` and `dead-link` are
 *     the checks nobody else makes, because everyone else is linting Markdown while
 *     the thing that has rotted is the *repository the Markdown describes*. A renamed
 *     `src/auth/handlers.ts` does not make the file invalid; it makes it a lie that
 *     the agent believes on every request.
 *
 * **Advisory by default.** Findings exit 0. `--strict` turns any finding into exit 1
 * for CI, because a check that cannot be enforced is a check nobody runs, and a check
 * that is enforced by default is smelt deciding somebody's house style for them.
 *
 * The heuristics here are heuristics, and the report says so where it matters: the
 * imperative count carries "(heuristic)" in its own label and in every receipt,
 * `generated-boilerplate` calls itself the softest rule in its own explanation, and the
 * closing line of every run states that findings are advisory and exit 0 unless
 * `--strict` was asked for. A rule that fires on a file the guide would call minimal is
 * not automatically a bug in the file — it may be a bug in the rule, or in the guide,
 * and the answer is worth writing down either way (ruling R9; see this repository's own
 * `AGENTS.md`).
 */

/* ------------------------------------------------------------------------------------
 * Rule ids — stable, and the whole machine-readable surface of a finding
 * ---------------------------------------------------------------------------------- */

// The ids. What each rule means is said once, in its {@link AGENTS_RULES} entry — the
// sentence the help prints — not repeated here.
export const DEAD_PATH_RULE = 'dead-path';
export const DEAD_LINK_RULE = 'dead-link';
export const FORCING_LANGUAGE_RULE = 'forcing-language';
export const STRUCTURE_DUMP_RULE = 'structure-dump';
export const GENERATED_BOILERPLATE_RULE = 'generated-boilerplate';
export const LANGUAGE_RULE_RULE = 'language-rule';
export const MIRROR_DRIFT_RULE = 'mirror-drift';
export const RESTATED_AT_LEVEL_RULE = 'restated-at-level';
export const BLANKET_READ_RULE = 'blanket-read';

/** The id of one advisory rule — the machine-readable half of a finding. */
export type AgentsRuleId =
  | typeof DEAD_PATH_RULE
  | typeof DEAD_LINK_RULE
  | typeof FORCING_LANGUAGE_RULE
  | typeof STRUCTURE_DUMP_RULE
  | typeof GENERATED_BOILERPLATE_RULE
  | typeof LANGUAGE_RULE_RULE
  | typeof MIRROR_DRIFT_RULE
  | typeof RESTATED_AT_LEVEL_RULE
  | typeof BLANKET_READ_RULE;

/** What a rule that reads one file at a time is handed beside the file. */
export interface RuleContext {
  /** The repository root, for resolving tokens against the tree. */
  readonly root: string;
  /** The tree seam. Every resolution goes through it. */
  readonly reader: RepoReader;
}

/**
 * One advisory rule: its id, the one sentence the help prints for it, the scope it
 * reads at, and the finder. Three scopes, because the rules genuinely read three
 * different things — one file's lines, one level's primary beside its mirrors, or the
 * whole merged set — and a rule at the wrong scope is a type error, not a runtime one.
 */
export type AgentsRule =
  | {
      readonly id: AgentsRuleId;
      readonly meaning: string;
      readonly scope: 'file';
      readonly find: (
        file: InstructionFile,
        lines: readonly ScannedLine[],
        context: RuleContext,
      ) => AgentsFinding[];
    }
  | {
      readonly id: AgentsRuleId;
      readonly meaning: string;
      readonly scope: 'level';
      readonly find: (level: InstructionLevel) => AgentsFinding[];
    }
  | {
      readonly id: AgentsRuleId;
      readonly meaning: string;
      readonly scope: 'set';
      readonly find: (set: InstructionSet) => AgentsFinding[];
    };

/**
 * The rule registry — every advisory rule, keyed by its own id, in report order.
 *
 * The same shape `HARNESS_PROFILES`, `SUBCOMMANDS` and `PLANNERS` take, for the same
 * reason: a `Record` over the id union does not compile with an entry missing, so
 * adding a rule is one entry here and its finder, and forgetting either is a build
 * error rather than a rule that exists in the help and never runs. The guard checks
 * every key names its own entry (`assertKeyedById`), that the published id list is
 * the entries' own ids, and — one fixture per rule — that every rule fires. Until
 * review IV (REP-51) the rule list was declared twice — an array of ids for report
 * order, and a hand-written sequence of eight finder calls — and nothing tied the two
 * together.
 */
export const AGENTS_RULES: Readonly<Record<AgentsRuleId, AgentsRule>> = {
  [DEAD_PATH_RULE]: {
    id: DEAD_PATH_RULE,
    meaning: 'a path-like token resolving to nothing in the tree',
    scope: 'file',
    find: (file, lines, context) => findDeadPaths(file, lines, context.root, context.reader),
  },
  [DEAD_LINK_RULE]: {
    id: DEAD_LINK_RULE,
    meaning: 'a link whose relative target is not in the tree',
    scope: 'file',
    find: (file, lines, context) => findDeadLinks(file, lines, context.root, context.reader),
  },
  [FORCING_LANGUAGE_RULE]: {
    id: FORCING_LANGUAGE_RULE,
    meaning: '"always", "never" or ALL-CAPS where a reason would do',
    scope: 'file',
    find: findForcingLanguage,
  },
  [STRUCTURE_DUMP_RULE]: {
    id: STRUCTURE_DUMP_RULE,
    meaning: 'a drawn directory tree, or a run of bare path lines',
    scope: 'file',
    find: findStructureDumps,
  },
  [GENERATED_BOILERPLATE_RULE]: {
    id: GENERATED_BOILERPLATE_RULE,
    meaning: 'the fingerprints an init script leaves (softest rule)',
    scope: 'file',
    find: findGeneratedBoilerplate,
  },
  [BLANKET_READ_RULE]: {
    id: BLANKET_READ_RULE,
    meaning: 'a "read A, B and C" with no when — every request pays',
    scope: 'file',
    find: findBlanketReads,
  },
  [LANGUAGE_RULE_RULE]: {
    id: LANGUAGE_RULE_RULE,
    meaning: 'a code-style rule paid on every request, used on few',
    scope: 'file',
    find: findLanguageRules,
  },
  [MIRROR_DRIFT_RULE]: {
    id: MIRROR_DRIFT_RULE,
    meaning: 'a CLAUDE.md or GEMINI.md diverged from its AGENTS.md',
    scope: 'level',
    find: (level) => findMirrorDrift(level.primary, level.mirrors),
  },
  [RESTATED_AT_LEVEL_RULE]: {
    id: RESTATED_AT_LEVEL_RULE,
    meaning: 'an instruction restated at a level and an ancestor',
    scope: 'set',
    find: findRestatedAcrossLevels,
  },
};

/**
 * The rule ids in report order — the entries' own ids, in the registry's key order,
 * derived the way `HARNESS_IDS` is and never restated. Read from the entries rather
 * than the keys so that a key naming one rule over an entry carrying another shows up
 * here too, not only in the guard.
 *
 * The ids are a wire surface: they go into `--json`, into CI greps and into whatever a
 * user filters on, so each is declared once (the constants above) and the list is
 * whatever the registry says.
 */
export const AGENTS_LINT_RULES: readonly AgentsRuleId[] = Object.values(AGENTS_RULES).map(
  (rule) => rule.id,
);

/**
 * The imperative counter's rule id (ruling R6).
 *
 * **Deliberately not in {@link AGENTS_LINT_RULES}.** An imperative is not a defect —
 * an instruction file is *made* of imperatives — so counting them is a measurement,
 * like `outputBytes`, and putting them among the findings would make `--strict` red on
 * every real AGENTS.md and therefore useless. Each counted line still carries a
 * receipt naming the verb that matched, because a heuristic whose matches you cannot
 * inspect is a number nobody can check.
 */
export const IMPERATIVE_LINE_RULE = 'imperative-line';

/* ------------------------------------------------------------------------------------
 * The report
 * ---------------------------------------------------------------------------------- */

/** One thing the lint noticed, at one place, with its reason. */
export interface AgentsFinding {
  /** Root-relative path of the instruction file. */
  readonly file: string;
  /** 1-based line within that file. */
  readonly line: number;
  /** Stable `rule` id plus the sentence explaining it — Law 2's shape. */
  readonly reason: ElisionReason;
}

/** What one level of the merged set costs, and what stands beside it. */
export interface AgentsLevelReport {
  /** Root-relative directory; `''` is the repository root. */
  readonly dir: string;
  /** The file this level contributes — see {@link InstructionLevel}. */
  readonly path: string;
  readonly bytes: number;
  /** The mirrors at this level, and how each one stands. */
  readonly mirrors: readonly AgentsMirrorReport[];
}

/** A `CLAUDE.md`/`GEMINI.md` beside an `AGENTS.md`, and whether it can drift. */
export interface AgentsMirrorReport {
  readonly path: string;
  readonly bytes: number;
  /**
   * `'symlink'` — the arrangement the guide recommends, and the only one in which
   * drift is impossible. `'copy'` — byte-identical today. `'drift'` — diverged, and a
   * {@link MIRROR_DRIFT_RULE} finding.
   */
  readonly standing: 'symlink' | 'copy' | 'drift';
}

/** Everything one `smelt agents lint` run measured and found. */
export interface AgentsLintReport {
  /** The directory that was linted, as the caller spelled it. */
  readonly root: string;
  /** Root level first. Empty when the tree holds no instruction file at all. */
  readonly levels: readonly AgentsLevelReport[];
  /**
   * The repository-wide instruction surface: every level's primary, summed.
   *
   * **Not a per-request cost** — see {@link perRequestBytes}, and the note in
   * `./instructions.ts` on why the two differ in any monorepo. This is the number the
   * user's `agents.budgetBytes` is compared against, deliberately: a ceiling on the
   * whole surface is one that cannot be met by moving bytes into a second package.
   */
  readonly totalBytes: number;
  /**
   * What the most expensive single request loads: the heaviest level plus its
   * ancestors. Siblings never merge, so they are never summed into this.
   */
  readonly perRequestBytes: number;
  /** Present only when `smelt.config.json` set one. There is no default (R2). */
  readonly budgetBytes?: number;
  /**
   * Lines counted as instructions, each with the verb that matched. The *count* is the
   * headline (`imperatives (heuristic)`); the receipts make it checkable.
   */
  readonly imperatives: readonly AgentsFinding[];
  /** Every advisory finding, grouped by rule in {@link AGENTS_LINT_RULES} order. */
  readonly findings: readonly AgentsFinding[];
}

/** What `lintAgents` needs. Everything but the root has a default. */
export interface AgentsLintOptions {
  /** The repository root to lint. */
  readonly root: string;
  /** The tree seam. Defaults to {@link nodeFsReader}. */
  readonly reader?: RepoReader;
  /** Replaces the built-in ignore list when given. */
  readonly ignore?: readonly string[];
  /** The user's budget, from `smelt.config.json`. Absent means unbudgeted (R2). */
  readonly budgetBytes?: number;
}

/**
 * Lint the merged set under `root`.
 *
 * Pure over its inputs and its reader: nothing is written, and every filesystem touch
 * goes through {@link RepoReader}, which has no writer on it.
 */
export function lintAgents(options: AgentsLintOptions): AgentsLintReport {
  const reader = options.reader ?? nodeFsReader();
  const set = readInstructionSet({
    root: options.root,
    reader,
    ...(options.ignore === undefined ? {} : { ignore: options.ignore }),
  });

  const findings: AgentsFinding[] = [];
  const imperatives: AgentsFinding[] = [];
  // The fold over the registry: every rule runs at its own scope, and nothing here
  // names a rule — adding one is a registry entry, not an edit to this loop.
  const rules = Object.values(AGENTS_RULES);
  const context: RuleContext = { root: options.root, reader };

  for (const level of set.levels) {
    // The imperative count is a companion to the byte total, so it is counted over
    // exactly what the byte total is counted over: the primaries. A mirror is an
    // alternative spelling of a level, not a second level — counting it would make
    // the headline number describe a request nobody makes.
    imperatives.push(...countImperatives(level.primary, scanLines(level.primary.text)));

    // The rules, though, run over the primary **and every mirror that has actually
    // diverged**: a drifted CLAUDE.md is what Claude Code loads, so its own dead paths
    // are real. A symlink or a byte-identical copy is skipped — it would mint a
    // duplicate of every finding on the primary and say nothing new.
    const linted = [
      level.primary,
      ...level.mirrors.filter((mirror) => standingOf(level.primary, mirror) === 'drift'),
    ];
    for (const file of linted) {
      const lines = scanLines(file.text);
      for (const rule of rules) {
        if (rule.scope === 'file') findings.push(...rule.find(file, lines, context));
      }
    }
    for (const rule of rules) {
      if (rule.scope === 'level') findings.push(...rule.find(level));
    }
  }
  for (const rule of rules) {
    if (rule.scope === 'set') findings.push(...rule.find(set));
  }

  return {
    root: options.root,
    levels: set.levels.map((level) => ({
      dir: level.dir,
      path: level.primary.path,
      bytes: level.primary.bytes,
      mirrors: level.mirrors.map((mirror) => ({
        path: mirror.path,
        bytes: mirror.bytes,
        standing: standingOf(level.primary, mirror),
      })),
    })),
    totalBytes: set.totalBytes,
    perRequestBytes: set.perRequestBytes,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes }),
    imperatives,
    findings: findings.toSorted(byRuleThenPlace),
  };
}

/** How far over the user's budget the merged set is, or `undefined` when it fits. */
export function overBudgetBytes(report: AgentsLintReport): number | undefined {
  if (report.budgetBytes === undefined) return undefined;
  const over = report.totalBytes - report.budgetBytes;
  return over > 0 ? over : undefined;
}

/** Findings in report order: rule first, then where they were found. */
function byRuleThenPlace(a: AgentsFinding, b: AgentsFinding): number {
  const rank =
    ruleOrder(a.reason.rule) - ruleOrder(b.reason.rule) ||
    (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) ||
    a.line - b.line;
  return rank;
}

function ruleOrder(rule: string): number {
  const index = (AGENTS_LINT_RULES as readonly string[]).indexOf(rule);
  return index === -1 ? AGENTS_LINT_RULES.length : index;
}

/* ------------------------------------------------------------------------------------
 * Scanning: prose versus fences
 * ---------------------------------------------------------------------------------- */

/** One line of an instruction file, with the one fact every rule branches on. */
export interface ScannedLine {
  /** 1-based. */
  readonly number: number;
  readonly text: string;
  /** True inside a fenced code block, including the fence lines themselves. */
  readonly fenced: boolean;
  /** True for the ``` or ~~~ line that opens a block. */
  readonly opensFence: boolean;
}

/**
 * Split a file into lines, marking fenced code.
 *
 * The distinction matters in both directions: a `const x = 1` inside a fence is an
 * *example*, not a `language-rule`, and a tree drawing is only a `structure-dump`
 * because it is a fence full of paths. Rules that read prose skip fences; the one
 * rule that reads fences skips prose.
 */
function scanLines(text: string): readonly ScannedLine[] {
  const out: ScannedLine[] = [];
  let fence: string | undefined;
  text.split('\n').forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    const opensFence = marker !== null && fence === undefined;
    if (marker !== null) {
      if (fence === undefined) fence = marker[1]!.slice(0, 1);
      else if (marker[1]!.startsWith(fence)) fence = undefined;
      out.push({ number: index + 1, text: line, fenced: true, opensFence });
      return;
    }
    out.push({ number: index + 1, text: line, fenced: fence !== undefined, opensFence: false });
  });
  return out;
}

/** A line stripped of list bullets, heading hashes, blockquote marks and bold runs. */
function bareText(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|#{1,6}\s+|>\s*)+/, '')
    .replace(/\*\*/g, '')
    .trim();
}

/* ------------------------------------------------------------------------------------
 * imperative-line — a labelled heuristic (R6)
 * ---------------------------------------------------------------------------------- */

/**
 * The openers counted as an instruction.
 *
 * A closed list, deliberately: an open-ended part-of-speech guess would be a number
 * nobody could reproduce, and this figure is reported beside a byte count that *is*
 * exact. The modal openers the guide itself names — always / never / do not / must /
 * should — are here alongside the verbs an instruction file actually opens with.
 */
const IMPERATIVE_OPENERS: readonly string[] = [
  'add',
  'always',
  'avoid',
  'build',
  'check',
  'commit',
  'create',
  'do',
  'document',
  'ensure',
  'follow',
  'format',
  'ignore',
  'implement',
  'install',
  'keep',
  'lint',
  'make',
  'must',
  'name',
  'never',
  'place',
  'prefer',
  'put',
  'read',
  'refuse',
  'remove',
  'return',
  'run',
  'should',
  'skip',
  'test',
  'throw',
  'treat',
  'update',
  'use',
  'verify',
  'write',
];

/**
 * Count the lines that read as instructions, one receipt each.
 *
 * Reported as `imperatives (heuristic)` and never as a precise figure, because it is
 * not one: "Run `pnpm verify`" counts and "The gate is `pnpm verify`" does not, and
 * both are the same instruction. The number is useful as a *scale* — the guide cites
 * ~150-200 as what a frontier thinking model follows consistently — and useless as a
 * threshold, which is why nothing here compares it to anything.
 */
function countImperatives(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    const bare = bareText(line.text);
    if (bare === '') continue;
    const opener = /^(do not|[A-Za-z']+)/.exec(bare.toLowerCase())?.[1];
    if (opener === undefined) continue;
    const matched = opener === 'do not' ? 'do not' : opener === "don't" ? "don't" : opener;
    const counted =
      matched === 'do not' ||
      matched === "don't" ||
      IMPERATIVE_OPENERS.includes(matched.replace(/'.*$/, ''));
    if (!counted) continue;
    out.push({
      file: file.path,
      line: line.number,
      reason: {
        rule: IMPERATIVE_LINE_RULE,
        explanation:
          `opens with "${matched}", so it is counted as one instruction (heuristic)` +
          citing(GUIDE.instructionCeiling),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * dead-link — a Markdown link whose target left the tree
 * ---------------------------------------------------------------------------------- */

/** `[text](target)`, with the target captured. */
const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * CommonMark lets a link destination be wrapped in angle brackets — `[x](<a b.md>)`,
 * the only way to write one containing a space. The brackets are delimiters, not part
 * of the path, and statting `<src/kept.ts>` never resolves: the rule would report a
 * live file as dead, which is the exact failure this rule exists to avoid making.
 */
function stripAngles(target: string): string {
  return target.startsWith('<') && target.endsWith('>') ? target.slice(1, -1) : target;
}

function findDeadLinks(
  file: InstructionFile,
  lines: readonly ScannedLine[],
  root: string,
  reader: RepoReader,
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    for (const match of line.text.matchAll(MARKDOWN_LINK)) {
      const target = stripFragment(stripAngles(match[1]!));
      if (target === '' || isExternal(target)) continue;
      const resolved = resolveAgainst(file.dir, target);
      if (resolved === undefined) continue;
      if (resolvesInTree(root, reader, resolved)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: DEAD_LINK_RULE,
          explanation:
            `links to \`${target}\`, which is not in the tree — the pointer the root ` +
            `file exists to be goes nowhere` +
            citing(GUIDE.pointsElsewhere),
        },
      });
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * dead-path — the flagship (R3)
 * ---------------------------------------------------------------------------------- */

/** A token with a directory separator: `src/auth`, `./scripts/build.mjs`, `docs/`. */
const SLASHED = /^\.{0,2}\/?[\w.+-]+(?:\/[\w.+-]+)*\/?$/;
/** A bare file name whose extension says "this is a file in this repo". */
const CODE_FILE = /^[\w.-]+\.(?:[cm]?[jt]sx?|json|md|ya?ml|toml|py|rs|go|rb|java|sh|sql|css|html)$/;
/**
 * A host name: what `example.com/guide` is, and what a repository path never is.
 *
 * A scheme-less URL is the one thing that is shaped exactly like a relative path —
 * dotted word, slash, more words — and the guide this very tool cites is written
 * `aihero.dev/a-complete-guide-to-agents-md` in smelt's own help text. Only the
 * segment before the first slash is tested, so `scripts/build.sh` is untouched: `sh`
 * is a TLD *and* an extension, and which one it is depends entirely on where the dot
 * sits relative to the separator.
 */
const DOMAIN_HOST =
  /^[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|dev|ai|app|co|me|sh|so|to|xyz|gg|cloud|page|info|blog)$/i;
/**
 * `Node.js`, `Vue.js`, `Bun.sh`, `Three.js` — a product, not a file in this tree.
 *
 * Narrow on purpose: one capitalised word, then one of the five suffixes products are
 * actually named with. It costs a bare mention of a PascalCase `Button.js`, which is
 * a real filename — but that is a finding not made, and this is a false accusation not
 * made, and on the flagship rule those two are not worth the same.
 */
const PRODUCT_NAME = /^[A-Z][A-Za-z]*\.(?:js|sh|ai|dev|io)$/;

function findDeadPaths(
  file: InstructionFile,
  lines: readonly ScannedLine[],
  root: string,
  reader: RepoReader,
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.fenced) continue;
    // Markdown link targets belong to `dead-link`; blank them so one dead pointer is
    // never reported twice under two rules.
    const withoutLinks = line.text.replace(MARKDOWN_LINK, '[]()');
    for (const token of pathCandidates(withoutLinks)) {
      const key = `${String(line.number)} ${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolveAgainst(file.dir, token);
      // A token that climbed out of the tree with `..` is not a path this lint can
      // rule on: it names something outside the repository, and both "dead" and
      // "alive" would be guesses about a directory nobody handed us.
      if (resolved === undefined) continue;
      if (resolvesInTree(root, reader, resolved)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: DEAD_PATH_RULE,
          explanation:
            `names \`${token}\`, which resolves to nothing in this tree — an agent ` +
            `reads this on every request and looks there anyway` +
            citing(GUIDE.stalenessPoisons),
        },
      });
    }
  }
  return out;
}

/**
 * The path-like tokens on one line.
 *
 * Inline code spans first, because a path in an instruction file is nearly always in
 * backticks; then bare words, filtered hard. The filters are the interesting part —
 * every one of them is a false positive this rule made before it had them:
 *
 *  - `https://…`, `mailto:` — not tree paths.
 *  - `@smeltjs/core`, `@types/node` — package names, which look exactly like paths.
 *  - `src/**\/*.ts` — a glob describes a set, and a set does not resolve.
 *  - `pnpm run build`, `and/or` — anything with whitespace, and anything whose
 *    segments carry no extension and no separator worth trusting.
 *  - `v1.2/v2` style version prose, caught by requiring a real segment shape.
 *  - `example.com/guide`, `aihero.dev/…` — a URL somebody wrote without its scheme.
 *  - `Node.js`, `Vue.js`, `Bun.sh` — products whose names end in an extension.
 *
 * The last two are why a token *without* a separator is a candidate only when it came
 * out of a code span. In running prose a dotted bare word is far more often a product
 * than a file, and this rule's whole value is that a reader believes it: one confident
 * sentence accusing `Node.js` of having left the tree costs more trust than a dozen
 * real findings earn. In backticks the author has said "this is a thing in my
 * repository", and the rule takes them at their word.
 */
function pathCandidates(text: string): readonly string[] {
  const tokens: string[] = [];
  const add = (raw: string, fromCodeSpan: boolean): void => {
    const token = raw.replace(/[),.:;]+$/, '').trim();
    if (token === '' || !isPathLike(token, fromCodeSpan)) return;
    tokens.push(token);
  };
  const withoutCode = text.replace(/`([^`]+)`/g, (_whole, inner: string) => {
    add(inner, true);
    return ' ';
  });
  for (const word of withoutCode.split(/\s+/)) add(word, false);
  return tokens;
}

/**
 * Is `token` a path into this tree?
 *
 * `fromCodeSpan` is the author's own signal, and it decides the one ambiguous case: a
 * dotted word with no separator. See {@link pathCandidates}.
 */
function isPathLike(token: string, fromCodeSpan: boolean): boolean {
  if (isExternal(token)) return false;
  if (token.startsWith('@')) return false;
  if (/[*?[\]{}<>|"'`\\]/.test(token)) return false;
  if (token.startsWith('#')) return false;
  if (!SLASHED.test(token)) return false;
  if (token.includes('/')) {
    // `example.com/guide` — a URL with its scheme left off, not a directory.
    return !DOMAIN_HOST.test(token.split('/')[0] ?? '');
  }
  return fromCodeSpan && !PRODUCT_NAME.test(token) && CODE_FILE.test(token);
}

/** True for anything that is not a path into this tree. */
function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//') || target.startsWith('#');
}

function stripFragment(target: string): string {
  const cut = target.indexOf('#');
  return cut === -1 ? target : target.slice(0, cut);
}

/**
 * A token in a nested instruction file is relative to *that* file's directory, which
 * is the whole reason a nested file can hold a link the root one cannot. `../` is
 * resolved rather than refused, so a nested file may point back up the tree.
 *
 * `undefined` when the token climbs past the repository root. It used to clamp there —
 * `stack.pop()` on an empty stack is a no-op — which silently turned `../sibling/x.ts`
 * into `sibling/x.ts` and then answered a question about the wrong file, in whichever
 * direction happened to be wrong. Outside the tree, this lint has nothing to say.
 */
function resolveAgainst(dir: string, token: string): string | undefined {
  const base = dir === '' ? [] : dir.split('/');
  const parts = token.replace(/\/+$/, '').split('/');
  const stack = [...base];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (stack.length === 0) return undefined;
      stack.pop();
    } else stack.push(part);
  }
  return stack.join('/');
}

/* ------------------------------------------------------------------------------------
 * forcing-language
 * ---------------------------------------------------------------------------------- */

/** ALL-CAPS words a reader meets as shouting rather than as an acronym. */
const SHOUTED = /\b(ALWAYS|NEVER|MUST|DO NOT|DON'T|REQUIRED|MANDATORY|CRITICAL|IMPORTANT)\b/;
/** The two words the guide names in its own example of what *not* to write. */
const FORCING_WORDS = /\b(always|never)\b/i;

function findForcingLanguage(
  file: InstructionFile,
  lines: readonly ScannedLine[],
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    const shouted = SHOUTED.exec(line.text)?.[1];
    const forcing = shouted ?? FORCING_WORDS.exec(line.text)?.[1];
    if (forcing === undefined) continue;
    out.push({
      file: file.path,
      line: line.number,
      reason: {
        rule: FORCING_LANGUAGE_RULE,
        explanation:
          `forces with "${forcing}" — forcing language spends tokens on emphasis ` +
          `rather than on information` +
          citing(GUIDE.lightTouch),
      },
    });
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * structure-dump
 * ---------------------------------------------------------------------------------- */

/**
 * The characters a generated tree listing is drawn with.
 *
 * Both charsets: `tree` draws box-drawing by default and `|--` / `` `-- `` under
 * `--charset=ascii`, and the ASCII form is what lands in a file written on a machine
 * whose terminal was not UTF-8. Missing it made the whole rule silent on a fenced
 * ASCII tree — and because fenced lines skip `dead-path` too, that block produced no
 * finding of any kind.
 */
const TREE_DRAWING = /[├└│─]|^\s*(?:\|--|`--|\|\s{3}|\+--)/;
/** How many path-ish lines in a row read as a dump rather than as an example. */
const DUMP_RUN = 3;

function findStructureDumps(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];

  // A fenced block whose body is a tree drawing.
  let fenceStart: ScannedLine | undefined;
  let drawn = 0;
  for (const line of lines) {
    if (line.opensFence) {
      fenceStart = line;
      drawn = 0;
      continue;
    }
    if (!line.fenced) {
      fenceStart = undefined;
      continue;
    }
    if (fenceStart === undefined) continue;
    if (TREE_DRAWING.test(line.text)) drawn += 1;
    if (drawn === 2) {
      out.push(structureFinding(file, fenceStart.number, 'a directory tree'));
      fenceStart = undefined;
    }
  }

  // A run of bare path lines in prose — the same dump without the box characters.
  let run = 0;
  let runStart = 0;
  for (const line of lines) {
    if (line.fenced) {
      run = 0;
      continue;
    }
    const bare = bareText(line.text);
    // A line whose whole content is one token is a path line, not prose — so the
    // code-span rule `dead-path` needs against running text has nothing to guard here.
    const isPathLine =
      bare !== '' && isPathLike(bare.replace(/`/g, '').split(/\s+/)[0] ?? '', true);
    if (isPathLine && bare.split(/\s+/).length <= 2) {
      if (run === 0) runStart = line.number;
      run += 1;
      if (run === DUMP_RUN) out.push(structureFinding(file, runStart, 'a run of path lines'));
    } else {
      run = 0;
    }
  }

  return out;
}

function structureFinding(file: InstructionFile, line: number, what: string): AgentsFinding {
  return {
    file: file.path,
    line,
    reason: {
      rule: STRUCTURE_DUMP_RULE,
      explanation:
        `spends the every-request budget on ${what} — layout is the fact in a ` +
        `repository that changes most often, so it is also the fact that rots first` +
        citing(GUIDE.describeCapabilities),
    },
  };
}

/* ------------------------------------------------------------------------------------
 * generated-boilerplate — the softest rule here, and it says so
 * ---------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------
 * blanket-read — "read A, B and C first", with no when (review IV, REP-59)
 * ---------------------------------------------------------------------------------- */

/** The verbs that make a line a reading instruction rather than a description. */
const READ_VERBS = /\b(?:read|review|consult|study|go through|familiari[sz]e yourself with)\b/i;

/** A read that is told *not* to happen is not a tour: "do not read `dist/` and `lock`". */
const NEGATED_READ =
  /\b(?:do not|don't|never|avoid|without)\s+(?:read|review|consult|study|go through)\b/i;

/**
 * An occasion for the whole line: it opens on a "before/when/if …" clause, or closes on
 * a condition ("… only when the schema changes"). Either says *when*, which is what the
 * article asks an instruction to say.
 */
const LEADING_OCCASION = /^(?:before|after|when|whenever|if|unless|while|once|during)\b/i;
const TRAILING_CONDITION = /\b(?:when|whenever|if|unless|only)\b/i;

/**
 * A trigger bound to one document — the article's own shape, `<doc> for <task>` — read
 * off the text between that document and the next. `for` counts here and not in a
 * trailing clause: "`a.md` for service boundaries" is a trigger; "read `a.md` and `b.md`
 * for context" is a tour with a filler on the end.
 */
const DOCUMENT_TRIGGER = /\b(?:for|when|whenever|if|unless)\b/i;

/**
 * A blanket read: one prose line that tells the agent to read two or more documents
 * and gives an occasion for none of them. Every request then pays for every one, which
 * is the guide's thesis restated from the article's side. The passing shapes: a
 * document each with its own trigger ("use X for service boundaries, Y for schema
 * changes"), a line that opens or closes on an occasion, a single pointer, a negated
 * read. The failing shape names its documents in the finding, so the reader can see
 * the tour.
 */
function findBlanketReads(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    const text = bareText(line.text);
    if (!READ_VERBS.test(text) || NEGATED_READ.test(text) || LEADING_OCCASION.test(text)) continue;
    const documents = documentSpans(text);
    if (documents.length < 2) continue;
    const tail = text.slice(documents[documents.length - 1]!.end);
    if (TRAILING_CONDITION.test(tail)) continue;
    // Every document but the last must carry its own trigger in the text that follows
    // it; one that does not is a document the agent is told to read for no stated reason.
    const untriggered = documents
      .slice(0, -1)
      .filter(
        (doc, index) => !DOCUMENT_TRIGGER.test(text.slice(doc.end, documents[index + 1]!.start)),
      );
    if (untriggered.length === 0) continue;
    const names = documents.map((doc) => doc.name);
    out.push({
      file: file.path,
      line: line.number,
      reason: {
        rule: BLANKET_READ_RULE,
        explanation:
          `directs a read of ${String(names.length)} documents (${names
            .map((name) => `\`${name}\``)
            .join(', ')}) with no occasion for them — every request pays for all; say ` +
          `what each is for` +
          citing(ARTICLE.contextualTriggers, ARTICLE_TITLE),
      },
    });
  }
  return out;
}

/** The documents a line names — links and path-like tokens — with where each sits in it. */
function documentSpans(
  text: string,
): readonly { readonly name: string; readonly start: number; readonly end: number }[] {
  const spans: { name: string; start: number; end: number }[] = [];
  for (const match of text.matchAll(MARKDOWN_LINK)) {
    spans.push({ name: match[1]!, start: match.index, end: match.index + match[0].length });
  }
  const withoutLinks = text.replace(MARKDOWN_LINK, (whole) => ' '.repeat(whole.length));
  for (const token of pathCandidates(withoutLinks)) {
    const at = withoutLinks.indexOf(token);
    if (at !== -1) spans.push({ name: token, start: at, end: at + token.length });
  }
  const seen = new Set<string>();
  return spans
    .toSorted((a, b) => a.start - b.start)
    .filter((span) => (seen.has(span.name) ? false : (seen.add(span.name), true)));
}

/** The fingerprints an init script leaves behind, with what each one is. */
const BOILERPLATE_SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/\bauto-?generated\b/i, 'an "auto-generated" marker'],
  [/\bgenerated by\b/i, 'a "generated by" credit'],
  [/<!--\s*generated/i, 'a generated-block comment'],
  [/\b(?:claude|codex|gemini|cursor|agents?)\s+init\b/i, 'an init-command credit'],
  [/\bthis file was (?:created|generated)\b/i, 'a "this file was generated" line'],
  [/\bdo not edit\b/i, 'a "do not edit" banner'],
];

function findGeneratedBoilerplate(
  file: InstructionFile,
  lines: readonly ScannedLine[],
): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    for (const [pattern, what] of BOILERPLATE_SIGNATURES) {
      if (!pattern.test(line.text)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: GENERATED_BOILERPLATE_RULE,
          explanation:
            `carries ${what}, which suggests this file was generated rather than ` +
            `written. This is the softest rule here: a signature is circumstantial, ` +
            `and a hand-written file may honestly carry one, so it never means more ` +
            `than "read this file again"` +
            citing(GUIDE.neverGenerate),
        },
      });
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * language-rule
 * ---------------------------------------------------------------------------------- */

/** Style rules that pay their every-request cost only when the agent writes code. */
const LANGUAGE_RULE_SIGNATURES: readonly (readonly [RegExp, string])[] = [
  [/\bconst\b[^\n]*\blet\b|\blet\b[^\n]*\bconst\b/, 'a const/let rule'],
  [/\binterface\b[^\n]*\btype\b|\btype\b[^\n]*\binterface\b/, 'an interface-vs-type rule'],
  [/\bstrict[- ]?null(?:checks)?\b/i, 'a strict-null rule'],
  [/\bsemi-?colons?\b/i, 'a semicolon rule'],
  [/\b(?:single|double) quotes\b/i, 'a quote-style rule'],
  [/\barrow functions?\b/i, 'an arrow-function rule'],
  [/\bnamed exports?\b|\bdefault exports?\b/i, 'an export-style rule'],
  [
    /\btabs? (?:over|versus|vs\.?) spaces?\b|\bspaces? (?:over|versus|vs\.?) tabs?\b/i,
    'an indentation rule',
  ],
];

function findLanguageRules(file: InstructionFile, lines: readonly ScannedLine[]): AgentsFinding[] {
  const out: AgentsFinding[] = [];
  for (const line of lines) {
    if (line.fenced) continue;
    for (const [pattern, what] of LANGUAGE_RULE_SIGNATURES) {
      if (!pattern.test(line.text)) continue;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: LANGUAGE_RULE_RULE,
          explanation:
            `states ${what}, which is paid for on every request and is relevant on ` +
            `few of them — move it behind a link and it costs only the tasks it applies to` +
            citing(GUIDE.loadWhenRelevant),
        },
      });
      break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------------------------
 * mirror-drift (R4)
 * ---------------------------------------------------------------------------------- */

function standingOf(
  primary: InstructionFile,
  mirror: InstructionFile,
): AgentsMirrorReport['standing'] {
  if (mirror.symlink) return 'symlink';
  return mirror.text === primary.text ? 'copy' : 'drift';
}

/**
 * A mirror that has diverged from its `AGENTS.md`.
 *
 * A byte-identical copy is **not** a finding: it is not drift, and calling it one
 * would be smelt enforcing the guide's suggestion rather than reporting a fact. What
 * the report does say, beside every copy, is that a symlink cannot drift — which is
 * the guide's suggestion offered, exactly as `smelt hooks` offers rather than does.
 */
function findMirrorDrift(
  primary: InstructionFile,
  mirrors: readonly InstructionFile[],
): AgentsFinding[] {
  return mirrors
    .filter((mirror) => standingOf(primary, mirror) === 'drift')
    .map((mirror) => ({
      file: mirror.path,
      line: 1,
      reason: {
        rule: MIRROR_DRIFT_RULE,
        explanation:
          `has diverged from \`${primary.path}\` (${String(mirror.bytes)} bytes against ` +
          `${String(primary.bytes)}) — two harnesses are now reading two different sets ` +
          `of instructions from one repository` +
          citing(GUIDE.symlinkMirror),
      },
    }));
}

/* ------------------------------------------------------------------------------------
 * restated-at-level (R8)
 * ---------------------------------------------------------------------------------- */

/** Below this, a repeated line is a heading or a bullet marker, not an instruction. */
const RESTATEMENT_MIN_CHARS = 40;

/**
 * The same instruction present at a level **and at one of its ancestors**.
 *
 * The guide's rule is that a nested file *merges with* the root, so a line written in
 * both is a line the agent is handed twice — paid for twice, and the second copy
 * carrying the risk that only one of them is ever updated. Reported on the deeper file,
 * because that is the copy the ancestor already covers.
 *
 * **Only ancestors.** A merge runs up the tree, never across it: an agent working in
 * `pkg/a` loads the root file and `pkg/a`'s, and never `pkg/b`'s. So a line two
 * siblings happen to share is not a line anybody is handed twice, and reporting it as
 * one would print an explanation about a merge that does not happen — a finding whose
 * sentence is false, which is worse than no finding at all (Law 2).
 */
function findRestatedAcrossLevels(set: InstructionSet): AgentsFinding[] {
  /** dir → the lines that level states, each with the file that states them. */
  const stated = new Map<string, Map<string, string>>();
  const out: AgentsFinding[] = [];

  // Levels arrive root-first (`readInstructionSet` sorts by depth), so every ancestor
  // of a level has already been recorded by the time the level is read.
  for (const level of set.levels) {
    const file = level.primary;
    const local = new Map<string, string>();
    stated.set(level.dir, local);
    const ancestors = ancestorDirs(level.dir);

    scanLines(file.text).forEach((line) => {
      if (line.fenced) return;
      const normalized = bareText(line.text).toLowerCase().replace(/\s+/g, ' ');
      if (normalized.length < RESTATEMENT_MIN_CHARS) return;
      if (local.has(normalized)) return;
      local.set(normalized, file.path);
      const earlier = ancestors
        .map((dir) => stated.get(dir)?.get(normalized))
        .find((path) => path !== undefined);
      if (earlier === undefined) return;
      out.push({
        file: file.path,
        line: line.number,
        reason: {
          rule: RESTATED_AT_LEVEL_RULE,
          explanation:
            `repeats a line already in \`${earlier}\`, which is above it — the levels ` +
            `merge, so the agent is handed this twice and only one copy will be kept ` +
            `up to date` +
            citing(GUIDE.nestedMerge),
        },
      });
    });
  }
  return out;
}
