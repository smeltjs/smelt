#!/usr/bin/env node
/**
 * The mutation runner — smelt's answer to "how do you know that check works?"
 *
 * A check nobody has watched fail is not known to work. So every guard in this repo
 * ships with at least one *mutation*: a specific, minimal break in the source that the
 * guard must catch — and the mutations live **with their guard**: each
 * `test/guards/*.test.ts` exports `MUTATIONS: GuardMutation[]` beside the assertions
 * that must notice the break (`test/guards/_mutations.ts` holds the shape). This file
 * is only the runner: it discovers the guard files — in **every workspace package**
 * that has a `test/guards/` directory (`packages/core` and `packages/mcp` today; a new
 * package joins by existing) — extracts each one's mutations, copies the owning
 * package's `src` to a scratch directory, applies one mutation, points the guard at
 * the copy via `SMELT_GUARD_SRC`, and asserts the guard goes **red**. A
 * mutation the guard survives is reported as a failure of the *guard*, not of the
 * mutation — and the run ends with the real tally, counted from the guard files
 * themselves and written to `guards.json` at the repository root, never typed into
 * prose (the freshness check below holds the committed copy to that, and every
 * document that wants the number reads it from there).
 *
 * It also runs every guard against the pristine tree first, because a guard that fails
 * on clean source proves nothing when it fails on broken source.
 *
 * Two kinds of mutation exist, because not every guard guards source code:
 *
 *   - `kind: 'src'` (the default) breaks a file under the owning package's `src`, and
 *     the guard is pointed at the broken copy via `SMELT_GUARD_SRC`.
 *   - `kind: 'artifact'` breaks a *committed artefact* — a generated file, for
 *     instance — resolved against the owning package first and the repository root
 *     second, in a scratch root the guard reads via `SMELT_GUARD_ROOT`. Nothing in the
 *     working tree is touched either way, which matters: a mutation runner that edits
 *     tracked files and crashes leaves the repo broken, and the whole point is that a
 *     failure here is safe.
 *
 * Flags, all of which exit before any mutation runs:
 *
 *   - `--print-guards` writes the `guards.json` this run counted to stdout (what the
 *     freshness guard compares the committed file against).
 *   - `--write-guards` writes it to the repository root — `pnpm generate:guards`.
 *
 * Convention, for anyone adding a guard:
 *
 *   1. Import the library through `@guard/...` so the alias can be redirected, and read
 *      committed artefacts through `guardRoot()` so they can be too.
 *   2. Export `MUTATIONS: GuardMutation[]` from the guard file itself: the exact source
 *      string to break, and why that break matters, beside the assertions that must
 *      catch it. Entries are literal data — see `test/guards/_mutations.ts`.
 *   3. Run `pnpm mutate`. If the guard survives, the guard is wrong.
 *
 * `find` must match exactly once. A mutation that silently no-ops because the source
 * moved is the same class of bug the guards exist to catch, so it is a hard error.
 *
 * How the mutations get out of the guard files: the guards are TypeScript test modules
 * that call vitest's `describe` at import time, so they cannot be imported here — not
 * by any Node in the supported range (20.19 runs no TypeScript at all), and not after a
 * tsc emit either, because `describe` outside a vitest runner throws. Booting a whole
 * vitest just to read data would make the safety tool heavier than the suite it checks.
 * So the runner extracts each `MUTATIONS` array literal textually and lets **V8 parse
 * it**: the declaration anchor is the exact shape prettier enforces (and
 * `pnpm format:check` gates), and the literal is evaluated in an empty `node:vm`
 * sandbox — no hand-written string/escape parsing anywhere, and an entry that is not
 * literal data (an identifier, an import) fails loudly with the file named. Every
 * failure mode in this pipeline is a hard error naming the guard file; nothing no-ops.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import process from 'node:process';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packagesDir = join(repoRoot, 'packages');
const scratchDir = join(repoRoot, '.mutants');
/**
 * Where each guard run's structured result lands — one file, reused (overwritten)
 * across every sequential run, never committed. See {@link runGuard} for why a JSON
 * reporter rides alongside the human-readable `dot` one.
 */
