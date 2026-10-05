/**
 * Failure classification for one candidate entry.
 *
 * The provider does not fail over on every error. A request only moves to the
 * next candidate when the current one is *out of quota for the day* (a durable
 * condition worth retiring the entry for) or hit a *transient* fault (network,
 * timeout, 5xx, rate limit — worth retrying after a short cooldown). Everything
 * else — a malformed request, a rejected key, an unknown model — is returned to
 * the caller unchanged, because trying the next candidate would only hide a
 * configuration mistake behind a second failure.
 *
 * Every classification carries a stable `code` so the configuration page, the
 * session log and the tests all speak the same vocabulary.
 *
 * @module @local/dsh-custom-provider/quota
 */

/**
 * @typedef {'quota' | 'transient' | 'fatal' | 'aborted'} FailureKind
 */

/**
 * @typedef {object} Failure
 * @property {FailureKind} kind - how the entry should be treated.
 * @property {string} code - stable machine-readable code.
 * @property {string} detail - short human-readable description.
 * @property {number} [status] - HTTP status when one was received.
 * @property {number} [retryAfterMs] - server-provided retry hint, when present.
 */

/**
 * Phrases that mean "this account cannot pay for more requests".
 *
 * These are matched against the HTTP body and against in-stream error payloads,
 * case-insensitively, because gateways put the same sentence behind 400, 403,
 * 429 and 402 depending on their own house style. Chinese relay stations in
 * particular report exhaustion in the body while returning a generic status.
 *
 * @type {readonly RegExp[]}
 */
export const DEFAULT_QUOTA_PATTERNS = Object.freeze([
  /insufficient[_\s-]*(?:user[_\s-]*)?(?:quota|balance|credits?|funds?)/i,
  /(?:quota|balance|credits?|funds?)[_\s-]*(?:exhausted|exceeded|depleted|insufficient|used[_\s-]*up|reached|is[_\s-]*0)/i,
  /exceeded\s+your\s+current\s+quota/i,
  /out\s+of\s+(?:quota|credits?|funds?)/i,
  /no\s+(?:remaining\s+|available\s+)?quota/i,
  /resource[_\s-]*exhausted/i,
  /billing\s+(?:hard\s+)?limit/i,
  /payment\s+required/i,
  /account\s+(?:is\s+)?(?:suspended|in\s+arrears|overdue)/i,
  /余额不足/,
  /余额已?(?:用尽|耗尽|不足|为零)/,
  /额度不足/,
  /额度已?(?:用尽|耗尽|用完|耗尽|不足)/,
  /配额不足/,
  /配额已?(?:用尽|耗尽|用完)/,
  /当前请求的额度/,
  /号已欠费/,
  /欠费/,
  /账户余额/,
]);

/**
 * Phrases that mean "slow down", which is transient rather than durable.
 *
 * @type {readonly RegExp[]}
 */
export const RATE_LIMIT_PATTERNS = Object.freeze([
  /rate\s*limit/i,
  /too\s+many\s+requests/i,
  /requests?\s+per\s+(?:minute|second|day)/i,
  /限流/,
  /请求(?:过于)?频繁/,
]);

/** Compile one user-supplied quota phrase into a literal, case-insensitive matcher. */
function literalPattern(phrase) {
  const escaped = String(phrase).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(escaped, 'i');
}

/**
 * Build the quota matcher list: built-ins first, then the operator's extras.
 *
 * @param {readonly string[]} [extraPhrases] - literal phrases from the plugin config.
 * @returns {readonly RegExp[]} matchers, built-ins included.
 */
export function quotaPatterns(extraPhrases = []) {
  const extras = (extraPhrases ?? [])
    .map((phrase) => String(phrase).trim())
    .filter((phrase) => phrase.length > 0)
    .map(literalPattern);
  return Object.freeze([...DEFAULT_QUOTA_PATTERNS, ...extras]);
}

/**
 * Does this text read as a quota/billing exhaustion message?
 *
 * @param {unknown} text - HTTP body, error message or in-stream error payload.
 * @param {readonly string[]} [extraPhrases] - operator-supplied literal phrases.
 * @returns {boolean} true when any quota matcher hits.
 */
export function looksLikeQuotaExhaustion(text, extraPhrases = []) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return quotaPatterns(extraPhrases).some((pattern) => pattern.test(text));
}

/**
 * Does this text read as a rate-limit message?
 *
 * @param {unknown} text - HTTP body or error message.
 * @returns {boolean} true when any rate-limit matcher hits.
 */
