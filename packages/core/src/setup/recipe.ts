/**
 * The SetupRecipe (CONTEXT.md): the one true way to put smelt on a machine — the
 * install commands, the init defaults, the store default, the hooks step, the MCP
 * registration — held as data, because prose is never the source. Every rendering
 * derives from this module or is pinned to it by a guard
 * (`test/guards/setup-recipe.test.ts`); the same facts used to be retyped until the
 * store default existed under three doc spellings, one of them wrong, and the MCP
 * registration command lived in four places at once.
 *
 * This module imports nothing and does nothing: it is the fact layer every setup
 * surface reads, and the seam the `setup` verb, the skill pack, and the site's fact
 * generator hang off.
 */
export const SETUP_RECIPE = {
  install: {
    /** The library, into a project — npm's spelling, and its siblings beside it. */
    library: 'npm install @smeltjs/core',
    libraryPnpm: 'pnpm add @smeltjs/core',
    libraryBun: 'bun add @smeltjs/core',
    /** The CLI, onto the machine. (Not named `global`: that word is Law 1's.) */
    globalInstall: 'npm install -g @smeltjs/core',
    /** The CLI, without installing it. */
    oneShot: 'npx @smeltjs/core',
    /** The CLI over Homebrew, from smelt's own tap (KOT-248 seeds it). */
    brewInstall: 'brew install smeltjs/tap/smelt',
    /** The Homebrew upgrade — the first half of the update loop doctor completes. */
    brewUpgrade: 'brew upgrade smelt',
    /** The SkillPack, installed by an agent's owner (ADR-0002). */
    skillInstall: 'npx skills add smeltjs/smelt',
  },
  /**
   * The budget the setup path writes when its caller names none — the number every
   * example already uses. Written loudly and recorded with its provenance; the
   * `smelt` verb's own budget-required refusal is untouched by it.
   */
  recommendedBudgetBytes: 4000,
  store: {
    /** Where the persistent store lives, relative to smelt.config.json. */
    defaultDir: '.smelt/store',
  },
  mcp: {
    /** The MCP server, run from the project directory. */
    run: 'npx @smeltjs/mcp',
    /**
     * Registration as Claude Code's CLI spells it — the canonical string while the
     * harness profiles cannot yet carry per-harness registration; the
     * mcp-registration step kind generalizes this per harness.
     */
    register: 'claude mcp add smelt -- npx @smeltjs/mcp',
    /**
     * The same registration for the whole machine. Claude Code's user scope is stored
     * under the top-level `mcpServers` key of `~/.claude.json` — a file Claude Code
     * owns and rewrites, and whose docs say to manage it through `/config` and this
     * CLI rather than by editing — so at user scope smelt prints this instead of
     * writing a byte. Verified 2026-09-09 against code.claude.com/docs/en/mcp and
     * .../mcp-quickstart ("Where servers are saved").
     */
    registerUser: 'claude mcp add --scope user smelt -- npx @smeltjs/mcp',
  },
} as const;

export type SetupRecipe = typeof SETUP_RECIPE;

/**
 * The recipe's run command as a spawn array — derived once, beside the fact it comes
 * from, because two harness profiles need the array and a second `.split(' ')` would
 * be the second spelling this module exists to end.
 */
export const MCP_RUN_ARGS: readonly string[] = SETUP_RECIPE.mcp.run.split(' ');

/** One step of the recipe, in the order a new machine walks it. */
export interface SetupStep {
  readonly id: 'install' | 'init' | 'hooks' | 'mcp' | 'verify';
  readonly title: string;
  readonly command: string;
}

/**
 * The recipe's steps, in order, ending in the verification that makes "set up" a
 * claim with evidence. The install and MCP commands are named facts above; the init,
 * hooks and verify steps name the verbs and the canonical invocation — the wizard
 * each is, not a fact the recipe owns, except the budget the verify step carries,
 * which is the recipe's.
 */
export const SETUP_STEPS: readonly SetupStep[] = [
  { id: 'install', title: 'install the CLI', command: SETUP_RECIPE.install.globalInstall },
  { id: 'init', title: 'write smelt.config.json', command: 'smelt init' },
  { id: 'hooks', title: 'wire the hooks preset', command: 'smelt hooks install' },
  { id: 'mcp', title: 'register the MCP server', command: SETUP_RECIPE.mcp.register },
  {
    id: 'verify',
    title: 'prove the round trip on a real file',
    command: `smelt <file> --budget ${SETUP_RECIPE.recommendedBudgetBytes} --focus <focus>`,
  },
];
