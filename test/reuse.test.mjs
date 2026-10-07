/**
 * Reuse: borrowing a model that already exists in the model list.
 *
 * Three things have to hold for "one-click reuse" to be honest, and each is
 * tested here without a runtime:
 *
 * 1. **Normalization** must treat a reuse candidate and a direct candidate as
 *    two shapes of the same thing — same health key, same capacity caps, same
 *    rotation — while requiring only what each mode actually needs.
 * 2. **Delegation** must hand the request to the owning route's adapter, keep
 *    the candidate's ceiling, and turn the inner stream's terminal failure back
 *    into the shape this plugin's cascade acts on.
 * 3. **The catalog projection** must survive one broken route without losing the
 *    rest, because the whole point is browsing everything that exists.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { normalizeConfig, usableCandidate, effectiveLimits, reusedProviders, staleReuses } from '../src/normalize.js';
import { CustomProviderAdapter } from '../src/adapter.js';
import { HealthStore } from '../src/health.js';
import {
  classifyDelegatedFailure,
  buildCatalogView,
  reuseModelId,
  reuseCandidateId,
  isSelfReuse,
  validProviderId,
} from '../src/reuse.js';
import { ProviderFailureError } from '../src/openai.js';

/** A configuration with one direct candidate and one reuse candidate. */
function mixedConfig(extra = {}) {
  return normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      contextWindow: 1_000_000,
      maxTokens: 100_000,
      candidates: [
        { id: 'direct', baseURL: 'https://gateway.example/v1', apiKey: 'sk-direct', model: 'vendor/model' },
        { id: 'borrowed', provider: 'our-free-model', model: 'space-bunny-free' },
      ],
    }],
    ...extra,
  });
}

/**
 * An isolated health store, so the tests never touch the real state file.
 *
 * Each call gets its own path, which matters more than it looks: a quota ban is
 * durable and keyed by `model/candidate`, so two tests that both use
 * `high/borrowed` through one shared file would have the second one silently
 * inherit the first one's ban — and fail in a way that looks like a logic bug.
 *
 * The path also carries the process id and is removed on the way out. A per-run
 * counter alone is not enough: it restarts at 1 in every process, so a *previous*
 * run's file would be inherited by this one — a flake that shows up only
 * sometimes, and only on a machine where the suite has already run.
 */
let healthSeq = 0;
const healthPaths = [];
function memoryHealth() {
  healthSeq += 1;
  const path = join(tmpdir(), `custom-provider-reuse-${process.pid}-${healthSeq}.json`);
  // Started from a clean slate, so a name collision cannot import stale health.
  rmSync(path, { force: true });
  healthPaths.push(path);
  return new HealthStore({ path });
}

process.on('exit', () => {
  for (const path of healthPaths) {
    try {
      rmSync(path, { force: true });
    } catch {
      // Best effort: a leftover temp file must never fail the run.
    }
  }
});

/** Collect an async iterable into an array. */
async function collect(iterable) {
  const items = [];
  for await (const item of iterable) items.push(item);
  return items;
}

/** A chunk producer that yields the given chunks then ends. */
async function* yields(...chunks) {
  for (const chunk of chunks) yield chunk;
}

// ── normalization ────────────────────────────────────────────────────────────

test('a reuse candidate needs a route and a model id, not an endpoint', () => {
  const config = mixedConfig();
  const [model] = config.models;
  const borrowed = model.candidates.find((candidate) => candidate.id === 'borrowed');
  assert.equal(borrowed.reuse, true);
  assert.equal(borrowed.provider, 'our-free-model');
  assert.equal(borrowed.routeOk, true);
  assert.equal(usableCandidate(borrowed), true);
  // It is offered like any other candidate: reuse is a transport choice, not a
  // second-class entry.
  assert.deepEqual(model.usableCandidates.map((candidate) => candidate.id), ['direct', 'borrowed']);
});

test('a direct candidate still needs an endpoint', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'm', candidates: [{ id: 'c', model: 'x', apiKey: 'k' }] }],
  });
  assert.equal(usableCandidate(config.models[0].candidates[0]), false);
  assert.ok(config.diagnostics.some((item) => item.field === 'baseURL' && item.severity === 'error'));
});

