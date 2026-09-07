import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import {
  budgetFault,
  budgetMalformed,
  budgetRequired,
  createRetrieveBatchTool,
  createRetrieveTool,
  formatReport,
  isStrategy,
  mapTree,
  readBlob,
  readCounters,
  readLedger,
  readTree,
  resolveStrategy,
  retrieveBytes,
  retrieveMany,
  RETRIEVE_BATCH_TOOL_NAME,
  RETRIEVE_TOOL_NAME,
  smeltBlob,
  SmeltError,
  STRATEGIES,
  UnknownHashError,
} from '@smeltjs/core';
import type {
  RetrieveBatchTool,
  RetrievedBlock,
  RetrieveTool,
  Ruling,
  Strategy,
} from '@smeltjs/core';

import { resolveMcpStore } from './store.ts';
import type { ResolvedMcpStore } from './store.ts';

/**
 * The smelt MCP server: the same library the `smelt` CLI fronts, as five stdio tools.
 *
 * The tool surface is deliberately minimal: `smelt_file`, `smelt_retrieve`,
 * `smelt_retrieve_batch`, `repo_map`, `smelt_stats` — the smallest set that covers
 * cut, un-cut (one hash, or several in one round trip), orient, and audit. Everything
 * else the library offers stays a library concern; a tool a model never needed is
 * context every call pays for. The batch tool earned its slot by measurement: tier 4
 * of the bench showed the smelted arm's summed input exceeding the raw arm's on five
 * of nine cases, because every one-hash retrieval is a new request that re-bills the
 * transcript. `smelt_retrieve` is the frozen wire surface and stays byte-identical
 * beside it.
 *
 * **Each tool is an adapter, and nothing more: validate the JSON Schema, call the op,
 * wrap the answer.** The verbs themselves are `smeltBlob`, `mapTree`, `retrieveBytes`,
 * `retrieveMany` and `readCounters` in `@smeltjs/core`'s ops seam, which sits below this server and
 * below the `smelt` binary alike — so the two front doors cannot drift on what a verb
 * does. The laws their inputs must satisfy come from the same place (a budget is a
 * positive integer with no default; an explicit strategy beats a configured one and
 * `lexical` fills last; a tree reader refuses a file; a path is read or the refusal
 * names it), each stated once there and spelled in *this* surface's vocabulary here:
 * `"budgetBytes"` rather than `--budget`, `smelt_file` rather than `smelt <file>`.
 *
 * What stays this server's own is what genuinely is: the schemas, the descriptions, the
 * `isError` envelope — and one deliberate divergence from the CLI, kept here on
 * purpose. `smelt retrieve` refuses a memory store outright; this server accepts one,
 * serves the whole session from it, and appends {@link ResolvedMcpStore.persistenceHint}
 * at the moment an unknown hash makes the difference bite. A resident process can
 * honestly serve a session-lifetime store; a fresh CLI process cannot.
 *
 * Two further properties are load-bearing and guarded:
 *
 * - **stdio-local.** This package's one sanctioned dependency beyond the core is the
 *   official `@modelcontextprotocol/sdk`, and only its stdio transport. The SDK also
 *   ships HTTP/SSE transports; no module here imports them, and
 *   `test/guards/no-network.test.ts` pins the exact SDK subpaths this source may
 *   touch — so Law 1 (zero network) holds for the server the same way it holds for
 *   the library under it.
 * - **stdout carries protocol JSON only.** The transport owns stdout; every human
 *   word this server says goes to stderr. A log line on stdout is a corrupted
 *   JSON-RPC stream, which clients report as a broken server.
 */

/** The server's protocol-visible name. */
export const SERVER_NAME = 'smelt-mcp';

/** This package's version, read from the manifest so the two cannot drift. */
export const SERVER_VERSION = (
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    version: string;
  }
).version;

/**
 * Tool names. `smelt_retrieve` is the core's frozen wire-surface name, re-exported;
 * `smelt_retrieve_batch` is its additive sibling, named once in the core beside it.
 */
