/**
 * TIER 3 — expansion rate, measured by real model calls.
 *
 * This module is the paid network path. `run.mjs` loads it dynamically and only when
 * the caller passed `--tier3` *and* `ANTHROPIC_API_KEY` is present — it is never run
 * incidentally, because every call here costs money. Per `docs/ARCHITECTURE.md`
 * § Decision 8 it is run once and the retrieval log committed
 * (`bench/tier3-log/<case>.json`),
 * so the rate is verifiable from a committed file rather than from trust.
 *
 * The measurement: the model is handed the smelted text, the case's task, and the
 * `smelt_retrieve` tool, and asked to do the task. Every `smelt_retrieve` invocation
 * is served from the real store and counted by the store's own counters — the same
 * counters the library ships, not a parallel tally. A case where the model retrieved
 * every elision back is a LOSS, reported as such with its input: the elision saved
 * nothing and cost a round trip.
 *
 * The log is the *entire* transcript, because tier 3 is run once and the committed
 * file is the only evidence: the initial user prompt (task + the smelted text the
 * model actually saw), every assistant response, and every tool_result payload the
 * harness sent back. A log holding only the assistant halves would make the rate
 * unverifiable — a reader could not see what the model was shown, and the smelted
 * text is not reconstructible later once the planner's code moves.
 *
 * A run can also hit the round cap while the model is still calling tools. That is
 * a cut-off conversation, not a completed measurement, and the log says so with a
 * `truncated` flag — `run.mjs` marks the row and keeps the case out of the
 * aggregate, because a truncated case's retrieval count is a floor, and reporting
 * it as final would flatter the expansion rate (Law 4).
 *
 * Like tier 2, this is the harness's own network call, outside the library. Nothing
 * under `src/` can reach this file.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_ROUNDS = 16;

import { postJson } from './net.mjs';

/**
 * Runs one case against a real model and returns its retrieval log.
 *
 * `smelter` is a live Smelter whose store already holds the case's elisions;
 * `smeltedText` is what the model sees — the smelted text followed by its report,
 * as `shownToModel` joins them (log format v3; v2 logs carried the text alone). The returned log carries the
 * full transcript (initial prompt, every assistant response, every tool_result),
 * the per-round stop reasons, a `truncated` flag for a run cut off at the round
 * cap mid-task, and the store's final counters.
 *
 * `transport` is injectable for tests; it defaults to the real API call.
 */
export async function measureExpansion({
  apiKey,
  model,
  benchCase,
  smelter,
  smeltedText,
  transport,
}) {
  const send = transport ?? ((payload) => request({ apiKey, ...payload }));
  const tool = smelter.tool;
  const tools = [
    {
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    },
  ];
  const messages = [
    {
      role: 'user',
      content:
        `${benchCase.task}.\n\n` +
        `The content below was shrunk by smelt; elided regions are markers you can ` +
        `expand with the ${tool.name} tool if — and only if — the task needs them.\n\n` +
        `${smeltedText}`,
    },
  ];
  const stopReasons = [];

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await send({ model, tools, messages });
    stopReasons.push(response.stop_reason);
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') break;

    const results = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      results.push(invokeTool(tool, block));
    }
    messages.push({ role: 'user', content: results });
  }

  // The cap was hit while the model was still asking for tools: the conversation
  // was cut off mid-task, and everything measured below is a floor, not a total.
  const truncated = stopReasons.length === MAX_ROUNDS && stopReasons.at(-1) === 'tool_use';

  const stats = smelter.stats();
  return {
    format: 'smelt-bench-tier3-log/v3',
    case: benchCase.id,
    model,
    maxRounds: MAX_ROUNDS,
    stopReasons,
    truncated,
    transcript: messages,
    stats: {
      elisionsStored: stats.elisionsStored,
      retrieveCalls: stats.retrieveCalls,
      uniqueRetrieved: stats.uniqueRetrieved,
      misses: stats.misses,
      expansionRate: stats.expansionRate,
      allElisionsRetrieved: stats.allElisionsRetrieved,
    },
  };
}

/** One tool invocation, surfaced to the model as a tool error on an unknown hash. */
function invokeTool(tool, block) {
  try {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: tool.invoke({ hash: String(block.input?.hash ?? '') }),
    };
  } catch (error) {
    return {
      type: 'tool_result',
      tool_use_id: block.id,
      content: error instanceof Error ? error.message : String(error),
      is_error: true,
    };
  }
}

async function request({ apiKey, model, tools, messages }) {
  return postJson({
    url: API_URL,
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': API_VERSION,
    },
    body: { model, max_tokens: 4096, tools, messages },
  });
}
