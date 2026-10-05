/**
 * The fallback adapter.
 *
 * One provider route serves a set of **logical models**. A request names one of
 * them — `ds-free`, say — and the adapter rotates **inside that model's own
 * candidate list**, in the operator's order. The rotation never leaves the
 * model: if every `ds-free` candidate is out of quota, the caller hears that
 * `ds-free` failed, rather than silently receiving an answer from a different
 * model it never selected.
 *
 * Two rules keep the behaviour honest:
 *
 * 1. **Failover happens before the first visible chunk.** Once a candidate has
 *    produced text, reasoning or a tool call, the caller has already received
 *    it and there is no way to un-send it, so a later failure ends the turn
 *    instead of splicing a second attempt onto the first. Quota exhaustion and
 *    connection faults are decided before the first byte, so this covers the
 *    cases the cascade exists for.
 * 2. **The adapter owns retrying.** It reports a `maxRetries: 0` provider retry
 *    policy, so the shared retry executor never re-runs a candidate behind the
 *    cascade's back.
 *
 * @module @local/dsh-custom-provider/adapter
 */

import { buildChatPayload, mapUsage } from './convert.js';
import { attemptMaxTokens, effectiveLimits, modelOf, modelsOf } from './normalize.js';
import { ProviderFailureError, streamChatCompletion } from './openai.js';
import { describePlan, planAttempts } from './plan.js';
import { classifyIncompleteStream } from './quota.js';

/**
 * Retry policy reported for every route: the cascade is the retry mechanism.
 *
 * `retryableCodes` must be non-empty even at zero retries, so it names a code
 * this adapter never emits.
 */
export const PROVIDER_RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze(['NEVER_RETRY_IN_ADAPTER']),
  initialDelayMs: 500,
  maxDelayMs: 1000,
  jitterRatio: 0,
});

/** Keys an endpoint may use for a reasoning delta, in preference order. */
const REASONING_KEYS = Object.freeze(['reasoning_content', 'reasoning', 'thinking']);

/** Fallback error constructor used when the Harness's `LlmError` is unavailable. */
function defaultMakeError(message, code) {
  const error = new Error(message);
  error.name = 'LlmError';
  error.code = code;
  return error;
}

/**
 * Accept a configured key, or refuse it with the reason.
 *
 * Mirrors the Models page rule: a key is trimmed, and must consist of the
 * printable ASCII an HTTP header can carry. The key itself never appears in the
 * message.
 *
 * @param {string} raw - the configured or resolved key.
 * @param {string} where - model/candidate and credential reference, for the diagnostic.
 * @param {(message: string, code: string) => Error} makeError - error constructor.
 * @returns {string} the trimmed key, possibly empty.
 */
export function normalizeApiKey(raw, where, makeError = defaultMakeError) {
  const value = String(raw ?? '').trim();
  if (value.length === 0) return '';
  // eslint-disable-next-line no-control-regex
  if (/[^\x21-\x7E]/u.test(value)) {
    throw makeError(`自定义供应商：${where} 的 API Key 含有 HTTP 头无法携带的字符`, 'INVALID_CREDENTIAL');
  }
  return value;
}

/** Build one `finish` chunk carrying a failure. */
function errorFinish(failure, message) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: message ?? (failure.detail.length > 0 ? failure.detail : failure.code),
        code: failure.code,
        ...(failure.status === undefined ? {} : { status: failure.status }),
        ...(failure.retryAfterMs === undefined || failure.retryAfterMs <= 0
          ? {}
          : { providerRetryAfterMs: failure.retryAfterMs }),
      },
    },
  };
}

/** Build one `finish` chunk reporting caller cancellation. */
function abortedFinish(failure) {
  return {
    type: 'finish',
    reason: { kind: 'aborted', failure: { message: failure.detail, code: failure.code } },
  };
}

/** Map a provider finish reason onto the Harness vocabulary. */
function finishReasonOf(reason) {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool-calls' };
    case 'length':
    case 'max_tokens':
      return { kind: 'max-tokens' };
    default:
      return { kind: 'stop' };
  }
}

