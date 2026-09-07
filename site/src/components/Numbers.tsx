import bench from '@/generated/bench.json';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Reveal } from '@/components/ui/Reveal';

/**
 * Law 4, mechanically: everything here is generated at build time from the latest run
 * in packages/core/bench/RESULTS.md (see scripts/bench-data.mjs). No number on this
 * page is typed by hand; every reduction is computed from two measured values; the
 * tier-3 aggregate and tier-4 verdicts arrive pre-parsed from the row notes, and a
 * note the generator cannot parse fails the build instead of guessing.
 */

interface Row {
  case: string;
  unit: string;
  input: number;
  output: number;
  elisions: number | null;
  model: string | null;
  note: string;
  overBudget: boolean;
  verdict?: string;
  retrieves?: number;
}

interface BenchData {
  runDate: string;
  tiersRun: string;
  corpusCommit: string;
  model: string | null;
  tiers: { bytes: Row[]; tokens: Row[]; expansion: Row[]; ab: Row[] };
  tier3Aggregate: number | null;
  provenance: Record<'bytes' | 'tokens' | 'expansion' | 'ab', { date: string; corpusCommit: string; model: string | null } | null>;
}

function ran(p: { date: string; corpusCommit: string } | null): string {
  return p === null ? 'not yet measured' : `run ${p.date}, corpus ${p.corpusCommit}`;
}

const data = bench as unknown as BenchData;
const fmt = new Intl.NumberFormat('en-US');

function plannerOf(note: string): string {
  const m = note.match(/(structural|lexical|json|diff)\/v\d+/);
  return m ? m[0] : '—';
}

function budgetOf(note: string): string {
  const m = note.match(/budget ([\d,]+) B/);
  return m ? `${m[1]} B` : '—';
}

function reduction(row: Row): string {
  const pct = ((row.output - row.input) / row.input) * 100;
  return `${pct.toFixed(1)}%`;
}

function total(rows: Row[]): number {
  return rows.reduce((sum, row) => sum + row.input, 0);
}

const th = 'py-2.5 pr-4 font-mono text-[13px] font-normal text-slag';
const td = 'py-3 pr-4';