const reportPath = join(tmpdir(), `smelt-mutate-report-${String(process.pid)}.json`);

function die(message) {
  console.error(`mutate: ${message}`);
  process.exit(1);
}

/**
 * Every workspace package that carries guards, discovered rather than listed — a new
 * package joins the pristine check and the mutation run by having a `test/guards/`
 * directory. `packages/core` must always be among them: a refactor that silently
 * dropped the core's guards from discovery would turn this whole runner vacuous.
 */
const PACKAGES = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    name: entry.name,
    dir: join(packagesDir, entry.name),
    sourceDir: join(packagesDir, entry.name, 'src'),
    guardsDir: join(packagesDir, entry.name, 'test/guards'),
  }))
  .filter((pkg) => existsSync(pkg.guardsDir))
  .toSorted((a, b) => a.name.localeCompare(b.name));
if (!PACKAGES.some((pkg) => pkg.name === 'core')) {
  die('packages/core/test/guards was not discovered — the core guards are the floor');
}

/**
 * Every guard file, discovered rather than listed — a new guard joins the pristine
 * check and the mutation run by existing. Files starting with `_` are shared
 * helpers (`_source.ts`, `_mutations.ts`), not guards — so a helper must never be a
 * `.test.ts` file: vitest would execute it while this discovery skipped its
 * mutations, a silent drop. The same goes for subdirectories: vitest's include is
 * `test/**\/*.test.ts` (recursive), this discovery is one level deep on purpose, and
 * the gap between the two must be a hard error rather than an invisible hole.
 */
const GUARDS = PACKAGES.flatMap((pkg) => {
  const guardEntries = readdirSync(pkg.guardsDir, { withFileTypes: true });
  for (const entry of guardEntries) {
    if (entry.isDirectory()) {
      die(
        `packages/${pkg.name}/test/guards/${entry.name}/ is a subdirectory — vitest ` +
          `would run tests inside it, but mutation discovery is deliberately flat, so ` +
          `its MUTATIONS would silently never execute. Keep guards directly under ` +
          `test/guards/.`,
      );
    }
    if (entry.name.startsWith('_') && entry.name.endsWith('.test.ts')) {
      die(
        `packages/${pkg.name}/test/guards/${entry.name} is both underscore-prefixed ` +
          `(a helper, skipped by discovery) and a .test.ts file (executed by vitest) — ` +
          `its MUTATIONS would silently never run. Rename the helper without ` +
          `.test.ts, or drop the prefix.`,
      );
    }
  }
  const files = guardEntries
    .map((entry) => entry.name)
    .filter((entry) => entry.endsWith('.test.ts') && !entry.startsWith('_'))
    .toSorted();
  if (files.length === 0) {
    die(
      `no guard files found under packages/${pkg.name}/test/guards — a directory of ` +
        `guards with no guards is a vacuous run wearing a convention`,
    );
  }
  return files.map((file) => ({
    pkg,
    file: `test/guards/${file}`,
    label: `${pkg.name}: test/guards/${file}`,
  }));
});
if (GUARDS.length === 0)
  die('no guard files found under packages/*/test/guards — a vacuous run proves nothing');

/**
 * Extract one guard's MUTATIONS.
 *
 * The anchors are the exact declaration prettier produces (`export const MUTATIONS:
 * GuardMutation[] = [` … `\n];`), so they are as stable as the repo's own formatting
 * gate; V8 parses the literal itself inside an empty sandbox. Alongside the runtime
 * array, the `id:` property lines of the source region are collected for the fusion
 * check below.
 */
