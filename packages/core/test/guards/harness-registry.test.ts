import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { assertKeyedById } from '@smelt/guard-kit';

// Through @guard, so the mutation runner can point these at a deliberately broken copy
// of `src` and watch them go red. See scripts/mutate.mjs.
import { cliUsage } from '@guard/cli/args';
import { planInstall } from '@guard/harness/plan';
import { harnessLabel, hasShim, shimAdapterOf } from '@guard/harness/profile';
import {
  GUARD_ONLY_FILES,
  harnessesByTier,
  HARNESS_PROFILES,
  HARNESSES,
  JSON_HOOK_FILES,
  lifecycleHarnesses,
  wiresLifecycle,
} from '@guard/harness/registry';
import { DEFAULT_GUARD_SETTINGS } from '@guard/hooks/guard-core';
import {
  renderShimDecision,
  REWRITE_ANNOUNCEMENT_JOIN,
  DENIED_WITHOUT_REASON,
  REWRITE_ANNOUNCEMENT_OPENING,
  rewriteAnnouncement,
} from '@guard/hooks/shim';

import { FIXTURE_BY_HARNESS, harnessPayloads, valueAt } from '../hooks-fixtures.ts';

import type { GuardMutation } from './_mutations.ts';
import { repoRoot } from './_source.ts';

/**
 * HARNESS TOTALITY GUARD — a harness cannot be claimed without tests, and the one
 * announcement cannot quietly become two.
 *
 * The HarnessProfile registry made adding a harness cheap: one file in `src/harness/`
 * carrying the hook schema, the detection paths and the install steps, and the
 * installer, the wizard, the managed event list and the `--harness` help text all
 * follow. That is exactly when the tests stop keeping up — the shim compiles, the
 * schema looks plausible, and the new harness ships with no recorded payload and no
 * proof that its deny reaches the model at all. Six months later a deny lands in a
 * field that harness ignores, silently, and every oversized read sails through.
 *
 * So this guard closes the loops the type system cannot. For **every** profile the
 * registry claims:
 *
 *   1. it is rendered where a user would look for it — the `--harness` list in the
 *      help text (derived from this registry, which is why the registry may not
 *      import `cli/`) and the tier paragraph above it, **under its own tier and no
 *      other**: presence somewhere was the old check, and it let a harness promoted
 *      from experimental to verified stay listed under the tier it had left;
 *   2. if it ships a shim, it has an entry in `FIXTURE_BY_HARNESS` and a recorded
 *      payload file citing the matrix row it came from — `test/hooks-shims.test.ts`
 *      then *is* its schema test, because that suite loops over this same registry;
 *   3. its declared install steps are consistent with what it ships: a harness that
 *      wires a JSON hook command must have a shim script for that command to run.
 *
 * The grouping needs a witness the registry does not write. Every rendered tier list —
 * the help paragraph, the wizard, the site table — now folds over `harnessesByTier()`,
 * so a mis-tiered profile moves all of them at once and they keep agreeing with each
 * other while all of them are wrong. `README.md`'s table is the outside voice: read
 * from the real repository (never a mutant copy), written by hand, and asserted equal
 * to the registry's grouping. `pnpm mutate` mis-tiers a harness and watches it go red
 * there.
 *
 * And the announcement a rewrite makes exists exactly once: three shims and the
 * *generated* opencode plugin — JavaScript this installer writes as text, where a
 * hand-typed copy could drift with nothing to notice — all render the same constants.
 *
 * The fixture table lives in test-land on purpose: the mutation runner redirects only
 * the library (`@guard`), so a mutant that claims a new harness, drops one, or retypes
 * the announcement is measured against the real, committed tests. `pnpm mutate` proves
 * it.
 */

const stat = (path: string): { size: number; isFile: boolean } | undefined =>
  path === '/repo/big.ts' ? { size: 20_000, isFile: true } : undefined;

/**
 * The tier grouping the registry states: tier → the names prose spells it with.
 * Every rendered grouping below is compared against this one.
 */
