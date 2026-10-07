---
description: "Custom LLM provider plugin: several custom models, each rotating inside its own candidate list; a candidate either dials its own endpoint or reuses a model that already exists in the list (official DeepSeek, OpenRouter, Our Free Model's free and co-paid models) in one click."
kind: "package-reference"
---

# @local/dsh-custom-provider

English | [中文](README.zh.md)

## Overview

This plugin registers **one** provider route on the DeepSeek Harness LLM seam, with two levels:

```
provider custom
├── model ds-free          ← one entry in the picker, and in the session log
│   ├── candidate modelscope1   baseURL + key + upstream model + its own output ceiling
│   ├── candidate modelscope2   baseURL + key + upstream model + its own output ceiling
│   └── candidate agnes         baseURL + key + upstream model + its own output ceiling
└── model ds-pro
    └── candidate pro1
```

A request rotates **only inside the model it named**. Exhausting `ds-free` fails as `ds-free`; it never silently answers from a model the caller did not select.

A candidate comes in one of two shapes, chosen by its `provider` field:

| Shape | `provider` | Behaviour |
|---|---|---|
| **Direct** | empty | This plugin speaks OpenAI Chat Completions to the candidate's `baseURL`, with the candidate's own key |
| **Reuse** | a registered route id | The request is handed to **that route's own adapter** (`ctx.llm`), which owns the endpoint, the credential, the wire protocol and the reasoning-effort table |

Reuse is not a lazier version of copying a base URL and a key — for most routes worth reusing it is the *only* mechanism that can work at all. Our Free Model serves its free lane anonymously and its co-paid (白嫖) lane through credentials the host keeps sealed, so there is no address or key to copy; `llm-pi-ai` resolves its key from a credential reference at call time, so a copy would freeze a secret meant to rotate; the official DeepSeek routes sign with account identity and platform extensions only their own adapter knows how to produce.

### Reuse an existing model in one click

The configuration page gained a **Reuse an existing model** section:

1. Press **Refresh available models**. The Host reads every **currently registered route** and the models it advertises *right now* — a live list, not a snapshot of configuration.
2. Expand a route, filter by id or name if you like, and press **Import** to add that model to this provider's own list; **Import all** takes the whole route at once.
3. The imported row arrives carrying the capacities the owning route publishes, so the picker shows real numbers immediately instead of defaults the first request would have to correct.

What you get is a **reuse candidate**: it records exactly two things — the route id and that route's model id — because the endpoint and the key belong to the route. Importing the same model twice is detected and skipped (the candidate id is derived deterministically from `route-model`).

**Why capacities are asked of the owning route.** How many tokens a candidate really accepts is knowable only by the route serving it. A reuse candidate asks its route once through `resolveModelInfo` — a local registry call, no network I/O — and falls back to the configured numbers when the route cannot answer, rather than failing the request over a missing detail.

> **One thing genuinely cannot be borrowed: replay state.** The Harness deliberately strips provider replay envelopes from history whose route belongs to *another* adapter. A reused model therefore sees that conversation as provider-neutral content. That is a capability regression on those turns, never a correctness one.

The rotation behaves like this:

| Situation | Behaviour |
|---|---|
| Out of quota (402, or a body matching a quota phrase) | The candidate is banned for the **rest of the local calendar day**; the ban lifts at local midnight, is written to disk, and survives a restart |
| Network error, timeout, 5xx, 429 rate limit, interrupted stream | The candidate is **parked for a cooldown** (5 minutes by default); it is retried when the window passes, and a success clears it |
| 401/403/400 and other deterministic errors | **No rotation** — the error is reported (`failoverOnAnyError` turns this on) |
| Failure after visible output | The turn ends with an error. Emitted text cannot be recalled, so splicing a second attempt onto it would only be worse |
| Reuse candidate: route not mounted / does not expose the model | The Reuse section and the candidate's **Probe** button name it; a failed request is classified as above |