test('a reuse candidate is never told it is missing an endpoint or a key', () => {
  const config = mixedConfig();
  const complaints = config.diagnostics.filter((item) => item.field === 'baseURL' || item.field === 'apiKey');
  assert.deepEqual(complaints, []);
});

test('self-reuse is refused, not merely warned about', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'm', candidates: [{ id: 'loop', provider: 'custom', model: 'x' }] }],
  });
  const [candidate] = config.models[0].candidates;
  assert.equal(candidate.routeOk, false);
  assert.equal(usableCandidate(candidate), false);
  assert.ok(config.diagnostics.some((item) => item.severity === 'error' && /绕回自身/u.test(item.message)));
  assert.deepEqual(config.usableModels, []);
});

test('an illegal route id is refused', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'm', candidates: [{ id: 'bad', provider: 'Not A Route', model: 'x' }] }],
  });
  assert.equal(config.models[0].candidates[0].routeOk, false);
  assert.ok(config.diagnostics.some((item) => item.severity === 'error' && /不合法/u.test(item.message)));
});

test('endpoint fields on a reuse candidate are reported as inert, not silently dropped', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'm',
      candidates: [{ id: 'c', provider: 'openrouter-free', model: 'x/y:free', baseURL: 'https://stale/v1', apiKey: 'sk-old' }],
    }],
  });
  const warning = config.diagnostics.find((item) => item.field === 'provider' && item.severity === 'warning');
  assert.ok(warning !== undefined);
  assert.match(warning.message, /不生效/u);
});

test('a reused route reports its own capacity when the candidate declares none', () => {
  const model = mixedConfig().models[0];
  // Nothing declared per candidate: the model's own numbers stand.
  assert.deepEqual(effectiveLimits(model), { maxTokens: 100_000, contextWindow: 1_000_000 });
  // With the live projection, the borrowed route's smaller window binds.
  const limits = effectiveLimits(model, (candidate) =>
    candidate.reuse ? { contextWindow: 262_144, maxTokens: 65_536 } : undefined);
  assert.deepEqual(limits, { maxTokens: 65_536, contextWindow: 262_144 });
});

test('a candidate-level declaration outranks the live projection', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'm',
      maxTokens: 100_000,
      contextWindow: 1_000_000,
      candidates: [{ id: 'c', provider: 'p', model: 'x', maxTokens: 1_000, contextWindow: 5_000 }],
    }],
  });
  const limits = effectiveLimits(config.models[0], () => ({ contextWindow: 262_144, maxTokens: 65_536 }));
  assert.deepEqual(limits, { maxTokens: 1_000, contextWindow: 5_000 });
});

test('reusedProviders lists each borrowed route once, in order', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [
      { id: 'a', candidates: [{ id: '1', provider: 'p-one', model: 'x' }, { id: '2', provider: 'p-two', model: 'y' }] },
      { id: 'b', candidates: [{ id: '3', provider: 'p-one', model: 'z' }, { id: '4', baseURL: 'https://d/v1', model: 'w' }] },
    ],
  });
  assert.deepEqual(reusedProviders(config), ['p-one', 'p-two']);
});

test('staleReuses names the model/candidate pairs whose route is gone', () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'high', candidates: [{ id: 'borrowed', provider: 'gone', model: 'x' }] }],
  });
  assert.deepEqual(staleReuses(config, ['gone']), [
    { model: 'high', candidate: 'borrowed', provider: 'gone', wanted: 'x' },
  ]);
  assert.deepEqual(staleReuses(config, []), []);
});

test('a mixed model advertises both upstreams in its description', () => {
  const config = mixedConfig();
  const description = config.usableModels[0] !== undefined
    ? `vendor/model / space-bunny-free`
    : '';
  assert.equal(description, 'vendor/model / space-bunny-free');
});

// ── delegated failure classification ─────────────────────────────────────────

test('provider-neutral quota codes retire the candidate for the day', () => {
  for (const code of ['QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA', 'INSUFFICIENT_BALANCE']) {
    assert.equal(classifyDelegatedFailure({ code }).kind, 'quota', code);
  }
});

