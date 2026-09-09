import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { RERANK_VOYAGE_PACKAGE } from '../net/policy.ts';
import { DEFAULT_STRATEGY, STRATEGIES } from '../plan/planners.ts';
import type { Strategy } from '../plan/planners.ts';
import { STRUCTURAL_LANGUAGES } from '../plan/structural.ts';
import { SETUP_RECIPE } from '../setup/recipe.ts';

import { countedFiles, doneBlock, palette } from './lava.ts';
import type { FileAction } from './lava.ts';
import { CLI_NAME } from './shell.ts';
import { wizardAsk } from './wizard.ts';
import type { AnswerStream } from './shell.ts';
import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  findConfigFile,
  parseConfig,
  renderConfig,
  VOYAGE_DEFAULT_KEY_ENV,
  VOYAGE_DEFAULT_MODEL,
} from '../config.ts';
import type {
  SmeltConfig,
  SmeltConfigHooks,
  SmeltConfigRerank,
  SmeltConfigStore,
} from '../config.ts';

/**
 * `smelt init` — the setup wizard.
 *
 * The same testability pattern as `run.ts`: the wizard is a pure function over an
 * input/output pair, so every flow — fresh run, back-navigation, re-run editing,
 * declined overwrites — runs in-process in tests, and `bin.ts` wires the real stdio.
 *
 * Three rules shape everything here:
 *
 *  1. **Nothing is written until the final confirm**, which lists exactly what will be
 *     written or changed. A wizard that writes as it goes cannot be backed out of.
 *  2. **An existing file is never overwritten without an explicit per-file yes.** Not
 *     a global "overwrite all", not a default — one question per existing file, and
 *     anything but a literal `yes` skips it. Guarded by
 *     `test/guards/init-wizard.test.ts`, with a mutation proving the guard goes red.
 *  3. **Every step accepts `back`.** A wizard you cannot reverse inside is a form. That
 *     includes the directory question a fresh run asks inside a workspace: `back` from
 *     the first step returns to it, keeping the answers given since.
 *  4. **Everything lands in one named directory.** A fresh run inside a workspace asks
 *     which end of config discovery to write to (see `chooseDirectory`) and an edit run
 *     writes beside the config it found; either way the directory is printed in the
 *     "About to write" listing before the confirm, and nothing is ever written outside
 *     it. A wizard that writes where the user cannot see is a wizard writing somewhere
 *     they did not agree to.
 *
 * Law 4 note: the wizard's copy states what each choice *does*, never what it saves —
 * no percentages, no rates, no numbers smelt has not measured.
 */

/** The generated measure-hook stub's file name. */
export const MEASURE_STUB_FILE = 'smelt.measure.ts';

/** The generated reranker stub's file name. */
export const RERANK_STUB_FILE = 'smelt.rerank.ts';

/** Where the wizard's bytes come from and go. Injected so `runInit` is testable in-process. */
export interface InitIo {
  /**
   * Interactive input — the real stdin in `bin.ts`, a scripted stream in tests.
   * Structural on purpose; see {@link AnswerStream}.
   */
  readonly input: AnswerStream;
  readonly output: (text: string) => void;
  /**
   * Where config discovery starts, and where a fresh run's files land — unless `cwd`
   * is inside a workspace and the user picks its root instead (`chooseDirectory`). An
   * edit run writes next to the discovered config, which may be an ancestor of `cwd`.
   * In every flow the "About to write" listing names the directory before anything is
   * written, and nothing is written outside it.
   */
  readonly cwd: string;
  /**
   * Whether the terminal's locale said it can render more than ASCII. The glyph set
   * (`✓ ✗ ⚠`), the closing block's rule and the banner's bar fall back to `+ x !` and
   * `-` where it did not. Absent means yes, which is what this wizard has always
   * printed. Computed once by `bin.ts`; see `lava.ts`'s `supportsUnicode`.
   */
  readonly unicode?: boolean;
}

/** Everything the wizard decides. Pure data until the final confirm writes it. */
interface WizardChoices {
  budgetBytes: number | undefined;
  store: SmeltConfigStore;
  strategy: Strategy;
  /** Generate {@link MEASURE_STUB_FILE}? Never deletes an existing one. */
  measureStub: boolean;
  /**
   * The reranker answer, and the one wizard choice that can make a later run talk to
   * another machine — so it is written as an explicit `rerank` block in the config
   * (ADR-0004) rather than left as a stub nothing loads.
   *
   * `'none'` writes no block and generates nothing, which is what every default run
   * answers. `'module'` generates {@link RERANK_STUB_FILE} *and* points the config at
   * it. `'voyage'` writes the config block for {@link RERANK_VOYAGE_PACKAGE} and prints the
   * install command and the environment variable to set; it writes no key, ever.
   */
  rerank: RerankChoice;
  /**
   * An existing config's `hooks` block, carried through verbatim. This wizard never
   * edits it — `smelt hooks install` owns those choices — but a re-run that silently
   * dropped it would be an edit the user never made.
   */
  hooks: SmeltConfigHooks | undefined;
}

