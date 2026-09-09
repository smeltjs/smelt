/** Languages smelt can parse structurally. Everything else falls back to the lexical planner. */
export type LanguageId =
  | 'typescript'
  | 'tsx'
  | 'javascript'
  | 'rust'
  | 'python'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'c_sharp'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'bash';

/** `'unknown'` is a first-class outcome, not a failure: it selects the lexical planner. */
export type DetectedLanguage = LanguageId | 'unknown';

/** A half-open byte range `[start, end)` into the UTF-8 bytes of the input. */
export interface ByteRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Why a range was elided, in two registers: a stable id for counters, and a sentence
 * a human can read in a diff. Law 2 — every elision is explainable — lives here:
 * if you cannot write the sentence, the rule does not ship.
 */
export interface ElisionReason {
  /** Stable machine id, e.g. `'sibling-collapse'`, `'line-window'`. */
  readonly rule: string;
  /** e.g. `'collapsed 3 sibling functions'`. Present tense, no trailing period. */
  readonly explanation: string;
}

/** One range a planner proposes to remove. Plans are pure data — inspectable and testable. */
export interface PlannedElision {
  readonly range: ByteRange;
  readonly reason: ElisionReason;
  /**
   * The **outline**: the names of the declarations this elision collapses, in source
   * order — `['parseConfig', 'normalisePath']` — when the planner can read them off a
   * parse tree. Absent, never empty, when it cannot (a lexical planner sees lines, not
   * declarations; a run of comments has nothing to name).
   *
   * Out of band by design. The names ride on the plan, the applied elision and the
   * report — never in the marker, whose bytes and priced cost do not move by one byte
   * (`test/guards/marker-format.test.ts` pins that). It exists because the planner
   * held the cheapest possible index of what it hid and threw it away at explanation
   * time, leaving a model on a whole-file task to retrieve hash by hash just to learn
   * what was behind each marker.
   */
  readonly names?: readonly string[];
}

/**
 * The complete output of a planner: the whole decision, before anything is mutated.
 * A plan can be logged, diffed, snapshot-tested, and rejected without touching the text.
 */
export interface ElisionPlan {
  readonly planner: string;
  readonly language: DetectedLanguage;
  readonly elisions: readonly PlannedElision[];
}

/**
 * The seam through which a planner asks what a marker will cost, in UTF-8 bytes.
 *
 * Marker cost is `apply.ts`'s fact — the applier renders the marker, so only the
 * applier knows its price. Planners need that price for two decisions (profitability:
 * a marker that costs more than it removes grows the output; and budget prediction:
 * which ladder rung actually fits), and before this seam each planner rebuilt the
 * marker machinery privately to measure it — correct, but an inversion. Now
 * `markerPricing()` in `apply.ts` builds the one adapter from the exact builder
 * `applyPlan` will use, and planners ask it. They never guess, and they never render
 * a marker of their own.
 *
 * The price is exact, not an estimate: the cost of the marker this elision would
 * earn, comment leader and all, with a stand-in hash of the real hash's length —
 * marker cost depends on the hash's *length*, never its value.
 */
export interface MarkerPricing {
  /** The exact UTF-8 byte cost of the marker an elision with this reason and size would earn. */
  costBytes(reason: ElisionReason, elidedBytes: number): number;
}

/**
 * What the caller hands a planner.
 *
 * Constructed centrally: `createSmelter` (and through it, the CLI) builds the one
 * `PlanInput` per call, including its {@link MarkerPricing} — a caller invoking
 * `planLexical`/`planStructural` directly builds `pricing` with `markerPricing()`
 * from `apply.ts`. A JS caller who omits it gets {@link MissingMarkerPricingError}
 * at plan time, not a guessed cost.
 */