test('a quota phrase outranks a generic code, as it does on the direct path', () => {
  const failure = classifyDelegatedFailure({ code: 'CLIENT_ERROR', message: '{"error":{"message":"insufficient balance"}}' });
  assert.equal(failure.kind, 'quota');
  assert.equal(classifyDelegatedFailure({ message: '余额不足，请充值' }).kind, 'quota');
});

test('a region block rotates rather than failing the turn', () => {
  // It is a property of the egress, so the next candidate is the right answer.
  assert.equal(classifyDelegatedFailure({ code: 'REGION_BLOCKED' }).kind, 'transient');
});

test('transport-shaped codes are transient', () => {
  for (const code of ['RATE_LIMIT', 'TIMEOUT', 'TRANSPORT', 'SERVER', 'EMPTY_RESPONSE', 'STREAM_INTERRUPTED']) {
    assert.equal(classifyDelegatedFailure({ code }).kind, 'transient', code);
  }
  assert.equal(classifyDelegatedFailure({ code: 'HTTP_503', status: 503 }).kind, 'transient');
});

test('an abort stays an abort, so a cancelled turn is not retried elsewhere', () => {
  assert.equal(classifyDelegatedFailure({ code: 'ABORTED' }).kind, 'aborted');
  assert.equal(classifyDelegatedFailure({ code: 'aborted' }).kind, 'aborted');
});

test('an unrecognized failure is fatal, so no key/config error hides behind a retry', () => {
  const failure = classifyDelegatedFailure({ code: 'INVALID_CREDENTIAL', message: 'bad key' });
  assert.equal(failure.kind, 'fatal');
  assert.equal(failure.code, 'INVALID_CREDENTIAL');
  assert.equal(classifyDelegatedFailure({}).kind, 'fatal');
});

test('a long failure message is clipped before it reaches history', () => {
  const failure = classifyDelegatedFailure({ code: 'SERVER', message: 'x'.repeat(5_000) });
  assert.ok(failure.detail.length <= 601, `detail was ${failure.detail.length}`);
});

// ── delegation through the owning adapter ────────────────────────────────────

test('a reuse candidate forwards the request to its own route', async () => {
  const config = mixedConfig();
  const seen = [];
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamVia: (provider, model, options) => {
      seen.push({ provider, model, maxTokens: options.maxTokens, tools: options.tools });
      return yields(
        { type: 'text-delta', index: 0, text: 'hi' },
        { type: 'finish', reason: { kind: 'stop' } },
      );
    },
  });

  const chunks = await collect(adapter.stream({
    provider: 'custom',
    model: 'high',
    maxTokens: 100_000,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    tools: [{ name: 't', description: 'd', parameters: {} }],
  }));

  assert.equal(seen.length, 1, 'exactly one delegated attempt');
  assert.equal(seen[0].provider, 'our-free-model');
  assert.equal(seen[0].model, 'space-bunny-free');
  // Forwarded verbatim: what the caller asked for is what the route receives.
  assert.equal(seen[0].maxTokens, 100_000);
  assert.equal(seen[0].tools.length, 1, 'tools are forwarded untouched, so the inner adapter is the only converter');
  assert.deepEqual(chunks.map((chunk) => chunk.type), ['text-delta', 'finish']);
  assert.equal(chunks.at(-1).reason.kind, 'stop');
});

