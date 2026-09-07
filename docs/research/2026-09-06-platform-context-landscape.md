# Platform context landscape — harness-native context management, vendor APIs, and the caching-vs-compression economics

Third note in the `docs/research/` convention (see `2026-09-02-agent-enforcement.md`
for the convention and `2026-09-02-harness-capability-matrix.md` for the
enforcement surface this builds on). Surveyed **2026-09-06** against primary
sources only — official vendor docs, the harnesses' own repos/changelogs, and
GitHub issues in the harnesses' own trackers. Every claim links to the source
that owns it; all URLs retrieved 2026-09-06 unless noted. Issue open/closed
states are as of that date. Feeds: the value-proposition wording in the README,
the hooks preset's cache-safety story, and the decision of which elisions to
run at ingress vs on retrieval.

The other half of this survey (peer _tools_: Headroom, LLMLingua, Serena,
repomix, rtk, …) lives in a separate note; this one covers what the
**platforms themselves ship** and what **users actually struggle with**.

---

## 1. Harness-native context management (mechanism · configurability · documented limits)

| Harness          | Manual command                                                                                                  | Automatic mechanism                                                                                                                                   | Documented trigger / threshold                                                                                                  | User-configurable?                                                                                                                                                        | Hook can intercept?                                                                                                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code**  | `/compact [focus]`, `/autocompact`, "Summarize up to here" (rewind menu)                                        | Auto-compaction + old-tool-result clearing + batched image removal                                                                                    | Default: at the model's context limit; 1M models "shortly before" 1M (Sonnet 5 ≈ 967K)                                          | `/autocompact 100K–1M`, `autoCompactWindow`, `--autocompact`, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `DISABLE_COMPACT`; compact instructions in CLAUDE.md; `/compact <focus>` | **Yes** — `PreCompact` hook can block compaction; `PostToolUse.updatedToolOutput` replaces tool output before the model sees it |
| **OpenAI Codex** | `/compact` ("Compact the current chat's context")                                                               | Auto-compaction ("history compaction"); remote `/responses/compact` task                                                                              | `model_auto_compact_token_limit` (unset = model default), scope `total`/`body_after_prefix`                                     | `compact_prompt` (inline override), `experimental_compact_prompt_file`                                                                                                    | **Yes** — `PreCompact` and `PostCompact` hook events; PostToolUse `additionalContext`/block (see 2026-09-02 note)               |
| **Gemini CLI**   | `/compress` ("Replace the entire chat context with a summary")                                                  | `ChatCompressionService` — auto-compress at **50% of model token limit**, keep last **30%** of history, summarised by a small model (flash-lite tier) | `DEFAULT_COMPRESSION_TOKEN_THRESHOLD = 0.5`; `COMPRESSION_PRESERVE_THRESHOLD = 0.3`; function-response budget **50,000 tokens** | Not documented as user config in commands reference                                                                                                                       | Partial — `PreCompressTrigger` exists in the hook types; `BeforeTool`/`AfterTool` rewrites exist (2026-09-02 note)              |
| **Cursor**       | CLI `/summarize` (alias `/compress`) — "Summarize the conversation to reduce context"                           | IDE-side handling **not documented** in current docs (no compaction page in the docs index)                                                           | Undocumented                                                                                                                    | Undocumented                                                                                                                                                              | `preToolUse.updated_input` rewrites input; `postToolUse` output rewrite is **MCP-only** (2026-09-02 note)                       |
| **opencode**     | `/compact` (alias `/summarize`)                                                                                 | `compaction.auto` — "Automatically compact the session when context is full (**default: true**)"                                                      | `compaction.reserved` — token buffer, default 10000                                                                             | `compaction: { auto, prune, reserved }` in `opencode.json`; **`prune` = "Remove old tool outputs to save tokens" (default false)**                                        | Plugin `tool.execute.before` deny/rewrite, `tool.execute.after` (2026-09-02 note)                                               |
| **Cline**        | `/smol` (alias `/compact`) — compresses current conversation; `/newtask` — distilled handoff to a fresh context | Auto-condense (docs page for it was removed in a docs restructure; behaviour documented via issues, §4)                                               | Undocumented in current docs                                                                                                    | None documented (turn-off requests open for years, §4)                                                                                                                    | No — hooks observe only; no output replacement (2026-09-02 note)                                                                |