/**
 * Accumulates one attempt's content blocks and turns provider deltas into
 * Harness `StreamChunk`s with stable indices.
 */
class BlockTracker {
  constructor() {
    this.nextIndex = 0;
    this.textIndex = -1;
    this.text = '';
    this.textOpen = false;
    this.reasoningIndex = -1;
    this.reasoning = '';
    this.reasoningOpen = false;
    /** @type {Map<unknown, { index: number, id: string, name: string, args: string }>} */
    this.tools = new Map();
  }

  /** True when any visible content was produced. */
  get visible() {
    return this.textIndex >= 0 || this.reasoningIndex >= 0 || this.tools.size > 0;
  }

  /**
   * Translate one `choices[0].delta` object.
   *
   * @param {any} delta - the provider delta.
   * @returns {object[]} the chunks to emit, in order.
   */
  apply(delta) {
    if (delta === null || typeof delta !== 'object') return [];
    /** @type {object[]} */
    const chunks = [];

    const reasoning = REASONING_KEYS.map((key) => delta[key]).find(
      (value) => typeof value === 'string' && value.length > 0,
    );
    if (reasoning !== undefined) {
      if (!this.reasoningOpen) {
        this.reasoningIndex = this.nextIndex++;
        this.reasoningOpen = true;
        chunks.push({ type: 'block-start', index: this.reasoningIndex, blockType: 'reasoning' });
      }
      this.reasoning += reasoning;
      chunks.push({ type: 'reasoning-delta', index: this.reasoningIndex, text: reasoning });
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      if (!this.textOpen) {
        this.textIndex = this.nextIndex++;
        this.textOpen = true;
        chunks.push({ type: 'block-start', index: this.textIndex, blockType: 'text' });
      }
      this.text += delta.content;
      chunks.push({ type: 'text-delta', index: this.textIndex, text: delta.content });
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const [position, call] of delta.tool_calls.entries()) {
        const key = call?.index ?? call?.id ?? position;
        let slot = this.tools.get(key);
        if (slot === undefined) {
          slot = { index: this.nextIndex++, id: '', name: '', args: '' };
          this.tools.set(key, slot);
          chunks.push({ type: 'block-start', index: slot.index, blockType: 'tool-call' });
        }
        if (typeof call?.id === 'string' && call.id.length > 0) slot.id = call.id;
        if (typeof call?.function?.name === 'string' && call.function.name.length > 0) slot.name = call.function.name;
        const argumentDelta = typeof call?.function?.arguments === 'string' ? call.function.arguments : '';
        slot.args += argumentDelta;
        chunks.push({
          type: 'tool-call-delta',
          index: slot.index,
          id: slot.id,
          ...(slot.name.length > 0 ? { name: slot.name } : {}),
          argumentsDelta: argumentDelta,
        });
      }
    }

    return chunks;
  }

  /** Close every block that is still open, in index order. */
  close() {
    /** @type {object[]} */
    const chunks = [];
    if (this.reasoningOpen) {
      chunks.push({ type: 'block-end', index: this.reasoningIndex, block: { type: 'reasoning', text: this.reasoning } });
      this.reasoningOpen = false;
    }
    if (this.textOpen) {
      chunks.push({ type: 'block-end', index: this.textIndex, block: { type: 'text', text: this.text } });
      this.textOpen = false;
    }
    for (const slot of this.tools.values()) {
      chunks.push({
        type: 'block-end',
        index: slot.index,
        block: { type: 'tool-call', id: slot.id, name: slot.name, arguments: slot.args },
      });
    }
    this.tools.clear();
    return chunks.sort((left, right) => left.index - right.index);
  }
}

/**
 * The provider route's adapter.
 *
 * Every dependency the adapter needs beyond pure logic is injected, so the
 * whole cascade is exercisable in a test with a stub config, a stub health
 * store and a local HTTP server.
 */