export const SMELT_FILE_TOOL_NAME = 'smelt_file';
export const REPO_MAP_TOOL_NAME = 'repo_map';
export const SMELT_STATS_TOOL_NAME = 'smelt_stats';
export { RETRIEVE_BATCH_TOOL_NAME, RETRIEVE_TOOL_NAME } from '@smeltjs/core';

/**
 * The `instructions` field of the initialize result. A hint, not a lever (clients MAY
 * surface it — see docs/research/2026-09-02-agent-enforcement.md §4), so it carries
 * the one fact a model cannot infer from the tool list alone: markers' in-band
 * `retrieve("hash")` maps to the `smelt_retrieve` tool here. Kept well under the 2 KB
 * cap Claude Code applies to descriptions + instructions.
 */
export const SERVER_INSTRUCTIONS =
  'smelt shrinks what enters your context without lying about what it removed. ' +
  'Use smelt_file instead of reading a large file (or pasting a large blob) raw: it cuts ' +
  'the text to a byte budget and replaces everything it removed with one-line markers like ' +
  '`<<smelt/v1: collapsed 3 sibling functions (2224B) — retrieve("84998967370f38bc")>>`. ' +
  'A marker\'s retrieve("hash") maps to the smelt_retrieve tool: call it with the hash to ' +
  'get the exact original bytes back — nothing is deleted, and guessing at what a marker ' +
  'hid is never correct; when several markers matter, smelt_retrieve_batch takes every ' +
  'hash in one call and returns one block per hash. repo_map renders a ranked symbol map of a directory tree inside a ' +
  'byte budget, for orienting in an unfamiliar repository. Retrievals are counted; ' +
  'smelt_stats reads the counters (including the expansion rate — the fraction of hidden ' +
  'content asked for back) without changing them.';

/** Options for {@link createSmeltMcpServer}. */
export interface SmeltMcpServerOptions {
  /**
   * Where `smelt.config.json` discovery starts — the directory the harness launched
   * the server in, which is how the CLI and the server find the same store. Defaults
   * to the process working directory.
   */
  readonly cwd?: string;
}

/** A constructed server plus the store decision it runs on. */
export interface SmeltMcpServer {
  /** The SDK server. Connect it to a transport; `bin.ts` wires real stdio. */
  readonly server: Server;
  /** The store decision, for the startup line and for tests. */
  readonly resolved: ResolvedMcpStore;
}

/** One text block, the shape every tool result here is built from. */
function text(value: string): { type: 'text'; text: string } {
  return { type: 'text', text: value };
}

/**
 * A tool-level error: `isError: true` plus a message the model can act on. Distinct
 * from a protocol error on purpose — a bad argument or an unknown hash is a fact about
 * this call, not a broken server, and the model is the party that can correct it.
 */
function toolError(message: string): CallToolResult {
  return { isError: true, content: [text(message)] };
}

/** Thrown by the argument readers below; caught and rendered as a tool error. */
class ToolArgumentError extends Error {}

function asArguments(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ToolArgumentError('arguments must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

/**
 * Refuse unknown argument keys, exactly as the CLI refuses unknown config keys: a
 * typo'd `focuss` that parsed cleanly would be an argument the model believed it
 * passed, silently ignored — the one failure shape this project refuses everywhere.
 */
function refuseUnknownKeys(args: Record<string, unknown>, known: readonly string[]): void {
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new ToolArgumentError(
      `unknown argument${unknown.length === 1 ? '' : 's'} ` +
        `${unknown.map((key) => `"${key}"`).join(', ')}. ` +
        `Known arguments: ${known.length === 0 ? '(none)' : known.join(', ')}.`,
    );
  }
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new ToolArgumentError(`"${key}" must be a string.`);
  return value;
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined || value === '') {
    throw new ToolArgumentError(`"${key}" is required and must be a non-empty string.`);
  }
  return value;
}

