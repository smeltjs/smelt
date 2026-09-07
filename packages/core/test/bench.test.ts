import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { retrieveStats } from '../src/stats.ts';
import { STRATEGIES } from '../src/plan/planners.ts';

/**
 * The measurement harness's own tests — the pure half.
 *
 * `bench/lib.mjs` is deliberately free of I/O, network and `dist/` imports, so its
 * logic is testable here without a build and without a key. The wired-up halves are
 * covered elsewhere: tier 1 end-to-end by an actual committed run in
 * `bench/RESULTS.md`, and the honesty properties by
 * `test/guards/bench-results.test.ts` plus its mutations.
 */

const testDir = dirname(fileURLToPath(import.meta.url));
const benchDir = resolve(testDir, '../bench');

interface BenchCase {
  readonly id: string;
  readonly file: string;
  readonly path: string;
  readonly strategy: string;
  readonly focus: readonly string[];
  readonly budgetBytes: number;
  readonly task: string;
  readonly provenance: string;
  readonly abQuestion?: string;
}

interface BenchLib {
  validateCases(manifest: unknown, fileExists: (file: string) => boolean): readonly string[];
  resultRow(row: Record<string, unknown>): readonly string[];
  renderTable(rows: readonly (readonly string[])[]): string;
  appendResults(existing: string, section: string): string;
  countTokensRequest(model: string, text: string): { model: string; messages: unknown[] };
  tier3Verdict(stats: { elisionsStored: number; uniqueRetrieved: number }): {
    expansionRate: number;
    loss: boolean;
  };
  tier3Aggregate(inputs: readonly { elisionsStored: number; uniqueRetrieved: number }[]): number;
  tier3RowNote(input: {
    verdict: { expansionRate: number; loss: boolean };
    retrieveCalls: number;
    truncated: boolean;
    maxRounds: number;
  }): string;
  CORPUS_REF_FORMAT: string;
  BENCH_STRATEGIES: readonly string[];
  parseBenchArgs(argv: readonly string[]): {
    wantTier3: boolean;
    wantTier4: boolean;
    unknown: readonly string[];
  };
  AB_VERDICT_TOOL: { name: string; input_schema: Record<string, unknown> };
  abArmPrompt(input: { question: string; text: string; toolName?: string }): string;
  abJudgeMessages(input: {
    question: string;
    reference: string;
    first: string;
    second: string;
  }): readonly { role: string; content: string }[];
  parseAbVerdict(input: unknown): { better: string; reasons: string };
  abRowNote(input: {
    verdict: string;
    rawUsage: { input_tokens: number; output_tokens: number };
    smeltedUsage: { input_tokens: number; output_tokens: number };
    retrieves: number;
    truncated: boolean;
  }): string;
  corpusRefMismatch(input: {
    refFile: string;
    from: string;
    pinned: string;
    actual: string;
  }): string;
}

let lib: BenchLib;
beforeAll(async () => {
  // A computed specifier, because tsc does not typecheck plain .mjs imports.
  lib = (await import(pathToFileURL(join(benchDir, 'lib.mjs')).href)) as BenchLib;
});

function manifest(): { format: string; cases: readonly BenchCase[] } {
  return JSON.parse(readFileSync(join(benchDir, 'cases.json'), 'utf8')) as {
    format: string;
    cases: readonly BenchCase[];
  };
}

