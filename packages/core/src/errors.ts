/**
 * Every error smelt throws is one of these. Consumers can `instanceof SmeltError`
 * to tell "the library said no" apart from "something else blew up".
 */
export class SmeltError extends Error {
  override readonly name: string = 'SmeltError';
}

/**
 * A scaffold stub. It throws instead of returning a plausible-looking wrong answer,
 * because a context optimizer that quietly returns bad output is indistinguishable
 * from one that works. See CONTRIBUTING.md § "Silence is the enemy".
 */
export class NotImplementedError extends SmeltError {
  override readonly name = 'NotImplementedError';

  constructor(what: string, seeAlso: string) {
    super(
      `smelt: ${what} is not implemented yet. This is a scaffold stub — it throws rather ` +
        `than returning a plausible wrong answer. See ${seeAlso}.`,
    );
  }
}

/**
 * Thrown when something in the elision path tried to reach a non-local resource.
 * v1 has no network. See docs/ARCHITECTURE.md § "Law 1 — zero network".
 */
export class NetworkPolicyError extends SmeltError {
  override readonly name = 'NetworkPolicyError';

  constructor(message: string) {
    super(`smelt: ${message}`);
  }
}

/** A plan asked to elide two overlapping ranges. Applying it would corrupt the output. */
export class OverlappingElisionError extends SmeltError {
  override readonly name = 'OverlappingElisionError';
}

/** A plan referenced a byte range that is not inside the input. */
export class RangeOutOfBoundsError extends SmeltError {
  override readonly name = 'RangeOutOfBoundsError';
}

/** A grammar was requested that is not installed or not registered. */
export class GrammarUnavailableError extends SmeltError {
  override readonly name = 'GrammarUnavailableError';
}

/** `retrieve(hash)` was called with a hash the store does not hold. */
export class UnknownHashError extends SmeltError {
  override readonly name = 'UnknownHashError';

  constructor(hash: string) {
    super(
      `smelt: no stored content for hash "${hash}". It was never elided, or the store was reset.`,
    );
  }
}

/**
 * A planner was handed a `PlanInput` without `pricing`. The type makes `pricing`
 * required, so TypeScript callers cannot get here; a JS caller can, and the honest
 * answer is this error rather than a guessed marker cost — a planner pricing markers
 * itself is exactly the inversion the MarkerPricing seam removed.
 */
export class MissingMarkerPricingError extends SmeltError {
  override readonly name = 'MissingMarkerPricingError';

  constructor(plannerId: string) {
    super(
      `smelt: ${plannerId} was handed a PlanInput without \`pricing\`. A planner never ` +
        `guesses what a marker costs — the applier renders markers, so the applier ` +
        `prices them. Build one with markerPricing(language, marker) from apply.ts and ` +
        `put it on the input; createSmelter and the CLI construct it centrally.`,
    );
  }
}

/**
 * The CLI was invoked wrongly — a missing `--budget`, an unknown flag, a budget that
 * is not a number. Distinct from every other `SmeltError` so the CLI can exit with a
 * usage code rather than pretending the library refused.
 */
export class CliUsageError extends SmeltError {
  override readonly name = 'CliUsageError';
}

/**
 * Two different blobs hashed to the same key. Astronomically unlikely, and yet: the
 * alternative to throwing is handing the model the wrong bytes and calling it a
 * retrieval, which is precisely the silent failure this library exists to avoid.
 */
export class HashCollisionError extends SmeltError {
  override readonly name = 'HashCollisionError';

  constructor(hash: string) {
    super(
      `smelt: hash collision on "${hash}" — two different blobs share a key. Refusing to ` +
        `store, because retrieving would return the wrong bytes. Please report this.`,
    );
  }
}

/**
 * A persistent store holds bytes under this hash, but they no longer hash to it — a
 * torn write, a truncation, an edit behind the store's back. Deliberately distinct from
 * {@link UnknownHashError}: "we hold damaged bytes" and "never existed" call for
 * different responses, and returning the damaged bytes as a retrieval would be the
 * silent wrong answer this library exists to refuse.
 */
