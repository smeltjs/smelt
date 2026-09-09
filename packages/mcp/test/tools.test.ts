import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  budgetMalformed,
  budgetRequired,
  CliUsageError,
  DirectoryElisionStore,
  readTree,
} from '@smeltjs/core';
import { strictModeViolations, type ToolSchema } from '@smelt/guard-kit';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createSmeltMcpServer,
  REPO_MAP_TOOL_NAME,
  RETRIEVE_BATCH_TOOL_NAME,
  RETRIEVE_TOOL_NAME,
  SMELT_FILE_TOOL_NAME,
  SMELT_STATS_TOOL_NAME,
} from '../src/index.ts';

/**
 * In-process tests for the five tools as **adapters**, driven through a real SDK
 * client over a linked in-memory transport pair — the same protocol layer the stdio
 * binary serves, minus the process boundary (`test/protocol.test.ts` owns that half).
 *
 * What is tested here is what only this package can see: the schema each tool
 * advertises, the shape of the result it returns, the `isError` envelope a refusal
 * arrives in, the arguments only a JSON surface can get wrong, the cwd a relative
 * path resolves against, and the store decision this server makes at startup —
 * including the one place it deliberately rules differently from the CLI.
 *
 * What is **not** tested here any more is what smelt *does*. The budget law, the
 * strategy precedence, the structural refusal, the not-a-directory refusal, the
 * unknown hash and the uncounted counters all moved down to the ops seam they now
 * come from — `packages/core/test/ops.test.ts` — because asserting them through a
 * transport was asserting a library fact in the package furthest from where it is
 * decided, in duplicate with the CLI's own suite. One refusal of each family stays
 * below, on purpose: not to re-test the law, but to prove this adapter renders it as
 * a tool error rather than crashing the server.
 */

const cleanups: (() => void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'smelt-mcp-test-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function connect(cwd: string): Promise<Client> {
  const { server } = createSmeltMcpServer({ cwd });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'smelt-mcp-test', version: '0.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  cleanups.push(() => {
    void client.close();
    void server.close();
  });
  return client;
}

interface ToolResult {
  readonly isError: boolean;
  readonly texts: readonly string[];
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: readonly { type: string; text?: string }[];
  };
  return {
    isError: result.isError === true,
    texts: (result.content ?? [])
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? ''),
  };
}

/** A blob with an obvious focus target and plenty of collapsible padding. */
function fixtureText(lines = 300): string {
  const padding = Array.from({ length: lines }, (_, i) => `padding line ${String(i)}`);
  padding.splice(150, 0, 'the handleRequest line the task is about');
  return `${padding.join('\n')}\n`;
}

describe('tools/list', () => {
  it('serves exactly the five ruled tools, budgetBytes required where it exists', async () => {
    const client = await connect(tempDir());
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).toSorted()).toEqual(
      [
        SMELT_FILE_TOOL_NAME,
        RETRIEVE_TOOL_NAME,
        RETRIEVE_BATCH_TOOL_NAME,
        REPO_MAP_TOOL_NAME,
        SMELT_STATS_TOOL_NAME,
      ].toSorted(),
    );
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    expect(byName.get(SMELT_FILE_TOOL_NAME)?.inputSchema['required']).toEqual(['budgetBytes']);
    expect(byName.get(REPO_MAP_TOOL_NAME)?.inputSchema['required']).toEqual(['dir', 'budgetBytes']);
    expect(byName.get(RETRIEVE_TOOL_NAME)?.inputSchema['required']).toEqual(['hash']);
    expect(byName.get(RETRIEVE_BATCH_TOOL_NAME)?.inputSchema['required']).toEqual(['hashes']);
    expect(byName.get(RETRIEVE_BATCH_TOOL_NAME)?.inputSchema['additionalProperties']).toBe(false);
    // Strict-mode shaped, end to end: the schema a client actually receives closes the
    // object, so a consumer registering it under OpenAI structured outputs in strict
    // mode is not refused at registration. It is the core's own `RetrieveTool`
    // schema — served, never re-written here.
    expect(byName.get(RETRIEVE_TOOL_NAME)?.inputSchema['additionalProperties']).toBe(false);
    // `smelt_stats` takes no arguments, so `required: []` is the whole truth about it
    // and strict mode — which wants the key present — is satisfied by saying so. It
    // used to omit the key entirely, which read as "not yet decided" and cost a strict
    // client the one tool that needed nothing from them.
    expect(byName.get(SMELT_STATS_TOOL_NAME)?.inputSchema['required']).toEqual([]);
    expect(byName.get(SMELT_STATS_TOOL_NAME)?.inputSchema['additionalProperties']).toBe(false);
    // The retrieve description is the core's own, rendered around a real marker — the
    // example a model learns from can never drift from the wire format.
    expect(byName.get(RETRIEVE_TOOL_NAME)?.description).toContain('<<smelt/v1:');
  });
});

