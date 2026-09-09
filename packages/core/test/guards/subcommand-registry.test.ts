import { describe, expect, it } from 'vitest';

import { assertKeyedById } from '@smelt/guard-kit';

// Guards import through @guard so the mutation runner can aim them at a broken copy
// of src. See scripts/mutate.mjs.
import { cliUsage, parseSmeltArgs } from '@guard/cli/args';
import { EXIT, runCli } from '@guard/cli/run';
import { CLI_FLAGS, GLOBAL_FLAGS, VERB_FLAGS } from '@guard/cli/subcommands/flags';
import type { VerbFlag } from '@guard/cli/subcommands/flags';
import { ownersOf, SUBCOMMAND_LIST, SUBCOMMANDS } from '@guard/cli/subcommands/registry';
import type { Verb } from '@guard/cli/subcommands/subcommand';
import { CliUsageError } from '@guard/errors';

import type { GuardMutation } from './_mutations.ts';

/**
 * The subcommand seam, and the property it exists for: **every verb owns its flags.**
 *
 * Before `SUBCOMMANDS`, a verb was a shape restated in four modules, and the
 * compounding cost was the refusals — because no verb owned its flags, every verb
 * refused every other verb's flags in hand-written prose. That is O(verbs × flags)
 * sentences kept in sync by hand, and it was already wrong in the small: `--harness`
 * was refused in two places with two different explanations, and an eleventh flag
 * meant editing five messages.
 *
 * So the refusals are tested the way they are now generated — as a table. Every verb
 * is crossed with every flag it does not own, and each pair must be refused, with the
 * exit code it always had (2, usage) and a message that names the offending flag and
 * the verb that refused it. Crossed the other way, every flag a verb *does* own must
 * be accepted, so widening a flag list to smuggle a foreign flag through goes red
 * instead of going quiet.
 *
 * The shipped verbs and the sample invocations below are restated by hand, on purpose:
 * a registry that is its own witness proves nothing.
 */

/** Restated by hand: the eight verbs, and a minimal way to invoke each. */
const SHIPPED: Record<Verb, readonly string[]> = {
  smelt: [],
  init: ['init'],
  map: ['map', 'some-dir'],
  retrieve: ['retrieve', 'deadbeefdeadbeef'],
  stats: ['stats'],
  hooks: ['hooks', 'install'],
  agents: ['agents', 'lint'],
  setup: ['setup'],
  doctor: ['doctor'],
};
const SHIPPED_VERBS = Object.keys(SHIPPED).toSorted();

/** Restated by hand: one well-formed way to type each ownable flag. */
const FLAG_ARGV: Record<VerbFlag, readonly string[]> = {
  budget: ['--budget', '4000'],
  focus: ['--focus', 'handleRequest'],
  producer: ['--producer', 'grep -C 2 handleRequest src'],
  language: ['--language', 'python'],
  strategy: ['--strategy', 'lexical'],
  ignore: ['--ignore', 'vendor'],
  cache: ['--cache', '.smelt-tags'],
  harness: ['--harness', 'codex'],
  scope: ['--scope', 'project'],
  yes: ['--yes'],
  'no-mcp': ['--no-mcp'],
  guard: ['--guard', 'on'],
  stats: ['--stats', 'off'],
  map: ['--map', 'on'],
  lint: ['--lint', 'off'],
  strict: ['--strict'],
  json: ['--json'],
  reconstruct: ['--reconstruct'],
};

/** Restated by hand: which verb owns which flag. The registry must not be its own witness. */
const OWNED: Record<Verb, readonly VerbFlag[]> = {
  smelt: ['budget', 'focus', 'producer', 'language', 'strategy', 'json', 'reconstruct'],
  init: [],
  map: ['budget', 'focus', 'ignore', 'cache', 'json'],
  retrieve: [],
  stats: ['json'],
  hooks: ['harness', 'scope', 'yes', 'guard', 'stats', 'map', 'lint'],
  agents: ['strict', 'json'],
  setup: ['harness', 'scope', 'yes', 'no-mcp', 'json', 'guard', 'stats', 'map', 'lint'],
  doctor: ['scope', 'json'],
};

