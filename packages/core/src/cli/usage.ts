import { PLAIN } from './lava.ts';
import type { Palette } from './lava.ts';
import { CLI_NAME } from './shell.ts';
import { CLI_FLAGS, FLAG_HELP } from './subcommands/flags.ts';
import type { FlagName } from './subcommands/flags.ts';
import { ownersOf, SUBCOMMAND_LIST } from './subcommands/registry.ts';
import { DEFAULT_VERB } from './subcommands/subcommand.ts';

/**
 * The help text and the front door — rendered from the registries, never hand-arranged.
 *
 * `--strategy` has rendered `STRATEGIES` and `--harness` `HARNESS_PROFILES` for a
 * while; this module finishes the job for the rest of the page. Every subcommand's
 * USAGE line, its section, and the `map only.` / `hooks only.` prefix on the flags it
 * owns come from `SUBCOMMANDS` and `CLI_FLAGS`, so a seventh verb or an eleventh flag
 * reaches the help by existing. The help text is also the closest thing the CLI has to
 * documentation, which is exactly why it must not be able to fall behind the parser.
 *
 * `test/__snapshots__/cli-usage.help.txt` pins the rendered bytes: a help change is a
 * reviewable diff, not a thing that happens. The snapshot is the **plain** rendering,
 * because the palette is the identity when colour is off — one page, one set of words,
 * paint or no paint.
 */

/** The column an OPTIONS entry's description starts at. */
const OPTION_INDENT = ' '.repeat(23);

/** What smelt is, in one line. The help's first sentence and the front door's. */
const TAGLINE = 'shrink text for a model, without lying about what was removed.';

/**
 * The three commands the front door names, and their one-line reasons.
 *
 * Deliberately **not** derived from the registry: the registry knows ten verbs and the
 * front door is an opinion about which three a person who has just typed `smelt` needs
 * — install it, run it once, check it. A generated list of ten would be the help page
 * again, and the help page is one keystroke away.
 */
const FRONT_DOOR: readonly (readonly [string, string])[] = [
  [`${CLI_NAME} setup`, 'wire smelt into the agent harness you use here'],
  [`${CLI_NAME} <file> --budget 4000`, 'smelt one file — the report says what went'],
  [`${CLI_NAME} doctor`, 'read back what is installed, and what is behind'],
];

/**
 * What bare `smelt` prints at an interactive terminal: the wordmark over the lava
 * gradient, what smelt is, the three commands, and where the rest is.
 *
 * Only ever reached when a person is at both ends (`CliIo.tty`) — a pipe still reads
 * stdin, and an agent still gets the refusal it has always got. A logo written into
 * something that is not a terminal is bytes somebody has to parse around.
 */
export function frontDoor(lava: Palette = PLAIN): string {
  const width = FRONT_DOOR.reduce((wide, [form]) => Math.max(wide, form.length), 0);
  return [
    lava.logo(),
    '',
    `  ${lava.paint('strong', CLI_NAME)} — ${TAGLINE}`,
    '',
    ...FRONT_DOOR.map(
      ([form, why]) => `  ${lava.paint('brand', form.padEnd(width))}  ${lava.paint('dim', why)}`,
    ),
    '',
    `  ${lava.paint('strong', `${CLI_NAME} --help`)} for every verb, every flag and the exit codes.`,
    '',
  ].join('\n');
}

/** The USAGE block: every command's everyday forms, then the occasional ones. */
function renderSynopsis(lava: Palette): string {
  const everyday = SUBCOMMAND_LIST.flatMap((command) => command.usage.synopsis);
  const occasional = SUBCOMMAND_LIST.flatMap((command) => command.usage.occasional ?? []);
  return [...everyday, ...occasional]
    .map((form) => `  ${lava.paint('brand', CLI_NAME)} ${form}`)
    .join('\n');
}

/**
 * The named sections, in registry order. Two verbs may declare the same heading —
 * `retrieve` and `stats` share RETRIEVE & STATS, because the loop is one story — and
 * their bodies are joined under the single heading rather than repeating it.
 */
function renderSections(lava: Palette): string {
  const sections = new Map<string, string[]>();
  for (const command of SUBCOMMAND_LIST) {
    const section = command.usage.section;
    if (section === undefined) continue;
    const bodies = sections.get(section.heading);
    if (bodies === undefined) sections.set(section.heading, [section.body]);
    else bodies.push(section.body);
  }
  return [...sections]
    .map(([heading, bodies]) => `${lava.heading(heading)}\n${bodies.join('\n\n')}`)
    .join('\n\n');
}

/**
 * The OPTIONS block. The description is the flag's own; the ownership sentence in
 * front of it is generated — a flag exactly one *named* verb owns reads `map only.`
 * or `hooks only.`, and one the default verb or several verbs share reads nothing,
 * because "which verb owns this flag" is a fact the registry already holds.
 */
function renderOptions(lava: Palette): string {
  return (Object.keys(CLI_FLAGS) as FlagName[])
    .map((name) => {
      const help = FLAG_HELP[name];
      const [first, ...rest] = [`${ownedBy(name)}${help.body()[0] ?? ''}`, ...help.body().slice(1)];
      return [
        `  ${lava.paint('brand', help.label.padEnd(21))}${first ?? ''}`,
        ...rest.map((line) => `${OPTION_INDENT}${line}`),
      ].join('\n');
    })
    .join('\n');
}

/** `map only. ` for a flag one named verb owns alone; nothing for anything else. */
function ownedBy(name: FlagName): string {
  const owners = ownersOf(name);
  const only = owners.length === 1 ? owners[0] : undefined;
  return only === undefined || only.name === DEFAULT_VERB ? '' : `${only.name} only. `;
}

/**
 * The help text. Also the closest thing the CLI has to documentation.
 *
 * The palette is a parameter with a plain default, so the snapshot, every guard that
 * compares `--help` against this function, and every pipe get exactly the same words —
 * the terminal just gets them painted.
 */
export function cliUsage(lava: Palette = PLAIN): string {
  return `${lava.logo()}

${lava.paint('strong', CLI_NAME)} — ${TAGLINE}

${lava.heading('USAGE')}
${renderSynopsis(lava)}

Smelted text goes to stdout and the report goes to stderr, so the two can be piped
apart:  ${CLI_NAME} big.log --budget 4000 > small.log

${renderSections(lava)}

${lava.heading('OPTIONS')}
${renderOptions(lava)}

${lava.heading('EXIT CODES')}
  0  under budget (map is always under budget by construction)
  1  over budget — the plan did not fit, and the report says so. Never silent.
     map never exits 1; see MAP above.
  2  usage error
  3  ${CLI_NAME} refused (a SmeltError: an unbuilt planner, an unknown hash, a corrupt store)
  4  unexpected internal error
`;
}
