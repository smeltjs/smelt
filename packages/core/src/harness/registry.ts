import { aider } from './aider.ts';
import { claudeCode } from './claude-code.ts';
import { cline } from './cline.ts';
import { codex } from './codex.ts';
import { cursor } from './cursor.ts';
import { gemini } from './gemini.ts';
import { grok } from './grok.ts';
import { hermes } from './hermes.ts';
import { kilocode } from './kilocode.ts';
import { opencode } from './opencode.ts';
import { harnessLabel, HARNESS_TIERS, TIER_HONESTY } from './profile.ts';
import type { HarnessId, HarnessJsonHooks, HarnessProfile, HarnessTier } from './profile.ts';

/**
 * The registry — every harness smelt knows, one {@link HarnessProfile} each.
 *
 * `Record<HarnessId, HarnessProfile>` on purpose: adding a `HarnessId` in `profile.ts`
 * without writing its profile is a compile error, so the id list and the facts cannot
 * drift. Every derived view — the `--harness` help list, the wizard's table, the
 * managed event names, the files a re-run reads its toggles back from — is computed
 * from this object, never written twice.
 *
 * This module imports **nothing from `cli/`**. That is the point: the registry used to
 * live in `cli/hooks.ts`, which imports `CLI_NAME` from `cli/args.ts`, so `args.ts`
 * could not import it back and the `--harness` help list was hand-typed five lines
 * below two lists that were correctly derived.
 *
 * Key order is meaningful: it is the order every rendered harness list uses (the help
 * text, the wizard's table, the "Known: …" of an unknown-harness error), so keep it
 * stable and append new harnesses at the end.
 */
export const HARNESS_PROFILES: Readonly<Record<HarnessId, HarnessProfile>> = {
  'claude-code': claudeCode,
  codex,
  gemini,
  grok,
  hermes,
  cursor,
  opencode,
  cline,
  kilocode,
  aider,
};

/** Every profile, in registry order. The list every rendered table walks. */
export const HARNESSES: readonly HarnessProfile[] = Object.values(HARNESS_PROFILES);

/** Every harness id, in registry order — the `--harness` help list, derived. */
export const HARNESS_IDS: readonly HarnessId[] = HARNESSES.map((profile) => profile.id);

/** The profile for a harness id, or `undefined` for a string the user made up. */
export function harnessById(id: string): HarnessProfile | undefined {
  return HARNESSES.find((profile) => profile.id === id);
}

/** One tier and the harnesses that ship at it — the row every tier table renders. */
export interface HarnessTierGroup {
  readonly tier: HarnessTier;
  /** That tier's one line of honesty ({@link TIER_HONESTY}), carried with the group. */
  readonly honesty: string;
  /** The profiles at this tier, in registry order. */
  readonly harnesses: readonly HarnessProfile[];
}

/**
 * The tier → harnesses grouping, derived — `HarnessProfile.tier` is data, and this is
 * the one fold over it.
 *
 * It was hand-typed in five places (the `hooks` help body, two wizard sentences, the
 * README's tier table and the site's), so a harness promoted from experimental to
 * verified stayed listed under the old tier in four of them and nothing failed: the
 * only check was that each harness's name appeared *somewhere* in the help. Every
 * rendered grouping now walks this, and `test/guards/harness-registry.test.ts` asserts
 * the rendered ones agree with it — each name under its own tier clause and no other.
 *
 * Tier order is {@link HARNESS_TIERS} (i.e. `TIER_HONESTY`'s key order); a tier no
 * profile claims yields no group, because a rendered "advisory ()" is worse than a
 * tier that has stopped existing.
 */
export function harnessesByTier(): readonly HarnessTierGroup[] {
  return HARNESS_TIERS.map((tier) => ({
    tier,
    honesty: TIER_HONESTY[tier],
    harnesses: HARNESSES.filter((profile) => profile.tier === tier),
  })).filter((group) => group.harnesses.length > 0);
}

