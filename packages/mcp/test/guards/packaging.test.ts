import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ambientNamespaceViolations,
  deadSourcemapViolations,
  packPackage,
  standaloneTypecheckViolations,
  type PackedPackage,
} from '@smelt/guard-kit';

import type { GuardMutation } from './_mutations.ts';
import { guardRoot, packageRoot, readSource } from './_source.ts';

/**
 * PACKAGING GUARD — this package's half of the tarball audit.
 *
 * `packages/core/test/guards/packaging.test.ts` states the reasoning in full: the
 * defects it was written for were properties of the bytes npm packs rather than of any
 * file under `src`, so the checks run over an extracted tarball. The MCP server ships
 * from the same build arrangement, so it can ship the same dead maps and the same
 * declarations that only compile in someone else's configuration.
 *
 * The third defect — a `smelt_retrieve` schema that strict structured outputs will not
 * register — is guarded here as a **re-fork** check rather than a re-assertion, and
 * that is the point. This server once wrote its own copy of the retrieve schema. One
 * contract, two documents: a library caller reading `RetrieveTool.inputSchema` and a
 * model reading `tools/list` could be told different things about the same call, and
 * nothing would report the day they diverged — which is exactly how the two packages
 * came to hold two budget laws (`test/guards/ops-seam.test.ts`). The schema is the
 * core's now, and this guard watches it stay the core's.
 *
 * The other three tools are not all held to strict mode, and the line falls where the
 * arguments do. `smelt_file` and `repo_map` have genuinely optional arguments
 * (`path`/`text`, `focus`, `strategy`), and strict mode has no notion of optional:
 * making them registrable would mean requiring every key and spelling absence as
 * `null`, which changes the calls a model is allowed to make. `smelt_stats` is not in
 * that company — it takes no arguments at all, so `required: []` is the whole truth
 * about it, and leaving the key out was a gap rather than a decision. It states the
 * empty list now, and the check below holds it there. `smelt_retrieve` has one
 * argument and it was already required, so stating the rule there changes nothing
 * about what it accepts.
 */

let packed: PackedPackage;

beforeAll(() => {
  packed = packPackage(packageRoot());
}, 180_000);

afterAll(() => {
  packed?.cleanup();
});