export interface PlanInput {
  readonly text: string;
  readonly language: DetectedLanguage;
  /** Soft ceiling for the emitted output, in UTF-8 bytes. Planners aim under it. */
  readonly budgetBytes: number;
  /**
   * What the caller was actually looking for — grep pattern, symbol name, error string.
   * Planners keep matching regions and collapse around them.
   */
  readonly focus?: readonly string[];
  /**
   * What a marker costs. Required: a planner that guesses marker cost can plan an
   * elision that grows the output. See {@link MarkerPricing}; built by
   * `markerPricing()` in `apply.ts` from the exact builder `applyPlan` will use.
   */
  readonly pricing: MarkerPricing;
  /**
   * The store's per-rule ledger — how many cuts each rule has made in this store and
   * how many of them were asked for back — when the store can supply one. Filled
   * centrally by `createSmelter`, like {@link MarkerPricing}; never guessed.
   *
   * **Opt-in data, not a lever.** The shipped planners do not read it: smelt measures
   * the expansion rate and never thresholds it (`docs/ARCHITECTURE.md` § Decision 4),
   * so a rule that "does not pay" is a fact a *caller's* planner may weigh, and never
   * a warning smelt authors. This is the deterministic form of "revert a cut that got
   * asked back": the loop is closed as data a planner can read, in one place.
   */
  readonly ruleHistory?: readonly RuleLedgerEntry[];
}

/**
 * A planner decides *what* to remove. It never removes anything itself; `applyPlan`
 * does that. Keeping the decision and the mutation apart is what makes the decision
 * testable in isolation.
 */
export interface Planner {
  readonly id: string;
  plan(input: PlanInput): Promise<ElisionPlan>;
}

/** One elision that actually happened, with the receipt needed to undo it. */
export interface AppliedElision {
  /** Content hash of the removed bytes — the key `retrieve()` takes. */
  readonly hash: string;
  /** Where the removed bytes were in the *input*. */
  readonly range: ByteRange;
  /**
   * Where the marker sits in the *output*. Law 3 — every elision is reversible — needs
   * this: {@link Reconstructor} splices stored bytes back over these ranges. Without it,
   * "reversible" would mean parsing markers back out of the text, which is a guess.
   * This is a fact recorded at the moment of the cut.
   */
  readonly outputRange: ByteRange;
  /** Size of the removed content, in UTF-8 bytes. */
  readonly bytes: number;
  readonly reason: ElisionReason;
  /** The exact marker text substituted into the output. */
  readonly marker: string;
  /** The planner's outline, carried verbatim from {@link PlannedElision.names}. */
  readonly names?: readonly string[];
}

/**
 * A consumer-supplied counter, so a caller who bills in tokens can *see* tokens.
 *
 * Budgets in smelt's core are UTF-8 bytes, permanently — bytes are the only unit that
 * is computable locally for every model, and they mean the same thing in five years.
 * See `docs/ARCHITECTURE.md` § "Decision 1". This hook does not change that: it adds a
 * second, labelled number to the result. The plan is still made in bytes.
 *
 * Both `id` and `unit` are required, and that is a Law 4 decision rather than
 * bookkeeping: a token count is meaningless without naming the tokenizer that produced
 * it. Anthropic's own docs record that Claude 4.7 and later use a newer tokenizer where
 * the same text yields roughly 30% more tokens than on earlier models — so `1,204
 * tokens` is not a fact, and `1,204 tokens (claude-4.7/count_tokens)` is.
 *
 * **This hook does not relax Law 1.** smelt imports no transport and the guard proves
 * that about smelt's own modules; it cannot prove it about a function you hand in. A
 * `count()` that calls an API makes *your* process call an API, from a line in *your*
 * source — exactly the arrangement {@link RerankStage} already describes. `count` is
 * synchronous on purpose: local tokenizers are synchronous, and network clients are not.
 */
export interface Measure {
  /** Names the counter, e.g. `'tiktoken/o200k_base'` or `'claude-4.7/count_tokens'`. */
  readonly id: string;
  /** The unit `count()` returns, e.g. `'tokens'`. Printed next to the number. */
  readonly unit: string;
  /** Local, synchronous count over the whole string. */
  count(text: string): number;
}

/** A second size for a result, in someone else's unit, with the counter named. */
export interface MeasuredSize {
  /** {@link Measure.id} of the counter that produced these numbers. */
  readonly measure: string;
  /** {@link Measure.unit}. */
  readonly unit: string;
  readonly input: number;
  readonly output: number;
}

