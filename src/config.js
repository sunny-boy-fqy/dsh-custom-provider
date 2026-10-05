/**
 * The plugin's schemastery configuration schema.
 *
 * Two deliberate properties:
 *
 * 1. **Permissive.** A profile whose config fails validation does not load at
 *    all, which would take away the very page the operator needs to fix it — so
 *    every field has a default, empty entries are accepted, and the real checks
 *    live in {@link module:@local/dsh-custom-provider/normalize}, whose findings
 *    are reported as diagnostics on the configuration page instead of as a load
 *    failure.
 * 2. **Volatile.** The settings seam only projects fields marked `.volatile()`
 *    (`volatileForm`), and only volatile paths are writable through it. Marking
 *    the whole surface volatile is what lets the plugin page read and write this
 *    config at all, and it makes a change apply *in place* — the loader swaps
 *    the value and emits `loader/volatile-update` instead of remounting the row,
 *    so an edit is picked up on the next request with no reload.
 *
 * @module @local/dsh-custom-provider/config
 */

import z from '@deepseek-ai/schemastery';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PROVIDER_ID,
  INPUT_MODALITIES,
} from './normalize.js';

/**
 * One entry of the provider-level shared key library.
 *
 * A key pasted once and referenced by several candidates: rotating it is one
 * edit instead of many, and a typo is visible in one row instead of hidden in
 * whichever candidate failed last.
 */
export const KeyConfig = z.object({
  id: z.string().default('').description('共享密钥 id：候选用它引用；留空由名称派生。'),
  name: z.string().default('').description('共享密钥显示名，例如 modelscope-1。'),
  value: z.string().default('').description('明文密钥；与凭据引用二选一。'),
  credentialRef: z.string().default('').description('DSH 凭据引用名；非空时优先于明文值。'),
});

/**
 * One candidate: one way to serve the model it belongs to.
 *
 * `baseURL`, a key and `model` are the whole point — a model's candidates differ
 * precisely in where they go and what they call.
 */
export const CandidateConfig = z.object({
  id: z.string().default('').description('候选标识（同一模型内唯一）：健康记录与日志用它区分候选；留空自动生成。'),
  name: z.string().default('').description('候选显示名，例如 modelscope1。'),
  baseURL: z.string().default('').description('该候选的端点，例如 https://gateway.example/v1；已含 /chat/completions 时原样使用。'),
  keyId: z.string().default('').description('复用「共享密钥」里的某一条；留空则用下面的内联密钥。'),
  apiKey: z.string().default('').description('明文 API Key；与凭据引用二选一。'),
  credentialRef: z.string().default('').description('DSH 凭据引用名（大写字母、数字、下划线）；非空时优先于明文 apiKey。'),
  model: z.string().default('').description('该候选真实调用的上游模型名，例如 DeepSeek-V4.1-Flash。'),
  headers: z.dict(z.string()).default({}).description('附加请求头，例如网关要求的 x-api-key。'),
  maxTokens: z.number().default(0).description('该端点的输出上限；0 = 跟随模型设置。设置后实际发送的 max_tokens 不会超过它（各中转站上限不同，必须逐候选声明）。'),
  contextWindow: z.number().default(0).description('该端点的上下文窗口；0 = 跟随模型设置。声明后模型对外上报的窗口取各候选的最小值。'),
  enabled: z.boolean().default(true).description('关闭后该候选不参与轮换。'),
});

/**
 * One logical model: what the picker shows, and the list it rotates inside.
 *
 * The capability fields live here rather than on the candidates, because they
 * describe the promise the caller selected; the candidates only describe how
 * that promise is kept.
 */
export const ModelConfig = z.object({
  id: z.string().default('').description('模型 id：模型选择器与历史记录里的标识，例如 ds-free；留空由显示名派生。'),
  name: z.string().default('').description('模型显示名；留空回退到 id。'),
  contextWindow: z.number().default(DEFAULT_CONTEXT_WINDOW).description('上下文窗口 token 数。'),
  maxTokens: z.number().default(DEFAULT_MAX_TOKENS).description('最大输出 token 数。'),
  input: z.array(z.union(INPUT_MODALITIES)).default(['text']).description('该模型接受的输入类型。'),
  candidates: z.array(CandidateConfig).default([]).description('该模型内部的轮询候选：从第一个开始顺延，不外溢到别的模型。'),
  enabled: z.boolean().default(true).description('关闭后该模型不出现在选择器里。'),
});

/** The plugin's configuration. */
export const Config = z.object({
  providerId: z.string().default(DEFAULT_PROVIDER_ID)
    .description('供应方路由 id：模型请求里记录的 provider，也是设置里的条目标识。')
    .volatile(),
  displayName: z.string().default('自定义供应商')
    .description('模型选择器里显示的供应方名称。')
    .volatile(),
  keys: z.array(KeyConfig).default([])
    .description('共享密钥库：一次填写，多个候选可复用。')
    .volatile(),
  models: z.array(ModelConfig).default([])
    .description('自定义模型列表：每个模型内部有自己的候选轮询表。')
    .volatile(),
  cooldownMinutes: z.number().default(DEFAULT_COOLDOWN_MINUTES)
    .description('临时故障（网络/超时/5xx/限流）后候选的冷却分钟数，到期自动重试。')
    .volatile(),
  idleTimeoutMs: z.number().default(DEFAULT_IDLE_TIMEOUT_MS)
    .description('单个上游请求的空闲超时（毫秒）：每收到一段数据就重新计时。')
    .volatile(),
  failoverOnTransient: z.boolean().default(true)
    .description('临时故障时是否顺延到该模型的下一个候选；关闭则直接报错。')
    .volatile(),
  failoverOnAnyError: z.boolean().default(false)
    .description('其他错误（401/403/400 等）是否也顺延；默认关闭，以免把配置错误掩盖成第二段失败。')
    .volatile(),
  extraQuotaPatterns: z.array(z.string()).default([])
    .description('额外的“额度用尽”关键字（按字面匹配，忽略大小写）。')
    .volatile(),
  entries: z.array(z.any()).default([])
    .description('已废弃：旧的扁平候选列表，加载时自动迁移为「每个模型一个候选」。')
    .volatile(),
});

export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_TOKENS,
  DEFAULT_PROVIDER_ID,
  INPUT_MODALITIES,
  attemptMaxTokens,
  effectiveLimits,
  errorsOf,
  healthKeys,
  modelOf,
  modelsOf,
  normalizeConfig,
  normalizeKeys,
  usableCandidate,
  usableModel,
} from './normalize.js';