describe('the corpus and its manifest', () => {
  it('cases.json is valid and every corpus file it names exists — as bytes or as a pinned reference', () => {
    // A by-reference entry has no committed bytes; its committed `<name>.json`
    // reference is what exists. The runner materializes the bytes before validating.
    const problems = lib.validateCases(
      manifest(),
      (file) => existsSync(join(benchDir, file)) || existsSync(join(benchDir, `${file}.json`)),
    );
    expect(problems).toEqual([]);
  });

  it('covers the shapes the harness requires: a large TS file, TSX, a grep, a stack trace, a build log', () => {
    const files = manifest().cases.map((benchCase) => benchCase.file);
    expect(files.some((file) => file.endsWith('.ts'))).toBe(true);
    expect(files.some((file) => file.endsWith('.tsx'))).toBe(true);
    expect(files.some((file) => file.includes('grep'))).toBe(true);
    expect(files.some((file) => file.includes('stack-trace'))).toBe(true);
    expect(files.some((file) => file.endsWith('.log'))).toBe(true);
  });

  it('the large TS file is a pinned reference to the real source — and the pin matches it', () => {
    // The old discipline was a committed byte-copy, guarded byte-for-byte. The new
    // one is a committed reference: the runner materializes the file from the
    // working tree and refuses a hash mismatch. This test keeps the pin honest at
    // `pnpm test` time — editing src/plan/structural.ts without re-pinning goes red
    // here, exactly as the byte-copy used to.
    const ref = JSON.parse(readFileSync(join(benchDir, 'corpus/structural.ts.json'), 'utf8')) as {
      format: string;
      from: string;
      sha256: string;
    };
    expect(ref.format).toBe(lib.CORPUS_REF_FORMAT);
    expect(ref.from).toBe('packages/core/src/plan/structural.ts');
    const source = readFileSync(resolve(testDir, '../src/plan/structural.ts'));
    expect(createHash('sha256').update(source).digest('hex')).toBe(ref.sha256);
  });

  it('a drifted source is refused with instructions, never silently measured', () => {
    const message = lib.corpusRefMismatch({
      refFile: 'corpus/structural.ts.json',
      from: 'packages/core/src/plan/structural.ts',
      pinned: 'aaaa',
      actual: 'bbbb',
    });
    expect(message).toContain('REFUSING');
    expect(message).toContain('update the pinned sha256');
    expect(message).toContain('corpus/structural.ts.json');
    expect(message).toContain('aaaa');
    expect(message).toContain('bbbb');
  });

  it('the build log is what its generator derives from the lockfile, and says it is synthetic', () => {
    const committed = readFileSync(join(benchDir, 'corpus/build.log'), 'utf8');
    expect(committed.split('\n')[0]).toContain('synthetic');
    // Committed log = generator output. A drifted lockfile would make this stale silently otherwise.
    return import(pathToFileURL(join(benchDir, 'gen-build-log.mjs')).href).then(
      (generator: {
        packagesFromLockfile(text: string): readonly { name: string; version: string }[];
        renderBuildLog(packages: readonly { name: string; version: string }[]): string;
      }) => {
        const lockfile = readFileSync(resolve(testDir, '../../../pnpm-lock.yaml'), 'utf8');
        expect(committed).toBe(generator.renderBuildLog(generator.packagesFromLockfile(lockfile)));
      },
    );
  });

  it('validateCases reports missing files, empty focus, bad budgets and unknown strategies', () => {
    const broken = {
      format: 'smelt-bench-cases/v1',
      cases: [
        {
          id: 'broken',
          file: 'corpus/nope.txt',
          path: '',
          strategy: 'vibes',
          focus: [],
          budgetBytes: -1,
          task: 't',
          provenance: '',
        },
      ],
    };
    const problems = lib.validateCases(broken, () => false);
    expect(problems.join('\n')).toContain('corpus file missing');
    expect(problems.join('\n')).toContain('no focus terms');
    expect(problems.join('\n')).toContain('budgetBytes');
    expect(problems.join('\n')).toContain('strategy');
    expect(problems.join('\n')).toContain('provenance');
  });

  it('the strategies a bench case may name are exactly the shipped ones', () => {
    // bench/lib.mjs cannot import PLANNERS — it is deliberately free of src/ and
    // dist/ imports so it stays testable without a build — so its strategy list is
    // hand-typed. This is the witness that keeps the hand-typed copy honest: a
    // strategy the registry ships and the bench manifest would reject is a manifest
    // face silently outside the registry's set.
    expect([...lib.BENCH_STRATEGIES].toSorted()).toEqual([...STRATEGIES].toSorted());
  });

  it('abQuestion is optional but never empty — an unanswerable question is no question', () => {
    const withQuestion = JSON.parse(JSON.stringify(manifest())) as {
      format: string;
      cases: Record<string, unknown>[];
    };
    for (const benchCase of withQuestion.cases) delete benchCase['abQuestion'];
    expect(lib.validateCases(withQuestion, () => true)).toEqual([]);
    withQuestion.cases[0]!['abQuestion'] = '';
    expect(lib.validateCases(withQuestion, () => true).join('\n')).toContain('abQuestion');
  });

  it('every case in the committed manifest carries an abQuestion — tier 4 measures all of them', () => {
    for (const benchCase of manifest().cases) {
      expect(benchCase.abQuestion, `${benchCase.id} has no abQuestion`).toBeTruthy();
    }
  });
});