function registryGrouping(): ReadonlyMap<string, readonly string[]> {
  return new Map(
    harnessesByTier().map((group) => [group.tier, group.harnesses.map(harnessLabel)] as const),
  );
}

/**
 * The tier clauses of the HOOKS paragraph — `verified (Claude Code, Codex)`,
 * `experimental (… — schemas from the capability matrix, not yet smoke-tested)` — as
 * tier → the names inside its parentheses, with the caveat after the em dash dropped.
 *
 * The paragraph is hand-wrapped, so it is flattened first; the sentence itself is
 * unique in the help text.
 */
function helpGrouping(): ReadonlyMap<string, readonly string[]> {
  const flat = cliUsage().replace(/\s+/gu, ' ');
  const sentence = /Harnesses are tiered honestly: (?<clauses>.+?)\. Same discipline/u.exec(flat);
  expect(
    sentence?.groups?.['clauses'],
    'the HOOKS section no longer carries a "Harnesses are tiered honestly: …" sentence — ' +
      'the tier grouping has stopped being rendered where --help shows it',
  ).toBeDefined();
  const clauses = new Map<string, readonly string[]>();
  for (const clause of sentence!.groups!['clauses']!.matchAll(
    /(?<tier>\w+) \((?<names>[^)]*)\)/gu,
  )) {
    const names = clause.groups!['names']!.split(' — ')[0]!;
    clauses.set(clause.groups!['tier']!, names.split(', '));
  }
  return clauses;
}

/**
 * The README's tier table, as tier → the harnesses its second column lists.
 *
 * The README is read from the real repository, never from a mutant copy — which is
 * the point of checking it here. Every *rendered* grouping is derived from
 * `HarnessProfile.tier`, so a mutation that mis-tiers a harness moves the registry and
 * the help text together and nothing they say to each other can notice. The README is
 * the independent witness: a document a human wrote, which a mis-tiered registry now
 * contradicts.
 */
function readmeGrouping(): ReadonlyMap<string, readonly string[]> {
  const readme = readFileSync(join(repoRoot(), 'README.md'), 'utf8');
  const rows = new Map<string, readonly string[]>();
  for (const line of readme.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length !== 5 || cells[0] !== '') continue; // `| a | b | c |` → ['', a, b, c, '']
    const tier = cells[1]!;
    if (!registryGrouping().has(tier)) continue;
    rows.set(tier, cells[2]!.split(', '));
  }
  return rows;
}

