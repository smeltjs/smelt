import { CliUsageError } from '../../errors.ts';
import { budgetRequired, readTree } from '../../ops/inputs.ts';
import { mapTree } from '../../ops/verbs.ts';
import type { RepoMap } from '../../repomap/map.ts';
import { CONFIG_FILE_NAME } from '../config.ts';
import type { LoadedConfig } from '../config.ts';
import { PLAIN, stderrPalette } from '../lava.ts';
import { formatMapReport } from '../report.ts';
import { CLI_NAME, EXIT } from '../shell.ts';
import type { CliIo } from '../shell.ts';

import { parseBudget } from './flags.ts';
import type { FlagValues } from './flags.ts';
import type { ConfigSource, Subcommand } from './subcommand.ts';

/**
 * `smelt map <dir>` — the repo map's front door.
 *
 * Deliberately **not** a `--strategy` name: `buildRepoMap` returns a {@link RepoMap},
 * not an `ElisionPlan` — nothing is elided, stored, or reversible — so it gets its own
 * verb and its own envelope instead of a strategy name that would lie about what comes
 * back. And it never exits {@link EXIT.overBudget}: a smelt plan may refuse to cut kept
 * regions and come back too big, while the map fits itself to the budget by
 * construction, so no exit code pretends an over-budget map can happen.
 */

/**
 * `smelt map <dir>` — the repo-map subcommand, parsed. A separate shape rather than
 * more optional fields on `SmeltInvocation`, because the two commands share
 * almost nothing: a map has a directory instead of a file/stdin, an ignore list and
 * a cache directory instead of a language and a strategy.
 */
export interface MapInvocation {
  readonly mode: 'map';
  /** The repository root to map. Always present — `map` without a directory is a usage error. */
  readonly dir: string;
  /** `undefined` means the flag was not given — the config default may apply. */
  readonly budgetBytes?: number;
  readonly focus: readonly string[];
  /** `--ignore` entries, replacing the built-in default list when non-empty. */
  readonly ignore: readonly string[];
  /** `--cache <dir>`: only when given does the map write to disk. */
  readonly cacheDir?: string;
  readonly json: boolean;
}

/**
 * Everything one `smelt map` run needs, fully merged — {@link ResolvedRun}'s sibling,
 * not a contortion of it. The two commands share exactly one merged value (the
 * budget), so they share the *seam* that owns precedence — every verb resolving its
 * own flags against the same config — not a struct whose fields would mostly be lies
 * for one of them: a map has no store, no strategy, no stdin, and its ignore/cache
 * legs mean nothing to a single-blob run.
 */
export interface ResolvedMapRun {
  readonly budgetBytes: number;
  /** Where the budget came from. A missing budget never gets here — it throws. */
  readonly budgetSource: 'flag' | 'config';
  readonly dir: string;
  readonly focus: readonly string[];
  /** `undefined` means "use the library's default ignore list". Flags only. */
  readonly ignore?: readonly string[];
  /** Only when present does the map write to disk. Flags only; the config has no say. */
  readonly cacheDir?: string;
  readonly json: boolean;
}

/**
 * The `smelt map --json` envelope format. Its own version line, because the two
 * envelopes carry different structures and must be able to move independently —
 * a map envelope has no elided bytes to carry, since a map elides nothing.
 */
export const CLI_MAP_JSON_FORMAT = 'smelt-map-cli/v1';

/** What `smelt map --json` prints: the {@link RepoMap} verbatim, versioned. */
export interface CliMapJsonEnvelope {
  readonly format: string;
  /** The {@link RepoMap} exactly as `buildRepoMap` returned it. */
  readonly map: RepoMap;
}