/** How a verb is named in its own refusal — the default verb has no word to use. */
function verbLabel(verb: Verb): string {
  return verb === 'smelt' ? 'a single-blob run' : verb;
}

async function usageErrorFor(argv: readonly string[]): Promise<{ code: number; stderr: string }> {
  let stderr = '';
  const code = await runCli(argv, {
    stdout: () => {},
    stderr: (text) => {
      stderr += text;
    },
    stdin: () => '',
    version: '9.9.9-test',
  });
  return { code, stderr };
}

describe('the SUBCOMMANDS registry serves every shipped verb', () => {
  it('carries exactly the shipped verbs — no more, no fewer', () => {
    expect(Object.keys(SUBCOMMANDS).toSorted()).toEqual(SHIPPED_VERBS);
    expect(SUBCOMMAND_LIST.map((command) => command.name).toSorted()).toEqual(SHIPPED_VERBS);
  });

  it('keys every command by its own name — `subcommandFor` looks up by key, the help reads the field', () => {
    // The two assertions above check each spelling against the shipped list, not
    // against each other: two keys swapped over two commands would pass both.
    assertKeyedById(SUBCOMMANDS, 'name');
  });

  it('gives every verb the four members the seam is made of', () => {
    for (const command of SUBCOMMAND_LIST) {
      expect(command.parse, command.name).toBeTypeOf('function');
      expect(command.resolve, command.name).toBeTypeOf('function');
      expect(command.run, command.name).toBeTypeOf('function');
      expect(command.refusal, command.name).not.toBe('');
    }
  });
});

describe('flag ownership is total: every flag has an owner, every owner a real flag', () => {
  it('every flag the parser accepts is global or owned by at least one verb', () => {
    for (const name of Object.keys(CLI_FLAGS)) {
      const global = (GLOBAL_FLAGS as readonly string[]).includes(name);
      const owners = ownersOf(name as VerbFlag);
      expect(global || owners.length > 0, `--${name} is owned by nobody`).toBe(true);
      // A global flag owned by a verb could be refused by another, and `--help` must
      // work everywhere: `smelt map --help` prints the help, it does not get refused.
      expect(global ? owners.length : 0, `--${name}`).toBe(0);
    }
  });

  it('no verb claims a flag the parser does not accept', () => {
    for (const command of SUBCOMMAND_LIST) {
      for (const flag of command.flags) {
        expect(Object.keys(CLI_FLAGS), `${command.name} claims --${flag}`).toContain(flag);
      }
    }
  });

  it('the two global flags reach every verb, rather than being refused by five of them', async () => {
    for (const argv of Object.values(SHIPPED)) {
      const { code, stdout } = await capture([...argv, '--help']);
      expect(code, argv.join(' ')).toBe(EXIT.ok);
      expect(stdout, argv.join(' ')).toBe(cliUsage());
    }
  });
});

async function capture(argv: readonly string[]): Promise<{ code: number; stdout: string }> {
  let stdout = '';
  const code = await runCli(argv, {
    stdout: (text) => {
      stdout += text;
    },
    stderr: () => {},
    stdin: () => '',
    version: '9.9.9-test',
  });
  return { code, stdout };
}

