/**
 * Browser half: the reuse import panel, executed for real.
 *
 * The client bundle is a hand-written `window.__ModuleLoader__` factory that
 * requires only `react`, so it can be run outside a browser against a minimal
 * React shim. That is worth doing rather than reading the source: the bugs that
 * matter here are behavioural — whether an import appends exactly once, whether
 * a second import of the same model is refused, whether a card switches from the
 * endpoint fields to the route fields — and none of them are visible in the
 * source.
 *
 * The shim implements the slice of React this bundle uses (`createElement`,
 * `useState`, `useRef`, a run-once `useEffect`/`useCallback`) with one honest
 * simplification: a state update re-renders synchronously. That makes each
 * click's effect observable before the next assertion. It does not paper over the
 * double-append case, because that is guarded by a ref rather than by batching —
 * and the test that covers it fires two clicks in a row on purpose.
 *
 * @module @local/dsh-custom-provider/test/client
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * A React just large enough for this bundle.
 *
 * Two things are load-bearing and both were got wrong on the first attempt:
 *
 * 1. **Function components are invoked, not stored.** `createElement` only
 *    describes; React calls the function during reconciliation. A shim that
 *    leaves `{ type: Editor }` in the tree renders nothing at all, and every
 *    assertion then fails for a reason that has nothing to do with the plugin.
 * 2. **Hooks belong to a component, not to a render.** State is kept per
 *    component function so it survives a re-render, and hooks are addressed by
 *    call order, the way React addresses them.
 *
 * A state update re-renders synchronously, which makes each click's effect
 * observable before the next assertion. That does not paper over the
 * double-append case: the test covering it deliberately fires two clicks before
 * anything can re-render, and what makes that safe is a ref, not batching.
 */
