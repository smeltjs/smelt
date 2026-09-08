import { CliUsageError } from '../../errors.ts';
import { CLI_NAME } from '../shell.ts';

import { agentsCommand } from './agents.ts';
import type { AgentsInvocation } from './agents.ts';
import { doctorCommand } from './doctor.ts';
import type { DoctorInvocation } from './doctor.ts';
import { flagList, VERB_FLAGS } from './flags.ts';
import type { FlagName, FlagValues, VerbFlag } from './flags.ts';
import { hooksCommand } from './hooks.ts';
import type { HooksInvocation } from './hooks.ts';
import { initCommand } from './init.ts';
import type { InitInvocation } from './init.ts';
import { mapCommand } from './map.ts';
import type { MapInvocation } from './map.ts';
import { retrieveCommand } from './retrieve.ts';
import type { RetrieveInvocation } from './retrieve.ts';
import { smeltCommand } from './smelt.ts';
import type { SmeltInvocation } from './smelt.ts';
import { setupCommand } from './setup.ts';
import type { SetupInvocation } from './setup.ts';
import { statsCommand } from './stats.ts';
import type { StatsInvocation } from './stats.ts';
import { storeCommand } from './store.ts';
import type { StoreInvocation } from './store.ts';
import { DEFAULT_VERB } from './subcommand.ts';
import type { Subcommand, Verb } from './subcommand.ts';

/**
 * The registry — every verb `smelt` answers to, one {@link Subcommand} each.
 *
 * `Record<Verb, Subcommand>` on purpose, exactly like `LANGUAGE_PROFILES` and
 * `HARNESS_PROFILES`: adding a `Verb` in `subcommand.ts` without writing its file is a
 * compile error, so the verb list and the facts cannot drift. Every derived view — the
 * USAGE block, the help's sections, the `map only.` prefixes in OPTIONS, and above all
 * the flag-ownership refusal below — is computed from this object, never written twice.
 *
 * Key order is meaningful: it is the order every rendered list uses (USAGE, the help
 * sections, the owners named in a refusal), so keep it stable and append new verbs at
 * the end.
 */
export const SUBCOMMANDS: Readonly<Record<Verb, AnySubcommand>> = {
  smelt: smeltCommand,
  init: initCommand,
  map: mapCommand,
  retrieve: retrieveCommand,
  stats: statsCommand,
  hooks: hooksCommand,
  agents: agentsCommand,
  setup: setupCommand,
  doctor: doctorCommand,
  store: storeCommand,
};

/** Everything `parseSmeltArgs` can return. Narrow on `mode`. */
export type CliInvocation =
  | SmeltInvocation
  | InitInvocation
  | MapInvocation
  | RetrieveInvocation
  | StatsInvocation
  | HooksInvocation
  | AgentsInvocation
  | SetupInvocation
  | DoctorInvocation
  | StoreInvocation;

/**
 * One registry entry, with its verb's own invocation and resolved types erased.
 *
 * The erasure is what lets six differently-typed commands live in one `Record`, and it
 * is safe because the two ends are never crossed: `runCli` hands a command exactly the
 * invocation that command's own `parse` produced (`verbFor` maps each `mode` back to
 * the verb that minted it), and the resolved value never leaves the pair of calls that
 * makes and consumes it.
 */
export type AnySubcommand = Subcommand<CliInvocation, unknown>;

/** Every command, in registry order. The list every rendered block walks. */
export const SUBCOMMAND_LIST: readonly AnySubcommand[] = Object.values(SUBCOMMANDS);

/**
 * The verbs with a word on the command line — everything but the default one.
 *
 * The default verb is excluded deliberately: `smelt smelt` is a file named `smelt`,
 * not a recursive invocation, the same way `smelt map` as a *file* needs `./map`.
 */
export const NAMED_VERBS: readonly Verb[] = SUBCOMMAND_LIST.map((command) => command.name).filter(
  (name) => name !== DEFAULT_VERB,
);

/**
 * Which command a command line selects: `positionals[0]` when it names a verb, the
 * default verb otherwise. The whole of subcommand dispatch, in one lookup.
 */
export function subcommandFor(positionals: readonly string[]): AnySubcommand {
  const first = positionals[0];
  const named = NAMED_VERBS.find((verb) => verb === first);
  return SUBCOMMANDS[named ?? DEFAULT_VERB];
}

/**
 * Which verb minted an invocation. Total over the modes `parseSmeltArgs` can return
 * for a verb, so a new mode without a home is a compile error — `'reconstruct'` maps
 * to the default verb because `--reconstruct` is that verb's second job, not a
 * seventh command.
 */