describe('smelt_file', () => {
  it('returns the payload and the report as two blocks, markers intact', async () => {
    const client = await connect(tempDir());
    const input = fixtureText();
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: input,
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    expect(result.texts).toHaveLength(2);
    const [smelted, report] = result.texts as [string, string];
    expect(smelted).toContain('the handleRequest line the task is about');
    expect(smelted).toContain('<<smelt/v1:');
    expect(smelted.length).toBeLessThan(input.length);
    // The second block is the CLI's own report, built from the op's return values.
    expect(report).toMatch(/in [\d,]+ B → out [\d,]+ B/);
    expect(report).toContain('focus-window');
  });

  it('reads a file when given a path, resolved against the server cwd', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'build.log'), fixtureText());
    const client = await connect(cwd);
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      path: 'build.log',
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    expect(result.texts[0]).toContain('<<smelt/v1:');
    expect(result.texts[1]).toContain('build.log');
  });

  it('refuses path and text together, and neither, as tool errors', async () => {
    const client = await connect(tempDir());
    const both = await call(client, SMELT_FILE_TOOL_NAME, {
      path: 'x',
      text: 'y',
      budgetBytes: 100,
    });
    expect(both.isError).toBe(true);
    expect(both.texts[0]).toContain('pass exactly one of "path"');
    const neither = await call(client, SMELT_FILE_TOOL_NAME, { budgetBytes: 100 });
    expect(neither.isError).toBe(true);
    expect(neither.texts[0]).toContain('pass exactly one of "path"');
  });

  it('renders the budget law as a tool error naming the tool and the argument', async () => {
    // The law and its whole matrix live in packages/core/test/ops.test.ts. What is
    // this package's to prove is two things: the envelope — `isError`, the tool name,
    // and a sentence a model can act on rather than a crash — and that the sentence
    // is *the core's*. The expectation is composed from `budgetRequired`, never
    // pasted: change the law in the core and this test moves with it, and the server
    // must still match; stop calling the law and it will not. (`test/guards/
    // ops-seam.test.ts` holds the same claim structurally, over source, because the
    // mutation runner cannot import a mutant tree.)
    const client = await connect(tempDir());
    const missing = await call(client, SMELT_FILE_TOOL_NAME, { text: 'hello' });
    expect(missing.isError).toBe(true);
    expect(missing.texts[0]).toBe(
      `${SMELT_FILE_TOOL_NAME}: ` +
        budgetRequired({ knob: '"budgetBytes"', stake: 'your context to throw away' }),
    );

    for (const [budgetBytes, fault] of [
      ['4kb', 'not-an-integer'],
      [1.5, 'not-an-integer'],
      [0, 'not-positive'],
    ] as const) {
      const malformed = await call(client, SMELT_FILE_TOOL_NAME, { text: 'hello', budgetBytes });
      expect(malformed.isError, JSON.stringify(budgetBytes)).toBe(true);
      expect(malformed.texts[0]).toBe(
        `${SMELT_FILE_TOOL_NAME}: ` + budgetMalformed(fault, '"budgetBytes"', budgetBytes),
      );
    }
  });

  it('refuses an unknown argument key instead of silently ignoring it', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: 'hello',
      budgetBytes: 100,
      focuss: ['typo'],
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('unknown argument');
    expect(result.texts[0]).toContain('"focuss"');
  });

  it('refuses an unreadable path as a tool error naming the path as written', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      path: 'no-such-file.txt',
      budgetBytes: 100,
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('cannot read "no-such-file.txt"');
  });

  it('renders a library refusal as a tool error carrying its error name', async () => {
    // A `SmeltError` out of the op is a refusal, not a broken server: it comes back
    // named, so a model can tell a GrammarUnavailableError from an UnknownHashError.
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      strategy: 'structural', // inline text has no path → language 'unknown' → refusal
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('GrammarUnavailableError');
  });

  it('rejects an unknown strategy name against the registry', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: 'hello',
      budgetBytes: 100,
      strategy: 'clever',
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('"strategy" must be');
  });

  it('feeds the config’s strategy to the op, and an argument beats it', async () => {
    // The precedence itself is the ops seam's (see resolveStrategy); what this proves
    // is the wiring — that startup reads smelt.config.json and hands the result over.
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, strategy: 'structural' })}\n`,
    );
    const client = await connect(cwd);
    const configured = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
    });
    expect(configured.isError).toBe(true);
    expect(configured.texts[0]).toContain('GrammarUnavailableError');
    const explicit = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      strategy: 'lexical',
    });
    expect(explicit.isError).toBe(false);
  });
});

function contextGrep(): string {
  const lines: string[] = [];
  for (let file = 0; file < 12; file += 1) {
    for (let i = 0; i < 20; i += 1) lines.push(`src/f${String(file)}.ts-${String(i)}-padding`);
    lines.push(`src/f${String(file)}.ts:21:  return handleRequest(path);`);
    for (let i = 22; i < 40; i += 1) lines.push(`src/f${String(file)}.ts-${String(i)}-padding`);
  }
  return `${lines.join('\n')}\n`;
}

describe('smelt_stats — the ledger beside the counters', () => {
  it('returns the RetrieveStats verbatim first, then the per-rule ledger as its own block', async () => {
    const client = await connect(tempDir());
    await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    const result = await call(client, SMELT_STATS_TOOL_NAME, {});
    expect(result.isError).toBe(false);
    expect(result.texts).toHaveLength(2);
    const stats = JSON.parse(result.texts[0]!) as Record<string, unknown>;
    expect(Object.keys(stats)).not.toContain('ledger');
    const ledger = JSON.parse(result.texts[1]!) as {
      rule: string;
      stored: number;
      retrieved: number;
    }[];
    expect(ledger).toEqual([
      { rule: 'focus-window', stored: stats['elisionsStored'], retrieved: 0 },
    ]);
  });
});

describe('smelt_file — the producer hint', () => {
  it('derives the focus from "producer" the same way the CLI and the guard do', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: contextGrep(),
      budgetBytes: 1500,
      producer: 'grep -C 2 handleRequest src',
    });
    expect(result.isError).toBe(false);
    expect(result.texts[0]).toContain('handleRequest(path)');
    expect(result.texts[1]).toContain('focus  handleRequest');
    expect(result.texts[1]).toContain('from producer');
  });

  it('refuses a non-string producer as an argument', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: 'x',
      budgetBytes: 100,
      producer: 7,
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('"producer" must be a string');
  });
});

describe('smelt_file — the rerank opt-in', () => {
  /**
   * The server offers reranking without importing an adapter: it hands the config
   * block to `@smeltjs/core`'s loader, exactly as the CLI does. So what is pinned here
   * is that the config decides (not this surface), that the attribution reaches the
   * report block a model reads, and that a refusal arrives as a tool error the model
   * can act on rather than a dead server.
   */

  function withRerank(rerank: unknown): string {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'smelt.config.json'),
      `${JSON.stringify({ smeltConfig: 1, rerank }, null, 2)}\n`,
    );
    return dir;
  }

  it('does nothing at all when the config names no reranker', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 1500,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    expect(result.texts[1]).not.toContain('rerank');
  });

  it('loads a configured module stage and attributes it in the report block', async () => {
    const dir = withRerank({ kind: 'module', path: './stage.mjs' });
    writeFileSync(
      join(dir, 'stage.mjs'),
      `export default {
         id: 'test',
         async rerank(candidates) {
           return candidates.slice(0, 1).map((c) => ({ ...c, score: 1 }));
         },
       };\n`,
    );
    const client = await connect(dir);
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 1500,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(false);
    expect(result.texts[1]).toMatch(
      /rerank {2}module\/\.\/stage\.mjs {2}\(\d+ candidates, 1 kept\)/,
    );
  });

  it('answers a misconfigured opt-in with a tool error naming what is missing', async () => {
    // A refusal the model can read and repeat to its user. A resident server that
    // exited at startup instead would say the same thing to nobody.
    const client = await connect(withRerank({ kind: 'module', path: './gone.mjs' }));
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 1500,
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('./gone.mjs');
  });

  it('answers a stage that throws with a tool error, not by crashing the handler', async () => {
    // A reranker's ordinary failures — a timeout, a 401 — throw plain Errors from the
    // consumer's own adapter. Unwrapped they would rethrow past this handler's catch,
    // which only knows ToolArgumentError and SmeltError, and take the tool call out as a
    // protocol-level failure the model cannot read or act on.
    const dir = withRerank({ kind: 'module', path: './boom.mjs' });
    writeFileSync(
      join(dir, 'boom.mjs'),
      `export default {
         id: 'voyage',
         async rerank() { throw new Error('api.voyageai.com did not answer within 30000ms'); },
       };\n`,
    );
    const client = await connect(dir);
    const result = await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 1500,
      focus: ['handleRequest'],
    });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('RerankStageError');
    expect(result.texts[0]).toContain('did not answer within 30000ms');
  });

  it('refuses to start on a rerank block it cannot parse, like every other key', async () => {
    expect(() => createSmeltMcpServer({ cwd: withRerank({ kind: 'psychic' }) })).toThrow(
      CliUsageError,
    );
  });
});

describe('smelt_retrieve_batch', () => {
  async function smeltedHashes(client: Client): Promise<{ input: string; hashes: string[] }> {
    const input = fixtureText(900);
    const smelted = (
      await call(client, SMELT_FILE_TOOL_NAME, {
        text: input,
        budgetBytes: 600,
        focus: ['handleRequest'],
      })
    ).texts[0]!;
    const hashes = [...smelted.matchAll(/retrieve\("([0-9a-f]+)"\)/g)].map((m) => m[1]!);
    expect(hashes.length, 'the fixture must leave at least two markers').toBeGreaterThan(1);
    return { input, hashes };
  }

  it('returns one labelled block per hash, in the order asked, in one response', async () => {
    const client = await connect(tempDir());
    const { input, hashes } = await smeltedHashes(client);

    const result = await call(client, RETRIEVE_BATCH_TOOL_NAME, { hashes });
    expect(result.isError).toBe(false);
    expect(result.texts).toHaveLength(hashes.length);
    for (const [index, block] of result.texts.entries()) {
      // The block names its hash on its first line — a batch has to say which bytes
      // belong to which marker — and everything after that line is the exact bytes.
      const newline = block.indexOf('\n');
      const header = block.slice(0, newline);
      const bytes = block.slice(newline + 1);
      expect(header).toContain(hashes[index]!);
      expect(bytes.length).toBeGreaterThan(0);
      expect(input).toContain(bytes);
    }

    const stats = JSON.parse((await call(client, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as {
      retrieveCalls: number;
      uniqueRetrieved: number;
    };
    expect(stats.retrieveCalls).toBe(hashes.length);
    expect(stats.uniqueRetrieved).toBe(hashes.length);
  });

  it('keeps a refusal inside its own block and does not fail the batch', async () => {
    const client = await connect(tempDir());
    const { hashes } = await smeltedHashes(client);
    const asked = [hashes[0]!, 'deadbeefdeadbeef', hashes[1]!];

    const result = await call(client, RETRIEVE_BATCH_TOOL_NAME, { hashes: asked });
    expect(result.isError).toBe(false);
    expect(result.texts).toHaveLength(3);
    expect(result.texts[1]).toContain('deadbeefdeadbeef');
    expect(result.texts[1]).toContain('UnknownHashError');
    expect(result.texts[1]).toContain('no stored content for hash "deadbeefdeadbeef"');
  });

  it('is a tool error only when every hash was refused, and then says how to persist', async () => {
    const client = await connect(tempDir()); // no config → memory store
    const result = await call(client, RETRIEVE_BATCH_TOOL_NAME, {
      hashes: ['deadbeefdeadbeef', 'cafebabecafebabe'],
    });
    expect(result.isError).toBe(true);
    expect(result.texts).toHaveLength(2);
    expect(result.texts[0]).toContain('UnknownHashError');
    expect(result.texts[1]).toContain('cafebabecafebabe');
    expect(result.texts.join('\n')).toContain('memory store dies with the process that made it');
  });

  it('refuses an empty array and a non-string entry as arguments, not as retrievals', async () => {
    const client = await connect(tempDir());
    const empty = await call(client, RETRIEVE_BATCH_TOOL_NAME, { hashes: [] });
    expect(empty.isError).toBe(true);
    expect(empty.texts[0]).toContain('"hashes" must be a non-empty array of strings');

    const mixed = await call(client, RETRIEVE_BATCH_TOOL_NAME, { hashes: ['abcd', 7] });
    expect(mixed.isError).toBe(true);
    expect(mixed.texts[0]).toContain('"hashes" must be a non-empty array of strings');

    const stats = JSON.parse((await call(client, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as {
      retrieveCalls: number;
    };
    expect(stats.retrieveCalls, 'an argument refusal is not a retrieval').toBe(0);
  });
});

describe('smelt_retrieve', () => {
  it('closes the marker’s retrieve("hash") loop over the wire', async () => {
    // The frozen wire contract, end to end: a hash the model can only have read out
    // of a marker goes in, the exact original bytes come back in one text block.
    const client = await connect(tempDir());
    const input = fixtureText();
    const smelted = (
      await call(client, SMELT_FILE_TOOL_NAME, {
        text: input,
        budgetBytes: 600,
        focus: ['handleRequest'],
      })
    ).texts[0]!;
    const hash = /retrieve\("([0-9a-f]+)"\)/.exec(smelted)?.[1];
    expect(hash, 'no marker hash in the smelted output').toBeDefined();

    const retrieved = await call(client, RETRIEVE_TOOL_NAME, { hash });
    expect(retrieved.isError).toBe(false);
    expect(retrieved.texts).toHaveLength(1);
    expect(retrieved.texts[0]!.length).toBeGreaterThan(0);
    expect(input).toContain(retrieved.texts[0]!);
  });

  it('renders an unknown hash as a tool error, never empty text', async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({
        smeltConfig: 1,
        store: { kind: 'directory', path: '.smelt-store' },
      })}\n`,
    );
    const client = await connect(cwd);
    const result = await call(client, RETRIEVE_TOOL_NAME, { hash: 'deadbeefdeadbeef' });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('UnknownHashError');
    expect(result.texts[0]).toContain('no stored content for hash "deadbeefdeadbeef"');
    // On a directory store the memory-store hint would be a non-sequitur.
    expect(result.texts[0]).not.toContain('memory store dies');
  });

  it('renders an evicted hash as the same shape as an unknown one, with its own text', async () => {
    // The `smelt_retrieve` contract must not move: a refusal is a tool-level error
    // with a text block, whichever refusal it is. What changes is the sentence — an
    // evicted hash is one a user pruned, and telling the model it was "never elided"
    // would be a false statement it cannot check.
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({
        smeltConfig: 1,
        store: { kind: 'directory', path: '.smelt-store' },
      })}\n`,
    );
    const storePath = join(cwd, '.smelt-store');
    const store = new DirectoryElisionStore(storePath);
    const hash = store.put('bytes an operator pruned between sessions');
    const ancient = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    utimesSync(join(storePath, 'blobs', hash), ancient, ancient);
    store.prune({ olderThan: new Date(), keepRetrieved: false, dryRun: false });

    const client = await connect(cwd);
    const result = await call(client, RETRIEVE_TOOL_NAME, { hash });
    expect(result.isError).toBe(true);
    expect(result.texts).toHaveLength(1);
    expect(result.texts[0]).toContain('EvictedHashError');
    expect(result.texts[0]).toContain('smelt store prune');
    expect(result.texts[0]).not.toContain('UnknownHashError');

    // And the batch tool renders it in the same slot, for the same reason.
    const batch = await call(client, RETRIEVE_BATCH_TOOL_NAME, { hashes: [hash] });
    expect(batch.isError).toBe(true);
    expect(batch.texts[0]).toContain('EvictedHashError');
  });

  it('says how to get persistence when a memory store cannot hold earlier sessions', async () => {
    // The deliberate divergence from the CLI, and the reason it is deliberate: this
    // server accepts a memory store and serves the session from it, then explains
    // itself at the moment an unknown hash makes the difference bite. `smelt
    // retrieve` refuses the same store up front, because a fresh process has nothing.
    const client = await connect(tempDir()); // no config → memory store
    const result = await call(client, RETRIEVE_TOOL_NAME, { hash: 'deadbeefdeadbeef' });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('memory store dies with the process that made it');
    expect(result.texts[0]).toContain('{"store": {"kind": "directory", "path": …}}');
    expect(result.texts[0]).toContain('smelt.config.json');
    expect(result.texts[0]).toContain('`smelt init` writes one');
  });

  it('retrieves across server instances through the shared directory store', async () => {
    const cwd = tempDir();
    writeFileSync(
      join(cwd, 'smelt.config.json'),
      `${JSON.stringify({
        smeltConfig: 1,
        store: { kind: 'directory', path: '.smelt-store' },
      })}\n`,
    );
    const input = fixtureText();

    const first = await connect(cwd);
    const smelted = (
      await call(first, SMELT_FILE_TOOL_NAME, {
        text: input,
        budgetBytes: 600,
        focus: ['handleRequest'],
      })
    ).texts[0]!;
    const hash = /retrieve\("([0-9a-f]+)"\)/.exec(smelted)![1]!;

    // A second server over the same cwd — a later session. Same config discovery,
    // same directory, same bytes: this is the CLI-and-server-share-one-store claim.
    const second = await connect(cwd);
    const retrieved = await call(second, RETRIEVE_TOOL_NAME, { hash });
    expect(retrieved.isError).toBe(false);
    expect(input).toContain(retrieved.texts[0]!);

    const stats = JSON.parse((await call(second, SMELT_STATS_TOOL_NAME, {})).texts[0]!) as Record<
      string,
      number
    >;
    expect(stats['retrieveCalls']).toBe(1);
    expect(stats['elisionsStored']).toBeGreaterThan(0);
  });
});

