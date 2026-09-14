import { describe, expect, it } from 'vitest';

import {
  defaultMarker,
  MARKER_LINE_COMMENT_LEADERS,
  markerForLanguage,
  markerPricing,
} from '../src/apply.ts';
import type { MarkerBuilder } from '../src/apply.ts';
import { MissingMarkerPricingError } from '../src/errors.ts';
import { HASH_LENGTH } from '../src/hash.ts';
import { createSmelter } from '../src/index.ts';
import { planLexical } from '../src/plan/lexical.ts';
import { planStructural } from '../src/plan/structural.ts';
import type { DetectedLanguage, ElisionReason, PlanInput } from '../src/types.ts';

import { FUNCTIONS_TS } from './structural-fixtures.ts';

/**
 * The MarkerPricing seam — the pricing half of a MarkerScheme: apply.ts is the one owner
 * of marker cost, planners ask and never guess. `markerPricing()` must price the exact
 * marker the scheme's builder renders —
 * default builder, per-language comment leader, or a caller's custom builder — because
 * a planner working from any other number can plan an elision that grows the output.
 */

const REASON: ElisionReason = { rule: 'sibling-collapse', explanation: 'collapsed 3 siblings' };
const HASH_STAND_IN = '0'.repeat(HASH_LENGTH);

const noise = (count: number, prefix = 'noise'): string =>
  Array.from({ length: count }, (_, i) => `${prefix} ${String(i)} ....................`).join('\n');

// A builder whose marker outweighs any cut the suppression inputs below offer. A
// planner still pricing the default marker would plan those cuts anyway — and grow
// the output.
const expensive: MarkerBuilder = (info) => `${'#'.repeat(100_000)} ${info.explanation}`;

/** A custom builder longer than the default, for the builder-wins-wholesale case. */
const customLonger: MarkerBuilder = (info) => `!!ELIDED ${info.explanation}!!${'x'.repeat(200)}`;

describe('markerPricing — the pricing half of the scheme, the one adapter for marker cost', () => {
  it('prices the default marker byte-for-byte', () => {
    const pricing = markerPricing('unknown');
    const rendered = defaultMarker({ hash: HASH_STAND_IN, bytes: 1234, ...REASON });
    expect(pricing.costBytes(REASON, 1234)).toBe(Buffer.byteLength(rendered, 'utf8'));
  });

  it('prices every language leader in, exactly as markerForLanguage renders it', () => {
    for (const [language, leader] of Object.entries(MARKER_LINE_COMMENT_LEADERS)) {
      const pricing = markerPricing(language as DetectedLanguage);
      const bare = markerPricing('unknown').costBytes(REASON, 500);
      expect(
        pricing.costBytes(REASON, 500),
        `${language}: pricing must carry the "${leader}" leader`,
      ).toBe(bare + Buffer.byteLength(leader, 'utf8'));
    }
  });

  it('prices a custom builder with its own cost — the builder wins wholesale, leader included', () => {
    // Same resolution as applyPlan: a supplied builder replaces the leader-wrapped
    // default entirely, even for a language that has a leader.
    const pricing = markerPricing('python', customLonger);
    const rendered = customLonger({ hash: HASH_STAND_IN, bytes: 42, ...REASON });
    expect(pricing.costBytes(REASON, 42)).toBe(Buffer.byteLength(rendered, 'utf8'));
    expect(pricing.costBytes(REASON, 42)).toBeGreaterThan(
      markerPricing('python').costBytes(REASON, 42),
    );
  });

  it('agrees with the markers applyPlan actually lands, per language', async () => {
    // The parity that keeps snapshots and bench rows byte-identical: what the planner
    // was told a marker costs is what the applied marker weighs.
    for (const language of ['unknown', 'python', 'typescript'] as const) {
      const pricing = markerPricing(language);
      const smelter = createSmelter();
      const result = await smelter.smelt(`${noise(80)}\nthe NEEDLE is here\n${noise(80, 'b')}`, {
        language,
        budgetBytes: 600,
        focus: ['needle'],
      });
      expect(result.elisions.length, `${language}: nothing applied — vacuous`).toBeGreaterThan(0);
      for (const elision of result.elisions) {
        expect(Buffer.byteLength(elision.marker, 'utf8')).toBe(
          pricing.costBytes(elision.reason, elision.bytes),
        );
      }
    }
  });

  it('markerForLanguage and markerPricing stay one resolution: unknown keeps the bare marker', () => {
    const built = markerForLanguage('unknown')({ hash: HASH_STAND_IN, bytes: 7, ...REASON });
    expect(built.startsWith('<<smelt/')).toBe(true);
    expect(markerPricing().costBytes(REASON, 7)).toBe(Buffer.byteLength(built, 'utf8'));
  });
});

describe('planners refuse to guess: pricing is required at runtime too', () => {
  const bare = {
    text: 'one\ntwo\nthree\n',
    language: 'unknown',
    budgetBytes: 10,
  } as unknown as PlanInput;

  it('planLexical throws MissingMarkerPricingError for a JS caller that omits pricing', () => {
    expect(() => planLexical(bare)).toThrowError(MissingMarkerPricingError);
  });

  it('planStructural throws MissingMarkerPricingError for a JS caller that omits pricing', async () => {
    const input = { ...bare, language: 'typescript' } as PlanInput;
    await expect(planStructural(input)).rejects.toThrowError(MissingMarkerPricingError);
  });
});

describe('an expensive custom MarkerBuilder suppresses unprofitable elisions in both planners', () => {
  it('lexical: the same input elides under default pricing and refuses under the expensive builder', () => {
    const text = `${noise(80)}\nthe NEEDLE is here\n${noise(80, 'after')}`;
    const base = { text, language: 'unknown', budgetBytes: 600, focus: ['needle'] } as const;

    const cheap = planLexical({ ...base, pricing: markerPricing('unknown') });
    expect(cheap.elisions.length, 'default pricing planned nothing — vacuous').toBeGreaterThan(0);

    const priced = planLexical({ ...base, pricing: markerPricing('unknown', expensive) });
    expect(priced.elisions).toEqual([]);
  });

  it('structural: the same input elides under default pricing and refuses under the expensive builder', async () => {
    const base = {
      text: FUNCTIONS_TS,
      language: 'typescript',
      budgetBytes: 600,
      focus: ['handleRequest'],
    } as const;

    const cheap = await planStructural({ ...base, pricing: markerPricing('typescript') });
    expect(cheap.elisions.length, 'default pricing planned nothing — vacuous').toBeGreaterThan(0);

    const priced = await planStructural({
      ...base,
      pricing: markerPricing('typescript', expensive),
    });
    expect(priced.elisions).toEqual([]);
  });
});