/**
 * Whether this harness's native schema carries the session-lifecycle events this preset
 * offers — `smelt stats` on Stop, `smelt map` on SessionStart — i.e. whether it declares
 * a JSON hook step with `lifecycle`.
 *
 * The wizard used to call these "verified-tier harnesses (Claude Code, Codex)", which
 * is a tier standing in for a capability it merely correlates with: the tier is how much
 * smelt is willing to *claim* about a harness, `lifecycle` is whether the harness has
 * the events at all. The two sets coincide today, which is precisely why the sentence
 * read correctly and why nothing could notice it was wrong — so the guard asks this
 * predicate about a profile whose tier and capability *disagree*, and the mutation runner
 * swaps one for the other and watches it go red.
 */
export function wiresLifecycle(profile: HarnessProfile): boolean {
  return profile.install.some((step) => step.kind === 'json-hooks' && step.lifecycle);
}

/** The harnesses the stats/map toggles actually wire, in registry order. */
export function lifecycleHarnesses(): readonly HarnessProfile[] {
  return HARNESSES.filter(wiresLifecycle);
}

/** A list of harnesses as prose spells them — the one join, so the four lists agree. */
export function harnessNames(profiles: readonly HarnessProfile[]): string {
  return profiles.map(harnessLabel).join(', ');
}

/** Every JSON hook step any profile declares, in registry order. */
function jsonHookSteps(): readonly HarnessJsonHooks[] {
  return HARNESSES.flatMap((profile) =>
    profile.install.filter((step): step is HarnessJsonHooks => step.kind === 'json-hooks'),
  );
}

/**
 * The session-lifecycle hooks this preset offers, named in each harness's schema:
 * `smelt stats` when a turn ends, and — sharing one `SessionStart` event — an opening
 * `smelt map` and a lint of the repository's own instruction files. Only the harnesses
 * whose schema carries these events wire them (`step.lifecycle`), and `cli/hooks.ts`
 * writes the entries under these exact keys — one spelling, so the managed-event list
 * below cannot fall behind what the installer writes.
 *
 * `map` and `lint` deliberately name the **same** event. They are two independent
 * toggles under one key, which is why `cli/hooks.ts` merges their entries into one
 * array rather than spreading two objects (the second would silently replace the
 * first) and why a re-run tells them apart by the command each entry runs.
 */
export const LIFECYCLE_EVENTS = {
  stats: 'Stop',
  map: 'SessionStart',
  lint: 'SessionStart',
} as const;

/**
 * The events this installer manages, across every harness's spelling of them —
 * foreign entries under them are always preserved, and events nobody claims are never
 * touched. Derived, so a harness that spells its pre-tool event a new way is managed
 * by existing.
 */
export const MANAGED_EVENTS: readonly string[] = [
  ...new Set(
    jsonHookSteps().flatMap((step) => [
      step.event,
      ...(step.lifecycle ? Object.values(LIFECYCLE_EVENTS) : []),
    ]),
  ),
];

/** The managed events that wire the PreToolUse guard, across harness spellings. */
export const GUARD_EVENTS: readonly string[] = [
  ...new Set(jsonHookSteps().map((step) => step.event)),
];

/** The JSON hook files a re-run reads installed toggles back from, per harness. */
export const JSON_HOOK_FILES: readonly string[] = [
  ...new Set(jsonHookSteps().map((step) => step.file)),
];

/**
 * The same files at **either** scope — the project spelling and, where a harness
 * documents one, the user-level spelling. The predicate "is this file a JSON hook
 * file?" is asked by name, and a name-keyed list that knew only the project spelling
 * would answer no for `~/.claude/settings.json`; four of today's five happen to spell
 * both the same way, which is exactly the kind of coincidence a derived list should
 * not depend on.
 */
export const JSON_HOOK_FILE_NAMES: readonly string[] = [
  ...new Set(
    jsonHookSteps().flatMap((step) =>
      step.user === undefined ? [step.file] : [step.file, step.user.file],
    ),
  ),
];

/** Guard-only files whose presence means the guard toggle was installed. */
export const GUARD_ONLY_FILES: readonly string[] = [
  ...new Set(
    HARNESSES.flatMap((profile) =>
      profile.install
        .filter((step) => step.kind === 'own-file' && step.guardOnly)
        .map((step) => step.file),
    ),
  ),
];
