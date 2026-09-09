import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AMBIENT_GLOBAL_NAMESPACES,
  ambientNamespaceViolations,
  ambientTypeUses,
  deadSourcemapViolations,
  packPackage,
  standaloneTypecheckViolations,
  type PackedPackage,
} from '@smelt/guard-kit';

import type { GuardMutation } from './_mutations.ts';
import {
  allSourceFiles,
  guardRoot,
  packageRoot,
  readSource,
  stripStringsAndComments,
} from './_source.ts';

/**
 * PACKAGING GUARD — the tarball, audited as a consumer receives it.
 *
 * `packages/core/test/guards/packaging.test.ts` states the reasoning in full: the three
 * defects it exists for were properties of the bytes npm packs and of nothing else — a
 * declaration that only compiles in someone else's configuration, maps that resolve to
 * files the tarball never carried, and a schema strict mode will not register. This
 * package ships from the same build arrangement, so it can ship the first two.
 *
 * It is **more** exposed to the first than either of the others, and that is why this
 * file exists rather than being skipped as boilerplate: an HTTP adapter's public surface
 * is made of exactly the names a types package supplies. `AbortSignal`, `Response`,
 * `Headers` and `Request` are all on `AMBIENT_GLOBAL_TYPES`, all natural in a `fetch`
 * wrapper's signatures, and all invisible to the namespace rule because none of them
 * announces itself with a dot. This package's first draft put `AbortSignal` straight
 * into an exported type; the guard is what caught it, and {@link VoyageAbortSignal} and
 * {@link VoyageResponse} are what it was replaced with.
 *
 * There is no Law 1 guard here on purpose — see `vitest.config.ts` for why, and for
 * where the property that matters is actually guarded.
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
    // Every check below is a filter over `packed.files`; an empty or dist-less tarball
    // would pass all of them while proving nothing.
    expect(packed.files, 'the tarball has no dist/index.d.ts — was `pnpm build` run?').toContain(
      'dist/index.d.ts',
    );
    expect(packed.files).toContain('dist/index.js');
    expect(packed.files.filter((file) => file.endsWith('.js.map')).length).toBeGreaterThan(0);
    expect(packed.files.filter((file) => file.endsWith('.d.ts.map')).length).toBeGreaterThan(0);
  });

  it('ships no declaration that names an ambient global namespace', () => {
    expect(ambientNamespaceViolations(packed).join('\n')).toBe('');
  });

  it('typechecks on its own under strict, skipLibCheck: false, types: []', () => {
    // The rule, rather than a name list: a compiler knows the globals nobody listed.
    // Only diagnostics in this package's own files count — `@smeltjs/core` answers for
    // its own declarations, and a peer's `.d.ts` is nobody here's to edit.
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
});

describe('the source facts that keep the tarball buildable', () => {
  it('no module here names an ambient global namespace in code', () => {
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const code = stripStringsAndComments(readSource(file));
      for (const namespace of AMBIENT_GLOBAL_NAMESPACES) {
        if (new RegExp(`\\b${namespace}\\s*\\.`).test(code)) {
          offenders.push(`${file} names \`${namespace}\``);
        }
      }
    }
    expect(offenders.join('\n')).toBe('');
    expect(allSourceFiles().length, 'the scan must have found source to scan').toBeGreaterThan(0);
  });

  it('no emitted declaration uses a types-package global as a type', () => {
    // The mutatable pairing for the tarball typecheck above, and the check that would
    // have caught this package's own first draft: a `fetch` wrapper's signatures are made
    // of exactly these names, and none of them announces itself with a dot.
    const dist = join(guardRoot(), 'dist');
    const declarations = allSourceFiles(dist).filter((file) => file.endsWith('.d.ts'));
    expect(
      declarations.length,
      `no declarations under ${dist} — was \`pnpm build\` run?`,
    ).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of declarations) {
      for (const name of ambientTypeUses(stripStringsAndComments(readSource(file, dist)))) {
        offenders.push(`dist/${file} uses \`${name}\` as a type`);
      }
    }
    expect(
      offenders.join('\n'),
      'a types-package global in a type position reaches the shipped .d.ts, where it ' +
        'resolves only for a consumer who happened to install and globally include those ' +
        'types. State the shape structurally instead — VoyageResponse and ' +
        'VoyageAbortSignal are the two this package already had to write.',
    ).toBe('');
  });

  it('tsconfig.json inlines sources into the emitted JavaScript maps', () => {
    // `scripts/inline-declaration-map-sources.mjs` fills `*.d.ts.map` only; TypeScript's
    // own `inlineSources` is what covers `*.js.map`, and the script must not quietly
    // paper over its loss.
    const path = join(guardRoot(), 'tsconfig.json');
    const config = JSON.parse(
      readFileSync(path, 'utf8')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n'),
    ) as { compilerOptions?: Record<string, unknown> };
    expect(
      config.compilerOptions?.['inlineSources'],
      `${path}: without inlineSources the emitted .js.map files name ../src/*.ts, a path ` +
        `"files" never packs — a dead map on every consumer's machine.`,
    ).toBe(true);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one and asserts this file
 * goes red — see `_mutations.ts` and `scripts/mutate.mjs`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    kind: 'artifact',
    id: 'rerank-voyage-sourcemaps-stop-inlining-sources',
    file: 'tsconfig.json',
    find: '"inlineSources": true,',
    replace: '"inlineSources": false,',
    why: 'this package emitting .js.map files that name ../src/*.ts, a path its tarball never carries — dead maps for every consumer',
  },
  {
    kind: 'artifact',
    id: 'rerank-voyage-public-surface-bare-abort-signal',
    file: 'dist/index.d.ts',
    find: 'readonly signal: VoyageAbortSignal;',
    replace: 'readonly signal: AbortSignal;',
    why: "`AbortSignal` back in an exported signature — the exact global this package's first draft shipped, invisible to the namespace rule because it carries no dot, and an error in the adapter's own .d.ts for every consumer building with skipLibCheck: false and no node types of their own. An HTTP adapter is the surface most likely to reintroduce it.",
  },
];
