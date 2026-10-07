/**
 * Reuse: borrowing a model that already exists in the model list.
 *
 * A candidate can be served two ways. **Direct** is what this plugin always
 * did: its own endpoint, its own key, its own upstream model name, spoken over
 * OpenAI Chat Completions. **Reuse** names a *route that is already mounted*
 * (`deepseek-official`, `openrouter-free`, `our-free-model`, …) plus one model
 * id that route advertises, and the request is handed to that route's own
 * adapter through `ctx.llm.stream()`.
 *
 * Reuse is not a convenience over copying a base URL and a key — for most of
 * the interesting routes it is the *only* mechanism that can work at all:
 *
 * - Our Free Model serves its free lane anonymously and its 白嫖 (Kilo/EAC)
 *   lane through credentials the host keeps sealed; there is no base URL or key
 *   an operator could copy, and the plugin deliberately never exposes one.
 * - `llm-pi-ai` resolves its key from a credential reference at call time, so a
 *   copy would freeze a secret that is meant to rotate.
 * - The official DeepSeek routes sign with account identity and platform
 *   extensions that only their adapter knows how to produce.
 *
 * Handing the call to the owning adapter therefore borrows the *transport* and
 * keeps exactly the properties that made the model worth reusing. What it does
 * **not** borrow is replay state: the Harness strips provider replay envelopes
 * from history whose route belongs to another adapter, deliberately, so a
 * reused model sees the same conversation as provider-neutral content. That is a
 * capability regression on those turns, never a correctness one.
 *
 * This module holds the parts of reuse that are pure — failure classification
 * and catalog shaping — so both are testable without a runtime or a socket.
 *
 * @module @local/dsh-custom-provider/reuse
 */

import { clip, looksLikeQuotaExhaustion } from './quota.js';

/**
 * Provider-neutral failure codes that mean "this route cannot pay for more
 * requests right now", so the candidate should be retired for the day.
 *
 * @type {ReadonlySet<string>}
 */
export const QUOTA_CODES = Object.freeze(new Set([
  'QUOTA',
  'QUOTA_EXCEEDED',
  'ACCOUNT_QUOTA',
  'INSUFFICIENT_BALANCE',
  'INSUFFICIENT_QUOTA',
  'BILLING_HARD_LIMIT',
]));

/**
 * Codes worth another candidate *now* or after a short cooldown.
 *
 * `REGION_BLOCKED` is deliberately here rather than among the fatal codes: it is
 * a property of the egress, not of the configuration, so rotating to the next
 * candidate is exactly the right response and a cooldown is the right memory.
 *
 * @type {ReadonlySet<string>}
 */
export const TRANSIENT_CODES = Object.freeze(new Set([
  'RATE_LIMIT',
  'TIMEOUT',
  'TRANSPORT',
  'NETWORK_ERROR',
  'SERVER',
  'STREAM_ERROR',
  'STREAM_INTERRUPTED',
  'STREAM_INCOMPLETE',
  'EMPTY_RESPONSE',
  'REGION_BLOCKED',
  'UNAVAILABLE',
  'OVERLOADED',
]));

/** The code every abort carries, in this plugin and in the Harness. */
export const ABORTED_CODE = 'ABORTED';

/**
 * Is this a route id the Harness can actually address?
 *
 * The LLM registry keys routes by exact string, and every first-party plugin
 * spells them lower-case with dots and hyphens, so the check is the same shape
 * the plugin already applies to its own `providerId`.
 *
 * @param {unknown} value - the candidate's `provider` field.
 * @returns {boolean} true when it could name a registered route.
 */
export function validProviderId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

/**
 * Classify a failure one reused route reported, in the Harness's own vocabulary.
 *
 * The inner adapter has already done the hard part: it turned an endpoint's
 * status, body and stream noise into a stable `code`. What is left is deciding
 * what that code *means for the rotation*, and the only trap is that the codes
 * differ per plugin while the intent does not — `QUOTA` from the official
 * adapter, `AUTHORIZATION_REQUIRED` from the free lane's gateway, `TIMEOUT`
 * from pi-ai. Message text is consulted as well, because a relay that reports
 * exhaustion under a generic code is the case the whole classifier exists for.
 *
 * @param {object} failure - the inner `finish.reason.failure`.
 * @param {string} [failure.code] - stable machine-readable code.
 * @param {string} [failure.message] - human-readable detail.
 * @param {number} [failure.status] - HTTP status, when the inner layer saw one.
 * @returns {import('./quota.js').Failure} the classification to act on.
 */
