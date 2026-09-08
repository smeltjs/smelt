import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { CliUsageError } from '../errors.ts';
import { DEFAULT_THRESHOLD_BYTES } from '../hooks/guard-core.ts';
import { detectedHarnesses, planInstall, presetToggles } from './hooks.ts';
import { fileIsOurs } from './installed.ts';
import { confirmLoop, listPlannedFiles, walkSteps, wizardAsk } from './wizard.ts';
import type { Ask, Step } from './wizard.ts';
import type { HooksChoices } from './hooks.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
} from './config.ts';
import type { SmeltConfig, SmeltConfigStore } from './config.ts';
import { HARNESSES, harnessById } from '../harness/registry.ts';
import type { HarnessProfile } from '../harness/profile.ts';
import { harnessLabel, TIER_HONESTY } from '../harness/profile.ts';
import { DirectoryElisionStore } from '../store-dir.ts';
import { createSmelter } from '../smelter.ts';
import { DEFAULT_STRATEGY } from '../plan/planners.ts';
import { SETUP_RECIPE } from '../setup/recipe.ts';
import { CLI_NAME, EXIT } from './shell.ts';
import type { AnswerStream } from './shell.ts';
import { lavaBanner } from './lava.ts';

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
 * The one hard rule is inherited unchanged from `init` and `hooks`: an existing file
 * that is not smelt's own config is never written — not by `--yes`, not by a wizard
 * answer. It is skipped with a note pointing at `smelt hooks install`, which asks per
 * file. `smelt.config.json` is smelt's own file; `setup` updates it and says exactly
 * what it added.
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
}