/**
 * `budgetBytes`, validated the way the CLI validates `--budget`, because it is the same
 * law: `ops/inputs.ts` owns the rule and both sentences, and this function supplies
 * only how *this* surface spells the knob. There is no default — a budget this server
 * invented would silently decide how much of the caller's context to throw away.
 *
 * The lexing is this surface's own: a JSON argument arrives with whatever type the
 * model sent, so "is it a number at all" is answered here, and the numeric rule (whole,
 * greater than zero) is answered by the law.
 */
function requireBudget(args: Record<string, unknown>): number {
  const value = args['budgetBytes'];
  if (value === undefined) {
    throw new ToolArgumentError(
      budgetRequired({ knob: '"budgetBytes"', stake: 'your context to throw away' }),
    );
  }
  if (typeof value !== 'number') {
    throw new ToolArgumentError(budgetMalformed('not-an-integer', '"budgetBytes"', value));
  }
  const fault = budgetFault(value);
  if (fault !== undefined) {
    throw new ToolArgumentError(budgetMalformed(fault, '"budgetBytes"', value));
  }
  return value;
}

function optionalFocus(args: Record<string, unknown>): readonly string[] | undefined {
  const value = args['focus'];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ToolArgumentError('"focus" must be an array of strings.');
  }
  return value as readonly string[];
}

/**
 * `hashes` for the batch tool: a non-empty array of strings, or an argument error.
 * Non-empty is an argument law rather than an empty answer: a model that sent `[]`
 * meant to send something, and a silent `[]` back would teach it nothing.
 */
function requireHashes(args: Record<string, unknown>): readonly string[] {
  const value = args['hashes'];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== 'string' || item === '')
  ) {
    throw new ToolArgumentError('"hashes" must be a non-empty array of strings.');
  }
  return value as readonly string[];
}

function optionalStrategy(args: Record<string, unknown>): Strategy | undefined {
  const value = optionalString(args, 'strategy');
  if (value === undefined) return undefined;
  if (!isStrategy(value)) {
    throw new ToolArgumentError(
      `"strategy" must be ${STRATEGIES.map((s) => `"${s}"`).join(' or ')}, ` +
        `got ${JSON.stringify(value)}.`,
    );
  }
  return value;
}

/**
 * A {@link Ruling} from an ops law, in this surface's currency: the value, or a tool
 * error carrying the law's own sentence. The laws return rather than throw precisely
 * so this conversion is explicit — the CLI turns the same refusal into a
 * `CliUsageError` that exits 2, and a shared exception type would have made one of the
 * two wrong.
 */
function take<T>(ruling: Ruling<T>): T {
  if (!ruling.ok) throw new ToolArgumentError(ruling.refusal);
  return ruling.value;
}

/** The JSON Schema fragments the tool list advertises. */
const BUDGET_SCHEMA = {
  type: 'integer',
  minimum: 1,
  description:
    'Output ceiling in UTF-8 bytes. Required — there is no default budget. Budgets are ' +
    'bytes, permanently: bytes are the only unit computable locally for every model.',
} as const;

const FOCUS_SCHEMA = {
  type: 'array',
  items: { type: 'string' },
  description:
    'What the task is actually about — a symbol name, an error string, a grep pattern. ' +
    'Matching regions survive; everything else is first to go.',
} as const;

