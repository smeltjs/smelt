import { shimFromSchema } from '../hooks/shim.ts';
import type { HarnessHookSchema, ShimAdapter } from '../hooks/shim.ts';
import type { TomlValue } from '../text/toml-edit.ts';

import type { InstallScope } from './scope.ts';

/**
 * Everything smelt knows about one agent harness, in one place.
 *
 * Before this module existed, a harness's facts lived at seven edit sites: the
 * `HarnessId` union, the `HARNESSES` array, a shim file, a case in `planInstall`, a
 * case in `planRemove`, `MANAGED_EVENTS`, a test fixture — plus a hand-typed id list
 * in the `--harness` help text, which could not be derived because the registry lived
 * in `cli/hooks.ts` and `cli/hooks.ts` imports `CLI_NAME` from `cli/args.ts`. The
 * registry was in the wrong module, and the cycle was the proof.
 *
 * A `HarnessProfile` is the single adapter carrying every per-harness fact, and the
 * registry (`registry.ts`) is `Record<HarnessId, HarnessProfile>` so totality stays a
 * compile error: a new `HarnessId` without a profile does not build. It imports
 * nothing from `cli/`, so `cli/args.ts` derives the `--harness` list and every other
 * rendered view is derived too — the managed event names, the files a re-run reads its
 * toggles back from, the id list in an error message.
 *
 * Installing and removing are **data**, not switch statements: `install` is the list
 * of artefacts `smelt hooks install` writes for this harness, and each artefact's kind
 * is also how `smelt hooks remove` takes it back out — a JSON hook file is merged and
 * strip-merged, a marker block is upserted and stripped, a file that is entirely ours
 * is written and deleted. `planInstall`/`planRemove` fold over the list.
 *
 * The optional sections state capability, never invent it: a harness ships a shim
 * exactly when it carries a {@link hooks} schema (or, for a harness a table cannot
 * express, a hand-written {@link shim}), and only such a profile has a shim script
 * path. What a profile does not claim, the installer does not write.
 */
export interface HarnessProfile {
  readonly id: HarnessId;
  /** The harness's own name, as its makers spell it. Shown wherever a tier is. */
  readonly name: string;
  /**
   * The name a *list* of harnesses uses, where the maker's own spelling carries a
   * category suffix a list does not need — "Codex CLI" is "Codex" in a tier clause,
   * "Hermes Agent" is "Hermes". Optional, and defaulted by {@link harnessLabel} to
   * {@link name}: only a harness whose prose name differs from its full name carries
   * one, and it carries it here rather than in each of the four places a tier list is
   * rendered. "Claude Code" has no suffix to drop, and so has none.
   */
  readonly shortName?: string;
  readonly tier: HarnessTier;
  /** Paths (relative to the project) whose existence means "this harness is in use here". */
  readonly detect: readonly string[];
  /** Paths relative to the user's home directory — "installed on this machine". */
  readonly detectHome: readonly string[];
  /** The standing-instructions file this harness reads (capability matrix column d). */
  readonly instructionFile: string;
  /**
   * The **documented** user-level standing-instructions file, relative to `$HOME` —
   * `.claude/CLAUDE.md`, `.codex/AGENTS.md`, `.gemini/GEMINI.md`. Absent means this
   * harness documents none, and a user-scope install says so instead of writing the
   * project spelling into the home directory, where nothing would read it.
   */
  readonly userInstructionFile?: string;
  /**
   * The standing-instructions layer — belt and braces under every shim, and the *only*
   * layer an advisory harness has:
   *
   *  - `'snippet'`: upsert the shared marker-bracketed block into
   *    {@link instructionFile} (a file several harnesses read, like `AGENTS.md`, is
   *    planned once); `remove` strips the block and leaves every other byte.
   *  - a renderer: a whole file this harness owns, snippet included — KiloCode's rules
   *    file carries two manual enforcement legs the shared snippet has no room for;
   *    `remove` deletes it.
   */
  readonly instructions: 'snippet' | HarnessFileContent;
  /** Caveats carried from the capability matrix, shown at install time. */
  readonly caveats: readonly string[];
  /**
   * Everything else `hooks install` writes for this harness, in the order it is
   * written and listed. Empty means instructions only: the advisory tier, where
   * nothing enforces anything and the output says so.
   */
  readonly install: readonly HarnessInstallStep[];
  /**
   * This harness's native pre-tool hook schema, as data. Present exactly when the
   * harness ships a shim script (`dist/hooks/shims/<id>.js`) — absent for the advisory
   * tier, and for opencode, whose hook API is a JavaScript plugin rather than a stdin
   * schema.
   */
  readonly hooks?: HarnessHookSchema;
  /**
   * The escape hatch: a hand-written adapter, for a harness whose schema a table
   * cannot express. Wins over {@link hooks} when both are present.
   */
  readonly shim?: ShimAdapter;
}