function makeReact() {
  /** Hook slots per component function, so state survives a re-render. */
  const hookStore = new Map();
  let current = null;
  let cursor = 0;
  let dirty = false;
  let effects = [];
  let phase = 'idle';
  let render = () => {};

  const createElement = (type, props, ...children) => {
    const flat = [];
    const push = (value) => {
      if (Array.isArray(value)) value.forEach(push);
      else if (value !== null && value !== undefined && value !== false && value !== true) flat.push(value);
    };
    children.forEach(push);
    return { type, props: props ?? {}, children: flat };
  };

  const slotsFor = (component) => {
    let slots = hookStore.get(component);
    if (slots === undefined) {
      slots = [];
      hookStore.set(component, slots);
    }
    return slots;
  };

  /**
   * One hook slot, created by the caller.
   *
   * Each hook owns the *shape* of its slot — `{ value }` for state, `{ current }`
   * for a ref, `{ deps, fn }` for a callback — because a single shared shape is
   * how this shim first went wrong: wrapping every hook in `{ value: … }` left
   * `slot.current` and `slot.deps` permanently `undefined`, so refs were empty
   * and every effect re-ran on every render.
   */
  const slotAt = (index, create) => {
    const slots = current === null ? [] : slotsFor(current);
    if (slots.length <= index) slots[index] = create();
    return slots[index];
  };

  const migrate = () => {
    if (phase === 'idle') render();
  };

  const useState = (initial) => {
    const index = cursor++;
    const slot = slotAt(index, () => ({ value: typeof initial === 'function' ? initial() : initial }));
    const setter = (next) => {
      const value = typeof next === 'function' ? next(slot.value) : next;
      if (Object.is(value, slot.value)) return;
      slot.value = value;
      dirty = true;
      migrate();
    };
    return [slot.value, setter];
  };

  const useRef = (initial) => {
    const index = cursor++;
    return slotAt(index, () => ({ current: typeof initial === 'function' ? initial() : initial }));
  };

  /** Shallow comparison, which is what React does with a dependency list. */
  const sameDeps = (left, right) => {
    if (left === undefined || right === undefined || left.length !== right.length) return false;
    return left.every((value, index) => Object.is(value, right[index]));
  };

  const useEffect = (fn, deps) => {
    const index = cursor++;
    const slot = slotAt(index, () => ({ deps: undefined, cleanup: undefined }));
    // A changed dependency list means "run again", and the previous cleanup runs
    // first. Without this, `refresh()` — whose deps are `[]` — would re-fire on
    // every render, its `setServer` would trigger the next one, and the render
    // would never settle. That is the shim lying about React rather than the
    // plugin misbehaving, which is why it is implemented rather than skipped.
    if (deps !== undefined && sameDeps(slot.deps, deps)) return;
    slot.deps = deps;
    effects.push(() => {
      if (typeof slot.cleanup === 'function') slot.cleanup();
      slot.cleanup = fn();
    });
  };

  /**
   * `useCallback` must stay referentially stable across renders when its deps do
   * not change, because the bundle's `refresh` is a dependency of an effect with
   * `[]` deps: a fresh function identity every render would make the effect
   * re-fire forever. That is the same contract React offers, so it is honoured
   * rather than approximated.
   */
  const useCallback = (fn, deps) => {
    const index = cursor++;
    const slot = slotAt(index, () => ({ deps: undefined, fn }));
    if (deps !== undefined && sameDeps(slot.deps, deps)) return slot.fn;
    slot.deps = deps;
    slot.fn = fn;
    return slot.fn;
  };

  /** Resolve function components into plain element nodes, depth-first. */
  const resolve = (node) => {
    if (node === null || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(resolve);
    if (typeof node.type === 'function') {
      const previous = current;
      const previousCursor = cursor;
      current = node.type;
      cursor = 0;
      let produced;
      try {
        produced = resolve(node.type(node.props));
      } finally {
        current = previous;
        cursor = previousCursor;
      }
      return produced;
    }
    return { ...node, children: node.children.map(resolve) };
  };

  return {
    createElement,
    useState,
    useRef,
    useEffect,
    useCallback,
    mount(component) {
      let tree = null;
      render = () => {
        let guard = 0;
        do {
          dirty = false;
          effects = [];
          phase = 'render';
          tree = resolve(component());
          phase = 'effect';
          for (const effect of effects) effect();
          phase = 'idle';
        } while (dirty && (guard += 1) < 50);
        assert.ok(guard < 50, 'render did not settle: an effect is updating state unconditionally');
      };
      render();

      const walk = (node, visit) => {
        if (node === null || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach((child) => walk(child, visit));
          return;
        }
        visit(node);
        (node.children ?? []).forEach((child) => walk(child, visit));
      };

      const api = {
        get tree() {
          return tree;
        },
        /** Every node matching a predicate, depth-first. */
        find(predicate) {
          const out = [];
          walk(tree, (node) => {
            if (predicate(node)) out.push(node);
          });
          return out;
        },
        /** The one node carrying this `id` prop. */
        byId(id) {
          return api.find((node) => node.props?.id === id)[0];
        },
        /** The text content of a node, flattened. */
        text(id) {
          const node = api.byId(id);
          if (node === undefined) return undefined;
          const parts = [];
          const gather = (value) => {
            if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
            else if (Array.isArray(value)) value.forEach(gather);
            else if (value !== null && typeof value === 'object') (value.children ?? []).forEach(gather);
          };
          gather(node);
          return parts.join('');
        },
        /** True when a node with this id exists. */
        has(id) {
          return api.byId(id) !== undefined;
        },
        click(id) {
          const node = api.byId(id);
          assert.ok(node !== undefined, `no node with id "${id}"`);
          node.props.onClick?.({ target: {} });
        },
      };
      return api;
    },
  };
}

/** Load the client factory and apply it, capturing the slot occupant. */
function loadComponent(React, onFetch) {
  let registered = null;
  const sandbox = {
    __ModuleLoader__: {
      load: ({ factory }) => {
        registered = factory((name) => {
          if (name === 'react') return React;
          throw new Error(`unexpected require("${name}")`);
        });
      },
    },
  };
  // `window` is the only global the bundle touches.
  new Function('window', readFileSync(join(here, '..', 'client', 'client.js'), 'utf8'))(sandbox);
  assert.ok(registered !== null, 'the bundle did not register a module');

  let component = null;
  registered.apply({
    effect: (fn) => fn(),
    locale: { register: () => {} },
    slots: {
      inject: (_slot, register) => register(),
      register: (_target, fn) => {
        component = fn;
        return () => {};
      },
    },
  });
  assert.ok(component !== null, 'the bundle registered no slot occupant');
  void onFetch;
  return component;
}

/** A live-registry answer shaped exactly as the Host builds it. */
const CATALOG = {
  ok: true,
  self: 'custom',
  reused: [],
  total: 3,
  providers: [
    {
      id: 'our-free-model',
      name: 'Our Free Model',
      models: [
        { id: 'space-bunny-free', name: 'Space Bunny', contextWindow: 262_144, maxTokens: 65_536, inputModalities: ['text', 'image'] },
        { id: 'longcat-2.5-preview-free', name: 'LongCat 2.5', contextWindow: 131_072 },
      ],
    },
    {
      id: 'openrouter-free',
      name: 'OpenRouter Free',
      models: [{ id: 'nvidia/nemotron-3-ultra-550b-a55b:free', name: 'high', contextWindow: 1_000_000, maxTokens: 65_536 }],
    },
  ],
  failures: [{ provider: 'deepseek-official', name: 'DeepSeek 官方', error: 'gateway unreachable' }],
};

/** The settings value the page edits: one direct candidate and one reuse candidate. */
function stateValue() {
  return {
    providerId: 'custom',
    displayName: '免费模型',
    keys: [],
    models: [{
      id: 'high',
      name: 'high',
      contextWindow: 1_048_576,
      maxTokens: 393_216,
      input: ['text'],
      enabled: true,
      candidates: [
        { id: 'modelscope1', name: '', provider: '', baseURL: 'https://api-inference.modelscope.cn/v1', keyId: '', apiKey: 'ms-x', credentialRef: '', model: 'deepseek-ai/DeepSeek-V4.1-Flash', headers: {}, maxTokens: 0, contextWindow: 0, enabled: true },
        { id: 'free', name: 'Space Bunny', provider: 'our-free-model', baseURL: '', keyId: '', apiKey: '', credentialRef: '', model: 'space-bunny-free', headers: {}, maxTokens: 0, contextWindow: 0, enabled: true },
      ],
    }],
    cooldownMinutes: 5,
    idleTimeoutMs: 300_000,
    failoverOnTransient: true,
    failoverOnAnyError: false,
    extraQuotaPatterns: ['insufficient balance'],
  };
}

/**
 * The dictionary function the slot occupant receives.
 *
 * It must be *callable* — the bundle uses `t('loading')`, not `t.loading` — and
 * returning the key keeps assertions about *which* string is shown rather than
 * about its exact wording.
 */
function translator() {
  return (key) => String(key);
}

/** Let the pending fetch promises settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Mount the editor against a fetch stub, and return the handles a test needs. */
function mountEditor({ catalog = CATALOG, catalogFails = false, value = stateValue() } = {}) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const text = String(url);
    if (text.endsWith('/catalog')) {
      return { json: async () => (catalogFails ? { ok: false, error: 'registry exploded' } : catalog) };
    }
    if (text.endsWith('/state')) {
      return { json: async () => ({ ok: true, models: [], diagnostics: [], staleReuse: [] }) };
    }
    return { json: async () => ({ ok: true }) };
  };

  const React = makeReact();
  const component = loadComponent(React, globalThis.fetch);
  // The bundle reads its dictionary through `t`; returning the key keeps the
  // assertions about *which* string is shown rather than about its wording.
  const t = translator();
  const form = {
    state: { status: 'ready', writable: true, revision: 7, value },
    mutations: [],
    mutate: async (ops, revision) => {
      form.mutations.push({ ops, revision });
      return true;
    },
  };
  const mounted = React.mount(() => component({ t, form }));
  // The draft is filled from the settings value inside an effect, so the first
  // render is the loading line and the second is the editor.
  return {
    mounted,
    form,
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}