/** The three answers the rerank step takes. See {@link WizardChoices.rerank}. */
type RerankChoice = 'none' | 'module' | 'voyage';

/**
 * The `topK` the wizard writes for the `voyage` answer, and the only number in this
 * file that is not the user's.
 *
 * It is written into the config as a **starting value the user can see and edit**, not
 * as a default smelt applies: `loadRerankStage` has no default for `topK` and refuses a
 * voyage block without one, exactly as `--budget` refuses. Eight is small enough that a
 * first run is cheap and visible in the report's `(N candidates, M kept)` line, and it
 * makes no claim about relevance — the wizard's copy says so.
 *
 * It is a **cap under the budget**, never a quantity: the rerank slot spares the stage's
 * ranking best-first and stops at the budget, so a `topK` of 8 may well report 3 kept,
 * with the report line naming the budget as the reason (`rerank/protect.ts`).
 */
const WIZARD_VOYAGE_TOP_K = 8;

type StepOutcome = 'ok' | 'back';

interface PlannedWrite {
  readonly name: string;
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  /** The file already holds exactly these bytes — nothing to write. */
  readonly unchanged: boolean;
}

/**
 * The wizard, start to finish. Returns an exit code (0 in every completed flow,
 * including "declined to write anything").
 *
 * @throws {CliUsageError} on a malformed existing config, or when input ends before
 *   the wizard finishes — both are usage-shaped, and nothing further is written.
 */
export async function runInit(io: InitIo): Promise<number> {
  // `answerReader` — not `Readable.from` + readline — because the wizard must *let go*
  // of stdin when it is done. See the note on `answerReader` for the hang that shape
  // caused: files written, `Done.` printed, and the process never exiting.
  const wizard = wizardAsk(
    io.input,
    io.output,
    `${CLI_NAME} init: input ended before the wizard finished. ` +
      `Files already confirmed and written stay; nothing further was written.`,
  );
  const ask = wizard.ask;

  try {
    const existing = loadExisting(io.cwd);
    return existing === undefined
      ? await freshRun(io, ask)
      : await editRun(io, ask, existing.path, existing.config);
  } finally {
    await wizard.release();
  }
}

function loadExisting(cwd: string): { path: string; config: SmeltConfig } | undefined {
  const path = findConfigFile(cwd);
  if (path === undefined) return undefined;
  // Malformed is a loud usage error, not a silent fresh start: overwriting a config
  // the user wrote, because it had a typo, would be the wizard deciding for them.
  return { path, config: parseConfig(readFileSync(path, 'utf8'), path) };
}

// ---------------------------------------------------------------------------
// The two flows
// ---------------------------------------------------------------------------

type Asker = (prompt: string) => Promise<string>;

interface Step {
  readonly id: 'budget' | 'store' | 'strategy' | 'measure' | 'rerank';
  run(io: InitIo, ask: Asker, choices: WizardChoices, dir: string): Promise<StepOutcome>;
}

const STEPS: readonly Step[] = [
  { id: 'budget', run: stepBudget },
  { id: 'store', run: stepStore },
  { id: 'strategy', run: stepStrategy },
  { id: 'measure', run: stepMeasure },
  { id: 'rerank', run: stepRerank },
];

async function freshRun(io: InitIo, ask: Asker): Promise<number> {
  const choices: WizardChoices = {
    budgetBytes: undefined,
    store: { kind: 'memory' },
    strategy: DEFAULT_STRATEGY,
    measureStub: false,
    rerank: 'none',
    hooks: undefined,
  };

  // Outside a workspace there is no directory question, so the first step really is the
  // first thing asked. Inside one there is, and `back` from the first step returns to it
  // — with every answer so far carried along, because reversing is not restarting.
  const root = findWorkspaceRoot(io.cwd);
  for (;;) {
    const dir = root === undefined ? io.cwd : await chooseDirectory(io, ask, root);
    io.output(
      `${CLI_NAME} init — sets up ${CONFIG_FILE_NAME} in ${dir}.\n` +
        `A run reads the nearest ${CONFIG_FILE_NAME}, walking UP from the directory it ` +
        `is run in, so this one is found from ${dir} and everything below it.\n` +
        `Answer \`back\` at any step to return to the previous one. ` +
        `Nothing is written until you confirm at the end.\n\n`,
    );
    if ((await runSteps(io, ask, choices, dir, root !== undefined)) === 'done') return 0;
  }
}