export class CustomProviderAdapter {
  /**
   * @param {object} options - construction options.
   * @param {() => import('./normalize.js').NormalizedConfig} options.readConfig - current configuration.
   * @param {import('./health.js').HealthStore} options.health - durable health table.
   * @param {(ref: string) => Promise<string | undefined>} [options.resolveCredential] - credential resolver.
   * @param {(ref: any, target: any, signal?: AbortSignal) => Promise<any>} [options.readImage] - request-image reader.
   * @param {() => Record<string, string>} [options.attribution] - headers every provider request must carry.
   * @param {(message: string, code: string) => Error} [options.makeError] - error constructor.
   * @param {typeof streamChatCompletion} [options.streamImpl] - stream client, injectable for tests.
   * @param {(record: object, model: object, from: object, to: object) => void} [options.onRotation] - told when a model degrades.
   */
  constructor(options) {
    this.readConfig = options.readConfig;
    this.health = options.health;
    this.resolveCredential = options.resolveCredential;
    this.readImage = options.readImage;
    this.attribution = options.attribution ?? (() => ({}));
    this.makeError = options.makeError ?? defaultMakeError;
    this.streamImpl = options.streamImpl ?? streamChatCompletion;
    this.onRotation = options.onRotation;
  }

  /** @returns {import('./normalize.js').NormalizedConfig} the current configuration. */
  config() {
    return this.readConfig();
  }

  /**
   * Describe the route.
   *
   * @param {string} provider - the registered route id.
   * @returns {{ id: string, name: string }} route metadata.
   */
  providerInfo(provider) {
    return { id: provider, name: this.config().displayName };
  }

  /** The cascade is the retry mechanism; the shared executor must stay out of it. */
  providerRetryPolicy() {
    return PROVIDER_RETRY_POLICY;
  }

  /** Declare no provider-side image pricing; the token meter uses its own estimate. */
  imageRequestPricing() {
    return undefined;
  }

  /**
   * Advertise one model per usable logical model — never one per candidate.
   *
   * The route id is taken from the argument, not from the configuration, so a
   * registration that survived a rejected `providerId` change still describes
   * the route it actually owns.
   *
   * @param {string} provider - the registered route id.
   * @returns {Promise<object[]>} model metadata.
   */
  async listModels(provider) {
    return modelsOf(this.config()).map((model) => ({ ...model, provider }));
  }

  /**
   * Resolve one model id into the metadata the caller needs.
   *
   * @param {string} provider - the registered route id.
   * @param {string} model - the model id.
   * @returns {Promise<object>} resolved model metadata.
   * @throws {Error} when the id is not a usable model.
   */
  async resolveModel(provider, model) {
    const resolved = modelOf(this.config(), model);
    if (resolved === undefined) {
      throw this.makeError(`自定义供应商：模型 "${model}" 不在可用列表里（可能已删除、停用或候选都没填完整）`, 'UNKNOWN_MODEL');
    }
    // Report the *effective* capability: the smallest ceiling any usable
    // candidate accepts. Reporting the model's own numbers would let the
    // harness pick a default the fallback endpoint then refuses.
    const limits = effectiveLimits(resolved);
    return {
      provider,
      id: resolved.id,
      name: resolved.name,
      context: { contextWindow: limits.contextWindow },
      defaultMaxTokens: limits.maxTokens,
      inputModalities: [...resolved.input],
    };
  }