function buildToolList(retrieveTool: RetrieveTool, batchTool: RetrieveBatchTool): Tool[] {
  return [
    {
      name: SMELT_FILE_TOOL_NAME,
      description:
        'Shrink a file (or a blob of text) to a byte budget before it enters context, ' +
        'without losing anything: the parts the task needs survive, and every removed ' +
        'region is replaced by a one-line marker naming what went, how big it was, and a ' +
        'hash that smelt_retrieve turns back into the exact original bytes. Use it ' +
        'instead of reading a large file raw; for a small file, reading raw is cheaper ' +
        'than a round trip. Returns two text blocks: the smelted text, then a report of ' +
        'every elision (rule, lines, bytes, hash, explanation, and — for structural cuts — ' +
        'the names of the declarations behind the marker, so you can decide what to ' +
        'retrieve without retrieving it).',
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
              'The command whose output "text" is, e.g. "grep -C 3 foo src". When "focus" ' +
              'is absent, the focus is derived from it exactly as the smelt hooks guard ' +
              'derives it: a search pattern, only when the output also holds non-matching ' +
              'lines (context flags). cat, diffs and logs name no term.',
          },
          strategy: {
            type: 'string',
            enum: [...STRATEGIES],
            description:
              '"structural" parses the file and collapses whole sibling declarations ' +
              '(refused, never approximated, for languages without a bundled grammar); ' +
              '"lexical" uses focus windows — right for logs, traces, and anything that ' +
              'is not code; "auto" picks structural for a language smelt has a grammar ' +
              'for and lexical for everything else, and the report names whichever one ' +
              'ran. Defaults to the smelt.config.json strategy, else "lexical".',
          },
        },
        required: ['budgetBytes'],
        additionalProperties: false,
      },
    },
    {
      name: RETRIEVE_TOOL_NAME,
      // The core renders this description around a marker built by the real marker
      // builder, so the example a model learns from can never drift from the wire
      // format. Reused verbatim for the same reason the tool name is.
      description: retrieveTool.description,
      // And so is the schema. `RetrieveTool.inputSchema` is the core's own
      // description of `hash in, exact bytes out` — already strict-mode shaped
      // (`additionalProperties: false`, every property required) so a
      // structured-outputs consumer can register it. A copy here would be a second
      // schema for one contract, and nothing would report the day they disagreed:
      // the library caller and the model would be reading different documents about
      // the same call. `required` is copied because the SDK's `Tool` wants a mutable
      // array; the shape is the core's, verbatim.
      inputSchema: {
        ...retrieveTool.inputSchema,
        required: [...retrieveTool.inputSchema.required],
      },
    },
    {
      name: RETRIEVE_BATCH_TOOL_NAME,
      // The core's description and schema again, for the same reason: one contract,
      // one document. The batch tool is the single tool's additive sibling — an array
      // where the other takes one string — and its result here is one text block per
      // hash, each block's first line naming the hash it answers, because a batch
      // must say which bytes belong to which marker; everything after that first line
      // is the exact original bytes.
      description:
        `${batchTool.description} Returns one text block per hash, in the order asked: ` +
        'the first line names the hash and its byte count, and everything after it is ' +
        'the exact original bytes. A hash the store does not hold gets a block carrying ' +
        'the refusal instead, and the other hashes still come back.',
      inputSchema: {
        ...batchTool.inputSchema,
        required: [...batchTool.inputSchema.required],
      },
    },
    {
      name: REPO_MAP_TOOL_NAME,
      description:
        'A ranked symbol map of a whole directory tree, fitted to a byte budget by ' +
        'construction — tree-sitter definition tags ranked by references (modelled on ' +
        "Aider's repo map), every included symbol stating why it ranked. Use it to " +
        'orient in an unfamiliar repository before opening files; it elides nothing and ' +
        'stores nothing, so there is nothing to retrieve from it.',
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
        "The store's retrieval counters, verbatim: elisionsStored, bytesStored, " +
        'retrieveCalls, uniqueRetrieved, misses, expansionRate (the fraction of hidden ' +
        'blobs asked for back — the honest signal of over-pruning) and ' +
        'allElisionsRetrieved — then, as a second block, the per-rule ledger: for each ' +
        'elision rule, how many cuts it made and how many were asked for back. Reading ' +
        'stats is not a retrieval and never moves the counters.',
      inputSchema: {
        type: 'object',
        properties: {},
        // `required: []` rather than no `required` at all. This tool takes no
        // arguments, so strict structured outputs — which wants every property
        // required and the key present — is satisfied by stating the empty list, and a
        // client registering in strict mode gets the one tool that needed nothing from
        // it. The other tools have genuinely optional arguments and are a different
        // question; this one was a missing key.
        required: [],
        additionalProperties: false,
      },
    },
  ];
}

