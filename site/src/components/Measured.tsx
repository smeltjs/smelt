import bench from '@/generated/bench.json';
import { Reveal } from '@/components/ui/Reveal';

/**
 * The measured strip — three headline numbers directly under the hero, each read off
 * the generated bench data and each carrying its own provenance (tier, model, date,
 * corpus commit). Nothing here is typed: the tiles are derived from the same rows the
 * Numbers section renders in full, so the two cannot disagree. A tier that was never
 * measured renders as exactly that, never as a placeholder number (Law 4).
 *
 * The expansion rate goes up unflattered. It is the honest signal the product exists
 * to surface, and 0.94 on whole-file tasks is the alarm ringing where it should.
 */

interface Row {
  case: string;
  input: number;
  output: number;
  verdict?: string;
}
interface Provenance {
  date: string;
  corpusCommit: string;
  model: string | null;
}
interface BenchData {
  provenance: {
    tokens: Provenance | null;
    expansion: Provenance | null;
    ab: Provenance | null;
  };
  tiers: { tokens: Row[]; expansion: Row[]; ab: Row[] };
  tier3Aggregate: number | null;
}

const data = bench as unknown as BenchData;
const fmt = new Intl.NumberFormat('en-US');

function provenanceLine(tier: string, p: Provenance | null): string {
  if (p === null) return `${tier} · not yet measured`;
  return [tier, p.model, p.date, `corpus ${p.corpusCommit}`].filter(Boolean).join(' · ');
}

function Tile({
  label,
  value,
  unit,
  reading,
  provenance,
}: {
  label: string;
  value: string;
  unit: string;
  reading: string;
  provenance: string;
}) {
  return (
    <a
      href="#numbers"
      className="group flex flex-col gap-2 rounded-[8px] border border-iron-dark bg-lift px-5 py-4 transition-colors duration-150 hover:border-iron"
    >
      <span className="font-mono text-[12px] text-iron-light">{label}</span>
      <span className="flex items-baseline gap-2">
        <span className="text-[30px] font-semibold leading-none tracking-[-0.02em] text-ash tabular-nums sm:text-[34px]">
          {value}
        </span>
        <span className="font-mono text-[13px] text-slag">{unit}</span>
      </span>
      <span className="text-[13px] leading-[1.5] text-slag">{reading}</span>
      <span className="mt-1 font-mono text-[11px] leading-[1.5] text-iron-light">{provenance}</span>
    </a>
  );
}

export function Measured() {
  const tokens = data.tiers.tokens;
  const tokensIn = tokens.reduce((sum, r) => sum + r.input, 0);
  const tokensOut = tokens.reduce((sum, r) => sum + r.output, 0);
  const tokensPct = tokensIn === 0 ? null : ((tokensIn - tokensOut) / tokensIn) * 100;

  const expansion = data.tiers.expansion;
  const stored = expansion.reduce((sum, r) => sum + r.input, 0);
  const retrieved = expansion.reduce((sum, r) => sum + r.output, 0);
  const lossCases = expansion.filter((r) => r.input > 0 && r.output === r.input).length;

  const ab = data.tiers.ab;
  const ties = ab.filter((r) => r.verdict === 'tie').length;
  const rawBetter = ab.filter((r) => r.verdict === 'raw better').length;
  const smeltedBetter = ab.filter((r) => r.verdict === 'smelted better').length;

  return (
    <section aria-label="Measured numbers, in brief" className="border-b border-iron-dark">
      <Reveal>
        <div className="mx-auto max-w-[1120px] px-4 py-8 sm:px-6">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="font-mono text-[13px] text-iron-light">
              measured — the bench, in three numbers
            </h2>
            <a href="#numbers" className="font-mono text-[13px] text-slag hover:text-ash">
              every row →
            </a>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <Tile
              label="tokens sent, nine-case corpus"
              value={tokensPct === null ? '—' : `−${tokensPct.toFixed(0)}%`}
              unit={tokensPct === null ? '' : `${fmt.format(tokensIn)} → ${fmt.format(tokensOut)}`}
              reading="Counted on the model's own tokenizer, the text as one user message."
              provenance={provenanceLine('tier 2', data.provenance.tokens)}
            />
            <Tile
              label="expansion rate, whole-file tasks"
              value={data.tier3Aggregate === null ? '—' : data.tier3Aggregate.toFixed(2)}
              unit={stored === 0 ? '' : `${fmt.format(retrieved)} of ${fmt.format(stored)} asked back`}
              reading={
                expansion.length === 0
                  ? 'The honest signal of over-pruning, measured and never thresholded.'
                  : `The over-pruning alarm, ringing where it should: ${String(lossCases)} of ${String(expansion.length)} cases retrieved everything.`
              }
              provenance={provenanceLine('tier 3', data.provenance.expansion)}
            />
            <Tile
              label="answer quality, A/B against raw"
              value={ab.length === 0 ? '—' : `${String(ties)} ties`}
              unit={
                ab.length === 0
                  ? ''
                  : `${String(rawBetter)} raw better · ${String(smeltedBetter)} smelted better`
              }
              reading="Judged blind against the raw blob, verdicts logged. One judged run: a model's opinion, reported as such."
              provenance={provenanceLine('tier 4', data.provenance.ab)}
            />
          </div>
        </div>
      </Reveal>
    </section>
  );
}