/**
 * The step loop for one chosen directory: every step, then the confirm, with `back`
 * reversing all the way through both. Returns `'directory'` when `back` walks off the
 * front and there is a directory question to walk back into — `freshRun` re-asks it and
 * calls this again with the same {@link WizardChoices}.
 */
async function runSteps(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
  canReopenDirectory: boolean,
): Promise<'done' | 'directory'> {
  let index = 0;
  for (;;) {
    while (index < STEPS.length) {
      const outcome = await STEPS[index]!.run(io, ask, choices, dir);
      if (outcome !== 'back') {
        index += 1;
      } else if (index > 0) {
        index -= 1;
      } else if (canReopenDirectory) {
        return 'directory';
      } else {
        io.output(`This is the first step — there is nothing before it.\n`);
      }
    }
    const verdict = await confirmAndWrite(io, ask, choices, dir);
    if (verdict !== 'back') return 'done';
    index = STEPS.length - 1;
  }
}

/**
 * Which directory this fresh run writes into — and the wizard's answer to the
 * monorepo trap.
 *
 * `smelt init` in `packages/web` used to write a config in `packages/web`, silently,
 * while discovery walks **up**: every run from the repo root then found no config and
 * used none, and the user had watched themselves set a budget. So when the working
 * directory sits inside a workspace (`pnpm-workspace.yaml`, or a `package.json` with a
 * `workspaces` field, in any ancestor), the wizard states the discovery rule and asks
 * which end of it to write to, defaulting to the root that covers the whole tree.
 *
 * The answer becomes the directory every later step, the "About to write" listing and
 * every `writeFileSync` uses — so the wizard still writes only inside the one directory
 * the user was shown and confirmed, here as much as anywhere else. Outside a workspace
 * there is nothing to choose and nothing is asked; the discovery rule is stated either
 * way, because "where will runs look for this?" is not a question a user should have to
 * infer from a path.
 *
 * Rule 3 holds here too: this is genuinely the first question, so `back` at it has
 * nowhere to go — but `back` from the first *step* comes back to it (see `freshRun`),
 * carrying the answers already given. The most consequential question in the wizard is
 * not the one you cannot reverse into.
 */
async function chooseDirectory(io: InitIo, ask: Asker, root: string): Promise<string> {
  io.output(
    `${CLI_NAME} init — ${io.cwd} is inside a workspace rooted at ${root}.\n` +
      `A run reads the nearest ${CONFIG_FILE_NAME}, walking UP from the directory it is ` +
      `run in. A config written here is found from here and below; a run from ${root} ` +
      `would not find it. One at the workspace root is found from every package in it.\n` +
      `  1. ${root} (the workspace root)\n` +
      `  2. ${io.cwd} (here — this package only)\n`,
  );
  for (;;) {
    const answer = await ask(`where should ${CONFIG_FILE_NAME} go? (1/2) [1]> `);
    if (answer === 'back') {
      io.output(`This is the first question — there is nothing before it.\n`);
      continue;
    }
    const pick = answer === '' ? '1' : answer;
    if (pick === '1') return root;
    if (pick === '2') return io.cwd;
    io.output(`1 for the workspace root, 2 for here.\n`);
  }
}

/**
 * The nearest **ancestor** of `cwd` that declares a workspace, or `undefined`.
 *
 * Ancestors only: a `cwd` that is itself the workspace root has nothing to choose
 * between, so it is asked nothing. Two markers, because those are the two the
 * ecosystem writes — pnpm's `pnpm-workspace.yaml`, and the `workspaces` field npm,
 * yarn and bun read out of `package.json`. Detection never reads a lockfile and never
 * shells out; a `package.json` it cannot parse claims nothing, so it is not a root.
 */
export function findWorkspaceRoot(cwd: string): string | undefined {
  let dir = resolve(cwd);
  for (;;) {
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
    if (declaresWorkspace(dir)) return dir;
  }
}

function declaresWorkspace(dir: string): boolean {
  if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return true;
  const manifest = join(dir, 'package.json');
  if (!existsSync(manifest)) return false;
  let workspaces: unknown;
  try {
    ({ workspaces } = JSON.parse(readFileSync(manifest, 'utf8')) as { workspaces?: unknown });
  } catch {
    return false; // a package.json smelt cannot read is not a claim about anything
  }
  return Array.isArray(workspaces) || (typeof workspaces === 'object' && workspaces !== null);
}

