import { describe, expect, it } from 'vitest';

import { focusMatcher } from '../src/plan/focus.ts';

/**
 * The Focus, matched — one table for the one implementation. Every planner and the
 * repo map used to carry these assertions in their own vocabulary; each of them now
 * keeps a single "focus reaches the matcher" case and the meaning lives here.
 */
describe('focusMatcher', () => {
  const cases: readonly {
    readonly name: string;
    readonly focus: readonly string[] | undefined;
    readonly caseSensitive?: boolean;
    readonly text: string;
    readonly matches: boolean;
    readonly first?: number;
  }[] = [
    { name: 'no focus matches nothing', focus: undefined, text: 'anything', matches: false },
    { name: 'an empty list matches nothing', focus: [], text: 'anything', matches: false },
    {
      name: 'substring, anywhere in the text',
      focus: ['Ticket'],
      text: 'renderTicket(id)',
      matches: true,
    },
    {
      name: 'case-insensitive by default, both ways',
      focus: ['TICKET'],
      text: 'renderticket',
      matches: true,
    },
    {
      name: 'case-sensitive on request',
      focus: ['Ticket'],
      caseSensitive: true,
      text: 'renderticket',
      matches: false,
    },
    {
      name: 'case-sensitive still matches the exact spelling',
      focus: ['Ticket'],
      caseSensitive: true,
      text: 'renderTicket',
      matches: true,
    },
    {
      name: 'the first matching term in caller order is named',
      focus: ['zzz', 'render', 'Ticket'],
      text: 'renderTicket',
      matches: true,
      first: 1,
    },
    {
      name: 'a later term can be the first to match',
      focus: ['nothere', 'Ticket'],
      text: 'renderTicket',
      matches: true,
      first: 1,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const matcher = focusMatcher(
        c.focus,
        c.caseSensitive === undefined ? {} : { caseSensitive: c.caseSensitive },
      );
      expect(matcher.matches(c.text)).toBe(c.matches);
      if (c.first !== undefined) expect(matcher.firstMatch(c.text)).toBe(c.first);
      if (!c.matches) expect(matcher.firstMatch(c.text)).toBe(-1);
    });
  }

  it('drops empty terms, keeps the caller spelling of the rest, and reports emptiness', () => {
    const matcher = focusMatcher(['', 'Foo', '', 'bar']);
    expect(matcher.terms).toEqual(['Foo', 'bar']);
    expect(matcher.empty).toBe(false);
    // An empty term would match every text; dropping it is what keeps "no focus" honest.
    expect(focusMatcher(['', '']).empty).toBe(true);
    expect(focusMatcher(['', '']).matches('anything')).toBe(false);
  });

  it('is pure: the same terms and options give the same answers', () => {
    const a = focusMatcher(['x'], { caseSensitive: true });
    const b = focusMatcher(['x'], { caseSensitive: true });
    expect(a.matches('X')).toBe(b.matches('X'));
    expect(a.matches('x')).toBe(true);
  });
});
