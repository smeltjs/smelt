import {
  createRetrieveBatchTool,
  createRetrieveTool,
  MemoryElisionStore,
  STRATEGIES,
} from '@smeltjs/core';
import { describe, expect, it } from 'vitest';

import { TOOL_LIST_BUDGET_BYTES, TOOL_SURFACE_BUDGET_BYTES, toolSurface } from '@guard/surface';

import type { GuardMutation } from './_mutations.ts';
import { readSource } from './_source.ts';

/**
 * THE TOOL SURFACE GUARD — the one byte budget smelt spends on every session, measured.
 *
 * Every tool description and the server's `instructions` string travel to the model
 * on `initialize` and `tools/list`, relevant or not, on every session this server is
 * registered in. That is a context-budget fact, and this repository's whole thesis is
 * that context-budget facts are measured. Until this guard existed, the server's own
 * doc comment claimed the surface was "kept well under the 2 KB cap" while the
 * measured total was 3,718 bytes — a claimed number with no measurement behind it, in
 * a package whose fourth law forbids exactly that.
 *
 * So the surface is a value with two sizes: `toolSurface()` renders the five tools and
 * the instructions once and returns them beside the prose count (descriptions plus
 * instructions) and the payload count (the serialized tools/list plus instructions —
 * schemas included, because they travel too). This guard holds the first under
 * {@link TOOL_SURFACE_BUDGET_BYTES} and the second under {@link TOOL_LIST_BUDGET_BYTES}.
 * Four checks:
 *
 *   1. **Under the ceilings.** Both measured totals are at or under their budgets.
 *   2. **Actually measured.** Each reported count equals an independent recount, so a
 *      measurement that stopped counting (or counted the wrong strings) is red — a
 *      guard that trusted the module's own arithmetic would be the vacuous guard this
 *      repository refuses.
 *   3. **The core's descriptions, verbatim.** `smelt_retrieve` and
 *      `smelt_retrieve_batch` are described once, in `@smeltjs/core`, around a marker
 *      the real marker builder rendered. A server-side tail on either is a second
 *      document for one contract, and it was the single largest contributor to the
 *      overrun this guard retires.
 *   4. **Type imports only.** `surface.ts` imports nothing at runtime, so the mutation
 *      runner's bare copy of `src` (no `node_modules` beside it) can be imported here
 *      and *executed* — which is what lets this guard measure rather than grep. The
 *      pin matters in its own right: a runtime import would make every mutation go
 *      red on module resolution, reported as caught for a reason unrelated to the
 *      break, which is the vacuous guard in its most convincing disguise.
 */

const store = new MemoryElisionStore();
const retrieveTool = createRetrieveTool(store);
const batchTool = createRetrieveBatchTool(store);
const surface = toolSurface({ retrieveTool, batchTool, strategies: STRATEGIES });

function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

