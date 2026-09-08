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
  FORBIDDEN_GLOBALS,
  FORBIDDEN_NODE_MODULES,
  FORBIDDEN_PACKAGES,
  OPT_IN_RERANK_PACKAGES,
} from '@smeltjs/core';

import type { GuardMutation } from './_mutations.ts';
import { guardSrcRoot, packageRoot } from './_source.ts';

/**
 * ZERO-NETWORK GUARD for the MCP package — Law 1, plus this package's own ruling:
 * **stdio-local only**.
 *
 * The sanctioned dependency, `@modelcontextprotocol/sdk`, ships HTTP and SSE
 * transports alongside stdio. Vetting "the package" would therefore vet a network
 * server into the graph; what was actually sanctioned is the *stdio* slice. So this
 * guard runs the same machine the core's guard runs — `@smelt/guard-kit`'s
 * `walkImportGraph`, which walks the real import graph from every manifest entrypoint
 * and carries the four vacuity defences — and pins the SDK to an explicit subpath
 * allowlist ({@link ALLOWED_SDK_SUBPATHS}): stdio transport, the server class, the
 * protocol types, nothing else. An SDK subpath off that list (`server/sse.js`,
 * `server/streamableHttp.js`) is forbidden, not unclassified — the guard names the
 * ruling it breaks.
 *
 * The forbidden lists are imported from `@smeltjs/core`'s own `net/policy.ts` — the
 * one place Law 1 is written down — so the two packages cannot drift on what counts
 * as a transport. The core package itself is vetted by the core's guard; this one
 * covers OUR source files: no `fetch`, no `node:http(s)`, no WebSocket, anywhere in
 * `packages/mcp/src`.
 */

/** The only `@modelcontextprotocol/sdk` subpaths any module here may import. */
const ALLOWED_SDK_SUBPATHS: readonly string[] = [
  '@modelcontextprotocol/sdk/server/index.js', // the low-level Server class
  '@modelcontextprotocol/sdk/server/stdio.js', // the one sanctioned transport
  '@modelcontextprotocol/sdk/types.js', // request schemas and result types
];

/** The complete vetted runtime dependency set — anything else in the manifest fails. */
const VETTED_DEPENDENCIES: readonly string[] = ['@modelcontextprotocol/sdk', '@smeltjs/core'];

/** Node builtins OUR modules may import, each with its reason. */
const ALLOWED_MCP_BUILTINS: readonly string[] = [
  'node:fs', // reading this package's own manifest, for the server version
  'node:path', // resolving tool paths against the server cwd
  'node:process', // cwd, stderr, and the exit code, for the binary
];

/** Modules legitimately unreachable from any entrypoint. Empty, and staying so. */
const UNREACHABLE_BY_DESIGN: readonly string[] = [];

/**
 * THE RULING, for this package: stdio-local. Relative edges are the walker's
 * business; every bare specifier is judged here.
 */
function classify(edge: Edge): Classification {
  const { specifier } = edge;

  if (FORBIDDEN_NODE_MODULES.includes(specifier)) {
    return { kind: 'forbidden', why: `"${specifier}" is a network transport` };
  }
  if (FORBIDDEN_PACKAGES.includes(specifier)) {
    return { kind: 'forbidden', why: `"${specifier}" is an HTTP/WebSocket client` };
  }
  if (
    specifier === '@modelcontextprotocol/sdk' ||
    specifier.startsWith('@modelcontextprotocol/sdk/')
  ) {
    if (ALLOWED_SDK_SUBPATHS.includes(specifier)) return { kind: 'allowed-package' };
    return {
      kind: 'forbidden',
      why:
        `"${specifier}" is not on the stdio-local SDK allowlist. This server is ` +
        `stdio-local by ruling: the SDK's HTTP/SSE transports never enter this graph. ` +
        `Allowed: ${ALLOWED_SDK_SUBPATHS.join(', ')}.`,
    };
  }
  // The opt-in rerank bucket, imported from the core's policy module so the two
  // packages cannot drift on which adapters are network-reaching. This server offers
  // reranking through `smelt_file` and still imports no adapter: it hands the config
  // block to the core's `loadRerankStage`, which loads by computed specifier. So the
  // name is forbidden here for the same reason and with the same force.
  if (
    OPT_IN_RERANK_PACKAGES.some((name) => specifier === name || specifier.startsWith(`${name}/`))
  ) {
    return {
      kind: 'forbidden',
      why:
        `"${specifier}" is an opt-in rerank adapter and it reaches the network. This ` +
        `server reranks by asking @smeltjs/core to load one from the consumer's own ` +
        `config; it imports none, and an edge here would put a network client in a ` +
        `stdio-local server's graph.`,
    };
  }
  if (specifier === '@smeltjs/core') return { kind: 'allowed-package' };
  if (ALLOWED_MCP_BUILTINS.includes(specifier)) return { kind: 'allowed-builtin' };
  return { kind: 'unclassified' };
}