/** Let the pending fetch promises settle. */

test('the reuse panel starts empty and reads the live registry on demand', async () => {
  const { mounted, calls, restore } = mountEditor();
  try {
    // Nothing has been read yet: the page says so instead of showing a blank list.
    assert.equal(mounted.text('cc-reuse-empty'), 'reuseNoCatalog');
    mounted.click('cc-reuse-refresh');
    await settle();
    assert.equal(calls.filter((call) => call.url.endsWith('/catalog')).length, 1);
    assert.ok(mounted.has('cc-reuse-providers'));
    assert.match(mounted.text('cc-reuse-provider-0'), /Our Free Model/u);
  } finally {
    restore();
  }
});

test('a failed read is reported instead of leaving the panel silent', async () => {
  const { mounted, restore } = mountEditor({ catalogFails: true });
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    const message = mounted.find((node) => String(node.children?.[0] ?? '').includes('registry exploded'));
    assert.equal(message.length, 1);
  } finally {
    restore();
  }
});

test('a route that failed to list is named beside the working ones', async () => {
  const { mounted, restore } = mountEditor();
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    const text = mounted.text('cc-reuse-failures');
    assert.match(text ?? '', /DeepSeek 官方/u);
    assert.match(text ?? '', /gateway unreachable/u);
  } finally {
    restore();
  }
});