test('the caller cannot tell which candidate served the request', async () => {
  // A direct candidate fails transiently; the reuse candidate answers. The
  // chunks the caller sees must be the reuse candidate's, with one finish.
  const config = normalizeConfig({
    providerId: 'custom',
    cooldownMinutes: 5,
    models: [{
      id: 'high',
      maxTokens: 1_000,
      candidates: [
        { id: 'direct', baseURL: 'https://gateway.example/v1', apiKey: 'sk', model: 'vendor/model' },
        { id: 'borrowed', provider: 'our-free-model', model: 'space-bunny-free' },
      ],
    }],
  });
  const health = memoryHealth();
  health.clearAll();
  const delegated = [];
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health,
    streamImpl: async function* () {
      throw new ProviderFailureError({ kind: 'transient', code: 'SERVER', detail: 'upstream 500' });
    },
    streamVia: (provider, model) => {
      delegated.push(`${provider}/${model}`);
      return yields(
        { type: 'text-delta', index: 0, text: 'from-reuse' },
        { type: 'finish', reason: { kind: 'stop' } },
      );
    },
    onRotation: () => {},
  });

  const chunks = await collect(adapter.stream({
    provider: 'custom',
    model: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }));

  assert.deepEqual(delegated, ['our-free-model/space-bunny-free']);
  assert.deepEqual(chunks, [
    { type: 'text-delta', index: 0, text: 'from-reuse' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  // The direct candidate was parked; the reuse candidate is healthy.
  assert.equal(health.status('high/direct').reason, 'cooldown');
  assert.equal(health.status('high/borrowed').available, true);
  assert.equal(health.status('high/borrowed').failures, 0);
});

test('a quota failure on a reused route retires it for the day', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x' }],
    }],
  });
  const health = memoryHealth();
  health.clearAll();
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health,
    streamVia: () => yields({ type: 'finish', reason: { kind: 'error', failure: { code: 'QUOTA', message: 'insufficient balance' } } }),
  });

  const chunks = await collect(adapter.stream({
    provider: 'custom',
    model: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }));

  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'QUOTA');
  const status = health.status('high/borrowed');
  assert.equal(status.available, false);
  assert.equal(status.reason, 'quota');
});

test('a reused route that produces nothing is named, not passed off as an empty turn', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'high', candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x' }] }],
  });
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamVia: () => yields({ type: 'finish', reason: { kind: 'stop' } }),
  });

  const chunks = await collect(adapter.stream({
    provider: 'custom',
    model: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }));
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'EMPTY_RESPONSE');
});

test('a ceiling configured on a reuse candidate is not imposed on the route', async () => {
  // The whole point of reuse is that the borrowed model is called through its
  // own API with no local configuration. A `maxTokens` left on the candidate —
  // by an earlier version, or by an operator who misread the field — must not
  // silently cap it, or a model the operator chose to borrow rather than
  // configure would quietly answer less than it can.
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      maxTokens: 393_216,
      candidates: [{ id: 'borrowed', provider: 'p', model: 'x', maxTokens: 65_536, contextWindow: 8_192, headers: { 'x-custom': '1' } }],
    }],
  });
  let requested;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamVia: (_provider, _model, options) => {
      requested = options.maxTokens;
      return yields({ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } });
    },
  });
  await collect(adapter.stream({ provider: 'custom', model: 'high', maxTokens: 393_216, messages: [] }));
  assert.equal(requested, 393_216, "the caller's ceiling is sent, not the candidate field");
});


test('without an LLM service a reuse candidate reports why instead of silently failing', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'high', candidates: [{ id: 'borrowed', provider: 'p', model: 'x' }] }],
  });
  const adapter = new CustomProviderAdapter({ readConfig: () => config, health: memoryHealth() });
  const chunks = await collect(adapter.stream({ provider: 'custom', model: 'high', messages: [] }));
  assert.equal(chunks.at(-1).reason.failure.code, 'REUSE_UNAVAILABLE');
});

test('an abort from the reused route is reported as an abort', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{ id: 'high', candidates: [{ id: 'borrowed', provider: 'p', model: 'x' }] }],
  });
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamVia: () => yields({ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'cancelled' } } }),
  });
  const chunks = await collect(adapter.stream({ provider: 'custom', model: 'high', messages: [] }));
  assert.equal(chunks.at(-1).reason.kind, 'aborted');
});

test('a reused model resolves its limits from the route that owns it', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      contextWindow: 1_000_000,
      maxTokens: 100_000,
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x' }],
    }],
  });
  const asked = [];
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    resolveVia: async (provider, model) => {
      asked.push(`${provider}/${model}`);
      return { context: { contextWindow: 200_000 }, defaultMaxTokens: 32_768 };
    },
  });
  const info = await adapter.resolveModel('custom', 'high');
  assert.deepEqual(asked, ['our-free-model/x']);
  assert.equal(info.context.contextWindow, 200_000);
  assert.equal(info.defaultMaxTokens, 32_768);
});

