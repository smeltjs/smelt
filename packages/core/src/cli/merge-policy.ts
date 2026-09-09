import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { PlannedFile } from '../harness/plan.ts';
import { CONFIG_FILE_NAME } from './config.ts';
import { fileIsOurs } from './installed.ts';
import { CLI_NAME } from './shell.ts';
import { writePlannedFile } from './wizard.ts';
import type { Ask } from './wizard.ts';

/**
 * The **MergePolicy** (CONTEXT.md): the one answer to "may this run write over a file
 * that already exists", and the one apply loop behind both install verbs.
 *
 * It is its own module because it is one idea with two callers: `smelt hooks install`
 * consents by asking, `smelt setup` and `--yes` consent by policy, and both go through
 * {@link applyPlanFiles}. Two apply loops would drift, and the one that drifted would
 * be the non-interactive path an agent drives blind. The plan it applies is
 * `harness/plan.ts`'s — the policy reads `PlannedFile.ownership`, a fact the planner
 * recorded, never a list of filenames it would have to keep in sync.
 */

/**
 * How an apply decides whether it may write over a file that already exists.
 *
 * There are exactly two answers, and one apply loop behind both — because two apply
 * loops would drift, and the one that drifted would be the one nobody watches: the
 * non-interactive path an agent drives blind.
 *
 *  - `wizard` — ask the human, per file, and take nothing but a literal `yes`. The
 *    rule `smelt init` lives under, unchanged.
 *  - `policy` — no one to ask, so the *plan's own shape* answers: a file whose planned
 *    content was computed by editing the existing bytes is safe to write (nothing
 *    foreign is lost), and a file smelt writes whole is refused unless it is already
 *    ours. That is what `--yes` and `smelt setup` consent by.
 */
export type Consent = { readonly kind: 'wizard'; readonly ask: Ask } | { readonly kind: 'policy' };

/** What one apply did to one file — the receipt line and the prose line, as data. */
export interface AppliedFile {
  readonly name: string;
  readonly action: 'written' | 'unchanged' | 'skipped';
  /** Why it was skipped, or what a write over an existing file changed. */
  readonly detail?: string;
}

/**
 * What a write over an existing file did, in the three shapes it can take. Stated as
 * narrowly as what actually holds, which is not the same thing for all three:
 *
 *  - **merged** — the honest claim is about *entries*, not bytes. A JSON hooks merge
 *    splices a re-serialised `hooks` value back into the file, so a foreign entry
 *    inside it keeps its content and loses its formatting: a one-line matcher comes
 *    back multi-line. Everything outside the edited region — every other top-level
 *    key, its indentation, its escapes, its number spellings — is byte-identical, and
 *    for a marker-block file or an MCP registration the edited region is our block or
 *    our server entry alone. An earlier cut of this said "every byte outside smelt's
 *    own entries is unchanged", which is a stronger claim than the editor makes.
 *  - **repaired** — a file smelt owns whole, already carrying our token, rewritten to
 *    this release. Every byte changed; all of them were ours.
 *  - **overwritten** — the same file when it was *not* ours, written because somebody
 *    typed `yes` to the per-file question. Only a wizard run can reach it, and it is
 *    the one case where bytes that were not smelt's are gone.
 */
const WRITE_DETAIL = {
  merged:
    "merged — every entry that is not smelt's is preserved, and every byte outside " +
    'the edited region is unchanged',
  repaired: "repaired — only smelt's own entries in it changed",
  overwritten: "overwritten — you confirmed it; the file is smelt's own now",
} as const;

/** What a write over an existing file turned out to be, or that it did not happen. */
type WriteVerdict = keyof typeof WRITE_DETAIL | 'refused';

/**
 * Whether an existing planned file is smelt's to write over without being asked.
 * The config is smelt's own; every other whole-owned file is ours exactly when it
 * already carries our entries — the marker token in text, our hook entries in a JSON
 * hooks file (the guard command carries no token, hence the entry-level predicate).
 *
 * Exported because `smelt setup` applies the same policy: one merge policy, or the
 * two verbs disagree about whose file it is.
 */
export function fileIsOursToRepair(file: {
  readonly name: string;
  readonly path: string;
}): boolean {
  if (basename(file.path) === CONFIG_FILE_NAME) return true;
  return fileIsOurs(file.name, readFileSync(file.path, 'utf8'));
}

/**
 * The policy's answer for one existing file. A merged plan already carries every
 * foreign byte, so writing it is not an overwrite at all; a whole-owned file has no
 * merge to perform, and one that is not ours is somebody else's work.
 */
function policyMayWrite(file: PlannedFile): boolean {
  if (file.ownership === 'merged') return true;
  return fileIsOursToRepair(file);
}

/** The refusal a policy run gives a whole-owned file that belongs to somebody else. */
function foreignWholeFileDetail(name: string): string {
  return (
    `exists and carries nothing of smelt's — ${name} is written whole, so there is ` +
    `nothing to merge into; move it aside, or run \`${CLI_NAME} hooks install\` ` +
    `without --yes to be asked per file`
  );
}

/**
 * The one apply loop. Writes the plan, file by file, consenting the way {@link Consent}
 * says; returns what it did rather than printing it, so the wizard's prose and setup's
 * receipt are two renderings of one run.
 */
export async function applyPlanFiles(
  files: readonly PlannedFile[],
  consent: Consent,
): Promise<readonly AppliedFile[]> {
  const applied: AppliedFile[] = [];
  for (const file of files) {
    if (file.unchanged) {
      applied.push({ name: file.name, action: 'unchanged' });
      continue;
    }
    const verdict = file.exists ? await verdictFor(file, consent) : undefined;
    if (verdict === 'refused') {
      applied.push({
        name: file.name,
        action: 'skipped',
        detail:
          consent.kind === 'wizard'
            ? 'the existing file was not touched'
            : foreignWholeFileDetail(file.name),
      });
      continue;
    }
    writePlannedFile(file);
    applied.push({
      name: file.name,
      action: 'written',
      ...(verdict === undefined ? {} : { detail: WRITE_DETAIL[verdict] }),
    });
  }
  return applied;
}

/**
 * May this write happen, and — since they are one question — what is it. The consent
 * decides whether; the plan's `ownership` and the file's current bytes decide which of
 * the three {@link WRITE_DETAIL} sentences is the true one.
 */
async function verdictFor(file: PlannedFile, consent: Consent): Promise<WriteVerdict> {
  const allowed =
    consent.kind === 'policy' ? policyMayWrite(file) : await askOverwrite(file, consent.ask);
  if (!allowed) return 'refused';
  if (file.ownership === 'merged') return 'merged';
  return fileIsOursToRepair(file) ? 'repaired' : 'overwritten';
}

/** The per-file consent question. */
async function askOverwrite(file: PlannedFile, ask: Ask): Promise<boolean> {
  // The one hard rule, same as `smelt init`: an existing file is never touched
  // without an explicit per-file yes — not `y`, not Enter, a literal `yes`.
  const answer = await ask(`  ${file.name} exists — overwrite it? (yes/no)> `);
  return answer === 'yes';
}