  /**
   * Bind model metadata and dispatch together, as the seam requires.
   *
   * @param {string} provider - the registered route id.
   * @param {string} model - the model id.
   * @param {AbortSignal} [signal] - cancellation for model resolution.
   * @returns {Promise<{ model: object, stream: (options: any) => AsyncIterable<object> }>} the prepared call.
   */
  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.stream(options),
    };
  }

  /**
   * Resolve the key one attempt must send.
   *
   * @param {import('./normalize.js').NormalizedCandidate} candidate - the candidate.
   * @returns {Promise<string>} the key, possibly empty.
   * @throws {Error} when a referenced credential is missing.
   */
  async keyFor(candidate) {
    if (candidate.credentialRef.length > 0) {
      const resolved = await this.resolveCredential?.(candidate.credentialRef);
      if (typeof resolved !== 'string' || resolved.length === 0) {
        throw this.makeError(
          `自定义供应商：候选 "${candidate.key}" 引用的凭据 "${candidate.credentialRef}" 没有配置`,
          'MISSING_CREDENTIAL',
        );
      }
      return normalizeApiKey(resolved, `凭据 "${candidate.credentialRef}"`, this.makeError);
    }
    return normalizeApiKey(candidate.apiKey, `候选 "${candidate.key}"`, this.makeError);
  }

  /**
   * Perform one attempt against one candidate.
   *
   * @param {import('./normalize.js').NormalizedCandidate} candidate - the candidate.
   * @param {import('./normalize.js').NormalizedModel} model - the model being served.
   * @param {any} options - the request.
   * @param {import('./normalize.js').NormalizedConfig} config - the configuration in force.
   * @returns {AsyncGenerator<object>} Harness chunks, ending with usage and finish.
   * @throws {ProviderFailureError} when the attempt fails.
   */
  async *attempt(candidate, model, options, config) {
    const apiKey = await this.keyFor(candidate);
    const payload = await buildChatPayload(options, {
      model,
      // The candidate's own ceiling caps whatever the caller resolved.
      maxTokens: attemptMaxTokens(options.maxTokens, candidate, model),
      readImage: this.readImage,
      signal: options.signal,
    });
    const tracker = new BlockTracker();
    let finished = false;
    let sawDone = false;
    let finishReason;
    let usage;

    for await (const item of this.streamImpl({
      baseURL: candidate.baseURL,
      apiKey,
      model: candidate.model,
      payload,
      headers: { ...this.attribution(), ...candidate.headers },
      signal: options.signal,
      timeoutMs: config.idleTimeoutMs,
      extraQuotaPatterns: config.extraQuotaPatterns,
    })) {
      if (item.kind === 'done') {
        sawDone = item.sawDone === true;
        break;
      }
      const chunk = item.data;
      if (chunk === null || typeof chunk !== 'object') continue;
      if (chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
      if (choice === null || typeof choice !== 'object') continue;
      for (const emitted of tracker.apply(choice.delta)) yield emitted;
      if (typeof choice.finish_reason === 'string' && choice.finish_reason.length > 0) {
        finishReason = choice.finish_reason;
        finished = true;
      }
    }

    if (!finished && !sawDone && !tracker.visible) {
      // The connection ended before the provider said anything at all.
      throw new ProviderFailureError(classifyIncompleteStream());
    }
    if (finishReason === 'content_filter') {
      throw new ProviderFailureError({ kind: 'fatal', code: 'CONTENT_FILTER', detail: '内容被上游安全过滤拦截' });
    }
    if (!tracker.visible && (finishReason === undefined || finishReason === 'stop')) {
      // A completed turn with no content would be reported as a normal empty
      // turn, silently ending the step. Name it instead.
      throw new ProviderFailureError({
        kind: 'fatal',
        code: 'EMPTY_RESPONSE',
        detail: `候选 "${candidate.key}" 返回了空响应（无文本、无工具调用）`,
      });
    }

    for (const emitted of tracker.close()) yield emitted;
    if (usage !== undefined) yield { type: 'usage', usage: mapUsage(usage) };
    yield { type: 'finish', reason: finishReasonOf(finishReason) };
  }

  /**
   * Record a failure in the health table, under the candidate's key.
   *
   * @param {import('./normalize.js').NormalizedCandidate} candidate - the failed candidate.
   * @param {import('./quota.js').Failure} failure - the classification.
   * @param {import('./normalize.js').NormalizedConfig} config - the configuration in force.
   */
  record(candidate, failure, config) {
    if (failure.kind === 'quota') {
      this.health.markQuota(candidate.key, { code: failure.code, detail: failure.detail });
      return;
    }
    if (failure.kind === 'transient') {
      this.health.markCooldown(candidate.key, config.cooldownMs, { code: failure.code, detail: failure.detail });
    }
  }

  /**
   * Should a classified failure move on to the next candidate?
   *
   * @param {import('./quota.js').Failure} failure - the classification.
   * @param {import('./normalize.js').NormalizedConfig} config - the configuration in force.
   * @returns {boolean} true when the cascade continues.
   */
  shouldFailover(failure, config) {
    if (failure.kind === 'quota') return true;
    if (failure.kind === 'transient') return config.failoverOnTransient;
    if (failure.kind === 'aborted') return false;
    return config.failoverOnAnyError;
  }

  /**
   * Announce that a model is about to be served by its next candidate.
   *
   * The caller cannot see this in the answer — the reply simply arrives from
   * somewhere else — so it is recorded for the configuration page and reported
   * to the Harness log at the same moment.
   *
   * @param {import('./normalize.js').NormalizedModel} model - the model that degraded.
   * @param {import('./normalize.js').NormalizedCandidate} from - the candidate that failed.
   * @param {import('./normalize.js').NormalizedCandidate} to - the candidate taking over.
   * @param {import('./quota.js').Failure} failure - the classification.
   */
  rotate(model, from, to, failure) {
    const record = {
      modelId: model.id,
      from: from.key,
      to: to.key,
      reason: failure.kind,
      code: failure.code,
      detail: failure.detail,
    };
    this.health.noteRotation(record);
    try {
      this.onRotation?.(record, model, from, to);
    } catch {
      // A logging callback must never break the request it is describing.
    }
  }

  /**
   * Stream one call, rotating inside the named model's own candidates.
   *
   * @param {any} options - the request.
   * @returns {AsyncGenerator<object>} Harness chunks.
   */
  async *stream(options) {
    const config = this.config();
    const model = modelOf(config, options.model);

    if (model === undefined) {
      const detail = `自定义供应商：模型 "${options.model}" 不在可用列表里（可能已删除、停用或候选都没填完整）`;
      yield errorFinish({ kind: 'fatal', code: 'UNKNOWN_MODEL', detail }, detail);
      return;
    }

    const plan = planAttempts(model, (candidate) => this.health.status(candidate.key));
    if (plan.failure !== undefined) {
      yield errorFinish({ kind: 'fatal', code: 'NO_CANDIDATE', detail: plan.failure }, plan.failure);
      return;
    }

    /** @type {Array<{ candidate: import('./normalize.js').NormalizedCandidate, failure: import('./quota.js').Failure }>} */
    const failures = [];
    const skippedNote = plan.skipped.length > 0
      ? `（已跳过 ${plan.skipped
          .map((item) => `${item.candidate.id}:${item.reason === 'quota' ? '额度用尽' : '冷却中'}`)
          .join('、')}）`
      : '';

    for (const [position, candidate] of plan.attempts.entries()) {
      let emitted = false;
      try {
        for await (const chunk of this.attempt(candidate, model, options, config)) {
          if (chunk.type !== 'usage') emitted = true;
          yield chunk;
        }
        this.health.markSuccess(candidate.key);
        return;
      } catch (error) {
        const failure = error instanceof ProviderFailureError
          ? error.failure
          : {
              kind: 'fatal',
              code: typeof error?.code === 'string' && error.code.length > 0 ? error.code : 'ADAPTER_ERROR',
              detail: error instanceof Error ? error.message : String(error),
            };

        if (failure.kind === 'aborted') {
          yield abortedFinish(failure);
          return;
        }
        this.record(candidate, failure, config);
        failures.push({ candidate, failure });

        if (emitted) {
          yield errorFinish(
            failure,
            `自定义供应商：模型 "${model.id}" 的候选 "${candidate.id}" 在已输出内容后失败，本次不再降级。${failure.detail}`,
          );
          return;
        }
        if (!this.shouldFailover(failure, config)) {
          yield errorFinish(failure, `自定义供应商：模型 "${model.id}" 的候选 "${candidate.id}" 失败且不满足降级条件：${failure.detail}`);
          return;
        }
        const next = plan.attempts[position + 1];
        if (next !== undefined) this.rotate(model, candidate, next, failure);
      }
    }

    const last = failures.at(-1);
    const chain = failures.map((item) => `${item.candidate.id}(${item.failure.code})`).join(' → ');
    yield errorFinish(
      last?.failure ?? { kind: 'fatal', code: 'NO_CANDIDATE', detail: '没有可用候选' },
      `自定义供应商：模型 "${model.id}" 的候选全部失败 ${chain}${skippedNote}；计划 ${describePlan(plan)}`,
    );
  }
}
