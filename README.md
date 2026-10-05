---
description: "Custom LLM provider plugin: several custom models, each rotating inside its own candidate list (per-candidate baseURL, key, upstream model and output ceiling)."
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

The rotation behaves like this:

| Situation | Behaviour |
|---|---|
| Out of quota (402, or a body matching a quota phrase) | The candidate is banned for the **rest of the local calendar day**; the ban lifts at local midnight, is written to disk, and survives a restart |
| Network error, timeout, 5xx, 429 rate limit, interrupted stream | The candidate is **parked for a cooldown** (5 minutes by default); it is retried when the window passes, and a success clears it |
| 401/403/400 and other deterministic errors | **No rotation** — the error is reported (`failoverOnAnyError` turns this on) |
| Failure after visible output | The turn ends with an error. Emitted text cannot be recalled, so splicing a second attempt onto it would only be worse |

Configure it in **sidebar → 插件 (Plugins) → this bundle's row → 配置 (Configure)**.

## Use this package

The page has five sections: provider settings, a **degradation notice**, the **shared key library**, diagnostics, and the model list.

- **Collapsible**: every model card and every candidate card folds. A folded model still shows its id, label, candidate count and a health summary (available / out of quota / cooling down), so a long configuration stays scannable; collapse-all and expand-all sit at the top.
- **Shared keys**: fill a key in once and candidates reuse it through the *key source* picker; rotating it is one edit. A candidate left on *inline key* still carries its own.
- **Degradation notice**: when a model rotates (say `modelscope1` ran out of quota and `modelscope2` took over) the page names the model, the failed candidate, the reason and the candidate that took over, keeping the upstream message. The same event is written to the Harness log, and the record survives a restart.
- The configuration page edits both levels: models (id, label, context window, default output ceiling, input modalities) and, inside each model, its candidates (id, label, endpoint, a key chosen from the shared library or an inline/credential key, upstream model, extra headers, and the candidate's **own** output and context ceilings). Each candidate shows its live state (available / out of quota today / cooling down), its consecutive failure count and its last error, and can be **probed** (`GET {baseURL}/models`) and **reset** individually; a reset-all control clears every record.

**Why the ceiling belongs to the candidate.** Relays differ: sending 393216 output tokens to an endpoint that caps at 65536 is rejected outright, which is how a *fallback* ends up refused by the very endpoint it fell back to. So the plugin protects twice — the capability it reports to the Harness is the **minimum** over the model's usable candidates, and the value actually sent is min(resolved, that candidate's ceiling).

Saving goes through the Harness settings plane with revision-conflict detection, and leaving the page discards an unsaved draft.

The same configuration can be written by hand:

```yaml
- id: custom-provider
  config:
    providerId: custom
    displayName: Custom provider
    entries:
      - id: primary
        name: Primary
        baseURL: https://gateway.example/v1
        apiKey: sk-...
        model: deepseek-v4
      - id: backup
        name: Backup
        baseURL: https://other.example/v1
        credentialRef: BACKUP_API_KEY
        model: deepseek-v4
```

## Understand the implementation

- **Health keys are `modelId/candidateId`**, so two models may reuse a candidate id without interfering.
- **Every config field is `.volatile()`.** The settings seam only projects and only writes volatile paths, so this is what makes the page able to read and write the config at all; it also makes an edit apply *in place* — the loader swaps the value and emits `loader/volatile-update` instead of remounting the row.
- **The adapter owns retrying.** `providerRetryPolicy()` returns `{ mode: 'normal', maxRetries: 0 }`, so the shared retry executor never re-runs a candidate behind the cascade's back.
- **Failover happens before the first visible chunk.** Quota exhaustion and connection faults are decided at the header stage, so this covers the cases the cascade exists for.
- **The browser half is a hand-written lazy CommonJS factory.** No build step; it requires only `react` and draws its own controls with `--dsw-alias-*` theme tokens.

Source map:

| File | Responsibility |
|---|---|
| `index.js` | Row entry: live volatile config, route registration, health table, HTTP routes |
| `src/config.js` | schemastery schema and diagnostics |
| `src/normalize.js` | Pure logic: id derivation, diagnostics, model catalog |
| `src/plan.js` | Attempt planning |
| `src/openai.js` | Dependency-free OpenAI-compatible SSE client |
| `src/quota.js` | Failure classification |
| `src/health.js` | Durable health table |
| `src/convert.js` | Harness messages/tools → Chat Completions payload |
| `src/adapter.js` | `LlmAdapter` and the cascade |
| `client/client.js` | Browser half: the `plugins.row.config` page |
| `probe.js` | End-to-end acceptance row (not mounted by default) |

## Testing

```sh
for f in test/*.test.mjs; do node "$f"; done
```

67 unit and integration cases cover failure classification, the health table (including cross-restart persistence and local-day reset), SSE parsing across chunk boundaries, idle timeout and cancellation, attempt planning, the full cascade against local mock endpoints, and the **browser half** — executed for real through a hand-written mini React runtime: module body, slot registration, full-page render and save path.

Real-runtime acceptance (needs DeepSeek Harness on Windows):

```sh
node tools/install.mjs --profile <profileDir>
cmd.exe /c tools\verify.cmd      # adjust paths first
# → custom-provider self-check: PASS (36/36)
```

The probe writes the candidate list through `settings.mutate` — exactly what the page does — then runs the cascade through the real `ctx.llm.stream` seam.

## Known limitations

- Image input depends on the session having an attachment provider; declare `input: ["text"]` for text-only endpoints.
- The local-midnight reset is only unit-verified (injected clock); cross-restart persistence has real-runtime evidence via `tools/persistence-*.cmd`.
- Reasoning effort is not exposed.
- Model discovery is not registered: the catalog comes from the configuration itself.
- No configurable-provider directory entry is registered, so 设置 → 模型 shows no row for this provider; the entry point is the Plugins page.
- Failover only happens before the first visible chunk.