describe('result rows (Law 4, structurally)', () => {
  const base = {
    caseId: 'x',
    tier: 1,
    date: '2026-09-01',
    corpusCommit: 'abcdef1234',
    unit: 'bytes',
    input: 10,
    output: 5,
    elisions: 1,
  };

  it('a token row without a model refuses to render', () => {
    expect(() => lib.resultRow({ ...base, tier: 2, unit: 'tokens' })).toThrow(/name its model/);
    expect(lib.resultRow({ ...base, tier: 2, unit: 'tokens', model: 'claude-opus-5' })[4]).toBe(
      'claude-opus-5',
    );
  });

  it('a row without a real date, commit or tier refuses to render', () => {
    expect(() => lib.resultRow({ ...base, date: 'today' })).toThrow(/date/);
    expect(() => lib.resultRow({ ...base, corpusCommit: 'not-a-hash' })).toThrow(/git hash/);
    expect(() => lib.resultRow({ ...base, tier: 5 })).toThrow(/tier/);
  });

  it('a tier-4 row renders like any judged row: named model, verdict in the note', () => {
    const row = lib.resultRow({
      ...base,
      tier: 4,
      unit: 'A/B judged',
      model: 'claude-opus-5',
      note: lib.abRowNote({
        verdict: 'tie',
        rawUsage: { input_tokens: 100, output_tokens: 10 },
        smeltedUsage: { input_tokens: 40, output_tokens: 12 },
        retrieves: 1,
        truncated: false,
      }),
    });
    expect(row[4]).toBe('claude-opus-5');
    expect(() => lib.resultRow({ ...base, tier: 4, unit: 'A/B judged' })).toThrow(/name its model/);
  });

  it('appendResults appends and never edits, and refuses extrapolation vocabulary', () => {
    const existing = '# results\n\n| old row |\n';
    const combined = lib.appendResults(existing, '| new row |');
    expect(combined.startsWith(existing.trimEnd())).toBe(true);
    expect(combined).toContain('| new row |');
    expect(() => lib.appendResults(existing, 'saves up to 94%')).toThrow(/not a measurement/);
    expect(() => lib.appendResults(existing, 'a 90% cache hit rate')).toThrow(/not a measurement/);
  });

  it('countTokensRequest sends the text itself — no byte-derived numbers anywhere', () => {
    const request = lib.countTokensRequest('claude-opus-5', 'some text');
    expect(request).toEqual({
      model: 'claude-opus-5',
      messages: [{ role: 'user', content: 'some text' }],
    });
    expect(() => lib.countTokensRequest('', 'text')).toThrow(/model/);
  });
});