/** The result of smelting one blob of text. */
export interface SmeltResult {
  readonly text: string;
  readonly inputBytes: number;
  readonly outputBytes: number;
  readonly planner: string;
  readonly language: DetectedLanguage;
  readonly elisions: readonly AppliedElision[];
  /** Present only when the caller supplied a {@link Measure}. Never invented. */
  readonly measured?: MeasuredSize;
  /**
   * Present only when the caller supplied a {@link RerankStage}. Never invented — an
   * absent field means no reranker ran, which is what every default run does.
   */
  readonly rerank?: RerankAttribution;
}

/**
 * Reversibility, as a callable. Takes a {@link SmeltResult} and the store that holds its
 * elided bytes, and returns the original text — byte for byte.
 */
export type Reconstructor = (result: SmeltResult, store: ElisionStore) => string;

// ---------------------------------------------------------------------------
// The store, and the counters that make over-pruning visible
// ---------------------------------------------------------------------------

/**
 * The numbers that keep smelt honest about itself.
 *
 * Law 3 says elisions are reversible. That is cheap to satisfy and easy to abuse: a
 * compressor that cuts everything is "reversible" and useless. The *retrieve rate* is
 * the tell. If the model keeps calling `smelt_retrieve`, smelt cut material the task
 * needed, and the round trip cost more tokens than the elision saved.
 *
 * So: `expansionRate` is not telemetry. It is the metric a caller tunes budgets
 * against, and the only number smelt is willing to have an opinion about — because it
 * measures it locally, per session, on the caller's own traffic.
 */
export interface RetrieveStats {
  /** Distinct blobs put into the store. */
  readonly elisionsStored: number;
  /** Total bytes held by the store. */
  readonly bytesStored: number;
  /** Every `retrieve()` call, including repeats and misses. */
  readonly retrieveCalls: number;
  /** Distinct hashes successfully retrieved at least once. */
  readonly uniqueRetrieved: number;
  /** Calls for a hash the store does not hold. Non-zero means a bug, not over-pruning. */
  readonly misses: number;
  /**
   * `uniqueRetrieved / elisionsStored`, or `0` when nothing has been stored.
   *
   * Read it as: *what fraction of what smelt hid did the model have to ask for back?*
   * There is no universally right value, and smelt does not ship a threshold it has
   * not measured. Rising across a workload is the signal.
   */
  readonly expansionRate: number;
  /**
   * The one degenerate outcome smelt is willing to name: **every distinct blob it hid
   * was asked for again.**
   *
   * smelt ships no expansion-rate threshold, because a threshold is a policy claim it
   * has no basis for and the right rate depends on how aggressive a budget the caller
   * chose — and a library printing warnings into someone else's process is bad manners.
   * This is not a threshold. At `uniqueRetrieved === elisionsStored` the elision
   * achieved nothing and cost a round trip: an arithmetic fact, not a preference. What
   * to do about it is the caller's call.
   *
   * `false` for an empty store — nothing was hidden, so nothing was defeated.
   */
  readonly allElisionsRetrieved: boolean;
}

/**
 * One row of a store's **ledger**: a rule, the distinct hashes it put, and how many
 * of those were retrieved at least once. Rows are sorted by rule, so two reads of one
 * store — or of one directory from two processes — render identically.
 *
 * `retrieved === stored` for a rule is the per-rule form of `allElisionsRetrieved`:
 * every cut that rule made was asked for back, an arithmetic fact and never a
 * threshold. What to do about it is the caller's call.
 */
export interface RuleLedgerEntry {
  /** The {@link ElisionReason.rule} id, e.g. `'sibling-collapse'`. */
  readonly rule: string;
  /** Distinct hashes put under this rule. */
  readonly stored: number;
  /** Of those, distinct hashes retrieved at least once. */
  readonly retrieved: number;
}

