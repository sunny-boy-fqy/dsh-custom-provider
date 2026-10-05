/**
 * Host half of `@local/dsh-custom-provider`.
 *
 * One provider route serves a set of logical models, each with its own ordered
 * candidate list. The adapter does the rotation (see `src/adapter.js`); this
 * module owns everything around it:
 *
 * - reading the live configuration through the volatile accessors the loader
 *   hands to `apply`, so an edit applies on the next request without a remount;
 * - keeping the route registration in step with `providerId`, atomically, and
 *   remembering why a conflicting id was refused instead of silently serving the
 *   wrong route;
 * - the durable health table (`src/health.js`) the cascade records into, keyed
 *   per candidate;
 * - the small HTTP surface the browser half uses for things the settings plane
 *   cannot carry: the model/candidate snapshot with live health, a manual reset,
 *   and an endpoint probe.
 *
 * @module @local/dsh-custom-provider
 */

import { CustomProviderAdapter } from './src/adapter.js';
import { healthKeys, modelsOf, normalizeConfig } from './src/normalize.js';
import { HealthStore, defaultStatePath } from './src/health.js';
import { buildChatCompletionsUrl } from './src/openai.js';

export { Config } from './src/config.js';

/** Cordis plugin name, and the row id declared by `cordis.patch.yml`. */
export const name = 'custom-provider';

/** The package name the Client module graph keys this bundle's browser half by. */
export const PACKAGE = '@local/dsh-custom-provider';

/** The LLM seam this row publishes a provider route to. */
export const inject = ['llm'];

/** Route prefix for the browser half's own endpoints. */
export const API_PREFIX = '/api/custom-provider';

/** Byte cap for a request body we accept. */
const BODY_MAX_BYTES = 256 * 1024;

/**
 * The Harness's own LLM package, when this plugin can reach it.
 *
 * It supplies `LlmError`, whose `code` survives the runtime's failure
 * normalisation (a bare `Error` degrades to `UNKNOWN`), and
 * `attributionHeaders()`, which every provider request is required to carry.
 * When the import fails the plugin still loads and still serves requests, with
 * a local error class and a minimal user agent.
 */
let harnessLlm = {};
try {
  harnessLlm = await import('@deepseek-ai/dsh-llm');
} catch {
  harnessLlm = {};
}

/** Distinctive user agent used when `attributionHeaders()` is unavailable. */
const FALLBACK_ATTRIBUTION = Object.freeze({ 'user-agent': 'dsh-custom-provider' });

/** Headers every upstream request must carry. */
function attribution() {
  try {
    const headers = harnessLlm.attributionHeaders?.();
    if (headers !== null && typeof headers === 'object') return { ...headers };
  } catch {
    // Fall through to the local string.
  }
  return { ...FALLBACK_ATTRIBUTION };
}

/**
 * Build the error class used for configuration-time failures.
 *
 * @returns {(message: string, code: string) => Error} the constructor.
 */
function errorFactory() {
  const LlmError = harnessLlm.LlmError;
  if (typeof LlmError === 'function') return (message, code) => new LlmError(message, code);
  return (message, code) => Object.assign(new Error(message), { name: 'LlmError', code });
}

/** Read one config field, whether the loader handed an accessor or a value. */
function readField(field, fallback) {
  if (field === null || field === undefined) return fallback;
  if (typeof field.get === 'function') return field.get();
  return field;
}

/** A short human label for one failure class, for the rotation log line. */
function failureLabel(reason) {
  if (reason === 'quota') return '额度用尽';
  if (reason === 'transient') return '临时故障';
  return '错误';
}

/** True when no piece of the raw config changed identity since the last read. */
function sameRaw(left, right) {
  if (left === null || right === null) return false;
  for (const key of Object.keys(right)) if (left[key] !== right[key]) return false;
  return true;
}

/** Write one JSON response. */
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(body);
}

/** True when a request does not come from another site. */
function isSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/**
 * Read a small JSON body.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {Promise<object | null>} the parsed object, or null when absent or invalid.
 */
async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_MAX_BYTES) return null;
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Mount the plugin.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the row's Cordis context.
 * @param {object} config - the row's effective config, whose volatile fields are accessors.
 */
