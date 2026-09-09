import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { CliUsageError } from '../errors.ts';
import { DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import {
  detectedHarnesses,
  planInstall,
  readIfExists,
  renderConfigWithHooks,
} from '../harness/plan.ts';
import type { HooksChoices, ManualStep } from '../harness/plan.ts';
import { applyPlanFiles } from './merge-policy.ts';
import { presetToggles, withToggleFlags } from './installed.ts';
import type { ToggleFlags } from './installed.ts';
import { confirmLoop, listPlannedFiles, walkSteps, wizardAsk } from './wizard.ts';
import type { Ask, Step } from './wizard.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
} from '../config.ts';
import type { SmeltConfig, SmeltConfigStore } from '../config.ts';
import { HARNESSES, harnessById } from '../harness/registry.ts';
import { locateStep, resolveScope, scopeRoot } from '../harness/scope.ts';
import type { InstallScope } from '../harness/scope.ts';
import type { HarnessProfile } from '../harness/profile.ts';
import { harnessLabel, TIER_HONESTY } from '../harness/profile.ts';
import { DirectoryElisionStore } from '../store-dir.ts';
import { createSmelter } from '../smelter.ts';
import { DEFAULT_STRATEGY } from '../plan/planners.ts';
import { SETUP_RECIPE } from '../setup/recipe.ts';
import { CLI_NAME, EXIT } from './shell.ts';
import type { AnswerStream } from './shell.ts';
import { countedFiles, doneBlock, lavaBanner, palette } from './lava.ts';

/**
 * `smelt setup` — the SetupRecipe (CONTEXT.md) applied end-to-end: config, the hooks
 * preset, the MCP registration step, and a real smelt → retrieve round trip to prove
 * the loop. The verb is `subcommands/setup.ts`; this file is the flow, a pure function
 * over an injected input/output pair — the `init`/`hooks` discipline, so the wizard is
 * guard-tested in-process and a renderer (KOT-253) slots in behind the same stream.
 *
 * The two paths share one apply path, because two apply paths would drift:
 *
 *   - `--yes` answers everything from the recipe: the budget it recommends (printed
 *     loudly, written only when the config lacks one — the `smelt` verb's own
 *     budget-required refusal is untouched), a directory store at the recipe's path
 *     when the config carries none, and the hooks preset's currently-installed
 *     defaults, read the same way `smelt hooks install` reads them.
 *   - interactive asks four questions, each with an Enter default, then confirms.
 *
 * The one hard rule is the merge policy `cli/merge-policy.ts` owns and both verbs apply
 * (`Consent`): an existing file is **merged**, never overwritten — every byte that is
 * not smelt's own rides through — and a file smelt would write *whole* is left alone
 * unless it is already smelt's, reported skipped with a reason naming it.
 * `smelt.config.json` is smelt's own file, written exactly once per run, and `setup`
 * says exactly what it added.
 *
 * Idempotent by construction: a re-run on a current machine plans `unchanged` for
 * every file, writes nothing, and exits 0.
 */

/** Where the flow's bytes come from and go. Injected, so guards run it in-process. */
export interface SetupIo {
  /**
   * Interactive input — the real stdin in `bin.ts`, a scripted stream in tests.
   * Required only for the interactive path; `--yes` never asks.
   */
  readonly input?: AnswerStream;
  readonly output: (text: string) => void;
  /** Where the recipe is applied: config discovery, hooks files, the store. */
  readonly cwd: string;
  /** The home directory, for harness detection. Defaults to the real one. */
  readonly home?: string;
  /** The release running setup — stamped into the instruction block for `smelt doctor`. */
  readonly version?: string;
  /** The lava renderer's switch — computed by the verb from CliIo, interactive-only. */
  readonly color?: boolean;
  /**
   * Whether the terminal's locale said it can render more than ASCII. The glyph set
   * (`✓ ✗ ⚠`), the closing block's rule and the banner's bar fall back to `+ x !` and
   * `-` where it did not. Absent means yes, which is what this wizard has always
   * printed. Computed once by `bin.ts`; see `lava.ts`'s `supportsUnicode`.
   */
  readonly unicode?: boolean;
}

/** Everything the verb resolved before the flow ran. Pure data, both paths. */
export interface SetupOptions {
  /** Validated harness ids — `--harness`, repeatable. Empty means none was named. */
  readonly harnessIds: readonly string[];
  readonly yes: boolean;
  readonly noMcp: boolean;
  readonly json: boolean;
  /**
   * This project, or this machine. Absent means detect: `user` when the working
   * directory *is* the home directory — the only way to get one config and one store
   * for every project, since config discovery walks up — and `project` otherwise. The
   * wizard states what detection found and lets you flip it.
   */
  readonly scope?: InstallScope;
  /**
   * The four hooks toggles as flags answered them. An absent one is not `off`: it
   * means leave it as the install found it, which is what `presetToggles` reads.
   * Both install verbs own these four and mean the same thing by them.
   */
  readonly toggles?: ToggleFlags;
}