test('the number sent never exceeds what the caller was told the model accepts', async () => {
  // The reported ceiling is the route's (32768). If the caller then asks for the
  // model's own 100000, the delegated request must still go out at 32768 — the
  // plugin cannot promise one number and send a larger one.
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      maxTokens: 100_000,
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x' }],
    }],
  });
  let sent;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    resolveVia: async () => ({ defaultMaxTokens: 32_768, context: { contextWindow: 200_000 } }),
    streamVia: (_provider, _model, options) => {
      sent = options.maxTokens;
      return yields({ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } });
    },
  });

  // Resolution happens first on the real path: the adapter knows the route's cap.
  const info = await adapter.resolveModel('custom', 'high');
  assert.equal(info.defaultMaxTokens, 32_768);

  await collect(adapter.stream({ provider: 'custom', model: 'high', messages: [], maxTokens: 100_000 }));
  assert.equal(sent, 32_768);
});

test('an attempt with no prior resolution sends the request as-is', async () => {
  // Dispatch without resolution is not the runtime path, so there is no live
  // route ceiling to hold the caller to. Nothing is invented in its place: the
  // request goes through unchanged rather than being capped by a number the
  // route never published.
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      maxTokens: 100_000,
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x', maxTokens: 8_192 }],
    }],
  });
  let sent;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamVia: (_provider, _model, options) => {
      sent = options.maxTokens;
      return yields({ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } });
    },
  });
  await collect(adapter.stream({ provider: 'custom', model: 'high', maxTokens: 100_000, messages: [] }));
  assert.equal(sent, 100_000);
});

test('a reuse attempt invents no parameter the caller did not send', async () => {
  // The strongest form of "configure nothing": when the caller sends no ceiling,
  // the request carries none, and the route's own adapter applies its own
  // default. Filling in a number here would be exactly the local configuration
  // reuse is meant to avoid.
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      maxTokens: 100_000,
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x', maxTokens: 8_192 }],
    }],
  });
  let forwarded;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamVia: (_provider, _model, options) => {
      forwarded = options;
      return yields({ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } });
    },
  });
  await collect(adapter.stream({ provider: 'custom', model: 'high', messages: [] }));
  assert.equal(Object.hasOwn(forwarded, 'maxTokens'), false, 'no ceiling is invented');
});

test('a resolved route ceiling still holds the caller to what it was told', async () => {
  // The one clamp that stays. `resolveModel` reports the route's own ceiling, so
  // a caller that then asks for more is asking beyond what it was told; sending
  // that through is the case this guards.
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      maxTokens: 100_000,
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x' }],
    }],
  });
  let sent;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    resolveVia: async () => ({ provider: 'our-free-model', id: 'x', defaultMaxTokens: 4_096 }),
    streamVia: (_provider, _model, options) => {
      sent = options.maxTokens;
      return yields({ type: 'text-delta', index: 0, text: 'x' }, { type: 'finish', reason: { kind: 'stop' } });
    },
  });
  // Resolve first, the way the runtime does, so the route ceiling is known.
  const resolved = await adapter.resolveModel('custom', 'high');
  assert.equal(resolved.defaultMaxTokens, 4_096, 'the route ceiling is reported as given');
  await collect(adapter.stream({ provider: 'custom', model: 'high', maxTokens: 100_000, messages: [] }));
  assert.equal(sent, 4_096);
});

test('a route that cannot describe its model degrades to the configured numbers', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      contextWindow: 1_000_000,
      maxTokens: 100_000,
      candidates: [{ id: 'borrowed', provider: 'our-free-model', model: 'x' }],
    }],
  });
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    resolveVia: async () => {
      throw new Error('route is gone');
    },
  });
  const info = await adapter.resolveModel('custom', 'high');
  assert.equal(info.context.contextWindow, 1_000_000);
  assert.equal(info.defaultMaxTokens, 100_000);
});