describe('repo_map', () => {
  it('returns the map as a text block, resolved against the server cwd', async () => {
    const cwd = tempDir();
    const src = join(cwd, 'src');
    mkdirSync(src);
    writeFileSync(
      join(src, 'greet.ts'),
      'export function greet(name: string): string {\n  return `hi ${name}`;\n}\n',
    );
    const client = await connect(cwd);
    const result = await call(client, REPO_MAP_TOOL_NAME, { dir: 'src', budgetBytes: 2_000 });
    expect(result.isError).toBe(false);
    expect(result.texts[0]).toContain('greet');
  });

  it('renders the tree refusals as tool errors in this surface’s vocabulary', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'a-file.txt'), 'not a directory\n');
    const client = await connect(cwd);
    const missing = await call(client, REPO_MAP_TOOL_NAME, { dir: 'nowhere', budgetBytes: 1_000 });
    expect(missing.isError).toBe(true);
    expect(missing.texts[0]).toContain('cannot read directory "nowhere"');
    const file = await call(client, REPO_MAP_TOOL_NAME, { dir: 'a-file.txt', budgetBytes: 1_000 });
    expect(file.isError).toBe(true);
    // Composed from the core's law, in this surface's naming: the tool names its own
    // siblings, and the sentence around them is not this package's to write.
    const law = readTree(join(cwd, 'a-file.txt'), 'a-file.txt', {
      tree: REPO_MAP_TOOL_NAME,
      file: SMELT_FILE_TOOL_NAME,
    });
    expect(file.texts[0]).toBe(
      `${REPO_MAP_TOOL_NAME}: ${law.ok ? '(the fixture was a directory)' : law.refusal}`,
    );
  });
});