Configure it in **sidebar → 插件 (Plugins) → this bundle's row → 配置 (Configure)**.

## Use this package

The page has six sections: provider settings, a **degradation notice**, the **shared key library**, diagnostics, **Reuse an existing model**, and the model list.

- **Collapsible**: every model card and every candidate card folds. A folded model still shows its id, label, candidate count and a health summary (available / out of quota / cooling down), so a long configuration stays scannable; collapse-all and expand-all sit at the top.
- **Shared keys**: fill a key in once and candidates reuse it through the *key source* picker; rotating it is one edit. A candidate left on *inline key* still carries its own.
- **Reuse an existing model**: see above. A candidate card is tagged **reuse** or **direct** at a glance, and a reuse candidate hides the endpoint and key fields — those fields would be saved and then silently ignored, so showing them would only invite an edit that does nothing.
- **Degradation notice**: when a model rotates (say `modelscope1` ran out of quota and `modelscope2` took over) the page names the model, the failed candidate, the reason and the candidate that took over, keeping the upstream message. The same event is written to the Harness log, and the record survives a restart.
- The configuration page edits both levels: models (id, label, context window, default output ceiling, input modalities) and, inside each model, its candidates (id, label, the reuse route or endpoint, a key chosen from the shared library or an inline/credential key, upstream model, extra headers, and the candidate's **own** output and context ceilings). Each candidate shows its live state (available / out of quota today / cooling down), its consecutive failure count and its last error, and can be **probed** and **reset** individually; a reset-all control clears every record. **Probe on a reuse candidate asks the live registry** — is the route mounted, does it expose this model — instead of dialing anything.

**Why the ceiling belongs to the candidate.** Relays differ: sending 393216 output tokens to an endpoint that caps at 65536 is rejected outright, which is how a *fallback* ends up refused by the very endpoint it fell back to. So the plugin protects twice — the capability it reports to the Harness is the **minimum** over the model's usable candidates (asking a reused route for its own number first), and the value actually sent is min(resolved, that candidate's ceiling).

Saving goes through the Harness settings plane with revision-conflict detection, and leaving the page discards an unsaved draft.

The same configuration can be written by hand:

```yaml
- id: custom-provider
  config:
    providerId: custom
    displayName: Custom provider
    models:
      - id: high
        name: high
        candidates:
          # Direct: this plugin dials the endpoint itself
          - id: modelscope1
            baseURL: https://api-inference.modelscope.cn/v1
            apiKey: ms-...
            model: deepseek-ai/DeepSeek-V4.1-Flash
            maxTokens: 393216
          # Reuse: handed to the route's own adapter
          - id: our-free-model-space-bunny-free
            provider: our-free-model
            model: space-bunny-free
          - id: official-ds
            provider: deepseek-official
            model: deepseek-v4.1-flash
```

A legacy flat `entries` list still loads: it migrates to one model per entry with a single candidate, lifting each entry's ceilings to the model so the values sent do not change. A candidate written before `provider` existed still means **direct**, so an existing configuration keeps its exact behaviour.

## Understand the implementation

- **Health keys are `modelId/candidateId`**, so two models may reuse a candidate id without interfering — and reuse and direct candidates share one table.
- **A candidate is normalized into exactly one mode**, decided by `provider` alone. A reuse candidate needs a route and a model id and nothing else; a direct candidate needs an endpoint. Each mode is never told it is missing what the other mode requires, `provider` naming a nonexistent route (or this very provider, which would loop back) is a *blocking* error, and endpoint fields left on a reuse candidate are reported as inert rather than silently dropped.
- **Delegation re-projects nothing.** The caller's request is forwarded verbatim to the owning adapter, which performs the single conversion; converting again on top would double-encode images and tools. The candidate's ceiling still clamps `maxTokens`, and the inner stream's terminal failure is translated back into this plugin's `quota`/`transient`/`fatal` vocabulary so the same `shouldFailover` decides — reuse and direct candidates rotate identically.
- **Every config field is `.volatile()`.** The settings seam only projects and only writes volatile paths, so this is what makes the page able to read and write the config at all; it also makes an edit apply *in place* — the loader swaps the value and emits `loader/volatile-update` instead of remounting the row.
- **The adapter owns retrying.** `providerRetryPolicy()` returns `{ mode: 'normal', maxRetries: 0 }`, so the shared retry executor never re-runs a candidate behind the cascade's back.
- **Failover happens before the first visible chunk.** Quota exhaustion and connection faults are decided at the header stage, so this covers the cases the cascade exists for.
- **The browser half is a hand-written lazy CommonJS factory.** No build step; it requires only `react` and draws its own controls with `--dsw-alias-*` theme tokens.