/** One file's fate, as the receipt and the confirm listing both spell it. */
export interface SetupFileAction {
  readonly name: string;
  readonly action: 'written' | 'updated' | 'unchanged' | 'skipped';
  /** Why a file was skipped, or what an update added. */
  readonly detail?: string;
}

/** One verification result. A check states what it proved, not what it ran. */
export interface SetupCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** The machine receipt — `--json` with `--yes`. Everything the flow decided. */
export interface SetupReceipt {
  readonly format: 'smelt.setup.v1';
  readonly cwd: string;
  /** Which install this run applied. Always emitted; `project` is the old behaviour. */
  readonly scope: InstallScope;
  readonly config: { readonly action: 'written' | 'updated' | 'current' };
  readonly files: readonly SetupFileAction[];
  readonly mcp: {
    readonly status: 'applied' | 'manual' | 'skipped';
    /**
     * The first of {@link commands}, kept because it is what `smelt.setup.v1` has
     * always carried. A run wiring two registering harnesses says two things here, and
     * this field can only say one of them — read {@link commands} where it is present.
     */
    readonly command?: string;
    /**
     * Every registration this verdict is about, one per harness that carries one: what
     * was written (`applied`), or what is left to you (`manual`). Additive and
     * optional, so a reader of `smelt.setup.v1` that predates it sees the envelope it
     * knows — but a reader that only ever read `command` was told about codex and not
     * about opencode, and concluded opencode had not been registered.
     */
    readonly commands?: readonly string[];
  };
  readonly checks: readonly SetupCheck[];
  /**
   * What the flow decided that no file records — today, that a hook command had to be
   * written with a path an upgrade will delete. Additive and optional: absent when the
   * run had nothing to say, so a reader of `smelt.setup.v1` that predates it is not
   * looking at a changed envelope.
   */
  readonly notes?: readonly string[];
}

/** Everything the wizard or `--yes` decided. Pure data until apply. */
interface SetupChoices {
  harnesses: HarnessProfile[];
  budgetBytes: number | undefined;
  store: SmeltConfigStore | undefined;
  registerMcp: boolean;
  scope: InstallScope;
  /** What `--guard`/`--stats`/`--map`/`--lint` said, if anything. */
  toggles: ToggleFlags;
}

/**
 * The probe the round-trip check smelts: big enough that the probe budget forces
 * cuts, with one focus term that must survive. The lexical planner is deterministic,
 * so every machine that runs setup proves the same round trip.
 */
const PROBE_SOURCE: string = `${Array.from(
  { length: 40 },
  (_, i): string =>
    `export function helper${String(i)}(input: string): string {\n` +
    `  const trimmed = input.trim();\n` +
    `  return trimmed + " (${String(i)})";\n` +
    `}\n`,
).join('')}\nexport function renderTicket(id: string): string {\n  return 'ticket-' + id;\n}\n`;

const PROBE_BUDGET_BYTES = 600;

type Say = (text: string) => void;

/**
 * The flow, start to finish. Returns an exit code: 0 when every check passed, the
 * refused exit when one did not — a setup that cannot prove its own round trip is not
 * a finished setup, and an agent reading `--json` must be able to see that in the
 * exit code without parsing prose.
 */
export async function runSetup(options: SetupOptions, io: SetupIo): Promise<number> {
  const wizard = options.yes
    ? undefined
    : wizardAsk(
        io.input!,
        io.output,
        `${CLI_NAME} setup: input ended before the wizard finished. Nothing was ` +
          `written. Non-interactive:\n  ${CLI_NAME} setup --yes [--harness <id>]... ` +
          `[--no-mcp] [--json]`,
      );
  const ask: Ask =
    wizard?.ask ??
    (async () => {
      // --yes never asks; a question reached with no stream is a bug in the flow,
      // not an answer the user owes.
      throw new CliUsageError(
        `${CLI_NAME} setup: a question was reached with no interactive input — ` +
          `this is a bug in the flow, not an answer you owe.`,
      );
    });
  // Prose is suppressed in --json mode: the receipt is the whole output, the way the
  // other verbs' envelopes are. A machine parsing the receipt must not also parse
  // around it.
  const say: Say = (text) => {
    if (!options.json) io.output(text);
  };

  try {
    const choices: SetupChoices | undefined = options.yes
      ? await yesPath(options, io, say)
      : await wizardPath(options, io, say, ask);
    if (choices === undefined) return EXIT.ok; // declined at the confirm
    return await finish(choices, io, say, options);
  } finally {
    await wizard?.release();
  }
}

// ── the two decision paths ─────────────────────────────────────────────────────────