describe('tier 3 verdicts', () => {
  it('retrieving everything back is a loss; retrieving nothing is not', () => {
    expect(lib.tier3Verdict({ elisionsStored: 3, uniqueRetrieved: 3 })).toEqual({
      expansionRate: 1,
      loss: true,
    });
    expect(lib.tier3Verdict({ elisionsStored: 3, uniqueRetrieved: 1 })).toEqual({
      expansionRate: 1 / 3,
      loss: false,
    });
    expect(lib.tier3Verdict({ elisionsStored: 0, uniqueRetrieved: 0 })).toEqual({
      expansionRate: 0,
      loss: false,
    });
  });

  it('a log claiming more retrieved than stored is corrupt, not a data point', () => {
    expect(() => lib.tier3Verdict({ elisionsStored: 1, uniqueRetrieved: 2 })).toThrow(/corrupt/);
  });

  it('the aggregate is total retrieved over total stored', () => {
    expect(
      lib.tier3Aggregate([
        { elisionsStored: 3, uniqueRetrieved: 3 },
        { elisionsStored: 5, uniqueRetrieved: 1 },
      ]),
    ).toBe(0.5);
  });

  it('agrees with src/stats.ts — lib.mjs is import-free, so this pin is what stops the two copies of the formula drifting', () => {
    // tier3Verdict/tier3Aggregate re-derive the honesty arithmetic that
    // `retrieveStats` owns inside src/. If they drifted, the RESULTS.md tier-3
    // note and the committed tier3-log JSON for the same run would disagree.
    for (const counts of [
      { elisionsStored: 0, uniqueRetrieved: 0 },
      { elisionsStored: 3, uniqueRetrieved: 1 },
      { elisionsStored: 3, uniqueRetrieved: 3 },
    ]) {
      const derived = retrieveStats({
        ...counts,
        bytesStored: 0,
        retrieveCalls: counts.uniqueRetrieved,
        misses: 0,
      });
      const verdict = lib.tier3Verdict(counts);
      expect(verdict.expansionRate).toBe(derived.expansionRate);
      expect(verdict.loss).toBe(derived.allElisionsRetrieved);
      expect(lib.tier3Aggregate([counts])).toBe(derived.expansionRate);
    }
  });

  it('a truncated row says TRUNCATED and never claims a LOSS — the run was cut off, not measured', () => {
    const verdict = { expansionRate: 0.5, loss: false };
    expect(lib.tier3RowNote({ verdict, retrieveCalls: 4, truncated: false, maxRounds: 16 })).toBe(
      'expansion rate 0.50, 4 calls',
    );
    expect(
      lib.tier3RowNote({
        verdict: { expansionRate: 1, loss: true },
        retrieveCalls: 3,
        truncated: false,
        maxRounds: 16,
      }),
    ).toContain('LOSS');
    const truncatedNote = lib.tier3RowNote({
      verdict: { expansionRate: 1, loss: true },
      retrieveCalls: 3,
      truncated: true,
      maxRounds: 16,
    });
    expect(truncatedNote).toContain('TRUNCATED');
    expect(truncatedNote).toContain('16-round cap');
    expect(truncatedNote).not.toContain('LOSS');
  });
});

/** A stand-in smelter for tier-3 tests: one retrievable hash, library-shaped counters. */
function fakeSmelter(): unknown {
  return {
    tool: {
      name: 'smelt_retrieve',
      description: 'retrieve an elision',
      inputSchema: { type: 'object' },
      invoke: ({ hash }: { hash: string }) => `RESTORED:${hash}`,
    },
    stats: () => ({
      elisionsStored: 2,
      retrieveCalls: 1,
      uniqueRetrieved: 1,
      misses: 0,
      expansionRate: 0.5,
      allElisionsRetrieved: false,
    }),
  };
}

describe('the tier-3 retrieval log is the whole conversation', () => {
  interface Tier3Log {
    format: string;
    maxRounds: number;
    stopReasons: readonly string[];
    truncated: boolean;
    transcript: readonly { role: string; content: unknown }[];
    stats: Record<string, unknown>;
  }
  interface Tier3Module {
    measureExpansion(input: {
      model: string;
      benchCase: { id: string; task: string };
      smelter: unknown;
      smeltedText: string;
      transport: (payload: unknown) => Promise<unknown>;
    }): Promise<Tier3Log>;
  }

  let measureExpansion: Tier3Module['measureExpansion'];
  beforeAll(async () => {
    const tier3 = (await import(
      pathToFileURL(join(benchDir, 'tier3.mjs')).href
    )) as unknown as Tier3Module;
    measureExpansion = tier3.measureExpansion;
  });

  const toolUseResponse = {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'call-1', name: 'smelt_retrieve', input: { hash: 'abc' } }],
  };
  const endTurnResponse = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'done' }],
  };

  it('captures the prompt shown to the model, every tool_result payload, and the final answer', async () => {
    const responses = [toolUseResponse, endTurnResponse];
    const log = await measureExpansion({
      model: 'test-model',
      benchCase: { id: 'case-x', task: 'find the thing' },
      smelter: fakeSmelter(),
      smeltedText: 'THE SMELTED TEXT',
      transport: () => Promise.resolve(responses.shift()),
    });

    expect(log.truncated).toBe(false);
    expect(log.stopReasons).toEqual(['tool_use', 'end_turn']);
    // The initial user message — task and smelted text — is in the log verbatim.
    const [prompt] = log.transcript;
    expect(prompt?.role).toBe('user');
    expect(String(prompt?.content)).toContain('find the thing');
    expect(String(prompt?.content)).toContain('THE SMELTED TEXT');
    // The tool_result payload the harness sent back is in the log too.
    expect(JSON.stringify(log.transcript)).toContain('RESTORED:abc');
    // And the final assistant message closes the transcript.
    expect(log.transcript.at(-1)).toEqual({ role: 'assistant', content: endTurnResponse.content });
  });

  it('flags a run cut off at the round cap mid-task as truncated', async () => {
    const log = await measureExpansion({
      model: 'test-model',
      benchCase: { id: 'case-y', task: 'keep digging' },
      smelter: fakeSmelter(),
      smeltedText: 'S',
      transport: () => Promise.resolve(toolUseResponse),
    });

    expect(log.truncated).toBe(true);
    expect(log.stopReasons).toHaveLength(log.maxRounds);
    expect(log.stopReasons.at(-1)).toBe('tool_use');
    // Even the cut-off conversation is fully logged, tool results included.
    expect(log.transcript).toHaveLength(1 + 2 * log.maxRounds);
  });
});

