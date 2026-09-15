import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { RetrieveBatchTool, RetrieveTool, Strategy } from '@smeltjs/core';

/**
 * The tool surface: what this server says to a model before the model has asked it
 * anything — the five tools and the `instructions` string — rendered once, as one
 * value, beside two measured sizes: the prose (every tool description plus the
 * instructions) and the whole serialized `tools/list` payload plus the instructions,
 * which is what a session actually pays, schemas included.
 *
 * Why a module of its own, and why it imports nothing at runtime. Every byte here
 * travels on `initialize` and `tools/list` in every session the server is registered
 * in, relevant or not: it is the one context budget smelt spends on its own account,
 * and until it was measured the server's doc comment claimed the prose sat "well under
 * 2 KB" while it measured 3,718 bytes. `test/guards/tool-surface.test.ts` now holds
 * the prose under {@link TOOL_SURFACE_BUDGET_BYTES} and the whole payload under
 * {@link TOOL_LIST_BUDGET_BYTES}, each recounted rather than trusted; for that guard
 * to *execute* this module from the mutation runner's bare copy of `src` (no
 * `node_modules` beside it), the module takes the core's two tools and the strategy
 * list as arguments rather than importing them, and every import here is a type
 * import — the guard pins that too, because a runtime import would turn every mutation
 * red on module resolution instead of on the break.
 *
 * What the prose is allowed to say follows the same rule the SkillPack renders under:
 * the trigger and the mechanism, never a saving. `smelt_retrieve` and
 * `smelt_retrieve_batch` are described by the core, verbatim — the example marker in
 * them is rendered by the real marker builder — and this module adds not one word to
 * either, because a server-side tail was the single largest piece of the overrun.
 */

/** Tool names. `smelt_retrieve` is the core's frozen wire-surface name; see the core. */
export const SMELT_FILE_TOOL_NAME = 'smelt_file';
export const REPO_MAP_TOOL_NAME = 'repo_map';
export const SMELT_STATS_TOOL_NAME = 'smelt_stats';

/**
 * The ceiling the guard holds the prose under, in UTF-8 bytes: the five tool
 * descriptions plus the instructions. It is smelt's own budget for its own prose, not
 * a claim about any client's limit — clients truncate, and at differing sizes, which
 * is exactly why the number here is measured rather than assumed. Raise it knowingly,
 * with the measurement in hand.
 */
export const TOOL_SURFACE_BUDGET_BYTES = 2048;

/**
 * The ceiling on the whole payload: the serialized `tools/list` result (names,
 * descriptions, every input schema with its property descriptions) plus the
 * instructions — what a session actually pays. The prose ceiling above is the part a
 * model reads as prose; this one is the part the transport sends.
 */
export const TOOL_LIST_BUDGET_BYTES = 5120;

/**
 * The `instructions` field of the initialize result. A hint clients MAY surface (see
 * docs/research/2026-09-02-agent-enforcement.md §4), so it carries the one fact a model
 * cannot infer from the tool list alone: a marker's in-band `retrieve("hash")` names
 * the `smelt_retrieve` tool here. Everything else is on the tools themselves. Its size
 * is counted into {@link ToolSurface.bytes}, which `test/guards/tool-surface.test.ts`
 * holds under {@link TOOL_SURFACE_BUDGET_BYTES} — the measured fact that replaced this
 * comment's former "well under 2 KB".
 */
export const SERVER_INSTRUCTIONS =
  'smelt shrinks what enters your context: removed regions become one-line <<smelt/v1: …>> ' +
  'markers whose retrieve("hash") names the smelt_retrieve tool — call it with the hash for ' +
  'the exact original bytes; smelt_retrieve_batch takes several in one call. Nothing is ' +
  'deleted; guessing at what a marker hid is never correct.';

/** What the surface renders from: the core's two retrieve tools and the strategy list. */
export interface ToolSurfaceInput {
  readonly retrieveTool: RetrieveTool;
  readonly batchTool: RetrieveBatchTool;
  readonly strategies: readonly Strategy[];
}

/** The rendered surface, with its measured size. */
export interface ToolSurface {
  /** The tool list, in the order `tools/list` serves it. */
  readonly tools: readonly Tool[];
  /** The initialize result's `instructions`. */
  readonly instructions: string;
  /** UTF-8 bytes of every tool description plus the instructions: the prose. */
  readonly bytes: number;
  /** UTF-8 bytes of the serialized tool list plus the instructions: what the transport sends. */
  readonly listBytes: number;
}

const BUDGET_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description: 'Output ceiling in UTF-8 bytes. Required — there is no default budget.',
} as const;

const FOCUS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'What the task is about — a symbol, an error string, a grep pattern. Matching ' +
    'regions survive; everything else is first to go.',
} as const;