/**
 * Build the server: resolve the store once, register the five tools, and wire every
 * refusal to a tool-level error rather than a crash.
 *
 * @throws {CliUsageError} when a `smelt.config.json` exists and is malformed — the
 *   server refuses to start on a config it cannot have meant, exactly as the CLI does.
 */
export function createSmeltMcpServer(options: SmeltMcpServerOptions = {}): SmeltMcpServer {
  const cwd = options.cwd ?? process.cwd();
  const resolved = resolveMcpStore(cwd);
  const retrieveTool = createRetrieveTool(resolved.store);
  const batchTool = createRetrieveBatchTool(resolved.store);
  const tools = buildToolList(retrieveTool, batchTool);

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    try {
      const args = asArguments(request.params.arguments);
      switch (name) {
        case SMELT_FILE_TOOL_NAME:
          return await handleSmeltFile(args, resolved, cwd);
        case RETRIEVE_TOOL_NAME:
          return handleRetrieve(args, resolved);
        case RETRIEVE_BATCH_TOOL_NAME:
          return handleRetrieveBatch(args, resolved);
        case REPO_MAP_TOOL_NAME:
          return await handleRepoMap(args, cwd);
        case SMELT_STATS_TOOL_NAME:
          return handleStats(args, resolved);
        default:
          throw new McpError(ErrorCode.InvalidParams, `unknown tool "${name}"`);
      }
    } catch (error) {
      if (error instanceof ToolArgumentError) return toolError(`${name}: ${error.message}`);
      // The library said no — a refusal, passed through with its name so the model
      // can tell a GrammarUnavailableError from an UnknownHashError. Never an empty
      // result, never a crash: a refusal is an answer.
      if (error instanceof SmeltError) return toolError(`${error.name}: ${error.message}`);
      throw error;
    }
  });

  return { server, resolved };
}

async function handleSmeltFile(
  args: Record<string, unknown>,
  resolved: ResolvedMcpStore,
  cwd: string,
): Promise<CallToolResult> {
  refuseUnknownKeys(args, ['path', 'text', 'budgetBytes', 'focus', 'producer', 'strategy']);
  const path = optionalString(args, 'path');
  const inline = optionalString(args, 'text');
  const producer = optionalString(args, 'producer');
  if ((path === undefined) === (inline === undefined)) {
    throw new ToolArgumentError(
      'pass exactly one of "path" (a file to read) or "text" (the blob itself).',
    );
  }
  const budgetBytes = requireBudget(args);
  const focus = optionalFocus(args);
  // The same precedence the CLI applies to --strategy: what the caller said wins, the
  // config fills in, `lexical` fills last — and the built-in is named in one place.
  const { strategy } = resolveStrategy(optionalStrategy(args), resolved.defaultStrategy);

  // A relative path is resolved against the server's working directory, but the
  // refusal names the path as the model wrote it: echoing back an absolute path it
  // never typed answers a question nobody asked.
  const inputText =
    path === undefined ? (inline as string) : take(readBlob(resolve(cwd, path), path));

  const outcome = await smeltBlob({
    text: inputText,
    source: path ?? '<text>',
    budgetBytes,
    strategy,
    store: resolved.store,
    ...(path === undefined ? {} : { path }),
    ...(focus === undefined ? {} : { focus }),
    ...(producer === undefined ? {} : { producer }),
  });

  // Two blocks: the payload, then the same report the CLI prints to stderr — built
  // from the values the op returned, so no total is counted twice. Over budget is
  // reported in the report (the plan came back as it came back), not dressed up as an
  // error. The one word this surface supplies is how it spells the producer knob.
  return {
    content: [
      text(outcome.result.text),
      text(formatReport({ ...outcome, producerKnob: 'producer' })),
    ],
  };
}