describe('tier 4 helpers (the A/B instrument, pure halves)', () => {
  it('the raw arm prompt names no tool; the smelted arm prompt names exactly the retrieve tool', () => {
    const raw = lib.abArmPrompt({ question: 'What is X?', text: 'THE TEXT' });
    expect(raw).toContain('What is X?');
    expect(raw).toContain('THE TEXT');
    expect(raw).not.toContain('smelt_retrieve');
    const smelted = lib.abArmPrompt({
      question: 'What is X?',
      text: 'THE TEXT',
      toolName: 'smelt_retrieve',
    });
    expect(smelted).toContain('smelt_retrieve');
    expect(smelted).toContain('What is X?');
  });

  it('the judge sees the question, the reference, and both answers under blind labels', () => {
    const messages = lib.abJudgeMessages({
      question: 'What is X?',
      reference: 'THE REFERENCE',
      first: 'FIRST ANSWER',
      second: 'SECOND ANSWER',
    });
    expect(messages).toHaveLength(1);
    const content = String(messages[0]?.content);
    expect(content).toContain('What is X?');
    expect(content).toContain('THE REFERENCE');
    expect(content).toContain('answer_1:\n\nFIRST ANSWER');
    expect(content).toContain('answer_2:\n\nSECOND ANSWER');
  });

  it('a verdict parses only in its declared shape — anything else is no verdict', () => {
    expect(lib.parseAbVerdict({ better: 'answer_1', reasons: 'r' })).toEqual({
      better: 'answer_1',
      reasons: 'r',
    });
    expect(lib.parseAbVerdict({ better: 'tie', reasons: 'r' }).better).toBe('tie');
    expect(() => lib.parseAbVerdict({ better: 'answer_3', reasons: 'r' })).toThrow(/better/);
    expect(() => lib.parseAbVerdict({ better: 'tie' })).toThrow(/reasons/);
    expect(() => lib.parseAbVerdict(undefined)).toThrow();
  });

  it('the row note states both arms, the retrieves, and the verdict — or its absence', () => {
    const input = {
      rawUsage: { input_tokens: 100, output_tokens: 10 },
      smeltedUsage: { input_tokens: 40, output_tokens: 12 },
      retrieves: 2,
    };
    expect(lib.abRowNote({ ...input, verdict: 'smelted', truncated: false })).toBe(
      'raw 100 in/10 out · smelted 40 in/12 out · 2 retrieve(s) · verdict: smelted better',
    );
    expect(lib.abRowNote({ ...input, verdict: 'tie', truncated: false })).toContain('verdict: tie');
    expect(lib.abRowNote({ ...input, verdict: 'unjudged', truncated: false })).toContain(
      'verdict: UNJUDGED',
    );
    const truncated = lib.abRowNote({ ...input, verdict: 'smelted', truncated: true });
    expect(truncated).toContain('TRUNCATED');
    expect(truncated).not.toContain('verdict: smelted better');
  });

  it('the verdict tool schema is strict — a judge reading must be validatable', () => {
    expect(lib.AB_VERDICT_TOOL.name).toBe('report_ab_verdict');
    expect(lib.AB_VERDICT_TOOL.input_schema['additionalProperties']).toBe(false);
  });
});

/** A judge response reporting `better` through the verdict tool, as the instrument demands. */
function judgeResponse(better: string) {
  return {
    stop_reason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: 'judge-1',
        name: 'report_ab_verdict',
        input: { better, reasons: 'the second is complete' },
      },
    ],
    usage: { input_tokens: 200, output_tokens: 20 },
  };
}

