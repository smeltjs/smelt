import { dirname } from 'node:path';

import { reconstruct } from '../../apply.ts';
import { SUPPORTED_LANGUAGES } from '../../detect.ts';
import { CliUsageError, SmeltError } from '../../errors.ts';
import { budgetRequired, openStore, readBlob, resolveStrategy } from '../../ops/inputs.ts';
import { smeltBlob } from '../../ops/verbs.ts';
import { isStrategy, STRATEGIES } from '../../plan/planners.ts';
import type { Strategy } from '../../plan/planners.ts';
import { loadRerankStage } from '../../rerank/load.ts';
import { MemoryElisionStore } from '../../store.ts';
import type { DetectedLanguage, ElisionStore, SmeltResult } from '../../types.ts';
import { CONFIG_FILE_NAME, configuredStore } from '../config.ts';
import type { ConfiguredStore, LoadedConfig, SmeltConfigRerank } from '../config.ts';
import { stderrPalette } from '../lava.ts';
import { formatReport } from '../report.ts';
import { CLI_NAME, EXIT } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import { flagList, parseBudget, VERB_FLAGS } from './flags.ts';
import type { FlagValues, VerbFlag } from './flags.ts';
import type { ConfigSource, Subcommand } from './subcommand.ts';

/**
 * The default verb: `smelt <file>` and `smelt < input`, plus the `--reconstruct` round
 * trip that reads one of its own `--json` envelopes back.
 *
 * Two jobs, one verb, which is why USAGE lists it twice: `--reconstruct` reads a file
 * this command wrote and puts every byte back, so it takes no budget, no focus and no
 * strategy — but it is the same front door, and giving it a subcommand word would
 * break every script that types `smelt --reconstruct`.
 */

/** What the CLI was asked to do. Pure data, so the parse is testable on its own. */
export interface SmeltInvocation {
  readonly mode: 'smelt' | 'reconstruct' | 'help' | 'version' | 'init';
  /** Path to read. `undefined` means stdin. */
  readonly file?: string;
  /**
   * UTF-8 bytes. `undefined` in `'smelt'` mode means the flag was not given; the
   * runner then consults `smelt.config.json` and errors if that has no default either.
   */
  readonly budgetBytes?: number;
  readonly focus: readonly string[];
  /** The command whose output the blob is, for focus derivation. See `--producer`. */
  readonly producer?: string;
  readonly language?: DetectedLanguage;
  /** `undefined` means the flag was not given — the config default may apply. */
  readonly strategy?: Strategy;
  readonly json: boolean;
}

/**
 * Everything one smelt run needs, fully merged — with a receipt for where each
 * merged value came from.
 *
 * This is the verb's single merge of flags + config + built-ins. Precedence lives
 * here and nowhere else: `resolveRun` is the only code that may look at a flag and a
 * config default side by side, so a precedence question is always answered by one
 * function instead of by reading two files. `runSmelt` executes this object
 * straight-line, without a `??` of its own.
 */
export interface ResolvedRun {
  readonly budgetBytes: number;
  /** Where the budget came from. A missing budget never gets here — it throws. */
  readonly budgetSource: 'flag' | 'config';
  readonly strategy: Strategy;
  readonly strategySource: 'flag' | 'config' | 'builtin';
  /**
   * The store decision, with `path` already resolved against the config file's
   * directory. `'memory'` is the built-in default — a fresh in-memory store per run.
   */
  readonly store: ConfiguredStore;
  /** Path to read. `undefined` means stdin. Flags only; the config has no say. */
  readonly file?: string;
  readonly focus: readonly string[];
  readonly producer?: string;
  readonly language?: DetectedLanguage;
  readonly json: boolean;
  /**
   * The reranker opt-in, exactly as the config wrote it, plus the directory its `path`
   * resolves against — the config file's own directory, like `store.path`.
   *
   * The *decision* is merged here; the *loading* is not, and the split is deliberate.
   * `resolveRun` is a pure merge of flags, config and built-ins — it reads no file,
   * imports no module and touches no environment, which is what makes every precedence
   * question answerable by reading one synchronous function. Importing a module off
   * disk and reading an API key out of the environment is execution, so it happens in
   * `runSmelt`, where every other side effect of a run already lives.
   *
   * Absent when the config named no reranker, which is every default config.
   */
  readonly rerank?: { readonly config: SmeltConfigRerank; readonly dir: string };
}

