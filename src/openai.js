/**
 * Minimal OpenAI-compatible Chat Completions streaming client.
 *
 * Deliberately dependency-free: Node's global `fetch` plus a hand-rolled SSE
 * reader. The Harness may be offline when the plugin is installed, and the
 * request shape this provider needs (one endpoint, one bearer key, one model
 * per candidate) is small enough that a general SDK would only add version
 * coupling to a package that lives outside the asar.
 *
 * The client's only jobs are: perform one request, surface a *classified*
 * failure, and hand parsed chunk objects to the adapter. It never decides which
 * candidate to try next.
 *
 * @module @local/dsh-custom-provider/openai
 */

import {
  classifyHttpFailure,
  classifyStreamError,
  classifyTransportFailure,
  clip,
} from './quota.js';

/** How much of an error body we are willing to read. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;

/**
 * A classified provider failure, thrown out of the stream client.
 *
 * Carries the {@link import('./quota.js').Failure} so the adapter can act on
 * `kind` without re-inspecting strings.
 */
export class ProviderFailureError extends Error {
  /**
   * @param {import('./quota.js').Failure} failure - the classification.
   * @param {object} [options] - construction options.
   * @param {unknown} [options.cause] - the underlying error, when any.
   */
  constructor(failure, { cause } = {}) {
    super(failure.detail.length > 0 ? failure.detail : failure.code, cause === undefined ? undefined : { cause });
    this.name = 'ProviderFailureError';
    /** The classified failure. */
    this.failure = failure;
  }
}

/**
 * Turn a configured base URL into the Chat Completions endpoint.
 *
 * Operators paste everything: `https://host/v1`, `https://host/v1/`, a gateway
 * URL that already names `/chat/completions`, or a bespoke path. An endpoint
 * that already ends in `/chat/completions` is used verbatim; everything else
 * gets the suffix appended once.
 *
 * @param {string} baseURL - the configured URL.
 * @returns {string} the absolute request URL.
 * @throws {Error} when the value is not an http(s) URL.
 */
