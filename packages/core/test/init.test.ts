import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CliUsageError } from '../src/errors.ts';
import { STRATEGIES } from '../src/plan/planners.ts';
import { STRUCTURAL_LANGUAGES } from '../src/plan/structural.ts';
import { CONFIG_FILE_NAME, findConfigFile } from '../src/cli/config.ts';
import type { SmeltConfig } from '../src/cli/config.ts';
import {
  findWorkspaceRoot,
  MEASURE_STUB_FILE,
  RERANK_STUB_FILE,
  runInit,
} from '../src/cli/init.ts';
import { EXIT, runCli } from '../src/cli/run.ts';
import type { CliIo } from '../src/cli/run.ts';

/**
 * The `smelt init` wizard, driven entirely in-process: the wizard is a pure function
 * over an input/output pair, so every flow here scripts the answers up front and
 * asserts on the files (and the transcript) afterwards. No terminal, no child process.
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'smelt-init-'));
  // Discovery walks UP from `dir` to the filesystem root, so a stray
  // smelt.config.json in the temp tree (or above it) would flip every fresh-run
  // test into an edit run. Fail loudly here instead of mysteriously below.
  expect(findConfigFile(dir), 'ancestor smelt.config.json would break these tests').toBeUndefined();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface WizardRun {
  readonly code: number;
  readonly output: string;
}

async function wizard(answers: readonly string[], cwd = dir): Promise<WizardRun> {
  let output = '';
  const code = await runInit({
    input: Readable.from([`${answers.join('\n')}\n`]),
    output: (text) => {
      output += text;
    },
    cwd,
  });
  return { code, output };
}

function readConfig(at = dir): SmeltConfig {
  return JSON.parse(readFileSync(join(at, CONFIG_FILE_NAME), 'utf8')) as SmeltConfig;
}

/** budget, store=memory, strategy=lexical, no stubs, confirm yes. */
const MINIMAL_ANSWERS = ['4000', '1', '1', '1', '1', 'yes'];