describe('every verb refuses every flag it does not own — the whole cross product', () => {
  // `SUBCOMMANDS[verb]?.flags ?? []`, not a bare index: this line runs at collection
  // time (it builds the `it.each` table below), outside any `it()` body — an
  // unguarded index throwing here crashes the whole file before a single test runs
  // (vitest reports "no tests", not a red assertion), which is exactly the CRASHED
  // failure mode `scripts/mutate.mjs` now distinguishes from a caught mutation. A verb
  // the registry dropped is still asserted — loudly, as a real failed test — by
  // `'carries exactly the shipped verbs — no more, no fewer'` above; this line's job
  // is only to keep collection itself from crashing when that happens.
  const foreign = (Object.keys(SHIPPED) as Verb[]).flatMap((verb) =>
    VERB_FLAGS.filter((flag) => !(SUBCOMMANDS[verb]?.flags.includes(flag) ?? false)).map(
      (flag) => [verb, flag] as const,
    ),
  );

  it('owns exactly the flags the shipped CLI documents, verb by verb', () => {
    for (const [verb, flags] of Object.entries(OWNED) as [Verb, readonly VerbFlag[]][]) {
      expect(SUBCOMMANDS[verb], verb).toBeDefined();
      expect([...SUBCOMMANDS[verb].flags].toSorted(), verb).toEqual([...flags].toSorted());
    }
  });

  it.each(foreign)('`smelt %s` refuses --%s, naming the flag and the verb', (verb, flag) => {
    const argv = [...SHIPPED[verb], ...FLAG_ARGV[flag]];
    expect(() => parseSmeltArgs(argv), argv.join(' ')).toThrow(CliUsageError);
    let message = '';
    try {
      parseSmeltArgs(argv);
    } catch (error) {
      message = (error as Error).message;
    }
    // The generated message must be at least as useful as the five hand-written ones
    // it replaced: it names the flag the user typed, and the verb that refused it.
    expect(message, argv.join(' ')).toContain(`--${flag}`);
    expect(message, argv.join(' ')).toContain(verbLabel(verb));
    expect(message, argv.join(' ')).toContain(SUBCOMMANDS[verb].refusal);
  });

  it.each(foreign)(
    '`smelt %s --%s` exits with the usage code, as it always did',
    async (verb, flag) => {
      const { code, stderr } = await usageErrorFor([...SHIPPED[verb], ...FLAG_ARGV[flag]]);
      expect(code, `${verb} --${flag}`).toBe(EXIT.usage);
      expect(stderr, `${verb} --${flag}`).toContain(`--${flag}`);
    },
  );

  it('names where a single-owner flag does belong, so the refusal is actionable', () => {
    // `--ignore` on a single-blob run reads exactly as the hand-written message did.
    expect(() => parseSmeltArgs(['--budget', '4000', '--ignore', '.git'])).toThrow(
      /--ignore and --cache belong to `smelt map`/,
    );
    // `--harness` used to belong to hooks alone, and the refusal named it; setup
    // owns it now too, so the actionable clause is correctly gone for it — a flag
    // with two owners cannot be sent to one place.
    expect(() => parseSmeltArgs(['--budget', '4000', '--harness', 'codex'])).toThrow(
      /got --harness/,
    );
    // And from a *named* verb, where the clause is not the refusing verb's own
    // complement: `hooks` lacks --budget/--focus/--json too, but map does not own them
    // alone, so the clause is map's exclusive pair and nothing else.
    expect(() => parseSmeltArgs(['hooks', 'install', '--ignore', 'vendor'])).toThrow(
      /--ignore and --cache belong to `smelt map`/,
    );
    expect(() => parseSmeltArgs(['stats', '--cache', '.smelt-tags'])).toThrow(
      /--ignore and --cache belong to `smelt map`/,
    );
    // A flag several verbs share has no single home, so none is invented.
    expect(ownersOf('json').length).toBeGreaterThan(1);
    let message = '';
    try {
      parseSmeltArgs(['retrieve', 'aaaa', '--json']);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/--json belongs to/);
  });

  /**
   * The clause the refusal ends its middle sentence with is an *assertion of
   * ownership*, so it must be true for every verb, not only the default one — a clause
   * naming a flag two verbs share would talk a user out of an invocation that works
   * (`smelt file.ts --budget 4000` after being told --budget is map's). Crossed over
   * every pair, because the wrong formula reads correctly from the default verb and
   * only goes false from the others.
   */
  it.each(foreign)('`smelt %s --%s` attributes no flag it would be wrong about', (verb, flag) => {
    const argv = [...SHIPPED[verb], ...FLAG_ARGV[flag]];
    let message = '';
    try {
      parseSmeltArgs(argv);
    } catch (error) {
      message = (error as Error).message;
    }
    for (const [, clause] of message.matchAll(/((?:--[a-z]+(?:,| and)? )+)belongs? to /g)) {
      for (const named of (clause ?? '').matchAll(/--([a-z]+)/g)) {
        const name = named[1] as VerbFlag;
        expect(ownersOf(name).length, `${argv.join(' ')}: --${name} is not one verb's`).toBe(1);
      }
    }
  });
});