export function apply(ctx, config) {
  const settingsNs = ctx.fiber?.entry?.options?.id ?? name;
  const health = new HealthStore({ path: defaultStatePath() });
  health.load();

  /** @type {import('./src/normalize.js').NormalizedConfig | null} */
  let memo = null;
  let lastRaw = null;

  /** The current configuration, normalized and memoized by identity. */
  const readConfig = () => {
    const raw = {
      providerId: readField(config?.providerId, ''),
      displayName: readField(config?.displayName, ''),
      keys: readField(config?.keys, []),
      models: readField(config?.models, []),
      entries: readField(config?.entries, []),
      cooldownMinutes: readField(config?.cooldownMinutes, undefined),
      idleTimeoutMs: readField(config?.idleTimeoutMs, undefined),
      failoverOnTransient: readField(config?.failoverOnTransient, undefined),
      failoverOnAnyError: readField(config?.failoverOnAnyError, undefined),
      extraQuotaPatterns: readField(config?.extraQuotaPatterns, []),
    };
    if (memo !== null && sameRaw(lastRaw, raw)) return memo;
    lastRaw = raw;
    memo = normalizeConfig(raw);
    return memo;
  };

  const adapter = new CustomProviderAdapter({
    readConfig,
    health,
    resolveCredential: async (ref) => {
      const credentials = ctx.get('credentials');
      if (credentials !== undefined) {
        const resolved = await credentials.resolve(ref);
        if (resolved !== undefined && typeof resolved.value === 'string' && resolved.value.length > 0) {
          return resolved.value;
        }
      }
      const fromEnvironment = process.env[ref];
      return typeof fromEnvironment === 'string' && fromEnvironment.length > 0 ? fromEnvironment : undefined;
    },
    readImage: (ref, target, signal) => ctx.get('attachments')?.readImageRequest(ref, target, signal),
    attribution,
    makeError: errorFactory(),
    // A rotation is invisible in the answer, so it is announced where an
    // operator looks: the Harness log now, and the configuration page later.
    onRotation: (record, _model, from, to) => {
      ctx.logger?.warn?.(
        `custom-provider: 模型 "${record.modelId}" 从候选 "${from.id}" 降级到 "${to.id}"`
        + `（${failureLabel(record.reason)} ${record.code}）${record.detail}`,
      );
    },
  });

  /** @type {string | null} */
  let routeId = null;
  /** @type {ReturnType<typeof ctx.llm.registerAdapter> | null} */
  let routeHandle = null;
  /** Why the route is not what the configuration asks for, if it is not. */
  let routeError = '';

  /**
   * Bring the registration in step with `providerId`.
   *
   * `replace` is atomic: a route already owned by another adapter leaves the
   * previous routes serving and is reported instead of throwing out of a
   * settings write.
   */
  const syncRoute = () => {
    const wanted = readConfig().providerId;
    if (routeId === wanted && routeHandle !== null) return;
    try {
      if (routeHandle === null) {
        routeHandle = ctx.llm.registerAdapter([wanted], adapter);
      } else {
        routeHandle.replace([wanted]);
      }
      routeId = wanted;
      routeError = '';
    } catch (error) {
      routeError = error instanceof Error ? error.message : String(error);
      ctx.logger?.error?.(`custom-provider: cannot serve route "${wanted}": ${routeError}`);
    }
  };

  syncRoute();

  // A non-volatile config change remounts the row and re-runs apply; a volatile
  // one swaps the value in place and lands here, where the route id may have
  // moved and the candidate keys the health table holds may have been rewritten.
  ctx.on('loader/volatile-update', () => {
    try {
      syncRoute();
      health.prune(healthKeys(readConfig()));
    } catch (error) {
      ctx.logger?.error?.(
        `custom-provider: configuration update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // The generic settings surface renders nothing for this namespace: the plugin
  // page is the editor.
  ctx.inject(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });

  /**
   * Whether the browser half is in the Client module graph.
   *
   * The Host composes that graph from every mounted bundle's `dsh.client`
   * declaration. Reporting it here turns "refresh the page and hope" into an
   * answer, and it is the one part of this plugin the Host half cannot otherwise
   * observe.
   *
   * @returns {{ linked: boolean, reason?: string }} the link state.
   */
  const clientLink = () => {
    try {
      const modules = ctx.get('clientModules');
      if (modules === undefined) return { linked: false, reason: 'clientModules service is not mounted' };
      const graph = modules.graph();
      const seen = new Set();
      const walk = (node) => {
        if (node === null || typeof node !== 'object') return false;
        if (seen.has(node)) return false;
        seen.add(node);
        if (Array.isArray(node)) return node.some(walk);
        if (node.id === PACKAGE) return true;
        return Object.values(node).some(walk);
      };
      return walk(graph) ? { linked: true } : { linked: false, reason: 'not present in the Client module graph' };
    } catch (error) {
      return { linked: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };

  /**
   * The snapshot the browser half reads: every model with its candidates' live
   * health, plus configuration diagnostics and the route's real state.
   *
   * @returns {object} the state payload.
   */
  const statePayload = () => {
    const current = readConfig();
    const at = Date.now();
    return {
      ok: true,
      settingsNs,
      route: { id: routeId, registered: routeHandle !== null, error: routeError },
      client: clientLink(),
      providerId: current.providerId,
      displayName: current.displayName,
      diagnostics: current.diagnostics,
      healthPath: health.path,
      lastRotation: health.lastRotation() ?? null,
      keyIds: current.keys.map((key) => ({ id: key.id, name: key.name, credential: key.credentialRef.length > 0 })),
      models: current.models.map((model) => ({
        id: model.id,
        name: model.name,
        enabled: model.enabled,
        index: model.index,
        usable: model.usableCandidates.length > 0,
        candidates: model.candidates.map((candidate) => ({
          id: candidate.id,
          key: candidate.key,
          name: candidate.name,
          enabled: candidate.enabled,
          index: candidate.index,
          status: health.status(candidate.key, at),
        })),
      })),
    };
  };

  /**
   * Ask one candidate's endpoint what models it advertises.
   *
   * @param {import('./src/normalize.js').NormalizedCandidate} candidate - the candidate.
   * @returns {Promise<object>} a small diagnostic result.
   */
  const probe = async (candidate) => {
    const key = await adapter.keyFor(candidate);
    const url = new URL(buildChatCompletionsUrl(candidate.baseURL));
    url.pathname = url.pathname.replace(/\/chat\/completions$/u, '/models');
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(key.length > 0 ? { authorization: `Bearer ${key}` } : {}),
        ...attribution(),
        ...candidate.headers,
      },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    if (!response.ok) return { ok: false, status: response.status, detail: text.slice(0, 400) };
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return { ok: false, status: response.status, detail: '端点返回的不是 JSON' };
    }
    const listed = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : [];
    const ids = listed
      .map((item) => (typeof item?.id === 'string' ? item.id : typeof item === 'string' ? item : undefined))
      .filter((id) => typeof id === 'string');
    return { ok: true, status: response.status, count: ids.length, sample: ids.slice(0, 40) };
  };

  ctx.inject(['webServer'], (child) => {
    child.effect(() => {
      const disposers = [
        child.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/state`,
          handler: (req, res) => {
            if (!isSameOrigin(req)) return json(res, 403, { ok: false, error: 'cross-site request rejected' });
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
            try {
              return json(res, 200, statePayload());
            } catch (error) {
              return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
          },
        }),
        child.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/reset`,
          handler: async (req, res) => {
            if (!isSameOrigin(req)) return json(res, 403, { ok: false, error: 'cross-site request rejected' });
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
            const body = await readJsonBody(req);
            if (body === null) return json(res, 400, { ok: false, error: 'invalid body' });
            const key = typeof body.key === 'string' ? body.key : '';
            const cleared = key.length > 0 ? (health.clear(key) ? 1 : 0) : health.clearAll();
            return json(res, 200, { ok: true, cleared, state: statePayload() });
          },
        }),
        child.webServer.register({
          kind: 'exact',
          path: `${API_PREFIX}/probe`,
          handler: async (req, res) => {
            if (!isSameOrigin(req)) return json(res, 403, { ok: false, error: 'cross-site request rejected' });
            if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' });
            const body = await readJsonBody(req);
            if (body === null) return json(res, 400, { ok: false, error: 'invalid body' });
            const current = readConfig();
            const model = current.models.find((candidate) => candidate.id === body.model);
            const candidate = model?.candidates.find((entry) => entry.id === body.candidate);
            if (model === undefined || candidate === undefined) {
              return json(res, 404, { ok: false, error: `未知候选：${String(body.model)} / ${String(body.candidate)}` });
            }
            try {
              return json(res, 200, { ok: true, result: await probe(candidate) });
            } catch (error) {
              return json(res, 200, {
                ok: true,
                result: { ok: false, detail: error instanceof Error ? error.message : String(error) },
              });
            }
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'custom-provider: routes');
  });
}