async function editRun(
  io: InitIo,
  ask: Asker,
  configPath: string,
  config: SmeltConfig,
): Promise<number> {
  const dir = dirname(configPath);
  const choices: WizardChoices = {
    budgetBytes: config.defaultBudgetBytes,
    store: config.store ?? { kind: 'memory' },
    strategy: config.strategy ?? DEFAULT_STRATEGY,
    measureStub: false,
    rerank: config.rerank === undefined ? 'none' : config.rerank.kind,
    hooks: config.hooks,
  };

  io.output(
    `${CLI_NAME} init — ${CONFIG_FILE_NAME} already exists at ${configPath}.\n` +
      `Change one setting at a time; nothing is written until you confirm.\n`,
  );

  for (;;) {
    io.output(`\nCurrent values:\n${summary(choices, dir)}\n`);
    const answer = await ask(
      `Change which setting? (budget / store / strategy / measure / rerank, ` +
        `\`done\` to review and confirm, \`back\` to leave without writing)\n> `,
    );
    if (answer === 'back') {
      io.output(`Left as it was. Nothing has been written.\n`);
      return 0;
    }
    if (answer === 'done') {
      const verdict = await confirmAndWrite(io, ask, choices, dir);
      if (verdict !== 'back') return 0;
      continue; // back from confirm returns to this menu
    }
    const step = STEPS.find((candidate) => candidate.id === answer);
    if (step === undefined) {
      io.output(`Not a setting: "${answer}". One of: budget, store, strategy, measure, rerank.\n`);
      continue;
    }
    await step.run(io, ask, choices, dir); // its own `back` returns here
  }
}

function summary(choices: WizardChoices, dir: string): string {
  const stubLine = (file: string, generate: boolean): string => {
    if (generate) return `generate ${file}`;
    return existsSync(join(dir, file)) ? `${file} exists (kept as is)` : 'none';
  };
  return [
    `  budget:    ${choices.budgetBytes === undefined ? '(not set)' : `${String(choices.budgetBytes)} bytes`}`,
    `  store:     ${choices.store.kind === 'memory' ? 'memory' : `directory (${choices.store.path})`}`,
    `  strategy:  ${choices.strategy}`,
    `  measure:   ${stubLine(MEASURE_STUB_FILE, choices.measureStub)}`,
    `  rerank:    ${rerankLine(choices, dir)}`,
  ].join('\n');
}

/**
 * What the rerank answer means, in the summary and in the confirm listing.
 *
 * It names the config block that will be written, not just the file — the whole point
 * of the third answer is that the choice ends up somewhere a run actually reads, and a
 * summary that said only "generate smelt.rerank.ts" would describe a stub nothing loads,
 * which is what this wizard used to do.
 */
function rerankLine(choices: WizardChoices, dir: string): string {
  switch (choices.rerank) {
    case 'none':
      return existsSync(join(dir, RERANK_STUB_FILE))
        ? `none (${RERANK_STUB_FILE} exists, and no config points at it)`
        : 'none';
    case 'module':
      return `module — generate ${RERANK_STUB_FILE} and point ${CONFIG_FILE_NAME} at it`;
    case 'voyage':
      return (
        `voyage — ${CONFIG_FILE_NAME} names ${VOYAGE_DEFAULT_MODEL}, ` +
        `key read from ${VOYAGE_DEFAULT_KEY_ENV}`
      );
  }
}

// ---------------------------------------------------------------------------
// The steps. Each one accepts `back`.
// ---------------------------------------------------------------------------

async function stepBudget(io: InitIo, ask: Asker, choices: WizardChoices): Promise<StepOutcome> {
  io.output(
    `\nDefault byte budget — used when a \`${CLI_NAME}\` run omits --budget.\n` +
      `Budgets are UTF-8 bytes, permanently; an explicit --budget always wins.\n` +
      `There is no suggested number: the right budget depends on your traffic, and ` +
      `smelt does not invent numbers it has not measured.\n`,
  );
  for (;;) {
    const current = choices.budgetBytes === undefined ? '' : ` [${String(choices.budgetBytes)}]`;
    const answer = await ask(`budget in bytes${current} (or back)> `);
    if (answer === 'back') return 'back';
    if (answer === '' && choices.budgetBytes !== undefined) return 'ok';
    if (/^\d+$/.test(answer) && Number(answer) > 0) {
      choices.budgetBytes = Number(answer);
      return 'ok';
    }
    io.output(`A whole number of bytes greater than zero, e.g. 4000.\n`);
  }
}