describe('a fresh run', () => {
  it('writes a versioned config from the answers, and nothing else', async () => {
    const { code, output } = await wizard(MINIMAL_ANSWERS);
    expect(code).toBe(EXIT.ok);
    expect(readConfig()).toEqual({
      smeltConfig: 1,
      defaultBudgetBytes: 4000,
      strategy: 'lexical',
      store: { kind: 'memory' },
    });
    expect(existsSync(join(dir, MEASURE_STUB_FILE))).toBe(false);
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(false);
    expect(output).toContain('wrote smelt.config.json');
  });

  it('describes the structural strategy with the real language list, derived, never hand-counted', async () => {
    // The wizard copy once said "parses typescript and tsx" — stale by thirteen
    // languages. Deriving both the count and the list from STRUCTURAL_LANGUAGES
    // means this sentence cannot rot when the next grammar lands.
    const { output } = await wizard(MINIMAL_ANSWERS);
    expect(output).toContain(`parses ${String(STRUCTURAL_LANGUAGES.length)} languages`);
    expect(output).toContain(STRUCTURAL_LANGUAGES.join(', '));
    expect(output).not.toContain('typescript and tsx');
  });

  it('offers every strategy the registry carries, and writes the one that was picked', async () => {
    // The wizard's menu, its numbering and its re-prompt all render STRATEGIES, so a
    // strategy cannot reach `--strategy` and miss the wizard. `auto` is choice 3.
    const { code, output } = await wizard(['4000', '1', '3', '1', '1', 'yes']);
    expect(code).toBe(EXIT.ok);
    for (const [index, name] of STRATEGIES.entries()) {
      expect(output, name).toContain(`${String(index + 1)}. ${name}`);
    }
    expect(output).toContain(`strategy (${STRATEGIES.map((_, i) => String(i + 1)).join('/')})`);
    expect(readConfig().strategy).toBe('auto');
  });

  it('generates both stubs when asked, and points the config at the reranker', async () => {
    const { code } = await wizard(['8000', '2', '', '2', '2', '2', 'yes']);
    expect(code).toBe(EXIT.ok);
    // The `module` answer writes the stub AND the block that loads it. A stub nothing
    // points at is a file the user watched themselves ask for and never got used.
    expect(readConfig()).toEqual({
      smeltConfig: 1,
      defaultBudgetBytes: 8000,
      strategy: 'structural',
      store: { kind: 'directory', path: '.smelt/store' },
      rerank: { kind: 'module', path: `./${RERANK_STUB_FILE}` },
    });
    const measure = readFileSync(join(dir, MEASURE_STUB_FILE), 'utf8');
    const rerank = readFileSync(join(dir, RERANK_STUB_FILE), 'utf8');
    expect(measure).toContain('Measure');
    expect(rerank).toContain('RerankStage');
    // The outbound call is sketched in the CONSUMER'S file, reading the consumer's
    // own env var — never wired into smelt's own graph.
    expect(rerank).toContain('TODO');
    expect(rerank).toContain('RERANKER_API_KEY');
    expect(rerank).toContain('fetch(');
    // What {"kind":"module"} loads.
    expect(rerank).toContain('export default rerank;');
  });

  it('writes the voyage block, and no key, for the third answer', async () => {
    const { code, output } = await wizard(['4000', '1', '1', '1', '3', 'yes']);
    expect(code).toBe(EXIT.ok);
    expect(readConfig().rerank).toEqual({
      kind: 'voyage',
      model: 'rerank-2.5',
      apiKeyEnv: 'VOYAGE_API_KEY',
      topK: 8,
    });
    // No stub is written for this answer — the adapter is a package, not a file.
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(false);
    // The two things the wizard deliberately does not do, printed where they matter.
    expect(output).toContain('npm install @smeltjs/rerank-voyage');
    expect(output).toContain('export VOYAGE_API_KEY=');
    // And never a key: the wizard names the variable and reads nothing.
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).not.toContain('apiKey"');
  });

  it('writes no rerank key at all for the `none` answer', async () => {
    // The opt-out is an *absent* key, never {"kind":"none"} — a written-out "off" is a
    // switch somebody can flip by editing one word in a file smelt wrote unasked.
    const { code } = await wizard(MINIMAL_ANSWERS);
    expect(code).toBe(EXIT.ok);
    expect(readConfig().rerank).toBeUndefined();
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).not.toContain('rerank');
  });

  it('accepts back at every step, including the confirm, and lands on the final answers', async () => {
    const answers = [
      '1000', // budget
      'back', // store → back to budget
      '2000', // budget again
      '1', // store: memory
      'back', // strategy → back to store
      '2', // store: directory
      '', // path: default
      '2', // strategy: structural
      'back', // measure → back to strategy
      '1', // strategy: lexical after all
      '1', // measure: none
      'back', // rerank → back to measure
      '2', // measure: generate
      '1', // rerank: none
      'back', // confirm → back to rerank
      '2', // rerank: module (generate the stub and point the config at it)
      'yes', // confirm
      // no overwrite questions: nothing existed
    ];
    const { code } = await wizard(answers);
    expect(code).toBe(EXIT.ok);
    expect(readConfig()).toEqual({
      smeltConfig: 1,
      defaultBudgetBytes: 2000,
      strategy: 'lexical',
      store: { kind: 'directory', path: '.smelt/store' },
      rerank: { kind: 'module', path: `./${RERANK_STUB_FILE}` },
    });
    expect(existsSync(join(dir, MEASURE_STUB_FILE))).toBe(true);
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(true);
  });

  it('back at the first step stays at the first step instead of crashing', async () => {
    const { code, output } = await wizard(['back', ...MINIMAL_ANSWERS]);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('first step');
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(true);
  });

  it('re-asks on an answer it does not understand, without advancing', async () => {
    const { code } = await wizard(['not-a-number', '-3', '4000', '7', '1', '1', '1', '1', 'yes']);
    expect(code).toBe(EXIT.ok);
    expect(readConfig().defaultBudgetBytes).toBe(4000);
  });

  it('writes NOTHING when the final confirm is declined', async () => {
    const { code, output } = await wizard(['4000', '1', '1', '2', '2', 'no']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('Nothing was written');
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(false);
    expect(existsSync(join(dir, MEASURE_STUB_FILE))).toBe(false);
    expect(existsSync(join(dir, RERANK_STUB_FILE))).toBe(false);
  });

  it('writes nothing before the confirm even when input ends mid-wizard', async () => {
    await expect(wizard(['4000', '1'])).rejects.toThrow(CliUsageError);
    expect(existsSync(join(dir, CONFIG_FILE_NAME))).toBe(false);
  });

  it('lists exactly what will be written before asking for the confirm', async () => {
    const { output } = await wizard(['4000', '1', '1', '2', '1', 'no']);
    const listing = output.slice(output.indexOf('About to write'));
    expect(listing).toContain(CONFIG_FILE_NAME);
    expect(listing).toContain(MEASURE_STUB_FILE);
    expect(listing).not.toContain(RERANK_STUB_FILE);
    expect(listing).toContain('Nothing has been written yet');
  });

  it('claims no unmeasured number anywhere in its copy (Law 4)', async () => {
    const { output } = await wizard(MINIMAL_ANSWERS);
    expect(output).not.toMatch(/\d+\s*%/);
    expect(output.toLowerCase()).not.toContain('hit rate');
    expect(output.toLowerCase()).not.toContain('sav');
  });

  it('states where runs will look for the config it is about to write', async () => {
    // Discovery walks UP, and a wizard that does not say so leaves the user to infer
    // it from a path — the same silence that made the monorepo case a trap.
    const { output } = await wizard(MINIMAL_ANSWERS);
    expect(output).toContain(`sets up ${CONFIG_FILE_NAME} in ${dir}`);
    expect(output).toContain('walking UP');
    expect(output).not.toContain('workspace'); // there is none here, so nothing is asked
  });
});

