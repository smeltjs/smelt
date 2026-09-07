# Peer tools survey — context optimizers for coding agents, 2026-09

Fourth note in the `docs/research/` convention (see `2026-09-02-agent-enforcement.md` for
its start). Surveyed 2026-09-06 against **live primary sources only** — every repo, docs
page, and commits page below was fetched the same day (retrieval date noted per source;
where a figure is a star count or commit count it is what the page rendered on that date).
Feeds the README prior-art section (parts of which now under-describe Headroom — §1), the
positioning claims in "What smelt actually adds", and the v2 planning conversation.
Following house Law 4 discipline, every number is labelled **MEASURED** (basis stated) or
**CLAIMED** (vendor's own words, basis unstated or self-reported) — and self-reported vs
peer-reviewed is flagged.

Decisions this survey should feed (not made here): update the README's Headroom credit to
its current shape; adopt a llmtrim-style live A/B harness before any tier-2/3 number lands
in `bench/RESULTS.md`; consider a per-command filter table (rtk) and SWE-bench-instance
corpus cases (claw-compactor). See Synthesis.

---

## Verification status

| Source                                                             | Status (2026-09-06)                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| headroomlabs-ai/headroom README + benchmarks doc                   | Verified live ([repo](https://github.com/headroomlabs-ai/headroom), [benchmarks doc](https://docs.headroomlabs.ai/docs/benchmarks))                                                                                       |
| microsoft/LLMLingua README + commits page                          | Verified live ([repo](https://github.com/microsoft/LLMLingua), [commits](https://github.com/microsoft/LLMLingua/commits/main))                                                                                            |
| Aider repo-map blog + repomap docs + repo                          | Verified live ([blog 2023-10-22](https://aider.chat/2023/10/22/repomap.html), [docs](https://aider.chat/docs/repomap.html), [repo](https://github.com/Aider-AI/aider))                                                    |
| oraios/serena README + evaluation intro                            | Verified live ([repo](https://github.com/oraios/serena), [evaluation](https://oraios.github.io/serena/04-evaluation/000_evaluation-intro.html))                                                                           |
| fkiene/llmtrim README                                              | Verified live ([repo](https://github.com/fkiene/llmtrim))                                                                                                                                                                 |
| open-compress/claw-compactor README                                | Verified live ([repo](https://github.com/open-compress/claw-compactor))                                                                                                                                                   |
| rtk-ai/rtk README                                                  | Verified live ([repo](https://github.com/rtk-ai/rtk))                                                                                                                                                                     |
| yamadashy/repomix, mufeedvh/code2prompt, ast-grep, github/spec-kit | Verified live ([repomix](https://github.com/yamadashy/repomix), [code2prompt](https://github.com/mufeedvh/code2prompt), [ast-grep](https://github.com/ast-grep/ast-grep), [spec-kit](https://github.com/github/spec-kit)) |
| GitHub topics prompt-compression / context-engineering             | Verified live ([prompt-compression](https://github.com/topics/prompt-compression?o=desc&s=stars), [context-engineering](https://github.com/topics/context-engineering?o=desc&s=stars))                                    |
| **`agester`**                                                      | **Could not verify — 0 results** on GitHub repository search ([search](https://github.com/search?q=agester&type=repositories), retrieved 2026-09-06). No such tool found; treated as non-existent under that name.        |
| Compresr, Token Co                                                 | Secondhand only — cited in Headroom's own comparison table ([README](https://github.com/headroomlabs-ai/headroom#compared-to)) as hosted/non-local/non-reversible; not independently fetched.                             |
| Gitingest                                                          | Secondhand pointer from Repomix README; not fetched.                                                                                                                                                                      |
| OpenSpec, Graft, entroly, caveman, leanctx                         | Topic-page metadata + llmtrim's published head-to-head snapshots only; not independently fetched.                                                                                                                         |

## The landscape at a glance

All figures from the repos' own pages, retrieved 2026-09-06. "Reversible" = the model has a
way to get cut content back. "Offline posture" = what the tool itself does, distinct from
the LLM calls its host obviously makes.

| Tool                                                              |  Stars | Language/core               | Mechanism                                                                                                                            | Reversible?                                          | Offline posture                                                                                           | Numbers basis                                                            |
| ----------------------------------------------------------------- | -----: | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [Headroom](https://github.com/headroomlabs-ai/headroom)           |  69.1k | Rust core + Python + TS SDK | ContentRouter → SmartCrusher (JSON stats) / CodeCompressor (AST) / Kompress-v2-base (trained model); CacheAligner; proxy+library+MCP | Yes — CCR retrieve tool, **TTL-evicted**             | Compression local, but beacon telemetry **on by default**, TLS fetches (ONNX, HF model), daily PyPI check | Seeded reproducible bench + accuracy suite (self-reported, reproducible) |
| [rtk](https://github.com/rtk-ai/rtk)                              |  79.1k | Rust binary                 | Per-command output filters (100+ commands: git, cargo, pytest, docker, aws)                                                          | Partial — tee-on-failure saves full output to a path | Local; telemetry **opt-in** (off by default)                                                              | Honest self-report: "up to 90% of bash output", bytes/4 estimate         |
| [Serena](https://github.com/oraios/serena)                        |  28.9k | Python (uv)                 | LSP-backed symbol-level tools over MCP — replace reads, don't shrink them                                                            | n/a (nothing cut)                                    | Local language servers; JetBrains backend is paid                                                         | Agent-self-evaluation (no controlled numbers)                            |
| [Repomix](https://github.com/yamadashy/repomix)                   |  28.2k | Node/TypeScript             | Pack whole repo to one file; optional tree-sitter `--compress` (experimental)                                                        | No                                                   | Local CLI (web app packs remotely)                                                                        | None published                                                           |
| [LLMLingua](https://github.com/microsoft/LLMLingua)               |   6.6k | Python (torch)              | Small-LM perplexity pruning; LLMLingua-2 = GPT-4-distilled BERT token classifier                                                     | No (token dropping)                                  | Local inference but GPU-class deps; model downloads                                                       | **Peer-reviewed papers** (EMNLP'23, ACL'24)                              |
| [claw-compactor](https://github.com/open-compress/claw-compactor) |   2.0k | Python, zero deps           | 14-stage pipeline (AST, JSON sampling, simhash dedup, log/diff/search folding)                                                       | Yes — RewindStore, hash markers, **LRU eviction**    | Local; optional tiktoken/tree-sitter extras                                                               | Self-reported incl. ROUGE-L vs LLMLingua-2 + SWE-bench instances         |
| [llmtrim](https://github.com/fkiene/llmtrim)                      |    227 | Rust (MITM proxy)           | 10 stages: lossless log folding, BM25+ retrieval, tree-sitter skeletonization, TOON, output control; quality gate reverts bad cuts   | Partial — `recall` command, **RAM-only, 5h TTL**     | Local MITM proxy; prompts never touch disk; no keys stored                                                | **112 live A/B cases**, quality-scored, with CIs and reproduce commands  |
| [code2prompt](https://github.com/mufeedvh/code2prompt)            |   7.6k | Rust                        | Repo → single prompt, templates, token counting                                                                                      | No                                                   | Local                                                                                                     | None published                                                           |
| [ast-grep](https://github.com/ast-grep/ast-grep)                  |  15.8k | Rust                        | AST structural search/lint/rewrite (enabling tech, not a context optimizer)                                                          | n/a                                                  | Local                                                                                                     | n/a                                                                      |
| [spec-kit](https://github.com/github/spec-kit)                    | 133.7k | Python (uv)                 | Spec-driven development artifacts (spec/plan/tasks) for 30+ agents                                                                   | n/a                                                  | Local; bundles work offline                                                                               | None (process toolkit)                                                   |

---

## 1. Headroom — the closest peer, and how it has grown

Source: [README](https://github.com/headroomlabs-ai/headroom) and
[benchmarks doc](https://docs.headroomlabs.ai/docs/benchmarks), both retrieved 2026-09-06.
69.1k stars, 5.4k forks, 2,734 commits, Apache-2.0. (The project began at
`chopratejas/headroom` — llmtrim's README still links that path — and now lives under
`headroomlabs-ai` with a company behind it; a managed/teams offering is offered in the
README.)

**smelt's README credit is now stale.** smelt describes Headroom as "Python, same core
shape: local store, a retrieve tool, BM25." Today it is a **Rust core** (maturin build,
wheels via PyPI `headroom-ai`; npm `headroom-ai` ships a TypeScript **SDK library only**,
no CLI) plus Docker, a proxy, an agent-wrap fleet, a cross-agent memory, failure mining,
and output-token shaping. BM25 survives as the non-ONNX relevance fallback. The "same core
shape" (store + retrieve tool) still holds; the scope no longer does.

**Mechanism** ([README, "How it works"](https://github.com/headroomlabs-ai/headroom#how-it-works)):
`CacheAligner → ContentRouter → CCR`, where ContentRouter picks per content type —
**SmartCrusher** (JSON: keeps error items, statistical outliers, first/last boundaries,
"selected from field-variance statistics rather than a keyword list"),
**CodeCompressor** (AST-aware, Python/JS-TS/Go/Rust/Java/C-C++/Perl), and
**Kompress-v2-base** — a **trained HuggingFace model** for prose, "trained on agentic
traces". Note what that means against smelt's Law 2: for text, a model's opinion is now in
Headroom's cut path (deterministic for JSON/code, learned for prose). Also: image
compression via a trained ML router (40–90% CLAIMED), and "live-zone compression" — only
new bytes are compressed so the provider KV-cache prefix survives.

**The 21–57% claim, exact wording and basis** ([README, "Proof"](https://github.com/headroomlabs-ai/headroom#proof),
retrieved 2026-09-06) — this is the number smelt's README cites, and it survives intact:

> "Four scenarios built from real MCP server output formats, measured with the provider
> tokenizer and the shipped `compress()`. Seeded and offline, so you get the same numbers
> we did: `uv run python benchmarks/index_proof_table.py --seed 20260902`"

| Scenario               | Before |  After | Saved |
| ---------------------- | -----: | -----: | ----: |
| Code search (100 hits) | 17,199 | 13,597 |   21% |
| SRE incident debugging | 55,957 | 24,340 |   57% |
| Codebase exploration   | 58,801 | 33,895 |   42% |
| GitHub issue triage    | 46,067 | 32,429 |   30% |

MEASURED (their machine, provider tokenizer, seeded and reproducible — the same honesty
class as smelt's `pnpm bench`). They also state the boundary conditions: "Savings scale
with how repetitive the payload is… prose and already-dense output compress very little."

**Accuracy suite** (MEASURED, N=100, self-run, `python -m headroom.evals suite --tier 1`):
GSM8K 0.870→0.870 (±0.000); TruthfulQA 0.530→0.560 with the explicit note that "a delta of
±0.03 falls inside the confidence interval"; SQuAD v2 97% at 19% compression; BFCL 97% at
32% compression. This is Law-4-grade candour about what an eval can and cannot show.

**Benchmarks doc** ([retrieved 2026-09-06](https://docs.headroomlabs.ai/docs/benchmarks),
pinned to Headroom 0.37.0, Apple M-series, 10 warm iterations): JSON arrays 48–49%, logs
53–54%, documentation text 92%, **Python source 0.0% — "Zero compression is intentional"**
(code passes through "to preserve correctness"); mixed total 56%; HTML extraction F1 0.919
(recall 0.985) at 94.8% compression on the Scrapinghub benchmark; SmartCrusher 38.2% with
the injected error entry verified to survive. Latency p50 0.20–1.4 ms. There is an
unresolved tension between the README's CodeCompressor claims and this table's 0% code row
(possibly version drift between the two documents) — cited as the owner states it, both
linked. And one more honesty marker worth copying: for QA-accuracy-preservation, "No
committed result artifact for it exists in this repo, so no number is published here."

**Reversibility and network posture.** CCR is reversible with a retrieve tool — but
"originals stay retrievable through CCR **for the configured TTL**" (README, "When to use
· when to skip"): eviction by design, where smelt's store never evicts. Compression runs
locally and "no prompt or file content is sent anywhere to be compressed", **but**: an
anonymous telemetry beacon is **on by default** (ratios, counters, provider/model IDs,
OS/arch; `HEADROOM_BEACON=off` to disable); two runtime assets are fetched over TLS
(`cdn.pyke.io` for ONNX Runtime, `huggingface.co` for kompress-base); the proxy checks
PyPI daily. Zero-network in the smelt sense it is not, and does not claim to be.

**What Headroom does better than smelt:** speed (0.2–1.4 ms p50 Rust vs smelt's measured
80–350 ms node+wasm, per `2026-09-02-agent-enforcement.md` §5); breadth of content types
(JSON statistics, images, conversation history, output tokens); deployment surface (proxy
wraps 16+ agents with zero code changes — Claude Code, Codex, Grok, Copilot CLI/VS Code,
Cursor, Aider, opencode, Cline, Continue, Goose, OpenHands, Vibe, OMP, OpenClaw, Kimi,
ZCode, per the README's compatibility table); the **output side** (verbosity steering +
effort routing, with estimated-vs-measured labelling and a 10%-holdout control for a
measured figure); accuracy evals; a company and a managed offering; 69.1k stars of
adoption.

**What it lacks that smelt has:** a zero-network guarantee (beacon on by default, TLS
asset fetches, update checks — none guard-enforced); named-rule explainability for every
elision (no per-elision marker contract is documented; a trained model decides prose
cuts); no-eviction reversibility (TTL); a counted expansion-rate metric surfaced as the
product-level honest signal (its stats are savings-shaped, not did-the-model-ask-it-back
shaped); refusal-over-approximation for unsupported languages is not documented as a
contract.

## 2. LLMLingua family — the peer-reviewed research line, now quiet

Source: [README](https://github.com/microsoft/LLMLingua) and
[commits](https://github.com/microsoft/LLMLingua/commits/main), retrieved 2026-09-06.
6.6k stars, 422 forks, 85 commits, MIT.

- **Mechanism.** LLMLingua (EMNLP'23): a compact LM (GPT-2-small … LLaMA-7B) scores token
  perplexity under a coarse-then-fine iterative compression; LongLLMLingua (ACL'24) adds
  question-conditioned ranking and document reordering against "lost in the middle";
  LLMLingua-2 (ACL'24 Findings) distills GPT-4 token-keep labels into a BERT/xlm-roberta
  classifier — 3–6× faster than LLMLingua, task-agnostic. SecurityLingua (CoLM 2025)
  reuses compression as a jailbreak guardrail.
- **Claims and basis** — the one line in this survey that is **peer-reviewed**: "up to 20×
  compression with minimal performance loss" (repo tagline, papers behind each figure);
  LongLLMLingua "improving RAG performance by up to 21.4% using only 1/4 of the tokens"
  (paper claim, on the papers' benchmarks — GSM8K, TruthfulQA-style QA, MeetingBank,
  summarization). smelt's README statement "its numbers are on non-code benchmarks" holds:
  the repo ships a `Code.ipynb` example but no code-task evaluation.
- **Adoption.** Integrated into LangChain, LlamaIndex, and Microsoft Prompt flow (README
  news items) — the citation anchor everyone (including Headroom's SmartCrusher-less
  world and claw-compactor's comparison table) benchmarks against.
- **Activity.** Last commit to main **2025-10-28** (SecurityLingua merge, verified on the
  commits page) — roughly ten months quiet as of this survey.
- **Reversibility/explainability/offline:** token dropping is irreversible and unmarked
  (which tokens vanished is a model decision, no rule names); local inference but
  torch/transformers-class dependencies and model downloads.
- **vs smelt:** better — peer-reviewed evidence, learned relevance that genuinely works on
  prose. Lacks — everything smelt is: reversible, explained, counted, byte-honest,
  code-structural. LLMLingua is the reason smelt's "never a model's opinion" law has a
  real cost on generic text; it is also the line LLMLingua-2-js (32★, topic page) and
  leanctx (316★) commercialize.

## 3. Aider's repo-map — the mechanism smelt's map is modelled on

Sources: [blog, 2023-10-22](https://aider.chat/2023/10/22/repomap.html), current
[repomap docs](https://aider.chat/docs/repomap.html), and
[repo](https://github.com/Aider-AI/aider) (48.8k stars, 4.9k forks, 13,138 commits,
Apache-2.0), all retrieved 2026-09-06.

**Mechanism** (blog): tree-sitter parses every file into def/ref tags via modified
`tags.scm` queries; a graph is built with files as nodes and references as edges; a graph
ranking algorithm (PageRank) scores identifiers; the map ships only the highest-ranked
signature lines that fit `--map-tokens` (default **1k tokens**). It replaced an earlier
ctags map. Aider now supports 100+ languages via tree-sitter-language-pack (repo README;
recordings index).

**In-product use** (docs): the map is sent **with every change request**, and "aider
adjusts the size of the repo map dynamically based on the state of the chat. It will
usually stay within that setting's value. But it does expand the repo map significantly at
times, especially when no files have been added to the chat." Relevance is chat-state
aware — files added to the chat boost their neighbourhood. Two honest deltas vs smelt's
clone: aider's map budget is a soft target it may exceed (smelt: "fits itself to the
budget by construction"), and aider's ranking is personalized to the current chat (smelt's
is deterministic and per-symbol-explained, not chat-conditioned).

**Published evaluation: none.** The blog post is qualitative — benefits are argued
("GPT can see… it can probably figure out…"), no measured improvement over no-map is
published anywhere we could find. Aider's measured numbers live elsewhere (its edit
leaderboards) and do not isolate the map.

**vs smelt:** better — battle-tested at 48.8k-star scale, chat-conditioned relevance,
cache-friendly incremental maps. Lacks — no reversibility story (a map is a summary, not a
recoverable elision), no per-symbol "why it ranked" explanation, budget is advisory.

## 4. Serena — give the agent better tools, not less context

Sources: [repo](https://github.com/oraios/serena) and
[evaluation intro](https://oraios.github.io/serena/04-evaluation/000_evaluation-intro.html),
retrieved 2026-09-06. 28.9k stars, 2.0k forks, 3,333 commits, MIT. Python/uv
(`uv tool install -p 3.13 serena-agent`).

Serena answers smelt's question with the opposite move: **never send the blob at all**.
LSP-backed symbol-level MCP tools (find_symbol, find_referencing_symbols, replace_symbol_body,
insert_before/after, …) over 40+ languages, plus a memory system; a paid JetBrains-plugin
backend adds move/inline/propagate-deletions and a debugging REPL. "Agent-first tool
design… distinguishes it from approaches that rely on low-level concepts like line numbers
or primitive search patterns."

**Evaluation** — honest about what it is: agents evaluate themselves. ~20 routine tasks
per agent across navigation/small-edit/large-edit/cross-file-refactor/workflow areas, run
with both Serena's tools and built-ins, recording call counts, payload sizes, prerequisite
steps; findings must be classified (a) adds capability / (b) no improvement / (c) out of
scope — "a structure that requires reporting negative and neutral results, not just
positive ones." Five result sets published (Claude Code Opus 4.6, Codex GPT-5.4, Copilot
CLI GPT-5.4, Claude Code GLM 5.1, Junie Opus 4.6). **Self-reported, not a controlled
benchmark** — model-quote-shaped evidence, but reproducible via published prompts.

**Adoption signal:** Headroom **installs Serena by default** when wrapping an agent
(`--code-memory`, README "Get started") and recommends it as "our recommended companion".
Serena is what the proxy world ships for navigation while it compresses everything else.

**vs smelt:** better — solves retrieval _at the source_ (nothing to shrink, nothing to
retrieve back, no over-pruning risk at all), refactoring-grade precision, huge adoption.
Lacks — everything smelt does for the blobs that still must flow (logs, traces, grep
output, the 40 kB file a model insists on reading whole, AGENTS.md measurement); LSP
servers are per-language processes to configure; no byte budgets, no elision contract.

## 5. llmtrim — the most Law-4-honest proxy peer

Source: [README](https://github.com/fkiene/llmtrim), retrieved 2026-09-06. 227 stars, 23
forks, 671 commits, MPL-2.0. Rust; local MITM proxy (name-constrained CA) + CLI + MCP
server + libraries in Rust/Python/Ruby/Kotlin/Swift/JS-WASM.

**Mechanism:** ten compressor stages, each a "deterministic implementation of published
research" (BM25+/RM3/TextTiling/MMR for lexical retrieval; tree-sitter skeletonization
over 14 languages keeping relevant bodies, rest to signatures; lossless Drain-style log
template folding; TOON/CSV serialization of record arrays; tool-schema trimming with
cache-prefix stability; output control via Chain-of-Draft-style directives). A `safe`
preset is lossless-only; `auto` quality-gates: "each stage is re-measured with the
provider's real tokenizer and **undone if it does not save tokens**," and `quality_gate`
"revert[s] any lossy cut whose query-relevant coverage drops too far." Nothing under a
`cache_control` marker is rewritten.

**Numbers** (MEASURED, live A/B, reproduce commands published): "Every case is sent twice,
once original and once compressed, then both answers are scored and billed at real rates…
112 live A/B cases": input 71,031→49,062 tokens (**−31%**), output 25,843→6,628 (**−74%**),
round-trip cost $0.0365→$0.0126 (**−66%**), answer quality 78.9%→82.2%. Named benchmarks
(paired 95% CI, n=20 unless noted): TruthfulQA 75→75, SQuAD v2 84→84, BFCL 95→95, and the
disclosed regression — GSM8K 100→92 (−8pp) traded for −71% cost on that preset, with the
caveat "measure per workload before enabling its reasoning preset." Their head-to-heads
(vs Headroom tie at 24–25% but 12-vs-2 output truncations; vs leanctx/LLMLingua-2 "18%
lower" quality; vs entroly "42% lower") are linked as committed snapshots. A "Known
limits" section states what the tool does _not_ measure (output savings live; approximate
Anthropic/Gemini token counts).

**Reversibility:** partial and explicitly bounded — shaped first-arrival tool results are
recoverable via `llmtrim recall r_…`, held **in daemon RAM for five hours**, gone on
restart; "prompts never touch disk."

**vs smelt:** better — the measurement culture (live A/B with quality scores is exactly
the tier-3-shaped evidence smelt has not yet run), the quality gate that reverts cuts,
~5 ms/call, input+output coverage, cache-prefix discipline in-product. Lacks — persistent
no-eviction reversibility (RAM TTL vs smelt's content-addressed directory store), per-
elision named-rule explanations, a zero-network invariant (it is a proxy by design;
locally it stores nothing, but the request stream inherently transits it), structural
refusal-over-downgrade is not a documented contract.

## 6. claw-compactor — the most smelt-shaped Python peer

Source: [README](https://github.com/open-compress/claw-compactor), retrieved 2026-09-06.
2.0k stars, 182 forks, 68 commits (young), MIT, Python 3.9+, **zero required
dependencies** (tiktoken and tree-sitter-language-pack optional). Topic page shows "Updated
Apr 1, 2026" — possibly going stale; one open issue.

**Mechanism:** a 14-stage "Fusion Pipeline" over an immutable context: KV-cache alignment
(QuantumLock), content/language auto-detection (Cortex, 16 languages), base64, path/RLE
shorthand, simhash dedup, JSON statistical sampling with schema discovery and error
preservation (Ionizer), log folding, search-result dedup, diff folding, import-block
collapse, tree-sitter AST compression "never shortens identifiers" with safe regex
fallback (Neurosyntax), optional ML token classification with stopword fallback (Nexus),
format optimization, NL abbreviation (text only). Gate-before-compress; every stage named.

**Reversibility:** RewindStore, "a hash-addressed **LRU**" — the model calls a Rewind
tool with markers like `[rewind:abc123…]`. LRU means eviction; smelt's store never
forgets. Markers carry a hash, not a rule name + human sentence.

**Numbers** (all CLAIMED/self-reported, methodology not published beyond the README):
15–82% depending on content; weighted 36.3% on their six-content-type table; SWE-bench
instance tests (django/sympy/scikit-learn) at 11.8–19.1%; ROUGE-L fidelity 0.653 @ 0.3
rate and 0.723 @ 0.5 vs LLMLingua-2's 0.346/0.570 — their own measurement, their own
harness ("<50 ms", "1600+ tests", "zero LLM inference cost"). Adopted by OpenClaw (built-in
skill) and OpenCompress (production API).

**vs smelt:** better — zero-dependency install, per-content-type stage fleet breadth,
SWE-bench-derived corpus cases, an established distribution channel (OpenClaw). Lacks —
counted retrieval metric, no-eviction store, per-elision explainability contract, any
guard/mutation honesty machinery, and published methodology for its numbers.

## 7. rtk — the installed base for "shrink tool output"

Source: [README](https://github.com/rtk-ai/rtk), retrieved 2026-09-06. **79.1k stars**,
5.0k forks, 1,736 commits, Apache-2.0, single Rust binary (brew/cargo/install script).

rtk rewrites agent shell commands (`git status` → `rtk git status`) via PreToolUse hooks
across **17 agents** and filters 100+ commands: failures-only test output, grouped diffs,
compact `git push` → `ok main`, signature reading (`rtk read -l aggressive`), deduped
logs. Not a blob compressor — a per-command filter fleet.

**Its honesty section is exemplary** and worth stealing the tone of: "RTK cuts up to 90%
of the bash output your agent reads. That is what RTK measures, **and it is not the same
as cutting your bill by 90%**" — with the dilution chain spelled out, and "token counts…
estimated as `bytes / 4` — RTK ships no tokenizer, so the percentages are reliable but
the absolute token numbers are approximate." Telemetry is **opt-in** (off by default,
GDPR-consent framed) — the mirror image of Headroom's on-by-default beacon.
**Reversibility:** tee-on-failure — when a command fails, the full output is saved to a
path shown in the compact output; `rtk curl` truncates and saves. A file path, not a
retrieve tool; not counted.

**vs smelt:** better — distribution (79.1k stars, brew formula), per-command semantics
(smelt's lexical planner is content-blind to _which_ command produced the blob), <10 ms.
Lacks — reversibility-as-contract, explainability per elision, budgets, the structural
planner, any measured quality evidence.

## 8. Repo-packers, spec toolkits, and adjacent tooling

All retrieved 2026-09-06. These prepare context but do not optimize it against a budget —
they differ from smelt by having no relevance decision to explain and nothing to reverse.

- **[Repomix](https://github.com/yamadashy/repomix)** — 28.2k★, Node/TS, packs a repo to
  one XML/MD/JSON/plain file; token counting (o200k default); `--compress` runs
  tree-sitter signature extraction, self-labelled "an experimental feature"; per-file
  inclusion levels (`directoryStructureOnly` etc.); **`--token-budget` fails non-zero when
  output exceeds N tokens** (a guard, convergent with smelt's over-budget exit code — but
  the output is still generated, not refitted); Secretlint scanning; MCP mode with
  `--sandbox`; watch mode; website packs remote repos (remote processing). JSNation Open
  Source Awards 2025 nominee. No reversibility, no ranking.
- **[code2prompt](https://github.com/mufeedvh/code2prompt)** — 7.6k★, Rust (TUI + CLI +
  Python SDK + MCP), repo→prompt with Handlebars templates, token tracking, git
  integration. A packer; no compression contract.
- **[Gitingest](https://github.com/cyclotruc/gitingest)** — Python-ecosystem equivalent;
  secondhand (Repomix README pointer), not fetched.
- **[github/spec-kit](https://github.com/github/spec-kit)** — 133.7k★, MIT, Python/uv
  `specify-cli`, **v1.0.0 shipped ~2026-08-21** ("Spec Kit Turns One — and Ships 1.0.0").
  Spec-driven development: constitution/specify/plan/tasks/implement/converge slash
  commands across 30+ agents; extensions/presets/bundles resolved offline. It is context
  _preparation_ — writing the artifacts that make big context unnecessary — not
  compression. (The SDD category is large: OpenSpec 67.4k★ per topic-page metadata,
  secondhand.)
- **[ast-grep](https://github.com/ast-grep/ast-grep)** — 15.8k★, Rust, AST
  search/lint/rewrite. Enabling technology adjacent to smelt's structural planner (both
  tree-sitter); it can _find_ focused context but has no budget, elision, or retrieval
  semantics.
- **Serena-adjacent code-graph MCPs**: Graft (5.7k★ per topic-page metadata, secondhand)
  — tree-sitter code-graph context server for coding agents.

## 9. Long tail from the topic sweep

From the [prompt-compression topic](https://github.com/topics/prompt-compression?o=desc&s=stars)
(137 repos) and [context-engineering topic](https://github.com/topics/context-engineering?o=desc&s=stars)
(3,072 repos), retrieved 2026-09-06; star counts and descriptions are the topic pages'
own. None individually verified beyond that.

| Tool                                                                           | Stars | Note                                                                                                      |
| ------------------------------------------------------------------------------ | ----: | --------------------------------------------------------------------------------------------------------- |
| [headroom-desktop](https://github.com/gglucass/headroom-desktop)               |   536 | Third-party macOS GUI for Headroom ("cut Claude Code and Codex token costs by ~50%" — CLAIMED)            |
| [leanctx](https://github.com/jia-gao/leanctx)                                  |   316 | LLMLingua-2 drop-in SDK, "40-60%" CLAIMED; measured by llmtrim at ❌ "18% lower" quality at 26% reduction |
| [llmtrim](https://github.com/fkiene/llmtrim)                                   |   227 | Covered in §5                                                                                             |
| [terseai](https://github.com/Terse-AI/terseai)                                 |    33 | macOS/Windows monitor + "40-70% on-device prompt compression" CLAIMED                                     |
| [llmlingua-2-js](https://github.com/atjsh/llmlingua-2-js)                      |    32 | Experimental JS port of LLMLingua-2                                                                       |
| [claude-rolling-context](https://github.com/NodeNestor/claude-rolling-context) |    31 | Rolling history compression as a Claude Code plugin (harness-native shaped; another agent covers those)   |
| [foveance](https://github.com/Aimaghsoodi/foveance)                            |    21 | "Lossless token-optimization codec," up to 82% CLAIMED                                                    |
| [clipforge-PAKT](https://github.com/sriinnu/clipforge-PAKT)                    |    20 | Lossless-first compression for JSON/YAML/CSV/MD; library+CLI+MCP                                          |
| [exprompt](https://github.com/bladysh/exprompt)                                |    15 | Go "Reverse T9" prompt compressor                                                                         |
| [cavewoman](https://github.com/danielle34/cavewoman)                           |    13 | Evaluation protocol scoring input/output compression in dollars+accuracy across 7 models, 5 benchmarks    |

**Vendor libraries in this space:** Microsoft's is LLMLingua (§2). Nothing from
Anthropic/OpenAI/Google surfaced in either topic sweep as an _open library_ for local
context optimization — OpenAI's compaction exists only as a provider-native harness
feature (per Headroom's own comparison table, which marks it "not reversible"), and the
harness-native compaction landscape is another agent's brief.

## 10. The three differentiators, re-checked against 2026 peers

smelt's README claims its only additions over prior art are: (1) the zero-network
guarantee, (2) every elision explaining itself in named-rule terms, (3) mutation-tested
honesty machinery. Checked against every peer above, 2026-09-06:

1. **Zero network (import-graph-enforced).** **Still unmatched — and now contrastable.**
   No peer claims it; several affirmatively network: Headroom (beacon on by default, TLS
   asset fetches, daily PyPI check), LLMLingua/leanctx (model downloads), Repomix web
   (remote packing). The closest in spirit is rtk (telemetry opt-in, no model fetches)
   and claw-compactor (zero required deps) — but neither states or enforces an invariant
   over the code paths. llmtrim is a proxy by definition.
2. **Named-rule explainability per elision.** **Still unmatched as a per-elision
   contract.** claw-compactor names its _stages_ and emits hash-only markers; Headroom
   documents no marker contract; rtk's filters are per-command but emit no per-elision
   reasons; LLMLingua's cuts are unmarked model decisions. smelt's "a named rule and a
   sentence a human can read in a diff" remains unique — and Headroom's Kompress model
   moves it _further_ away for prose.
3. **Honesty machinery.** **Partially matched in culture, not in machinery.** Headroom
   now practises Law-4-grade candour where it has data (CI note on TruthfulQA, "no
   committed result artifact, so no number is published", estimated-vs-measured output
   savings with a holdout control); llmtrim's live A/B with disclosed regressions
   (GSM8K −8pp) is stronger evidence than smelt has yet produced; rtk's savings-dilution
   disclaimer is exemplary. But **nobody counts retrievals as the headline metric** —
   no peer reports an expansion-rate analogue (did the model ask for the cut bytes
   back?), and no peer mutation-tests its guarantees. That combination remains smelt's.

---

## Synthesis

**(a) Where smelt genuinely leads today.** The enforced zero-network invariant (unique —
peers either network or merely don't-mention); per-elision named-rule explainability as a
wire-format contract (unique; closest is claw-compactor's named stages with hash-only
markers); no-eviction, no-"reversible, usually" persistence (Headroom's CCR has a TTL,
llmtrim's recall lives 5 hours in RAM, claw-compactor's RewindStore is an LRU); and the
counted expansion-rate feedback loop, which no peer surfaces as a metric at all. The
byte-unit argument (local, tokenizer-independent, model-portable) also remains
differentiated — rtk concedes it must estimate tokens as bytes/4; Headroom measures in
provider tokens and needs LiteLLM for dollars.

**(b) Where smelt is behind.** Adoption (69k–134k-star peers vs a 0.x library); speed
(0.2–1.4 ms Rust vs 80–350 ms node+wasm, measured in this repo's own notes); measured
evidence end-to-end (llmtrim has 112 quality-scored live A/B cases; Headroom has an
accuracy suite and a seeded reproducible bench; smelt has six byte-reduction cases and
explicitly unrun tier-2/3 — the README is honest about this, but honesty is not
evidence); content breadth (JSON statistics, images, history, output tokens are all
covered by proxies, none by smelt); and the proxy deployment mode (zero-code-change wrap
of 16–17 agents vs smelt's hooks preset, verified on 2 harnesses, experimental on 6).

**(c) Peer moves to steal.** From **llmtrim**: the send-twice/score-both/bill-both A/B
harness design (the right instrument for smelt's tier-2/3 rows — run it before claiming
any token or expansion number), and the revert-a-cut-that-doesn't-pay quality gate as a
planner seam. From **Headroom**: seeded reproducible benchmark scripts
(`--seed 20260902`), the estimated-vs-measured label with a holdout control, and
"live-zone" cache-safety as an explicit, documented property. From **rtk**: per-command
recognition feeding `--focus` defaults (a pytest blob, a cargo blob, a `git diff` blob
each get the right focus for free), and the tee-on-failure affordance as a second
retrieval front door. From **claw-compactor**: SWE-bench-instance files as bench corpus
cases (real repo code, honest mid-band reductions). From **Serena/Headroom**: position
Serena as the documented companion (navigation) to smelt (shrinkage of what still gets
read) rather than pretending the LSP approach doesn't exist. Also update the README's
Headroom credit — it is now a Rust-core proxy platform with a trained compressor, not
"Python, same core shape."

**(d) Peers that are declining or irrelevant.** **LLMLingua core repo** — ten months
quiet, GPU-class, irreversible, non-code benchmarks; it remains the field's citation
anchor (keep crediting the papers) but is not a living product competitor. **Hosted
compressors** (Compresr, Token Co — per Headroom's table, secondhand) — not local, not
reversible; irrelevant to smelt's stance. **Repo-packers** (Repomix, code2prompt,
Gitingest) — different problem; their `--compress` modes are experimental, drop bodies
without retrieval, and Repomix's `--token-budget` guard is the only convergent detail.
**Spec toolkits** (spec-kit, OpenSpec) — adjacent category (avoid the context instead of
optimizing it); cite, don't track. **Long-tail micro codecs** (terseai, foveance,
clipforge, exprompt, entroly) — sub-350-star, lossy, and two of them carry llmtrim-measured
quality regressions; not worth tracking individually. **`agester`** — could not be
verified to exist (zero GitHub search results, 2026-09-06).

_Caveats carried forward: star/commit counts are point-in-time page renders (2026-09-06);
Headroom's README-vs-bench-doc tension on code compression is cited as the owners state
it; Serena's evaluation is agent-self-report by design; every "CLAIMED" label above means
the vendor's words with no published methodology — Law 4 applies to reading this file
too._
