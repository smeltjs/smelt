/**
 * The guide `smelt agents` lints against, quoted once.
 *
 * Every rule in `./lint.ts` and every sentence `./split.ts` prints cites a source, and
 * the source is one article: *A Complete Guide to AGENTS.md* ({@link GUIDE_URL}). Its
 * thesis is a context-budget argument — the same argument smelt is built on — which is
 * why smelt can lint against it honestly: **an AGENTS.md is a blob that loads on every
 * request, and a blob that loads on every request is exactly what this repository
 * measures.**
 *
 * The quotes live here rather than inside each rule for the reason every other
 * "written twice" in this codebase got collected: an explanation that paraphrases its
 * source drifts from it silently, and a reader who cannot tell smelt's opinion from
 * the guide's cannot judge either. So a rule's explanation is *smelt's* sentence plus
 * a phrase from {@link GUIDE}, attributed — never smelt's opinion wearing the guide's
 * authority, and never the guide's advice restated as smelt's law.
 *
 * **What is not here: a threshold.** {@link GUIDE.instructionCeiling} is the guide's
 * cited figure and is printed as a citation, never applied. The only number that can
 * fail a lint is `agents.budgetBytes` in `smelt.config.json` — the user's own. See
 * ruling R2 in ISSUES.md, which is the same ruling that keeps `--budget` without a
 * default.
 */

/** Where every quote below comes from. Printed beside the citations, never guessed. */
export const GUIDE_URL = 'https://www.aihero.dev/a-complete-guide-to-agents-md';

/** How the guide is named in a citation. */
export const GUIDE_TITLE = 'the AGENTS.md guide';

/**
 * The guide's own phrasing, short and attributed.
 *
 * Each entry is a fragment of the article quoted for the rule it grounds. They are
 * deliberately brief: a lint that reprinted its source would be doing to the terminal
 * what a bloated AGENTS.md does to a context window.
 */
export const GUIDE = {
  /** The thesis. Why an instruction file is a budget problem at all. */
  loadsEveryRequest:
    'every token in your AGENTS.md gets loaded on every single request, ' +
    'regardless of whether it is relevant',
  /** The cited figure. **A citation, never a threshold** — see R2. */
  instructionCeiling:
    'frontier thinking LLMs can follow ~150-200 instructions with reasonable consistency',
  /** Why a dead path is worse than no path. The flagship rule's grounding (R3). */
  stalenessPoisons: 'stale information actively poisons the context',
  /** Why a directory listing is the wrong thing to spend the budget on. */
  describeCapabilities: 'instead of documenting structure, describe capabilities',
  /** The tone the guide's own example is written in. */
  lightTouch: "notice the light touch, no 'always', no all-caps forcing",
  /** The sentence that rules out `smelt agents init` (R1). */
  neverGenerate: 'never use initialization scripts to auto-generate your AGENTS.md',
  /** The payoff of moving style rules into a linked file. */
  loadWhenRelevant: 'TypeScript rules only load when the agent writes TypeScript',
  /** Why the sum across levels is the honest number (R8). */
  nestedMerge: 'a nested AGENTS.md merges with the root level — do not overload any level',
  /** What the root file should be once the refactor is done. */
  pointsElsewhere: 'the ideal root file is small, focused, and points elsewhere',
  /** The mirror advice, and the reason for it (R4). */
  symlinkMirror: '`ln -s AGENTS.md CLAUDE.md`, to keep all your tools working the same way',
  /** What the guide says a root file actually needs. The dogfood checklist (R9). */
  essentials:
    'a one-sentence project description, the package manager if it is not npm, and ' +
    'the build/typecheck commands if they are non-standard — "that\'s honestly it"',
} as const;

/**
 * The second source, quoted once for the same reason: OpenAI's note on rewriting skills
 * and instruction files for a more capable model ({@link ARTICLE_URL}). Its argument
 * about `AGENTS.md` is the guide's, from the other side — an instruction loaded on
 * every request should say *when* it applies, not name everything an agent might ever
 * read — and it grounds exactly one rule, `blanket-read` (review IV, REP-59). Quoted
 * as the source, never restated as smelt's law: the rule is advisory like the other
 * eight, and a reader can see whose sentence the finding leans on.
 */
export const ARTICLE_URL =
  'https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra';

/** How the article is named in a citation. */
export const ARTICLE_TITLE = "OpenAI's GPT-6 Astra notes";

/** The article's own phrasing, short and attributed. */
export const ARTICLE = {
  /** The rewrite it recommends in place of a blanket "read these before every edit". */
  contextualTriggers: 'use architecture.md for service boundaries, database.md for schema changes',
} as const;

/**
 * `… — <the source>: "<quote>"`, the tail every explanation ends with.
 *
 * One function so the attribution is spelled identically everywhere: a reader
 * scanning a wall of findings must be able to tell, at a glance and without counting
 * quotation marks, which half of a sentence is smelt's claim and which half is the
 * source's. The source defaults to the guide; the one rule grounded in the article
 * names it.
 */
export function citing(quote: string, source: string = GUIDE_TITLE): string {
  return ` — ${source}: "${quote}"`;
}
