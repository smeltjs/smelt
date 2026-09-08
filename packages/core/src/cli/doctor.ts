import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { probeHookCommand } from '../harness/hook-command.ts';
import type { HookCommand, HookProbe } from '../harness/hook-command.ts';
import { hasShim } from '../harness/profile.ts';
import { harnessById } from '../harness/registry.ts';
import { resolveScope, scopeRoot } from '../harness/scope.ts';
import type { InstallScope } from '../harness/scope.ts';
import { readStoreSize } from '../store-dir.ts';

import {
  CONFIG_FILE_NAME,
  CONFIG_VERSION,
  VOYAGE_DEFAULT_KEY_ENV,
  VOYAGE_DEFAULT_MODEL,
} from './config.ts';
import type { SmeltConfig } from './config.ts';
import { readInstalledState } from './installed.ts';
import { formatStoreSize } from './report.ts';
import type {
  InstalledBlock,
  InstalledConfig,
  InstalledHookFile,
  InstalledMcp,
} from './installed.ts';
import { CLI_NAME, EXIT } from './shell.ts';

/**
 * `smelt doctor` — the verdicts over InstalledState. The reading lives in
 * `cli/installed.ts` (one reader, behind the three consumers); this module decides
 * and reports: which blocks are behind the running binary, which pieces are orphans,
 * what the repair is, and what the exit code means. Everything the writers wrote,
 * this verb reads back and compares — and never writes a byte of (ADR-0003).
 *
 * When something is behind, the report ends with the exact repair command —
 * `smelt setup`, per harness where a block is behind — and nothing more happens.
 * The exit code carries the verdict, so the other-machine loop — upgrade, doctor,
 * setup — needs no prose parsing.
 *
 * The verdicts are shapes, not restatements: {@link DoctorBlock} and {@link DoctorMcp}
 * are the reader's own types plus what doctor decided, so a field added to the reading
 * reaches the receipt without being retyped here. {@link DoctorConfig} is deliberately
 * *not* an extension of `InstalledConfig` — it carries the two facts (present,
 * malformed) and then a verdict about the parse (`currentSchema`, the store directory),
 * which is doctor's own and belongs to nobody else.
 *
 * **The wiring is probed, not merely seen.** `wired` used to be a text fact: any file
 * carrying an entry of ours. A shim reached through a symlink and a Homebrew keg path
 * an upgrade deleted both leave that text intact while the guard does nothing, so
 * doctor now runs each command it read (`harness/hook-command.ts`) against a synthetic
 * payload in a temp directory and reports `wired (verified)`, `wired but inert` or
 * `wired but missing`. Probing is a read — ADR-0003 holds, doctor still writes no byte
 * of the project.
 */

export interface DoctorIo {
  readonly output: (text: string) => void;
  /** Where installed state is read: config discovery, instruction files, hook files. */
  readonly cwd: string;
  /** The home directory a user-scope reading looks in. Defaults to the real one. */
  readonly home?: string;
  /** The running binary's version — what "current" is measured against. */
  readonly version: string;
  /**
   * The process environment. Read by *name* only, and only for the name the config's
   * `rerank.apiKeyEnv` supplied — and only to report **presence**. Absent means an
   * empty environment; doctor never falls back to `process.env` on its own.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface DoctorOptions {
  readonly json: boolean;
  /**
   * Which install to read: this project, or this machine. Absent means detect —
   * `user` when the working directory *is* the home directory, `project` otherwise.
   * A doctor that read the project paths while the install went to the home directory
   * would report a healthy install where nothing is wired, which is the same silent
   * agreement between writer and reader that InstallScope exists to end.
   */
  readonly scope?: InstallScope;
}

/**
 * One instruction block found on disk, with the release that wrote it and doctor's
 * verdict on it. The reading's own shape (`InstalledBlock`) plus `status` — minus
 * `stampable`, which is *how* the verdict is reached and not part of it.
 */
export type DoctorBlock = Omit<InstalledBlock, 'stampable'> & {
  readonly status: 'current' | 'behind' | 'unversioned';
};

/**
 * The config as doctor saw it. A malformed config is a finding, not a crash.
 *
 * The two facts come from the reading; everything else is the verdict — whether the
 * schema is the one this binary speaks, and whether the store directory the config
 * promises is actually there.
 */