/** How much smelt is willing to claim about a harness. */
export type HarnessTier = 'verified' | 'experimental' | 'advisory';

/**
 * Every harness the preset knows. The registry is keyed by this union, so adding an id
 * without writing its profile is a compile error — and the `--harness` help list, the
 * wizard's table and every error message read the registry, never a second list.
 */
export type HarnessId =
  | 'claude-code'
  | 'codex'
  | 'gemini'
  | 'grok'
  | 'hermes'
  | 'cursor'
  | 'opencode'
  | 'cline'
  | 'kilocode'
  | 'aider';

/** One line of honesty per tier, shown wherever a tier label appears. */
export const TIER_HONESTY: Record<HarnessTier, string> = {
  verified: 'schema verified against primary docs and pinned by fixtures',
  experimental:
    'schema mapped from the 2026-09-02 capability matrix, not yet smoke-tested against the real binary',
  advisory: 'no usable hook API — instructions only, nothing enforces them',
};

/**
 * The tiers, in the order every rendered tier list walks them — most claimed first.
 * {@link TIER_HONESTY}'s key order *is* that order, so a tier cannot exist without a
 * line saying what it means, and the order lives once.
 */
export const HARNESS_TIERS: readonly HarnessTier[] = Object.keys(TIER_HONESTY) as HarnessTier[];

/**
 * How a list of harnesses spells this one: {@link HarnessProfile.shortName} where the
 * maker's own name carries a suffix a list does not need, else {@link
 * HarnessProfile.name}. The help's tier clause, the wizard's sentences and the site's
 * tier table all render through this, so they cannot spell a harness three ways.
 */
export function harnessLabel(profile: HarnessProfile): string {
  return profile.shortName ?? profile.name;
}

/**
 * What the wizard settled on, as the installer's renderers see it: the toggles, the
 * guard's settings, and the project directory every path is relative to. A renderer
 * takes this and returns bytes; nothing writes.
 */
export interface HarnessInstallContext {
  /** Project directory: every path a renderer emits is portable relative to it. */
  readonly cwd: string;
  /**
   * Project or machine. A renderer reads it through `renderRoot(ctx.scope, ctx)`: at
   * project scope a script inside the repo is spelled relative to it, because the
   * config travels with the repo; at user scope nothing travels and the hook runs from
   * whatever project the agent opened, so every path it emits is absolute.
   */
  readonly scope: InstallScope;
  /** The release writing these bytes — stamped into shared blocks for `smelt doctor`. */
  readonly writtenBy?: string;
  readonly guard: boolean;
  readonly statsOnStop: boolean;
  readonly mapOnStart: boolean;
  /** Opt-in `smelt agents lint` at session start — shares SessionStart with the map. */
  readonly lintOnStart: boolean;
  readonly thresholdBytes: number;
  /** The `--budget` every suggested command and the snippet quote. */
  readonly budgetBytes: number;
  /**
   * The package `dist` every rendered script path is named under. Absent means "this
   * install's own", which is every real run; a caller passes one to render a plan for
   * a layout that is not the running one, which is how the installer's stability
   * reporting is exercised without a Homebrew machine.
   */
  readonly distDir?: string;
}