/**
 * The default verb's second job, `--reconstruct`, owns a *subset* of the verb's flags —
 * which the registry cannot express, because both jobs are one verb. So the round trip
 * refuses the rest itself, and this is the cross product of that: every flag the verb
 * owns except `--reconstruct` must be refused when typed beside it, with the same exit
 * code and the same shape as the ownership refusals.
 *
 * It used to refuse `--budget` alone and silently ignore `--json`, `--focus`,
 * `--language` and `--strategy` — a run that printed the reconstructed text while the
 * user believed they had asked for an envelope, which is this repository's own
 * definition of a bug.
 */
describe('the round trip refuses every flag it cannot honour, rather than ignoring it', () => {
  // Restated by hand: what `--reconstruct` shares the verb with. Derived from OWNED,
  // which is itself hand-written — the registry must not be its own witness.
  const beside = OWNED.smelt.filter((flag) => flag !== 'reconstruct');

  it('leaves nothing the verb owns unaccounted for', () => {
    expect([...beside].toSorted()).toEqual([
      'budget',
      'focus',
      'json',
      'language',
      'producer',
      'strategy',
    ]);
  });

  it.each(beside)('`smelt --reconstruct --%s` is refused, naming the flag', (flag) => {
    const argv = ['--reconstruct', ...FLAG_ARGV[flag]];
    expect(() => parseSmeltArgs(argv), argv.join(' ')).toThrow(CliUsageError);
    let message = '';
    try {
      parseSmeltArgs(argv);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, argv.join(' ')).toContain(`--${flag}`);
    expect(message, argv.join(' ')).toContain('no sense with --reconstruct');
  });

  it.each(beside)('`smelt --reconstruct --%s` exits with the usage code', async (flag) => {
    const { code, stderr } = await usageErrorFor(['--reconstruct', ...FLAG_ARGV[flag]]);
    expect(code, `--reconstruct --${flag}`).toBe(EXIT.usage);
    expect(stderr, `--reconstruct --${flag}`).toContain(`--${flag}`);
  });

  it('names every offending flag at once, and the round trip alone is accepted', () => {
    expect(() => parseSmeltArgs(['--reconstruct', '--focus', 'x', '--json'])).toThrow(
      /--focus and --json make no sense with --reconstruct/,
    );
    expect(parseSmeltArgs(['--reconstruct', 'result.json'])).toMatchObject({
      mode: 'reconstruct',
      file: 'result.json',
    });
  });
});

describe('every verb accepts every flag it does own', () => {
  // Same reasoning as the cross-product `foreign` table above: this runs at
  // collection time, so a dropped verb must not throw here — it is asserted, loudly,
  // by 'carries exactly the shipped verbs — no more, no fewer'.
  const owned = (Object.keys(SHIPPED) as Verb[]).flatMap((verb) =>
    (SUBCOMMANDS[verb]?.flags ?? []).map((flag) => [verb, flag] as const),
  );

  it.each(owned)('`smelt %s` does not refuse its own --%s', (verb, flag) => {
    const argv = [...SHIPPED[verb], ...FLAG_ARGV[flag]];
    let message = '';
    try {
      parseSmeltArgs(argv);
    } catch (error) {
      message = (error as Error).message;
    }
    // The verb may still refuse the *combination* (`--budget` with `--reconstruct`),
    // but never with the ownership refusal — that would mean a verb disowning a flag
    // the help says it takes.
    expect(message, argv.join(' ')).not.toMatch(/takes no flags|takes only/);
  });
});