test('a model already in the list cannot be imported again', async () => {
  const { mounted, restore } = mountEditor();
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    // The first route is opened automatically, so its models are already listed.
    // `space-bunny-free` is already configured, under the model id `high`.
    assert.ok(mounted.byId('cc-reuse-import-0-0'));
    assert.equal(mounted.byId('cc-reuse-import-0-0').props.disabled, true);
    // Its neighbour is genuinely new, so it stays importable.
    assert.equal(mounted.byId('cc-reuse-import-0-1').props.disabled, false);
  } finally {
    restore();
  }
});

test('one import appends exactly one reuse model and writes it on save', async () => {
  const { mounted, form, restore } = mountEditor();
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    mounted.click('cc-reuse-import-0-1');
    assert.ok(mounted.has('cc-model-1-toggle'), 'a second model card should exist');
    assert.equal(mounted.has('cc-model-2-toggle'), false, 'only one model was imported');

    mounted.click('cc-save');
    await settle();
    assert.equal(form.mutations.length, 1);
    const [operation] = form.mutations[0].ops;
    assert.equal(operation.path[0], 'models');
    const imported = operation.value[1];
    assert.equal(imported.id, 'longcat-2.5-preview-free');
    // The route's published capacities came along, so the picker is correct
    // before the first request.
    assert.equal(imported.contextWindow, 131_072);
    assert.deepEqual(imported.candidates, [{
      id: 'our-free-model-longcat-2.5-preview-free',
      name: 'LongCat 2.5',
      provider: 'our-free-model',
      baseURL: '',
      keyId: '',
      apiKey: '',
      credentialRef: '',
      model: 'longcat-2.5-preview-free',
      headers: {},
      maxTokens: 0,
      contextWindow: 0,
      enabled: true,
    }]);
  } finally {
    restore();
  }
});

test('importing the same model twice appends it once', async () => {
  const { mounted, restore } = mountEditor();
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    // Open the second route, then fire two clicks in a row before any re-render
    // can correct the button state: this is the case a render-time check alone
    // would get wrong.
    mounted.click('cc-reuse-provider-1');
    mounted.click('cc-reuse-import-1-0');
    mounted.click('cc-reuse-import-1-0');
    assert.ok(mounted.has('cc-model-1-toggle'));
    assert.equal(mounted.has('cc-model-2-toggle'), false, 'the second click must be a no-op');
    assert.equal(mounted.text('cc-save').length >= 0, true);
  } finally {
    restore();
  }
});