/**
 * The default verb's two resolved shapes.
 *
 * `--reconstruct` merges nothing: there is no budget to default, no strategy to pick
 * and no store to choose, because the envelope carries its own bytes. Saying that in
 * the type is cheaper than a {@link ResolvedRun} whose every field would be a lie for
 * half of this verb's runs.
 */
export type ResolvedSmeltCommand =
  | { readonly kind: 'smelt'; readonly run: ResolvedRun }
  | { readonly kind: 'reconstruct'; readonly file?: string };

/**
 * The `--json` envelope format, versioned like the marker for the same reason: this is
 * a surface other programs parse, so a change to it has to be identifiable rather than
 * silent.
 */
export const CLI_JSON_FORMAT = 'smelt-cli/v1';

/**
 * What `--json` prints, and what `--reconstruct` reads back.
 *
 * `result` is the {@link SmeltResult} **verbatim** — nothing renamed, nothing dropped —
 * so it can be diffed in a test. `elided` is the other half, and it is here because a
 * result on its own is *not* reconstructible: Law 3 is a property of the result plus
 * the store that holds its bytes, and a file claiming to prove the round trip while
 * carrying only half of it would prove nothing.
 */
export interface CliJsonEnvelope {
  readonly format: string;
  readonly result: SmeltResult;
  /** hash → the exact elided bytes. Keys match `result.elisions[].hash`. */
  readonly elided: Readonly<Record<string, string>>;
}

export const smeltCommand: Subcommand<SmeltInvocation, ResolvedSmeltCommand> = {
  name: 'smelt',
  flags: ['budget', 'focus', 'producer', 'language', 'strategy', 'json', 'reconstruct'],
  refusal:
    `A single-blob run reads one file or stdin; there is no tree to walk, ` +
    `nothing to cache, and no harness to install into.`,
  usage: {
    synopsis: [
      '<file> --budget <bytes> [--focus <term>]...',
      '--budget <bytes> [--focus <term>]... < input',
    ],
    occasional: ['--reconstruct <result.json>', '--reconstruct < result.json'],
  },

  parse(values: FlagValues, positionals: readonly string[]): SmeltInvocation {
    if (positionals.length > 1) {
      throw new CliUsageError(
        `${CLI_NAME}: expected at most one file, got ${String(positionals.length)} ` +
          `(${positionals.join(', ')}). smelt reads one blob at a time.`,
      );
    }
    const file = positionals[0];

    if (values.reconstruct === true) {
      refuseReconstructFlags(values);
      return {
        mode: 'reconstruct',
        ...(file === undefined ? {} : { file }),
        focus: [],
        json: false,
      };
    }

    const budgetBytes = parseBudget(values.budget);
    const chosenStrategy = parseStrategy(values.strategy);
    return {
      mode: 'smelt',
      ...(file === undefined ? {} : { file }),
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
      focus: values.focus ?? [],
      ...(values.producer === undefined ? {} : { producer: values.producer }),
      ...(values.language === undefined ? {} : { language: parseLanguage(values.language) }),
      ...(chosenStrategy === undefined ? {} : { strategy: chosenStrategy }),
      json: values.json === true,
    };
  },

  resolve(invocation: SmeltInvocation, config: ConfigSource): ResolvedSmeltCommand {
    if (invocation.mode === 'reconstruct') {
      return {
        kind: 'reconstruct',
        ...(invocation.file === undefined ? {} : { file: invocation.file }),
      };
    }
    return { kind: 'smelt', run: resolveRun(invocation, config()) };
  },

  run(resolved: ResolvedSmeltCommand, io: CliIo): number | Promise<number> {
    if (resolved.kind === 'reconstruct') {
      return runReconstruct(readInput(resolved.file, io), io);
    }
    return runSmelt(resolved.run, io);
  },
};