/**
 * Local, content-addressed storage for elided bytes. No network, and **nothing on this
 * interface evicts** — evicting on smelt's own initiative is how "reversible" quietly
 * becomes "reversible for a while". The one eviction that exists is a method on
 * {@link DirectoryElisionStore} and not on this interface (`prune`, behind
 * `smelt store prune`): a user asks for it, the store journals it, and a later
 * `retrieve` of the evicted hash says so. Putting it here would offer eviction to every
 * adapter — including one an agent's tool could reach.
 */
export interface ElisionStore {
  /**
   * Store content, returning its hash. Idempotent for identical content.
   *
   * `reason` is the rule the content was cut by, when the caller is the applier — it
   * feeds the store's {@link ledger}. Optional, so a store written before ledgers and
   * a caller storing bytes for its own reasons both keep working; a put with no
   * reason is stored and never attributed.
   */
  put(content: string, reason?: ElisionReason): string;
  /**
   * The stored content, or `undefined` if this store never held that hash. Uncounted.
   *
   * @throws {EvictedHashError} — {@link DirectoryElisionStore} only — when the bytes
   *   were deliberately removed by `smelt store prune`. Absence with a receipt is not
   *   the same fact as absence without one, and answering `undefined` for both would
   *   let a caller report "never elided" for bytes its own user deleted.
   * @throws {StoreCorruptionError} — {@link DirectoryElisionStore} only — when the
   *   stored bytes no longer hash to their own name.
   */
  peek(hash: string): string | undefined;
  /**
   * The stored content, *counted* as a retrieval. This is what the model's tool calls.
   *
   * @throws {UnknownHashError} when the hash is unknown.
   * @throws {StoreCorruptionError} — {@link DirectoryElisionStore} only — when the
   *   bytes on disk no longer hash to their own name. Distinct from
   *   `UnknownHashError` on purpose: "we hold damaged bytes" and "it never existed"
   *   are different answers, and a caller that conflates them will report the wrong
   *   one to its user.
   * @throws {EvictedHashError} — {@link DirectoryElisionStore} only — when a
   *   `smelt store prune` deleted the bytes, naming the date it took them. The third
   *   answer, for the same reason there is a second: "you removed it" is not "it never
   *   existed", and it is the one a model can act on. **It still counts as a miss** —
   *   `retrieveCalls` and `misses` move exactly as they would for an unknown hash,
   *   because the model asked for material back and did not get it, and an eviction
   *   that stopped counting would let a prune improve the expansion rate.
   *
   * A {@link DirectoryElisionStore} whose journal cannot be written (a read-only
   * store directory, a full disk) still returns the bytes — verified bytes are never
   * withheld over a bookkeeping failure — and surfaces the lost count as a
   * `process.emitWarning` named `SmeltCounterWriteFailure` instead of throwing. Its
   * stats go quiet from that point; the retrieval itself succeeded.
   */
  retrieve(hash: string): string;
  /**
   * Whether this hash can be retrieved — **not** merely whether a slot bearing it
   * exists. `true` must mean the very next `retrieve(hash)` returns bytes, so a store
   * that verifies content on read verifies here too and raises its corruption error
   * rather than answering `true` for bytes it would then refuse. Uncounted: a check is
   * not the model asking for material back.
   */
  has(hash: string): boolean;
  /** A snapshot of the counters. See {@link RetrieveStats}. */
  stats(): RetrieveStats;
  /**
   * The per-rule ledger, when this store keeps one — both shipped stores do. Optional
   * so a custom store need not; a consumer that wants the feedback loop implements it
   * with the shared `ruleLedger()` derivation from `stats.ts`. Uncounted, like
   * `stats()`: reading the ledger never moves it.
   */
  ledger?(): readonly RuleLedgerEntry[];
}

/**
 * The retrieval tool a consumer exposes to its model. Deliberately not an MCP or
 * provider-specific shape — smelt does not know which SDK you use. The consumer adapts
 * this into its own tool schema; the contract is `hash in, exact bytes out`.
 */