describe('the tier-4 A/B measurement (transport-injected)', () => {
  interface Tier4Log {
    format: string;
    maxRounds: number;
    smeltedFirst: boolean;
    raw: { transcript: readonly unknown[]; usage: { input_tokens: number; output_tokens: number } };
    smelted: {
      transcript: readonly unknown[];
      usage: { input_tokens: number; output_tokens: number };
      stopReasons: readonly string[];
      truncated: boolean;
    };
    judge: { transcript: readonly unknown[]; reasons: string };
    verdict: string;
  }
  interface Tier4Module {
    measureAb(input: {
      model: string;
      benchCase: { id: string; abQuestion: string };
      rawText: string;
      smeltedText: string;
      smelter: unknown;
      index: number;
      transport: (payload: unknown) => Promise<unknown>;
    }): Promise<{
      log: Tier4Log;
      verdict: string;
      rawUsage: { input_tokens: number; output_tokens: number };
      smeltedUsage: { input_tokens: number; output_tokens: number };
      retrieves: number;
      truncated: boolean;
    }>;
  }

  let measureAb: Tier4Module['measureAb'];
  beforeAll(async () => {
    const tier4 = (await import(
      pathToFileURL(join(benchDir, 'tier4.mjs')).href
    )) as unknown as Tier4Module;
    measureAb = tier4.measureAb;
  });

  const rawResponse = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'RAW ANSWER' }],
    usage: { input_tokens: 100, output_tokens: 10 },
  };
  const toolUseResponse = {
    stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 'call-1', name: 'smelt_retrieve', input: { hash: 'abc' } }],
    usage: { input_tokens: 50, output_tokens: 5 },
  };
  const smeltedEndResponse = {
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'SMELTED ANSWER' }],
    usage: { input_tokens: 60, output_tokens: 7 },
  };

  /** Scripts the full call sequence and records every payload it was sent. */
  function scripted(judge: unknown, payloads: unknown[]) {
    const queue = [rawResponse, toolUseResponse, smeltedEndResponse, judge];
    return {
      payloads,
      transport: (payload: unknown) => {
        payloads.push(payload);
        return Promise.resolve(queue.shift());
      },
    };
  }

  it('asks both arms, judges blind, unblinds by case index, and records the call shapes', async () => {
    const payloads: unknown[] = [];
    const { transport } = scripted(judgeResponse('answer_2'), payloads);
    const result = await measureAb({
      model: 'test-model',
      benchCase: { id: 'case-x', abQuestion: 'what is it?' },
      rawText: 'RAW TEXT',
      smeltedText: 'SMELTED TEXT',
      smelter: fakeSmelter(),
      index: 0,
      transport,
    });

    // Four calls: raw arm, two smelted-arm rounds, judge.
    expect(payloads).toHaveLength(4);
    const [rawCall, firstSmeltedCall, , judgeCall] = payloads as [
      { tools?: unknown[]; temperature?: number; messages: { role: string; content: string }[] },
      { tools: { name: string }[] },
      unknown,
      { tools: { name: string }[]; temperature?: number; messages: { content: string }[] },
    ];
    expect(rawCall.tools).toBeUndefined(); // the raw arm has no way back — that is the arm
    expect(String(rawCall.messages[0]?.content)).toContain('RAW TEXT');
    expect(firstSmeltedCall.tools[0]?.name).toBe('smelt_retrieve');
    expect(judgeCall.tools[0]?.name).toBe('report_ab_verdict');
    // No sampling parameters anywhere: current models deprecate `temperature`
    // outright (a live run was refused with "`temperature` is deprecated for this
    // model"), and the reading's discipline is the tool-forced verdict, not the knob.
    expect(judgeCall.temperature).toBeUndefined();
    expect(String(judgeCall.messages[0]?.content)).toContain('answer_1:\n\nRAW ANSWER');
    expect(String(judgeCall.messages[0]?.content)).toContain('answer_2:\n\nSMELTED ANSWER');

    // index 0 → raw first → 'answer_2' is the smelted arm.
    expect(result.verdict).toBe('smelted');
    expect(result.truncated).toBe(false);
    // Usage per arm, summed from the API's own fields.
    expect(result.rawUsage).toEqual({ input_tokens: 100, output_tokens: 10 });
    expect(result.smeltedUsage).toEqual({ input_tokens: 110, output_tokens: 12 });
    expect(result.retrieves).toBe(1);
    // The log carries both transcripts, the judge's reasons, and the retrieve payload.
    expect(result.log.raw.transcript).toHaveLength(2);
    expect(JSON.stringify(result.log.smelted.transcript)).toContain('RESTORED:abc');
    expect(result.log.judge.reasons).toBe('the second is complete');
    expect(result.log.format).toBe('smelt-bench-tier4-log/v1');
  });

  it('an odd case index flips the blind order — the same judge call names the other arm', async () => {
    const payloads: unknown[] = [];
    const { transport } = scripted(judgeResponse('answer_2'), payloads);
    const result = await measureAb({
      model: 'test-model',
      benchCase: { id: 'case-y', abQuestion: 'q' },
      rawText: 'RAW TEXT',
      smeltedText: 'SMELTED TEXT',
      smelter: fakeSmelter(),
      index: 1,
      transport,
    });
    const judgeCall = payloads[3] as { messages: { content: string }[] };
    expect(String(judgeCall.messages[0]?.content)).toContain('answer_1:\n\nSMELTED ANSWER');
    // index 1 → smelted first → 'answer_2' is the raw arm.
    expect(result.verdict).toBe('raw');
    expect(result.log.smeltedFirst).toBe(true);
  });

  it('a judge that did not produce a parseable verdict is UNJUDGED, never guessed', async () => {
    const payloads: unknown[] = [];
    const proseJudge = {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'I prefer the second one, informally.' }],
      usage: { input_tokens: 200, output_tokens: 20 },
    };
    const { transport } = scripted(proseJudge, payloads);
    const result = await measureAb({
      model: 'test-model',
      benchCase: { id: 'case-z', abQuestion: 'q' },
      rawText: 'RAW',
      smeltedText: 'SMELTED',
      smelter: fakeSmelter(),
      index: 0,
      transport,
    });
    expect(result.verdict).toBe('unjudged');
    expect(result.log.judge.reasons).toBe('');
  });

  it('a smelted arm cut off at the round cap claims no verdict — a floor is not a reading', async () => {
    let calls = 0;
    const result = await measureAb({
      model: 'test-model',
      benchCase: { id: 'case-t', abQuestion: 'q' },
      rawText: 'RAW',
      smeltedText: 'SMELTED',
      smelter: fakeSmelter(),
      index: 0,
      transport: (payload) => {
        calls += 1;
        void payload;
        return Promise.resolve(calls === 1 ? rawResponse : toolUseResponse);
      },
    });
    expect(result.truncated).toBe(true);
    expect(result.verdict).toBe('unjudged');
    // 1 raw call + the cap's worth of smelted rounds — and no judge call after them.
    expect(calls).toBe(1 + result.log.maxRounds);
    expect(result.log.judge.transcript).toHaveLength(0);
  });
});