describe('the tool surface is measured and under its budget', () => {
  it(`spends at most ${String(TOOL_SURFACE_BUDGET_BYTES)} bytes on descriptions + instructions`, () => {
    expect(
      surface.bytes,
      `the five tool descriptions plus the server instructions measure ${String(surface.bytes)} B, ` +
        `over the ${String(TOOL_SURFACE_BUDGET_BYTES)} B ceiling. Every session pays this on ` +
        `initialize and tools/list; trim a description or raise the constant knowingly.`,
    ).toBeLessThanOrEqual(TOOL_SURFACE_BUDGET_BYTES);
  });

  it(`sends at most ${String(TOOL_LIST_BUDGET_BYTES)} bytes as the whole tools/list payload + instructions`, () => {
    expect(
      surface.listBytes,
      `the serialized tool list plus instructions measures ${String(surface.listBytes)} B, over ` +
        `the ${String(TOOL_LIST_BUDGET_BYTES)} B ceiling — schema prose travels too; trim it or raise the constant knowingly.`,
    ).toBeLessThanOrEqual(TOOL_LIST_BUDGET_BYTES);
  });

  it('reports the byte counts it actually measured', () => {
    const recount =
      surface.tools.reduce((sum, tool) => sum + utf8(tool.description ?? ''), 0) +
      utf8(surface.instructions);
    expect(
      surface.bytes,
      'toolSurface().bytes disagrees with a recount of its own strings — the measurement is not measuring',
    ).toBe(recount);
    expect(surface.bytes, 'a surface with no bytes is not a surface').toBeGreaterThan(0);
    const listRecount = utf8(JSON.stringify(surface.tools)) + utf8(surface.instructions);
    expect(
      surface.listBytes,
      'toolSurface().listBytes disagrees with a recount of the serialized list — the measurement is not measuring',
    ).toBe(listRecount);
    expect(surface.listBytes, 'the payload is larger than its prose').toBeGreaterThan(
      surface.bytes,
    );
  });

  it('imports nothing at runtime, so this guard can execute a mutant copy of it', () => {
    const source = readSource('surface.ts');
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(
      imports.length,
      'surface.ts has no imports at all — the SDK Tool type went somewhere',
    ).toBeGreaterThan(0);
    for (const line of imports) {
      expect(
        line.startsWith('import type '),
        `surface.ts carries a runtime import — "${line}" — so a mutant copy fails on module ` +
          'resolution before any assertion runs, and every mutation reads as caught for the wrong reason',
      ).toBe(true);
    }
  });

  it('serves exactly five tools, named as the markers and the SkillPack expect', () => {
    expect(surface.tools.map((tool) => tool.name)).toEqual([
      'smelt_file',
      'smelt_retrieve',
      'smelt_retrieve_batch',
      'repo_map',
      'smelt_stats',
    ]);
  });

  it("describes smelt_retrieve and smelt_retrieve_batch in the core's words, verbatim", () => {
    const byName = new Map(surface.tools.map((tool) => [tool.name, tool] as const));
    expect(
      byName.get('smelt_retrieve')?.description,
      'the smelt_retrieve description is not the core’s — a second document for one contract',
    ).toBe(retrieveTool.description);
    expect(
      byName.get('smelt_retrieve_batch')?.description,
      'the smelt_retrieve_batch description has grown a server-side tail — the core’s sentence is the whole description',
    ).toBe(batchTool.description);
  });

  it('teaches the one unlearnable fact in the instructions: retrieve("hash") is the smelt_retrieve tool', () => {
    expect(surface.instructions).toContain('retrieve("hash")');
    expect(surface.instructions).toContain('smelt_retrieve');
  });
});

export const MUTATIONS: GuardMutation[] = [
  {
    id: 'mcp-tool-surface-padded-past-budget',
    file: 'surface.ts',
    find: "    'Shrink a file (or a blob of text) to a byte budget before it enters context. '",
    replace:
      "    'Shrink a file (or a blob of text) to a byte budget before it enters context. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. ' +\n" +
      "    'This sentence is padding that a reviewer waved through because it read well and nobody measured it. '",
    why: 'a description grown by two kilobytes of prose that reads well — the overrun this guard was written to catch, arriving the way the original one did: one helpful sentence at a time, with nothing counting',
  },
  {
    id: 'mcp-tool-surface-measurement-removed',
    file: 'surface.ts',
    find: '  const bytes = described + utf8(SERVER_INSTRUCTIONS);',
    replace: '  const bytes = 0;',
    why: 'the measurement replaced by a flattering constant — the surface reports zero bytes forever and the ceiling check passes vacuously, which is a claimed number with no measurement behind it, the exact Law 4 breach this guard exists to make impossible',
  },
  {
    id: 'mcp-tool-surface-batch-tail-regrown',
    file: 'surface.ts',
    find: '      description: batchTool.description,',
    replace:
      '      description: `${batchTool.description} Returns one text block per hash, in the order asked.`,',
    why: "a server-side tail appended to the core's smelt_retrieve_batch description — the second document for one contract that was the single largest contributor to the 3,718-byte overrun, growing back",
  },
  {
    id: 'mcp-tool-surface-list-measurement-removed',
    file: 'surface.ts',
    find: '  const listBytes = utf8(JSON.stringify(tools)) + utf8(SERVER_INSTRUCTIONS);',
    replace: '  const listBytes = bytes;',
    why: 'the payload measurement quietly reporting the prose figure — the schemas stop being counted, and a strategy description that grows back to six hundred characters is invisible to both ceilings',
  },
  {
    id: 'mcp-tool-surface-runtime-import',
    file: 'surface.ts',
    find: "import type { RetrieveBatchTool, RetrieveTool, Strategy } from '@smeltjs/core';",
    replace:
      "import { STRATEGIES, type RetrieveBatchTool, type RetrieveTool, type Strategy } from '@smeltjs/core';",
    why: 'a runtime import into the one module the guard executes from a bare copy of src — module resolution fails before any assertion runs, every other mutation turns red for the wrong reason, and the type-only pin is the only check that names the actual break',
  },
];