describe('the packed tarball is what a consumer can actually build against', () => {
  it('packs the declarations and maps this guard is about — nothing here is vacuous', () => {
    expect(packed.files, 'the tarball has no dist/index.d.ts — was `pnpm build` run?').toContain(
      'dist/index.d.ts',
    );
    expect(packed.files.filter((file) => file.endsWith('.d.ts')).length).toBeGreaterThan(2);
    expect(packed.files.filter((file) => file.endsWith('.js.map')).length).toBeGreaterThan(2);
    expect(packed.files.filter((file) => file.endsWith('.d.ts.map')).length).toBeGreaterThan(2);
  });

  it('ships no declaration that names an ambient global namespace', () => {
    expect(ambientNamespaceViolations(packed).join('\n')).toBe('');
  });

  it('typechecks on its own under strict, skipLibCheck: false, types: []', () => {
    // The core's guard states the reasoning: a namespace check is blind to a bare
    // `Buffer` or `URL`, so the rule that keeps the shipped declarations buildable is
    // a compiler rather than a name list. Only diagnostics in this package's own files
    // count — `@smeltjs/core` answers for its own, and a dependency's `.d.ts` is
    // nobody here's to edit.
    expect(
      standaloneTypecheckViolations(packed, {
        tsc: join(packageRoot(), 'node_modules', '.bin', 'tsc'),
        packageDir: packageRoot(),
      }).join('\n'),
    ).toBe('');
  }, 180_000);

  it('ships no sourcemap that resolves to a file it did not pack', () => {
    expect(deadSourcemapViolations(packed).join('\n')).toBe('');
  });

  it('tsconfig.json inlines sources into the emitted JavaScript maps', () => {
    // The declaration maps are filled by `scripts/inline-declaration-map-sources.mjs`,
    // which touches only `*.d.ts.map`; TypeScript's own `inlineSources` is what covers
    // `*.js.map`, and the script must not quietly paper over its loss.
    const path = join(guardRoot(), 'tsconfig.json');
    const config = JSON.parse(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { compilerOptions?: Record<string, unknown> };
    expect(
      config.compilerOptions?.['inlineSources'],
      `${path}: without inlineSources the emitted .js.map files name ../src/*.ts, a ` +
        `path "files" never packs — a dead map on every consumer's machine.`,
    ).toBe(true);
  });
});

describe("the served smelt_retrieve schema is the core's, not a copy of it", () => {
  const source = readSource('server.ts');

  it('serves RetrieveTool.inputSchema rather than writing its own', () => {
    expect(
      source,
      'server.ts no longer serves `retrieveTool.inputSchema`. The retrieve schema ' +
        'belongs to @smeltjs/core, beside the `invoke` that reads it and the ' +
        'strict-mode rules its own guard pins; a copy here is a second document for ' +
        'one contract, and the day they disagree nothing reports it.',
    ).toContain('retrieveTool.inputSchema');
  });

  it('writes no properties block of its own for that tool', () => {
    // A re-fork does not announce itself by deleting the reuse — it announces itself
    // by a hand-written schema appearing beside the tool name. This is that check.
    const retrieveEntry = source.slice(
      source.indexOf('name: RETRIEVE_TOOL_NAME,'),
      source.indexOf('name: REPO_MAP_TOOL_NAME,'),
    );
    expect(retrieveEntry, 'the retrieve tool entry was not found in server.ts').not.toBe('');
    expect(
      retrieveEntry.includes('properties: {'),
      'the retrieve tool entry writes its own `properties` block — that is the copy ' +
        'this guard exists to refuse. Serve the core schema instead.',
    ).toBe(false);
  });
});

/**
 * `smelt_stats`'s source facts that keep it strict-mode registrable: `required: []`
 * beside `additionalProperties: false`, on the tool that takes no arguments at all —
 * the one gap this schema used to leave (a missing key reads as "not yet decided",
 * not as "nothing required"). This is a text-level check, not a live protocol round
 * trip: `test/tools.test.ts` runs the real `tools/list` (including this same fact,
 * plus the universal "every schema closes to unknown keys" rule across all five
 * tools, and `smelt_retrieve`/`smelt_retrieve_batch`'s full strict-mode validity) —
 * a check this guard cannot make, because a `kind: 'src'` mutation points `@guard/*`
 * at a bare copy of `src` with no `node_modules` beside it, and actually executing
 * `createSmeltMcpServer` reaches into `@smeltjs/core`, which that copy cannot
 * resolve. Every other check in this guard reads `server.ts` as text for the same
 * reason; this one keeps the pairing.
 */
describe('smelt_stats is strict-mode shaped in its own source, not only when it happens to be served', () => {
  it('states required: [] beside additionalProperties: false on the smelt_stats entry', () => {
    const source = readSource('server.ts');
    const entry = source.slice(source.indexOf('name: SMELT_STATS_TOOL_NAME,'));
    expect(entry, 'the smelt_stats tool entry was not found in server.ts').not.toBe('');
    expect(
      /required:\s*\[\s*\]\s*,[\s\S]{0,80}additionalProperties:\s*false\s*,/.test(entry),
      'smelt_stats no longer states `required: []` beside `additionalProperties: false` ' +
        '— the tool that takes no arguments stops being strict-mode registrable',
    ).toBe(true);
  });
});

export const MUTATIONS: GuardMutation[] = [
  {
    id: 'mcp-retrieve-schema-reforked',
    file: 'server.ts',
    find:
      '      inputSchema: {\n' +
      '        ...retrieveTool.inputSchema,\n' +
      '        required: [...retrieveTool.inputSchema.required],\n' +
      '      },',
    replace:
      '      inputSchema: {\n' +
      "        type: 'object',\n" +
      "        properties: { hash: { type: 'string' } },\n" +
      "        required: ['hash'],\n" +
      '      },',
    why: 'the retrieve schema re-forked into this server — one contract described in two places, and this copy has quietly lost additionalProperties, so a strict-structured-outputs client cannot register the one tool every marker points at',
  },
  {
    kind: 'artifact',
    id: 'mcp-sourcemaps-stop-inlining-sources',
    file: 'tsconfig.json',
    find: '"inlineSources": true,',
    replace: '"inlineSources": false,',
    why: 'the MCP package emitting .js.map files that name ../src/*.ts, a path its tarball never carries — dead maps for every consumer',
  },
  {
    id: 'mcp-smelt-stats-schema-loses-strict-mode',
    file: 'server.ts',
    find: '        required: [],\n        additionalProperties: false,\n      },\n    },\n  ];\n}',
    replace: '        required: [],\n      },\n    },\n  ];\n}',
    why: 'smelt_stats losing additionalProperties: false in its own source — the one tool that takes no arguments at all stops being strict-mode registrable, and the source-level pin (paired with the live protocol check in test/tools.test.ts) must notice',
  },
];