const VERB_BY_MODE = {
  smelt: 'smelt',
  reconstruct: 'smelt',
  init: 'init',
  map: 'map',
  retrieve: 'retrieve',
  stats: 'stats',
  hooks: 'hooks',
  agents: 'agents',
  setup: 'setup',
  doctor: 'doctor',
  store: 'store',
} as const satisfies Record<Exclude<CliInvocation['mode'], 'help' | 'version'>, Verb>;

/** The command that produced an invocation, for dispatch. */
export function commandFor(
  mode: Exclude<CliInvocation['mode'], 'help' | 'version'>,
): AnySubcommand {
  return SUBCOMMANDS[VERB_BY_MODE[mode]];
}

/** How a command is named in prose. The default verb has no word to name it by. */
function label(command: AnySubcommand): string {
  return command.name === DEFAULT_VERB ? 'a single-blob run' : command.name;
}

/** How a command is named as the *owner* of a flag: the form you would type. */
function ownerLabel(command: AnySubcommand): string {
  return command.name === DEFAULT_VERB ? 'a single-blob run' : `\`${CLI_NAME} ${command.name}\``;
}

/**
 * The commands that own a flag, in registry order — empty for the two global flags,
 * which no verb owns. A flag with exactly one owner has an unambiguous home worth
 * naming in a refusal (and worth prefixing its OPTIONS entry with); a flag several
 * verbs share (`--json`, `--budget`, `--focus`) has none, and pointing at one of them
 * would be a guess.
 */
export function ownersOf(flag: FlagName): readonly AnySubcommand[] {
  return SUBCOMMAND_LIST.filter((command) => (command.flags as readonly string[]).includes(flag));
}

/**
 * Refuse every flag the chosen verb does not own — the one message that replaced five
 * hand-written ones.
 *
 * Before this existed, each verb refused each other verb's flags in prose, so the
 * refusals were O(verbs × flags) sentences kept in sync by hand and an eleventh flag
 * edited five of them. Now ownership is declared once per verb and the message is
 * generated from three derived facts, in the order a reader needs them:
 *
 *   1. **what this verb takes**, and what it got instead — the offending flag, named;
 *   2. **where the flag does belong**, when exactly one verb owns it, listed as that
 *      owner's *exclusively* owned flags (so `--ignore` here still reads "--ignore and
 *      --cache belong to `smelt map`", exactly as the hand-written message did);
 *   3. **why not here** — the verb's own `refusal` sentence, the half of the old
 *      messages worth keeping, and the only half a verb still writes.
 *
 * Every refusal stays a {@link CliUsageError}, so every one of them still exits 2.
 *
 * @throws {CliUsageError} naming the offending flag, this verb, and the flag's owner.
 */
export function refuseForeignFlags(command: AnySubcommand, values: FlagValues): void {
  const foreign = VERB_FLAGS.filter(
    (flag) => values[flag] !== undefined && !command.flags.includes(flag),
  );
  if (foreign.length === 0) return;

  const takes =
    command.flags.length === 0
      ? `${label(command)} takes no flags (got ${flagList(foreign)}).`
      : `${label(command)} takes only ${flagList(command.flags)} (got ${flagList(foreign)}).`;

  throw new CliUsageError(`${CLI_NAME}: ${takes}${redirects(foreign)} ${command.refusal}`);
}

/**
 * ` --ignore and --cache belong to \`smelt map\`.` — one clause per single-owner verb.
 *
 * A clause names only the flags its owner owns **alone**, never the ones it shares.
 * `ownersOf(flag).length === 1` is the same test that decided the owner deserved a
 * clause at all, applied to the whole clause: a shared flag (`--budget`, `--focus`,
 * `--json`) has no single home, so naming it here would assert an ownership that the
 * OPTIONS block — which prefixes `map only.` by the same rule — correctly denies.
 */
function redirects(foreign: readonly VerbFlag[]): string {
  const owners = SUBCOMMAND_LIST.filter((owner) =>
    foreign.some((flag) => {
      const claimants = ownersOf(flag);
      return claimants.length === 1 && claimants[0] === owner;
    }),
  );
  return owners
    .map((owner) => {
      const elsewhere = owner.flags.filter((flag) => ownersOf(flag).length === 1);
      const verb = elsewhere.length === 1 ? 'belongs' : 'belong';
      return ` ${flagList(elsewhere)} ${verb} to ${ownerLabel(owner)}.`;
    })
    .join('');
}
