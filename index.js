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
import { healthKeys, modelsOf, normalizeConfig, reusedProviders, staleReuses } from './src/normalize.js';
import { buildCatalogView } from './src/reuse.js';
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
    // Reuse: hand the call to the route that already serves it. Resolved live
    // from the registry rather than captured at mount, because a route can be
    // registered after this plugin and re-registered during a session; and
    // refused when it names this very route, which would recurse.
    streamVia: (provider, model, options) => {
      if (provider === readConfig().providerId) {
        throw errorFactory()(`自定义供应商：候选路由 "${provider}" 指向本供应方自身，无法复用`, 'REUSE_SELF');
      }
      return ctx.llm.stream({ ...options, provider, model });
    },
    resolveVia: (provider, model, signal) => ctx.llm.resolveModelInfo(provider, model, signal),
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
   * Reuse candidates whose route is not mounted right now.
   *
   * This can only be answered against the live registry, which is why it lives
   * here rather than in the pure normalizer: the configuration is not wrong —
   * the route simply is not there *yet*, or is gone. Either way the request
   * would fail on every attempt, so the configuration page says so up front
   * instead of leaving the operator to infer it from a failed turn.
   *
   * @param {import('./src/normalize.js').NormalizedConfig} config - the normalized config.
   * @returns {Array<{ model: string, candidate: string, provider: string, wanted: string }>} the stale pairs.
   */
  const staleReuse = (config) => {
    const routes = new Set(reusedProviders(config));
    if (routes.size === 0) return [];
    const mounted = new Set(ctx.llm.listProviders().map((provider) => provider.id));
    return staleReuses(config, [...routes].filter((route) => !mounted.has(route)));
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
      staleReuse: staleReuse(current),
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
          provider: candidate.provider,
          reuse: candidate.reuse,
          status: health.status(candidate.key, at),
        })),
      })),
    };
  };

  /**
   * Ask one candidate's endpoint what models it advertises.
   *
   * A reuse candidate has no endpoint of its own to interrogate, so the question
   * becomes the more useful one: does the route it borrows still exist, and does
   * it still advertise the model the candidate names? Answering from the live
   * registry is exactly what an operator wants to know before blaming a key.
   *
   * @param {import('./src/normalize.js').NormalizedCandidate} candidate - the candidate.
   * @returns {Promise<object>} a small diagnostic result.
   */
  const probe = async (candidate) => {
    if (candidate.reuse) {
      const providers = ctx.llm.listProviders();
      const known = providers.find((provider) => provider.id === candidate.provider);
      if (known === undefined) {
        return {
          ok: false,
          detail: `复用路由 "${candidate.provider}" 未挂载（当前已注册：${providers.map((provider) => provider.id).join('、') || '无'}）`,
          mounted: false,
        };
      }
      const models = await ctx.llm.listModels(candidate.provider).catch((error) => {
        // The route exists but could not answer. That is a different problem
        // from a missing route — the fix is on the other provider, not here —
        // so it is reported as such instead of collapsing into one message.
        return { error: error instanceof Error ? error.message : String(error) };
      });
      if (!Array.isArray(models)) {
        return {
          ok: false,
          mounted: true,
          detail: `路由 "${candidate.provider}" 已挂载，但读取模型列表失败：${models.error}`,
        };
      }
      const ids = models.map((model) => model.id);
      const found = ids.includes(candidate.model);
      return {
        ok: found,
        mounted: true,
        status: 200,
        count: ids.length,
        sample: ids.slice(0, 40),
        detail: found
          ? undefined
          : `路由 "${candidate.provider}" 已挂载，但没有暴露模型 "${candidate.model}"`,
      };
    }
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

  /**
   * Every route the registry currently serves, with the models it advertises.
   *
   * This is the answer to "let me reuse a model that already exists": the
   * browser half cannot reach `ctx.llm`, so the Host half projects the live
   * registry for it. Each model carries the capacities the owning adapter
   * publishes, so an import can fill the new model row with real numbers
   * instead of defaults the first request would have to correct.
   *
   * Costs are bounded deliberately: one `listModels` per route, no
   * `resolveModelInfo` per model — the cheap listing is enough to choose from,
   * and the per-model capacity is resolved lazily by the adapter once the model
   * is actually used.
   *
   * @returns {Promise<object>} the catalog payload, with per-route failures kept beside the groups.
   */
  const liveCatalog = async () => {
    const own = readConfig().providerId;
    const providers = ctx.llm.listProviders();
    /** @type {Map<string, { models?: readonly object[], error?: string }>} */
    const listed = new Map();
    await Promise.all(providers.map(async (provider) => {
      try {
        const models = await ctx.llm.listModels(provider.id);
        listed.set(provider.id, { models });
      } catch (error) {
        listed.set(provider.id, { error: error instanceof Error ? error.message : String(error) });
      }
    }));
    return {
      ok: true,
      self: own,
      reused: reusedProviders(readConfig()),
      ...buildCatalogView({ providers, listed, self: own }),
    };
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
          path: `${API_PREFIX}/catalog`,
          handler: async (req, res) => {
            if (!isSameOrigin(req)) return json(res, 403, { ok: false, error: 'cross-site request rejected' });
            if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' });
            try {
              return json(res, 200, await liveCatalog());
            } catch (error) {
              return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
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