/**
 * Every flag this verb owns that `--reconstruct` cannot honour, with the reason each
 * one makes no sense — the second job's flag ownership, which the registry cannot
 * express because both jobs are the same verb.
 *
 * `refuseForeignFlags` refuses a flag no verb owns *here*; it cannot refuse `--focus`
 * on a single-blob run, because a single-blob run is exactly where `--focus` belongs.
 * So the ones the round trip ignores are named here instead, and named exhaustively:
 * every flag on `smeltCommand.flags` except `--reconstruct` itself has an entry, which
 * `test/guards/subcommand-registry.test.ts` crosses. A flag added to this verb and
 * forgotten here would be silently ignored by half of the verb's runs — the failure
 * this table exists to make impossible.
 *
 * Key order is the flag table's order, so a refusal lists flags the way every other
 * refusal does.
 */
const RECONSTRUCT_REFUSALS = {
  budget: `Reconstruction puts every byte back; there is nothing to fit.`,
  focus:
    `Focus decides what survives a cut, and the cut has already been made — ` +
    `the envelope names every elision it took.`,
  producer: `A producer only derives a focus, and there is no cut left to focus.`,
  language:
    `Nothing is detected or parsed on the way back: the envelope carries the ` +
    `bytes and the ranges the cut recorded.`,
  strategy: `No planner runs on the way back — the elisions come from the envelope.`,
  json:
    `--reconstruct reads a --json envelope and prints the original text; ` +
    `there is no second envelope to write.`,
} as const satisfies Partial<Record<VerbFlag, string>>;

/**
 * Refuse every flag `--reconstruct` would otherwise ignore, in one message shaped like
 * the ownership refusals: the flags named, then why not here. A {@link CliUsageError},
 * so it exits 2 exactly as every other refusal does.
 *
 * @throws {CliUsageError} naming each offending flag and what the round trip does instead.
 */
function refuseReconstructFlags(values: FlagValues): void {
  const reasons: Partial<Record<VerbFlag, string>> = RECONSTRUCT_REFUSALS;
  const offending = VERB_FLAGS.filter(
    (flag) => reasons[flag] !== undefined && values[flag] !== undefined,
  );
  if (offending.length === 0) return;

  const verb = offending.length === 1 ? 'makes' : 'make';
  const why = offending.map((flag) => reasons[flag] ?? '').join(' ');
  throw new CliUsageError(
    `${CLI_NAME}: ${flagList(offending)} ${verb} no sense with --reconstruct. ${why}`,
  );
}

/**
 * Merge one `'smelt'`-mode invocation with the loaded config (or `undefined` when no
 * `smelt.config.json` exists) and the built-in defaults.
 *
 * The precedence is strict and one-directional: an explicit flag always wins over the
 * config, and the config only fills what the flags left unsaid. Built-ins fill last,
 * and only where a built-in exists at all — the budget deliberately has none, so a run
 * with no budget from either source is refused here, in the one function that owns that
 * error.
 *
 * @throws {CliUsageError} when neither `--budget` nor the config names a budget.
 */
export function resolveRun(
  invocation: SmeltInvocation,
  config: LoadedConfig | undefined,
): ResolvedRun {
  const budgetBytes = invocation.budgetBytes ?? config?.config.defaultBudgetBytes;
  if (budgetBytes === undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: ` +
        budgetRequired({
          knob: '--budget',
          stake: 'your context to throw away',
          advice:
            `Pass --budget, or set defaultBudgetBytes in ${CONFIG_FILE_NAME} ` +
            `(\`${CLI_NAME} init\` writes one).\n` +
            `  ${CLI_NAME} src/server.ts --budget 4000 --focus handleRequest`,
        }),
    );
  }

  const strategy = resolveStrategy(invocation.strategy, config?.config.strategy);

  return {
    budgetBytes,
    budgetSource: invocation.budgetBytes !== undefined ? 'flag' : 'config',
    strategy: strategy.strategy,
    strategySource: strategy.source,
    store: configuredStore(config),
    ...(config?.config.rerank === undefined
      ? {}
      : { rerank: { config: config.config.rerank, dir: dirname(config.path) } }),
    ...(invocation.file === undefined ? {} : { file: invocation.file }),
    focus: invocation.focus,
    ...(invocation.producer === undefined ? {} : { producer: invocation.producer }),
    ...(invocation.language === undefined ? {} : { language: invocation.language }),
    json: invocation.json,
  };
}