export function looksLikeRateLimit(text) {
  if (typeof text !== 'string' || text.length === 0) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Read a `Retry-After` header when the endpoint sends one.
 *
 * @param {Headers | undefined} headers - response headers.
 * @returns {number | undefined} delay in milliseconds, when present and sane.
 */
export function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Keep an error body short enough to travel through settings, logs and history. */
export function clip(text, limit = 600) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim().replace(/\s+/gu, ' ');
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

/**
 * Classify an HTTP failure response.
 *
 * Order matters: a body that says "quota exhausted" wins over the status code,
 * because relay stations reuse 400/403/429 for billing problems; a bare 429 is
 * a transient rate limit; 5xx and 408/425 are transient; everything else is a
 * configuration error the operator must see.
 *
 * @param {object} input - the response facts.
 * @param {number} input.status - HTTP status code.
 * @param {string} [input.bodyText] - response body, already read as text.
 * @param {Headers} [input.headers] - response headers.
 * @param {readonly string[]} [input.extraQuotaPatterns] - operator-supplied phrases.
 * @returns {Failure} the classification.
 */
export function classifyHttpFailure({ status, bodyText = '', headers, extraQuotaPatterns = [] }) {
  const body = clip(bodyText);
  const hint = retryAfterMs(headers);

  if (status === 402) {
    return { kind: 'quota', code: 'QUOTA', detail: body.length > 0 ? body : 'HTTP 402 Payment Required', status };
  }
  if (looksLikeQuotaExhaustion(body, extraQuotaPatterns)) {
    return { kind: 'quota', code: 'QUOTA', detail: body, status };
  }
  if (status === 429) {
    return {
      kind: 'transient',
      code: 'RATE_LIMIT',
      detail: body.length > 0 ? body : 'HTTP 429 Too Many Requests',
      status,
      ...(hint === undefined ? {} : { retryAfterMs: hint }),
    };
  }
  if (status === 408 || status === 425 || status >= 500) {
    return { kind: 'transient', code: `HTTP_${status}`, detail: body.length > 0 ? body : `HTTP ${status}`, status };
  }
  return { kind: 'fatal', code: `HTTP_${status}`, detail: body.length > 0 ? body : `HTTP ${status}`, status };
}

/**
 * Classify a transport-level failure thrown by `fetch` or by the stream reader.
 *
 * @param {unknown} error - the thrown value.
 * @param {object} [options] - context.
 * @param {boolean} [options.timedOut] - true when our own timeout fired.
 * @param {boolean} [options.cancelled] - true when the caller aborted.
 * @param {boolean} [options.midStream] - true when the failure happened after headers arrived.
 * @returns {Failure} the classification.
 */
export function classifyTransportFailure(error, { timedOut = false, cancelled = false, midStream = false } = {}) {
  const name = error?.name;
  const code = error?.code;
  if (cancelled || name === 'AbortError' || code === 'ABORT_ERR') {
    return { kind: 'aborted', code: 'ABORTED', detail: 'request cancelled' };
  }
  if (timedOut || name === 'TimeoutError' || code === 'ETIMEDOUT') {
    return {
      kind: 'transient',
      code: 'TIMEOUT',
      detail: midStream ? 'the response stream stalled after it started' : 'the request timed out',
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    kind: 'transient',
    code: midStream ? 'STREAM_INTERRUPTED' : 'NETWORK_ERROR',
    detail: clip(message.length > 0 ? message : 'network failure'),
  };
}

/**
 * Classify an error object delivered inside the SSE stream.
 *
 * Providers stream `{"error": {...}}` mid-response for failures they discover
 * after committing to 200. The message decides the class; anything that is not
 * a quota message is treated as transient, because the transport itself is
 * still up and a cooldown retry is the cheapest possible next move.
 *
 * @param {unknown} payload - the parsed `error` value, or a raw string.
 * @param {readonly string[]} [extraQuotaPatterns] - operator-supplied phrases.
 * @returns {Failure} the classification.
 */
export function classifyStreamError(payload, extraQuotaPatterns = []) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const detail = clip(text);
  if (looksLikeQuotaExhaustion(text, extraQuotaPatterns)) {
    return { kind: 'quota', code: 'QUOTA', detail };
  }
  if (looksLikeRateLimit(text)) {
    return { kind: 'transient', code: 'RATE_LIMIT', detail };
  }
  return { kind: 'transient', code: 'STREAM_ERROR', detail };
}

/**
 * Classify a stream that ended before the provider said it was finished.
 *
 * @returns {Failure} a transient failure the cooldown should absorb.
 */
export function classifyIncompleteStream() {
  return {
    kind: 'transient',
    code: 'STREAM_INCOMPLETE',
    detail: 'the stream ended before the provider reported a finish reason',
  };
}
