import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { packageRoot } from './guards/_source.ts';

/**
 * The BUILT server, spawned as a real subprocess and driven over a real stdio pipe —
 * the claims no in-process suite can make:
 *
 *  - **stdout carries protocol JSON only.** The transport owns stdout; the startup
 *    line and every error goes to stderr. One stray `console.log` corrupts the
 *    JSON-RPC stream, and only a real pipe can prove there is none.
 *  - **the handshake works from a cold process** — initialize → initialized →
 *    tools/list → tools/call, byte-for-byte over fd 0/1, exactly as a harness
 *    launches `npx @smeltjs/mcp`.
 *
 * These tests need `dist/` — `pnpm verify` builds before testing. If this fails with
 * "server not built", run `pnpm build` first.
 */

const binPath = join(packageRoot(), 'dist', 'bin.js');

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

interface Driven {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Every non-empty stdout line, parsed. A line that does not parse fails the run. */
  readonly messages: readonly JsonRpcMessage[];
  byId(id: number): JsonRpcMessage;
}

/**
 * Spawn the built server, write the frames, wait until a response exists for every
 * request id, then end stdin and wait for the exit. Requests and responses correlate
 * by id, never by order.
 */
function drive(frames: readonly Record<string, unknown>[], cwd: string): Promise<Driven> {
  const wantIds = frames
    .map((frame) => frame['id'])
    .filter((id): id is number => typeof id === 'number');

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let ended = false;

    const timer = setTimeout(() => {
      child.kill();
      rejectPromise(
        new Error(`timed out waiting for responses.\nstdout:\n${stdout}\nstderr:\n${stderr}`),
      );
    }, 15_000);

    const maybeEnd = (): void => {
      if (ended) return;
      const seen = new Set(
        stdout
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => {
            try {
              return (JSON.parse(line) as JsonRpcMessage).id;
            } catch {
              return undefined;
            }
          }),
      );
      if (wantIds.every((id) => seen.has(id))) {
        ended = true;
        child.stdin.end(); // the session is over; the server exits on close
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      maybeEnd();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', rejectPromise);
    child.on('close', (code) => {
      clearTimeout(timer);
      const messages = stdout
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as JsonRpcMessage);
      resolvePromise({
        code,
        stdout,
        stderr,
        messages,
        byId(id: number) {
          const found = messages.find((message) => message.id === id);
          if (found === undefined) throw new Error(`no response for id ${String(id)}`);
          return found;
        },
      });
    });

    for (const frame of frames) child.stdin.write(`${JSON.stringify(frame)}\n`);
  });
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'smelt-protocol-test', version: '0.0.0' },
  },
};
const INITIALIZED = { jsonrpc: '2.0', method: 'notifications/initialized' };

let scratch: string;
beforeAll(() => {
  if (!existsSync(binPath)) {
    throw new Error(`server not built at ${binPath} — run \`pnpm build\` first`);
  }
  scratch = mkdtempSync(join(tmpdir(), 'smelt-mcp-protocol-'));
});
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('the built server over real stdio', () => {
  it('initializes, lists the five tools, and answers a tools/call', async () => {
    const run = await drive(
      [
        INITIALIZE,
        INITIALIZED,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'smelt_file',
            arguments: { text: `${'padding\n'.repeat(400)}needle\n`, budgetBytes: 200 },
          },
        },
      ],
      scratch,
    );
    expect(run.code).toBe(0);

    const init = run.byId(1).result!;
    const serverInfo = init['serverInfo'] as { name: string; version: string };
    expect(serverInfo.name).toBe('smelt-mcp');
    expect(serverInfo.version).toBe('0.7.0');
    // The instructions field carries the one unlearnable fact: markers'
    // retrieve("hash") maps to smelt_retrieve.
    expect(init['instructions']).toContain('retrieve("hash")');
    expect(init['instructions']).toContain('smelt_retrieve');
    expect(init['capabilities']).toHaveProperty('tools');

    const listed = run.byId(2).result!['tools'] as readonly { name: string }[];
    expect(listed.map((tool) => tool.name).toSorted()).toEqual([
      'repo_map',
      'smelt_file',
      'smelt_retrieve',
      'smelt_retrieve_batch',
      'smelt_stats',
    ]);

    const called = run.byId(3).result!;
    expect(called['isError']).not.toBe(true);
    const content = called['content'] as readonly { type: string; text: string }[];
    expect(content[0]!.text).toContain('<<smelt/v1:');
  });

  it('keeps stdout protocol-clean: every line is JSON-RPC, prose stays on stderr', async () => {
    const run = await drive(
      [INITIALIZE, INITIALIZED, { jsonrpc: '2.0', id: 2, method: 'tools/list' }],
      scratch,
    );
    expect(run.code).toBe(0);
    // Every non-empty stdout line parsed (drive() throws otherwise) AND declares
    // itself JSON-RPC — nothing else may share the channel.
    expect(run.messages.length).toBeGreaterThanOrEqual(2);
    for (const message of run.messages) expect(message.jsonrpc).toBe('2.0');
    // The startup receipt exists, and on the right stream.
    expect(run.stderr).toContain('smelt-mcp 0.7.0:');
    expect(run.stderr).toContain('in-memory store');
    expect(run.stdout).not.toContain('in-memory store');
  });

  it('reports an unknown hash as a tool-level error, not a protocol error', async () => {
    const run = await drive(
      [
        INITIALIZE,
        INITIALIZED,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'smelt_retrieve', arguments: { hash: 'deadbeefdeadbeef' } },
        },
      ],
      scratch,
    );
    const response = run.byId(2);
    expect(response.error, 'expected a tool result, got a protocol error').toBeUndefined();
    expect(response.result!['isError']).toBe(true);
    const content = response.result!['content'] as readonly { text: string }[];
    expect(content[0]!.text).toContain('UnknownHashError');
    expect(content[0]!.text).toContain('smelt.config.json');
  });

  it('answers an unknown tool with a protocol error', async () => {
    const run = await drive(
      [
        INITIALIZE,
        INITIALIZED,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'smelt_everything', arguments: {} },
        },
      ],
      scratch,
    );
    const response = run.byId(2);
    expect(response.result).toBeUndefined();
    expect(response.error?.message).toContain('unknown tool "smelt_everything"');
  });
});