export class StoreCorruptionError extends SmeltError {
  override readonly name = 'StoreCorruptionError';

  constructor(hash: string) {
    super(
      `smelt: the bytes stored under hash "${hash}" do not hash to "${hash}". Refusing ` +
        `to return them — they are damaged, not merely unknown. The store directory was ` +
        `truncated or edited outside smelt.`,
    );
  }
}

/**
 * A directory offered as a persistent store carries a format marker this version of
 * smelt does not understand — or no parseable marker at all. Refusing beats guessing:
 * reinterpreting an unknown layout could hand back the wrong bytes with no error.
 */
export class StoreFormatError extends SmeltError {
  override readonly name = 'StoreFormatError';
}

/**
 * A filesystem call the repo map made failed: a root that is not there, a directory
 * that cannot be listed, a file that cannot be read, a cache entry that cannot be
 * written.
 *
 * It exists because of a hole in the one promise the consumer contract makes about
 * errors — **every error smelt throws is an `instanceof SmeltError`**.
 * `buildRepoMap({ root: '/nonexistent' })` used to throw the raw `ENOENT` that
 * `readdirSync` raises, so a caller doing precisely what the documentation says still
 * had a bare `Error` escaping past its `catch`. The guarantee is worth nothing with an
 * exception to it, so every `node:fs` call under `src/repomap/` now arrives here.
 *
 * The message names the path, because "ENOENT" without one is a bug report nobody can
 * act on, and the original error is kept as `cause`: wrapping is meant to bring the
 * failure inside the contract, never to hide what Node said.
 */
export class RepoMapIoError extends SmeltError {
  override readonly name = 'RepoMapIoError';

  constructor(operation: string, path: string, cause: unknown) {
    super(
      `smelt: could not ${operation} "${path}" while building the repo map: ` +
        `${describeIoCause(cause)}.`,
      { cause },
    );
  }
}

/** The `errno` code when Node supplied one, its message otherwise. Never invented. */
function describeIoCause(cause: unknown): string {
  const code = (cause as { code?: string } | null | undefined)?.code;
  if (typeof code === 'string' && code !== '') return code;
  if (cause instanceof Error && cause.message !== '') return cause.message;
  return String(cause);
}

/**
 * A content-kind planner (`json`, `diff`) was asked to plan text that is not that kind.
 * It refuses rather than approximating, for the reason the structural planner refuses
 * an unknown language: output labelled `json/v1` that is really line windows would be
 * undetectable from outside. `auto` never raises this — it probes the kind first and
 * routes only what the probe proved.
 */
export class ContentKindError extends SmeltError {
  override readonly name = 'ContentKindError';
}

/**
 * A configured {@link RerankStage} did not produce an answer smelt can act on — it
 * threw, or it returned a candidate id it was never sent, or the same id twice.
 *
 * **Every way a stage can fail arrives as this error**, and that is the point. A stage
 * is the one part of a smelt run that talks to another machine, so its ordinary failures
 * are *expected*: a timeout, a 401, an unreachable host, a generated stub nobody has
 * filled in yet. Those throw plain `Error`s from the consumer's own adapter — and a
 * plain `Error` escaping the library reaches a CLI that prints "unexpected internal
 * error \u2014 this is a bug, please report it" with a stack trace and exits 4, and an MCP
 * handler that rethrows past its own envelope. Neither is true: the reranker was
 * unreachable, which is an answer, and a refusal is an answer both front doors already
 * know how to render. So `applyRerank` catches whatever the stage throws and rethrows it
 * as this, carrying the original as `cause`.
 *
 * The garbage-answer cases refuse rather than filtering the answer down to the parts
 * smelt recognises, for the reason a store refuses a hash whose bytes no longer match: a
 * reranker whose answer is quietly repaired is a reranker nobody can tell has broken.
 */
export class RerankStageError extends SmeltError {
  override readonly name = 'RerankStageError';

  constructor(stageId: string, why: string, options?: { readonly cause?: unknown }) {
    super(
      `smelt: the rerank stage "${stageId}" ${why}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
  }
}