export type DoctorConfig = Pick<InstalledConfig, 'present' | 'malformed'> & {
  readonly schemaVersion?: number;
  readonly currentSchema?: boolean;
  readonly budgetBytes?: number;
  readonly store: {
    readonly kind?: 'directory' | 'memory';
    readonly path?: string;
    readonly dirExists?: boolean;
    /**
     * How many blobs the store directory holds, and how many bytes they are — present
     * only for a directory store that exists and is readable.
     *
     * They are two structured receipt fields rather than a sentence, because a
     * receipt is what an agent reads: `store.bytes` is the exact integer, and the
     * prose line doctor prints is a rendering of it (`formatStoreSize`). Read
     * **without opening the store** — see `readStoreSize`. Doctor never writes, and
     * constructing a store to ask it for `stats()` would author the very directory it
     * is reporting on.
     */
    readonly blobs?: number;
    readonly bytes?: number;
  };
};

/** One MCP registration found (or notably absent) on disk — the reading, verbatim. */
export type DoctorMcp = InstalledMcp;

/** One hook entry doctor read back, and what running it did. */
export interface DoctorHookEntry {
  /** The harness's own spelling of the event: `PreToolUse`, `Stop`, `SessionStart`. */
  readonly event: string;
  readonly kind: HookCommand['kind'];
  /** The script the command names, resolved against the project. */
  readonly script?: string;
  readonly probe: { readonly status: HookProbe['status']; readonly detail: string };
}

/**
 * The reranker opt-in as doctor found it — the one part of installed state that can
 * make smelt talk to somebody else's machine, so it is reported and never assumed.
 *
 * `keyEnv` is the environment variable *name* the config named, and `keySet` says only
 * whether it holds anything. The value is never read into this receipt, never printed,
 * and never logged: a doctor report is a thing people paste into issues.
 */
export interface DoctorRerank {
  /** `'module'` or `'voyage'`, exactly as the config wrote it. */
  readonly kind: 'module' | 'voyage';
  /** `voyage/rerank-2.5`, or `module/./smelt.rerank.ts` — what a report line would say. */
  readonly adapter: string;
  /** The env var the `voyage` kind reads its key from. Absent for `module`. */
  readonly keyEnv?: string;
  /** Whether that variable is set. Presence only — never the value. */
  readonly keySet?: boolean;
  /** For `module`: whether the file the config points at exists. */
  readonly moduleExists?: boolean;
}

/** One hook file, with every command of ours in it and its probe. */
export interface DoctorHookFile {
  readonly file: string;
  readonly harness: string;
  readonly entries: readonly DoctorHookEntry[];
}

/** The machine receipt — `--json`. Everything doctor read, and the verdict. */
export interface DoctorReceipt {
  readonly format: 'smelt.doctor.v1';
  readonly version: string;
  /** True when something is installed and nothing is behind and there are no orphans. */
  readonly current: boolean;
  readonly installed: boolean;
  /** Which install this receipt is about. Always emitted; `project` is the old shape. */
  readonly scope: InstallScope;
  readonly config: DoctorConfig;
  /** The reranker opt-in, when the config carries one. Absent means no reranker. */
  readonly rerank?: DoctorRerank;
  readonly blocks: readonly DoctorBlock[];
  readonly hookFiles: readonly string[];
  readonly mcp: readonly DoctorMcp[];
  /**
   * The wiring, probed — present only when there is a JSON hook file of ours to probe.
   * Additive: `hookFiles` still carries every wired file's name, in the shape it always
   * did, and no field of this receipt has changed spelling or meaning.
   */
  readonly hooks?: readonly DoctorHookFile[];
  readonly orphans: readonly string[];
  readonly repair: readonly string[];
}