describe('smelt_stats', () => {
  it('serves the RetrieveStats verbatim, as JSON', async () => {
    const client = await connect(tempDir());
    await call(client, SMELT_FILE_TOOL_NAME, {
      text: fixtureText(),
      budgetBytes: 600,
      focus: ['handleRequest'],
    });
    const result = await call(client, SMELT_STATS_TOOL_NAME, {});
    expect(result.isError).toBe(false);
    const stats = JSON.parse(result.texts[0]!) as Record<string, unknown>;
    expect(Object.keys(stats).toSorted()).toEqual(
      [
        'elisionsStored',
        'bytesStored',
        'retrieveCalls',
        'uniqueRetrieved',
        'misses',
        'expansionRate',
        'allElisionsRetrieved',
      ].toSorted(),
    );
    expect(stats['elisionsStored']).toBeGreaterThan(0);
  });

  it('refuses arguments — the tool takes none', async () => {
    const client = await connect(tempDir());
    const result = await call(client, SMELT_STATS_TOOL_NAME, { verbose: true });
    expect(result.isError).toBe(true);
    expect(result.texts[0]).toContain('unknown argument');
  });
});

describe('startup', () => {
  it('refuses to start on a malformed smelt.config.json, exactly as the CLI does', () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'smelt.config.json'), '{"smeltConfig": 1, "defaultBudgetByte": 5}\n');
    expect(() => createSmeltMcpServer({ cwd })).toThrow(CliUsageError);
    expect(() => createSmeltMcpServer({ cwd })).toThrow(/unknown key "defaultBudgetByte"/);
  });
});