describe('a fresh run inside a monorepo package', () => {
  let root: string;
  let pkg: string;

  beforeEach(() => {
    root = dir;
    pkg = join(root, 'packages', 'web');
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\n");
  });

  it('says which end of config discovery it is writing to, and asks', async () => {
    const { output } = await wizard(['1', ...MINIMAL_ANSWERS], pkg);
    expect(output).toContain(`inside a workspace rooted at ${root}`);
    expect(output).toContain(`would not find it`);
    expect(output).toContain(`where should ${CONFIG_FILE_NAME} go?`);
  });

  it('writes at the workspace root when that is the answer — where runs will look', async () => {
    const { code } = await wizard(['1', ...MINIMAL_ANSWERS], pkg);
    expect(code).toBe(EXIT.ok);
    expect(existsSync(join(root, CONFIG_FILE_NAME))).toBe(true);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(false);
    // The point of the whole question: a run from the root now finds it.
    expect(findConfigFile(root)).toBe(join(root, CONFIG_FILE_NAME));
    expect(readConfig(root).defaultBudgetBytes).toBe(4000);
  });

  it('writes in the package when that is the answer, and nowhere else', async () => {
    const { code } = await wizard(['2', ...MINIMAL_ANSWERS], pkg);
    expect(code).toBe(EXIT.ok);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(true);
    expect(existsSync(join(root, CONFIG_FILE_NAME))).toBe(false);
  });

  it('writes only into the directory the confirm listing named', async () => {
    const { output } = await wizard(['2', ...MINIMAL_ANSWERS], pkg);
    expect(output).toContain(`About to write, into ${pkg}`);
    expect(existsSync(join(root, CONFIG_FILE_NAME))).toBe(false);
    // …and the same promise from the other answer.
    rmSync(join(pkg, CONFIG_FILE_NAME), { force: true });
    const rooted = await wizard(['1', ...MINIMAL_ANSWERS], pkg);
    expect(rooted.output).toContain(`About to write, into ${root}`);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(false);
  });

  it('reverses into the directory question, keeping the answers given since (Rule 3)', async () => {
    // The directory is the one answer you cannot change afterwards, so it must be the
    // one you can get back to. `back` off the front of the steps re-asks it; the budget
    // already answered is still the default, so reversing is not restarting.
    const { code, output } = await wizard(
      ['2', '4000', 'back', 'back', '1', '', ...MINIMAL_ANSWERS.slice(1)],
      pkg,
    );
    expect(code).toBe(EXIT.ok);
    expect(output).not.toContain('first step'); // there IS something before it
    expect(output.split(`where should ${CONFIG_FILE_NAME} go?`)).toHaveLength(3); // asked twice
    expect(output).toContain(`About to write, into ${root}`);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(false);
    expect(readConfig(root).defaultBudgetBytes).toBe(4000);
  });

  it('defaults to the root, and re-asks an answer it does not understand', async () => {
    const { code, output } = await wizard(['3', '', ...MINIMAL_ANSWERS], pkg);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('1 for the workspace root, 2 for here.');
    expect(existsSync(join(root, CONFIG_FILE_NAME))).toBe(true);
  });

  it('detects a npm/yarn-style workspaces field too, and ignores an unparseable manifest', async () => {
    rmSync(join(root, 'pnpm-workspace.yaml'));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    expect(findWorkspaceRoot(pkg)).toBe(root);

    writeFileSync(join(root, 'package.json'), '{ not json');
    expect(findWorkspaceRoot(pkg)).toBeUndefined();
    // A plain package (no workspaces field) is not a workspace root either.
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'not-a-workspace' }));
    expect(findWorkspaceRoot(pkg)).toBeUndefined();
  });

  it('asks nothing when the workspace root is where you already are', async () => {
    const { output } = await wizard(MINIMAL_ANSWERS, root);
    expect(output).not.toContain('where should');
    expect(existsSync(join(root, CONFIG_FILE_NAME))).toBe(true);
  });

  it('is not asked at all on a re-run: the found config decides where it lives', async () => {
    writeFileSync(
      join(root, CONFIG_FILE_NAME),
      `${JSON.stringify({ smeltConfig: 1, defaultBudgetBytes: 4000 }, null, 2)}\n`,
    );
    const { output } = await wizard(['budget', '9999', 'done', 'yes', 'yes'], pkg);
    expect(output).not.toContain('where should');
    expect(readConfig(root).defaultBudgetBytes).toBe(9999);
    expect(existsSync(join(pkg, CONFIG_FILE_NAME))).toBe(false);
  });
});