export function runDoctor(options: DoctorOptions, io: DoctorIo): number {
  const say = (text: string): void => {
    if (!options.json) io.output(text);
  };
  const orphans: string[] = [];
  const repair: string[] = [];

  const home = io.home ?? homedir();
  const scope = resolveScope(options.scope, { cwd: io.cwd, home });
  const root = scopeRoot(scope, { cwd: io.cwd, home });
  const state = readInstalledState(io.cwd, { scope, home });

  // ── verdict: blocks vs the running binary ──
  const blocks: DoctorBlock[] = state.blocks.map((block) => ({
    file: block.file,
    harnesses: block.harnesses,
    ...(block.installedBy === undefined ? {} : { installedBy: block.installedBy }),
    status: blockStatus(block, io.version),
  }));
  const behindBlocks = blocks.filter((block) => block.status === 'behind');
  for (const block of behindBlocks) {
    repair.push(
      ...block.harnesses.map((id) => `${CLI_NAME} setup --harness ${id}${scopeFlag(scope)}`),
    );
  }

  // ── the wiring, probed: does the command each entry carries still do anything? ──
  const hooks = probeHookFiles(state.hooks, io.cwd);
  const brokenHooks = hooks.filter((file) => hookFileStatus(file) !== 'fires');
  for (const file of brokenHooks) {
    repair.push(`${CLI_NAME} setup --harness ${file.harness}${scopeFlag(scope)}`);
  }
  for (const one of state.mcp) {
    if (one.manual !== undefined && !one.registered) repair.push(one.manual);
  }

  // ── config detail + the store-directory orphan ──
  let config: DoctorConfig = { present: false, store: {} };
  let rerank: DoctorRerank | undefined;
  if (state.config.present) {
    if (state.config.malformed === true || state.config.parsed === undefined) {
      config = { present: true, malformed: true, store: {} };
      orphans.push(
        `${CONFIG_FILE_NAME} is malformed: ${state.config.malformedWhy ?? 'unparseable JSON'}`,
      );
      repair.push(`${CLI_NAME} setup${scopeFlag(scope)}`);
    } else {
      const parsed = state.config.parsed;
      const configPath = state.config.path ?? join(root, CONFIG_FILE_NAME);
      const storeDir =
        parsed.store?.kind === 'directory'
          ? join(dirname(configPath), parsed.store.path)
          : undefined;
      const dirExists = storeDir === undefined ? undefined : existsSync(storeDir);
      const size = storeDir === undefined || !dirExists ? undefined : readStoreSize(storeDir);
      config = {
        present: true,
        schemaVersion: parsed.smeltConfig,
        currentSchema: parsed.smeltConfig === CONFIG_VERSION,
        ...(parsed.defaultBudgetBytes === undefined
          ? {}
          : { budgetBytes: parsed.defaultBudgetBytes }),
        store: {
          ...(parsed.store === undefined ? {} : { kind: parsed.store.kind }),
          ...(parsed.store?.kind === 'directory' ? { path: parsed.store.path } : {}),
          ...(dirExists === undefined ? {} : { dirExists }),
          ...(size === undefined ? {} : { blobs: size.blobs, bytes: size.bytes }),
        },
      };
      if (parsed.store?.kind === 'directory' && dirExists === false) {
        orphans.push(
          `the store directory (${parsed.store.path}) does not exist — retrieves across processes would fail`,
        );
        repair.push(`${CLI_NAME} setup${scopeFlag(scope)}`);
      }

      // The reranker opt-in. Doctor reads it for one reason: it is the only line in
      // this file that can make a smelt run talk to another machine, and "is that
      // switched on here, and does it have what it needs?" must be answerable without
      // running anything. Presence of the key only — never the key.
      rerank = readRerank(parsed.rerank, dirname(configPath), io.env ?? {});
      if (rerank?.keySet === false) {
        orphans.push(
          `rerank is configured (${rerank.adapter}) but ${rerank.keyEnv ?? ''} is not set — ` +
            `every run that would rerank refuses instead`,
        );
        repair.push(`export ${rerank.keyEnv ?? ''}=...`);
      }
      if (rerank?.moduleExists === false) {
        orphans.push(
          `rerank points at ${rerank.adapter.replace('module/', '')}, which does not exist — ` +
            `every run that would rerank refuses instead`,
        );
        repair.push(`${CLI_NAME} init`);
      }
    }
  }

  // ── orphans: pieces whose partners are missing ──
  const wired = state.blocks.length > 0 || state.hookFiles.length > 0;
  if (state.mcp.some((one) => one.registered) && !wired) {
    orphans.push(
      'an MCP registration is present but no hooks wiring is — the guard and the retrieval contract travel together',
    );
    repair.push(`${CLI_NAME} setup${scopeFlag(scope)}`);
  }
  if (wired && !state.config.present) {
    orphans.push(
      'hooks are wired but there is no smelt.config.json — the store and budget the hooks promise live there',
    );
    repair.push(`${CLI_NAME} setup${scopeFlag(scope)}`);
  }

  // ── verdict ──
  const installed = wired || state.config.present || state.mcp.some((one) => one.registered);
  const current =
    installed && behindBlocks.length === 0 && orphans.length === 0 && brokenHooks.length === 0;

  // The suffix only where it says something: a project reading from a project
  // directory is what this line has always meant, and every byte of that prose stays
  // what it was.
  say(
    `${CLI_NAME} doctor — binary ${io.version}, reading ${root}` +
      `${scope === 'user' ? ' (machine scope)' : ''}\n`,
  );
  if (!installed) {
    say(`Nothing of smelt's is installed here. \`${CLI_NAME} setup\` would change that.\n`);
  } else {
    if (config.present) {
      say(
        `  ${CONFIG_FILE_NAME}: ${
          config.malformed === true
            ? 'MALFORMED'
            : `schema ${String(config.schemaVersion)}, budget ${
                config.budgetBytes === undefined ? 'unset' : String(config.budgetBytes)
              }, store ${describeStore(config)}`
        }\n`,
      );
    } else {
      say(`  ${CONFIG_FILE_NAME}: absent\n`);
    }
    for (const block of blocks) {
      say(
        `  ${block.file}: written by ${
          block.installedBy ?? 'a pre-stamping release (unversioned)'
        } [${block.status}] — ${block.harnesses.join(', ')}\n`,
      );
    }
    for (const name of state.hookFiles) {
      say(`  ${name}: ${describeWiring(hooks.find((file) => file.file === name))}\n`);
    }
    for (const one of state.mcp) {
      if (one.registered) say(`  ${one.file}: ${one.server} registered\n`);
      // A registration the harness owns is a step a person runs, so an absent one is
      // reported with the command rather than silently. It does not cost `current`:
      // smelt never wrote it and cannot know it was wanted.
      else if (one.manual !== undefined) {
        say(`  ${one.file}: ${one.server} not registered — run: ${one.manual}\n`);
      }
    }
    if (rerank !== undefined) {
      say(
        `  rerank: ${rerank.adapter}` +
          (rerank.keyEnv === undefined
            ? ''
            : ` — ${rerank.keyEnv} ${rerank.keySet === true ? 'set' : 'missing'}`) +
          `\n`,
      );
    }
    for (const orphan of orphans) say(`  ORPHAN: ${orphan}\n`);
    if (behindBlocks.length > 0) {
      say(
        `\nBehind: the running binary is ${io.version}; re-run setup to bring the ` +
          `installed state to it:\n` +
          [...new Set(repair)].map((command) => `  ${command}\n`).join(''),
      );
    } else if (orphans.length > 0 || brokenHooks.length > 0) {
      say(`\nRepair:\n${[...new Set(repair)].map((command) => `  ${command}\n`).join('')}`);
    }
    say(
      current
        ? `Current: everything on disk agrees with binary ${io.version}.\n`
        : `Not current — see above. Doctor never writes; ${CLI_NAME} setup is the repair.\n`,
    );
  }

  if (options.json) {
    const receipt: DoctorReceipt = {
      format: 'smelt.doctor.v1',
      version: io.version,
      current,
      installed,
      scope,
      config,
      ...(rerank === undefined ? {} : { rerank }),
      blocks,
      hookFiles: [...state.hookFiles],
      mcp: [...state.mcp],
      ...(hooks.length === 0 ? {} : { hooks }),
      orphans,
      repair: [...new Set(repair)],
    };
    io.output(JSON.stringify(receipt, null, 2) + '\n');
  }
  return current || !installed ? EXIT.ok : EXIT.refused;
}