/** Everything the verb resolved before the flow ran. Pure data, both paths. */
export interface SetupOptions {
  /** Validated harness ids — `--harness`, repeatable. Empty means none was named. */
  readonly harnessIds: readonly string[];
  readonly yes: boolean;
  readonly noMcp: boolean;
  readonly json: boolean;
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
  readonly config: { readonly action: 'written' | 'updated' | 'current' };
  readonly files: readonly SetupFileAction[];
  readonly mcp: {
    readonly status: 'applied' | 'manual' | 'skipped';
    /** The recipe's registration command — what was written, or what is left to you. */
    readonly command?: string;
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

function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

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
  const choices: SetupChoices = {
    harnesses: options.harnessIds.map((id) => harnessById(id)!),
    budgetBytes: SETUP_RECIPE.recommendedBudgetBytes,
    store: { kind: 'directory', path: SETUP_RECIPE.store.defaultDir },
    registerMcp: !options.noMcp,
  };
  say(
    `${CLI_NAME} setup — applying the recipe with --yes:\n` +
      `  budget: ${String(SETUP_RECIPE.recommendedBudgetBytes)} bytes (written only if ` +
      `the config carries none)\n` +
      `  store: directory at ${SETUP_RECIPE.store.defaultDir} (only if the config ` +
      `carries none; an explicit store is respected)\n` +
      `  hooks preset: current defaults for ${
        choices.harnesses.length === 0
          ? 'no harness (none named — config only)'
          : choices.harnesses.map((profile) => profile.id).join(', ')
      }\n` +
      `  existing files are never overwritten — skipped with a note\n`,
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
  say(lavaBanner('smelt setup', io.color === true));
  say(
    `\n${CLI_NAME} setup — one command through the whole recipe. Enter accepts every ` +
      `default; nothing is written until the final confirm.\n\n`,
  );

  const choices: SetupChoices = {
    harnesses: options.harnessIds.map((id) => harnessById(id)!),
    budgetBytes: undefined,
    store: undefined,
    registerMcp: true,
  };

  // Budget: the config's own if it carries one, else the recipe's recommendation —
  // Enter is always an answer here, which is the difference from `init`, whose
  // confirm refuses to proceed without a budget someone typed.
  const configPath = findConfigFile(io.cwd) ?? join(io.cwd, CONFIG_FILE_NAME);
  const existingText = readIfExists(configPath);
  const existing = existingText === undefined ? undefined : parseConfig(existingText, configPath);
  const budgetDefault = existing?.defaultBudgetBytes ?? SETUP_RECIPE.recommendedBudgetBytes;

  // The wizard kit's step machine, so back is real back: harnesses ← budget ← store
  // ← mcp, each step returning to the one before it (the first says so).
  const steps: readonly Step[] = [
    async (a) => {
      if (options.harnessIds.length > 0) {
        for (const profile of choices.harnesses) say(`  ${tierLine(profile)}\n`);
        return 'ok';
      }
      await stepHarnesses(say, a, choices, detectedHarnesses(io.cwd, io.home ?? homedir()));
      return 'ok';
    },
    async (a) => await stepBudget(say, a, choices, budgetDefault),
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
      : planInstall(io.cwd, hooksChoices(choices, io.cwd, io.version));
  say(`\nAbout to apply, into ${io.cwd}:\n`);
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
  const mcpApplied = choices.harnesses.some((profile) =>
    profile.install.some(
      (step) => step.kind === 'mcp-registration' || step.kind === 'toml-mcp-registration',
    ),
  );
  say(
    `  mcp ${
      !choices.registerMcp
        ? '(skipped)'
        : mcpApplied
          ? `(applied beside your existing servers: ${SETUP_RECIPE.mcp.register})`
          : `(manual step: ${SETUP_RECIPE.mcp.register})`
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
  const configPath = findConfigFile(io.cwd) ?? join(io.cwd, CONFIG_FILE_NAME);
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
  const rendered = renderConfig(next);
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
  const plan =
    choices.harnesses.length === 0
      ? undefined
      : planInstall(io.cwd, hooksChoices(choices, io.cwd, io.version));
  if (plan !== undefined) {
    for (const file of plan.files) {
      if (file.unchanged) {
        files.push({ name: file.name, action: 'unchanged' });
        continue;
      }
      if (!file.exists) {
        mkdirSync(dirname(file.path), { recursive: true });
        writeFileSync(file.path, file.content);
        if (file.mode !== undefined) chmodSync(file.path, file.mode);
        files.push({ name: file.name, action: 'written' });
        continue;
      }
      if (fileIsOursToRepair(file)) {
        // Repair, not consent: this file already carries smelt's own entries, and
        // every byte the plan would change is inside them — a marker-block upsert,
        // a strip-merge of our hook entries, a nested edit of our server entry.
        // That is the doctor → setup loop actually closing: a block written by an
        // older release is brought to this one.
        writeFileSync(file.path, file.content);
        if (file.mode !== undefined) chmodSync(file.path, file.mode);
        files.push({
          name: file.name,
          action: basename(file.path) === CONFIG_FILE_NAME ? 'updated' : 'written',
          detail: "repaired — only smelt's own entries in it changed",
        });
        continue;
      }
      // The hard rule, inherited: an existing file with nothing of smelt's in it is
      // never written — not by --yes, not by a wizard answer. Point at the editor.
      files.push({
        name: file.name,
        action: 'skipped',
        detail: 'exists — not overwritten; `smelt hooks install` edits it and asks per file',
      });
    }
    notes.push(...plan.notes);
  }

  // ── mcp: applied where a profile carries either registration step (JSON or TOML),
  //    handed over as the exact command where none does (no harness named, or a
  //    harness whose registration this preset does not yet know) — never pretending
  //    it ran something it did not ──
  const mcpApplied = choices.harnesses.some((profile) =>
    profile.install.some(
      (step) => step.kind === 'mcp-registration' || step.kind === 'toml-mcp-registration',
    ),
  );
  const mcp: SetupReceipt['mcp'] = !choices.registerMcp
    ? { status: 'skipped' }
    : mcpApplied
      ? { status: 'applied', command: SETUP_RECIPE.mcp.register }
      : { status: 'manual', command: SETUP_RECIPE.mcp.register };

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
    receipt: {
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
function renderOutcome(outcome: ApplyOutcome, say: Say): boolean {
  const { receipt } = outcome;
  const { files, mcp, checks } = receipt;
  const ok = outcome.failedChecks === 0;

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
    say(
      `MCP registration stays in your hands (no selected harness carries it):\n` +
        `  ${mcp.command}\n` +
        `packages/mcp/README.md has the mechanism for every harness surveyed.\n`,
    );
  }
  for (const check of checks) {
    say(`${check.ok ? ' ✓' : ' ✗'} ${check.name} — ${check.detail}\n`);
  }

  return ok;
}

/** finish: apply once, render twice — prose for humans, the receipt for machines. */
async function finish(
  choices: SetupChoices,
  io: SetupIo,
  say: Say,
  options: SetupOptions,
): Promise<number> {
  const outcome = await applySetup(choices, io);
  const ok = renderOutcome(outcome, say);
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

/**
 * Whether an existing planned file is smelt's to repair. The config is smelt's own;
 * every other file is ours exactly when it already carries our entries — the marker
 * token in text, or our hook entries in a JSON hooks file (the guard command carries
 * no token, hence the entry-level predicate). A file with nothing of ours in it is
 * somebody else's, and consent — not --yes — is what opens it.
 */
function fileIsOursToRepair(file: { readonly name: string; readonly path: string }): boolean {
  if (basename(file.path) === CONFIG_FILE_NAME) return true;
  return fileIsOurs(file.name, readFileSync(file.path, 'utf8'));
}

function hooksChoices(
  choices: SetupChoices,
  cwd: string,
  version: string | undefined,
): HooksChoices {
  return {
    harnesses: choices.harnesses,
    ...(version === undefined ? {} : { writtenBy: version }),
    // Read off what is actually installed, falling back to the installer's defaults
    // when nothing of smelt's is on disk — the same "edit, never reset" reading the
    // hooks installer itself uses. No second copy of the defaults lives here.
    ...presetToggles(cwd),
    enforcement: 'deny',
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
  };
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
