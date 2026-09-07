import { describe, expect, it } from 'vitest';

import { focusTermsFor } from '../src/hooks/focus-terms.ts';

/**
 * `focusTermsFor(command)` — the one derivation of focus terms from the command that
 * produced a blob. It answers a narrower question than "what did the command search
 * for": *which terms, if any, distinguish the output lines the task is about from the
 * ones it is not.* A plain grep prints only matching lines, so its pattern
 * distinguishes nothing — every line has it — and focusing on it would protect the
 * whole output. A grep with context prints non-matching lines too, and there the
 * pattern is exactly the focus the lexical planner wants.
 */
describe('focusTermsFor — terms that distinguish output lines, never terms every line has', () => {
  it('states nothing for a plain grep: every output line already matches', () => {
    expect(focusTermsFor('grep -rn handleRequest src')).toEqual([]);
    expect(focusTermsFor("rg -e 'foo bar' src")).toEqual([]);
  });

  it('names the pattern when the search prints context lines around each match', () => {
    expect(focusTermsFor('grep -C 3 handleRequest src')).toEqual(['handleRequest']);
    expect(focusTermsFor('grep -rn -A 5 -B 2 foo src')).toEqual(['foo']);
    expect(focusTermsFor('rg --context 4 foo')).toEqual(['foo']);
    expect(focusTermsFor('rg -C3 foo')).toEqual(['foo']);
    expect(focusTermsFor('rg --after-context=2 foo src')).toEqual(['foo']);
    expect(focusTermsFor('git grep -C 2 foo')).toEqual(['foo']);
  });

  it('names every explicit -e pattern, in order', () => {
    expect(focusTermsFor('grep -C 2 -e alpha -e beta file')).toEqual(['alpha', 'beta']);
  });

  it('states nothing for a listing search — its output has no matching lines at all', () => {
    expect(focusTermsFor('grep -l -C 2 foo src')).toEqual([]);
    expect(focusTermsFor('rg -c -C 2 foo src')).toEqual([]);
    expect(focusTermsFor('rg --files-with-matches -C 2 foo src')).toEqual([]);
  });

  it('states nothing for a producer that names no term', () => {
    expect(focusTermsFor('cat src/big.ts')).toEqual([]);
    expect(focusTermsFor('git diff main')).toEqual([]);
    expect(focusTermsFor('sed -n 1,20p src/big.ts')).toEqual([]);
    expect(focusTermsFor('')).toEqual([]);
    expect(focusTermsFor(undefined)).toEqual([]);
  });

  it('states nothing for a command it cannot see whole', () => {
    expect(focusTermsFor('grep -C 2 foo src | head')).toEqual([]);
    expect(focusTermsFor('grep -C 2 "$PATTERN" src')).toEqual([]);
  });
});