describe('the tier grouping is derived, and every rendering of it agrees', () => {
  it('the help text groups each harness under its own tier clause and no other', () => {
    const registry = registryGrouping();
    const help = helpGrouping();
    expect(
      [...help.keys()],
      'the tiers named in the HOOKS paragraph are not the tiers the registry claims',
    ).toEqual([...registry.keys()]);
    for (const [tier, names] of registry) {
      expect(
        help.get(tier),
        `the "${tier}" clause of the HOOKS paragraph does not list exactly the ` +
          `harnesses the registry puts at that tier`,
      ).toEqual(names);
    }
    // The property the old check missed: presence *somewhere* was all it asked, so a
    // promoted harness stayed listed under the tier it had left.
    for (const profile of HARNESSES) {
      for (const [tier, names] of help) {
        expect(
          names.includes(harnessLabel(profile)),
          `${harnessLabel(profile)} is a ${profile.tier} harness but appears in the ` +
            `"${tier}" clause of the help text`,
        ).toBe(tier === profile.tier);
      }
    }
  });

  it("the README's tier table lists exactly what the registry tiers say", () => {
    const registry = registryGrouping();
    const readme = readmeGrouping();
    expect(
      [...readme.keys()],
      'README.md no longer carries a tier table with a row per tier — it is the one ' +
        'rendering of this grouping that is not derived from the registry, and so the ' +
        'only one that can contradict it',
    ).toEqual([...registry.keys()]);
    for (const [tier, names] of registry) {
      expect(
        readme.get(tier),
        `README.md lists "${readme.get(tier)?.join(', ') ?? ''}" at the ${tier} tier, ` +
          `but the registry puts ${names.join(', ')} there. One of the two is wrong, ` +
          `and a reader of the README cannot tell which.`,
      ).toEqual(names);
    }
  });

  it('the lifecycle sentences name a capability, not the tier that correlates with it', () => {
    // `smelt stats` on Stop and `smelt map` on SessionStart are wired exactly where a
    // harness's JSON hook step declares `lifecycle`. The wizard used to call these
    // "verified-tier harnesses", which is true only while the two sets coincide — and
    // they do coincide, so asking about the real registry cannot tell the two rules
    // apart. These are the counterexamples: real profiles whose tier and capability
    // have been made to disagree, one in each direction.
    const byLifecycle = lifecycleHarnesses().map((profile) => profile.id);
    expect(
      byLifecycle.length,
      'no harness declares a lifecycle hook step — the stats/map toggles would wire nothing',
    ).toBeGreaterThanOrEqual(2);
    for (const profile of HARNESSES) {
      expect(byLifecycle.includes(profile.id)).toBe(wiresLifecycle(profile));
    }

    const promoted = { ...HARNESS_PROFILES['cursor'], tier: 'verified' as const };
    expect(
      wiresLifecycle(promoted),
      `${promoted.name} wires only the guard — its schema carries no Stop or ` +
        `SessionStart event — so promoting its tier must not make the wizard promise ` +
        `stats and a map it will never wire`,
    ).toBe(false);
    const demoted = { ...HARNESS_PROFILES['claude-code'], tier: 'advisory' as const };
    expect(
      wiresLifecycle(demoted),
      `${demoted.name}'s schema carries the session events whatever smelt is willing ` +
        `to claim about it — the toggles follow the capability, not the label`,
    ).toBe(true);
  });
});

describe('harness totality — every claimed harness is rendered, tested, and internally consistent', () => {
  it('claims at least the ten shipped harnesses, or the guard is vacuous', () => {
    expect(HARNESSES.length).toBeGreaterThanOrEqual(10);
  });

  it('keys every profile by its own id — `harnessById` finds by field, the wizard reads by key', () => {
    // The one disagreement nothing else here would see: `HARNESSES` and `HARNESS_IDS`
    // are `Object.values` and a map over `profile.id`, so a renamed key leaves every
    // rendered list intact while `HARNESS_PROFILES[id]` starts naming a different
    // profile — or none.
    assertKeyedById(HARNESS_PROFILES, 'id');
  });

  it('every claimed harness reaches the help text — the id list and the tier paragraph', () => {
    const usage = cliUsage();
    for (const profile of HARNESSES) {
      expect(
        usage,
        `${profile.id}: claimed by the registry but absent from the --harness list — ` +
          `the list is derived; a harness missing from it means the derivation broke`,
      ).toContain(profile.id);
      // Which tier clause it lands in is the grouping check above; this only says the
      // HOOKS paragraph names it at all, in the spelling prose uses for it.
      expect(
        usage,
        `${harnessLabel(profile)}: claimed by the registry but named nowhere in the ` +
          `HOOKS section, so nobody reading --help learns the tier it ships at`,
      ).toContain(harnessLabel(profile));
    }
  });

  it('every harness that ships a shim has a cited fixture, and the fixtures claim nothing else', () => {
    const shimmed = HARNESSES.filter(hasShim);
    expect(
      shimmed.length,
      'no harness ships a shim — the fixture loop would be vacuous',
    ).toBeGreaterThanOrEqual(7);
    for (const profile of shimmed) {
      const fixture = FIXTURE_BY_HARNESS[profile.id];
      expect(
        fixture,
        `${profile.id}: ships a shim but has no entry in FIXTURE_BY_HARNESS — add a ` +
          `recorded payload and its expectations before claiming the harness`,
      ).toBeDefined();
      // Cites the matrix row it was recorded from, or throws.
      const payloads = harnessPayloads(profile.id);
      for (const name of [fixture!.readBigCase, fixture!.catCase, ...fixture!.passCases]) {
        expect(payloads[name], `${profile.id}.json has no case "${name}"`).toBeDefined();
      }
    }
    const claimed = shimmed.map((profile) => profile.id);
    for (const id of Object.keys(FIXTURE_BY_HARNESS)) {
      expect(
        claimed,
        `${id}: has a shim fixture but no profile in the registry ships that shim — ` +
          `dead test data, or a harness dropped without its tests`,
      ).toContain(id);
    }
  });

  it('a harness that wires a hook command ships the shim that command runs', () => {
    for (const profile of HARNESSES) {
      const wiresCommand = profile.install.some((step) => step.kind === 'json-hooks');
      if (!wiresCommand) continue;
      expect(
        hasShim(profile),
        `${profile.id}: declares a JSON hook file but carries neither a hook schema nor ` +
          `a hand-written adapter — the installed command would name a script the ` +
          `build never produced`,
      ).toBe(true);
    }
  });

  it('the derived file lists cover every harness that persists something to read back', () => {
    for (const profile of HARNESSES) {
      for (const step of profile.install) {
        if (step.kind === 'json-hooks') expect(JSON_HOOK_FILES).toContain(step.file);
        if (step.kind === 'own-file' && step.guardOnly) {
          expect(GUARD_ONLY_FILES).toContain(step.file);
        }
      }
    }
  });
});