function handleRetrieve(args: Record<string, unknown>, resolved: ResolvedMcpStore): CallToolResult {
  refuseUnknownKeys(args, ['hash']);
  const hash = requireString(args, 'hash');
  try {
    // The counted read — this is the expansion rate moving. Exact original bytes,
    // nothing appended, nothing re-encoded.
    return { content: [text(retrieveBytes({ store: resolved.store, hash }))] };
  } catch (error) {
    if (error instanceof UnknownHashError && resolved.persistenceHint !== undefined) {
      // On a memory store, "unknown hash" is very often "hash from an earlier
      // session" — say so. This is the deliberate divergence from the CLI, which
      // refuses a memory store for `smelt retrieve` outright: a resident process can
      // honestly serve a session-lifetime store, a fresh CLI process cannot.
      return toolError(`${error.name}: ${error.message}\n\n${resolved.persistenceHint}`);
    }
    throw error;
  }
}

/**
 * One block per hash, in the order asked. Each block's first line names the hash and
 * the byte count, then the exact bytes follow — a batch has to label its answers, and
 * the label sits on its own line so the bytes after it are verbatim. A refused hash
 * gets its refusal in the same slot, so the model can pair every answer with the
 * marker it came from. The result is a tool error only when *every* hash was refused:
 * a partial answer is an answer, and the counters moved for it.
 */
function handleRetrieveBatch(
  args: Record<string, unknown>,
  resolved: ResolvedMcpStore,
): CallToolResult {
  refuseUnknownKeys(args, ['hashes']);
  const hashes = requireHashes(args);
  const blocks = retrieveMany({ store: resolved.store, hashes });
  const hint = resolved.persistenceHint;
  const content = blocks.map((block) => text(renderBlock(block, hint)));
  const allRefused = blocks.every((block) => 'error' in block);
  return allRefused ? { isError: true, content } : { content };
}

function renderBlock(block: RetrievedBlock, persistenceHint: string | undefined): string {
  if ('text' in block) {
    return `hash ${block.hash} (${String(Buffer.byteLength(block.text, 'utf8'))} B):\n${block.text}`;
  }
  const refusal = `hash ${block.hash}: ${block.error.name}: ${block.error.message}`;
  // The same divergence `smelt_retrieve` documents: on a memory store an unknown hash
  // is very often a hash from an earlier session, and the moment it bites is the
  // moment to say how to get persistence.
  return block.error instanceof UnknownHashError && persistenceHint !== undefined
    ? `${refusal}\n\n${persistenceHint}`
    : refusal;
}

async function handleRepoMap(args: Record<string, unknown>, cwd: string): Promise<CallToolResult> {
  refuseUnknownKeys(args, ['dir', 'budgetBytes', 'focus']);
  const dir = requireString(args, 'dir');
  const budgetBytes = requireBudget(args);
  const focus = optionalFocus(args);

  // The same two refusals `smelt map` gives, in this surface's vocabulary: a path that
  // cannot be statted, and a path that is a file and therefore wanted the other verb.
  const root = take(
    readTree(resolve(cwd, dir), dir, { tree: REPO_MAP_TOOL_NAME, file: SMELT_FILE_TOOL_NAME }),
  );

  const map = await mapTree({
    root,
    budgetBytes,
    ...(focus === undefined ? {} : { focus }),
  });

  const blocks = [text(map.text)];
  if (map.warnings.length > 0) {
    blocks.push(
      text(
        map.warnings
          .map((warning) => `warning  ${warning.rule}: ${warning.explanation}`)
          .join('\n'),
      ),
    );
  }
  return { content: blocks };
}

function handleStats(args: Record<string, unknown>, resolved: ResolvedMcpStore): CallToolResult {
  refuseUnknownKeys(args, []);
  // The uncounted read — `stats()` journals nothing, because an observer that inflated
  // its own metric would make the honest signal dishonest. The RetrieveStats goes out
  // verbatim, as JSON.
  // The ledger as its own block beside them — the first block stays the RetrieveStats
  // verbatim, as it always was, so a reader of one is never handed a reshaped other.
  return {
    content: [
      text(JSON.stringify(readCounters({ store: resolved.store }), null, 2)),
      text(JSON.stringify(readLedger({ store: resolved.store }) ?? [], null, 2)),
    ],
  };
}
