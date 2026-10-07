/**
 * Host-half acceptance: the reuse surface, against a stub runtime.
 *
 * The unit suite covers the pure logic. This file covers the seam the logic
 * cannot reach on its own — that `apply()` really registers the browser routes,
 * that `/catalog` projects a *live* registry rather than the configuration, and
 * that `/state` reports a candidate whose route has gone missing. Those are the
 * three claims the feature rests on, and each one is only observable through the
 * mounted plugin.
 *
 * `@deepseek-ai/schemastery` is imported for real, so a config-schema mistake
 * fails here rather than in the app. That package ships with the Harness and is
 * *not* a dependency of this repository, so this suite runs where the plugin
 * actually runs — inside a profile's `node_modules` — and skips elsewhere with
 * the reason stated, rather than reporting a failure that says nothing about the
 * code. Everything else is a minimal stub: this plugin's contract with the
 * runtime is `ctx.llm`, `ctx.webServer`, `ctx.logger` and `ctx.fiber`.
 *
 * @module @local/dsh-custom-provider/test/host
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

/** Whether the Harness's settings schema library is reachable from here. */
const schemastery = await import('@deepseek-ai/schemastery').then(
  () => true,
  () => false,
);
const skip = schemastery ? false : '需要 Harness 提供的 @deepseek-ai/schemastery：请在 profile 目录下运行（node_modules/@local/dsh-custom-provider/test）';