/** `--yes`: the recipe's answers, printed loudly — never silently assumed. */
async function yesPath(options: SetupOptions, io: SetupIo, say: Say): Promise<SetupChoices> {
  const scope = scopeOf(options, io);
  const choices: SetupChoices = {
    harnesses: options.harnessIds.map((id) => harnessById(id)!),
    budgetBytes: SETUP_RECIPE.recommendedBudgetBytes,
    store: { kind: 'directory', path: SETUP_RECIPE.store.defaultDir },
    registerMcp: !options.noMcp,
    scope,
    toggles: options.toggles ?? {},
  };
  say(
    `${CLI_NAME} setup — applying the recipe with --yes:\n` +
      `  ${scopeLine(scope, io)}\n` +
      `  budget: ${String(SETUP_RECIPE.recommendedBudgetBytes)} bytes (written only if ` +
      `the config carries none)\n` +
      `  store: directory at ${SETUP_RECIPE.store.defaultDir} (only if the config ` +
      `carries none; an explicit store is respected)\n` +
      `  hooks preset: ${
        choices.harnesses.length === 0
          ? 'no harness (none named — config only)'
          : choices.harnesses.map((profile) => profile.id).join(', ')
      }, toggles as installed then as --guard/--stats/--map/--lint named\n` +
      `  an existing file is merged, never overwritten; one smelt writes whole is ` +
      `left alone unless it is already smelt's\n`,
  );
  return choices;
}

/** Interactive: four questions, each with an Enter default, then one confirm. */
async function wizardPath(
  options: SetupOptions,
  io: SetupIo,
  say: Say,
  ask: Ask,
): Promise<SetupChoices | undefined> {
  say(lavaBanner('smelt setup', io.color === true, io.unicode !== false));
  say(
    `\n${CLI_NAME} setup — one command through the whole recipe. Enter accepts every ` +
      `default; nothing is written until the final confirm.\n\n`,
  );

  const choices: SetupChoices = {
    harnesses: options.harnessIds.map((id) => harnessById(id)!),
    budgetBytes: undefined,
    store: undefined,
    registerMcp: true,
    scope: scopeOf(options, io),
    toggles: options.toggles ?? {},
  };
  const detected = choices.scope;

  // Budget: the config's own if it carries one, else the recipe's recommendation —
  // Enter is always an answer here, which is the difference from `init`, whose
  // confirm refuses to proceed without a budget someone typed.
  //
  // Read **when the question is asked**, not when the steps are built: the scope step
  // runs first and can flip the answer, and `~/smelt.config.json` and the project's are
  // two different files with two different budgets. Offering the machine's number as
  // the Enter default for a project install is offering a number from a file this run
  // will not touch.
  const budgetDefault = (): number => {
    const configPath = setupConfigPath(io, choices.scope);
    const existingText = readIfExists(configPath);
    const existing = existingText === undefined ? undefined : parseConfig(existingText, configPath);
    return existing?.defaultBudgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes;
  };

  // The wizard kit's step machine, so back is real back: harnesses ← budget ← store
  // ← mcp, each step returning to the one before it (the first says so).
  const steps: readonly Step[] = [
    // The scope question is asked only when detection picked `user`: from any other
    // directory `project` is the only reading that makes sense, and a question whose
    // answer is already certain is a question that trains people to hit Enter.
    async (a) =>
      options.scope !== undefined || detected === 'project'
        ? 'ok'
        : await stepScope(say, a, choices, io),
    async (a) => {
      if (options.harnessIds.length > 0) {
        for (const profile of choices.harnesses) say(`  ${tierLine(profile)}\n`);
        return 'ok';
      }
      await stepHarnesses(say, a, choices, detectedHarnesses(io.cwd, io.home ?? homedir()));
      return 'ok';
    },
    async (a) => await stepBudget(say, a, choices, budgetDefault()),
    async (a) => await stepStore(say, a, choices),
    async (a) => await stepMcp(say, a, choices),
  ];
  await walkSteps(steps, ask, say);
  for (;;) {
    const verdict = await confirm(say, ask, choices, io);
    if (verdict === 'done') return choices;
    if (verdict === 'declined') {
      say(`Nothing was written.\n`);
      return undefined;
    }
    // A confirm's back lands on the last step — and from there, real back.
    await walkSteps(steps, ask, say, steps.length - 1);
  }
}

/**
 * The one scope question, asked only where detection said `user` — i.e. from the home
 * directory itself. It states what was detected and why, and Enter takes it.
 */
async function stepScope(
  say: Say,
  ask: Ask,
  choices: SetupChoices,
  io: SetupIo,
): Promise<'ok' | 'back'> {
  say(
    `\nYou are in your home directory, so this looks like a **machine-wide** install:\n` +
      `  ${scopeLine('user', io)}\n` +
      `  every project on this machine then finds one ${CONFIG_FILE_NAME} and one store.\n` +
      `A project install writes into ${io.cwd} instead, and only that project sees it.\n`,
  );
  for (;;) {
    const answer = await ask(`scope (1 machine / 2 project) [1]> `);
    if (answer === 'back') return 'back';
    if (answer === '' || answer === '1') {
      choices.scope = 'user';
      return 'ok';
    }
    if (answer === '2') {
      choices.scope = 'project';
      return 'ok';
    }
    say(`1 for this machine, 2 for this project.\n`);
  }
}