/**
 * One smelt run: read the input, hand the resolved values to {@link smeltBlob}, render.
 *
 * All merging — flags versus `smelt.config.json` versus built-ins, including the
 * budget-required refusal — happens in {@link resolveRun}, which is the only place
 * precedence lives. This function reads the resolved object and never consults a flag
 * or a config field directly. The cut itself belongs to no front door: `smeltBlob` in
 * `ops/verbs.ts` builds the smelter and returns the values this function prints, and
 * the `smelt_file` tool calls the same op with its own arguments.
 */
async function runSmelt(run: ResolvedRun, io: CliIo): Promise<number> {
  const inputText = readInput(run.file, io);

  // The opt-in, loaded here and only here: a config with no `rerank` block makes this
  // an `undefined` in and an `undefined` out, and nothing is imported. See
  // `rerank/load.ts` for why the adapter package is never in smelt's import graph.
  const rerank =
    run.rerank === undefined
      ? undefined
      : await loadRerankStage({
          rerank: run.rerank.config,
          configDir: run.rerank.dir,
          env: io.env ?? {},
        });

  const outcome = await smeltBlob({
    text: inputText,
    source: run.file ?? '<stdin>',
    budgetBytes: run.budgetBytes,
    strategy: run.strategy,
    store: openStore(run.store),
    ...(run.file === undefined ? {} : { path: run.file }),
    ...(run.language === undefined ? {} : { language: run.language }),
    focus: run.focus,
    ...(run.producer === undefined ? {} : { producer: run.producer }),
    ...(rerank === undefined ? {} : { rerank }),
  });

  if (run.json) {
    io.stdout(`${JSON.stringify(envelope(outcome.result, outcome.store), null, 2)}\n`);
  } else {
    io.stdout(outcome.result.text);
  }
  // The report goes to stderr, so it is painted by the stderr switch: `smelt big.log
  // --budget 4000 > small.log` leaves the payload in a file and this report on a
  // terminal, and that is the half a person reads.
  io.stderr(formatReport(outcome, stderrPalette(io)));

  return outcome.result.outputBytes > run.budgetBytes ? EXIT.overBudget : EXIT.ok;
}

/**
 * Law 3, from a shell.
 *
 * This is deliberately not "print the text and hope": it rebuilds the store from the
 * envelope, checks every hash against the bytes it claims to key, and checks the
 * reconstructed length against the `inputBytes` the result recorded at the time of the
 * cut. A round trip that quietly returns almost-right text is the failure this whole
 * repository is arranged against.
 */
function runReconstruct(text: string, io: CliIo): number {
  const { result, elided } = parseEnvelope(text);
  const store = new MemoryElisionStore();

  for (const [hash, content] of Object.entries(elided)) {
    const actual = store.put(content);
    if (actual !== hash) {
      throw new CliUsageError(
        `${CLI_NAME}: envelope is not self-consistent — it stores bytes under ` +
          `"${hash}" that actually hash to "${actual}". Refusing to reconstruct from it.`,
      );
    }
  }
  for (const elision of result.elisions) {
    if (!store.has(elision.hash)) {
      throw new CliUsageError(
        `${CLI_NAME}: envelope is missing the bytes for "${elision.hash}". A result ` +
          `without its elided bytes cannot be reconstructed; re-run with --json.`,
      );
    }
  }

  const original = reconstruct(result, store);
  const bytes = Buffer.byteLength(original, 'utf8');
  if (bytes !== result.inputBytes) {
    throw new SmeltError(
      `${CLI_NAME}: reconstruction produced ${String(bytes)} bytes but the result ` +
        `recorded ${String(result.inputBytes)}. The round trip did not close.`,
    );
  }

  io.stdout(original);
  const lava = stderrPalette(io);
  io.stderr(
    `${lava.paint('brand', CLI_NAME)}  reconstructed ` +
      `${lava.paint('number', String(result.inputBytes))} B from ` +
      `${String(result.elisions.length)} elisions — ${lava.paint('good', 'byte for byte')}\n`,
  );
  return EXIT.ok;
}

