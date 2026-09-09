import facts from '@/generated/facts.json';
import { SectionHeader } from '@/components/ui/SectionHeader';
import { Reveal } from '@/components/ui/Reveal';
import { GITHUB } from '@/components/Nav';

const ENTRIES = [
  {
    name: 'Headroom',
    href: 'https://github.com/headroomlabs-ai/headroom',
    body: "Python, same core shape: local store, a retrieve tool, BM25. Its CacheAligner's detect-don't-rewrite decision is copied here outright. If you need this today, in Python, use Headroom.",
  },
  {
    name: "Aider's repo-map",
    href: 'https://aider.chat/2023/10/22/repomap.html',
    body: 'The proven prior art the repo-map planner is modelled on: tree-sitter tags + PageRank + a budget + a cache.',
  },
  {
    name: 'LLMLingua',
    href: 'https://github.com/microsoft/LLMLingua',
    body: 'The prompt-compression research line; its numbers are on non-code benchmarks.',
  },
  {
    name: 'SweRank · LocAgent · Agentless',
    href: 'https://arxiv.org/abs/2505.07849',
    body: 'Learned code localization — a v2 conversation, because each puts a model in the retrieval path.',
  },
  {
    name: 'Tree-sitter',
    href: 'https://tree-sitter.github.io/',
    body: `The parsers under all of it. ${String(facts.grammars.length)} grammars ship inside the tarball, attribution generated and guard-checked.`,
  },
] as const;

export function PriorArt() {
  return (
    <section aria-labelledby="prior-art">
      <div className="mx-auto max-w-[1120px] px-4 py-16 sm:px-6 md:py-24">
        <SectionHeader
          id="prior-art"
          index="06 · credited honestly →"
          title={
            <>
              Prior art.{' '}
              <span className="text-slag">
                smelt's architecture is close to Headroom's, and it would be dishonest to imply
                otherwise.
              </span>
            </>
          }
          lead={
            <>
              What smelt actually adds — the whole list: the zero-network guarantee, the requirement
              that every elision explains itself in named-rule terms, and the mutation-tested
              honesty machinery that makes both claims checkable instead of aspirational.
            </>
          }
        />
        <Reveal className="mt-10">
          <dl>
            {ENTRIES.map((entry) => (
              <div
                key={entry.name}
                className="grid gap-2 border-t border-iron-dark py-5 last:border-b md:grid-cols-12 md:gap-8"
              >
                <dt className="md:col-span-4">
                  <a
                    href={entry.href}
                    className="text-[15px] font-medium text-ash underline decoration-iron underline-offset-4 transition-colors hover:decoration-ember"
                  >
                    {entry.name}
                  </a>
                </dt>
                <dd className="text-[14px] leading-[1.6] text-slag md:col-span-8">{entry.body}</dd>
              </div>
            ))}
          </dl>
        </Reveal>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="border-t border-iron-dark">
      <div className="mx-auto flex max-w-[1120px] flex-col gap-8 px-4 py-12 sm:px-6 md:flex-row md:items-end md:justify-between">
        <div>
          <div className="flex items-center gap-2.5">
            <img src={`${import.meta.env.BASE_URL}smelt-mark.svg`} alt="" width="28" height="28" />
            <span className="text-[15px] font-semibold tracking-tight text-ash">smelt</span>
          </div>
          <p className="mt-3 max-w-[44ch] text-[14px] leading-[1.6] text-slag">
            Cut hard. Explain everything. Keep the ore.
          </p>
          <p className="mt-4 font-mono text-[12px] text-slag">
            @smeltjs/core v{facts.versions.core} · @smeltjs/mcp v{facts.versions.mcp} · Apache-2.0
          </p>
        </div>
        <nav
          aria-label="Footer"
          className="grid grid-cols-2 gap-x-12 gap-y-2 text-[14px] sm:grid-cols-3"
        >
          {[
            { label: 'GitHub', href: GITHUB },
            { label: 'npm: core', href: 'https://www.npmjs.com/package/@smeltjs/core' },
            { label: 'npm: mcp', href: 'https://www.npmjs.com/package/@smeltjs/mcp' },
            { label: 'Docs (ARCHITECTURE)', href: `${GITHUB}/blob/main/docs/ARCHITECTURE.md` },
            { label: 'Bench harness', href: `${GITHUB}/tree/main/packages/core/bench` },
            { label: 'llms.txt', href: `${import.meta.env.BASE_URL}llms.txt` },
            { label: 'License', href: `${GITHUB}/blob/main/LICENSE` },
          ].map((link) => (
            <a
              key={link.label}
              href={link.href}
              className="text-slag transition-colors duration-150 hover:text-ash"
            >
              {link.label}
            </a>
          ))}
        </nav>
      </div>
    </footer>
  );
}