describe('the help text is rendered from the registry, not arranged by hand', () => {
  it('gives every verb its USAGE lines', () => {
    const usage = cliUsage();
    for (const command of SUBCOMMAND_LIST) {
      const forms = [...command.usage.synopsis, ...(command.usage.occasional ?? [])];
      expect(forms.length, `${command.name} has no USAGE form`).toBeGreaterThan(0);
      for (const form of forms) {
        expect(usage, `${command.name}: ${form}`).toContain(`  smelt ${form}`);
      }
    }
  });

  it('gives every declared section its heading and body', () => {
    const usage = cliUsage();
    for (const command of SUBCOMMAND_LIST) {
      const section = command.usage.section;
      if (section === undefined) continue;
      expect(usage, command.name).toContain(`${section.heading}\n`);
      expect(usage, command.name).toContain(section.body);
    }
  });

  it("generates each OPTIONS entry's ownership sentence from the registry", () => {
    const usage = cliUsage();
    for (const name of Object.keys(CLI_FLAGS)) {
      const owners = ownersOf(name as VerbFlag);
      const only = owners.length === 1 ? owners[0] : undefined;
      if (only === undefined || only.name === 'smelt') continue;
      // `--ignore <entry>     map only. …` — the prefix is derived, so a flag that
      // changed hands cannot keep advertising its old one.
      expect(usage, `--${name}`).toMatch(new RegExp(`--${name}[^\\n]*\\s${only.name} only\\.`));
    }
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'subcommand-flag-list-widened',
    file: 'cli/subcommands/map.ts',
    find: "  flags: ['budget', 'focus', 'ignore', 'cache', 'json'],",
    replace: "  flags: ['budget', 'focus', 'ignore', 'cache', 'json', 'harness'],",
    why: "a verb's flag list widened to a flag it does not implement — `smelt map --harness codex` is now accepted and silently ignored, which is the exact failure the hand-written refusals existed to prevent, and the cross-product must notice a pair that stopped being refused",
  },
  {
    id: 'subcommand-dropped-from-registry',
    file: 'cli/subcommands/registry.ts',
    find: '  stats: statsCommand,\n',
    replace: '',
    why: 'a verb dropped from the one SUBCOMMANDS registry — the word stops dispatching, its USAGE line and its half of the RETRIEVE & STATS section vanish from the help, and every flag it owned loses its owner, all in one edit the guard must watch go red on every face at once',
  },
  {
    id: 'subcommand-foreign-flag-refusal-dropped',
    file: 'cli/args.ts',
    find: '  refuseForeignFlags(command, values);\n',
    replace: '',
    why: 'the one generated refusal removed from the parse — every verb now accepts every flag and silently ignores the ones it cannot act on, which is a setting the user believed was in force; the whole cross product must go red, not just one pair',
  },
  {
    id: 'subcommand-redirect-claims-shared-flags',
    file: 'cli/subcommands/registry.ts',
    find: '      const elsewhere = owner.flags.filter((flag) => ownersOf(flag).length === 1);',
    replace: '      const elsewhere = owner.flags.filter((flag) => ownersOf(flag).length >= 1);',
    why: "the redirect clause widened from the owner's exclusively-owned flags to all of them — the refusal starts asserting that shared flags (--budget, --focus, --json) belong to one verb, contradicting the help's own `map only.` prefixes and talking a user out of an invocation that works, so the cross-product must catch a clause naming a flag with more than one owner",
  },
  {
    id: 'reconstruct-ignores-the-flags-it-cannot-honour',
    file: 'cli/subcommands/smelt.ts',
    find: '      refuseReconstructFlags(values);\n',
    replace: '',
    why: 'the round trip stops refusing the flags it cannot act on — `smelt --reconstruct --json` prints the reconstructed text while the user believed they asked for an envelope, the silently-ignored flag the ownership refusals exist to make impossible',
  },
];