export const mapCommand: Subcommand<MapInvocation, ResolvedMapRun> = {
  name: 'map',
  flags: ['budget', 'focus', 'ignore', 'cache', 'json'],
  refusal:
    `map reads a whole tree, detects each file's language itself, and is not a planner ` +
    `strategy — it returns a map, not an elision plan, and elides nothing, so there is ` +
    `nothing to put back.`,
  usage: {
    synopsis: [
      'map <dir> --budget <bytes> [--focus <term>]... [--ignore <entry>]... [--cache <dir>]',
    ],
    section: {
      heading: 'MAP',
      body:
        `  ${CLI_NAME} map <dir> renders a ranked symbol map of a whole repository — modelled\n` +
        `  on Aider's repo-map (aider.chat/docs/repomap.html, design by Paul Gauthier) — to\n` +
        `  stdout, with a short report on stderr. Local files only: symlinks are never\n` +
        `  followed, binary files are skipped, and the map writes nothing to disk unless\n` +
        `  --cache names a directory. Every included symbol carries a receipt: its\n` +
        `  definition site and the measured reference counts that ranked it. Unlike a\n` +
        `  smelt run, map never exits\n` +
        `  1: a plan can come back over budget because ${CLI_NAME} refuses to cut regions you\n` +
        `  asked to keep, but the map fits itself to the budget by construction — symbols\n` +
        `  are appended in rank order until the next line would not fit.`,
    },
  },

  /**
   * Exactly one directory, and the same budget rules as everywhere else — a missing
   * `--budget` is not an error *here* (the config may carry `defaultBudgetBytes`), a
   * malformed one always is.
   */
  parse(values: FlagValues, positionals: readonly string[]): MapInvocation {
    if (positionals.length < 2) {
      throw new CliUsageError(
        `${CLI_NAME}: map needs the directory to read.\n` +
          `  ${CLI_NAME} map <dir> --budget <bytes> [--focus <term>]...`,
      );
    }
    if (positionals.length > 2) {
      throw new CliUsageError(
        `${CLI_NAME}: map takes exactly one directory, got ` +
          `${String(positionals.length - 1)} (${positionals.slice(1).join(', ')}).`,
      );
    }
    const budgetBytes = parseBudget(values.budget);
    return {
      mode: 'map',
      dir: positionals[1]!,
      ...(budgetBytes === undefined ? {} : { budgetBytes }),
      focus: values.focus ?? [],
      ignore: values.ignore ?? [],
      ...(values.cache === undefined ? {} : { cacheDir: values.cache }),
      json: values.json === true,
    };
  },

  resolve(invocation: MapInvocation, config: ConfigSource): ResolvedMapRun {
    return resolveMapRun(invocation, config());
  },

  run(resolved: ResolvedMapRun, io: CliIo): Promise<number> {
    return runMap(resolved, io);
  },
};

/**
 * Merge one `'map'`-mode invocation with the loaded config and the built-ins. The
 * config contributes exactly what it contributes to a smelt run — `defaultBudgetBytes`,
 * a default the user chose explicitly — and nothing else: the store and strategy legs
 * are single-blob concerns, and the map ignores them rather than reinterpreting them.
 *
 * @throws {CliUsageError} when neither `--budget` nor the config names a budget.
 */
export function resolveMapRun(
  invocation: MapInvocation,
  config: LoadedConfig | undefined,
): ResolvedMapRun {
  const budgetBytes = invocation.budgetBytes ?? config?.config.defaultBudgetBytes;
  if (budgetBytes === undefined) {
    throw new CliUsageError(
      `${CLI_NAME}: ` +
        budgetRequired({
          knob: '--budget',
          stake: 'the map to leave out',
          advice:
            `Pass --budget, or set defaultBudgetBytes in ${CONFIG_FILE_NAME} ` +
            `(\`${CLI_NAME} init\` writes one).\n` +
            `  ${CLI_NAME} map src --budget 4000 --focus handleRequest`,
        }),
    );
  }

  return {
    budgetBytes,
    budgetSource: invocation.budgetBytes !== undefined ? 'flag' : 'config',
    dir: invocation.dir,
    focus: invocation.focus,
    ...(invocation.ignore.length === 0 ? {} : { ignore: invocation.ignore }),
    ...(invocation.cacheDir === undefined ? {} : { cacheDir: invocation.cacheDir }),
    json: invocation.json,
  };
}

/**
 * One `smelt map` run: prove the target is a tree, hand it to {@link mapTree}, render.
 *
 * The merge, including the budget-required refusal, lives in {@link resolveMapRun} —
 * the same arrangement the smelt verb uses over its {@link ResolvedRun}. The walk
 * itself belongs to no front door: the `repo_map` tool calls the same op, and refuses
 * a file with the same sentence in its own vocabulary.
 */
async function runMap(run: ResolvedMapRun, io: CliIo): Promise<number> {
  const tree = readTree(run.dir, run.dir, {
    tree: 'map',
    file: `\`${CLI_NAME} <file>\``,
  });
  if (!tree.ok) throw new CliUsageError(`${CLI_NAME}: ${tree.refusal}`);

  const map = await mapTree({
    root: tree.value,
    budgetBytes: run.budgetBytes,
    focus: run.focus,
    ...(run.ignore === undefined ? {} : { ignore: run.ignore }),
    ...(run.cacheDir === undefined ? {} : { cacheDir: run.cacheDir }),
  });

  if (run.json) {
    const mapEnvelope: CliMapJsonEnvelope = { format: CLI_MAP_JSON_FORMAT, map };
    io.stdout(`${JSON.stringify(mapEnvelope, null, 2)}\n`);
  } else {
    io.stdout(map.text);
  }
  io.stderr(
    formatMapReport(
      { map, source: run.dir, budgetSource: run.budgetSource },
      run.json ? PLAIN : stderrPalette(io),
    ),
  );

  return EXIT.ok;
}
