import { describe, expect, it } from 'vitest';

import {
  assertNoNetwork,
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
} from '@guard/net/policy';

import type { GuardMutation } from './_mutations.ts';
import { guardSrcRoot, packageRoot } from './_source.ts';

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