/** A file's bytes, rendered from the wizard's choices. */
export type HarnessFileContent = (ctx: HarnessInstallContext) => string;

/**
 * The **documented** user-level home of one install artefact, relative to `$HOME`.
 *
 * It lives on the profile beside the project path because it is a per-harness fact,
 * exactly like the project path is: `HarnessProfile` keeps owning every per-harness
 * fact, and `harness/scope.ts` is the one resolver that folds a scope and a pair of
 * roots into a path. A step with no `user` location is project-only, and a user-scope
 * install reports it skipped with the reason rather than guessing.
 */
export interface HarnessUserLocation {
  /** The path, relative to the home directory. */
  readonly file: string;
  /**
   * Present when the harness **owns and rewrites** this file, so smelt must not: the
   * value is the exact command a human runs instead. Claude Code's user-scope MCP
   * registration lives under the top-level `mcpServers` key of `~/.claude.json`, a
   * file its own docs say to manage through `/config` and the `claude mcp` CLI rather
   * than by editing — so the step becomes a printed command that setup hands over and
   * doctor checks read-only.
   */
  readonly manual?: string;
}

/**
 * One artefact `hooks install` writes. The kind is also the un-write: `json-hooks` is
 * merged in and strip-merged out, `marker-block` is upserted and stripped,
 * `own-file` is written and deleted, `mcp-registration` is nested-merged in and
 * lifted back out, `toml-mcp-registration` is table-inserted in and table-removed out.
 */
export type HarnessInstallStep =
  | HarnessJsonHooks
  | HarnessMarkerBlock
  | HarnessOwnFile
  | HarnessMcpRegistration
  | HarnessTomlMcpRegistration;

/**
 * A JSON settings/hooks file the harness reads. Our entries are merged in
 * byte-faithfully and, on `remove`, stripped back out with everything foreign left
 * exactly as it was.
 */
export interface HarnessJsonHooks {
  readonly kind: 'json-hooks';
  /** Project-relative path of the file. */
  readonly file: string;
  /** Where this file lives for the whole machine, when the harness documents one. */
  readonly user?: HarnessUserLocation;
  /** The pre-tool event, in this harness's spelling (`PreToolUse`, `BeforeTool`, …). */
  readonly event: string;
  /**
   * One hook entry per matcher — the tool names the guard wants to see. `undefined`
   * is a matcher-less entry, for a harness whose hook fires on every tool.
   */
  readonly matchers: readonly (string | undefined)[];
  /**
   * The entry shape: `'command-list'` is Claude Code's `{matcher, hooks:[{type,
   * command}]}`, which Codex, Gemini and Grok mirror; `'bare-command'` is Cursor's
   * `{command}`.
   */
  readonly entry: 'command-list' | 'bare-command';
  /**
   * True for a harness whose schema also carries the session-lifecycle events this
   * preset offers — `smelt stats` on Stop, `smelt map` and `smelt agents lint` on
   * SessionStart. The other
   * harnesses wire the guard only, and the wizard's toggles say so.
   */
  readonly lifecycle: boolean;
  /** Top-level keys a *fresh* file must carry (Cursor's `version: 1`). */
  readonly shape?: { readonly version: number };
}

/** A marker-bracketed block inside a file smelt shares with its owner. */
export interface HarnessMarkerBlock {
  readonly kind: 'marker-block';
  readonly file: string;
  /** Where this file lives for the whole machine, when the harness documents one. */
  readonly user?: HarnessUserLocation;
  readonly block: HarnessFileContent;
  /** The marker line opening the block — also how `remove` finds it. */
  readonly start: string;
  readonly end: string;
  /**
   * Refuse the file instead of editing it when it already carries `contains` and none
   * of ours: Codex's `config.toml` may have a hand-written `[features]` table, and an
   * installer that merged into it would be editing what it was never asked to.
   */
  readonly skipWhen?: { readonly contains: string; readonly why: string };
}