/** Budget, with the config's or the recipe's number as the Enter default. */
async function stepBudget(
  say: Say,
  ask: Ask,
  choices: SetupChoices,
  budgetDefault: number,
): Promise<'ok' | 'back'> {
  for (;;) {
    const answer = await ask(`default budget in bytes [${String(budgetDefault)}]> `);
    if (answer === 'back') return 'back';
    if (answer === '') {
      choices.budgetBytes = budgetDefault;
      return 'ok';
    }
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.budgetBytes = Number(answer);
      return 'ok';
    }
    say(`A whole number of bytes greater than zero, e.g. ${String(budgetDefault)}.\n`);
  }
}

// ── the questions ───────────────────────────────────────────────────────────────────

async function stepHarnesses(
  say: Say,
  ask: Ask,
  choices: SetupChoices,
  detected: readonly HarnessProfile[],
): Promise<'ok' | 'back'> {
  const all = [...HARNESSES];
  say(`Harnesses to wire with the guard preset:\n`);
  all.forEach((profile, index) => {
    const mark = detected.some((one) => one.id === profile.id) ? ' (detected)' : '';
    say(`  ${String(index + 1)}. ${tierLine(profile)}${mark}\n`);
  });
  const detectedNote =
    detected.length === 0
      ? 'none detected — Enter means config only'
      : `Enter for detected: ${detected.map((profile) => profile.id).join(', ')}`;
  for (;;) {
    const answer = await ask(`numbers, 'all', or Enter (${detectedNote})> `);
    if (answer === 'back') return 'back'; // the step machine answers it
    if (answer === '') {
      choices.harnesses = [...detected];
      return 'ok';
    }
    if (answer === 'all') {
      choices.harnesses = all;
      return 'ok';
    }
    if (/^\d+(?:\s*,\s*\d+)*$/u.test(answer)) {
      const picked = answer.split(',').map((piece) => Number(piece.trim()));
      if (picked.every((n) => n >= 1 && n <= all.length)) {
        choices.harnesses = [...new Set(picked)].map((n) => all[n - 1]!);
        return 'ok';
      }
    }
    say(`A comma-separated list of the numbers above, 'all', or Enter.\n`);
  }
}

async function stepStore(say: Say, ask: Ask, choices: SetupChoices): Promise<'ok' | 'back'> {
  say(
    `\nWhere elided bytes live. Every elision is reversible only while a store holds ` +
      `its bytes (Law 3). An explicit store already in the config is respected.\n`,
  );
  for (;;) {
    const answer = await ask(`store (1 memory / 2 directory) [2]> `);
    if (answer === 'back') return 'back';
    if (answer === '' || answer === '2') {
      const pathDefault =
        choices.store?.kind === 'directory' ? choices.store.path : SETUP_RECIPE.store.defaultDir;
      const path = await ask(`store directory, relative to ${CONFIG_FILE_NAME} [${pathDefault}]> `);
      if (path === 'back') continue;
      choices.store = { kind: 'directory', path: path === '' ? pathDefault : path };
      return 'ok';
    }
    if (answer === '1') {
      choices.store = { kind: 'memory' };
      return 'ok';
    }
    say(`1 for memory, 2 for directory.\n`);
  }
}

async function stepMcp(say: Say, ask: Ask, choices: SetupChoices): Promise<'ok' | 'back'> {
  for (;;) {
    const answer = await ask(`register the MCP server? (1 yes — prints the command / 2 no) [1]> `);
    if (answer === 'back') return 'back';
    if (answer === '' || answer === '1') {
      choices.registerMcp = true;
      return 'ok';
    }
    if (answer === '2') {
      choices.registerMcp = false;
      return 'ok';
    }
    say(`1 to include the MCP step, 2 to skip it.\n`);
  }
}

type ConfirmVerdict = 'done' | 'declined' | 'back';

async function confirm(
  say: Say,
  ask: Ask,
  choices: SetupChoices,
  io: SetupIo,
): Promise<ConfirmVerdict> {
  const plan =
    choices.harnesses.length === 0
      ? undefined
      : planInstall(io.cwd, hooksChoices(choices, io.cwd, io.version, io));
  say(`\nAbout to apply, into ${setupRoot(io, choices.scope)}:\n`);
  say(
    `  ${CONFIG_FILE_NAME.padEnd(32)} (budget ` +
      `${String(choices.budgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes)}, strategy ` +
      `default, store ${describeStore(choices.store)})\n`,
  );
  if (plan === undefined) {
    say(`  no harness selected — the guard preset is skipped\n`);
  } else {
    listPlannedFiles(
      say,
      plan.files.filter((file) => basename(file.path) !== CONFIG_FILE_NAME),
      plan.skipped,
      fileFate,
    );
  }
  const { mcp } = mcpVerdict(choices, plan?.manual ?? [], io);
  // Every registration, not the first of them: a run wiring two registering harnesses
  // was about to name one and leave the reader to guess about the other.
  const listed = mcpCommandList(mcp).join('; ');
  say(
    `  mcp ${
      mcp.status === 'skipped'
        ? '(skipped)'
        : mcp.status === 'applied'
          ? `(applied beside your existing servers: ${listed})`
          : `(manual step: ${listed})`
    }\nNothing has been written yet.\n`,
  );
  const confirmed = await confirmLoop(
    ask,
    'yes to apply, no to leave everything untouched, back to change a step.',
  );
  if (confirmed === 'back') return 'back';
  return confirmed === 'yes' ? 'done' : 'declined';
}