/**
 * The `--scope` a repair command has to carry to repair *this* reading. Project scope
 * is the detected default from a project directory, so it stays silent; a user-scope
 * repair must say so, or the command doctor printed would repair the wrong install.
 */
function scopeFlag(scope: InstallScope): string {
  return scope === 'user' ? ' --scope user' : '';
}

/**
 * The `rerank` block as a receipt line — the one part of a config that can send bytes
 * off the machine, read back as three facts and no more.
 *
 * `keySet` is a boolean over `env[name]`, and that is the whole of what doctor learns
 * about a key. A doctor report is a thing people paste into issue trackers; a verb that
 * printed even a prefix of a secret would be a verb that leaks one eventually.
 */
function readRerank(
  configured: SmeltConfig['rerank'],
  configDir: string,
  env: Readonly<Record<string, string | undefined>>,
): DoctorRerank | undefined {
  if (configured === undefined) return undefined;
  if (configured.kind === 'module') {
    return {
      kind: 'module',
      adapter: `module/${configured.path}`,
      moduleExists: existsSync(join(configDir, configured.path)),
    };
  }
  const keyEnv = configured.apiKeyEnv ?? VOYAGE_DEFAULT_KEY_ENV;
  const key = env[keyEnv];
  return {
    kind: 'voyage',
    adapter: `voyage/${configured.model ?? VOYAGE_DEFAULT_MODEL}`,
    keyEnv,
    keySet: key !== undefined && key !== '',
  };
}

