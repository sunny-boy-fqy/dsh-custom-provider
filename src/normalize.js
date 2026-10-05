/**
 * Configuration normalization: the shape every other module consumes.
 *
 * The provider is two levels deep, and the levels mean different things:
 *
 * - A **model** is what the picker shows and what a request names —
 *   `ds-free`, say. It carries the capability metadata (context window, output
 *   ceiling, input modalities) and it is what a session log records.
 * - A **candidate** is one way to actually serve that model: its own endpoint,
 *   key and upstream model name. A request for a model rotates **inside that
 *   model's own candidates**. It never leaks into another model's list, because
 *   two models are two different promises to the caller, not two links of one
 *   chain.
 *
 * This module is deliberately free of any Harness import so the pure logic — id
 * derivation, diagnostics, the model catalog — is unit-testable with plain
 * `node`, outside the runtime.
 *
 * @module @local/dsh-custom-provider/normalize
 */

/** Context window assumed when a model declares none. */
export const DEFAULT_CONTEXT_WINDOW = 262_144;
/** Output-token ceiling assumed when a model declares none. */
export const DEFAULT_MAX_TOKENS = 32_768;
/** How long a transiently failing candidate is parked, in minutes. */
export const DEFAULT_COOLDOWN_MINUTES = 5;
/** Idle timeout for one upstream request, in milliseconds. */
export const DEFAULT_IDLE_TIMEOUT_MS = 300_000;
/** Route id used when the operator supplies none. */
export const DEFAULT_PROVIDER_ID = 'custom';

/** Route ids must look like the ids the Harness already uses for providers. */
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

/** Model input modalities this provider understands. */
export const INPUT_MODALITIES = Object.freeze(['text', 'image']);

/** Slug a display name into an identifier. */
function slugify(text) {
  const slug = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return slug;
}

/** Coerce a positive integer, falling back when the value cannot be one. */
function positiveInt(value, fallback) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.max(1, Math.trunc(number));
}

/** Keep only recognized modalities, defaulting to text. */
function modalities(value) {
  if (!Array.isArray(value)) return ['text'];
  const kept = INPUT_MODALITIES.filter((modality) => value.includes(modality));
  return kept.length > 0 ? kept : ['text'];
}

/** Keep only string header values with non-empty names. */
function stringHeaders(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  /** @type {Record<string, string>} */
  const headers = {};
  for (const [name, header] of Object.entries(value)) {
    const key = name.trim();
    if (key.length === 0) continue;
    if (typeof header !== 'string') continue;
    headers[key] = header;
  }
  return headers;
}

/**
 * An optional positive integer: `undefined` when the field was left unset.
 *
 * Zero and blanks mean "not declared", not "zero tokens" — a candidate that
 * says nothing inherits the model's value instead of asking for an empty answer.
 */
function optionalInt(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.max(1, Math.trunc(number));
}