describe('the runner argv (pure half)', () => {
  it('reads the tier flags and refuses every argument it does not know', () => {
    expect(lib.parseBenchArgs([])).toEqual({ wantTier3: false, wantTier4: false, unknown: [] });
    expect(lib.parseBenchArgs(['--tier3'])).toEqual({
      wantTier3: true,
      wantTier4: false,
      unknown: [],
    });
    expect(lib.parseBenchArgs(['--tier4']).wantTier4).toBe(true);
    expect(lib.parseBenchArgs(['--vibes']).unknown).toEqual(['--vibes']);
  });

  it("drops a bare '--' — the separator pnpm leaks through the workspace double hop", () => {
    // The regression: `pnpm bench -- --tier3 --tier4` from the repository root
    // reaches run.mjs as `-- --tier3 --tier4`, and the literal separator used to
    // be refused as an unknown argument. It is argv convention, not an argument.
    expect(lib.parseBenchArgs(['--', '--tier3', '--tier4'])).toEqual({
      wantTier3: true,
      wantTier4: true,
      unknown: [],
    });
    expect(lib.parseBenchArgs(['--']).unknown).toEqual([]);
  });
});

/** Zero backoff — the retry tests exercise policy, not patience. */
const instant = () => 0;

/** A failed HTTP response carrying `status` and a readable body. */
function statusResponse(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error('unused')),
    text: () => Promise.resolve(`body of ${String(status)}`),
  };
}