function extractMutations(guard) {
  const path = join(guard.pkg.dir, guard.file);
  const source = readFileSync(path, 'utf8');

  const declaration = /^export const MUTATIONS: GuardMutation\[\] = \[$/m.exec(source);
  if (declaration === null) {
    die(
      `${guard.label} exports no MUTATIONS — every guard ships its breaks beside its ` +
        `assertions. Add \`export const MUTATIONS: GuardMutation[] = [ … ];\` ` +
        `(see test/guards/_mutations.ts), with at least one entry.`,
    );
  }
  const open = source.indexOf('[', declaration.index);
  const close = source.indexOf('\n];', open);
  if (close === -1)
    die(`${guard.label}: the MUTATIONS literal never closes with a top-level \`];\``);
  const literal = source.slice(open, close + 2); // `[` … `\n]`

  let mutations;
  try {
    // An empty sandbox: entries are literal data, so any identifier reference —
    // an import, a helper, a computed value — throws here, with the file named.
    mutations = runInNewContext(`(${literal})`, {}, { filename: `${guard.label}#MUTATIONS` });
  } catch (error) {
    die(
      `${guard.label}: MUTATIONS did not evaluate as literal data — ` +
        `${error instanceof Error ? error.message : String(error)}. Entries must be ` +
        `plain object literals of strings (concatenation with + is fine).`,
    );
  }
  if (!Array.isArray(mutations) || mutations.length === 0) {
    die(`${guard.label}: MUTATIONS must be a non-empty array`);
  }

  const sourceIds = [...literal.matchAll(/^ {4}id: '([^']+)',$/gm)].map((match) => match[1]);
  return { mutations, sourceIds };
}

/**
 * Self-check: refuse to run over malformed or fused MUTATIONS, in any guard.
 *
 * The trap is specific and has happened three times: a rebase merges two adjacent
 * object literals into one — the `},\n  {` between them collapses away — and
 * JavaScript accepts the result without a murmur: the duplicated keys are legal,
 * the later `id` wins, and one mutation silently stops running. A runner that
 * quietly runs n−1 of its n mutations is precisely the silent failure this file
 * exists to catch, so the check is structural, per guard file: every `id:` line in
 * that file's MUTATIONS source must correspond to exactly one runtime object, every
 * id must be globally unique, and every entry must carry the full GuardMutation
 * shape. Anything else is a hard error naming the file, before anything runs.
 * (In TypeScript a fused literal is also a duplicate-property type error — this
 * keeps the property even when the typechecker has not run.)
 */
function validateMutations(guard, { mutations, sourceIds }, seenIds) {
  const ALLOWED_KEYS = new Set(['id', 'file', 'find', 'replace', 'why', 'kind']);

  for (const [index, mutation] of mutations.entries()) {
    const label = () =>
      `${guard.label}: MUTATIONS[${String(index)}]` +
      (typeof mutation?.id === 'string' ? ` ("${mutation.id}")` : '');
    if (typeof mutation !== 'object' || mutation === null) die(`${label()} is not an object`);
    for (const key of Object.keys(mutation)) {
      if (!ALLOWED_KEYS.has(key)) die(`${label()} carries an unknown key "${key}"`);
    }
    for (const key of ['id', 'file', 'find', 'why']) {
      if (typeof mutation[key] !== 'string' || mutation[key] === '') {
        die(`${label()} needs a non-empty string \`${key}\``);
      }
    }
    if (typeof mutation.replace !== 'string') die(`${label()} needs a string \`replace\``);
    if (mutation.kind !== undefined && mutation.kind !== 'src' && mutation.kind !== 'artifact') {
      die(`${label()} has kind "${String(mutation.kind)}" — only 'src' and 'artifact' exist`);
    }
    if (seenIds.has(mutation.id)) {
      die(
        `mutation id "${mutation.id}" appears in both ${seenIds.get(mutation.id)} and ` +
          `${guard.label} — every id must be unique across all guards`,
      );
    }
    seenIds.set(mutation.id, guard.label);
  }

  if (sourceIds.length !== mutations.length) {
    // A fused object contributes two `id:` lines to the source but one object at
    // runtime, whose later id wins — so the id that vanished is the first source
    // id the runtime list no longer has, and its partner is the source id that
    // follows it inside the same fused literal.
    const runtimeSet = new Set(mutations.map((mutation) => mutation.id));
    const lost = sourceIds.find((id) => !runtimeSet.has(id));
    if (lost !== undefined) {
      const partner = sourceIds[sourceIds.indexOf(lost) + 1] ?? '(none — trailing id)';
      die(
        `${guard.label}: mutations "${lost}" and "${partner}" appear fused into one object — ` +
          `"${lost}"'s fields were silently overwritten and its mutation no longer runs. ` +
          `Restore the "},\\n  {" boundary between them.`,
      );
    }
    die(
      `${guard.label}: the source declares ${String(sourceIds.length)} id lines but ` +
        `${String(mutations.length)} mutation objects exist — two entries have merged ` +
        `or an id moved`,
    );
  }
}

const seenIds = new Map();
const MUTATIONS_BY_GUARD = GUARDS.map((guard) => {
  const extracted = extractMutations(guard);
  validateMutations(guard, extracted, seenIds);
  return { guard, mutations: extracted.mutations };
});
const totalMutations = MUTATIONS_BY_GUARD.reduce((sum, entry) => sum + entry.mutations.length, 0);

/**
 * Prose drift check, retired: the tally is an artefact now.
 *
 * `guards.json` at the repository root holds what this run just counted — the number
 * of guards, the number of mutations, and the per-guard breakdown — and every document
 * that wants the number reads it there (the site imports it through its build-time
 * generator; README.md and docs/ARCHITECTURE.md state the mechanism and point at the
 * file). The number used to live in four pieces of prose, and reconciling it after a
 * guard gained a mutation took five commits in one day; one of the four was worded past
 * the regex that was supposed to catch exactly that.
 *
 * So: the runner refuses when the committed file disagrees with the guard files, the
 * way `THIRD-PARTY.md`'s guard refuses a stale notices file. `--write-guards` writes
 * it (`pnpm generate:guards`), `--print-guards` prints it for a guard to compare
 * against, and both exit before a single mutation runs.
 */
const GUARDS_MANIFEST = 'guards.json';

/** What this run counted, as the committed artefact spells it. */
function guardsManifest() {
  return {
    guards: GUARDS.length,
    mutations: totalMutations,
    byGuard: MUTATIONS_BY_GUARD.map(({ guard, mutations }) => ({
      guard: `packages/${guard.pkg.name}/${guard.file}`,
      count: mutations.length,
    })),
  };
}

/** The artefact's exact bytes — one renderer, so writer and comparer cannot differ. */
function renderGuardsManifest() {
  return JSON.stringify(guardsManifest(), null, 2) + '\n';
}

function assertGuardsManifestCurrent() {
  const path = join(repoRoot, GUARDS_MANIFEST);
  const rendered = renderGuardsManifest();
  const committed = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (committed === rendered) return;
  const counted = `${String(totalMutations)} mutations across ${String(GUARDS.length)} guards`;
  die(
    committed === undefined
      ? `${GUARDS_MANIFEST} is missing. The guard files hold ${counted}. Run ` +
          `\`pnpm generate:guards\` and commit the result.`
      : `${GUARDS_MANIFEST} is stale — it disagrees with the guard files, which hold ` +
          `${counted}. It is generated, never edited by hand: run \`pnpm generate:guards\` ` +
          `and commit the result.`,
  );
}

if (process.argv.includes('--print-guards')) {
  process.stdout.write(renderGuardsManifest());
  process.exit(0);
}
if (process.argv.includes('--write-guards')) {
  writeFileSync(join(repoRoot, GUARDS_MANIFEST), renderGuardsManifest());
  console.log(
    `mutate: ${String(totalMutations)} mutations across ${String(GUARDS.length)} guards → ` +
      `${GUARDS_MANIFEST}`,
  );
  process.exit(0);
}

assertGuardsManifestCurrent();

/**
 * Run one guard file, both for its human-readable console output (`dot`, unchanged)
 * and — the reason a second reporter rides alongside it — a structured verdict
 * `classifyRun` can trust without parsing formatted text. `dot` alone cannot tell
 * "the assertion this guard exists for went red" from "vitest could not even load the
 * file" apart: both exit non-zero, and a naive `status !== 0` reads a syntax error, a
 * missing import, or a module that throws at the top level as a caught mutation —
 * exactly the silent failure this runner exists to refuse (see `classifyRun`).
 *
 * `--reporter=json --outputFile=<reportPath>` writes vitest's own count of tests it
 * actually ran to a scratch file (one path, overwritten every run — these run
 * sequentially, never concurrently), read back below and never committed.
 */
function runGuard(guard, guardSrc, guardRoot = guard.pkg.dir) {
  rmSync(reportPath, { force: true });
  const run = spawnSync(
    './node_modules/.bin/vitest',
    ['run', guard.file, '--reporter=dot', '--reporter=json', `--outputFile=${reportPath}`],
    {
      cwd: guard.pkg.dir,
      env: { ...process.env, SMELT_GUARD_SRC: guardSrc, SMELT_GUARD_ROOT: guardRoot },
      encoding: 'utf8',
    },
  );
  run.report = readJsonReport();
  return run;
}

/**
 * The JSON reporter's own tally, or `undefined` when it never wrote one (vitest itself
 * failed to start — an even earlier failure than a crashed test file). Returning
 * `undefined` rather than guessing a shape keeps {@link classifyRun} honest about what
 * it does not know.
 */
function readJsonReport() {
  if (!existsSync(reportPath)) return undefined;
  try {
    return JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * What a guard run actually was, distinguishing the two ways `status !== 0` happens:
 *
 *   - **`'caught'`** — the guard file loaded, its assertions ran, and at least one
 *     failed. This is what a mutation is *supposed* to produce: the guard noticed.
 *   - **`'crashed'`** — vitest could not run the guard's tests at all (a syntax error
 *     in the mutant, an import that no longer resolves, a top-level throw). Exit code
 *     alone is identical to `'caught'`, but nothing was actually asserted — the guard
 *     went red for a reason that has nothing to do with what it exists to check, which
 *     is a hole, not a save. `numTotalTests === 0` on a failed run is vitest's own
 *     signal for this: a suite that failed to *load* runs zero tests, where a suite
 *     whose assertions failed always ran at least one (`test/guards/mutate-*` fixtures
 *     pin both shapes; see the doc comment on the runner as a whole).
 *   - **`'pass'`** — exit 0, the guard is green.
 *
 * A missing or unparseable JSON report on a non-zero exit is treated as `'crashed'`
 * too — the conservative reading: this function must never call a run `'caught'`
 * without positive evidence a real assertion failed.
 */
function classifyRun(run) {
  if (run.status === 0) return 'pass';
  if (run.report !== undefined && run.report.numTotalTests > 0) return 'caught';
  return 'crashed';
}

function firstFailureLine(output) {
  const line = output
    .split('\n')
    .find((l) => /AssertionError|Error:|×|✗/.test(l) && l.trim() !== '');
  return line === undefined ? '(no failure line captured)' : line.trim();
}

const results = [];
let failed = 0;

console.log('\n=== pristine source: every guard must be green ===\n');
for (const guard of GUARDS) {
  const run = runGuard(guard, guard.pkg.sourceDir);
  const ok = run.status === 0;
  if (!ok) failed += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${guard.label}`);
  if (!ok) console.log(run.stdout + run.stderr);
}

console.log('\n=== mutations: every guard must go red ===\n');
rmSync(scratchDir, { recursive: true, force: true });

for (const { guard, mutations } of MUTATIONS_BY_GUARD) {
  for (const mutation of mutations) {
    const kind = mutation.kind ?? 'src';
    const scratch = join(scratchDir, mutation.id);
    let guardSrc = guard.pkg.sourceDir;
    let guardRoot = guard.pkg.dir;
    let target;

    if (kind === 'src') {
      const mutantSrc = join(scratch, 'src');
      mkdirSync(dirname(mutantSrc), { recursive: true });
      cpSync(guard.pkg.sourceDir, mutantSrc, { recursive: true });
      // The bundled grammars sit beside `src` in the real package, and the grammar
      // loader resolves them relative to its own module — so a mutant tree needs its own
      // copy, or a structural guard would go red for the wrong reason (a missing
      // grammar, not the mutation).
      const grammarsDir = join(guard.pkg.dir, 'grammars');
      if (existsSync(grammarsDir)) {
        cpSync(grammarsDir, join(scratch, 'grammars'), { recursive: true });
      }
      guardSrc = mutantSrc;
      target = join(mutantSrc, mutation.file);
    } else {
      // Only the artefact is copied. The guard still reads the real manifest, the real
      // grammars and the real generator — the *committed* copy is the thing being staled.
      //
      // An artefact is resolved against the owning package first and the repository
      // root second: `guards.json` is the tally across *every* package's guards, so it
      // belongs to none of them, while `package.json` exists at both levels and the
      // package's is the one a package guard means. Either way the guard reads it
      // through `guardRoot()` at the same relative path, so nothing else changes.
      const packaged = join(guard.pkg.dir, mutation.file);
      const source = existsSync(packaged) ? packaged : join(repoRoot, mutation.file);
      if (!existsSync(source)) {
        die(
          `${mutation.id}: artefact "${mutation.file}" exists neither under ` +
            `packages/${guard.pkg.name}/ nor at the repository root`,
        );
      }
      const mutantRoot = join(scratch, 'root');
      mkdirSync(mutantRoot, { recursive: true });
      cpSync(source, join(mutantRoot, mutation.file));
      guardRoot = mutantRoot;
      target = join(mutantRoot, mutation.file);
    }

    const original = readFileSync(target, 'utf8');
    const occurrences = original.split(mutation.find).length - 1;
    if (occurrences !== 1) {
      console.log(
        `  BROKEN  ${mutation.id}: its anchor matches ${occurrences} times in ` +
          `${kind === 'src' ? 'src/' : ''}${mutation.file}, expected exactly 1. The ` +
          `source moved; fix the mutation.`,
      );
      failed += 1;
      continue;
    }
    writeFileSync(target, original.replace(mutation.find, mutation.replace));

    const run = runGuard(guard, guardSrc, guardRoot);
    const outcome = classifyRun(run);
    const caught = outcome === 'caught';
    // A crash is not a catch: nothing was actually asserted, so it fails the run
    // exactly as a survived mutation does — see `classifyRun`.
    if (outcome !== 'caught') failed += 1;
    results.push({ mutation, caught, outcome, output: run.stdout + run.stderr });

    const label = outcome === 'caught' ? 'CAUGHT ' : outcome === 'crashed' ? 'CRASHED' : 'SURVIVED';
    console.log(`  ${label} ${mutation.id}`);
    console.log(`           mutation: ${mutation.why}`);
    console.log(`           guard:    ${guard.label}`);
    if (outcome === 'caught') {
      console.log(`           red on:   ${firstFailureLine(results.at(-1).output)}`);
    } else if (outcome === 'crashed') {
      console.log(
        '           the guard did not run its assertions at all — vitest could not load ' +
          'the mutant (a syntax error, a broken import, a top-level throw). That is a ' +
          'hole in the mutation, not a catch: fix the mutation so the guard actually runs.',
      );
      console.log(`           vitest said: ${firstFailureLine(results.at(-1).output)}`);
    } else {
      console.log(
        '           the guard did NOT notice. That is a hole in the guard, not in the mutation.',
      );
    }
    console.log('');
  }
}

rmSync(scratchDir, { recursive: true, force: true });
rmSync(reportPath, { force: true });

const caughtCount = results.filter((r) => r.outcome === 'caught').length;
const crashedCount = results.filter((r) => r.outcome === 'crashed').length;
console.log(
  `=== ${String(caughtCount)}/${String(totalMutations)} mutations caught across ` +
    `${String(GUARDS.length)} guards` +
    (crashedCount > 0 ? ` (${String(crashedCount)} CRASHED — not a catch)` : '') +
    ' ===\n',
);

if (failed > 0) {
  console.error(
    crashedCount > 0
      ? 'mutation testing failed. A guard that crashed instead of asserting proved ' +
          'nothing, and a guard that cannot go red is not a guard.\n'
      : 'mutation testing failed. A guard that cannot go red is not a guard.\n',
  );
  process.exit(1);
}