describe('one announcement — a rewrite says the same sentence everywhere it can be seen', () => {
  const rewriting = HARNESSES.filter(hasShim).filter(
    (profile) => FIXTURE_BY_HARNESS[profile.id]?.rewrite?.announce === 'stderr',
  );

  it('is used by every shim whose rewrite document has no reason channel', () => {
    expect(
      rewriting.length,
      'no stderr-announcing shim — this check would be vacuous',
    ).toBeGreaterThanOrEqual(3);
    for (const profile of rewriting) {
      const fixture = FIXTURE_BY_HARNESS[profile.id]!;
      const raw = harnessPayloads(profile.id)[fixture.catCase];
      const adapter = shimAdapterOf(profile);
      // The same call twice: once in deny mode, for the reason the guard would have
      // shown the model, and once in rewrite mode. The announcement must carry that
      // exact reason — a substitution announced without its why is half an answer.
      const denied = renderShimDecision(adapter, raw, DEFAULT_GUARD_SETTINGS, '/repo', stat);
      const reason = valueAt(JSON.parse(denied.stdout) as unknown, fixture.reasonKeyPath);
      const output = renderShimDecision(
        adapter,
        raw,
        { ...DEFAULT_GUARD_SETTINGS, enforcement: 'rewrite' },
        '/repo',
        stat,
      );
      const suggestion = valueAt(
        JSON.parse(output.stdout) as unknown,
        fixture.rewrite!.commandKeyPath,
      );
      expect(typeof suggestion).toBe('string');
      expect(
        output.stderr,
        `${profile.id}: announces a rewrite in words of its own — the one constant is ` +
          `what keeps four copies of this sentence identical`,
      ).toBe(`${rewriteAnnouncement(suggestion as string, reason as string)}\n`);
    }
  });

  it('is spliced into the generated opencode plugin, not hand-typed inside it', () => {
    // The fourth copy used to live inside a JavaScript string template, where nothing
    // could see it drift from the three shims'. Now the template splices the same
    // constants in, and this is what says so.
    const plan = planInstall('/repo', {
      harnesses: HARNESSES.filter((profile) => profile.id === 'opencode'),
      guard: true,
      statsOnStop: false,
      mapOnStart: false,
      lintOnStart: false,
      enforcement: 'rewrite',
      thresholdBytes: 8192,
    });
    const plugin = plan.files.find((file) => file.name.endsWith('smelt-guard.js'));
    expect(plugin, 'the opencode plugin was not planned').toBeDefined();
    expect(plugin!.content).toContain(JSON.stringify(REWRITE_ANNOUNCEMENT_OPENING));
    expect(plugin!.content).toContain(JSON.stringify(REWRITE_ANNOUNCEMENT_JOIN));
    // The reasonless deny is the plugin's other spliced sentence, and it drifts the
    // same way: a hand-typed replacement reads correctly while saying something the
    // shims never say.
    expect(plugin!.content).toContain(JSON.stringify(DENIED_WITHOUT_REASON));
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'harness-mis-tiered',
    file: 'harness/cursor.ts',
    find: "  tier: 'experimental',",
    replace: "  tier: 'verified',",
    why: 'a harness promoted a tier in the registry alone — every rendered grouping folds over `HarnessProfile.tier`, so the help paragraph, the wizard and the site table all move with it and keep agreeing; only README.md, written by hand and read from the real repo, still says where Cursor actually ships',
  },
  {
    id: 'harness-tier-clause-hand-typed',
    file: 'cli/subcommands/hooks.ts',
    find: "verified (${tierNames('verified')})",
    replace: 'verified (Claude Code, Codex, Cursor)',
    why: 'the tier clause typed back into the help body — the exact defect this card removes: the names read plausibly, one harness is now listed under two tiers at once, and before the grouping check nothing looked at which clause a name sat in',
  },
  {
    id: 'harness-lifecycle-read-off-the-tier',
    file: 'harness/registry.ts',
    find: "  return profile.install.some((step) => step.kind === 'json-hooks' && step.lifecycle);",
    replace: "  return profile.tier === 'verified' && profile.install.length > 0;",
    why: "the stats/map sentences reading the tier instead of the capability — true only while the two sets coincide, which is what made the old wording ('verified-tier harnesses') look correct; the first verified harness without session events, or experimental one with them, wires the opposite of what it says",
  },
  {
    id: 'harness-registry-key-disagrees-with-id',
    file: 'harness/registry.ts',
    find: '  codex,\n  gemini,',
    replace: "  'codex-cli': codex,\n  gemini,",
    why: "a registry key renamed while the profile keeps its id — `HARNESSES`, `HARNESS_IDS`, the help list and `harnessById('codex')` all still work because they read the field, while `HARNESS_PROFILES['codex']` is now undefined; two spellings of one id that nothing typed against each other, so only the keyed-id invariant can see it",
  },
  {
    id: 'harness-dropped-from-registry',
    file: 'harness/registry.ts',
    find: '  cursor,\n  opencode,',
    replace: '  opencode,',
    why: 'a harness dropped from the registry — the id vanishes from the --harness help list, the wizard and the installer while its fixture, its shim script and its published export all stay, which is the silent half-removal a registry is supposed to make impossible',
  },
  {
    id: 'harness-shim-claimed-without-fixture',
    file: 'harness/registry.ts',
    find: '  kilocode,\n  aider,\n};',
    replace: "  kilocode,\n  aider,\n  zed: { ...cursor, id: 'zed' },\n};",
    why: 'a harness claiming a shim with no recorded payload and no expectations — exactly the untested-schema ship the totality guard exists to refuse',
  },
  {
    id: 'harness-rewrite-announcement-hand-typed',
    file: 'harness/opencode.ts',
    find: '        ${JSON.stringify(REWRITE_ANNOUNCEMENT_OPENING)} +',
    replace: "        'smelt guard: rewrote the command with ' +",
    why: 'the generated opencode plugin announcing a rewrite in words of its own — a fourth copy of the sentence, inside a JavaScript string template where nothing can see it drift from the three shims that print it',
  },
  {
    id: 'harness-deny-fallback-hand-typed',
    file: 'harness/opencode.ts',
    find: '${JSON.stringify(DENIED_WITHOUT_REASON)}',
    replace: "'blocked by smelt'",
    why: 'the generated opencode plugin refusing in words of its own — the deny sentence spliced from the same constant the shims use, hand-typed instead, inside a template where nothing can see it drift',
  },
];
