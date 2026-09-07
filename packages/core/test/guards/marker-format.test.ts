import { describe, expect, it } from 'vitest';

import { applyPlan, defaultMarker, MARKER_FORMAT_VERSION, markerPricing } from '@guard/apply';
import { createRetrieveTool } from '@guard/retrieve';
import { MemoryElisionStore } from '@guard/store';
import type { ElisionPlan } from '@guard/types';

import type { GuardMutation } from './_mutations.ts';

/**
 * MARKER-FORMAT GUARD — the wire surface a *model* sees.
 *
 * The marker is not an API. It goes into prompts. Changing its shape changes model
 * behaviour downstream, and that manifests as **worse output with no error anywhere** —
 * this project's signature failure mode, shipped as a version bump. So the marker
 * format is frozen from 0.1 and treated as 1.0 (`CONTRIBUTING.md` § "Two promises, not
 * one"), while the TypeScript API stays `0.x` and may move.
 *
 * This guard is a drift guard of the shape the repo prefers: one truth (the rendered
 * marker) written in two places (the code, and the frozen table below), with a check
 * that they agree. It closes three holes:
 *
 *  1. *Silent format change* — the template moves, the version does not. The
 *     fingerprint stops matching.
 *  2. *Unknown version* — the version moves to something the table does not know. The
 *     lookup fails, so a new format is **additive**: a new row, never an edit.
 *  3. *Silent substitution* — two versions rendering the same string, so a consumer
 *     could not tell which format it is holding. Every frozen string must be distinct
 *     and must carry its own version in band.
 *
 * The fixture is fixed on purpose: the same inputs must render the same bytes forever
 * for a given version.
 */

const FIXTURE = {
  hash: 'abcdef0123456789',
  bytes: 412,
  rule: 'sibling-collapse',
  explanation: 'collapsed 3 sibling functions',
} as const;

/**
 * The frozen rendering of {@link FIXTURE}, per marker-format version.
 *
 * **Never edit a row.** A format change adds a row and bumps
 * `MARKER_FORMAT_VERSION`; the old row stays, because old markers stay valid in
 * transcripts, caches and other people's prompts. Editing a row in place is the silent
 * substitution this guard exists to prevent.
 */
const FROZEN: Readonly<Record<string, string>> = {
  v1: '<<smelt/v1: collapsed 3 sibling functions (412B) — retrieve("abcdef0123456789")>>',
};

