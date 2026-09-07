/**
 * Shared POST transport for the tier modules — with the retry the paid tiers need.
 *
 * A bench run makes dozens of sequential requests over the public internet, and a
 * single dropped TLS record ("fetch failed … ssl3_read_bytes: alert bad record mac" —
 * seen in a live run) used to kill the whole run after earlier calls had already been
 * paid for, because rows append only when every tier finishes. Two failure classes
 * are therefore distinguished here:
 *
 *  - **Transient** — the transport itself rejected the call (DNS, TLS, dropped
 *    connection), or the provider answered 429/5xx/529 (rate limit, overload, server
 *    error). Retried with exponential backoff and jitter, announced on stderr, so the
 *    run's transcript stays honest about what was retried.
 *  - **Fatal** — any other 4xx. The provider has judged the request itself wrong;
 *    retrying only re-pays for the same refusal, so it surfaces immediately.
 *
 * This file is one of the bench modules allowed to reach the network
 * (`test/guards/bench-results.test.ts`); it is imported only by the tier modules,
 * which run.mjs loads dynamically on their tiers — a tier-1 run never loads it.
 */

const RETRYABLE_STATUS = (status) => status === 429 || (status >= 500 && status < 600);

class TransientFailure extends Error {}

function describeTransportError(error) {
  const cause = error?.cause?.message;
  return cause === undefined ? String(error) : `${String(error)} — ${cause}`;
}

/**
 * POSTs one JSON request, retrying transient failures. `fetchImpl` and `backoffMs`
 * are injectable so `test/bench.test.ts` can exercise the policy offline and
 * instantly; `attempts` bounds the total tries (default 5 — roughly 15 s of backoff
 * on the real schedule before the last transient failure is raised as the answer).
 */
export async function postJson({
  url,
  headers,
  body,
  fetchImpl,
  attempts = 5,
  backoffMs,
  onRetry,
}) {
  const doFetch = fetchImpl ?? fetch;
  const delay =
    backoffMs ?? ((attempt) => 1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
  let lastTransient;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      let response;
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
      } catch (error) {
        // fetch rejected: DNS, TLS, a dropped connection — the transport, not the request.
        throw new TransientFailure(describeTransportError(error));
      }
      if (response.ok) return response.json();
      const detail = await response.text();
      const message = `HTTP ${String(response.status)} — ${detail}`;
      if (RETRYABLE_STATUS(response.status)) throw new TransientFailure(message);
      throw new Error(message);
    } catch (error) {
      if (!(error instanceof TransientFailure)) throw error;
      lastTransient = error;
      if (attempt < attempts) {
        onRetry?.(attempt, error);
        await new Promise((resolve) => setTimeout(resolve, delay(attempt)));
      }
    }
  }
  throw lastTransient;
}
