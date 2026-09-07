# smelt vs its peers — positioning and the road to valuable

Fifth note in the `docs/research/` convention. Synthesis of the two surveys taken
2026-09-06 — [`2026-09-06-peer-tools-survey.md`](2026-09-06-peer-tools-survey.md)
(peer tools: Headroom, llmtrim, claw-compactor, rtk, Serena, LLMLingua, packers) and
[`2026-09-06-platform-context-landscape.md`](2026-09-06-platform-context-landscape.md)
(harness-native compaction, vendor context APIs, caching economics, user pain signals) —
both against live primary sources, cited there. This note adds no new sources; it draws
the comparison and proposes priorities. Law 4 applies: numbers below are MEASURED or
CLAIMED as their owners state them, and the roadmap items are **proposals feeding a
decision, not decisions**.

---

## 1. The field, one table

smelt's four properties that matter to a buyer, checked against every peer and platform
surveyed (detail and sources in the two notes above):

| Property                                  | smelt                            | Headroom (69.1k★)             | llmtrim (227★)         | claw-compactor (2.0k★)    | rtk (79.1k★)          | Serena (28.9k★) | Platform-native (Claude Code et al.)               |
| ----------------------------------------- | -------------------------------- | ----------------------------- | ---------------------- | ------------------------- | --------------------- | --------------- | -------------------------------------------------- |
| Zero network, enforced invariant          | **yes (guard)**                  | no — beacon on by default     | no — proxy by design   | claims local, unenforced  | local, telemetry off  | local LSPs      | n/a                                                |
| Per-elision named-rule explainability     | **yes (wire contract)**          | no (trained model, prose)     | no                     | hash-only markers         | per-command, no rule  | n/a             | no — bare placeholder (Anthropic)                  |
| Reversibility without eviction            | **yes (no-evict store)**         | TTL-evicted                   | 5 h in RAM             | LRU                       | tee-to-file           | n/a             | **no — irreversible everywhere**                   |
| Retrievals counted (over-pruning visible) | **yes (expansion rate)**         | no                            | no                     | no                        | no                    | n/a             | no — "data preserved but UI inaccessible" (#27242) |
| Structure-aware (tree-sitter)             | yes, 15 langs, refuses downgrade | yes (code deterministic)      | yes, 14 langs          | yes, 16 langs             | no                    | LSP, 40+ langs  | no — summary or line truncation                    |
| Quality evidence                          | 6 byte cases                     | accuracy suite + seeded bench | **112 live A/B cases** | CLAIMED, SWE-bench corpus | none                  | agent self-eval | none                                               |
| Latency (owner-measured)                  | 80–350 ms (our note)             | 0.2–1.4 ms p50                | ~5 ms                  | "<50 ms" CLAIMED          | <10 ms                | n/a             | native                                             |
| Install surface                           | npm/brew/hooks/MCP               | proxy wraps 16+ agents        | proxy + MCP            | zero-dep Python           | brew/cargo, 17 agents | uv + MCP        | built in                                           |

Read plainly: **smelt holds every property it advertises — and only smelt holds all four
rows no one else has.** The competition has converged on honesty _culture_ (llmtrim's
disclosed GSM8K regression, Headroom's "no artifact → no number", rtk's savings-dilution
disclaimer) while none of them counts retrievals, none guarantees zero network, and none
explains an individual cut. Meanwhile the platforms have absorbed compaction _shallowly_:
every native mechanism is lossy, irreversible, opaque (OpenAI's is encrypted by design),
uncounted — and reliably the top complaint cluster in their own trackers.

## 2. What the surveys change about smelt's story

1. **The README's Headroom credit is stale, and the truth flatters smelt.** Headroom is
   now a Rust-core platform with a trained HF model in the prose cut path, beacon
   telemetry on by default, TLS asset fetches, and TTL-evicted retrieval. smelt's "same
   core shape" line under-describes both the threat and the contrast. The honest update
   makes smelt's three laws _more_ differentiated, not less.
2. **"Library, not a proxy" is now an economics claim, not a philosophy.** With cache
   reads at 0.1× and writes at 1.25×, an ingress-time k× reduction saves (1−1/k) of a
   blob's attributable cost regardless of cache warmth — but rewriting an already-cached
   prefix is the one operation that costs more than it saves (vendor-documented). A
   transcript-rewriting proxy is precisely the punished shape; smelt's hook design
   (transform before first send) is cache-safe by construction and should say so loudly.
3. **The expansion rate is an economic instrument, not honesty theatre.** Each retrieval
   re-enters the transcript at the uncached write rate; break-even is ≈1.5 retrieves per
   elided blob in the worked example. No peer and no platform measures this at all — and
   it is the exact number that decides whether compression paid.
4. **Users are independently asking for smelt.** claude-code #17428 ("file-backed
   summaries and **selective restoration**") and #6390 ("**context pruning** as
   alternative to compacting") describe reversible, inspectable elision without knowing
   smelt exists. The pain cluster (amnesia #6354/#7502, no inspectability #27242,
   reliability failures on both vendors, quota exhaustion at 1,491 comments) is the
   demand side smelt was built for.
5. **Anthropic's own doctrine is smelt's design.** "Maintain lightweight identifiers
   (file paths, stored queries, web links) and use these references to dynamically load
   data into context at runtime using tools" — that is the marker + `smelt_retrieve`
   contract, stated as vendor engineering guidance. The README can cite the vendor
   agreeing with the mechanism.
6. **smelt's honesty machinery is unique; its honesty _output_ is not.** llmtrim has run
   more real experiments than smelt has. The guard/mutation apparatus is the moat; the
   tier-2/3 rows are the missing evidence inside it.

## 3. Where smelt is genuinely behind (admitted, with sources in the notes)

- **Evidence.** Six deterministic byte cases versus llmtrim's 112 quality-scored live
  A/B cases and Headroom's accuracy suite. The README is honest that tiers 2–3 are unrun;
  honesty is not evidence.
- **Speed.** 80–350 ms measured (mostly Node startup + wasm init) versus 0.2–5 ms Rust
  peers. Matters at hook cadence; irrelevant for CLI-on-demand.
- **Content breadth.** JSON statistics (error items, outliers, boundaries), log-template
  folding, diff folding, search-result dedup, image shaping, output-token steering — all
  covered by peers, none by smelt.
- **Distribution.** A proxy wraps 16–17 agents with zero code change; smelt's hooks are
  verified on 2 harnesses, experimental on 6, advisory on 2.
- **Adoption.** Every serious peer outweighs smelt in stars and installed base; the
  field's citation anchor (LLMLingua) is dormant but the products around it are not.

## 4. Roadmap — proposals, priority-ordered

### P0 — Turn the honesty apparatus into evidence (nothing else matters first)

1. **Run the tier-2/3 measurements with a send-twice A/B harness** (llmtrim's design:
   each case sent raw and smelted, both scored, both billed, CIs published, regressions
   disclosed). The bench harness exists with tier slots reserved; this fills
   `bench/RESULTS.md` with token counts and — uniquely possible for smelt — **expansion
   rates with their dollar interpretation** (§2.3). Until this runs, smelt has the best
   measurement machinery in the field and the thinnest measurements.
2. **Republish the positioning** against today's facts: update the Headroom credit; add
   cache-safety-by-construction as a stated property (Headroom calls the same idea
   "live-zone compression"); cite Anthropic's lightweight-identifiers doctrine; add
   SWE-bench-instance corpus cases (claw-compactor's move) and `--seed`-reproducible bench
   scripts (Headroom's move) so anyone can re-derive the table.

### P1 — Occupy the wedge the platforms left open

3. **Make ingress rewrite the flagship path.** `PostToolUse.updatedToolOutput`
   (Claude Code), Codex PostToolUse, Gemini `AfterTool`, opencode `tool.execute.after` —
   transform before first send: cache-safe, near-identical schemas on the top two
   harnesses, and the resident MCP server amortizes the grammar cache (the measured
   latency is mostly per-process init; a resident process pays it once).
4. **Ship a PreCompact/PreCompress hook** that injects the repo map and the live elision
   index into the compaction summary — elisions and the retrieve contract _survive
   compaction_. This answers the loudest unmet pain (amnesia, selective-restoration
   requests) with the only mechanism the platforms cannot copy without becoming
   reversible. No peer or platform does this.
5. **Per-command focus defaults** (rtk's insight, applied at the planner seam): a small
   data table mapping producer commands (`pytest`, `cargo test`, `git diff`, `grep`) to
   focus semantics and content-type stages, so the common blobs arrive pre-focused.
6. **Promote the six experimental shims to verified** by smoke-testing against the real
   binaries — the honesty tier system only persuades when the verified row grows.

### P2 — Close the product gaps the peers proved matter

7. **Content-type stages, all deterministic and Law-2-explainable:** JSON statistical
   crusher (keep error items, outliers, first/last boundaries), Drain-style lossless log
   folding, diff folding, search-result dedup — proven valuable by Headroom's
   SmartCrusher (48–49% on JSON MEASURED), llmtrim and claw-compactor stages.
8. **Quality gate as a planner seam** (llmtrim's revert-a-cut-that-doesn't-pay, made
   deterministic): a per-elision retrieve counter that widens the window next time the
   same shape is planned. The expansion rate becomes a control loop, not just a gauge.
9. **Speed work only where cadence pays:** keep the hook-path guard stat-only (~25 ms,
   already measured), amortize wasm in the resident server, and measure again before
   claiming.

### Strategy guardrails — what the surveys say not to do

- **Never a proxy.** The caching economics punish transcript rewriting, and Law 1
  forbids the shape anyway. The platform note's verdict stands: ingress-only.
- **No learned distillation, even as peers add it.** Headroom's Kompress model is the
  standing contrast case — it is why smelt's prose numbers will be lower and its
  guarantees real. Wear that trade openly (Law 2 already reasons it).
- **No telemetry, ever.** Headroom's on-by-default beacon is the foil; zero-network is
  the product, not a config flag.
- **Don't fight native compaction on summarization.** Fight on what it structurally
  cannot do: explainable, reversible, counted, structure-aware elision — the six unmet
  pains of §4 in the platform note.

## Synthesis

smelt is already the only actor in the field — tool or platform — that combines enforced
zero network, per-elision explainability, no-eviction reversibility, and counted
retrieval, on a platform trajectory (vendor APIs, compaction pain, cache economics) that
rewards exactly those four and punishes the proxy alternative. What it lacks is not
identity but **evidence (P0), distribution (P1), and breadth (P2)** — in that order,
because the field's leaders win on measured numbers and installed surface, and smelt's
honesty machinery is only credible once it has run on real traffic. The first move that
makes smelt truly valuable is to point its own apparatus at itself and publish the
result.