export function classifyDelegatedFailure(failure) {
  const code = typeof failure?.code === 'string' ? failure.code.trim().toUpperCase() : '';
  const message = typeof failure?.message === 'string' ? failure.message : '';
  const detail = clip(message.length > 0 ? message : code || 'reused route failed');
  const status = Number.isFinite(failure?.status) ? failure.status : undefined;

  if (code === ABORTED_CODE) {
    return { kind: 'aborted', code: ABORTED_CODE, detail };
  }
  // A body that says "out of quota" outranks the code, exactly as it outranks
  // the HTTP status in the direct path: relays report billing problems as 400s
  // under codes like `CLIENT_ERROR`.
  if (QUOTA_CODES.has(code) || looksLikeQuotaExhaustion(message)) {
    return { kind: 'quota', code: code.length > 0 ? code : 'QUOTA', detail, ...(status === undefined ? {} : { status }) };
  }
  if (TRANSIENT_CODES.has(code) || (status !== undefined && (status === 408 || status === 425 || status >= 500))) {
    return {
      kind: 'transient',
      code: code.length > 0 ? code : `HTTP_${status}`,
      detail,
      ...(status === undefined ? {} : { status }),
    };
  }
  return { kind: 'fatal', code: code.length > 0 ? code : 'DELEGATED_ERROR', detail, ...(status === undefined ? {} : { status }) };
}

/**
 * Shape the live model list into the payload the browser half browses.
 *
 * The browser cannot call `ctx.llm` itself, so the Host half projects it: every
 * registered route, the models it currently advertises, and — for each model —
 * the capacities an import can write into the new model row so the picker shows
 * real numbers before the first request.
 *
 * A route that fails to list its models is reported as a *failure beside* the
 * others rather than sinking the whole answer: one broken provider must not
 * remove the ability to reuse the rest.
 *
 * @param {object} input - the projection inputs.
 * @param {readonly { id: string, name: string }[]} input.providers - `llm.listProviders()`.
 * @param {Map<string, { models?: readonly object[], error?: string }>} input.listed - per-route listing outcome.
 * @param {string} input.self - this plugin's own route id, which is never offered.
 * @returns {{ providers: object[], failures: object[], total: number }} the payload.
 */
export function buildCatalogView({ providers, listed, self }) {
  /** @type {object[]} */
  const groups = [];
  /** @type {object[]} */
  const failures = [];
  let total = 0;

  for (const provider of providers) {
    if (provider === null || typeof provider !== 'object') continue;
    const id = typeof provider.id === 'string' ? provider.id : '';
    if (id.length === 0 || id === self) continue;
    const outcome = listed.get(id);
    if (outcome === undefined || outcome.error !== undefined) {
      failures.push({
        provider: id,
        name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : id,
        error: outcome?.error ?? '该路由没有返回模型列表',
      });
      continue;
    }
    const models = (outcome.models ?? []).map((model) => ({
      id: String(model.id ?? ''),
      name: typeof model.name === 'string' && model.name.length > 0 ? model.name : String(model.id ?? ''),
      ...(typeof model.description === 'string' && model.description.length > 0 ? { description: model.description } : {}),
      ...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
      ...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
      ...(Array.isArray(model.inputModalities) ? { inputModalities: model.inputModalities.filter((value) => value === 'text' || value === 'image') } : {}),
      ...(model.reasoning === true ? { reasoning: true } : {}),
    })).filter((model) => model.id.length > 0);
    total += models.length;
    groups.push({
      id,
      name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : id,
      models,
    });
  }

  return { providers: groups, failures, total };
}

/**
 * The id a reused model should take in this provider's own model list.
 *
 * The reused id is already what the operator sees in the picker
 * (`space-bunny-free`, `deepseek-v4.1-flash`), so keeping it means one concept
 * has one name. A leading `org/` path segment is dropped because a slash is not
 * legal in a model id here, and the rest is slugged.
 *
 * @param {string} modelId - the reused model id.
 * @param {string} [fallback] - the display name, when the id slugs to nothing.
 * @returns {string} a legal model id, or `''` when nothing usable remains.
 */
export function reuseModelId(modelId, fallback = '') {
  const tail = String(modelId ?? '').trim().split('/').filter((part) => part.length > 0).at(-1) ?? '';
  const source = tail.length > 0 ? tail : String(fallback ?? '');
  return source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/**
 * The candidate id one reused model takes inside its new logical model.
 *
 * Bounded and deterministic: the same (route, model) pair always yields the same
 * id, so importing a model twice extends nothing and duplicates nothing — the
 * caller can use this to detect "already there".
 *
 * @param {string} provider - the reused route id.
 * @param {string} model - the reused model id.
 * @returns {string} a candidate id unique to that pair.
 */
export function reuseCandidateId(provider, model) {
  const slug = reuseModelId(model) || 'model';
  const route = String(provider ?? '').trim().toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${route.length > 0 ? route : 'route'}-${slug}`.slice(0, 120);
}

/**
 * Would this candidate ask a route to call itself?
 *
 * A reused candidate whose route is this very provider would route the request
 * straight back into the cascade that produced it. Refusing it early turns an
 * unbounded recursion into a diagnostic.
 *
 * @param {string} candidateProvider - the candidate's `provider`.
 * @param {string} ownProvider - this provider's route id.
 * @returns {boolean} true when the candidate is self-referential.
 */
export function isSelfReuse(candidateProvider, ownProvider) {
  return candidateProvider.length > 0 && candidateProvider === ownProvider;
}