/** A non-empty trimmed string, or the fallback. */
function text(value, fallback = '') {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

/**
 * @typedef {object} NormalizedKey
 * @property {string} id - identifier a candidate names in `keyId`.
 * @property {string} name - label shown in the picker.
 * @property {string} value - inline key, possibly empty.
 * @property {string} credentialRef - credential reference, possibly empty.
 * @property {boolean} empty - true when the entry carries neither.
 */

/**
 * @typedef {object} NormalizedCandidate
 * @property {string} id - identifier, unique inside its model.
 * @property {string} key - health key, `modelId/candidateId`.
 * @property {string} name - label used in diagnostics and records.
 * @property {string} keyId - shared-key entry this candidate reuses, or `''`.
 * @property {boolean} keyResolved - false when `keyId` names nothing.
 * @property {string} baseURL - endpoint, trimmed.
 * @property {string} apiKey - inline key, trimmed.
 * @property {string} credentialRef - credential reference, trimmed.
 * @property {string} model - upstream model id.
 * @property {Readonly<Record<string, string>>} headers - extra request headers.
 * @property {number | undefined} maxTokens - this endpoint's own output ceiling.
 * @property {number | undefined} contextWindow - this endpoint's own context window.
 * @property {boolean} enabled - whether the candidate participates.
 * @property {number} index - position inside its model's list.
 */

/**
 * @typedef {object} NormalizedModel
 * @property {string} id - model id: the picker's identity and the session log's.
 * @property {string} name - picker label.
 * @property {number} contextWindow - context window.
 * @property {number} maxTokens - output ceiling.
 * @property {readonly string[]} input - accepted modalities.
 * @property {boolean} enabled - whether the model is offered at all.
 * @property {number} index - position in the configured list.
 * @property {NormalizedCandidate[]} candidates - every configured candidate.
 * @property {NormalizedCandidate[]} usableCandidates - enabled, complete candidates.
 */

/**
 * @typedef {object} Diagnostic
 * @property {number} model - model index, or -1 for a provider-level finding.
 * @property {number} candidate - candidate index, or -1 when the finding is not about one.
 * @property {string} field - the offending field, or `''`.
 * @property {'error' | 'warning'} severity - how bad it is.
 * @property {string} message - what to show the operator.
 */

/**
 * @typedef {object} NormalizedConfig
 * @property {string} providerId - validated route id.
 * @property {string} displayName - provider label.
 * @property {NormalizedKey[]} keys - the shared key library.
 * @property {NormalizedModel[]} models - every configured model.
 * @property {NormalizedModel[]} usableModels - enabled models with a usable candidate.
 * @property {number} cooldownMs - cooldown in milliseconds.
 * @property {number} idleTimeoutMs - idle timeout in milliseconds.
 * @property {boolean} failoverOnTransient - transient failover enabled.
 * @property {boolean} failoverOnAnyError - fail-anything failover enabled.
 * @property {readonly string[]} extraQuotaPatterns - operator quota phrases.
 * @property {Diagnostic[]} diagnostics - everything worth telling the operator.
 */

/**
 * Does this candidate have everything a request needs?
 *
 * @param {NormalizedCandidate} candidate - the candidate.
 * @returns {boolean} true when it is enabled, addressed, named and its key (if any) resolved.
 */
export function usableCandidate(candidate) {
  return candidate.enabled
    && candidate.keyResolved !== false
    && candidate.baseURL.length > 0
    && candidate.model.length > 0;
}

/**
 * Normalize the provider-level shared key library.
 *
 * The library exists so one key can serve many candidates: an operator with
 * three ModelScope keys pastes each once and points candidates at them, instead
 * of copying a secret into every row where a typo is invisible and a rotation
 * means editing all of them.
 *
 * @param {unknown} raw - the raw `keys` value.
 * @param {Diagnostic[]} diagnostics - collected findings.
 * @returns {NormalizedKey[]} the normalized library, in configured order.
 */
export function normalizeKeys(raw, diagnostics = []) {
  const source = Array.isArray(raw) ? raw : [];
  const taken = new Set();
  return source.map((value, index) => {
    const entry = value !== null && typeof value === 'object' ? value : {};
    const name = text(entry.name);
    const requested = text(entry.id);
    const derived = requested.length > 0 ? requested : slugify(name) || `key-${index + 1}`;
    const id = uniqueId(derived, taken);
    if (id !== derived) {
      diagnostics.push({
        model: -1,
        candidate: -1,
        field: 'keys',
        severity: 'warning',
        message: `共享密钥 id "${derived}" 重复，已改用 "${id}"`,
      });
    }
    const key = {
      id,
      name: name.length > 0 ? name : id,
      value: text(entry.value),
      credentialRef: text(entry.credentialRef),
    };
    if (key.value.length === 0 && key.credentialRef.length === 0) {
      diagnostics.push({
        model: -1,
        candidate: -1,
        field: 'keys',
        severity: 'warning',
        message: `共享密钥 "${id}" 既没有明文值也没有凭据引用`,
      });
    }
    return { ...key, empty: key.value.length === 0 && key.credentialRef.length === 0 };
  });
}

/**
 * Does this model offer at least one usable candidate?
 *
 * @param {NormalizedModel} model - the model.
 * @returns {boolean} true when it is enabled and has a usable candidate.
 */
export function usableModel(model) {
  return model.enabled && model.usableCandidates.length > 0;
}

/** Is this endpoint a usable http(s) URL? */
function validEndpoint(baseURL) {
  try {
    const url = new URL(baseURL);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Give a string a unique id inside one namespace. */
function uniqueId(candidateId, taken) {
  let id = candidateId;
  let suffix = 2;
  while (taken.has(id)) id = `${candidateId}-${suffix++}`;
  taken.add(id);
  return id;
}

/**
 * Normalize one candidate.
 *
 * @param {unknown} value - the raw candidate.
 * @param {number} index - its position in the model.
 * @param {string} modelId - the owning model's id, for the health key.
 * @param {Set<string>} taken - candidate ids already used in this model.
 * @param {Map<string, NormalizedKey>} keyMap - the shared key library by id.
 * @param {Diagnostic[]} diagnostics - collected findings.
 * @returns {NormalizedCandidate} the candidate.
 */
function normalizeCandidate(value, index, modelId, taken, keyMap, diagnostics) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const upstream = text(source.model);
  const name = text(source.name);
  const baseURL = text(source.baseURL);
  const keyId = text(source.keyId);

  const requested = text(source.id);
  const derived = requested.length > 0 ? requested : slugify(name) || slugify(upstream) || `candidate-${index + 1}`;
  const id = uniqueId(derived, taken);
  if (id !== derived) {
    diagnostics.push({
      model: -1,
      candidate: index,
      field: 'id',
      severity: 'warning',
      message: `候选 id "${derived}" 重复，已改用 "${id}"`,
    });
  }

  // A candidate either names a shared key or carries its own. Resolution happens
  // here, once, so every consumer downstream sees the same two fields and the
  // adapter never has to know the library exists.
  const shared = keyId.length > 0 ? keyMap.get(keyId) : undefined;
  const keyResolved = keyId.length === 0 || shared !== undefined;
  if (!keyResolved) {
    diagnostics.push({
      model: -1,
      candidate: index,
      field: 'keyId',
      severity: 'error',
      message: `候选 "${id}" 引用的共享密钥 "${keyId}" 不存在`,
    });
  }
  const apiKey = shared !== undefined ? shared.value : text(source.apiKey);
  const credentialRef = shared !== undefined ? shared.credentialRef : text(source.credentialRef);

  const enabled = source.enabled !== false;
  if (enabled) {
    if (baseURL.length === 0) {
      diagnostics.push({ model: -1, candidate: index, field: 'baseURL', severity: 'error', message: `候选 "${id}" 缺少端点地址` });
    } else if (!validEndpoint(baseURL)) {
      diagnostics.push({
        model: -1,
        candidate: index,
        field: 'baseURL',
        severity: 'error',
        message: `候选 "${id}" 的端点不是合法的 http(s) 地址：${baseURL}`,
      });
    }
    if (upstream.length === 0) {
      diagnostics.push({ model: -1, candidate: index, field: 'model', severity: 'error', message: `候选 "${id}" 缺少上游模型名` });
    }
    if (apiKey.length === 0 && credentialRef.length === 0) {
      diagnostics.push({ model: -1, candidate: index, field: 'apiKey', severity: 'warning', message: `候选 "${id}" 未配置密钥：将以无鉴权方式请求` });
    }
    if (apiKey.length > 0 && credentialRef.length > 0) {
      diagnostics.push({
        model: -1,
        candidate: index,
        field: 'credentialRef',
        severity: 'warning',
        message: `候选 "${id}" 同时配置了明文 key 与凭据引用，将使用凭据引用`,
      });
    }
  }

  return {
    id,
    key: `${modelId}/${id}`,
    name: name.length > 0 ? name : upstream.length > 0 ? upstream : id,
    keyId,
    keyResolved,
    baseURL,
    apiKey,
    credentialRef,
    model: upstream,
    headers: Object.freeze(stringHeaders(source.headers)),
    maxTokens: optionalInt(source.maxTokens),
    contextWindow: optionalInt(source.contextWindow),
    enabled,
    index,
  };
}

/**
 * Normalize one model and its candidates.
 *
 * @param {unknown} value - the raw model.
 * @param {number} index - its position in the configured list.
 * @param {Set<string>} taken - model ids already used.
 * @param {Map<string, NormalizedKey>} keyMap - the shared key library by id.
 * @param {Diagnostic[]} diagnostics - collected findings.
 * @returns {NormalizedModel} the model.
 */
function normalizeModel(value, index, taken, keyMap, diagnostics) {
  const source = value !== null && typeof value === 'object' ? value : {};
  const name = text(source.name);
  const requested = text(source.id);
  const derived = requested.length > 0 ? requested : slugify(name) || `model-${index + 1}`;
  const id = uniqueId(derived, taken);
  if (id !== derived) {
    diagnostics.push({
      model: index,
      candidate: -1,
      field: 'id',
      severity: 'warning',
      message: `模型 id "${derived}" 重复，已改用 "${id}"`,
    });
  }

  const startedAt = diagnostics.length;
  const candidateIds = new Set();
  const rawCandidates = Array.isArray(source.candidates) ? source.candidates : [];
  const candidates = rawCandidates.map((candidate, position) =>
    normalizeCandidate(candidate, position, id, candidateIds, keyMap, diagnostics),
  );
  // Findings raised while normalizing candidates are attributed to this model.
  for (let cursor = startedAt; cursor < diagnostics.length; cursor += 1) {
    if (diagnostics[cursor].model === -1) diagnostics[cursor].model = index;
  }

  const enabled = source.enabled !== false;
  const usableCandidates = candidates.filter(usableCandidate);
  if (enabled && candidates.length === 0) {
    diagnostics.push({ model: index, candidate: -1, field: 'candidates', severity: 'error', message: `模型 "${id}" 没有任何候选` });
  } else if (enabled && usableCandidates.length === 0) {
    diagnostics.push({
      model: index,
      candidate: -1,
      field: 'candidates',
      severity: 'error',
      message: `模型 "${id}" 没有可用的候选（需要至少一条填写完整的启用候选）`,
    });
  }

  return {
    id,
    name: name.length > 0 ? name : id,
    contextWindow: positiveInt(source.contextWindow, DEFAULT_CONTEXT_WINDOW),
    maxTokens: positiveInt(source.maxTokens, DEFAULT_MAX_TOKENS),
    input: Object.freeze(modalities(source.input)),
    enabled,
    index,
    candidates,
    usableCandidates,
  };
}

/**
 * Build the two-level configuration.
 *
 * Ids are derived when absent (from the id field, then the display name, then
 * the position) and de-duplicated, so a hand-written list without ids still
 * yields distinct, stable identities.
 *
 * A legacy flat `entries` list is migrated to one model per entry with a single
 * candidate, so a pre-existing hand-written config keeps working.
 *
 * @param {unknown} raw - the validated (or partially filled) config.
 * @returns {NormalizedConfig} the normalized view.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  /** @type {Diagnostic[]} */
  const diagnostics = [];

  const requestedId = text(source.providerId);
  let providerId = requestedId.length > 0 ? requestedId : DEFAULT_PROVIDER_ID;
  if (!PROVIDER_ID_PATTERN.test(providerId)) {
    diagnostics.push({
      model: -1,
      candidate: -1,
      field: 'providerId',
      severity: 'error',
      message: `路由 id 只能包含小写字母、数字、点、下划线和连字符，已回退到 ${DEFAULT_PROVIDER_ID}`,
    });
    providerId = DEFAULT_PROVIDER_ID;
  }

  const displayName = text(source.displayName, '自定义供应商');

  let rawModels = Array.isArray(source.models) ? source.models : [];
  const legacy = Array.isArray(source.entries) ? source.entries : [];
  if (rawModels.length === 0 && legacy.length > 0) {
    // One model per old entry, carrying that entry's capability fields up to the
    // model and keeping the entry itself as the single candidate — so the
    // migrated configuration still sends exactly the ceilings it used to.
    rawModels = legacy.map((entry) => ({
      id: text(entry?.id) || text(entry?.name),
      name: text(entry?.name),
      contextWindow: entry?.contextWindow,
      maxTokens: entry?.maxTokens,
      input: entry?.input,
      enabled: entry?.enabled,
      candidates: [entry],
    }));
    diagnostics.push({
      model: -1,
      candidate: -1,
      field: 'entries',
      severity: 'warning',
      message: '检测到旧的扁平 entries 配置，已迁移为「每个模型一个候选」；建议在配置页把同一模型的多个候选合并进去',
    });
  }

  const modelIds = new Set();
  const keys = normalizeKeys(source.keys, diagnostics);
  const keyMap = new Map(keys.map((key) => [key.id, key]));
  const models = rawModels.map((model, index) => normalizeModel(model, index, modelIds, keyMap, diagnostics));
  const usableModels = models.filter(usableModel);

  const cooldownMinutes = Number(source.cooldownMinutes);
  const idleTimeoutMs = Number(source.idleTimeoutMs);
  const extraQuotaPatterns = Array.isArray(source.extraQuotaPatterns)
    ? source.extraQuotaPatterns.map((pattern) => String(pattern)).filter((pattern) => pattern.length > 0)
    : [];

  return {
    providerId,
    displayName,
    keys,
    models,
    usableModels,
    cooldownMs: Math.max(
      1,
      Math.round((Number.isFinite(cooldownMinutes) && cooldownMinutes > 0 ? cooldownMinutes : DEFAULT_COOLDOWN_MINUTES) * 60_000),
    ),
    idleTimeoutMs: positiveInt(idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS),
    failoverOnTransient: source.failoverOnTransient !== false,
    failoverOnAnyError: source.failoverOnAnyError === true,
    extraQuotaPatterns: Object.freeze(extraQuotaPatterns),
    diagnostics,
  };
}

/**
 * Only the blocking findings.
 *
 * @param {NormalizedConfig} config - the normalized config.
 * @returns {readonly Diagnostic[]} the errors.
 */
export function errorsOf(config) {
  return config.diagnostics.filter((diagnostic) => diagnostic.severity === 'error');
}

/**
 * The effective limits of one model, after its candidates' own ceilings.
 *
 * A candidate that declares its own `maxTokens` or `contextWindow` is telling us
 * what the *endpoint behind it* accepts, and endpoints differ: one relay may
 * take 393216 output tokens while another caps at 65536. Reporting the model's
 * value to the Harness would make the harness pick a default the smallest
 * candidate cannot serve — which is exactly how a fallback ends up rejected by
 * the endpoint it fell back to. So the reported capability is the **minimum**
 * over the usable candidates, and the per-attempt clamp in the adapter covers a
 * caller that asks for more anyway.
 *
 * @param {NormalizedModel} model - the model.
 * @returns {{ maxTokens: number, contextWindow: number }} the effective limits.
 */
export function effectiveLimits(model) {
  const pool = model.usableCandidates.length > 0 ? model.usableCandidates : model.candidates;
  const outputCaps = pool.map((candidate) => candidate.maxTokens).filter((value) => value !== undefined);
  const windows = pool.map((candidate) => candidate.contextWindow).filter((value) => value !== undefined);
  return {
    maxTokens: outputCaps.length > 0 ? Math.min(model.maxTokens, ...outputCaps) : model.maxTokens,
    contextWindow: windows.length > 0 ? Math.min(model.contextWindow, ...windows) : model.contextWindow,
  };
}

/**
 * The output ceiling one attempt may ask for.
 *
 * The caller's resolved value (or the model's default) is the intent; the
 * candidate's own ceiling is the permission. The smaller one wins, so a
 * fallback can never be handed a number its endpoint already refused.
 *
 * @param {number | undefined} requested - the resolved request ceiling.
 * @param {NormalizedCandidate} candidate - the candidate about to be tried.
 * @param {NormalizedModel} model - the model being served.
 * @returns {number} the value to send as `max_tokens`.
 */
export function attemptMaxTokens(requested, candidate, model) {
  const intent = typeof requested === 'number' && requested > 0 ? requested : model.maxTokens;
  return candidate.maxTokens === undefined ? intent : Math.min(intent, candidate.maxTokens);
}

/**
 * Every health key the configuration currently declares.
 *
 * @param {NormalizedConfig} config - the normalized config.
 * @returns {string[]} candidate keys, in configuration order.
 */
export function healthKeys(config) {
  return config.models.flatMap((model) => model.candidates.map((candidate) => candidate.key));
}

/**
 * The model catalog this provider advertises: **one entry per logical model**.
 *
 * @param {NormalizedConfig} config - the normalized config.
 * @returns {Array<{ provider: string, id: string, name: string, description?: string, inputModalities?: readonly string[] }>} detached model metadata.
 */
export function modelsOf(config) {
  return config.usableModels.map((model) => ({
    provider: config.providerId,
    id: model.id,
    name: model.name,
    description: `${model.candidates.length} 个候选 · ${model.usableCandidates.map((candidate) => candidate.model).join(' / ')}`,
    inputModalities: [...model.input],
  }));
}

/**
 * Look up one logical model by the id a request names.
 *
 * @param {NormalizedConfig} config - the normalized config.
 * @param {string} model - the requested model id.
 * @returns {NormalizedModel | undefined} the model, when it is usable.
 */
export function modelOf(config, model) {
  return config.usableModels.find((candidate) => candidate.id === model);
}
