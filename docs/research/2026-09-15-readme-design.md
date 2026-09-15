# README design — structure, length, and the first screen, against primary sources

Sixth note in the `docs/research/` convention (see
[`2026-09-02-agent-enforcement.md`](2026-09-02-agent-enforcement.md) for its start). Surveyed
**2026-09-15**: guidance pages fetched live, the eight example READMEs fetched as raw
Markdown from their default branches and counted locally, so every length/count below is
**MEASURED** with a stated basis (`wc -l -w -c`, or `grep -c` on the stated pattern).
**CLAIMED** marks an assertion with no published basis — most of the guidance literature is
CLAIMED by nature: experienced opinion, not measurement. Feeds a restructure proposal (§6).

## 0. Verification status

| Source                                              | Status (2026-09-15)                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub Docs "About READMEs"; Make a README          | Both verified live ([docs.github.com](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes), [makeareadme.com](https://www.makeareadme.com/))                                                                                                            |
| **Art of README**                                   | **Canonical source gone.** `github.com/hackergrrl/art-of-readme` → 404, and the `hackergrrl` account 404s on the GitHub API; `noffle` exists with 0 public repos. Read from a third-party copy, [bradparks/art-of-readme](https://github.com/bradparks/art-of-readme) (422 lines) — **secondhand**, not diffable against an original. |
| readme.so                                           | Landing page live ([readme.so](https://readme.so/)) but enumerates no sections; catalogue below read from its own repo, [`template.md`](https://github.com/octokatherine/readme.so/blob/main/template.md).                                                                                                                            |
| Zod, Vite, Bun, ripgrep, fd, bat, esbuild, Prettier | All eight verified live via `raw.githubusercontent.com`, branch per §3. Zod's repo-root `README.md` is a 22-byte pointer to `packages/zod/README.md`; that file was measured.                                                                                                                                                         |

## 1. GitHub Docs — the only normative source here

[docs.github.com, "About READMEs"](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-readmes),
retrieved 2026-09-15. Thin on style, specific on mechanics:

- A README "should include information on": "What the project does", "Why the project is
  useful", "How users can get started with the project", "Where users can get help with
  your project", "Who maintains and contributes to the project" — five questions in that
  order (CLAIMED, no basis offered, but it is what GitHub publishes).
- **Headings generate a table of contents automatically** (outline menu), so a hand-written
  TOC is duplicated machinery on GitHub; relative links and image paths are rewritten per
  branch, so links into `docs/` survive clones and forks — what makes "link out" cheap.
- The only hard number: "any content beyond 500 KiB will be truncated" — a ceiling, not a
  target (smelt's README, 60,880 B, is at 12% of it). Length advice is otherwise
  qualitative: use a wiki rather than a "bloated" README.

## 2. The opinion literature

**Make a README** ([makeareadme.com](https://www.makeareadme.com/), retrieved 2026-09-15) —
the 12-section list, in order: Name, Description, Badges, Visuals, Installation, Usage,
Support, Roadmap, Contributing, Authors and acknowledgment, License, Project status. All
CLAIMED: "While a README can be too long and detailed, too long is better than too short";
"Use examples liberally, and show the expected output if you can… inline the smallest
example of usage that you can demonstrate"; visuals may be screenshots or GIFs, with
Asciinema named for terminal capture; bigger projects "can also benefit from a wiki or a
dedicated documentation website".

**Art of README** (secondhand, §0) originates the ideas, and argues the opposite of "too
long is better than too short":

- The job: "1. tell them what it is (with context) 2. show them what it looks like in action 3. show them how they use it 4. tell them any other relevant details".
- **Brevity:** "The ideal README is as short as it can be without being any shorter.
  Detailed documentation is good -- make separate pages for it! -- but keep your README
  succinct."
- **Key elements in scan order:** Name → One liner → Usage → API → Installation → License.
  Install lands _fifth_: "if I've read this far down then I'm sold on trying out the module."
- **Cognitive funneling** — "a funnel held upright, where the widest end contains the
  broadest more pertinent details, and moving deeper down into the funnel presents more
  specific details that are pertinent for only a reader who is interested enough in your
  work to have reached that deeply in the document"; quoting `perlmodstyle`, "someone who's
  slightly familiar with your module should be able to refresh their memory without hitting
  'page down'". Elements are ordered "by how quickly they let someone 'short circuit' and
  bail on your module."
- **Badges, skeptically:** "Be judicious… They add visual noise to your README… For each
  badge, consider: 'what real value is this badge providing to the typical viewer'?"
- Also: **aggressively linkify**; keep the Usage example as a runnable file in the repo;
  for a CLI "show usage examples as command invocations and their output"; _inline_
  anything essential, because the README "will outlive your repository host and any of the
  things you hyperlink to--especially images".

**readme.so** is a block editor — "The easiest way to create a README" is its only guidance
text. Its repo's `template.md` carries 25 blocks (Installation, Run Locally, Screenshots,
Environment Variables, Features, Usage/Examples, API Reference, Contributing, Running
Tests, License, Badges, Roadmap, Authors, Support, Feedback, Related, Demo, Tech Stack,
Optimizations, Lessons Learned, FAQ, Used By, Documentation, Deployment, Appendix) — a
menu, not an order, which is itself the finding: outside "name, pitch, something you can
run", there is no consensus ordering.

## 3. The eight READMEs, measured

Fetched 2026-09-15 from `raw.githubusercontent.com` on the branch named. Length `wc -l -w -c`; "badges" `grep -c` for shields/badge image URLs; "rows" `grep -c '^|'`; "imgs" `grep -c -E '!\[|<img '`.

| README (branch)                                                  | Lines | Words |  Bytes | Badges | Imgs | Rows | Hand TOC                          |
| ---------------------------------------------------------------- | ----: | ----: | -----: | -----: | ---: | ---: | --------------------------------- |
| [esbuild](https://github.com/evanw/esbuild) (main)               |    39 |   166 |  2,104 |  **0** |    2 |    0 | no (5-link nav row)               |
| [Vite](https://github.com/vitejs/vite) (main)                    |    66 |   239 |  3,416 |      4 |    9 |    5 | no                                |
| [Prettier](https://github.com/prettier/prettier) (main)          |   104 |   236 |  3,396 |      7 |   10 |    0 | no (docs link block, L84)         |
| [Zod](https://github.com/colinhacks/zod) (main, `packages/zod/`) |   218 |   914 |  7,304 |      5 |    6 |    0 | no (4-link nav row)               |
| [Bun](https://github.com/oven-sh/bun) (main)                     |   446 | 2,062 | 26,195 |      3 |    4 |    0 | no (353 lines of docs-site index) |
| [ripgrep](https://github.com/BurntSushi/ripgrep) (master)        |   541 | 2,874 | 21,599 |      3 |    4 |   36 | yes — "Documentation quick links" |
| [fd](https://github.com/sharkdp/fd) (master)                     |   790 | 4,048 | 28,132 |      2 |    4 |    0 | yes — 3-link nav row              |
| [bat](https://github.com/sharkdp/bat) (master)                   |   941 | 4,654 | 33,947 |      2 |    8 |   16 | yes — 5-link nav row              |

**First screens, in order, with raw-file line numbers — and where each hands off:**

| README   | First screen, in order                                                                                                                                                                         | Install at | Hands off to                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------- |
| esbuild  | wordmark (L1) · nav row Website ∣ Getting started ∣ Documentation ∣ Plugins ∣ FAQ (L8) · `## Why?` (L15) · benchmark bar-chart SVG (L19) · goal paragraph · 7 linkified bullets                | **absent** | esbuild.github.io, from every feature bullet                                                          |
| Prettier | banner · `<h2>Opinionated Code Formatter</h2>` (L3) · language list · 7 badges (L37) · `## Intro`, one paragraph (L57) · `### Input`/`### Output`, the real example as a code pair (L61–79)    | a link     | rule-delimited block (L82): Documentation · Install · Options · CLI · API · Playground                |
| Zod      | logo · `<h1>Zod</h1>` · one-liner "TypeScript-first schema validation with static type inference" (L5) · byline · 5 badges · nav row (L20) · **`### [Read the docs →]` (L34)** · example (L39) | L77, 8th   | zod.dev (6 links)                                                                                     |
| Bun      | logo · `<h1>Bun</h1>` · 3 badges · nav row · **`### [Read the docs →]` (L23)** · What is Bun? (L25) with two runnable blocks                                                                   | L44        | **353 of 446 lines (79%) are a link index** — 120 `bun.com/docs`, 190 `bun.com/guides`                |
| ripgrep  | **prose first**: setext title + 9-line description (L1–9), _then_ 3 badges (L11), licence, `### Documentation quick links` (L22), screenshot PNG (L34), benchmark tables (L39) as the pitch    | **L233**   | `GUIDE.md`, `FAQ.md`, `CHANGELOG.md` (13 refs). Installation is L233–450 — 217 lines, 40% of the file |
| fd       | `# fd` · 2 badges + 2 translation links · 3-sentence description · nav row (L13) · Features · `## Demo` (L30), an **SVG screencast committed in-repo** (`doc/screencast.svg`)                  | **L538**   | translated READMEs; installation is ~250 lines, per distro                                            |
| bat      | logo · 3 badges · one-liner (L6) · nav row + 5 translated READMEs · **four feature sections each led by a screenshot** (L22–53)                                                                | L243       | `doc/alternatives.md`, `doc/assets.md`, `doc/batgrep.md`, `doc/batman.md`, `doc/prettybat.md`         |
| Vite     | logo · 4 badges · `# Vite ⚡` (L23) · blockquote tagline · 6 bullets · two paragraphs · "[Read the Docs to Learn More]" (L41) · a 3-row Packages/version table                                 | **absent** | vite.dev; no code block anywhere in the file                                                          |

**Patterns that hold across all eight (MEASURED):**

1. **One-line pitch inside the first 10 lines: 8/8.**
2. **Explicit handoff to docs: 8/8**, at or above the fold in 6/8 (esbuild L8, bat L10, fd
   L13, ripgrep L22, bun L23, zod L34; Vite L41, Prettier L84). Two use the identical line
   `### [Read the docs →]`.
3. **Badges: 7/8**, count 2–7; esbuild ships **zero**, nobody exceeds 7. **Image or
   terminal capture in the first screen: 6/8** (fd's screencast L30 and ripgrep's
   screenshot L34 are just below; Vite's is a logo only).
4. **A single install line on the first screen: 0/8.** Install sits at L44, L77, L233,
   L243, L538, is a bare link (Prettier), or is absent (Vite, esbuild) — contradicting the
   "install line in the hero" intuition, and matching Art of README's funnel exactly.
   **A real runnable example before install: 5/8** (Prettier, Zod, Bun, ripgrep, fd).
5. **Tables are rare and do one job: comparison.** 5/8 have none; ripgrep's 36 rows are
   timings and features, bat's 16 are options, Vite's 5 are package→version. None uses a
   table for prose.
6. **Hand-written TOC: 3/8**, all CLIs over 500 lines — and the two longest (bat 941, fd 790) spend that length on per-distro install and per-tool integration, not on
   architecture, rationale, or design law.

## 4. smelt's README, measured the same way

`/Users/mjnong/repos/smelt/README.md` at `6706b3a`, 2026-09-15: **1,018 lines · 8,608 words
· 60,880 bytes** — **1.08× bat**, the longest peer, and **26× esbuild**. 8 distinct table
blocks / **72 table rows** (twice ripgrep's count, the table-heaviest peer), 62 code fences,
6 images, 4 badges.

**First screen (L1–24):** wordmark SVG · one-liner "Structure-aware, reversible context
optimization for coding agents." + "A library, not a proxy." · 4 badges (CI,
`network_calls-0`, node, licence) · nav row Docs · Vocabulary · Changelog · Skill · llms.txt
· a **3-column measured-numbers table** (−80% tokens; 0.94 expansion rate; 6 ties) with
per-cell provenance footers (tier, model, date, corpus commit) · a pointer to `smelt stats`.
Peer-conformant through the nav row; the numbers table is the divergence, and §5 says why it
is required rather than optional.

**Sections (L, name, measured span).** L26 What it does 34 · L60 Install 16 · L76 For
agents 40 · L116 Sixty seconds from a shell 80 · L196 `smelt init` 20 · L216 The library 40
· L256 Wiring it into an agent harness 45 · L301 One command `smelt setup` 78 · L379 One
project or the whole machine 26 · L405 Updating 54 · L459 The hooks preset 81 · L540 As an
MCP server 19 · L559 `smelt agents` 65 · L624 Fine print on the API 15 · L639 What is in
the box 58 · L697 Measured numbers 10 · L707/729/744/752 Tiers 1–4 22/15/8/35 · L787 On
units: bytes 22 · **L809 Reranking 107** · L916 Two stability promises 11 · L927 The four
laws 17 · L944–1018 Requirements, Prior art, Documentation, Contributing, License 74.

**The mass is setup, plus one optional adapter.** L256–558 — wiring through MCP server — is
**303 lines, 30% of the file**; add `smelt init` (20) and `smelt agents` (65) and
install/configuration prose is **388 lines, 38%**. The longest single section is **Reranking,
107 lines**, for a separately published opt-in package of which `bench/RESULTS.md` says there
are "**no `+rerank` rows here, and no claim about what reranking does to the expansion rate**".

**Where it restates a document that already owns the material (MEASURED):**

| README section                                                                        | Lines | Already owned by                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reranking (L809–915)                                                                  |   107 | `packages/rerank-voyage/README.md` (134 lines) — same config JSON, same `VOYAGE_API_KEY`, same adapter contract                                                                                         |
| Wiring / hooks / MCP (L256–558)                                                       |   303 | `packages/mcp/README.md` §"Wiring it into a harness" (L55–115: Claude Code, Codex, Grok, opencode). `claude mcp add smelt -- npx @smeltjs/mcp` appears at README L552 _and_ `packages/mcp/README.md:68` |
| What is in the box (L639–696)                                                         |    58 | `docs/ARCHITECTURE.md` §"The subsystems" (L316–1194)                                                                                                                                                    |
| The library + Fine print (L216–255, 624–638)                                          |    55 | `packages/core/README.md` (65 lines) and `docs/ARCHITECTURE.md` §"The consumer contract" (L1243–1361)                                                                                                   |
| Tier 1–4 narrative (L707–786)                                                         |    80 | `packages/core/bench/RESULTS.md` — the append-only rows, with units and caveats                                                                                                                         |
| Four laws (L927–943) · On units: bytes (L787–808) · Two stability promises (L916–926) |    50 | `docs/ARCHITECTURE.md` §"The four laws…" (L28–155) — also stated in full in `llms.txt` — plus §Decision 8 / `CONTEXT.md` and §"The consumer contract"                                                   |

**~653 lines — 64% of the README — restate text a sibling document already owns.**

## 5. Law 4 versus the marketing hero

`docs/ARCHITECTURE.md:135` — "**Law 4 — claim no number that has not been measured.
Absolute.** Not in the README, not in a doc comment, not in a commit message, not in a
tweet" — its stated origin (L140–141) being the founding pitch's unsupported "80–94% token
reduction" and "90%+ cache hit rate". It is enforced, not aspirational:
`packages/core/test/guards/readme-numbers.test.ts` "look[s] up [every Tier 1–4 figure the
README quotes] in `bench/RESULTS.md` by the corpus commit the README itself cites — never
one hardcoded here — and the top-of-file summary must restate the same three numbers as the
sections below it" (`docs/ARCHITECTURE.md:268`); the "Sixty seconds" captures are
regenerated from the real binary by that same guard.

**What it forbids** is the conventional hero: a round percentage, a "10× faster" claim, a
chart without a corpus. esbuild's first screen is exactly that shape — a bar-chart SVG
under "Our current build tools for the web are 10-100x slower than they could be", no
methodology on the page. **What it permits** ripgrep demonstrates: a **table** of timed
commands on the first screen carrying the exact invocation, line count, hardware ("an Intel
i9-12900K 5.2 GHz") and corpus (the Linux kernel tree at a named commit). A measured table
_is_ a hero, and it is the hero Law 4 allows; smelt's three-number table is that pattern
with stricter provenance. **Proposal: keep it, as the differentiator rather than an
apology.** Law 4 forces a _cited_ README, not a long one — nothing in it requires the
citation and its 80-line methodology narrative to share a file. That is what
`bench/RESULTS.md` is for, and the guard follows the link either way.

## 6. Synthesis — proposals (none is a decision; none changes a measured number)

**Proposal 1 — length target: 300 lines / ~2,500 words, hard ceiling 350.** Basis: the
measured band is 39–941 lines, the only peers above 500 spend 40%+ of it on per-distro
installation that smelt does not have (one `npm install -g`, one Homebrew tap), and the
closest peers by shape — a library with a CLI and a docs site — are Zod (218) and Bun's
non-index portion (93). 300 lines is 29% of today's file and still 1.4× Zod; the target is
Art of README's "as short as it can be without being any shorter".

**Proposal 2 — section order** (cognitive funnel, peer-conformant, Law 4 intact):

| #   | Section                                                                  | Lines | Note                                                                             |
| --- | ------------------------------------------------------------------------ | ----: | -------------------------------------------------------------------------------- |
| 1   | Hero: wordmark, one-liner, badges, nav row                               |   ~18 | unchanged; 4 badges is already under the peer max of 7                           |
| 2   | Measured, in three numbers                                               |   ~10 | **keep the table** (§5) — ripgrep's move, done stricter                          |
| 3   | What it does + marker example + before/after table                       |   ~30 | both tables stay; this is "show them what it looks like"                         |
| 4   | Sixty seconds, from a shell                                              |   ~45 | one transcript + one `smelt stats` block, both still guard-regenerated           |
| 5   | Install                                                                  |   ~12 | one line, alternates in `<details>`; 0/8 peers put install in the hero           |
| 6   | Setup in one command                                                     |   ~25 | `smelt setup --yes` + `smelt doctor`, then link out                              |
| 7   | For agents (MCP + skill)                                                 |   ~20 | tool names, one registration line, link `packages/mcp/README.md`                 |
| 8   | The library                                                              |   ~20 | one `smelt()`, one `reconstruct()`, link `packages/core/README.md`               |
| 9   | Measured numbers, tiers 1–4                                              |   ~45 | the four tables with provenance; methodology → `bench/RESULTS.md`                |
| 10  | What is in the box                                                       |   ~25 | bullets only, each linkified into ARCHITECTURE §The subsystems                   |
| 11  | The four laws · Prior art · Requirements · Docs · Contributing · License |   ~49 | four sentences + links; prior art stays — Art of README's "aggressively linkify" |

**Proposal 3 — the specific moves** (every destination already exists):

- **Wiring it into an agent harness** L256–558 (303) → per-harness registration to
  `packages/mcp/README.md` (which already has that section); `--scope`, updating and
  hooks-preset internals to `docs/ARCHITECTURE.md` §`smelt init` and `smelt.config.json`.
  README keeps §6 + §7 above (~45 lines). **`smelt init`** L196–215 folds into §6.
- **Reranking** L809–915 (107) → `packages/rerank-voyage/README.md`, which already
  documents all of it. README keeps ~6 lines: a seam, opt-in, forbidden as an import by the
  zero-network guard, and **no measured rows**.
- **`smelt agents`** L559–623 (65) → `docs/ARCHITECTURE.md` / `skills/smelt/SKILL.md`, ~8
  kept. **What is in the box** L639–696 (58) → bullets linkified into ARCHITECTURE
  §The subsystems, ~25 kept.
- **Fine print on the API**, **Two stability promises**, **On units: bytes** (48) →
  ARCHITECTURE §The consumer contract and §Decision 8 / `CONTEXT.md`; one linked sentence
  each. **Tier 2/3/4 prose** (~60 of 80) → `packages/core/bench/RESULTS.md`, which already
  carries the units paragraph and the unmeasured-rerank caveat verbatim.
- **Add no TOC** — GitHub generates one from headings, and only the three 500+-line peers
  hand-write one. But **consider one terminal capture**: 6/8 peers put an image above the
  fold, fd commits `doc/screencast.svg`, and Make a README names Asciinema. An
  asciinema-derived SVG of the `smelt` → marker → `smelt_retrieve` round trip is the one
  visual smelt lacks — with Art of README's warning: inline it in-repo, do not hotlink.

**Proposal 4 — guard the ceiling.** `readme-numbers.test.ts` already proves the README
cannot invent a number; a sibling assertion (README ≤ 350 lines, ≤ 8 badges) would make the
length target enforceable the way Law 4 is rather than advisory — at the cost of a new
guard, and guards cost `pnpm verify` time.

_Caveats: Art of README was read from a third-party copy because the canonical repo and its
author's account both 404 as of 2026-09-15 — its quotes are secondhand; readme.so's block
list is its repo's template, not the live editor UI; all peer counts are point-in-time reads
of the named default branch on 2026-09-15 and will drift. Every guidance claim in §1–§2 is
CLAIMED — none of those sources publishes a measurement behind its advice; the only MEASURED
material here is §3 and §4._