export function buildChatCompletionsUrl(baseURL) {
  const raw = String(baseURL ?? '').trim();
  if (raw.length === 0) throw new Error('baseURL is empty');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`baseURL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`baseURL must use http or https: ${raw}`);
  }
  const path = url.pathname.replace(/\/+$/u, '');
  if (!/\/chat\/completions$/u.test(path)) {
    url.pathname = `${path}/chat/completions`;
  } else {
    url.pathname = path;
  }
  url.search = '';
  url.hash = '';
  return url.href;
}

/**
 * Read at most `maxBytes` of a response body as text.
 *
 * @param {Response} response - the failure response.
 * @param {number} [maxBytes] - byte cap.
 * @returns {Promise<string>} the decoded (possibly clipped) body.
 */
async function readBodyText(response, maxBytes = ERROR_BODY_MAX_BYTES) {
  try {
    const body = response.body;
    if (body === null || body === undefined) return await response.text();
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read += value.byteLength;
      text += decoder.decode(value, { stream: true });
      if (read >= maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Cancelling a body we already stopped reading is best-effort.
        }
        break;
      }
    }
    text += decoder.decode();
    return text;
  } catch {
    return '';
  }
}

/**
 * Split a byte stream into Server-Sent Events lines.
 *
 * Yields the payload of every `data:` line, in order. Comment lines (`:`),
 * `event:` lines and blank separators are ignored: the OpenAI protocol puts a
 * complete JSON document on each `data:` line and terminates with `[DONE]`, so
 * a line-oriented reader is exactly as capable here as a full SSE parser.
 *
 * @param {AsyncIterable<Uint8Array>} chunks - the response body.
 * @returns {AsyncGenerator<string>} decoded data payloads.
 */
export async function* sseDataLines(chunks) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      const payload = dataLinePayload(line);
      if (payload !== undefined) yield payload;
    }
  }
  buffer += decoder.decode();
  if (buffer.length > 0) {
    const payload = dataLinePayload(buffer.replace(/\r$/u, ''));
    if (payload !== undefined) yield payload;
  }
}

/**
 * Extract the payload of one SSE line.
 *
 * @param {string} line - one raw line.
 * @returns {string | undefined} the payload, or undefined when the line carries none.
 */
export function dataLinePayload(line) {
  if (!line.startsWith('data:')) return undefined;
  const value = line.slice(5);
  return value.startsWith(' ') ? value.slice(1) : value;
}

/**
 * One parsed stream item.
 *
 * `sawDone` distinguishes a stream the provider closed properly (`data:
 * [DONE]`) from a body that merely ended, which the adapter needs in order to
 * tell "finished" from "the connection dropped".
 *
 * @typedef {{ kind: 'chunk', data: unknown } | { kind: 'done', sawDone: boolean }} StreamItem
 */

/**
 * Stream one Chat Completions request.
 *
 * `timeoutMs` is an **idle** budget, not a total one: the timer restarts on
 * every byte the endpoint sends, so a long answer is never cut short while a
 * stalled connection is. Aborting the caller's signal aborts the request and
 * classifies as `aborted`, which the adapter reports as a cancellation rather
 * than a provider failure.
 *
 * @param {object} request - the request to perform.
 * @param {string} request.baseURL - candidate endpoint.
 * @param {string} [request.apiKey] - resolved bearer key; empty sends none.
 * @param {string} request.model - upstream model id.
 * @param {object} request.payload - the Chat Completions body (minus stream fields).
 * @param {Record<string, string>} [request.headers] - extra headers, e.g. for gateways that want `x-api-key`.
 * @param {AbortSignal} [request.signal] - caller cancellation.
 * @param {number} [request.timeoutMs] - idle timeout in milliseconds.
 * @param {typeof fetch} [request.fetchImpl] - fetch implementation, injectable for tests.
 * @param {readonly string[]} [request.extraQuotaPatterns] - operator quota phrases.
 * @returns {AsyncGenerator<StreamItem>} parsed stream items, ending with `{ kind: 'done' }`.
 * @throws {ProviderFailureError} when the request or the stream fails.
 */
export async function* streamChatCompletion({
  baseURL,
  apiKey = '',
  model,
  payload,
  headers = {},
  signal,
  timeoutMs = 300_000,
  fetchImpl = fetch,
  extraQuotaPatterns = [],
}) {
  const url = buildChatCompletionsUrl(baseURL);
  const controller = new AbortController();
  let timedOut = false;
  let cancelled = false;

  const onAbort = () => {
    cancelled = true;
    controller.abort(signal?.reason);
  };
  if (signal?.aborted === true) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  let timer;
  const armTimer = () => {
    if (!(timeoutMs > 0)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('idle timeout'));
    }, timeoutMs);
    // Never hold the event loop open on account of an idle guard.
    timer.unref?.();
  };
  armTimer();

  const requestHeaders = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...(apiKey.length > 0 ? { authorization: `Bearer ${apiKey}` } : {}),
    ...headers,
  };

  try {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          ...payload,
          model,
          stream: true,
          // Ask for the usage frame; endpoints that do not understand it ignore
          // it, endpoints that do stop reporting tokens as an empty final chunk.
          stream_options: { include_usage: true },
        }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new ProviderFailureError(classifyTransportFailure(error, { timedOut, cancelled }));
    }

    if (!response.ok) {
      const bodyText = await readBodyText(response);
      throw new ProviderFailureError(
        classifyHttpFailure({ status: response.status, bodyText, headers: response.headers, extraQuotaPatterns }),
      );
    }
    if (response.body === null || response.body === undefined) {
      throw new ProviderFailureError({
        kind: 'transient',
        code: 'STREAM_INTERRUPTED',
        detail: 'the endpoint returned no response body',
      });
    }

    try {
      for await (const line of sseDataLines(response.body)) {
        armTimer();
        if (line === '[DONE]') {
          yield { kind: 'done', sawDone: true };
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          // Keepalive comments and vendor noise are not protocol violations.
          continue;
        }
        if (parsed !== null && typeof parsed === 'object' && 'error' in parsed && parsed.error !== null) {
          throw new ProviderFailureError(classifyStreamError(parsed.error, extraQuotaPatterns));
        }
        yield { kind: 'chunk', data: parsed };
      }
      // The body ended without `[DONE]`. The adapter decides whether that is a
      // clean end (a finish reason was already seen) or an interrupted stream.
      yield { kind: 'done', sawDone: false };
    } catch (error) {
      if (error instanceof ProviderFailureError) throw error;
      throw new ProviderFailureError(classifyTransportFailure(error, { timedOut, cancelled, midStream: true }));
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Clip a message for a settings/health record.
 *
 * @param {unknown} value - anything.
 * @returns {string} a short single-line rendering.
 */
export function brief(value) {
  if (value instanceof Error) return clip(value.message);
  if (typeof value === 'string') return clip(value);
  try {
    return clip(JSON.stringify(value));
  } catch {
    return clip(String(value));
  }
}