// ── the one apply path ──────────────────────────────────────────────────────────────

/** Everything one apply decided, as data — the receipt before it is rendered. */
interface ApplyOutcome {
  readonly receipt: Omit<SetupReceipt, 'format' | 'cwd'>;
  readonly notes: readonly string[];
  readonly failedChecks: number;
  /**
   * True when a `manual` MCP verdict means "no selected harness carries a registration
   * this preset knows how to write" rather than "the file is the harness's own". The
   * receipt carries the command either way; only the prose distinguishes them, because
   * only a reader needs to know which of the two it is looking at.
   */
  readonly manualFromProfile: boolean;
}

/**
 * The one apply path: config, hooks preset, MCP verdict, checks. Decides and writes;
 * renders nothing — the prose and the JSON receipt are two adapters over the outcome,
 * which is the seam the lava renderer (KOT-253) slots in behind.
 */
async function applySetup(choices: SetupChoices, io: SetupIo): Promise<ApplyOutcome> {
  const files: SetupFileAction[] = [];
  const notes: string[] = [];

  // ── config first: the hooks plan reads the settled bytes back, so a second run
  //    plans the same file as `unchanged` instead of chasing its own tail ──
  const configPath = setupConfigPath(io, choices.scope);
  const before = readIfExists(configPath);
  const existing = before === undefined ? undefined : parseConfig(before, configPath);
  const budget =
    existing?.defaultBudgetBytes ?? choices.budgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes;
  const store = existing?.store ?? choices.store;
  const next: SmeltConfig = {
    ...existing,
    smeltConfig: CONFIG_VERSION,
    defaultBudgetBytes: budget,
    strategy: existing?.strategy ?? DEFAULT_STRATEGY,
    ...(store === undefined ? {} : { store }),
  };
  // The hooks preset's choices are settled *before* the config is written, because
  // the config is written **once**: with the guard's hooks block when a harness was
  // named, without it when none was. The installer plans the same file from the same
  // choices, so its entry for it comes back `unchanged` — and setup drops it from the
  // apply below rather than reporting one file twice, once as written and again as
  // repaired, which is what a fresh `--json` run used to say.
  const hooks =
    choices.harnesses.length === 0 ? undefined : hooksChoices(choices, io.cwd, io.version, io);
  const rendered =
    hooks === undefined
      ? renderConfig(next)
      : renderConfigWithHooks(next, {
          thresholdBytes: hooks.thresholdBytes,
          enforcement: hooks.enforcement,
        });
  let configAction: SetupReceipt['config']['action'];
  if (before === undefined) {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, rendered);
    configAction = 'written';
    files.push({ name: CONFIG_FILE_NAME, action: 'written' });
  } else if (before !== rendered) {
    writeFileSync(configPath, rendered);
    configAction = 'updated';
    files.push({
      name: CONFIG_FILE_NAME,
      action: 'updated',
      detail: 'filled the fields the config lacked (budget, strategy default, store)',
    });
  } else {
    configAction = 'current';
    files.push({ name: CONFIG_FILE_NAME, action: 'unchanged' });
  }

  // ── hooks preset: the installer's own plan, over the settled config. The plan's
  //    config entry rides too — renderConfigWithHooks adds the hooks block the shims
  //    read, so setup and hooks install leave the same file, and a re-run plans
  //    `unchanged` for it. ──
  const plan = hooks === undefined ? undefined : planInstall(io.cwd, hooks);
  if (plan !== undefined) {
    // One merge policy, one apply loop, shared with `smelt hooks install` — see
    // `Consent` in cli/merge-policy.ts. Setup has nobody to ask; it consents by policy:
    // a file whose planned content was merged out of the existing bytes is written
    // (nothing of anybody's is lost), and one smelt would write *whole* is refused
    // unless it is already ours.
    const applied = await applyPlanFiles(
      // The config was written above, from the same choices this plan was built
      // from. Reporting the plan's entry for it too would name one file twice.
      plan.files.filter((file) => basename(file.path) !== CONFIG_FILE_NAME),
      { kind: 'policy' },
    );
    for (const file of applied) {
      files.push({
        name: file.name,
        action: file.action,
        ...(file.detail === undefined ? {} : { detail: file.detail }),
      });
    }
    notes.push(...plan.notes);
    for (const skip of plan.skipped) {
      files.push({ name: skip.name, action: 'skipped', detail: skip.why });
    }
    for (const step of plan.manual) {
      notes.push(
        `${step.harness}: ${step.name} is ${step.harness}'s to write — run: ${step.command}`,
      );
    }
  }

  // ── mcp: applied where a profile carries either registration step (JSON or TOML),
  //    handed over as the exact command where none does (no harness named, or a
  //    harness whose registration this preset does not yet know) — never pretending
  //    it ran something it did not ──
  const { mcp, fromProfile: manualFromProfile } = mcpVerdict(choices, plan?.manual ?? [], io);

  // ── verify: the checks that make "set up" a claim with evidence ──
  const checks: SetupCheck[] = [];
  const afterText = readIfExists(configPath);
  const after = afterText === undefined ? undefined : parseConfig(afterText, configPath);
  checks.push({
    name: 'config parses',
    ok: after?.smeltConfig === CONFIG_VERSION,
    detail: `${CONFIG_FILE_NAME} read back and parsed`,
  });
  const storeDir =
    after?.store?.kind === 'directory' ? join(dirname(configPath), after.store.path) : undefined;
  if (storeDir === undefined) {
    checks.push({
      name: 'round trip',
      ok: true,
      detail: 'memory store — per-process by choice; retrieval works inside one process',
    });
  } else {
    checks.push(...(await probeStore(storeDir, budget)));
  }

  const failedChecks = checks.filter((check) => !check.ok).length;
  return {
    manualFromProfile,
    receipt: {
      scope: choices.scope,
      config: { action: configAction },
      files,
      mcp,
      checks,
      ...(notes.length === 0 ? {} : { notes }),
    },
    notes,
    failedChecks,
  };
}