/** A registered route plus whatever `listModels` should do. */
function fakeRegistry(routes) {
  const providers = routes.map((route) => ({ id: route.id, name: route.name }));
  const calls = { listModels: [], resolveModelInfo: [], stream: [] };
  return {
    providers,
    calls,
    listProviders: () => providers.map((provider) => ({ ...provider })),
    listModels: async (provider) => {
      calls.listModels.push(provider);
      const route = routes.find((entry) => entry.id === provider);
      if (route === undefined) throw new Error(`no adapter registered for provider "${provider}"`);
      if (route.listError !== undefined) throw new Error(route.listError);
      return (route.models ?? []).map((model) => ({ provider, ...model }));
    },
    resolveModelInfo: async (provider, model) => {
      calls.resolveModelInfo.push(`${provider}/${model}`);
      return { provider, id: model, name: model };
    },
    stream: (options) => {
      calls.stream.push(options);
      return (async function* () {
        yield { type: 'text-delta', index: 0, text: 'ok' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
    registerAdapter: () => {
      const handle = () => {};
      handle.replace = () => {};
      return handle;
    },
  };
}

/** Mount the host half and hand back the routes it registered. */
async function mount(config, routes) {
  const { apply } = await import('../index.js');
  const registry = fakeRegistry(routes);
  const handlers = new Map();
  const state = { value: config };
  const ctx = {
    llm: registry,
    logger: { warn: () => {}, error: () => {} },
    fiber: { entry: { options: { id: 'custom-provider' } } },
    get: () => undefined,
    on: () => {},
    inject: (deps, callback) => {
      if (deps.includes('webServer')) {
        callback({
          effect: (factory) => {
            const disposers = factory();
            void disposers;
          },
          webServer: {
            register: (route) => {
              handlers.set(route.path, route.handler);
              return () => handlers.delete(route.path);
            },
          },
        });
      } else {
        callback({ effect: () => {}, settings: { configure: () => {} } });
      }
    },
  };
  // The loader hands volatile fields as accessors, exactly as in the app.
  const live = Object.fromEntries(
    Object.entries(state.value).map(([key, value]) => [key, { get: () => value }]),
  );
  apply(ctx, live);
  return { handlers, registry, state, live };
}

/** Call one registered route with a synthesized request. */
async function call(handler, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const req = {
    method,
    headers: { host: '127.0.0.1:19387', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code) => {
      status = code;
    },
    end: (text) => {
      payload = text;
    },
  };
  await handler(req, res);
  return { status, body: payload.length > 0 ? JSON.parse(payload) : undefined };
}

const CONFIG = {
  providerId: 'custom',
  displayName: '免费模型',
  keys: [{ id: 'modelscope-1', name: 'modelscope-1', value: 'ms-x', credentialRef: '' }],
  models: [
    {
      id: 'high',
      name: 'high',
      candidates: [
        { id: 'direct', baseURL: 'https://api-inference.modelscope.cn/v1', keyId: 'modelscope-1', model: 'deepseek-ai/DeepSeek-V4.1-Flash' },
        { id: 'free', provider: 'our-free-model', model: 'space-bunny-free' },
      ],
    },
    {
      id: 'official',
      name: 'official',
      candidates: [{ id: 'ds', provider: 'deepseek-official', model: 'deepseek-v4.1-flash' }],
    },
  ],
};

const ROUTES = [
  {
    id: 'our-free-model',
    name: 'Our Free Model',
    models: [
      { id: 'space-bunny-free', name: 'Space Bunny', contextWindow: 262_144, maxTokens: 65_536 },
      { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5' },
    ],
  },
  { id: 'deepseek-official', name: 'DeepSeek 官方', listError: 'gateway unreachable' },
];

test('the reuse catalog projects the live registry', { skip }, async () => {
  const { handlers } = await mount(CONFIG, ROUTES);
  const { status, body } = await call(handlers.get('/api/custom-provider/catalog'));
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  // This provider is not offered: reusing it would loop back into itself.
  assert.deepEqual(body.providers.map((group) => group.id), ['our-free-model']);
  assert.equal(body.total, 2);
  assert.equal(body.providers[0].models[0].contextWindow, 262_144);
  // A route that failed to list is reported beside the working one, not instead
  // of it.
  assert.deepEqual(body.failures, [{ provider: 'deepseek-official', name: 'DeepSeek 官方', error: 'gateway unreachable' }]);
  // The configuration's own borrowings are echoed so the page can show staleness.
  assert.deepEqual(body.reused, ['our-free-model', 'deepseek-official']);
});

test('a reuse candidate is usable without an endpoint', { skip }, async () => {
  const { handlers } = await mount(CONFIG, ROUTES);
  const { body } = await call(handlers.get('/api/custom-provider/state'));
  const high = body.models.find((model) => model.id === 'high');
  assert.deepEqual(high.candidates.map((candidate) => candidate.reuse), [false, true]);
  assert.equal(high.usable, true);
  // Neither candidate is complained about: the direct one has its key, the
  // reused one has its route.
  assert.deepEqual(body.diagnostics, []);
});

test('a candidate whose route is not mounted is reported as stale', { skip }, async () => {
  const { handlers } = await mount(CONFIG, [{ id: 'our-free-model', name: 'Our Free Model', models: [] }]);
  const { body } = await call(handlers.get('/api/custom-provider/state'));
  assert.deepEqual(body.staleReuse, [
    { model: 'official', candidate: 'ds', provider: 'deepseek-official', wanted: 'deepseek-v4.1-flash' },
  ]);
});

test('probing a reuse candidate checks the route rather than dialing it', { skip }, async () => {
  const { handlers, registry } = await mount(CONFIG, ROUTES);
  const { status, body } = await call(handlers.get('/api/custom-provider/probe'), {
    method: 'POST',
    body: { model: 'high', candidate: 'free' },
  });
  assert.equal(status, 200);
  assert.equal(body.result.ok, true);
  assert.equal(body.result.mounted, true);
  assert.deepEqual(body.result.sample, ['space-bunny-free', 'longcat-2.5-preview-free']);
  // It asked the registry, not an endpoint.
  assert.deepEqual(registry.calls.listModels, ['our-free-model']);
});

test('probing a reuse candidate names the missing model when the route exists', { skip }, async () => {
  // The route answers, but does not advertise what the candidate asks for.
  const { handlers } = await mount(CONFIG, [
    { id: 'our-free-model', name: 'Our Free Model', models: [] },
    { id: 'deepseek-official', name: 'DeepSeek 官方', models: [{ id: 'some-other-model', name: 'Other' }] },
  ]);
  const { body } = await call(handlers.get('/api/custom-provider/probe'), {
    method: 'POST',
    body: { model: 'official', candidate: 'ds' },
  });
  assert.equal(body.result.ok, false);
  assert.equal(body.result.mounted, true);
  assert.equal(body.result.count, 1);
  assert.match(body.result.detail, /没有暴露模型/u);
});

test('a route that is mounted but cannot list is distinguished from one that is gone', { skip }, async () => {
  // The two failures have different fixes — one is on this plugin's config, the
  // other on the other provider — so the probe must not collapse them.
  const { handlers } = await mount(CONFIG, ROUTES);
  const { body } = await call(handlers.get('/api/custom-provider/probe'), {
    method: 'POST',
    body: { model: 'official', candidate: 'ds' },
  });
  assert.equal(body.result.mounted, true);
  assert.match(body.result.detail, /已挂载，但读取模型列表失败/u);
  assert.match(body.result.detail, /gateway unreachable/u);
  assert.doesNotMatch(body.result.detail, /未挂载/u);
});

test('probing a reuse candidate names the missing route when it is gone', { skip }, async () => {
  const { handlers } = await mount(CONFIG, [{ id: 'other', name: 'Other', models: [] }]);
  const { body } = await call(handlers.get('/api/custom-provider/probe'), {
    method: 'POST',
    body: { model: 'high', candidate: 'free' },
  });
  assert.equal(body.result.ok, false);
  assert.equal(body.result.mounted, false);
  assert.match(body.result.detail, /未挂载/u);
  assert.match(body.result.detail, /other/u);
});

test('the plugin route stays registered and the state stays writable', { skip }, async () => {
  const { handlers } = await mount(CONFIG, ROUTES);
  const { body } = await call(handlers.get('/api/custom-provider/state'));
  assert.deepEqual(body.route, { id: 'custom', registered: true, error: '' });
  assert.equal(body.ok, true);
});

test('the config schema accepts a reuse candidate and defaults its route to empty', { skip }, async () => {
  const { Config } = await import('../src/config.js');
  // Every field this plugin declares is `.volatile()`, so schemastery hands back
  // accessors rather than plain values — the same shape the loader gives `apply`.
  const parsed = Config({
    providerId: 'custom',
    models: [{ id: 'm', candidates: [{ id: 'c', provider: 'our-free-model', model: 'space-bunny-free' }] }],
  });
  assert.equal(parsed.models.get()[0].candidates[0].provider, 'our-free-model');
  // A candidate that never mentions `provider` is a direct candidate, so an
  // existing configuration keeps its exact meaning without a migration.
  const legacy = Config({ models: [{ id: 'm', candidates: [{ id: 'c', baseURL: 'https://x/v1', model: 'y' }] }] });
  assert.equal(legacy.models.get()[0].candidates[0].provider, '');
});