Source map:

| File | Responsibility |
|---|---|
| `index.js` | Row entry: live volatile config, route registration, health table, HTTP routes (state/catalog/reset/probe), reuse delegation |
| `src/config.js` | schemastery schema and diagnostics |
| `src/normalize.js` | Pure logic: id derivation, diagnostics, model catalog, the two candidate modes |
| `src/reuse.js` | Pure logic: delegated-failure classification, live catalog projection, reuse id derivation |
| `src/plan.js` | Attempt planning |
| `src/openai.js` | Dependency-free OpenAI-compatible SSE client |
| `src/quota.js` | Failure classification |
| `src/health.js` | Durable health table |
| `src/convert.js` | Harness messages/tools → Chat Completions payload |
| `src/adapter.js` | `LlmAdapter`, the cascade, and delegation for reuse candidates |
| `client/client.js` | Browser half: the `plugins.row.config` page and the reuse import panel |
| `probe.js` | End-to-end acceptance row (not mounted by default) |

## Testing

```sh
npm test          # discovers and runs test/*.test.mjs
```

61 cases cover failure classification, the health table (including cross-restart persistence and local-day reset), SSE parsing across chunk boundaries, idle timeout and cancellation, attempt planning, the full cascade against local mock endpoints, and reuse — normalization of both modes, delegation, failure translation, catalog projection, id derivation; plus 13 cases that execute the browser half through a minimal React shim (the reuse panel, import deduplication, the mode switch, the stale-route notice).

`test/host.test.mjs` mounts `apply()` against a minimal stub runtime and verifies that `/catalog` projects the **live registry** rather than the configuration, that `/state` reports a candidate whose route has vanished, and that probing a reuse candidate consults the registry instead of dialing. It needs `@deepseek-ai/schemastery`, which ships with the Harness and is not a dependency of this repository, so it **skips with its reason stated** when run from the source tree rather than pretending to fail. To execute it, run inside the profile:

```sh
cd <profile>/node_modules/@local/dsh-custom-provider && npm test
```

Real-runtime acceptance (needs DeepSeek Harness on Windows):

```sh
cmd.exe /c tools\verify.cmd      # adjust paths first
```

The probe writes the candidate list through `settings.mutate` — exactly what the page does — then runs the cascade through the real `ctx.llm.stream` seam.

## Known limitations

- Image input depends on the session having an attachment provider; declare `input: ["text"]` for text-only endpoints.
- **A reused model cannot borrow replay state**: the Harness strips replay envelopes belonging to another adapter by design, so history arrives provider-neutral.
- Reasoning effort is not exposed. A reuse candidate uses its route's default effort, but this plugin does not choose one for it.
- **Reuse is keyed by (route, model id)**, so the same model of the same route cannot be attached twice with different parameters — that would need support in the owning route.
- Model discovery is not registered: the catalog comes from the configuration itself or from reuse.
- The local-midnight reset is only unit-verified (injected clock); cross-restart persistence has real-runtime evidence via `tools/persistence-*.cmd`.
- No configurable-provider directory entry is registered, so 设置 → 模型 shows no row for this provider; the entry point is the Plugins page.
- Failover only happens before the first visible chunk.