export interface RetrieveTool {
  /** `'smelt_retrieve'`. Stable — consumers hard-code it in prompts. */
  readonly name: string;
  /** Prose the consumer can put straight into a tool description. */
  readonly description: string;
  /**
   * JSON-Schema-shaped parameter description, for consumers that want one.
   *
   * Strict-mode shaped: `additionalProperties: false` and a `required` naming every
   * property, so a consumer registering this under OpenAI's structured-outputs strict
   * mode is not refused at registration. See {@link createRetrieveTool}.
   */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: {
      readonly hash: { readonly type: 'string'; readonly description: string };
    };
    readonly required: readonly ['hash'];
    readonly additionalProperties: false;
  };
  /**
   * @throws {UnknownHashError} when the hash is unknown.
   * @throws {StoreCorruptionError} when the backing store holds damaged bytes for
   *   that hash — see {@link ElisionStore.retrieve}, whose contract this forwards
   *   verbatim. Surface either to the model as a tool error, never as empty text.
   */
  invoke(input: { readonly hash: string }): string;
}

/**
 * One answer inside a batched retrieval: the exact bytes for a hash, or the store's
 * own refusal for it. A batch never fails as a whole — a model that asked for
 * eighteen blobs and typo'd one must still get the seventeen, and the one refusal
 * must still be the store's distinct error (`UnknownHashError` vs
 * `StoreCorruptionError`), never an empty string standing in for either.
 */
export type RetrievedBlock =
  | { readonly hash: string; readonly text: string }
  | { readonly hash: string; readonly error: Error };

/**
 * The batched sibling of {@link RetrieveTool}: N hashes in, one {@link RetrievedBlock}
 * per hash out, in the order asked. Additive — `smelt_retrieve` is the frozen wire
 * surface and stays byte-identical beside this.
 *
 * Why it exists is a measured fact, not a convenience: every tool call is a new
 * request, and input tokens are billed per request, so a model expanding eighteen
 * markers one call at a time re-bills its whole transcript eighteen times. One
 * request for eighteen blocks changes what that costs without changing what the
 * expansion rate *means* — each hit inside the batch is journalled exactly as a
 * single call would journal it.
 */
export interface RetrieveBatchTool {
  /** `'smelt_retrieve_batch'`. Stable — consumers hard-code it in prompts. */
  readonly name: string;
  /** Prose the consumer can put straight into a tool description. */
  readonly description: string;
  /** Strict-mode shaped, like {@link RetrieveTool.inputSchema}. */
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: {
      readonly hashes: {
        readonly type: 'array';
        readonly items: { readonly type: 'string' };
        readonly description: string;
      };
    };
    readonly required: readonly ['hashes'];
    readonly additionalProperties: false;
  };
  /**
   * One block per hash, in order. Never throws for a hash the store refuses — that
   * refusal rides inside its block — but anything that is not the store's own
   * refusal (an I/O failure, a bug) still propagates.
   */
  invoke(input: { readonly hashes: readonly string[] }): readonly RetrievedBlock[];
}

// ---------------------------------------------------------------------------
// Pluggable stages — interfaces in v1, nothing more
// ---------------------------------------------------------------------------

/** A candidate handed to a {@link RerankStage}: an opaque id plus the text to judge. */
export interface RerankCandidate {
  readonly id: string;
  readonly text: string;
}

/** A reranked candidate, most relevant first. `score` is the stage's own scale. */
export interface RerankedCandidate extends RerankCandidate {
  readonly score: number;
}

/**
 * Relevance reranking — a *seam*, not a feature.
 *
 * Hosted rerankers are good and smelt still bundles none in its default graph, because
 * bundling would break Law 1: the moment a reranker ships as a default, `smelt()` can
 * make a network call the caller did not ask for and cannot see. What ADR-0004 reopened
 * is narrower than that — an **explicit config opt-in**, never a default: a consumer
 * writes a `rerank` block into `smelt.config.json`, installs the adapter package
 * themselves, and reads their own key out of their own environment. With no `rerank`
 * key, nothing loads and nothing is called, exactly as before.
 *
 * A consumer wiring the stage programmatically implements this interface directly and
 * owns the fact that its context now leaves the machine.
 */
