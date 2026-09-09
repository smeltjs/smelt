import type { ReactNode } from 'react';
import facts from '@/generated/facts.json';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Reveal } from '@/components/ui/Reveal';

function Stage({ name, note }: { name: string; note: string }) {
  return (
    <div className="flex-1 rounded-[8px] border border-iron-dark bg-lift px-4 py-3">
      <div className="font-mono text-[13px] text-ash">{name}</div>
      <div className="mt-1 text-[13px] leading-[1.5] text-slag">{note}</div>
    </div>
  );
}

function Arrow() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center justify-center self-center text-iron-light"
    >
      <span className="rotate-90 font-mono text-[14px] md:rotate-0">→</span>
    </div>
  );
}

const LAWS: readonly { index: string; title: string; body: ReactNode }[] = [
  {
    index: 'law/1',
    title: 'Zero network',
    body: 'No external calls, in any code path — enforced by a guard that walks the real import graph from every entrypoint the manifest advertises. Code never leaves the machine.',
  },
  {
    index: 'law/2',
    title: 'Every elision is explainable',
    body: 'A named rule and a sentence a human can read in a diff. "collapsed 3 sibling functions" — never a model\'s opinion, never an unexplained "[…truncated…]".',
  },
  {
    index: 'law/3',
    title: 'Every elision is reversible, and counted',
    body: 'Elided bytes are stored locally, keyed by content hash, with no automatic eviction — the only deletion is smelt store prune, which you type and which journals what it removed. Expansions are counted: reversibility without counting is how "90% reduction" gets claimed while the model quietly asks for all of it back.',
  },
  {
    index: 'law/4',
    title: 'Claim no number that has not been measured',
    body: 'Absolute — not in the README, not in a doc comment, not on this page. The numbers below are a table with a date and a corpus commit, not a headline.',
  },
];

export function HowItWorks() {
  return (
    <section aria-labelledby="how" className="border-b border-iron-dark">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="how"
          index="03 · plan → apply → store → retrieve →"
          title={
            <>
              One pipeline, four laws.{' '}
              <span className="text-slag">Planners decide; only apply removes bytes.</span>
            </>
          }
          lead={
            <>
              A planner turns blob + budget + focus into a plan without removing anything. Applying
              the plan is the single byte-remover, every removal leaves a marker, and the store
              makes each one reversible — by construction, not by promise.
            </>
          }
        />

        <Reveal className="mt-10">
          <div
            className="flex flex-col gap-2 md:flex-row md:gap-3"
            role="img"
            aria-label="Pipeline: plan, then apply, then store, then retrieve"
          >
            <Stage
              name="plan"
              note={`blob + budget + focus → an elision plan; nothing removed yet. Under auto: content kind first (json, diff), then structural in the ${String(facts.structuralLanguages.length)} languages with a bundled grammar, lexical everywhere else.`}
            />
            <Arrow />
            <Stage name="apply" note="the only byte-remover; every cut leaves a one-line marker" />
            <Arrow />
            <Stage name="store" note="elided bytes kept locally, content-addressed, no automatic eviction" />
            <Arrow />
            <Stage
              name="retrieve"
              note="exact original bytes back by hash — and the call is counted"
            />
          </div>
        </Reveal>

        <Reveal className="mt-10">
          <div className="grid gap-px overflow-hidden rounded-[12px] border border-iron-dark bg-iron-dark md:grid-cols-2">
            {LAWS.map((law) => (
              <article key={law.index} className="bg-charcoal p-5 sm:p-6">
                <div className="font-mono text-[13px] text-ember">{law.index}</div>
                <h3 className="mt-2 text-[17px] font-medium leading-[1.3] text-ash sm:text-[18px]">
                  {law.title}
                </h3>
                <p className="mt-2 max-w-[52ch] text-[14px] leading-[1.6] text-slag">{law.body}</p>
              </article>
            ))}
          </div>
          <p className="mt-4 max-w-[72ch] text-[13px] leading-[1.6] text-slag">
            Each law has a guard that can fail, and each guard has mutations proving it does:{' '}
            {facts.guards.guards} guard suites, {facts.guards.mutations} mutations across them, run
            by <code className="font-mono">pnpm mutate</code> — a deliberate break the guard must
            catch, or the run fails.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