async function stepStore(io: InitIo, ask: Asker, choices: WizardChoices): Promise<StepOutcome> {
  io.output(
    `\nWhere elided bytes live. Every elision is reversible only while a store holds ` +
      `its bytes (Law 3):\n` +
      `  1. memory     — per-process; retrievals do not survive the process\n` +
      `  2. directory  — persistent, content-addressed, on disk; retrieval counters ` +
      `survive restarts\n`,
  );
  for (;;) {
    const current = choices.store.kind === 'memory' ? '1' : '2';
    const answer = await ask(`store (1/2) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    if (pick === '1') {
      choices.store = { kind: 'memory' };
      return 'ok';
    }
    if (pick === '2') {
      const previous =
        choices.store.kind === 'directory' ? choices.store.path : SETUP_RECIPE.store.defaultDir;
      const path = await ask(`store directory, relative to ${CONFIG_FILE_NAME} [${previous}]> `);
      if (path === 'back') continue; // back to the store choice, not out of the step
      choices.store = { kind: 'directory', path: path === '' ? previous : path };
      return 'ok';
    }
    io.output(`1 for memory, 2 for directory, or back.\n`);
  }
}

/**
 * One sentence per strategy, for the wizard's menu — `Record<Strategy, string>`, so a
 * strategy added to the `PLANNERS` registry without a line here is a compile error
 * rather than an option the wizard silently never offers. The menu itself, its
 * numbering and the re-prompt are all rendered from {@link STRATEGIES}, which is why
 * the third choice cost one entry in this table.
 */
const STRATEGY_BLURB: Readonly<Record<Strategy, string>> = {
  lexical: 'line windows around your focus terms; works on any text',
  structural:
    `parses ${String(STRUCTURAL_LANGUAGES.length)} languages with bundled grammars ` +
    `(${STRUCTURAL_LANGUAGES.join(', ')}) and collapses siblings by name; refuses ` +
    `other languages rather than approximating`,
  auto:
    'content kind first (json, diff), then structural for those languages and ' +
    'lexical for everything else; the result names whichever one actually ran',
  json: 'members and elements as units, for JSON tool results; refuses non-JSON',
  diff: 'files and hunks as units, for unified diffs; refuses anything else',
};

async function stepStrategy(io: InitIo, ask: Asker, choices: WizardChoices): Promise<StepOutcome> {
  const picks = STRATEGIES.map((_, index) => String(index + 1));
  io.output(
    `\nDefault planner strategy — used when a run omits --strategy:\n` +
      STRATEGIES.map(
        (name, index) => `  ${picks[index]!}. ${name.padEnd(12)}— ${STRATEGY_BLURB[name]}\n`,
      ).join(''),
  );
  for (;;) {
    const current = picks[STRATEGIES.indexOf(choices.strategy)]!;
    const answer = await ask(`strategy (${picks.join('/')}) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    const index = picks.indexOf(pick);
    if (index >= 0) {
      choices.strategy = STRATEGIES[index]!;
      return 'ok';
    }
    io.output(`${STRATEGIES.map((name, i) => `${picks[i]!} for ${name}`).join(', ')}, or back.\n`);
  }
}

async function stepMeasure(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
): Promise<StepOutcome> {
  const exists = existsSync(join(dir, MEASURE_STUB_FILE));
  io.output(
    `\nMeasure hook — your own counter (a tokenizer, usually), so results carry a ` +
      `second, labelled number next to the byte counts. smelt ships none: a token ` +
      `count without its tokenizer named is not a measurement.\n` +
      `  1. none\n` +
      `  2. generate ${MEASURE_STUB_FILE}, a typed stub you fill in\n` +
      (exists ? `(${MEASURE_STUB_FILE} already exists; it is never deleted from here.)\n` : ``),
  );
  for (;;) {
    const answer = await ask(`measure (1/2) [${choices.measureStub ? '2' : '1'}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? (choices.measureStub ? '2' : '1') : answer;
    if (pick === '1' || pick === '2') {
      choices.measureStub = pick === '2';
      return 'ok';
    }
    io.output(`1 for none, 2 to generate the stub, or back.\n`);
  }
}

/**
 * The reranker question, and the only one whose answer can send bytes off the machine.
 *
 * Three answers, because ADR-0004 added the third: `none` (the default, and the answer
 * that leaves smelt exactly as network-free as it has always been), `module` (your own
 * stage, in your own file, with the config pointing at it), and `voyage` (the opt-in
 * adapter package, which you install and key yourself).
 *
 * The copy states what each answer *does* and never what it saves — no relevance claim,
 * no percentage, nothing measured. What it does say plainly is the consequence: with
 * anything but `none`, regions of your files are sent to whatever the stage calls.
 */
async function stepRerank(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
): Promise<StepOutcome> {
  const exists = existsSync(join(dir, RERANK_STUB_FILE));
  const picks: readonly RerankChoice[] = ['none', 'module', 'voyage'];
  io.output(
    `\nReranker — a RerankStage that decides which regions a cut must spare. smelt ` +
      `bundles none and loads none unless this config says so: with answer 1, nothing ` +
      `is imported and nothing is called, which is what smelt has always done. With 2 ` +
      `or 3, regions of your files are sent to whatever that stage calls, from your ` +
      `process, under your key.\n` +
      `  1. none\n` +
      `  2. module  — generate ${RERANK_STUB_FILE}, a typed stub you fill in, and point ` +
      `${CONFIG_FILE_NAME} at it\n` +
      `  3. voyage  — use ${RERANK_VOYAGE_PACKAGE}, which you install; the key is read from ` +
      `${VOYAGE_DEFAULT_KEY_ENV} and never written here\n` +
      (exists ? `(${RERANK_STUB_FILE} already exists; it is never deleted from here.)\n` : ``),
  );
  for (;;) {
    const current = String(picks.indexOf(choices.rerank) + 1);
    const answer = await ask(`rerank (1/2/3) [${current}] (or back)> `);
    if (answer === 'back') return 'back';
    const pick = answer === '' ? current : answer;
    const index = ['1', '2', '3'].indexOf(pick);
    if (index >= 0) {
      choices.rerank = picks[index]!;
      return 'ok';
    }
    io.output(`1 for none, 2 for a module of your own, 3 for voyage, or back.\n`);
  }
}

// ---------------------------------------------------------------------------
// The confirm step: the only place anything is written
// ---------------------------------------------------------------------------

const writeLabel = (write: PlannedWrite): string => {
  if (write.unchanged) return 'unchanged — nothing to write';
  return write.exists ? 'exists — will ask before overwriting' : 'new';
};

async function confirmAndWrite(
  io: InitIo,
  ask: Asker,
  choices: WizardChoices,
  dir: string,
): Promise<'done' | 'back'> {
  if (choices.budgetBytes === undefined) {
    // Unreachable in the fresh flow (the budget step requires a number) but reachable
    // from an edit of a config that never had one — `defaultBudgetBytes` is optional,
    // so such a config parses fine. The wizard still insists: a confirm without a
    // budget would write a file this wizard just called incomplete. `back` here is a
    // real `back` — it returns to the caller, never falls forward into the confirm.
    io.output(`No budget is set yet — set one before confirming.\n`);
    if ((await stepBudget(io, ask, choices)) === 'back') return 'back';
  }

  const writes = plannedWrites(choices, dir);
  io.output(
    `\nAbout to write, into ${dir}:\n` +
      writes.map((write) => `  ${write.name.padEnd(20)} (${writeLabel(write)})\n`).join('') +
      `Nothing has been written yet.\n`,
  );

  for (;;) {
    const answer = await ask(`confirm (yes / no / back)> `);
    if (answer === 'back') return 'back';
    if (answer === 'no') {
      io.output(`Nothing was written.\n`);
      return 'done';
    }
    if (answer === 'yes') break;
    io.output(`yes to write, no to leave everything untouched, back to change a setting.\n`);
  }

  // Counted as the loop goes, so the closing block states what was written rather
  // than what was planned — a file declined at its own prompt is not a file written.
  const applied: FileAction[] = [];
  for (const write of writes) {
    if (write.unchanged) {
      io.output(`  ${write.name} — unchanged, not rewritten\n`);
      applied.push('unchanged');
      continue;
    }
    if (write.exists) {
      // The per-file consent rule: one explicit question per existing file, and only
      // a literal `yes` overwrites. This is the line the mutation
      // `init-overwrite-without-consent` breaks to prove the guard can go red.
      const answer = await ask(`  ${write.name} exists — overwrite it? (yes/no)> `);
      if (answer !== 'yes') {
        io.output(`  skipped ${write.name} — the existing file was not touched\n`);
        applied.push('skipped');
        continue;
      }
    }
    writeFileSync(write.path, write.content);
    io.output(`  wrote ${write.name}\n`);
    applied.push('written');
  }
  if (choices.rerank === 'voyage') {
    // The two things the wizard deliberately did not do for them: install the adapter
    // and supply a key. Printed at the moment they matter, and the key is named, never
    // read and never written.
    io.output(
      `\nThe voyage reranker needs two things this wizard will not do for you:\n` +
        `  npm install ${RERANK_VOYAGE_PACKAGE}\n` +
        `  export ${VOYAGE_DEFAULT_KEY_ENV}=...   (smelt reads the variable, never stores the key)\n` +
        `Until both are in place, a run that would rerank refuses and says which is missing.\n` +
        `\`${CLI_NAME} doctor\` reports whether ${VOYAGE_DEFAULT_KEY_ENV} is set.\n`,
    );
  }
  const lava = palette({ unicode: io.unicode !== false });
  io.output(
    doneBlock(
      {
        ok: true,
        what: `${CLI_NAME} init`,
        summary: countedFiles(applied, lava),
        note: `${CONFIG_FILE_NAME} is defaults only ${lava.dash()} every flag still wins over it.`,
        next: [
          [`${CLI_NAME} setup`, 'wire the guard preset into the harness you use'],
          [
            `${CLI_NAME} <file> --budget 4000`,
            `smelt one file ${lava.dash()} the report says what went`,
          ],
          [`${CLI_NAME} doctor`, 'read back what is installed, and what is behind'],
        ],
      },
      lava,
    ),
  );
  return 'done';
}

function plannedWrites(choices: WizardChoices, dir: string): readonly PlannedWrite[] {
  const plan = (name: string, content: string): PlannedWrite => {
    const path = join(dir, name);
    const exists = existsSync(path);
    const unchanged = exists && readFileSync(path, 'utf8') === content;
    return { name, path, content, exists, unchanged };
  };
  const writes = [plan(CONFIG_FILE_NAME, renderConfig(chosenConfig(choices)))];
  if (choices.measureStub) writes.push(plan(MEASURE_STUB_FILE, measureStubSource()));
  if (choices.rerank === 'module') writes.push(plan(RERANK_STUB_FILE, rerankStubSource()));
  return writes;
}

/**
 * The config the wizard's choices mean — the wizard's *policy*, handed to the one
 * writer in `config.ts`. `strategy` and `store` are always written: the wizard asked
 * about both, and a chosen value left out of the file would be a setting the user
 * watched themselves pick and never got.
 */
function chosenConfig(choices: {
  readonly budgetBytes: number | undefined;
  readonly store: SmeltConfigStore;
  readonly strategy: Strategy;
  readonly rerank: RerankChoice;
  /** Carried through from an existing config; this wizard never edits it. */
  readonly hooks?: SmeltConfigHooks | undefined;
}): SmeltConfig {
  return {
    smeltConfig: CONFIG_VERSION,
    ...(choices.budgetBytes === undefined ? {} : { defaultBudgetBytes: choices.budgetBytes }),
    strategy: choices.strategy,
    store: choices.store,
    ...(choices.hooks === undefined ? {} : { hooks: choices.hooks }),
    ...rerankBlock(choices.rerank),
  };
}

/**
 * The `rerank` block a choice means — and `'none'` means **no key at all**, not
 * `{"kind":"none"}`.
 *
 * An absent key is the whole of the opt-out: `parseConfig` returns `undefined`,
 * `loadRerankStage` returns `undefined`, and no module is imported. A written-out "off"
 * would be a switch someone could flip by editing one word, in a file smelt wrote
 * without being asked to.
 */
function rerankBlock(choice: RerankChoice): { rerank?: SmeltConfigRerank } {
  switch (choice) {
    case 'none':
      return {};
    case 'module':
      return { rerank: { kind: 'module', path: `./${RERANK_STUB_FILE}` } };
    case 'voyage':
      return {
        rerank: {
          kind: 'voyage',
          model: VOYAGE_DEFAULT_MODEL,
          apiKeyEnv: VOYAGE_DEFAULT_KEY_ENV,
          topK: WIZARD_VOYAGE_TOP_K,
        },
      };
  }
}

// ---------------------------------------------------------------------------
// The generated stubs. String literals on purpose: smelt's own import graph must not
// gain an HTTP client, and the zero-network guard's string-stripper ignores string
// bodies — the sketched fetch below lives in the CONSUMER'S file, never in smelt's.
//
// The comment token between `from` and the package name in each stub's import line is
// deliberate: the guard's import scanner reads raw source, so spelling that import
// plainly inside this template would register as an edge in smelt's own graph — which
// it is not. The comment keeps the generated file valid TypeScript while keeping this
// data out of the guard's walk.
// ---------------------------------------------------------------------------

/** The `smelt.measure.ts` the wizard writes. Exported so tests can compile it. */
export function measureStubSource(): string {
  return `/**
 * Measure hook — generated by \`smelt init\`.
 *
 * smelt's budgets are UTF-8 bytes, permanently; this hook adds a second, labelled
 * number to every result in YOUR unit, counted by YOUR tokenizer. Both \`id\` and
 * \`unit\` are required: a count without the counter named is not a measurement.
 *
 * Wire it in, in your own code:
 *
 *   const smelter = createSmelter({ defaultBudgetBytes: 8_000, measure });
 *
 * with createSmelter imported from your @smeltjs/core install and measure from here.
 */
import type { Measure } from /* your install */ '@smeltjs/core';

export const measure: Measure = {
  // TODO: name the counter that produces these numbers, e.g. 'tiktoken/o200k_base'.
  id: 'TODO/your-tokenizer',
  unit: 'tokens',
  count(text: string): number {
    // TODO: replace with your real tokenizer. It must be local and synchronous —
    // a count() that calls an API would make your process call an API on every smelt.
    // e.g.  return encode(text).length;
    throw new Error(
      'smelt.measure.ts: count() is not implemented yet — ' +
        'fill it in with your tokenizer (length of input: ' + String(text.length) + ')',
    );
  },
};
`;
}

/** The `smelt.rerank.ts` the wizard writes. Exported so tests can compile it. */
export function rerankStubSource(): string {
  return `/**
 * Reranker stub — generated by \`smelt init\`.
 *
 * smelt's own import graph makes zero network calls and bundles no reranker (Law 1):
 * the moment one ships as a default, every consumer's source code leaves the machine
 * and they find out from a changelog, or never. So the outbound call lives HERE, in
 * your file, reading your env var, visible in your own review.
 *
 * \`smelt init\` also wrote a \`rerank\` block into smelt.config.json pointing at this
 * file, so \`smelt\` and the MCP server load it. Delete that block and nothing here is
 * ever imported — the opt-in is the config key, not this file's existence.
 */
import type { RerankCandidate, RerankedCandidate, RerankStage } from /* your install */ '@smeltjs/core';

/** The env var YOUR code reads. Rename it to match your vendor. */
const API_KEY_ENV = 'RERANKER_API_KEY';

/**
 * How many regions this stage spares from the cut.
 *
 * smelt has no default for this and never will: whatever \`rerank\` returns is what smelt
 * KEEPS, so a K somebody else picked would decide how much of your context survives.
 * Pick a number you meant \u2014 and note that returning every candidate keeps every
 * candidate, which makes the run a no-op that exits 0.
 */
const TOP_K = 8;

export const rerank: RerankStage = {
  id: 'my-reranker/v1',
  async rerank(
    candidates: readonly RerankCandidate[],
    query: string,
  ): Promise<readonly RerankedCandidate[]> {
    const apiKey = process.env[API_KEY_ENV];
    if (apiKey === undefined || apiKey === '') {
      throw new Error(
        'smelt.rerank.ts: ' + API_KEY_ENV + ' is not set. This stage makes an outbound ' +
          'HTTP call from YOUR code with YOUR key; without a key it refuses to pretend.',
      );
    }

    // TODO: the outbound call. Voyage AI is one example vendor; any reranker with an
    // HTTP API fits this shape:
    //
    //   const response = await fetch('https://api.voyageai.com/v1/rerank', {
    //     method: 'POST',
    //     headers: {
    //       'content-type': 'application/json',
    //       authorization: \`Bearer \${apiKey}\`,
    //     },
    //     body: JSON.stringify({
    //       query,
    //       documents: candidates.map((candidate) => candidate.text),
    //       // Your cut-off, and it is not optional. Whatever you return is what smelt
    //       // SPARES from the cut, so returning every candidate spares every candidate:
    //       // the output equals the input, nothing errors, and the run exits 0 looking
    //       // like it worked. Pick a K you meant.
    //       top_k: TOP_K,
    //     }),
    //   });
    //   if (!response.ok) throw new Error('rerank failed: ' + String(response.status));
    //   const body = (await response.json()) as {
    //     data: { index: number; relevance_score: number }[];
    //   };
    //   return body.data
    //     .map(({ index, relevance_score }) => ({
    //       ...candidates[index]!,
    //       score: relevance_score,
    //     }))
    //     // Belt and braces: a vendor that ignores top_k must not silently disable
    //     // every elision on this run.
    //     .slice(0, TOP_K);
    //
    void candidates;
    void query;
    void TOP_K;
    throw new Error(
      'smelt.rerank.ts: implement the outbound call sketched above, then delete this throw. ' +
        'smelt reports this as a RerankStageError naming this stage, not as a crash.',
    );
  },
};

// What smelt.config.json's {"kind":"module"} loads. The named \`rerank\` above is
// accepted too, so either spelling works when you import this from your own code.
export default rerank;
`;
}
