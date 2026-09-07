/**
 * The BlobKind probe — a fact about the bytes, never a sniff.
 *
 * `auto` used to decide on one fact: whether the language carries a bundled grammar.
 * A piped diff is path-less, detects `unknown`, and could only ever reach the lexical
 * planner, which sees lines and not hunks; a JSON tool result reached the same planner,
 * which sees lines and not members — and a pretty-printed log's biggest values are
 * single lines a line planner cannot cut at all. The bench measured it (rows
 * `git-diff` and `json-tool-result`, corpus 226c91db4f95): lexical missed both
 * budgets. So `auto` now asks a second fact first, and this is where it is answered.
 *
 * Two kinds, each proved rather than guessed:
 *
 *  - **json** — the text, trimmed, begins an object or array and `JSON.parse` accepts
 *    it. A parse is a fact; a leading brace is not.
 *  - **diff** — a unified-diff header shape: a `diff --git` line first, or a `--- ` line
 *    directly followed by a `+++ ` line with a hunk header somewhere after them.
 *
 * Everything else is `undefined`: not a kind this probe names, so the language decides
 * as it always did. This is deliberately *not* language sniffing — `lang/registry.ts`'s
 * refusal to guess a language from content stands; a content kind is a different fact
 * (a parser accepted these bytes; these lines have this shape), and the planner that
 * runs on it says so in `result.planner`.
 */

/** The content kinds the probe can prove. */
export type BlobKind = 'json' | 'diff';

export function probeKind(text: string): BlobKind | undefined {
  if (isJsonDocument(text)) return 'json';
  if (hasDiffHeader(text)) return 'diff';
  return undefined;
}

function isJsonDocument(text: string): boolean {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function hasDiffHeader(text: string): boolean {
  const lines = text.split('\n');
  const firstContent = lines.find((line) => line.trim() !== '');
  if (firstContent?.startsWith('diff --git ') === true) return true;
  for (let i = 0; i + 1 < lines.length; i += 1) {
    if (!lines[i]!.startsWith('--- ') || !lines[i + 1]!.startsWith('+++ ')) continue;
    if (lines.slice(i + 2).some((line) => line.startsWith('@@ '))) return true;
  }
  return false;
}