export interface RerankStage {
  readonly id: string;
  /**
   * The model this stage ranks with, when it names one — carried into the report and
   * the `--json` receipt beside {@link id}.
   *
   * Optional, and required of nothing: a stage that ranks locally has no model to name.
   * It exists for the same Law 4 reason {@link Measure} requires `id` — a relevance
   * score without the ranker that produced it named is not a measurement, and
   * `voyage/rerank-2.5` is a fact where `reranked` is a rumour.
   */
  readonly model?: string;
  /**
   * Rank `candidates` against `query` and return **the selection to spare** — not a
   * ranking of everything you were given.
   *
   * This is the one thing about the contract a stage author must get right, and the one
   * mistake here that fails silently. The candidates are the regions a planner has
   * already decided to remove; every entry you return is a region smelt will therefore
   * *not* remove. So returning all of them spares all of them: the run emits its input
   * unchanged, under budget or not, and exits 0 with a report saying every candidate was
   * kept. Nothing errors, because nothing is wrong — you asked for everything back.
   *
   * Apply your own cut-off before returning: a hosted reranker's `top_k`, a
   * `.slice(0, k)`, a threshold you chose. smelt applies none on top of yours, because a
   * K smelt invented would silently decide how much of the caller's context survives.
   *
   * May make network calls — that is the consumer's choice, made in the consumer's code.
   * Throwing is fine and expected: smelt wraps whatever comes out in a
   * {@link RerankStageError}, so a timeout or a 401 is reported as the refusal it is
   * rather than as a bug in smelt.
   */
  rerank(
    candidates: readonly RerankCandidate[],
    query: string,
  ): Promise<readonly RerankedCandidate[]>;
}

/**
 * What a {@link RerankStage} did to one run, as data — the outbound call made visible.
 *
 * Law 2 says every elision is explainable and Law 4 says no number is unmeasured. A
 * stage that reaches the network on the caller's behalf owes both: **which** ranker ran,
 * how many regions were at stake, and how many of them it saved from the cut. Every
 * surface renders this one value — the stderr report, the `--json` envelope (inside
 * `result`, so the receipt and the report cannot disagree) and the `smelt_file` report
 * block — so no front door assembles an attribution of its own.
 *
 * A run where the stage was never called still produces one of these, and says so in
 * {@link skipped} rather than by reporting a zero nobody measured: "configured and had
 * nothing to do" and "configured and never ran" are different facts, and one of them is
 * a misconfiguration.
 */
export interface RerankAttribution {
  /** {@link RerankStage.id} — `'voyage'`, `'module/./smelt.rerank.ts'`. */
  readonly adapter: string;
  /** {@link RerankStage.model}, when the stage names one. Never invented. */
  readonly model?: string;
  /**
   * Regions the planner proposed to elide — the candidate set, counted off the plan.
   * Always the measured size, including when {@link skipped} says the stage never saw
   * them: the planner really did propose that many, and reporting `0` because nothing
   * was sent would be a count nobody took.
   */
  readonly candidates: number;
  /** Of those, how many the stage returned and smelt therefore did **not** cut. */
  readonly kept: number;
  /**
   * Present exactly when the stage was **not** called, naming the precondition it could
   * not supply: `'no-candidates'` (the planner proposed nothing to cut) or `'no-query'`
   * (the run named no focus terms, and a ranker with no query would be scoring against
   * the empty string and calling the result relevance). Absent means the stage ran.
   */
  readonly skipped?: 'no-candidates' | 'no-query';
}

/**
 * Learned distillation — rewriting content with a model instead of cutting it.
 *
 * Out of v1 for a reason beyond the network: a distilled paragraph cannot satisfy
 * Law 2. "The model summarised this" is not an explanation of what was removed, and
 * the removed material is no longer recoverable from the output. If this ever ships,
 * it ships as a stage that stores the original and explains itself in the same terms
 * every other rule does.
 */
export interface DistillStage {
  readonly id: string;
  distill(text: string, budgetBytes: number): Promise<string>;
}