/** The prose renderer — one adapter over the outcome. */
function renderOutcome(outcome: ApplyOutcome, say: Say, unicode: boolean): boolean {
  const { receipt } = outcome;
  const { files, mcp, checks } = receipt;
  const ok = outcome.failedChecks === 0;
  // Plain on purpose: the marks and the rule are *drawn* here and *painted* at the
  // verb's sink, which is where a wizard's colour has always been decided. What this
  // palette decides is the glyph set — `✓` or `+`, `━` or `-`.
  const lava = palette({ unicode });

  for (const file of files) {
    say(`  ${file.name}: ${file.action}${file.detail === undefined ? '' : ` — ${file.detail}`}\n`);
  }
  for (const note of outcome.notes) say(`note: ${note}\n`);
  if (mcp.status === 'applied') {
    say(
      `MCP registration: written to the harness configs beside any servers you already ` +
        `had — \`smelt hooks remove\` takes it back out.\n`,
    );
  }
  if (mcp.status === 'manual') {
    // Two different manuals, and the reason is what the reader needs. Either no
    // selected harness carries a registration this preset knows how to write — the
    // sentence this line has always carried — or one does and the file is the
    // harness's own to rewrite, which the receipt's own command already names.
    say(
      `MCP registration stays in your hands` +
        `${outcome.manualFromProfile ? ' (no selected harness carries it)' : ''}:\n` +
        mcpCommandList(mcp)
          .map((command) => `  ${command}\n`)
          .join('') +
        `packages/mcp/README.md has the mechanism for every harness surveyed.\n`,
    );
  }
  for (const check of checks) {
    say(` ${lava.glyph(check.ok ? 'ok' : 'bad')} ${check.name} — ${check.detail}\n`);
  }

  // The closing block, and the only place this flow states a total. Both halves are
  // counted off what was applied and what was proven — never off the plan, and never
  // off the recipe.
  const passed = checks.filter((check) => check.ok).length;
  say(
    doneBlock(
      {
        ok,
        what: `${CLI_NAME} setup`,
        summary: `${countedFiles(
          files.map((file) => file.action),
          lava,
        )}; ${String(passed)} of ${String(checks.length)} checks passed`,
        ...(ok
          ? {}
          : {
              note:
                `A check did not pass ${lava.dash()} the lines above say which, ` +
                `and this run exits non-zero.`,
            }),
        next: [
          [`${CLI_NAME} doctor`, 'read back what was written, and what is behind'],
          [
            `${CLI_NAME} <file> --budget 4000`,
            `smelt one file ${lava.dash()} the report says what went`,
          ],
          [`${CLI_NAME} stats`, 'the store, once a run has put something in it'],
        ],
      },
      lava,
    ),
  );

  return ok;
}

/**
 * Every command a verdict names, for a renderer — {@link SetupReceipt.mcp}'s list where
 * it has one, its single `command` otherwise. One reading, so the confirm summary and
 * the outcome prose cannot disagree about how many registrations a run is about.
 */
function mcpCommandList(mcp: SetupReceipt['mcp']): readonly string[] {
  if (mcp.commands !== undefined) return mcp.commands;
  return mcp.command === undefined ? [] : [mcp.command];
}

