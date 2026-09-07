import { defaultMarker } from './apply.ts';
import { SmeltError } from './errors.ts';
import type { ElisionStore, RetrieveBatchTool, RetrievedBlock, RetrieveTool } from './types.ts';

/** The tool name smelt's markers reference. Consumers hard-code it; do not rename it. */
export const RETRIEVE_TOOL_NAME = 'smelt_retrieve';

/** The batched sibling's name. Also stable; also never a rename of the one above. */
export const RETRIEVE_BATCH_TOOL_NAME = 'smelt_retrieve_batch';

/**
 * The example marker inside the tool description is *rendered by the real marker
 * builder*, never hand-written — the description is the one string a model reads to
 * recognize markers, and an example whose shape drifted from the wire format
 * (`<<smelt: …>>` when real markers say `<<smelt/v1: …>>`) would teach the model to
 * miss every marker it actually receives. `test/guards/marker-format.test.ts` pins
 * this to `MARKER_FORMAT_VERSION`.
 */
const EXAMPLE_MARKER = defaultMarker({
  hash: 'a1b2c3d4e5f60718',
  bytes: 412,
  rule: 'sibling-collapse',
  explanation: 'collapsed 3 sibling functions',
});

const DESCRIPTION =
  'Return the exact original text that was elided from a previous tool result. ' +
  `Context you were given may contain markers like \`${EXAMPLE_MARKER}\`. ` +
  'Call this with that hash to get those bytes ' +
  'back verbatim. Nothing was deleted — it is all still here. Ask whenever the elided ' +
  'material might matter; guessing at what a marker hid is never correct.';

/**
 * Wrap a store as the tool a model calls.
 *
 * Why the description says "ask whenever it might matter": under-retrieval is the
 * failure mode that looks like success. A model that never calls this produces a
 * confident answer built on material it never saw, and the retrieve rate reads 0% —
 * which is indistinguishable from perfect pruning. Encouraging retrieval keeps the
 * signal in {@link ElisionStore.stats} honest.
 *
 * **The schema is strict-mode shaped on purpose.** `additionalProperties: false`, and
 * `required` naming every property — the two rules OpenAI's structured-outputs strict
 * mode enforces before it will register a function at all. Without them a whole class
 * of consumer simply cannot expose this tool. It says nothing new: `hash` was always
 * the only key `invoke` reads, and an extra key was always ignored. A schema that is
 * strictly more precise about the same shape is not a change to the wire surface the
 * tool name and behaviour guarantee covers.
 */
export function createRetrieveTool(store: ElisionStore): RetrieveTool {
  return {
    name: RETRIEVE_TOOL_NAME,
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        hash: { type: 'string', description: 'The hash from a marker\'s retrieve("hash").' },
      },
      required: ['hash'],
      additionalProperties: false,
    },
    invoke: ({ hash }) => store.retrieve(hash),
  };
}

const BATCH_DESCRIPTION =
  'Return the exact original text for several markers at once — the same bytes ' +
  `${RETRIEVE_TOOL_NAME} returns for one hash, in one call. Context you were given may ` +
  `contain markers like \`${EXAMPLE_MARKER}\`. Pass every hash you need in one array: ` +
  'each hash comes back as its own block, in the order asked, and a hash the store does ' +
  'not hold comes back as a refusal in its block without failing the others. Prefer this ' +
  `over repeated ${RETRIEVE_TOOL_NAME} calls whenever more than one marker matters — every ` +
  'call is a new request, and asking for eighteen blobs one at a time pays for the whole ' +
  'conversation eighteen times.';

/**
 * Retrieve each hash through the counted path, keeping the store's own refusal per
 * hash. The one loop behind both {@link createRetrieveBatchTool} and the
 * `retrieveMany` op: a batch is N single retrievals that share one round trip, and
 * *nothing else* — `store.retrieve` journals every hit and every miss exactly as a
 * single call would, so the expansion rate keeps its exact meaning across both
 * shapes. Only a {@link SmeltError} is kept inside a block; anything else is not the
 * store saying no, and propagates.
 */
export function retrieveEach(
  store: ElisionStore,
  hashes: readonly string[],
): readonly RetrievedBlock[] {
  return hashes.map((hash) => {
    try {
      return { hash, text: store.retrieve(hash) };
    } catch (error) {
      if (error instanceof SmeltError) return { hash, error };
      throw error;
    }
  });
}

/**
 * Wrap a store as the batched tool a model calls beside {@link createRetrieveTool}.
 *
 * Same store, same counters, same strict-mode shape. The two tools are siblings, not
 * a replacement: `smelt_retrieve` is the name every marker's `retrieve("hash")` points
 * at and is frozen; this one exists for the measured case where several markers
 * matter at once and the round trips, not the bytes, are the cost.
 */
export function createRetrieveBatchTool(store: ElisionStore): RetrieveBatchTool {
  return {
    name: RETRIEVE_BATCH_TOOL_NAME,
    description: BATCH_DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        hashes: {
          type: 'array',
          items: { type: 'string' },
          description: 'The hashes from the markers\' retrieve("hash"), every one you need.',
        },
      },
      required: ['hashes'],
      additionalProperties: false,
    },
    invoke: ({ hashes }) => retrieveEach(store, hashes),
  };
}