describe('Law 1 for @smeltjs/mcp — zero network, stdio-local', () => {
  const manifest = readManifest(packageRoot());
  const walk = walkImportGraph({ root: guardSrcRoot(), manifest });

  assertNoNetwork({
    walk,
    classify,
    unreachableByDesign: UNREACHABLE_BY_DESIGN,
    forbiddenGlobals: FORBIDDEN_GLOBALS,
    coverage: {
      entrypoints: ['index.ts', 'bin.ts'],
      bin: ['smelt-mcp'],
      binWhy: 'the server ships as a `bin` (npx @smeltjs/mcp) and the walk starts from it',
      minVisited: 4,
      minEdges: 8,
      // The modules with the most dangerous surface must be in the walk, by name.
      mustVisit: ['server.ts', 'store.ts', 'bin.ts'],
    },
    messages: {
      violation: 'Law 1 violation: this server makes zero network calls',
      unclassified:
        'unclassified import. Add it to ALLOWED_MCP_BUILTINS or ALLOWED_SDK_SUBPATHS in ' +
        'this guard, with a comment saying why it cannot reach the network — or accept ' +
        'that it is forbidden.',
    },
  });

  it('declares exactly the vetted runtime dependencies, and nothing more', () => {
    // Hole 3, the manifest half — and this package's ruling is equality, not a
    // partition: the SDK is the one sanctioned addition.
    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ].toSorted();
    expect(
      declared,
      'the runtime dependency set moved. The SDK is the one sanctioned addition ' +
        '(stdio-local); anything further needs its own vetting and its own ruling.',
    ).toEqual([...VETTED_DEPENDENCIES].toSorted());
  });

  it('imports the sanctioned node builtins only through the allowlist above', () => {
    // Every builtin on the local list must also be one the core's policy already
    // allows — the mcp package gets no builtin the library itself refuses.
    const unvetted = ALLOWED_MCP_BUILTINS.filter((name) => !ALLOWED_NODE_BUILTINS.includes(name));
    expect(
      unvetted,
      'a builtin allowed here is not on @smeltjs/core net/policy.ts ALLOWED_NODE_BUILTINS',
    ).toEqual([]);
  });
});

/**
 * The breaks this guard must catch. `pnpm mutate` applies each one to a scratch copy
 * of `packages/mcp/src` and asserts this file goes red — see `_mutations.ts` and
 * `scripts/mutate.mjs`.
 */
export const MUTATIONS: GuardMutation[] = [
  {
    id: 'mcp-law1-opt-in-reranker-statically-imported',
    file: 'store.ts',
    find: "import { dirname } from 'node:path';",
    replace: "import '@smeltjs/rerank-voyage';\nimport { dirname } from 'node:path';",
    why: 'the opt-in rerank adapter imported into the stdio-local server — the server reranks by asking the core to load one from the consumer\u2019s config, so an edge here is a network client this package never vetted and a second, silent way for one to arrive',
  },
  {
    id: 'mcp-law1-node-https-import',
    file: 'server.ts',
    find: "import { readFileSync } from 'node:fs';",
    replace: "import 'node:https';\nimport { readFileSync } from 'node:fs';",
    why: 'a network transport imported directly into the MCP server',
  },
  {
    id: 'mcp-law1-global-fetch',
    file: 'store.ts',
    find: 'export function resolveMcpStore(cwd: string): ResolvedMcpStore {',
    replace: 'export function resolveMcpStore(cwd: string): ResolvedMcpStore {\n  void fetch;',
    why: 'a network-capable global referenced without any import at all',
  },
  {
    id: 'mcp-law1-http-transport-subpath',
    file: 'server.ts',
    find: "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    replace:
      "import '@modelcontextprotocol/sdk/server/sse.js';\n" +
      "import { Server } from '@modelcontextprotocol/sdk/server/index.js';",
    why:
      'an HTTP/SSE transport subpath of the sanctioned SDK — the package name is vetted, ' +
      'the network half of it is not, so the guard must pin subpaths rather than the name',
  },
  {
    id: 'mcp-law1-unclassified-package',
    file: 'bin.ts',
    find: "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    replace:
      "import 'some-package-nobody-vetted';\n" +
      "import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';",
    why: 'a dependency that matches no list — the case a forbidden-list alone misses',
  },
];