/** finish: apply once, render twice — prose for humans, the receipt for machines. */
async function finish(
  choices: SetupChoices,
  io: SetupIo,
  say: Say,
  options: SetupOptions,
): Promise<number> {
  const outcome = await applySetup(choices, io);
  const ok = renderOutcome(outcome, say, io.unicode !== false);
  if (options.json) {
    const receipt: SetupReceipt = {
      format: 'smelt.setup.v1',
      cwd: io.cwd,
      ...outcome.receipt,
    };
    io.output(JSON.stringify(receipt, null, 2) + '\n');
  }
  return ok ? EXIT.ok : EXIT.refused;
}

/**
 * The flow's own probe, split where honesty demanded it: the **real** store directory
 * is proven creatable and writable with a scratch file that is removed again — the
 * user's counters stay untouched — and the elide → retrieve round trip runs against a
 * **disposable** store beside it, deleted with the check. The first version of this
 * probe ran the round trip in the production store: its blobs and its one retrieval
 * are permanent (a store that can forget is not reversible), so a fresh machine's
 * first `smelt stats` would have reported setup's probe as the user's work — noise in
 * the exact honest signal the product leads with.
 */
async function probeStore(storeDir: string, budget: number): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = [];
  try {
    mkdirSync(storeDir, { recursive: true });
    const scratch = join(storeDir, '.setup-probe-writable');
    writeFileSync(scratch, 'writable');
    rmSync(scratch, { force: true });
    checks.push({
      name: 'store writable',
      ok: true,
      detail: `${storeDir} accepts and removes a scratch file`,
    });
  } catch (error) {
    checks.push({
      name: 'store writable',
      ok: false,
      detail: `${storeDir} is not writable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return checks; // the round trip cannot prove more than this
  }

  const disposable = mkdtempSync(join(tmpdir(), 'smelt-setup-probe-'));
  try {
    const store = new DirectoryElisionStore(disposable);
    const smelter = createSmelter({ store });
    const result = await smelter.smelt(PROBE_SOURCE, {
      path: 'setup-probe.ts',
      focus: ['renderTicket'],
      budgetBytes: Math.min(budget, PROBE_BUDGET_BYTES),
    });
    if (result.elisions.length === 0) {
      checks.push({
        name: 'round trip',
        ok: false,
        detail: `the probe produced no elisions at a ${String(PROBE_BUDGET_BYTES)}-byte budget`,
      });
      return checks;
    }
    const first = result.elisions[0]!;
    const original = PROBE_SOURCE.slice(first.range.start, first.range.end);
    const back = store.retrieve(first.hash);
    checks.push({
      name: 'round trip',
      ok: back === original,
      detail:
        back === original
          ? `${String(result.elisions.length)} elisions under the budget; the first cut's ` +
            `${String(first.range.end - first.range.start)} bytes retrieved byte-identical, in a throwaway store`
          : 'the store returned different bytes than were elided',
    });
    return checks;
  } finally {
    rmSync(disposable, { recursive: true, force: true });
  }
}

// ── small shared pieces ─────────────────────────────────────────────────────────────

function hooksChoices(
  choices: SetupChoices,
  cwd: string,
  version: string | undefined,
  io: SetupIo,
): HooksChoices {
  const home = io.home ?? homedir();
  return {
    harnesses: choices.harnesses,
    ...(version === undefined ? {} : { writtenBy: version }),
    // Read off what is actually installed, falling back to the installer's defaults
    // when nothing of smelt's is on disk — the same "edit, never reset" reading the
    // hooks installer itself uses — then whatever the four toggle flags named. No
    // second copy of the defaults, and no second reading of the flags, lives here.
    ...withToggleFlags(presetToggles(cwd, { scope: choices.scope, home }), choices.toggles),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
    scope: choices.scope,
    home,
  };
}

/** The scope this run applies: what the caller named, else what detection found. */
function scopeOf(options: SetupOptions, io: SetupIo): InstallScope {
  return resolveScope(options.scope, { cwd: io.cwd, home: io.home ?? homedir() });
}

/** The directory this scope's files live under. */
function setupRoot(io: SetupIo, scope: InstallScope): string {
  return scopeRoot(scope, { cwd: io.cwd, home: io.home ?? homedir() });
}

/**
 * Where the config goes. At project scope it is *discovered* — the nearest one above
 * the project wins, which is what lets a monorepo carry one. At user scope it is
 * *decided*: `~/smelt.config.json`, the file every project below finds by walking up,
 * with the recipe's directory store under it at `~/.smelt/store`.
 */
function setupConfigPath(io: SetupIo, scope: InstallScope): string {
  const root = setupRoot(io, scope);
  if (scope === 'user') return join(root, CONFIG_FILE_NAME);
  return findConfigFile(io.cwd) ?? join(io.cwd, CONFIG_FILE_NAME);
}

/** The one line setup prints about where it is applying, at either scope. */
function scopeLine(scope: InstallScope, io: SetupIo): string {
  const root = setupRoot(io, scope);
  return scope === 'user'
    ? `scope: this machine — ${join(root, CONFIG_FILE_NAME)}, store at ` +
        `${join(root, SETUP_RECIPE.store.defaultDir)}, harness files at their ` +
        `documented user-level locations`
    : `scope: this project — ${root}`;
}