describe('the marker format is frozen, and versioned in band', () => {
  it('renders exactly the frozen string for its declared version', () => {
    const expected = FROZEN[MARKER_FORMAT_VERSION];
    expect(
      expected,
      `MARKER_FORMAT_VERSION is "${MARKER_FORMAT_VERSION}", which this table does not ` +
        `know. A new marker format is additive: add a row to FROZEN with the exact ` +
        `rendering, and leave the existing rows alone. Read the note above first — the ` +
        `marker goes into prompts, so changing it changes model behaviour with no error ` +
        `anywhere.`,
    ).toBeDefined();
    expect(
      defaultMarker(FIXTURE),
      `the marker format changed without its version changing. Either revert the format, ` +
        `or bump MARKER_FORMAT_VERSION and add a FROZEN row — a format that changes ` +
        `silently is a substitution, not a release.`,
    ).toBe(expected);
  });

  it('carries its own version inside the marker, so a reader can tell which it has', () => {
    const marker = defaultMarker(FIXTURE);
    expect(marker).toContain(`smelt/${MARKER_FORMAT_VERSION}`);
    expect(marker.startsWith('<<smelt/')).toBe(true);
    expect(marker.endsWith('>>')).toBe(true);
  });

  it('stays machine-readable: version, byte count and hash all parse back out', () => {
    const marker = defaultMarker(FIXTURE);
    const parsed =
      /^<<smelt\/(?<version>[^:]+): (?<explanation>.+) \((?<bytes>\d+)B\) — retrieve\("(?<hash>[0-9a-f]+)"\)>>$/.exec(
        marker,
      );
    expect(parsed, `the marker no longer parses: ${marker}`).not.toBeNull();
    expect(parsed?.groups?.['version']).toBe(MARKER_FORMAT_VERSION);
    expect(parsed?.groups?.['explanation']).toBe(FIXTURE.explanation);
    expect(parsed?.groups?.['bytes']).toBe(String(FIXTURE.bytes));
    expect(parsed?.groups?.['hash']).toBe(FIXTURE.hash);
  });

  it('never lets two versions render the same bytes', () => {
    const renderings = Object.values(FROZEN);
    expect(new Set(renderings).size).toBe(renderings.length);
    for (const [version, rendering] of Object.entries(FROZEN)) {
      expect(rendering, `the ${version} row does not identify itself`).toContain(
        `smelt/${version}`,
      );
    }
  });

  it('states every fact Laws 2 and 3 require, in the one line the model reads', () => {
    const marker = defaultMarker(FIXTURE);
    expect(marker).toContain(FIXTURE.explanation); // Law 2: what went
    expect(marker).toContain(`${String(FIXTURE.bytes)}B`); // how much
    expect(marker).toContain(FIXTURE.hash); // Law 3: how to get it back
  });

  it('shows the model an example marker in the tool description that matches the real format', () => {
    // The retrieve tool's description is the one string a model reads to *recognize*
    // markers. An example there whose shape drifted from the wire format — a
    // `<<smelt: …>>` when real markers say `<<smelt/v1: …>>` — teaches the model to
    // miss every marker it actually receives, silently. So the description must
    // carry an example rendered by the real builder, version in band.
    const { description } = createRetrieveTool(new MemoryElisionStore());
    expect(description).toContain(`<<smelt/${MARKER_FORMAT_VERSION}: `);
    const embedded = /<<smelt\/[^>]*>>/.exec(description)?.[0];
    expect(embedded, 'the description carries no marker example at all').toBeDefined();
    expect(
      embedded,
      'the example marker in the tool description does not match what defaultMarker ' +
        'renders — the description would teach the model a shape it will never see',
    ).toBe(
      defaultMarker({
        hash: 'a1b2c3d4e5f60718',
        bytes: 412,
        rule: 'sibling-collapse',
        explanation: 'collapsed 3 sibling functions',
      }),
    );
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
describe('the elision outline stays out of band', () => {
  // `PlannedElision.names` is the cheapest index the planner holds — the collapsed
  // declarations' names — and it rides in the *report*, never in the marker: a marker
  // that grew with every name would change the wire surface and its priced cost at
  // once, and the pricing seam would then under-count every planned cut.
  const text = 'line one\nline two\nline three\nline four\nline five\nline six\n';
  const bare: ElisionPlan = {
    planner: 'test/v1',
    language: 'unknown',
    elisions: [
      { range: { start: 0, end: 27 }, reason: { rule: 'r', explanation: 'collapsed 3 lines' } },
    ],
  };
  const outlined: ElisionPlan = {
    ...bare,
    elisions: [{ ...bare.elisions[0]!, names: ['alpha', 'beta', 'gamma'] }],
  };

  it('renders the same marker bytes with and without names', () => {
    const without = applyPlan(text, bare, new MemoryElisionStore());
    const withNames = applyPlan(text, outlined, new MemoryElisionStore());
    expect(withNames.text).toBe(without.text);
    expect(withNames.elisions[0]!.marker).toBe(without.elisions[0]!.marker);
    expect(withNames.elisions[0]!.marker).not.toContain('alpha');
  });

  it('prices the same marker with and without names', () => {
    const pricing = markerPricing('unknown');
    const cost = pricing.costBytes(bare.elisions[0]!.reason, 27);
    expect(cost).toBe(
      Buffer.byteLength(
        applyPlan(text, outlined, new MemoryElisionStore()).elisions[0]!.marker,
        'utf8',
      ),
    );
  });
});

export const MUTATIONS: GuardMutation[] = [
  {
    id: 'outline-leaks-into-the-marker',
    file: 'apply.ts',
    find: "    const removedText = removed.toString('utf8');",
    replace:
      "    const removedText = removed.toString('utf8');\n" +
      "    reason = names === undefined ? reason : { ...reason, explanation: `${reason.explanation}: ${names.join(', ')}` };",
    why: 'the outline spliced into the marker text — the wire surface grows with every name and its priced cost no longer matches what the planner was told, so a cut can pass profitability and grow the output',
  },
  {
    id: 'marker-format-silent-change',
    file: 'apply.ts',
    find: '  `<<smelt/${MARKER_FORMAT_VERSION}: ${explanation} (${String(bytes)}B) — retrieve("${hash}")>>`;',
    replace:
      '  `<<smelt/${MARKER_FORMAT_VERSION}: ${explanation} [${String(bytes)} bytes] retrieve=${hash}>>`;',
    why: 'the wire surface a model sees, reshaped without its version moving — worse output, no error anywhere',
  },
  {
    id: 'marker-version-not-frozen',
    file: 'apply.ts',
    find: "export const MARKER_FORMAT_VERSION = 'v1';",
    replace: "export const MARKER_FORMAT_VERSION = 'v2';",
    why: 'a new marker version with no frozen rendering — the format table must be total, not advisory',
  },
];