/** `peek`, not `retrieve`: writing a file is not the model asking for anything back. */
function envelope(result: SmeltResult, store: ElisionStore): CliJsonEnvelope {
  const elided: Record<string, string> = {};
  for (const elision of result.elisions) {
    const content = store.peek(elision.hash);
    if (content === undefined) {
      throw new SmeltError(
        `${CLI_NAME}: the store does not hold "${elision.hash}", which its own result ` +
          `says it elided. Refusing to write an envelope that cannot round-trip.`,
      );
    }
    elided[elision.hash] = content;
  }
  return { format: CLI_JSON_FORMAT, result, elided };
}

function parseEnvelope(text: string): CliJsonEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new CliUsageError(
      `${CLI_NAME}: --reconstruct expected a --json envelope, and this is not JSON: ` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  if (typeof value !== 'object' || value === null) {
    throw new CliUsageError(`${CLI_NAME}: --reconstruct expected a JSON object.`);
  }
  const fields = value as Record<string, unknown>;

  if (fields['format'] !== CLI_JSON_FORMAT) {
    throw new CliUsageError(
      `${CLI_NAME}: this envelope says format "${String(fields['format'])}"; this build ` +
        `reads "${CLI_JSON_FORMAT}". Formats are versioned so a mismatch is visible ` +
        `instead of being half-understood.`,
    );
  }

  const result = fields['result'];
  if (typeof result !== 'object' || result === null) {
    throw new CliUsageError(`${CLI_NAME}: envelope has no \`result\` object.`);
  }
  const resultFields = result as Record<string, unknown>;
  if (
    typeof resultFields['text'] !== 'string' ||
    typeof resultFields['inputBytes'] !== 'number' ||
    !Array.isArray(resultFields['elisions'])
  ) {
    throw new CliUsageError(
      `${CLI_NAME}: envelope's \`result\` is missing text, inputBytes or elisions.`,
    );
  }

  const elided = fields['elided'];
  if (typeof elided !== 'object' || elided === null) {
    throw new CliUsageError(`${CLI_NAME}: envelope has no \`elided\` map.`);
  }
  for (const [hash, content] of Object.entries(elided)) {
    if (typeof content !== 'string') {
      throw new CliUsageError(`${CLI_NAME}: envelope's \`elided["${hash}"]\` is not a string.`);
    }
  }

  return {
    format: CLI_JSON_FORMAT,
    result: result as unknown as SmeltResult,
    elided: elided as Record<string, string>,
  };
}

/**
 * The blob to work on: stdin when no file was named, otherwise the file — read
 * through the ops law, so "cannot read X" says the same thing here and in the
 * `smelt_file` tool. Only the stdin leg is the CLI's own; a tool has no stdin.
 */
function readInput(file: string | undefined, io: CliIo): string {
  if (file === undefined) return io.stdin();
  const read = readBlob(file, file);
  if (!read.ok) throw new CliUsageError(`${CLI_NAME}: ${read.refusal}`);
  return read.value;
}

function parseLanguage(raw: string): DetectedLanguage {
  const known: readonly string[] = [...SUPPORTED_LANGUAGES, 'unknown'];
  if (!known.includes(raw)) {
    throw new CliUsageError(
      `${CLI_NAME}: unknown --language "${raw}". Known: ${known.join(', ')}.`,
    );
  }
  return raw as DetectedLanguage;
}

/** Membership in the {@link PLANNERS} registry is the whole validation. */
function parseStrategy(raw: string | undefined): Strategy | undefined {
  if (raw === undefined) return undefined;
  if (!isStrategy(raw)) {
    throw new CliUsageError(
      `${CLI_NAME}: unknown --strategy "${raw}". Known: ${STRATEGIES.join(', ')}.`,
    );
  }
  return raw;
}