/**
 * The MCP verdict, read off the plan rather than off the profile list.
 *
 * A profile carrying an mcp step does not mean *this scope* writes it: Claude Code's
 * user-scope registration lives in a file Claude Code owns, so at user scope the step
 * is a printed command. Reading the profile alone would have the receipt say `applied`
 * for a registration nobody performed — the receipt lying in the direction that costs
 * the agent a working MCP server.
 */
/** An MCP registration step, either spelling of it. */
function isMcpStep(step: { readonly kind: string }): boolean {
  return step.kind === 'mcp-registration' || step.kind === 'toml-mcp-registration';
}

function mcpVerdict(
  choices: SetupChoices,
  manual: readonly ManualStep[],
  io: SetupIo,
): { readonly mcp: SetupReceipt['mcp']; readonly fromProfile: boolean } {
  if (!choices.registerMcp) return { mcp: { status: 'skipped' }, fromProfile: false };
  const roots = { cwd: io.cwd, home: io.home ?? homedir() };

  // `applied` wins, and that order is the ruling: a run that wrote *any* registration
  // has applied one, whatever else it also handed over. `--scope user --harness
  // claude-code --harness codex` writes codex's TOML table and prints Claude Code's
  // command; calling the whole run `manual` would tell an agent to go and do by hand
  // something setup already did. The command it could not write stays in `notes`, per
  // step, with the harness that asked for it.
  //
  // "Written" is asked of the resolver, not of the profile: a step with a documented
  // user-level location that is the harness's own file to rewrite has a path and is
  // still not ours to write.
  const applied = choices.harnesses.filter((profile) =>
    profile.install.some((step) => {
      if (!isMcpStep(step)) return false;
      const located = locateStep(step, choices.scope, { ...roots, harness: profile.name });
      return located.path !== undefined && located.manual === undefined;
    }),
  );
  if (applied.length > 0) {
    return {
      mcp: mcpVerdictCommands(
        'applied',
        applied.map((profile) => mcpManual(profile, choices.scope)),
      ),
      fromProfile: false,
    };
  }
  const manualMcp = manual.filter(isMcpStep);
  // Two different manuals: a location that is the harness's own to rewrite (the step
  // carries the command), or no selected harness carrying a registration this preset
  // knows how to write at all — which is the older of the two, and the one whose
  // sentence the prose has always said out loud. The second one names no harness, so
  // it names none: the plain stdio command any MCP client registers, not one harness's
  // CLI verb printed at somebody who is not using that harness.
  return manualMcp.length === 0
    ? { mcp: mcpVerdictCommands('manual', [SETUP_RECIPE.mcp.run]), fromProfile: true }
    : {
        mcp: mcpVerdictCommands(
          'manual',
          manualMcp.map((step) => step.command),
        ),
        fromProfile: false,
      };
}

/**
 * The verdict as the receipt carries it: every command it is about, and the first of
 * them again under `command`, which is the field `smelt.setup.v1` has always had and
 * cannot be allowed to change meaning. Two harnesses that spell the same registration
 * the same way are one line, not two — the list is what a reader acts on.
 */
function mcpVerdictCommands(
  status: 'applied' | 'manual',
  commands: readonly string[],
): SetupReceipt['mcp'] {
  const unique = [...new Set(commands)];
  /* v8 ignore next -- unreachable: every caller passes at least one command */
  if (unique[0] === undefined) return { status };
  return { status, command: unique[0], commands: unique };
}

/**
 * How **this** harness's registration is performed by hand, at this scope — the
 * profile's own fact (CONTEXT.md, **HarnessProfile**), not the recipe's Claude Code
 * command printed at everybody. A harness carrying a registration step carries this
 * too; `test/guards/setup-recipe.test.ts` pins the pair, and pins each one against
 * the section `packages/mcp/README.md` gives it.
 */
function mcpManual(profile: HarnessProfile, scope: InstallScope): string {
  const manual = profile.mcp;
  /* v8 ignore next -- unreachable: pinned by test/guards/setup-recipe.test.ts */
  if (manual === undefined) return SETUP_RECIPE.mcp.run;
  return scope === 'user' ? (manual.manualUser ?? manual.manual) : manual.manual;
}

function tierLine(profile: HarnessProfile): string {
  return `${profile.id.padEnd(12)} ${harnessLabel(profile).padEnd(16)} [${profile.tier}] — ${
    TIER_HONESTY[profile.tier]
  }`;
}

function describeStore(store: SmeltConfigStore | undefined): string {
  if (store === undefined) return 'none (the config keeps whatever it has)';
  return store.kind === 'memory' ? 'memory' : `directory at ${store.path}`;
}

function fileFate(file: {
  readonly name: string;
  readonly exists: boolean;
  readonly unchanged: boolean;
}): string {
  if (file.unchanged) return 'unchanged — nothing to write';
  if (file.exists) return 'exists — will be skipped, not overwritten';
  return 'new';
}
