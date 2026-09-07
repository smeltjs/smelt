import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { probeKind } from '../src/plan/kind.ts';

import { FUNCTIONS_TS } from './structural-fixtures.ts';

const REAL_DIFF = readFileSync(new URL('../bench/corpus/bench-argv.diff', import.meta.url), 'utf8');

/**
 * The BlobKind probe: a fact about the bytes, never a sniff. `'json'` means the text
 * parsed as JSON; `'diff'` means it carries a unified-diff header shape. Anything
 * else is `undefined` — "not a kind this probe names" — and the language decides, as
 * it always did. It never guesses a *language* from content: `lang/registry.ts`'s
 * refusal of content-sniffing-for-language stands, and this is a different fact.
 */
describe('probeKind states facts about the bytes', () => {
  it('names json only when the text actually parses as a JSON object or array', () => {
    expect(probeKind('{"a": 1, "b": [1, 2]}')).toBe('json');
    expect(probeKind('  [\n 1,\n 2\n]\n')).toBe('json');
    expect(probeKind('{"a": 1,')).toBeUndefined();
    expect(probeKind('42')).toBeUndefined();
    expect(probeKind('"a string"')).toBeUndefined();
  });

  it('names diff for a git diff and for a bare unified diff', () => {
    expect(probeKind(REAL_DIFF)).toBe('diff');
    expect(probeKind('--- a/x.txt\n+++ b/x.txt\n@@ -1,2 +1,2 @@\n-old\n+new\n')).toBe('diff');
  });

  it('names nothing for code, logs, a lone --- line or an empty blob', () => {
    expect(probeKind(FUNCTIONS_TS)).toBeUndefined();
    expect(probeKind('compiling module\nerror: TypeError\n')).toBeUndefined();
    expect(probeKind('--- a heading\nnot a diff\n')).toBeUndefined();
    expect(probeKind('')).toBeUndefined();
  });
});
