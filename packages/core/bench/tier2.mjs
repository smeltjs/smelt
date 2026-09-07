/**
 * TIER 2 — token counts via Anthropic's `/v1/messages/count_tokens`.
 *
 * This module is the network. It is imported dynamically by `run.mjs` and only when
 * `ANTHROPIC_API_KEY` is present, so a tier-1 run never even loads a file that can
 * reach the wire. It is part of the measurement harness, not of smelt: nothing under
 * `src/` imports it, it ships in no tarball, and Law 1's guard walks `src/` only —
 * the model calls here are the harness's own, made explicitly, exactly as the
 * harness's contract requires.
 *
 * `count_tokens` is free (rate-limited, not billed), which is what makes tier 2
 * affordable to anyone with a key. The count reported is of the text as a single
 * user message on the named model — never a byte count converted with a fudge
 * factor.
 */

const API_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const API_VERSION = '2023-06-01';

import { countTokensRequest } from './lib.mjs';
import { postJson } from './net.mjs';

/** Counts tokens for one string on one model. Throws on any non-2xx response. */
export async function countTokens({ apiKey, model, text }) {
  const parsed = await postJson({
    url: API_URL,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: countTokensRequest(model, text),
  });
  if (!Number.isInteger(parsed.input_tokens)) {
    throw new Error(
      `count_tokens: response has no integer input_tokens: ${JSON.stringify(parsed)}`,
    );
  }
  return parsed.input_tokens;
}