/** The verdict over one block: whole-owned files carry no stamp to compare. */
function blockStatus(block: InstalledBlock, binaryVersion: string): DoctorBlock['status'] {
  if (!block.stampable) return 'unversioned';
  return block.installedBy === binaryVersion ? 'current' : 'behind';
}

/**
 * Every hook file's entries, run.
 *
 * Identical commands are probed **once**: `.claude/settings.json` wires the same shim
 * under two matchers, and spawning it twice would answer the same question twice at a
 * process apiece. The key is the whole command, so two entries that differ at all are
 * still two probes.
 */
function probeHookFiles(
  files: readonly InstalledHookFile[],
  cwd: string,
): readonly DoctorHookFile[] {
  const seen = new Map<string, HookProbe>();
  return files.map((file) => {
    const profile = harnessById(file.harness);
    return {
      file: file.file,
      harness: file.harness,
      entries: file.entries.map((entry) => {
        const key = `${file.harness}\0${JSON.stringify(entry.command)}`;
        let probe = seen.get(key);
        if (probe === undefined) {
          probe =
            /* v8 ignore next 3 -- unreachable: a JSON hook file's harness ships a shim */
            profile === undefined || !hasShim(profile)
              ? { status: 'inert', detail: `${file.harness} ships no shim to probe` }
              : probeHookCommand(entry.command, profile, { cwd });
          seen.set(key, probe);
        }
        return {
          event: entry.event,
          kind: entry.command.kind,
          ...(probe.script === undefined ? {} : { script: probe.script }),
          probe: { status: probe.status, detail: probe.detail },
        };
      }),
    };
  });
}

/**
 * One file's verdict, worst first: anything the probe could not find outranks anything
 * that ran and did nothing, which outranks a file that fires. A file whose entries were
 * all foreign (nothing of ours parsed) has nothing to say and counts as firing — doctor
 * reports what it read, and it read no command of ours there.
 */
function hookFileStatus(file: DoctorHookFile): HookProbe['status'] {
  if (file.entries.some((entry) => entry.probe.status === 'missing')) return 'missing';
  if (file.entries.some((entry) => entry.probe.status === 'inert')) return 'inert';
  return 'fires';
}

/**
 * What a wired file's line says. `wired` alone is the honest answer for a file with no
 * probe behind it — the guard-only files smelt owns whole, which carry no event table
 * to read commands out of.
 */
function describeWiring(file: DoctorHookFile | undefined): string {
  if (file === undefined || file.entries.length === 0) return 'wired';
  const worst = file.entries.find((entry) => entry.probe.status === 'missing');
  if (worst !== undefined) return `wired but missing — ${worst.script ?? worst.probe.detail}`;
  const inert = file.entries.find((entry) => entry.probe.status === 'inert');
  if (inert !== undefined) return `wired but inert — ${inert.probe.detail}`;
  return 'wired (verified)';
}


/**
 * The store, as one clause of the config line. The size half is rendered from the two
 * receipt fields rather than counted here — one arithmetic, two surfaces.
 */
function describeStore(config: DoctorConfig): string {
  if (config.store.kind === undefined) return 'unset';
  if (config.store.kind === 'memory') return 'memory';
  const size =
    config.store.blobs === undefined || config.store.bytes === undefined
      ? ''
      : ` — ${formatStoreSize(config.store.blobs, config.store.bytes)}`;
  return `directory at ${config.store.path ?? ''} (${
    config.store.dirExists ? 'present' : 'MISSING'
  })${size}`;
}