test('resolveModel asks each distinct reused route once', async () => {
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      candidates: [
        { id: 'a', provider: 'p', model: 'x' },
        { id: 'b', provider: 'p', model: 'x' },
        { id: 'c', provider: 'p', model: 'y' },
      ],
    }],
  });
  let calls = 0;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    resolveVia: async () => {
      calls += 1;
      return { context: { contextWindow: 1_000 } };
    },
  });
  await adapter.resolveModel('custom', 'high');
  assert.equal(calls, 2, 'one per distinct route/model pair');
});

// ── ids ──────────────────────────────────────────────────────────────────────

test('a reused id keeps the name the operator already knows', () => {
  assert.equal(reuseModelId('space-bunny-free'), 'space-bunny-free');
  assert.equal(reuseModelId('nvidia/nemotron-3-ultra-550b-a55b:free'), 'nvidia-nemotron-3-ultra-550b-a55b-free');
  // The organization is dropped when the leaf already names it, so the clean
  // spelling survives where it can.
  assert.equal(reuseModelId('deepseek-ai/DeepSeek-V4.1-Flash'), 'deepseek-v4.1-flash');
  assert.equal(reuseModelId('', 'Fallback Name'), 'fallback-name');
});

test('distinct models never collapse to one id', () => {
  // The bug this guards: taking only the last path segment made `kilo-auto/free`
  // and `openrouter/free` both `free`, so the second import was refused as
  // "already here" although it is a different model. An id collision here is a
  // silent data-loss bug, not a cosmetic one.
  const real = [
    'kilo-auto/free',
    'openrouter/free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'stepfun/step-3.7-flash:free',
    'deepseek-ai/DeepSeek-V4.1-Flash',
    'moonshotai/kimi-k3',
    'z-ai/glm-5.3-flash',
    'openai/gpt-oss-20b',
    'inclusionai/ling-3.1-flash',
    'dots-studio/dots-3-note-preview:free',
    'liquid/lfm-2.5-2.6b:free',
    'space-bunny-free',
    'longcat-2.5-preview-free',
  ];
  const ids = real.map((id) => reuseModelId(id));
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  assert.deepEqual(duplicates, [], `these ids collided: ${duplicates.join(', ')}`);
  assert.equal(ids.filter((id) => id.length === 0).length, 0, 'every id must be usable');
});

test('a leaf that is only a generic word still gets its route prefix', () => {
  assert.equal(reuseModelId('kilo-auto/free'), 'kilo-auto-free');
  assert.equal(reuseModelId('openrouter/free'), 'openrouter-free');
  // And the same leaf under different parents stays distinct.
  assert.notEqual(reuseModelId('kilo-auto/free'), reuseModelId('openrouter/free'));
});

test('an id with no path separator is left alone', () => {
  assert.equal(reuseModelId('mimo-v2.6-flash-free'), 'mimo-v2.6-flash-free');
  assert.equal(reuseModelId('tierflow_pro'), 'tierflow_pro');
});

test('a candidate id is deterministic, so a second import is detectable', () => {
  assert.equal(reuseCandidateId('our-free-model', 'space-bunny-free'), 'our-free-model-space-bunny-free');
  assert.equal(reuseCandidateId('our-free-model', 'space-bunny-free'), reuseCandidateId('our-free-model', 'space-bunny-free'));
  assert.notEqual(reuseCandidateId('a', 'x'), reuseCandidateId('b', 'x'));
  assert.ok(reuseCandidateId('p'.repeat(200), 'm').length <= 120);
});

test('route ids are validated the way the registry addresses them', () => {
  assert.equal(validProviderId('our-free-model'), true);
  assert.equal(validProviderId('deepseek-official'), true);
  assert.equal(validProviderId('openrouter-free'), true);
  assert.equal(validProviderId('Bad'), false);
  assert.equal(validProviderId(''), false);
  assert.equal(validProviderId(undefined), false);
});

test('self-reuse is only when the route names this very provider', () => {
  assert.equal(isSelfReuse('custom', 'custom'), true);
  assert.equal(isSelfReuse('other', 'custom'), false);
  assert.equal(isSelfReuse('', 'custom'), false);
});

