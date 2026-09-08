import { describe, expect, it } from 'vitest';

import {
  assertNoNetwork,
  importSpecifiers,
  readManifest,
  walkImportGraph,
  type Classification,
  type Edge,
} from '@smelt/guard-kit';

import {
  ALLOWED_NODE_BUILTINS,
  ALLOWED_PACKAGES,
  ALLOWED_URL_SCHEMES,
  assertLocalResource,
  FORBIDDEN_GLOBALS,
  FORBIDDEN_NODE_MODULES,
  FORBIDDEN_PACKAGES,
  OPT_IN_RERANK_PACKAGES,
  RERANK_VOYAGE_PACKAGE,
} from '@guard/net/policy';

import type { GuardMutation } from './_mutations.ts';
import { allSourceFiles, guardSrcRoot, packageRoot, readSource } from './_source.ts';

/**
 * ZERO-NETWORK GUARD — Law 1.
 *
 * This test fails if any module reachable from a published entrypoint can reach the
 * network. It is a *partition of a discovered set*, not an allowlist over an assumed
 * one: `walkImportGraph` walks the real import graph and {@link classify} sorts every
 * edge it finds into exactly one of five buckets. An import that matches nothing — a
 * transport nobody thought to forbid — lands in "unclassified" and fails. Forgetting
 * cannot be silent.
 *
 * The walk itself, and the four vacuity holes it closes, live in `@smelt/guard-kit`
 * (`walk.ts` carries the reasoning) — the same machine `packages/mcp` runs. What is
 * this package's own is below: the ruling. The core's ruling is the five-bucket
 * partition against `src/net/policy.ts`, the one place Law 1 is written down.
 *
 * Watching it fail is not optional. See CONTRIBUTING.md § "A guard nobody has watched
 * fail is not a guard" for the recorded transcript, and `pnpm mutate` to reproduce it.
 */

/**
 * Modules that are legitimately not reachable from any entrypoint. Empty today, and it
 * must stay justified line by line — this is the escape hatch, so it is the thing to be
 * suspicious of in review.
 */
const UNREACHABLE_BY_DESIGN: readonly string[] = [];

/**
 * THE RULING, for this package. Relative edges are the walker's business; every bare
 * specifier is judged here, against the policy module and nothing else.
 */
function classify(edge: Edge): Classification {
  const { specifier } = edge;

  if (FORBIDDEN_NODE_MODULES.includes(specifier)) {
    return { kind: 'forbidden', why: `"${specifier}" is a network transport` };
  }
  if (FORBIDDEN_PACKAGES.includes(specifier)) {
    return { kind: 'forbidden', why: `"${specifier}" is an HTTP/WebSocket client` };
  }
  // The opt-in rerank bucket (ADR-0004). smelt may know these packages' names — they
  // are *data* in `net/policy.ts`, handed to `import()` by `rerank/load.ts` when a
  // consumer's own config asks for one — and may never depend on them. So the name is
  // forbidden as an *edge*, which is a stronger statement than leaving it
  // unclassified: an unclassified import says "nobody has decided about this", and
  // this one is decided.
  if (
    OPT_IN_RERANK_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
  ) {
    return {
      kind: 'forbidden',
      why:
        `"${specifier}" is an opt-in rerank adapter and it reaches the network. It is ` +
        `loaded at runtime by a computed specifier when a consumer's own smelt.config.json ` +
        `asks for it, and imported by nothing — see OPT_IN_RERANK_PACKAGES in ` +
        `src/net/policy.ts. An import of it would put a network client in the default ` +
        `graph, which is the whole thing ADR-0004 did not reopen.`,
    };
  }
  if (ALLOWED_NODE_BUILTINS.includes(specifier)) return { kind: 'allowed-builtin' };
  if (ALLOWED_PACKAGES.includes(specifier)) return { kind: 'allowed-package' };
  return { kind: 'unclassified' };
}

