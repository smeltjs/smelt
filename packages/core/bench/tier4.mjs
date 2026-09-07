/**
 * TIER 4 — answer-quality A/B, measured by real model calls.
 *
 * This module is the paid network path. `run.mjs` loads it dynamically and only when
 * the caller passed `--tier4` *and* `ANTHROPIC_API_KEY` is present — it is never run
 * incidentally, because every call here costs money (three or more per case: the raw
 * arm, the smelted arm's rounds, and the judge). Like tier 3 it is run once and its
 * log committed (`bench/ab-log/<case>.json`), so the reading is checkable from a file
 * rather than from trust.
 *
 * The measurement, per case: the same answerable question is asked twice — once
 * against the raw blob (no tools), once against the smelted one with `smelt_retrieve`
 * wired exactly as tier 3 wires it. Both arms' token usage is recorded from the API's
 * own usage fields, summed over the arm's requests; nothing is converted between
 * units. A judge — the same named model, holding the raw blob as its reference —
 * reports which answer is better through a tool call, so the verdict is parseable or
 * absent, never scraped. No sampling parameters are sent on any call: current models
 * deprecate `temperature` outright (a live run of this harness was refused with
 * "`temperature` is deprecated for this model"), and the reading's discipline never
 * rested on it anyway — it rests on the tool-forced verdict, the blind ordering, and
 * the one committed log. The judge sees the answers anonymised as
 * `answer_1`/`answer_2`, and which arm is first reverses on odd case indices, so
 * position bias has no fixed direction across a run.
 *
 * Two honesty boundaries, both visible in the row:
 *
 *  - The verdict is a model's opinion — an instrument reading, not a measurement.
 *    The row names the judge by naming the model; the log carries the judge's
 *    reasons; and a judge that did not produce a parseable verdict is reported as
 *    UNJUDGED, never guessed.
 *  - A smelted arm that hits the round cap while still calling tools was cut off
 *    mid-task; its answer is a floor, so the row claims no verdict and says
 *    TRUNCATED — the same ruling as tier 3.
 *
 * Like tier 2 and tier 3, this is the harness's own network call, outside the
 * library. Nothing under `src/` can reach this file.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_ROUNDS = 16;

import { AB_VERDICT_TOOL, abArmPrompt, abJudgeMessages, parseAbVerdict } from './lib.mjs';
import { postJson } from './net.mjs';

/**
 * Runs one A/B case and returns its log plus the values a row needs.
 *
 * `smelter` is a live Smelter whose store already holds the case's elisions;
 * `rawText` is the original blob and `smeltedText` what the smelted arm sees. The
 * `index` is the case's position in the manifest: it alone decides answer order, so
 * a run is deterministic in its blinding without any randomness.
 *
 * `transport` is injectable for tests; it defaults to the real API call.
 */
export async function measureAb({
  apiKey,
  model,
  benchCase,
  rawText,
  smeltedText,
  smelter,
  index,
  transport,
}) {
  const send = transport ?? ((payload) => request({ apiKey, ...payload }));
  const tool = smelter.tool;

  // -- the raw arm: one request, no tools --------------------------------------
  const rawPrompt = abArmPrompt({ question: benchCase.abQuestion, text: rawText });
  const rawResponse = await send({ model, messages: [{ role: 'user', content: rawPrompt }] });
  const rawUsage = sumUsage([rawResponse]);
  const rawAnswer = textOf(rawResponse);
  const rawTranscript = [
    { role: 'user', content: rawPrompt },
    { role: 'assistant', content: rawResponse.content },
  ];

  // -- the smelted arm: the retrieve tool, tier-3's loop ------------------------
  const smeltedPrompt = abArmPrompt({
    question: benchCase.abQuestion,
    text: smeltedText,
    toolName: tool.name,
  });
  const tools = [
    { name: tool.name, description: tool.description, input_schema: tool.inputSchema },
  ];
  const messages = [{ role: 'user', content: smeltedPrompt }];
  const responses = [];
  const stopReasons = [];
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const response = await send({ model, tools, messages });
    responses.push(response);
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
  const smeltedUsage = sumUsage(responses);
  const smeltedAnswer = textOfLast(responses);
  const stats = smelter.stats();
  const truncated = stopReasons.length === MAX_ROUNDS && stopReasons.at(-1) === 'tool_use';

  // -- the judge: reference in hand, answers blind, verdict via tool -------------
  const smeltedFirst = index % 2 === 1;
  const first = smeltedFirst ? smeltedAnswer : rawAnswer;
  const second = smeltedFirst ? rawAnswer : smeltedAnswer;
  let verdict = 'unjudged';
  let judgeReasons = '';
  let judgeTranscript = [];
  if (!truncated) {
    const judgeMessages = abJudgeMessages({
      question: benchCase.abQuestion,
      reference: rawText,
      first,
      second,
    });
    const judgeResponse = await send({
      model,
      tools: [AB_VERDICT_TOOL],
      messages: judgeMessages,
    });
    judgeTranscript = [...judgeMessages, { role: 'assistant', content: judgeResponse.content }];
    const call = judgeResponse.content.find((block) => block.type === 'tool_use');
    try {
      const parsed = parseAbVerdict(call?.input);
      judgeReasons = parsed.reasons;
      verdict =
        parsed.better === 'tie'
          ? 'tie'
          : (parsed.better === 'answer_1') === smeltedFirst
            ? 'smelted'
            : 'raw';
    } catch {
      verdict = 'unjudged'; // a verdict that did not parse is no verdict
    }
  }

  return {
    log: {
      format: 'smelt-bench-tier4-log/v1',
      case: benchCase.id,
      model,
      maxRounds: MAX_ROUNDS,
      smeltedFirst,
      raw: { transcript: rawTranscript, usage: rawUsage },
      smelted: { transcript: messages, usage: smeltedUsage, stopReasons, truncated },
      judge: { transcript: judgeTranscript, reasons: judgeReasons },
      verdict,
      stats: {
        elisionsStored: stats.elisionsStored,
        retrieveCalls: stats.retrieveCalls,
        uniqueRetrieved: stats.uniqueRetrieved,
        misses: stats.misses,
        expansionRate: stats.expansionRate,
        allElisionsRetrieved: stats.allElisionsRetrieved,
      },
    },
    verdict,
    rawUsage,
    smeltedUsage,
    retrieves: stats.retrieveCalls,
    truncated,
  };
}

/** The concatenated text blocks of a response — the arm's answer. */
function textOf(response) {
  return response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/** The text of the last response — the smelted arm's answer is its final turn. */
function textOfLast(responses) {
  return responses.length === 0 ? '' : textOf(responses.at(-1));
}

/** Sums an arm's usage across its requests — what the arm cost, per the API itself. */
function sumUsage(responses) {
  const total = { input_tokens: 0, output_tokens: 0 };
  for (const response of responses) {
    total.input_tokens += response.usage?.input_tokens ?? 0;
    total.output_tokens += response.usage?.output_tokens ?? 0;
  }
  return total;
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