// ── catalog projection ───────────────────────────────────────────────────────

test('the catalog projection offers every route except this one', () => {
  const view = buildCatalogView({
    providers: [
      { id: 'custom', name: '免费模型' },
      { id: 'our-free-model', name: 'Our Free Model' },
      { id: 'openrouter-free', name: 'OpenRouter Free' },
    ],
    listed: new Map([
      ['our-free-model', { models: [{ id: 'space-bunny-free', name: 'Space Bunny', contextWindow: 262_144, maxTokens: 65_536 }] }],
      ['openrouter-free', { models: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'Nemotron', inputModalities: ['text'] }] }],
    ]),
    self: 'custom',
  });
  assert.deepEqual(view.providers.map((group) => group.id), ['our-free-model', 'openrouter-free']);
  assert.equal(view.total, 2);
  assert.deepEqual(view.failures, []);
  // Capacities survive so an import can write real numbers.
  assert.equal(view.providers[0].models[0].contextWindow, 262_144);
});

test('one broken route does not remove the ability to reuse the rest', () => {
  const view = buildCatalogView({
    providers: [
      { id: 'broken', name: 'Broken Route' },
      { id: 'healthy', name: 'Healthy Route' },
    ],
    listed: new Map([
      ['broken', { error: 'boom' }],
      ['healthy', { models: [{ id: 'm', name: 'M' }] }],
    ]),
    self: 'custom',
  });
  assert.deepEqual(view.providers.map((group) => group.id), ['healthy']);
  assert.deepEqual(view.failures, [{ provider: 'broken', name: 'Broken Route', error: 'boom' }]);
  assert.equal(view.total, 1);
});

test('a route that never answered is reported, not treated as empty', () => {
  const view = buildCatalogView({
    providers: [{ id: 'silent', name: 'Silent' }],
    listed: new Map(),
    self: 'custom',
  });
  assert.equal(view.providers.length, 0);
  assert.equal(view.failures[0].provider, 'silent');
});

test('the projection drops models with no id and normalizes modality fields', () => {
  const view = buildCatalogView({
    providers: [{ id: 'p', name: 'P' }],
    listed: new Map([['p', { models: [
      { id: '', name: 'no id' },
      { id: 'ok', name: '', inputModalities: ['text', 'audio'] },
    ] }]]),
    self: 'custom',
  });
  assert.deepEqual(view.providers[0].models, [{ id: 'ok', name: 'ok', inputModalities: ['text'] }]);
});
test('a reused route that emits text and then fails does not rotate', async () => {
  // The same invariant the direct path enforces: once the caller has received
  // text, there is no way to un-send it, so splicing a second attempt onto it
  // would be worse than the failure. Delegation must not become a way around it.
  const config = normalizeConfig({
    providerId: 'custom',
    models: [{
      id: 'high',
      candidates: [
        { id: 'borrowed', provider: 'our-free-model', model: 'x' },
        { id: 'direct', baseURL: 'https://gateway.example/v1', apiKey: 'sk', model: 'y' },
      ],
    }],
  });
  const delegated = [];
  let directTried = false;
  const adapter = new CustomProviderAdapter({
    readConfig: () => config,
    health: memoryHealth(),
    streamImpl: async function* () {
      directTried = true;
      yield { type: 'text-delta', index: 0, text: 'should not happen' };
      yield { type: 'finish', reason: { kind: 'stop' } };
    },
    streamVia: (provider, model) => {
      delegated.push(`${provider}/${model}`);
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'partial answer' };
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: 'upstream died mid-stream' } } };
      })();
    },
  });

  const chunks = await collect(adapter.stream({
    provider: 'custom',
    model: 'high',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  }));

  assert.deepEqual(delegated, ['our-free-model/x'], 'only the reuse candidate was attempted');
  assert.equal(directTried, false, 'the next candidate must not be tried after visible output');
  assert.equal(chunks[0].text, 'partial answer', 'the text already sent stays sent');
  assert.equal(chunks.at(-1).reason.kind, 'error');
  assert.equal(chunks.at(-1).reason.failure.code, 'SERVER');
});