Sources: [Claude Code costs](https://code.claude.com/docs/en/costs) · [model-config: auto-compact window](https://code.claude.com/docs/en/model-config#set-the-auto-compact-window) · [context-window](https://code.claude.com/docs/en/context-window) · [prompt-caching](https://code.claude.com/docs/en/prompt-caching) · [CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md) (Sonnet 5 967K auto-compact; `PreCompact` hook; `bashOutputMaxChars`/`taskOutputMaxChars` up to 128K chars in v2.1.261) · [Codex slash commands](https://developers.openai.com/codex/reference/slash-commands) · [Codex config reference](https://developers.openai.com/codex/config-reference) · [Gemini CLI commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md) · [`chatCompressionService.ts`](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts) · [v0.38 compression service PR #24483](https://github.com/google-gemini/gemini-cli/pull/24483), [v0.45 ContextManager simplification #27345](https://github.com/google-gemini/gemini-cli/pull/27345) · [Cursor CLI slash commands](https://cursor.com/docs/cli/reference/slash-commands) · [opencode TUI /compact](https://opencode.ai/docs/tui/#compact) · [opencode config: compaction](https://opencode.ai/docs/config/#compaction) · [Cline commands](https://docs.cline.bot/core-workflows/using-commands).

### Claude Code in detail — what compaction keeps and loses

The [context-window page](https://code.claude.com/docs/en/context-window) documents the
post-compaction state precisely. The summary preserves "your requests and intent,
key technical concepts, files examined or modified with important code snippets,
errors and how they were fixed, pending tasks, and current work"; it **replaces the
verbatim conversation — full tool outputs and intermediate reasoning are gone**.
Claude Code then re-reads **up to five of the most recently modified files**,
reloads matching path-scoped rules, and re-injects the body of invoked skills
(**capped at 5,000 tokens per skill**); the skill _listing_ is not reloaded.
MEMORY.md contributes only its first **200 lines or 25 KB**. Additional native
mechanisms: old tool results are cleared from context (the `/usage` cache panel
counts "expected rebuild (compaction or **tool-result clearing**)"
[costs doc](https://code.claude.com/docs/en/costs)), and images/PDFs are removed
in batches when request limits near ([prompt-caching: accumulating many
images](https://code.claude.com/docs/en/prompt-caching#accumulating-many-images)).
PostToolUse `additionalContext` is capped at **10,000 characters**; MCP tool
results can opt out of truncation up to **500K chars** via
`_meta["anthropic/maxResultSizeChars"]` ([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
Compaction itself is a large request: "`/compact` reads the conversation it
summarizes, so compacting a large context is itself a large request. When you
want a fresh start instead of continuity, `/clear` costs nothing"
([costs](https://code.claude.com/docs/en/costs)). Known failure modes fixed
only recently: auto-compact **thrash loop** ("context refills to the limit
immediately after compacting three times in a row"), compaction failing on
"Prompt is too long", and 1M-context compaction timeouts
([CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)).
Note: the 2025-era term _microcompact_ does not appear anywhere in the current
docs or the changelog snapshot we retrieved — the current documented mechanisms
are compaction, tool-result clearing, and image eviction.

### Gemini CLI in detail — the reverse token budget

`chatCompressionService.ts` implements a "Reverse Token Budget": walking newest→oldest,
recent function responses are kept in full; once the running tally exceeds
**50,000 tokens**, older large tool responses are **truncated to their last 30
lines and the full output saved to a temporary file** referenced in the placeholder
([source](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/context/chatCompressionService.ts)).
That is the closest native analogue to smelt's marker+store design — but it is
line-count truncation (not structure-aware), the pointer is a file path the
model must read manually (not a one-call retrieve), nothing is counted as
"expanded", and `/compress` itself "replaces the **entire** chat context with a
summary" ([commands](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md)).
The compression pass runs on a small model (flash-lite-tier mapping table in the
same file) — i.e., summarization quality is deliberately downgraded to save cost.

## 2. Vendor API-level context features

| Feature                     | Anthropic                                                                                                                                                                                                                                                                                                                                                                                                    | OpenAI                                                                                                                                                                                                                                                                                                                                                                            | Google                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Server-side compaction**  | `context_management.edits: [{type: "compact_20260112"}]` (beta `compact-2026-01-12`); trigger default **150K input tokens** (min 50K); `instructions` **replaces** the default summarization prompt; `pause_after_compaction` to inject content before continuing. "Server-side compaction is the recommended strategy" ([compaction doc](https://platform.claude.com/docs/en/build-with-claude/compaction)) | Responses API `context_management: [{type: "compaction", compact_threshold}]` (in-stream, ZDR-friendly with `store=false`) **plus a standalone stateless `/responses/compact` endpoint**. Compaction item is "encrypted … opaque and not intended to be human-interpretable" ([compaction guide](https://developers.openai.com/api/docs/guides/compaction))                       | None found at API level (Gemini CLI implements compression client-side)                                                                                                                                                                                                                         |
| **Tool-result clearing**    | `clear_tool_uses_20250919`: clears oldest tool results in chronological order, replaces each with **placeholder text telling Claude it was removed**; `trigger`, `keep` (N most recent), `clear_at_least`, `exclude_tools`, `clear_tool_inputs` ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing))                                                                   | — (compaction only)                                                                                                                                                                                                                                                                                                                                                               | —                                                                                                                                                                                                                                                                                               |
| **Thinking-block clearing** | `clear_thinking_20251015` with `keep` (per-model defaults; Opus 4.5+/Sonnet 4.6+/Fable/Mythos keep all) ([same](https://platform.claude.com/docs/en/build-with-claude/context-editing))                                                                                                                                                                                                                      | —                                                                                                                                                                                                                                                                                                                                                                                 | —                                                                                                                                                                                                                                                                                               |
| **Memory tool**             | `memory_20250818` client-side file memory under `/memories`; auto system-prompt protocol: "ASSUME INTERRUPTION: Your context window might be reset at any moment…" ([memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool))                                                                                                                                                | —                                                                                                                                                                                                                                                                                                                                                                                 | Gemini CLI ships its own four-tier memory system (v0.40, [#25716](https://github.com/google-gemini/gemini-cli/pull/25716))                                                                                                                                                                      |
| **Prompt caching**          | Prefix-match; **reads 0.1× base** (0.025× on Fable/Mythos 5.1); **5m writes 1.25×**, 1h writes 2×; min cacheable 512–4,096 tokens by model; 4 breakpoints, 20-block lookback; "Cache hits require 100% identical prompt segments" ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching))                                                                                   | Automatic for supported models; GPT-5.6+: reads 0.1× ("discounted up to 90%"), **writes 1.25×**, min 1,024 tokens, 30m TTL, explicit breakpoints (up to 4 writes, 50-breakpoint read lookback); earlier models: no write charge, model-dependent read discount, min 2,048, `in_memory`/`24h` retention ([prompt caching](https://platform.openai.com/docs/guides/prompt-caching)) | **Implicit caching on by default** for Gemini 2.5+; min 4,096 tokens (Gemini 3.x) / 2,048 (2.5); "we automatically pass on cost savings if your request hits caches"; explicit cache objects exist on `generateContent` only ([context caching](https://ai.google.dev/gemini-api/docs/caching)) |
| **Tool-definition economy** | Tool search tool with `defer_loading` stubs ([tool search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool))                                                                                                                                                                                                                                                                  | Same pattern: `defer_loading: true` + tool search ([tool search](https://developers.openai.com/api/docs/guides/tools-tool-search))                                                                                                                                                                                                                                                | —                                                                                                                                                                                                                                                                                               |
| **Batch**                   | 50% off, stacks with cache multipliers ([batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing))                                                                                                                                                                                                                                                                          | 50% off ([batch](https://developers.openai.com/api/docs/guides/batch))                                                                                                                                                                                                                                                                                                            | Batch API exists (not re-verified here)                                                                                                                                                                                                                                                         |

Two structural facts matter for smelt. First, **compaction has moved into the
APIs** — Anthropic shipped `compact-2026-01-12` (January 2026 beta) and OpenAI
ships both in-stream compaction and a standalone compact endpoint that Codex's
"remote compact task" issues run against (the failure cluster in §4 names
`chatgpt.com/backend-api/codex/responses/compact`). OpenAI's compaction blob is
explicitly **opaque and encrypted** — a harness that enables it can no longer
see or selectively restore what was dropped. Second, Anthropic's tool-result
clearing is the platform's own version of "replace a tool result with a marker" —
but the marker is a bare placeholder, the elision is **irreversible** (the client
keeps its copy, but the model can never get content back), and the docs warn the
operation is cache-hostile (§3).

## 3. The economics question — does 0.1× caching kill pre-emptive compression?

**Short answer: no — provided compression happens at ingress (before the bytes
enter the cached prefix). Post-hoc compression of an already-cached transcript
is cache-hostile and can cost more than it saves.** Every number below is
arithmetic on verified list prices (labelled; not a benchmark, Law 4 applies —
this belongs in strategy docs, not the README).

### The vendor guidance, verbatim

- Anthropic, on tool-result clearing: "**Invalidates cached prompt prefixes when
  content is cleared. To account for this, clear enough tokens to make the cache
  invalidation worthwhile.** Use the `clear_at_least` parameter… You'll incur
  cache write costs each time content is cleared."
  ([context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing))
- OpenAI, on the same tradeoff: "**Summarization, compaction, or context
  truncation can change the prefix and reset cache reuse**" and, under "Compaction
  can reduce cache reuse": "**fewer input tokens can still save money even when
  the cache-hit rate falls.**"
  ([prompt caching](https://platform.openai.com/docs/guides/prompt-caching))
- Anthropic's Claude Code team on why the whole harness is built around caching:
  "we run alerts on our prompt cache hit rate and **declare SEVs if they're too
  low**"; the compaction cost trap ("you end up paying the full, uncached input
  rate for the entire conversation") and its fix, cache-safe forking with the
  same prefix ([Lessons from building Claude Code: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything), Apr 30 2026).

### Worked example (arithmetic on Opus 5 list prices: $5 base, $6.25 5m-write, $0.50 read per MTok)

A 40,000-token tool result enters the transcript and stays resident for 10
subsequent requests, cache warm throughout:

| Strategy                                                                                 | One-time write                  | 10 reads                    | Total      | vs raw          |
| ---------------------------------------------------------------------------------------- | ------------------------------- | --------------------------- | ---------- | --------------- |
| Keep raw (cached)                                                                        | 40k × $6.25/M = $0.250          | 10 × 40k × $0.50/M = $0.200 | **$0.450** | —               |
| Smelted to 8k tokens at ingress (5×)                                                     | 8k × $6.25/M = $0.050           | 10 × 8k × $0.50/M = $0.040  | **$0.090** | **−80%**        |
| Smelted + 1 later `retrieve` of the elided 32k (re-enters as new suffix, uncached write) | $0.050 + 32k × $6.25/M = $0.200 | $0.040                      | **$0.290** | −36%            |
| Smelted + 2 retrieves                                                                    | $0.450 in writes                | $0.040                      | **$0.490** | **+9% (loses)** |

Because both the write multiplier (1.25×) and the read multiplier (0.1×) scale
with token count, a k× reduction at ingress saves (1−1/k) of the attributable
cost **regardless of how many times the prefix is re-read** — caching shrinks
the absolute savings, never the sign. The sign flips only through:

1. **Retrieval re-entry.** Each expansion pays the uncached write rate on the
   elided bytes. Break-even in this example is ≈1.5 retrieves per elided blob —
   which is precisely why smelt's counted expansion rate (Law 3) is an economics
   instrument, not just honesty theatre.
2. **Rewriting an already-cached prefix.** Compressing a result that already sits
   inside a warm cache invalidates everything after it. Rewriting one mid-conversation
   result in a 150K-token context can force re-writing ~100K tokens at 1.25×
   ($0.625) — more than the $0.36 saved. This is Anthropic's `clear_at_least`
   warning, and it is why **smelt must only ever transform tool output before it
   first reaches the model** (PostToolUse fires before the next request — safe;
   retroactive transcript surgery — never).
3. **Dropping below the minimum cacheable prefix** (1,024–4,096 tokens by model
   and vendor — [Anthropic](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
   [OpenAI](https://platform.openai.com/docs/guides/prompt-caching#escape-the-minimum-cacheable-length-cost-trap),
   [Gemini](https://ai.google.dev/gemini-api/docs/caching)). OpenAI documents
   this as the "minimum cacheable length cost trap" with the exact break-even
   formula; over-compressing a small session can cost more than it saves.
   smelt's ~8 KB floor (2026-09-02 note) sits safely above all three minimums.

And caching does nothing for the three budgets that compression _does_ help:

- **Window capacity.** A cached token still occupies the context window;
  compaction still fires. Anthropic: "as a conversation grows, response quality
  degrades, so compaction replaces older content with a concise summary"
  ([compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)).
- **Rate limits.** OpenAI FAQ: "**Cached input tokens still count toward
  tokens-per-minute limits**" ([prompt caching FAQ](https://platform.openai.com/docs/guides/prompt-caching)).
- **Subscription quota.** Claude Code: "a one-line question in a session that has
  been open all day still draws usage for the whole conversation" at the cached
  rate ([costs](https://code.claude.com/docs/en/costs)); plan-limit exhaustion is
  the single loudest pain signal in §4.

The cold-cache case strengthens compression further: with the 5-minute TTL
expired (the default for Claude Code API-key users and OpenAI `in_memory`
sessions), every re-read is 1.0× and a 5× ingress reduction saves 80% of the
full reprocessing cost per turn. Conversely the 1-hour TTL (2× writes) makes
long-idle sessions cache-friendly — Claude Code now picks TTLs per request
bucket and surfaces a `Prompt cache (main)` hit-rate line in `/usage`
([costs](https://code.claude.com/docs/en/costs#prompt-cache-statistics)).

## 4. User pain signals (harnesses' own trackers, retrieved 2026-09-06)

Strongest recurring themes, with the highest-engagement exemplars:

1. **Compaction amnesia — critical state lost.**
   [#6354](https://github.com/anthropics/claude-code/issues/6354) "Claude forgets everything in CLAUDE.md after compaction" (open) ·
   [#7502](https://github.com/anthropics/claude-code/issues/7502) "Auto-Compact Erases Entire Chat History Without Warning" (open) ·
   [#27242](https://github.com/anthropics/claude-code/issues/27242) "No working mechanism to review previous context after compaction… data preserved but UI inaccessible" (open) ·
   [#17428](https://github.com/anthropics/claude-code/issues/17428) "Enhanced /compact with file-backed summaries and **selective restoration**" (open) —
   i.e. users are independently asking for reversible, inspectable elision.
2. **Compaction reliability.**
   [#7530](https://github.com/anthropics/claude-code/issues/7530) "Error during compaction" (134 comments, closed) ·
   [#23047](https://github.com/anthropics/claude-code/issues/23047) "/compact fails with 'Conversation too long'" (closed) ·
   [#18482](https://github.com/anthropics/claude-code/issues/18482) "compaction intermittently corrupts conversation state" (closed) ·
   [#2038](https://github.com/anthropics/claude-code/issues/2038) "Error loop between 'context low' and '/compact'" (closed) ·
   Codex "Error running remote compact task" cluster:
   [#13784](https://github.com/openai/codex/issues/13784), [#14860](https://github.com/openai/codex/issues/14860) (106 comments),
   [#14346](https://github.com/openai/codex/issues/14346) "Context Compaction Hanging",
   [#22309](https://github.com/openai/codex/issues/22309) "gets stuck after… stream disconnected" ·
   [#39310](https://github.com/openai/codex/issues/39310) "Context just compacted, read 0% used, yet unable to continue".
3. **"Let me control it."**
   Codex [#4106](https://github.com/openai/codex/issues/4106) "Control over auto-compaction parameters" (open, 24 comments) ·
   claude-code [#6689](https://github.com/anthropics/claude-code/issues/6689) `--no-auto-compact` (closed, shipped) ·
   Cline [#5637](https://github.com/cline/cline/issues/5637) "How to turn off auto compact?" and
   [#10637](https://github.com/cline/cline/issues/10637) "auto compacts silently even with autocompacting setting disabled" (open) ·
   Cline [#5616](https://github.com/cline/cline/issues/5616) "New context condensing feature causes excessive token burning **and context loss**" (closed).
4. **Big outputs / long files blow the window.**
   Cline [#4389](https://github.com/cline/cline/issues/4389) "Improve Context Window Management and Large File Handling" (open, 23 comments) ·
   Cline [#5251](https://github.com/cline/cline/issues/5251) "Large files can cause conversations to break" (closed) ·
   Codex [#19464](https://github.com/openai/codex/issues/19464) "Support 1M token context for GPT-5.5 in Codex" (open, 132 comments).
5. **Cache economics is user-visible pain.**
   claude-code [#46829](https://github.com/anthropics/claude-code/issues/46829) "Cache TTL silently regressed from 1h to 5m… quota and cost inflation" (closed, 56 comments) ·
   [#16157](https://github.com/anthropics/claude-code/issues/16157) "Instantly hitting usage limits with Max subscription" (open, 1,491 comments) ·
   [#38335](https://github.com/anthropics/claude-code/issues/38335) "session limits exhausted abnormally fast" (open, 843 comments) ·
   Codex [#19585](https://github.com/openai/codex/issues/19585) "Pro weekly usage… worsened by unstable context compaction" (open) ·
   [#28879](https://github.com/openai/codex/issues/28879) "rate-limit cost per token jumped ~10-20×" (closed, 211 comments).
6. **Demand for smelt-shaped alternatives.**
   [#6390](https://github.com/anthropics/claude-code/issues/6390) "Add **Context Pruning** as Alternative to Compacting" (open) ·
   [#17428](https://github.com/anthropics/claude-code/issues/17428) (again — file-backed, selectively restorable summaries).

Pattern read: users do not complain that compaction exists; they complain that
it is **lossy without being inspectable, irreversible, badly tunable, and
occasionally broken** — and that its cost side-effects (cache misses, quota
burn) are invisible until the bill arrives.

## 5. Academic / industry framing (primary sources, brief)

- **Anthropic, "Effective context engineering for AI agents"** (Sep 29 2025):
  coins the operational doctrine — context is "a finite resource with
  diminishing marginal returns"; models have an "**attention budget**" (n²
  pairwise attention); the goal is "the smallest possible set of high-signal
  tokens"; and the just-in-time pattern is to "maintain **lightweight
  identifiers (file paths, stored queries, web links, etc.)** and use these
  references to dynamically load data into context at runtime using tools."
  That sentence is smelt's marker+`retrieve` design, stated as vendor doctrine.
  ([essay](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents))
- **Context rot**: the essay's cited evidence is Chroma's needle-in-haystack
  study ("as the number of tokens in the context window increases, the model's
  ability to accurately recall information from that context decreases",
  [research.trychroma.com/context-rot](https://research.trychroma.com/context-rot)).
- **Lost in the Middle** (Liu et al., 2023): the canonical precursor — retrieval
  accuracy is positional, sagging in the middle of long contexts
  ([arXiv:2307.03172](https://arxiv.org/abs/2307.03172)).
- **2026 restatement**: Anthropic's compaction beta doc motivates server-side
  compaction not by cost but by quality: "as a conversation grows, **response
  quality degrades**" ([compaction](https://platform.claude.com/docs/en/build-with-claude/compaction)).
  The memory tool doc adds the operative protocol for long-horizon work:
  "ASSUME INTERRUPTION: Your context window might be reset at any moment, so you
  risk losing any progress that is not recorded in your memory"
  ([memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)).

## Synthesis

**(a) Are harnesses absorbing this natively — how fast, how well?** Fast and
shallow. Every surveyed harness now ships summarization-compaction (Claude Code
`/compact`+auto, Codex `/compact`+auto with prompt overrides, Gemini `/compress`
+50%-threshold auto, Cursor `/summarize`, opencode `/compact`+`prune`,
Cline `/smol`), and the vendors have pulled the mechanism **into the API layer**
(Anthropic `compact_20260112` Jan 2026; OpenAI `context_management` +
`/responses/compact`). But "absorbed" stops at the _when-the-window-fills_
layer. Every native mechanism is whole-transcript summarization or blunt
truncation: lossy, irreversible, opaque (OpenAI's blob is encrypted by design),
unmeasured (no vendor counts what was dropped or fetched back), and — per §4 —
reliably the top complaint cluster. The closest native feature to smelt,
Anthropic's `clear_tool_uses_20250919`, replaces tool results with a bare
irreversible placeholder that the model cannot retrieve, and Gemini CLI's
30-lines-to-a-temp-file truncation is the same idea without structure or
accounting. The platform gap is exactly smelt's four laws: explainable,
reversible, counted, structure-aware elision.

**(b) Does prompt-cache economics help or hurt pre-emptive compression?** Hurt
only in one specific geometry; help elsewhere. At 0.1× reads / 1.25× writes on
both Anthropic and OpenAI (Gemini implicit caching on by default), a k×
ingress-time reduction still saves (1−1/k) of a blob's attributable cost — 80%
on a 5× smelt in the worked example, warm or cold cache alike. The honest
caveats: (i) **each retrieval re-enters at the uncached write rate** — break-even
≈1.5 retrieves/blob in the example, making the expansion-rate counter an
economic necessity; (ii) **never rewrite an already-cached transcript** — that
is the one operation that genuinely costs more than it saves (vendor-documented);
(iii) don't compress below the 1,024–4,096-token cache minimums. What caching
explicitly does _not_ buy — window capacity, context-rot quality, rate limits,
subscription quota (all vendor-stated) — is compression's uncontested territory.
Verdict: cache-friendly compression-at-ingress is strictly additive; retroactive
compression is the trap. smelt's hook design (PostToolUse before the result
reaches the model) is cache-safe by construction and should say so loudly.

**(c) What context pains remain unsolved by the platforms?** Six recurring,
unmet: irreversible compaction amnesia (state users needed later); no
inspectability of what was dropped (claude-code #27242: data preserved but
inaccessible); no selective/per-item restoration (#17428, #6390 ask for exactly
this); blunt or missing configurability (Codex #4106, Cline #5637/#10637);
compaction reliability (the error clusters on both Anthropic and OpenAI); and
opaque server-side blobs (OpenAI's encrypted compaction item) that make the
first five permanent. None of the platforms counts elisions or retrievals —
honest over-pruning signals do not exist anywhere native.

**(d) Most defensible wedge for a third-party library.** Ranked by leverage ×
cache-safety × portability: (1) **Ingress hooks over tool outputs** — Claude
Code `PostToolUse.updatedToolOutput` / Codex PostToolUse / Gemini `AfterTool` /
opencode `tool.execute.after`: transform before first send = cache-safe by
construction, and the 2026-09-02 matrix already shows the schema is near-identical
across Claude Code and Codex. (2) **MCP `smelt_retrieve`** as the universal
reversibility layer — the only surface that works on every harness including the
hook-less ones (KiloCode, Cline-observe), and the resident process that amortizes
the grammar cache. (3) **PreCompact/PreCompress hooks** (Claude Code, Codex;
Gemini's trigger type exists in code) to inject the smelt map into the summary so
elisions survive compaction — turning the platforms' own mechanism into a
retrieval index. (4) AGENTS.md/instruction files remain advisory-only but are
the teaching layer for the marker/retrieve contract. The "library, not a proxy"
positioning is not just philosophical here: a proxy that rewrites transcripts
mid-stream is the one shape the caching economics punishes.

---

_Sources of record (all retrieved 2026-09-06):
[claude.com/docs costs · prompt-caching · context-window · model-config](https://code.claude.com/docs/en/costs),
[Claude Code CHANGELOG](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md),
[claude.com blog: prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything),
[platform.claude.com: compaction · context-editing · prompt-caching · memory-tool · batch](https://platform.claude.com/docs/en/build-with-claude/compaction),
[anthropic.com/engineering: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents),
[developers.openai.com: prompt-caching · compaction · batch · codex slash-commands · codex config-reference](https://developers.openai.com/api/docs/guides/prompt-caching),
[ai.google.dev: context caching](https://ai.google.dev/gemini-api/docs/caching),
[google-gemini/gemini-cli: commands.md · chatCompressionService.ts · release notes](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/commands.md),
[cursor.com/docs: agent overview · CLI slash commands](https://cursor.com/docs/cli/reference/slash-commands),
[opencode.ai/docs: tui · config](https://opencode.ai/docs/tui/),
[docs.cline.bot: using commands](https://docs.cline.bot/core-workflows/using-commands),
plus the GitHub issues cited inline. Worked-example prices are arithmetic on
the cited list prices; no claims about any real deployment's spend._