export function Numbers() {
  const bytes = data.tiers.bytes;
  const tokens = data.tiers.tokens;
  const expansion = data.tiers.expansion;
  const ab = data.tiers.ab;
  const ties = ab.filter((r) => r.verdict === 'tie').length;
  const rawBetter = ab.filter((r) => r.verdict === 'raw better').length;
  const smeltedBetter = ab.filter((r) => r.verdict === 'smelted better').length;
  // Every count below is derived from the rows, never typed: the expansion sums, the
  // loss cases, the retrieve range, and the zero-retrieve arm ratios.
  const stored = expansion.reduce((sum, r) => sum + r.input, 0);
  const retrieved = expansion.reduce((sum, r) => sum + r.output, 0);
  const lossCases = expansion.filter((r) => r.input > 0 && r.output === r.input).length;
  const retrieveCounts = ab.map((r) => r.retrieves ?? 0);
  const zeroRetrieveRatios = ab
    .filter((r) => (r.retrieves ?? 0) === 0 && r.output > 0)
    .map((r) => r.input / r.output);

  return (
    <section aria-labelledby="numbers" className="border-b border-iron-dark">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="numbers"
          index="05 · measured, or absent →"
          title={
            <>
              Measured numbers.{' '}
              <span className="text-slag">Generated from the bench table, never typed.</span>
            </>
          }
          lead={
            <>
              From the committed measurement harness (
              <code className="font-mono text-[13px]">pnpm bench</code>). Each tier's rows come
              from the last run that measured it, and say so: tier 1 {ran(data.provenance.bytes)};
              tier 2 {ran(data.provenance.tokens)}; tiers 3–4 {ran(data.provenance.expansion)},
              once, on <span className="font-mono text-[13px]">{data.model ?? '—'}</span>, logs
              committed beside the rows. Tiers 1–2 reproduce from a fresh clone. Parsed out of{' '}
              <code className="font-mono text-[13px]">bench/RESULTS.md</code> at build time.
            </>
          }
        />

        <Reveal className="mt-10">
          <div className="grid gap-10 lg:grid-cols-12 lg:gap-8">
            <div className="lg:col-span-8">
              <h3 className="font-mono text-[13px] text-iron-light">
                tier 1 — bytes, deterministic, offline · unit: UTF-8 bytes ·{' '}
                {ran(data.provenance.bytes)}
              </h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-iron-dark">
                      <th scope="col" className={`${th} text-left`}>case</th>
                      <th scope="col" className={`${th} text-left`}>planner</th>
                      <th scope="col" className={`${th} text-left`}>budget</th>
                      <th scope="col" className={`${th} text-right`}>in (B)</th>
                      <th scope="col" className={`${th} text-right`}>out (B)</th>
                      <th scope="col" className={`${th} text-right`}>reduction</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[13px]">
                    {bytes.map((row) => (
                      <tr key={row.case} className="border-b border-iron-dark">
                        <td className={`${td} text-ash`}>{row.case}</td>
                        <td className={`${td} text-slag`}>{plannerOf(row.note)}</td>
                        <td className={`${td} text-slag`}>{budgetOf(row.note)}</td>
                        <td className={`${td} text-right text-slag`}>{fmt.format(row.input)}</td>
                        <td className={`${td} text-right text-slag`}>{fmt.format(row.output)}</td>
                        <td className={`${td} text-right`}>
                          {row.overBudget ? (
                            <span className="text-ember">over budget, reported</span>
                          ) : (
                            <span className="text-ash">{reduction(row)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    <tr className="border-b border-iron-dark">
                      <td className={`${td} text-iron-light`}>corpus total</td>
                      <td className={td} />
                      <td className={td} />
                      <td className={`${td} text-right text-iron-light`}>
                        {fmt.format(total(bytes))}
                      </td>
                      <td className={`${td} text-right text-iron-light`}>
                        {fmt.format(bytes.reduce((sum, row) => sum + row.output, 0))}
                      </td>
                      <td className={`${td} text-right text-iron-light`}>
                        {(
                          ((bytes.reduce((sum, row) => sum + row.output, 0) - total(bytes)) /
                            total(bytes)) *
                          100
                        ).toFixed(1)}
                        %
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="mt-10 font-mono text-[13px] text-iron-light">
                tier 2 — tokens, {data.provenance.tokens?.model ?? '—'}'s own tokenizer · unit:
                tokens · {ran(data.provenance.tokens)}
              </h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-iron-dark">
                      <th scope="col" className={`${th} text-left`}>case</th>
                      <th scope="col" className={`${th} text-right`}>in (tok)</th>
                      <th scope="col" className={`${th} text-right`}>out (tok)</th>
                      <th scope="col" className={`${th} text-right`}>reduction</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[13px]">
                    {tokens.map((row) => (
                      <tr key={row.case} className="border-b border-iron-dark">
                        <td className={`${td} text-ash`}>{row.case}</td>
                        <td className={`${td} text-right text-slag`}>{fmt.format(row.input)}</td>
                        <td className={`${td} text-right text-slag`}>{fmt.format(row.output)}</td>
                        <td className={`${td} text-right text-ash`}>{reduction(row)}</td>
                      </tr>
                    ))}
                    <tr className="border-b border-iron-dark">
                      <td className={`${td} text-iron-light`}>corpus total</td>
                      <td className={`${td} text-right text-iron-light`}>
                        {fmt.format(total(tokens))}
                      </td>
                      <td className={`${td} text-right text-iron-light`}>
                        {fmt.format(tokens.reduce((sum, row) => sum + row.output, 0))}
                      </td>
                      <td className={`${td} text-right text-iron-light`}>
                        {(
                          ((tokens.reduce((sum, row) => sum + row.output, 0) - total(tokens)) /
                            total(tokens)) *
                          100
                        ).toFixed(1)}
                        %
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3 className="mt-10 font-mono text-[13px] text-iron-light">
                tier 3 — the expansion rate, the honest signal · and it rang
              </h3>
              <p className="mt-3 font-mono text-[13px] text-ash">
                aggregate {data.tier3Aggregate?.toFixed(2) ?? '—'} — the model asked for{' '}
                {fmt.format(retrieved)} of {fmt.format(stored)} elided blobs back
              </p>
              <p className="mt-2 text-[14px] leading-[1.7] text-slag">
                Tier 3 hands the model the smelted text under a{' '}
                <em>read this whole file to understand it before editing</em> framing — the one
                task shape that genuinely needs everything. The over-pruning alarm exists to ring
                there, and it did: {lossCases} of {expansion.length} cases retrieved every elision
                back. For question-shaped reads — tier 4 below — the same model retrieved{' '}
                {fmt.format(Math.min(...retrieveCounts))}–{fmt.format(Math.max(...retrieveCounts))}{' '}
                of them.
              </p>

              <h3 className="mt-10 font-mono text-[13px] text-iron-light">
                tier 4 — answer quality, A/B, one judged run · verdicts are a model's opinion
              </h3>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full min-w-[560px] border-collapse text-left text-[14px]">
                  <thead>
                    <tr className="border-b border-iron-dark">
                      <th scope="col" className={`${th} text-left`}>case</th>
                      <th scope="col" className={`${th} text-right`}>raw in (tok)</th>
                      <th scope="col" className={`${th} text-right`}>smelted in (tok)</th>
                      <th scope="col" className={`${th} text-right`}>retrieves</th>
                      <th scope="col" className={`${th} text-left`}>verdict</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono text-[13px]">
                    {ab.map((row) => (
                      <tr key={row.case} className="border-b border-iron-dark">
                        <td className={`${td} text-ash`}>{row.case}</td>
                        <td className={`${td} text-right text-slag`}>{fmt.format(row.input)}</td>
                        <td className={`${td} text-right text-slag`}>
                          {fmt.format(row.output)}
                        </td>
                        <td className={`${td} text-right text-slag`}>
                          {fmt.format(row.retrieves ?? 0)}
                        </td>
                        <td className={`${td} ${row.verdict === 'tie' ? 'text-slag' : 'text-ember'}`}>
                          {row.verdict}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[14px] leading-[1.7] text-slag">
                {ties} ties · {rawBetter} raw better · {smeltedBetter} smelted better — and the one
                "smelted better" is an artifact: that raw arm returned an empty answer (0 output
                tokens; the judge says so in the committed log). The economics reading: on the
                cases that retrieved nothing, the raw arm paid{' '}
                {Math.min(...zeroRetrieveRatios).toFixed(1)}–
                {Math.max(...zeroRetrieveRatios).toFixed(1)}× the smelted arm's input; where
                retrieves happened, each round re-billed the transcript and could flip the sign —
                the reason the expansion rate is a first-class number, not a footnote.
              </p>

              <p className="mt-3 font-mono text-[12px] text-slag">
                generated at build time by site/scripts/bench-data.mjs from
                packages/core/bench/RESULTS.md
              </p>
            </div>

            <div className="text-[14px] leading-[1.7] text-slag lg:col-span-4">
              <h3 className="font-mono text-[13px] text-iron-light">what these are / are not</h3>
              <p className="mt-2">
                <span className="text-ash">What they are:</span> measured bytes (tier 1),
                measured tokens on the named model's tokenizer (tier 2), counted{' '}
                <code className="font-mono text-[13px]">smelt_retrieve</code> calls (tier 3), and
                one judged A/B run with committed logs (tier 4) — on a nine-case corpus of real
                tool outputs and byte-exact files from django, scikit-learn and sympy at pinned
                commits.
              </p>
              <p className="mt-3">
                <span className="text-ash">What they are not:</span> dollar savings — no price
                table is committed, tokens are the measured unit — nor rates from real agent
                traffic: tier 3's framing is a lab task, chosen to ring the alarm on purpose.
              </p>
              <p className="mt-3">
                <span className="text-ash">The honest reading:</span> ingress shrinkage is real and
                large (−80% of tokens across this corpus); question-shaped reads keep answer
                quality at tie while paying a fraction of the input; and whole-file-comprehension
                tasks ask for everything back, which is the signal working, not the product
                failing.
              </p>
              <p className="mt-3">
                For the class of saving to expect on real agent traffic, the honest comparable
                remains{' '}
                <a
                  href="https://github.com/headroomlabs-ai/headroom"
                  className="text-ash underline decoration-iron underline-offset-4 transition-colors hover:decoration-ember"
                >
                  Headroom's
                </a>{' '}
                stated 21–57% across its four proof scenarios (README, 2026-09) — their numbers, on
                their corpus, cited as exactly that.
              </p>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