describe('a re-run over an existing config', () => {
  const existing: SmeltConfig = {
    smeltConfig: 1,
    defaultBudgetBytes: 4000,
    strategy: 'lexical',
    store: { kind: 'memory' },
  };

  beforeEach(() => {
    writeFileSync(join(dir, CONFIG_FILE_NAME), `${JSON.stringify(existing, null, 2)}\n`);
  });

  it('shows the current values and changes exactly one choice at a time', async () => {
    const { code, output } = await wizard([
      'strategy', // edit one setting…
      '2', // …to structural
      'done',
      'yes', // confirm
      'yes', // overwrite smelt.config.json
    ]);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('already exists');
    expect(output).toContain('budget:    4000 bytes');
    expect(output).toContain('strategy:  lexical'); // shown before the edit
    expect(readConfig()).toEqual({ ...existing, strategy: 'structural' });
  });

  it('never overwrites the existing config without an explicit per-file yes', async () => {
    const before = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    const { code, output } = await wizard(['budget', '9999', 'done', 'yes', 'no']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('overwrite');
    expect(output).toContain('skipped');
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(before);
  });

  it('back at the menu leaves without writing anything', async () => {
    const before = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    const { code, output } = await wizard(['back']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('Nothing has been written');
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(before);
  });

  it('does not rewrite an unchanged config, and says so', async () => {
    const before = readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8');
    const { code, output } = await wizard(['done', 'yes']);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain('unchanged');
    expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(before);
  });

  it('declining to overwrite an existing stub leaves it byte-for-byte intact', async () => {
    const sentinel = '// my hand-written reranker — do not touch\n';
    writeFileSync(join(dir, RERANK_STUB_FILE), sentinel);
    const { code, output } = await wizard([
      'rerank',
      '2', // module: generate the stub, and point the config at it
      'done',
      'yes', // confirm
      'yes', // overwrite the config — it gained the rerank block
      'no', // decline overwriting smelt.rerank.ts
    ]);
    expect(code).toBe(EXIT.ok);
    expect(output).toContain(`${RERANK_STUB_FILE} exists`);
    expect(readFileSync(join(dir, RERANK_STUB_FILE), 'utf8')).toBe(sentinel);
  });

  it('refuses a malformed existing config loudly instead of overwriting it', async () => {
    writeFileSync(join(dir, CONFIG_FILE_NAME), '{ not json');
    await expect(wizard(['4000'])).rejects.toThrow(/malformed/);
  });

  describe('over a valid config that never had a budget', () => {
    // `defaultBudgetBytes` is optional in the schema, so this config parses fine —
    // the forced budget prompt at the confirm is the only thing standing between
    // `done` and writing a budget-less config the wizard itself called incomplete.
    const budgetless = `${JSON.stringify({ smeltConfig: 1, strategy: 'lexical' }, null, 2)}\n`;

    beforeEach(() => {
      writeFileSync(join(dir, CONFIG_FILE_NAME), budgetless);
    });

    it('back at the forced budget prompt returns to the menu instead of falling into the confirm', async () => {
      const { code, output } = await wizard([
        'done', // review → forced budget prompt (no budget set)
        'back', // back out of it → the menu, NOT the confirm
        'back', // leave the menu without writing
      ]);
      expect(code).toBe(EXIT.ok);
      expect(output).toContain('No budget is set yet');
      expect(output).not.toContain('About to write'); // never reached the confirm
      expect(readFileSync(join(dir, CONFIG_FILE_NAME), 'utf8')).toBe(budgetless);
    });

    it('a budget answered at the forced prompt lands in the written config', async () => {
      const { code } = await wizard([
        'done', // review → forced budget prompt
        '5000', // set one
        'yes', // confirm
        'yes', // overwrite smelt.config.json
      ]);
      expect(code).toBe(EXIT.ok);
      expect(readConfig().defaultBudgetBytes).toBe(5000);
    });
  });
});

describe('smelt init through the CLI', () => {
  it('runs the wizard from runCli, against io.cwd', async () => {
    let stdout = '';
    const io: CliIo = {
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
      initInput: Readable.from([`${MINIMAL_ANSWERS.join('\n')}\n`]),
    };
    const code = await runCli(['init'], io);
    expect(code).toBe(EXIT.ok);
    expect(stdout).toContain('wrote smelt.config.json');
    expect(readConfig()).toMatchObject({ smeltConfig: 1, defaultBudgetBytes: 4000 });
  });

  it('is a usage error when no interactive input is wired', async () => {
    let stderr = '';
    const code = await runCli(['init'], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
    });
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('interactive');
  });

  it('refuses flags: init asks, it does not parse', async () => {
    let stderr = '';
    const code = await runCli(['init', '--budget', '4000'], {
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      stdin: () => '',
      version: '9.9.9-test',
      cwd: dir,
    });
    expect(code).toBe(EXIT.usage);
    expect(stderr).toContain('no flags');
  });
});