/** A file that is entirely smelt's: written whole, deleted whole. */
export interface HarnessOwnFile {
  readonly kind: 'own-file';
  readonly file: string;
  /** Where this file lives for the whole machine, when the harness documents one. */
  readonly user?: HarnessUserLocation;
  readonly content: HarnessFileContent;
  /** chmod after writing (Cline's hook must be executable). */
  readonly mode?: number;
  /** True when the file exists only to wire the guard — the guard toggle gates it. */
  readonly guardOnly: boolean;
}

/**
 * An MCP server registration inside a JSON config the harness reads — Claude Code's
 * `.mcp.json` (`mcpServers.smelt`), opencode's `opencode.json` (`mcp.smelt`). The
 * entry is merged in byte-faithfully beside any other servers the user registered,
 * and on `remove` it is lifted back out; a container this install created empty is
 * removed with it, so a file that never carried the key round-trips byte-identical.
 * A harness whose registration is TOML declares {@link HarnessTomlMcpRegistration}
 * instead — a hand-edit into TOML with this step's JSON editor is exactly the edit
 * `text/json-edit.ts` exists to refuse.
 */
export interface HarnessMcpRegistration {
  readonly kind: 'mcp-registration';
  /** Project-relative path of the config file. */
  readonly file: string;
  /** Where this registration lives for the whole machine, when one is documented. */
  readonly user?: HarnessUserLocation;
  /** The container key, then the server's name: `['mcpServers', 'smelt']`. */
  readonly path: readonly [string, string];
  /** The server entry as a JSON value — the bytes are the editor's. */
  readonly entry: (ctx: HarnessInstallContext) => unknown;
}

/**
 * An MCP server registration inside a **TOML** config the harness reads — Codex's
 * `.codex/config.toml` and Grok's `.grok/config.toml`, both `[mcp_servers.<name>]`
 * with `command`/`args` (`text/toml-edit.ts` has the cited shapes). The table is
 * merged in byte-faithfully beside any other servers the user registered — header
 * form or dotted-key form, comments and inline tables elsewhere in the file
 * untouched — and on `remove` it is lifted back out. {@link HarnessMcpRegistration}'s
 * sibling for the one harness family that spells its config in TOML rather than JSON.
 */
export interface HarnessTomlMcpRegistration {
  readonly kind: 'toml-mcp-registration';
  /** Project-relative path of the config file. */
  readonly file: string;
  /** Where this registration lives for the whole machine, when one is documented. */
  readonly user?: HarnessUserLocation;
  /** The container key, then the server's name: `['mcp_servers', 'smelt']`. */
  readonly path: readonly [string, string];
  /** The server entry as a TOML table's body — string/number/boolean/string-array. */
  readonly entry: (ctx: HarnessInstallContext) => Readonly<Record<string, TomlValue>>;
}

/**
 * A profile that ships a shim script. Only these have a shim path: `shimScriptPath`
 * takes one, so a harness with no shim cannot name a script that was never built.
 */
export type ShimmedHarnessProfile = HarnessProfile &
  ({ readonly hooks: HarnessHookSchema } | { readonly shim: ShimAdapter });

/** True for a profile that ships a shim script — the narrowing `shimScriptPath` needs. */
export function hasShim(profile: HarnessProfile): profile is ShimmedHarnessProfile {
  return profile.hooks !== undefined || profile.shim !== undefined;
}

/**
 * The adapter this profile's shim script runs: the one its {@link HarnessProfile.hooks}
 * schema describes, or the hand-written escape hatch where it carries one.
 */
export function shimAdapterOf(profile: ShimmedHarnessProfile): ShimAdapter {
  const { hooks, shim } = profile;
  if (shim !== undefined) return shim;
  /* v8 ignore next 5 -- unreachable: a ShimmedHarnessProfile carries one or the other */
  if (hooks === undefined) {
    throw new Error(
      `smelt: harness "${profile.id}" claims a shim but carries neither a hook schema nor an adapter.`,
    );
  }
  return shimFromSchema(hooks);
}