describe('Law 1 — zero network', () => {
  const manifest = readManifest(packageRoot());
  const walk = walkImportGraph({ root: guardSrcRoot(), manifest });

  assertNoNetwork({
    walk,
    classify,
    unreachableByDesign: UNREACHABLE_BY_DESIGN,
    forbiddenGlobals: FORBIDDEN_GLOBALS,
    coverage: {
      entrypoints: ['index.ts'],
      bin: ['smelt'],
      binWhy:
        'the CLI ships as a `bin` on this package (one package, one version, one install) ' +
        'and the walk starts from it, so losing the bin would quietly shrink the guard',
      minVisited: 8,
      minEdges: 15,
      // The modules with the most dangerous surface must be in the walk, by name: the
      // policy itself, the grammar loader, and the CLI's argument handling.
      mustVisit: ['index.ts', 'net/policy.ts', 'plan/grammar.ts', 'cli/args.ts', 'cli/run.ts'],
    },
    messages: {
      violation: 'Law 1 violation: smelt v1 makes zero network calls',
      unclassified:
        'unclassified import. Add it to ALLOWED_PACKAGES / ALLOWED_NODE_BUILTINS in ' +
        'src/net/policy.ts with a comment saying why it cannot reach the network — or ' +
        'to the forbidden lists.',
    },
  });

  it('declares no dependency that could reach the network', () => {
    // Hole 3, the manifest half: a dependency added to package.json that no list
    // mentions would never appear as an edge until something imported it.
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ];
    expect(
      declared.length,
      'no runtime dependencies found — is the manifest right?',
    ).toBeGreaterThan(0);
    const unvetted = declared.filter((name) => !ALLOWED_PACKAGES.includes(name));
    expect(
      unvetted,
      'runtime dependency not vetted against Law 1. Add it to ALLOWED_PACKAGES in ' +
        'src/net/policy.ts, with a comment, once you have checked it cannot phone home.',
    ).toEqual([]);
  });

  it('never imports an opt-in rerank adapter, and rules that it may not', () => {
    // Two halves, and the guard needs both. The *ruling*: any spelling of the name is
    // forbidden, so the mutations below have something to go red against — asserted
    // directly, because a walk with no such edge in it proves nothing about what the
    // ruling would say. The *fact*: the walk found no such edge.
    for (const name of OPT_IN_RERANK_PACKAGES) {
      expect(classify({ from: 'index.ts', specifier: name }).kind).toBe('forbidden');
      expect(classify({ from: 'index.ts', specifier: `${name}/sub.js` }).kind).toBe('forbidden');
    }
    expect(OPT_IN_RERANK_PACKAGES).toContain(RERANK_VOYAGE_PACKAGE);
    expect(ALLOWED_PACKAGES).not.toContain(RERANK_VOYAGE_PACKAGE);

    // Every file, not only the walked ones, and every import spelling the walker knows
    // — including `import('literal')`, which is exactly what `rerank/load.ts` must not
    // become. A computed specifier is not an import; a literal one is.
    const importers = allSourceFiles().filter((file) =>
      importSpecifiers(readSource(file)).some((specifier) =>
        OPT_IN_RERANK_PACKAGES.some(
          (name) => specifier === name || specifier.startsWith(`${name}/`),
        ),
      ),
    );
    expect(
      importers,
      'an opt-in rerank adapter is imported by name. It reaches the network; smelt does ' +
        'not. Load it through the constant in src/net/policy.ts, which `import()` takes ' +
        'as a value — or accept that this package now depends on a network client.',
    ).toEqual([]);
  });

  it('refuses a remote resource path', () => {
    expect(ALLOWED_URL_SCHEMES).toEqual(['file:']);
    expect(() => assertLocalResource('https://example.invalid/tree-sitter-rust.wasm')).toThrow(
      /not local/,
    );
    expect(() => assertLocalResource('http://example.invalid/grammar.wasm')).toThrow(/not local/);
    expect(() => assertLocalResource(new URL('https://example.invalid/g.wasm'))).toThrow(
      /not local/,
    );
    expect(assertLocalResource('/tmp/tree-sitter-rust.wasm').protocol).toBe('file:');
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `src` and asserts this file goes red — see `test/guards/_mutations.ts`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'law1-opt-in-reranker-statically-imported',
    file: 'stages.ts',
    find: "import { NotImplementedError } from './errors.ts';",
    replace: "import '@smeltjs/rerank-voyage';\nimport { NotImplementedError } from './errors.ts';",
    why: 'the opt-in rerank adapter imported into the default graph — the package exists precisely because it reaches the network, so an edge to it makes "zero network" false for every consumer who never wrote a rerank block',
  },
  {
    id: 'law1-opt-in-reranker-import-spelled-literally',
    file: 'rerank/load.ts',
    find: 'await import(RERANK_VOYAGE_PACKAGE)',
    replace: "await import('@smeltjs/rerank-voyage')",
    why: 'the loader spelling its dynamic import with a literal instead of the policy constant — behaviourally identical, and the difference is the entire honesty of the arrangement: a literal is an edge the walk follows and a bundler resolves, so the adapter would be back in the graph while nothing about the running code changed',
  },
  {
    id: 'law1-node-https-import',
    file: 'plan/lexical.ts',
    find: "import { MissingMarkerPricingError } from '../errors.ts';",
    replace: "import 'node:https';\nimport { MissingMarkerPricingError } from '../errors.ts';",
    why: 'a network transport imported directly into the elision path',
  },
  {
    id: 'law1-global-fetch',
    file: 'store.ts',
    find: '  put(content: string, reason?: ElisionReason): string {',
    replace: '  put(content: string, reason?: ElisionReason): string {\n    void fetch;',
    why: 'a network-capable global referenced without any import at all',
  },
  {
    id: 'law1-unclassified-package',
    file: 'retrieve.ts',
    find: "import type { ElisionStore, RetrieveBatchTool, RetrievedBlock, RetrieveTool } from './types.ts';",
    replace:
      "import 'some-package-nobody-vetted';\nimport type { ElisionStore, RetrieveBatchTool, RetrievedBlock, RetrieveTool } from './types.ts';",
    why: 'a dependency that matches no list — the case a forbidden-list alone misses',
  },
  {
    id: 'law1-remote-grammar-scheme',
    file: 'net/policy.ts',
    find: "export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:'];",
    replace: "export const ALLOWED_URL_SCHEMES: readonly string[] = ['file:', 'https:'];",
    why: 'widening the scheme allowlist so a grammar could be fetched over the wire',
  },
  {
    id: 'law1-cli-network-import',
    file: 'cli/args.ts',
    find: "import { parseArgs } from 'node:util';",
    replace: "import 'node:https';\nimport { parseArgs } from 'node:util';",
    why: 'a transport in the CLI — the second front door, which a walk from index.ts alone would never scan',
  },
  {
    id: 'law1-globalthis-fetch',
    file: 'store.ts',
    find: '  has(hash: string): boolean {',
    replace: '  has(hash: string): boolean {\n    void globalThis.fetch;',
    why: 'fetch reached through the global object — `globalThis.fetch` slips past a bare-name grep whose lookbehind rejects any `.`-prefixed match, so the guard must catch the qualified spelling too',
  },
];