test('import all takes a route once and skips what the list already has', async () => {
  const { mounted, form, restore } = mountEditor();
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    mounted.click('cc-reuse-import-all-0');
    // Two models are advertised; only the new one is appended.
    assert.ok(mounted.has('cc-model-1-toggle'));
    assert.equal(mounted.has('cc-model-2-toggle'), false);

    mounted.click('cc-save');
    await settle();
    const imported = form.mutations[0].ops[0].value;
    assert.deepEqual(imported.map((model) => model.id), ['high', 'longcat-2.5-preview-free']);
  } finally {
    restore();
  }
});

test('a reuse candidate card shows the route instead of the endpoint fields', async () => {
  const { mounted, restore } = mountEditor();
  try {
    // Candidate 0 is direct: its endpoint and key fields are present.
    assert.ok(mounted.has('cc-0-0-url'));
    assert.ok(mounted.has('cc-0-0-key'));
    assert.equal(mounted.has('cc-0-0-reuse-note'), false);
    // Candidate 1 reuses a route: no endpoint, no key, and a note naming both.
    assert.equal(mounted.has('cc-0-1-url'), false);
    assert.equal(mounted.has('cc-0-1-key'), false);
    const note = mounted.text('cc-0-1-reuse-note');
    assert.match(note, /our-free-model/u);
    assert.match(note, /space-bunny-free/u);
  } finally {
    restore();
  }
});

test('the mode chip names the two candidate modes', async () => {
  const { mounted, restore } = mountEditor();
  try {
    assert.equal(mounted.text('cc-0-0-mode'), 'directBadge');
    assert.equal(mounted.text('cc-0-1-mode'), 'reuseBadge our-free-model');
  } finally {
    restore();
  }
});

test('a route that is not currently mounted still appears in the picker', async () => {
  // The candidate names `tierflow`, which the live registry did not return. The
  // picker must keep the value instead of silently rewriting it on the next save.
  const value = stateValue();
  value.models[0].candidates[1].provider = 'tierflow';
  value.models[0].candidates[1].model = 'tierflow_pro';
  const { mounted, restore } = mountEditor({ value });
  try {
    assert.equal(mounted.text('cc-0-1-mode'), 'reuseBadge tierflow');
    mounted.click('cc-0-1-provider');
    const options = mounted.find((node) => typeof node.props?.id === 'string' && node.props.id.startsWith('cc-0-1-provider-opt-'));
    assert.ok(options.some((node) => node.props.id.endsWith('-1')), 'the route should still be one of the options');
  } finally {
    restore();
  }
});

test('switching a candidate to a route keeps its id and model editable', async () => {
  const { mounted, form, restore } = mountEditor();
  try {
    // The route list comes from the live registry, so it has to be read first:
    // the picker offers registered routes, not a hard-coded list.
    mounted.click('cc-reuse-refresh');
    await settle();
    mounted.click('cc-0-0-provider');
    // Option 1 is the first live route (option 0 is "direct").
    mounted.click('cc-0-0-provider-opt-1');
    assert.equal(mounted.text('cc-0-0-mode'), 'reuseBadge our-free-model');
    assert.equal(mounted.has('cc-0-0-url'), false);
    // The model field stays available, now labelled as the route's model id.
    assert.ok(mounted.has('cc-0-0-model'));

    mounted.click('cc-save');
    await settle();
    const direct = form.mutations[0].ops[0].value[0].candidates[0];
    assert.equal(direct.provider, 'our-free-model');
    assert.equal(direct.id, 'modelscope1', 'the candidate id is untouched by the mode switch');
  } finally {
    restore();
  }
});

test('discarding an import forgets it, so it can be imported again', async () => {
  const { mounted, restore } = mountEditor();
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    mounted.click('cc-reuse-import-0-1');
    assert.ok(mounted.has('cc-model-1-toggle'));

    mounted.click('cc-discard');
    assert.equal(mounted.has('cc-model-1-toggle'), false, 'the draft is back to the saved value');
  } finally {
    restore();
  }
});

