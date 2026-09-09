import type { InstallScope } from './scope.ts';

/**
 * The text every harness shares: the marker lines that bracket a block this installer
 * owns inside somebody else's file, the token that identifies a hook entry as ours,
 * and the instruction snippet itself.
 */

/** Marker lines bracketing every block this installer owns inside a shared file. */
export const SNIPPET_START_MD = '<!-- smelt:hooks v1 start -->';
export const SNIPPET_END_MD = '<!-- smelt:hooks v1 end -->';
export const SNIPPET_START_HASH = '# smelt:hooks v1 start';
export const SNIPPET_END_HASH = '# smelt:hooks v1 end';

/** Substring that identifies a file (or JSON hook entry) as written by this installer. */
export const OURS_TOKEN = 'smelt:hooks';

/**
 * The version stamp, as the block's second line: which release wrote these bytes.
 * The markers above stay byte-stable across releases — an upgrade must find the old
 * block to replace it — so the version travels *inside* the block, where replacing
 * the block replaces it. `smelt doctor` reads it back with {@link snippetStampVersion};
 * a block without the line was written before stamping existed, and doctor says so
 * instead of guessing a version nobody recorded.
 */
export const SNIPPET_STAMP_LINE = (version: string): string =>
  `<!-- smelt:hooks written-by @smeltjs/core ${version} -->`;

/** The version a block was written by, or `undefined` when it predates stamping. */
export function snippetStampVersion(text: string): string | undefined {
  return /<!-- smelt:hooks written-by @smeltjs\/core (\d+\.\d+\.\d+)(?:[-+][^>]*)? -->/u.exec(
    text,
  )?.[1];
}

/**
 * The instruction snippet — belt and braces under every shim, and the *only* layer
 * for advisory harnesses. It teaches the three commands, and in particular what to do
 * after a guard deny: run the named replacement, then `smelt retrieve` per marker.
 * `writtenBy` stamps the block for `smelt doctor`; omitted (legacy callers) the block
 * simply carries no version line.
 *
 * `scope` decides one word, and it is the honest one: a block in `~/.claude/CLAUDE.md`
 * is loaded in every project on the machine, so "This project uses smelt" would be a
 * claim about a project the reader is not necessarily in.
 */
export function instructionSnippet(
  thresholdBytes: number,
  budgetBytes: number,
  writtenBy?: string,
  scope: InstallScope = 'project',
): string {
  const stamp = writtenBy === undefined ? '' : `${SNIPPET_STAMP_LINE(writtenBy)}\n`;
  return `${SNIPPET_START_MD}
${stamp}
## smelt — context discipline

This ${scope === 'user' ? 'machine' : 'project'} uses [smelt](https://github.com/smeltjs/smelt) to keep large tool output
out of the context window, reversibly.

- Do not read files over ${String(thresholdBytes)} bytes raw. Run
  \`smelt <file> --budget ${String(budgetBytes)} --focus <what you are looking for>\`
  instead (repeat \`--focus\` per term). Focused regions survive verbatim; everything
  else collapses into a one-line marker stating what was removed.
- Every marker ends in \`retrieve("hash")\`. \`smelt retrieve <hash>\` prints the
  exact original bytes back. Retrieve what you actually need — retrievals are counted,
  and \`smelt stats\` reports the honest expansion rate.
- For orientation, \`smelt map . --budget ${String(budgetBytes)}\` prints a ranked
  symbol map of the repository.
- If a smelt guard hook denies a raw read, run the exact replacement command named in
  the denial, then \`smelt retrieve\` any marker you need expanded.

${SNIPPET_END_MD}
`;
}
