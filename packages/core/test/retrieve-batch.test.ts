import { describe, expect, it } from 'vitest';

import { UnknownHashError } from '../src/errors.ts';
import {
  createRetrieveBatchTool,
  createRetrieveTool,
  RETRIEVE_BATCH_TOOL_NAME,
  RETRIEVE_TOOL_NAME,
} from '../src/retrieve.ts';
import { MemoryElisionStore } from '../src/store.ts';

/**
 * The batch tool beside the frozen one. `smelt_retrieve` is byte-identical to what it
 * was; this is its additive sibling — an array of hashes in, one block per hash out,
 * every hit journalled exactly as a single call would journal it.
 */
describe(RETRIEVE_BATCH_TOOL_NAME, () => {
  it('is a new name beside the frozen one, never a change to it', () => {
    const store = new MemoryElisionStore();
    const single = createRetrieveTool(store);
    const batch = createRetrieveBatchTool(store);
    expect(single.name).toBe(RETRIEVE_TOOL_NAME);
    expect(batch.name).toBe(RETRIEVE_BATCH_TOOL_NAME);
    expect(batch.name).not.toBe(single.name);
    expect(RETRIEVE_BATCH_TOOL_NAME).toBe('smelt_retrieve_batch');
  });

  it('takes an array of hashes and nothing else, strict-mode shaped', () => {
    const batch = createRetrieveBatchTool(new MemoryElisionStore());
    expect(Object.keys(batch.inputSchema.properties)).toEqual(['hashes']);
    expect(batch.inputSchema.required).toEqual(['hashes']);
    expect(batch.inputSchema.additionalProperties).toBe(false);
    expect(batch.inputSchema.properties.hashes.type).toBe('array');
    expect(batch.inputSchema.properties.hashes.items.type).toBe('string');
  });

  it('returns the exact bytes per hash and journals each hit', () => {
    const store = new MemoryElisionStore();
    const a = store.put('alpha\n');
    const b = store.put('beta\n');
    const blocks = createRetrieveBatchTool(store).invoke({ hashes: [a, b] });
    expect(blocks).toEqual([
      { hash: a, text: 'alpha\n' },
      { hash: b, text: 'beta\n' },
    ]);
    expect(store.stats().retrieveCalls).toBe(2);
    expect(store.stats().uniqueRetrieved).toBe(2);
  });

  it('describes the batch in terms of the marker the model already knows', () => {
    const batch = createRetrieveBatchTool(new MemoryElisionStore());
    expect(batch.description).toContain('<<smelt/v1:');
    expect(batch.description).toContain(RETRIEVE_TOOL_NAME);
  });

  it('carries the store’s own error per hash, so one bad hash cannot hide the rest', () => {
    const store = new MemoryElisionStore();
    const a = store.put('alpha\n');
    const blocks = createRetrieveBatchTool(store).invoke({ hashes: ['deadbeefdeadbeef', a] });
    expect(blocks[1]).toEqual({ hash: a, text: 'alpha\n' });
    const missed = blocks[0]!;
    expect('error' in missed && missed.error instanceof UnknownHashError).toBe(true);
  });
});