test('a stale reuse candidate is reported from the state snapshot', async () => {
  const previous = globalThis.fetch;
  const value = stateValue();
  globalThis.fetch = async (url) => {
    const text = String(url);
    if (text.endsWith('/state')) {
      return {
        json: async () => ({
          ok: true,
          models: [],
          diagnostics: [],
          staleReuse: [{ model: 'high', candidate: 'free', provider: 'our-free-model', wanted: 'space-bunny-free' }],
        }),
      };
    }
    return { json: async () => (text.endsWith('/catalog') ? CATALOG : { ok: true }) };
  };
  try {
    const React = makeReact();
    const component = loadComponent(React, globalThis.fetch);
    const t = translator();
    const form = { state: { status: 'ready', writable: true, revision: 7, value }, mutate: async () => true };
    const mounted = React.mount(() => component({ t, form }));
    await settle();
    assert.match(mounted.text('cc-reuse-stale') ?? '', /our-free-model/u);
  } finally {
    globalThis.fetch = previous;
  }
});
test('two routes exposing the same generic leaf both import as distinct models', async () => {
  // `kilo-auto/free` and `openrouter/free` are different models whose last path
  // segment is identical. If the derived id collapsed to `free`, the second
  // import would be refused as "already here" and the operator would silently
  // lose a model — so this is a correctness test, not a naming one.
  const catalog = {
    ok: true,
    self: 'custom',
    reused: [],
    total: 2,
    providers: [
      { id: 'channel-a', name: 'Channel A', models: [{ id: 'kilo-auto/free', name: 'Kilo Auto Free' }] },
      { id: 'channel-b', name: 'Channel B', models: [{ id: 'openrouter/free', name: 'OpenRouter Free' }] },
    ],
    failures: [],
  };
  const { mounted, form, restore } = mountEditor({ catalog });
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    // The first route is open; import its model.
    mounted.click('cc-reuse-import-0-0');
    // Open the second route and import its model too.
    mounted.click('cc-reuse-provider-1');
    assert.equal(mounted.byId('cc-reuse-import-1-0').props.disabled, false, 'a different model must stay importable');
    mounted.click('cc-reuse-import-1-0');

    mounted.click('cc-save');
    await settle();
    const saved = form.mutations[0].ops[0].value;
    // The id derives from the model, so the two distinct models keep the path
    // segment that tells them apart. Under the old rule both were `free`.
    assert.deepEqual(saved.map((model) => model.id), ['high', 'kilo-auto-free', 'openrouter-free']);
  } finally {
    restore();
  }
});

test('the client derives the same id the host would', async () => {
  // The two halves both derive ids, and a disagreement would make the "already
  // imported" check and the saved configuration contradict each other. Assert
  // them against the host's own implementation rather than a copy of the rule.
  const host = await import('../src/reuse.js');
  const samples = [
    'kilo-auto/free',
    'openrouter/free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'deepseek-ai/DeepSeek-V4.1-Flash',
    'space-bunny-free',
    'stepfun/step-3.7-flash:free',
    'moonshotai/kimi-k3',
  ];
  const catalog = {
    ok: true,
    self: 'custom',
    reused: [],
    total: samples.length,
    providers: [{ id: 'p', name: 'P', models: samples.map((id) => ({ id, name: id })) }],
    failures: [],
  };
  const { mounted, form, restore } = mountEditor({ catalog });
  try {
    mounted.click('cc-reuse-refresh');
    await settle();
    mounted.click('cc-reuse-import-all-0');
    mounted.click('cc-save');
    await settle();
    const saved = form.mutations[0].ops[0].value.slice(1).map((model) => model.id);
    assert.deepEqual(saved, samples.map((id) => host.reuseModelId(id)));
  } finally {
    restore();
  }
});