/** A successful response resolving to `value`. */
function okResponse(value: unknown) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(value),
    text: () => Promise.resolve(''),
  };
}

describe('the shared transport (net.mjs — retry policy, offline and instant)', () => {
  interface NetModule {
    postJson(input: {
      url: string;
      headers: Record<string, string>;
      body: unknown;
      fetchImpl?: (
        url: unknown,
        init: unknown,
      ) => Promise<{
        ok: boolean;
        status: number;
        json: () => Promise<unknown>;
        text: () => Promise<string>;
      }>;
      attempts?: number;
      backoffMs?: (attempt: number) => number;
      onRetry?: (attempt: number, error: Error) => void;
    }): Promise<unknown>;
  }

  let postJson: NetModule['postJson'];
  beforeAll(async () => {
    const net = (await import(
      pathToFileURL(join(benchDir, 'net.mjs')).href
    )) as unknown as NetModule;
    postJson = net.postJson;
  });

  it('rides out transient transport failures — the dropped-TLS-record class', async () => {
    const seen: string[] = [];
    const retries: number[] = [];
    const result = await postJson({
      url: 'https://example.invalid',
      headers: {},
      body: { a: 1 },
      fetchImpl: async () => {
        seen.push('call');
        if (seen.length < 3)
          throw new TypeError('fetch failed', { cause: new Error('bad record mac') });
        return okResponse({ input_tokens: 7 });
      },
      backoffMs: instant,
      onRetry: (attempt, error) => {
        retries.push(attempt);
        void error;
      },
    });
    expect(result).toEqual({ input_tokens: 7 });
    expect(seen).toHaveLength(3);
    expect(retries).toEqual([1, 2]);
  });

  it('retries the provider transient statuses (429, 5xx) and not the fatal ones', async () => {
    for (const [statuses, shouldThrow, calls] of [
      [[429, 500, 200], false, 3],
      [[500, 503, 529, 200], false, 4],
      [[400], true, 1],
      [[404], true, 1],
    ] as const) {
      let call = 0;
      const attempt = async () => {
        void shouldThrow;
        const status = statuses[Math.min(call, statuses.length - 1)]!;
        call += 1;
        return status === 200 ? okResponse({ ok: true }) : statusResponse(status);
      };
      const run = postJson({
        url: 'u',
        headers: {},
        body: {},
        fetchImpl: async () => attempt(),
        backoffMs: instant,
      });
      if (shouldThrow) {
        await expect(run).rejects.toThrow(/HTTP 4\d\d/);
      } else {
        await expect(run).resolves.toEqual({ ok: true });
      }
      expect(call, `statuses ${statuses.join(',')}`).toBe(calls);
    }
  });

  it('gives up after the attempt budget and raises the last transient failure', async () => {
    let call = 0;
    await expect(
      postJson({
        url: 'u',
        headers: {},
        body: {},
        fetchImpl: async () => {
          call += 1;
          return statusResponse(529);
        },
        attempts: 3,
        backoffMs: instant,
      }),
    ).rejects.toThrow(/HTTP 529/);
    expect(call).toBe(3);
  });

  it('a transport failure names its cause — the live run\u2019s SSL alert, readable', async () => {
    await expect(
      postJson({
        url: 'u',
        headers: {},
        body: {},
        fetchImpl: async () => {
          throw new TypeError('fetch failed', {
            cause: new Error('ssl3_read_bytes: bad record mac'),
          });
        },
        attempts: 2,
        backoffMs: instant,
      }),
    ).rejects.toThrow(/fetch failed.*bad record mac/);
  });
});

describe('the harness stays out of the product', () => {
  it('package.json files excludes bench/', () => {
    const packageManifest = JSON.parse(
      readFileSync(resolve(testDir, '../package.json'), 'utf8'),
    ) as { files: readonly string[] };
    expect(
      packageManifest.files.some((entry) => entry === 'bench' || entry.startsWith('bench/')),
    ).toBe(false);
  });

  it('bench/ lives outside src/, so the zero-network walk never discovers it', () => {
    expect(existsSync(resolve(testDir, '../src/bench'))).toBe(false);
    expect(existsSync(join(benchDir, 'run.mjs'))).toBe(true);
  });
});