/**
 * Strict-mode registrability, over the served `tools/list` — not the source. This
 * lives here rather than in `test/guards/packaging.test.ts` on purpose: a guard's
 * `kind: 'src'` mutation points `@guard/*` at a bare copy of this package's `src`
 * with no `node_modules` beside it, and `createSmeltMcpServer` reaches into
 * `@smeltjs/core` — a real, executed import the scratch copy cannot resolve. Every
 * other check in the packaging guard is deliberately string-level for the same
 * reason (`readSource('server.ts')`); this one needs the real protocol round trip
 * `tools.test.ts` already runs everything else through, so it stays with its
 * siblings instead of crashing the guard it would otherwise live in. The literal
 * source facts that keep these two checks true — `additionalProperties: false` on
 * every entry `buildToolList` returns, and `smelt_stats`'s `required: []` beside it —
 * are pinned separately, and mutation-tested, in `test/guards/packaging.test.ts`.
 */
describe('every tool this server serves is registrable, strict-mode-wise, up to its own documented limits', () => {
  it('closes every tool schema to unknown keys, no exceptions', async () => {
    const client = await connect(tempDir());
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThan(2); // non-vacuity: the list really loaded
    const offenders = tools
      .filter(
        (tool) =>
          (tool.inputSchema as { additionalProperties?: unknown }).additionalProperties !== false,
      )
      .map((tool) => tool.name);
    expect(
      offenders.join(', '),
      'every tool schema this server serves must close additionalProperties, strict ' +
        'clients aside — an open object schema lets a model send an argument that was ' +
        'silently ignored, exactly what refuseUnknownKeys exists to refuse at the value ' +
        'layer',
    ).toBe('');
  });

  it('the three argument-free-or-required tools are fully strict-mode valid', async () => {
    const client = await connect(tempDir());
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    // smelt_file and repo_map are the documented exception: both have genuinely
    // optional arguments, and strict mode has no notion of optional. See the
    // module doc on `server.ts`'s `buildToolList`.
    const fullyStrict = [RETRIEVE_TOOL_NAME, RETRIEVE_BATCH_TOOL_NAME, SMELT_STATS_TOOL_NAME];
    const offenders: string[] = [];
    for (const name of fullyStrict) {
      const tool = byName.get(name);
      expect(tool, `${name} is not in the served tool list`).toBeDefined();
      offenders.push(...strictModeViolations(tool!.inputSchema as unknown as ToolSchema, name));
    }
    expect(offenders.join('\n')).toBe('');
  });
});