function utf8(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** Render the surface once and measure it. Pure: same inputs, same bytes. */
export function toolSurface(input: ToolSurfaceInput): ToolSurface {
  const tools = buildToolList(input);
  const described = tools.reduce((sum, tool) => sum + utf8(tool.description ?? ''), 0);
  const bytes = described + utf8(SERVER_INSTRUCTIONS);
  const listBytes = utf8(JSON.stringify(tools)) + utf8(SERVER_INSTRUCTIONS);
  return { tools, instructions: SERVER_INSTRUCTIONS, bytes, listBytes };
}

function buildToolList({ retrieveTool, batchTool, strategies }: ToolSurfaceInput): Tool[] {
  return [
    {
      name: SMELT_FILE_TOOL_NAME,
      description:
        'Shrink a file (or a blob of text) to a byte budget before it enters context. ' +
        'Focus-matched regions survive verbatim; each removed region becomes a one-line ' +
        'marker naming what went, its size, and a hash smelt_retrieve turns back into the ' +
        'exact bytes. Use it instead of reading a large file raw (a small file is cheaper ' +
        'raw). Returns the smelted text, then a report of every elision.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              "File to read and smelt, resolved against the server's working directory. " +
              'Pass exactly one of "path" or "text".',
          },
          text: {
            type: 'string',
            description:
              'The blob itself — a grep result, a build log, a diff. Pass exactly one of ' +
              '"path" or "text".',
          },
          budgetBytes: BUDGET_SCHEMA,
          focus: FOCUS_SCHEMA,
          producer: {
            type: 'string',
            description:
              'The command whose output "text" is, e.g. "grep -C 3 foo src". With no ' +
              '"focus", the focus is derived from it the way the smelt hooks guard does.',
          },
          strategy: {
            type: 'string',
            enum: [...strategies],
            description:
              '"structural" collapses whole declarations (refused without a bundled ' +
              'grammar); "lexical" keeps focus windows — right for logs; "json" and "diff" ' +
              'cut their own kind; "auto" picks by content, then grammar. Defaults to the ' +
              'smelt.config.json strategy, else "lexical".',
          },
        },
        required: ['budgetBytes'],
        additionalProperties: false,
      },
    },
    {
      name: retrieveTool.name,
      // The core renders this description around a marker built by the real marker
      // builder, so the example a model learns from can never drift from the wire
      // format. Reused verbatim for the same reason the tool name is.
      description: retrieveTool.description,
      // And so is the schema. `RetrieveTool.inputSchema` is the core's own
      // description of `hash in, exact bytes out` — already strict-mode shaped
      // (`additionalProperties: false`, every property required) so a
      // structured-outputs consumer can register it. A copy here would be a second
      // schema for one contract, and nothing would report the day they disagreed.
      // `required` is copied because the SDK's `Tool` wants a mutable array; the shape
      // is the core's, verbatim.
      inputSchema: {
        ...retrieveTool.inputSchema,
        required: [...retrieveTool.inputSchema.required],
      },
    },
    {
      name: batchTool.name,
      // The core's description and schema again, and not one word more: the batch
      // tool is the single tool's additive sibling, and a server-side tail restating
      // its block format was the largest single piece of the surface's overrun.
      description: batchTool.description,
      inputSchema: {
        ...batchTool.inputSchema,
        required: [...batchTool.inputSchema.required],
      },
    },
    {
      name: REPO_MAP_TOOL_NAME,
      description:
        'A ranked symbol map of a directory tree, fitted to a byte budget by construction ' +
        '(tree-sitter definitions ranked by references). Use it to orient in an unfamiliar ' +
        'repository before opening files. It elides and stores nothing — nothing to retrieve.',
      inputSchema: {
        type: 'object',
        properties: {
          dir: {
            type: 'string',
            description: "Directory to map, resolved against the server's working directory.",
          },
          budgetBytes: BUDGET_SCHEMA,
          focus: FOCUS_SCHEMA,
        },
        required: ['dir', 'budgetBytes'],
        additionalProperties: false,
      },
    },
    {
      name: SMELT_STATS_TOOL_NAME,
      description:
        "The store's retrieval counters, verbatim — elisionsStored, bytesStored, retrieveCalls, " +
        'uniqueRetrieved, misses, expansionRate (the fraction of hidden blobs asked for back) — ' +
        'then the per-rule ledger as a second block. Reading stats never moves the counters.',
      inputSchema: {
        type: 'object',
        properties: {},
        // `required: []` rather than no `required` at all. This tool takes no
        // arguments, so strict structured outputs — which wants every property
        // required and the key present — is satisfied by stating the empty list.
        required: [],
        additionalProperties: false,
      },
    },
  ];
}
