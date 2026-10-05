---
description: "自定义 LLM 供应方插件：两级结构——若干自定义模型，每个模型内部是自己的候选轮询表（各自 baseURL/Key/上游模型名/输出上限）。"
kind: "package-reference"
---

# @local/dsh-custom-provider

[English](README.md) | 中文

## 概述

本插件向 DeepSeek Harness 的 LLM seam 注册**一个**供应方路由，结构是两级的：

```
供应方 custom
├── 模型 ds-free          ← 模型选择器里的一项，也是会话历史记录的标识
│   ├── 候选 modelscope1  baseURL + Key + 上游模型名 + 自己的输出上限
│   ├── 候选 modelscope2  baseURL + Key + 上游模型名 + 自己的输出上限
│   └── 候选 agnes        baseURL + Key + 上游模型名 + 自己的输出上限
└── 模型 ds-pro
    └── 候选 pro1
```

**请求只在它命名的那个模型的候选中轮换**，绝不外溢到别的模型：`ds-free` 的候选全部失败，就是 `ds-free` 失败，而不是悄悄换一个调用方没选过的模型来回答。

| 情况 | 行为 |
|---|---|
| 额度用尽（402，或响应体命中额度关键字） | 该**候选**当天禁用，跨过本地 00:00 自动恢复；状态落盘，重启 Harness 不会复活 |
| 网络错误、超时、5xx、429 限流、流中断 | 该**候选**进入冷却（默认 5 分钟），到期自动重试；成功即清除 |
| 401/403/400 等确定性错误 | 默认**不轮换**，原样报给用户（`failoverOnAnyError` 可打开） |
| 已输出内容后失败 | 结束这一轮并报错。已发出的文本无法撤回，拼接第二段只会更糟 |

配置在**侧栏 → 插件 → 本插件所在行 → 配置**。

## 使用本包

页面分五段：供应方级设置、**降级提示**、**共享密钥库**、诊断、模型列表。

- **可折叠**：每个模型卡片和每个候选卡片都能折叠，折叠后模型行仍显示 id、名称、候选数量与健康汇总（可用 / 额度用尽 / 冷却中），因此长配置也能一眼扫过；顶部有「全部折叠 / 全部展开」。
- **共享密钥库**：密钥在这里填一次，多个候选通过「密钥来源」下拉复用；轮换或改错只需改一处。候选留「内联密钥」时仍可各自填写。
- **降级提示**：模型发生自动降级时（例如 `modelscope1` 额度用尽 → 轮到 `modelscope2`），这里会显示「哪个模型的哪个候选、因为什么、降级到了哪个候选」，并保留上游原文；同时写入 Harness 日志。降级记录会持久化，重启后仍能看到。
- 每个模型卡片里嵌套它自己的候选列表，各自可增删、上下排序、逐个启用/停用、探测与恢复。

### 模型字段（对调用方的承诺）

| 字段 | 默认 | 含义 |
|---|---|---|
| `id` | 派生 | 模型 id：模型选择器与历史记录里的标识，例如 `ds-free` |
| `name` | 回退到 `id` | 选择器里显示的标签 |
| `contextWindow` | 262144 | 上下文窗口；**上报给 Harness 的值会取各可用候选的最小值** |
| `maxTokens` | 32768 | 默认输出上限；**上报给 Harness 的值同样取各可用候选的最小值** |
| `input` | `["text"]` | 该模型接受的输入类型 |
| `candidates` | — | 该模型内部的轮询表 |
| `enabled` | true | 关闭后不出现在选择器里 |

### 候选字段（怎么兑现这个承诺）

| 字段 | 默认 | 含义 |
|---|---|---|
| `id` | 派生 | 候选标识（同一模型内唯一），健康记录用它 |
| `name` | 回退到上游模型名 | 候选显示名 |
| `baseURL` | — | 该候选的端点；已含 `/chat/completions` 时原样使用 |
| `keyId` | 空 | 复用共享密钥库里的某一条；留空则用下面的内联密钥 |
| `apiKey` | 空 | 明文密钥；留空则不发鉴权头 |
| `credentialRef` | 空 | DSH 凭据名；非空时**优先于** `apiKey` |
| `model` | — | 该候选真实调用的上游模型名 |
| `maxTokens` | 0 = 跟随模型 | **该端点自己的输出上限**。发送时取「请求值 ∩ 该上限」 |
| `contextWindow` | 0 = 跟随模型 | 该端点自己的窗口；参与上面的最小值计算 |
| `headers` | `{}` | 附加请求头 |
| `enabled` | true | 关闭后不参与轮换 |

> **为什么输出上限必须在候选上**：不同中转站的上限不一样。把某个模型的 393216 发给只允许 65536 的端点，上游会直接 400 拒绝——这正是「明明是备选，却因为容量设置被拒」的成因。因此插件做两层保护：上报能力时取候选最小值，实际发送时再按该候选上限夹一次。

### 共享密钥库

| 字段 | 含义 |
|---|---|
| `id` | 候选通过 `keyId` 引用它 |
| `name` | 显示名 |
| `value` | 明文密钥 |
| `credentialRef` | DSH 凭据引用名；非空时优先于明文值 |

解析顺序：候选的 `keyId` →（该条目的凭据引用 或 明文值）；`keyId` 留空时用候选自己的 `credentialRef`，再退回候选的 `apiKey`。`keyId` 指向不存在的条目时该候选**不可用**并报错——绝不静默发出无鉴权请求。

### 供应方级字段

| 字段 | 默认 | 含义 |
|---|---|---|
| `providerId` | `custom` | 路由 id |
| `displayName` | 自定义供应商 | 选择器里显示的供应方名 |
| `cooldownMinutes` | 5 | 临时故障冷却时长 |
| `idleTimeoutMs` | 300000 | 单请求**空闲**超时：每收到一段数据就重新计时 |
| `failoverOnTransient` | true | 临时故障是否轮换到下一个候选 |
| `failoverOnAnyError` | false | 其他错误是否也轮换 |
| `extraQuotaPatterns` | `[]` | 额外的「额度用尽」关键字，按字面匹配、忽略大小写 |

内置额度关键字覆盖 `insufficient quota`、`quota exceeded`、`exceeded your current quota`、`resource_exhausted`、`billing hard limit`、`payment required`、`余额不足`、`额度已用尽`、`欠费` 等；额度判定优先于 HTTP 状态码，因为中转站会把计费问题塞进 400/403/429。

### 等价的手写配置

```yaml
- id: custom-provider
  config:
    providerId: custom
    displayName: 自定义供应商
    models:
      - id: ds-free
        name: DS Free
        maxTokens: 393216
        candidates:
          - id: modelscope1
            baseURL: https://api-inference.modelscope.cn/v1
            apiKey: ms-...
            model: deepseek-ai/DeepSeek-V4.1-Flash
            maxTokens: 393216
          - id: agnes
            baseURL: https://apihub.agnes-ai.com/v1
            credentialRef: AGNES_KEY
            model: agnes-3.0-flash
            maxTokens: 65535
```

> 旧的扁平 `entries` 配置仍可加载：会自动迁移成「每个条目一个模型、一个候选」，并把条目容量上提到模型层，保持发送值不变；页面会给出一条迁移提示。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| `index.js` | 行入口：易变配置、路由注册同步、健康表、HTTP 路由（state/reset/probe） |
| `src/config.js` | schemastery 模式（全部字段 `.volatile()`） |
| `src/normalize.js` | 纯逻辑：id 派生、诊断、能力最小值、逐候选夹取 |
| `src/plan.js` | 尝试计划：只在**该模型内部**向下顺延 |
| `src/openai.js` | 无依赖的 OpenAI 兼容 SSE 客户端与失败分类 |
| `src/quota.js` | 「额度用尽 / 临时故障 / 确定性错误」分类 |
| `src/health.js` | 持久化健康表，键为 `模型id/候选id` |
| `src/convert.js` | Harness 消息/工具 → Chat Completions 载荷 |
| `src/adapter.js` | `LlmAdapter` 实现与模型内轮换 |
| `client/client.js` | 浏览器半侧：`plugins.row.config` 配置页（两级编辑器） |
| `probe.js` | 端到端验收行（默认不挂载） |

### 关键不变量

- **健康记录的键是 `模型id/候选id`**：两个模型可以重用同名候选而互不影响。
- **能力上报取最小值**：`contextWindow`、`maxTokens` 都取各可用候选的最小值，Harness 据此做压缩与默认输出决策。
- **发送时再夹一次**：`max_tokens` = min(请求值, 该候选上限)。
- **volatile 配置**：settings 平面只投影/写入易变字段，因此这是页面能读写配置的前提；改动就地生效，`apply` 不重跑。
- **适配器自己就是重试机制**：`providerRetryPolicy()` 返回 `maxRetries: 0`，避免同一候选被外层重试多次才轮到下一个。
- **降级只在首个可见分片之前**：额度与连接类失败都在响应头阶段决定。

</details>

## 测试

```sh
for f in test/*.test.mjs; do node "$f"; done
```

90 个单元/集成用例：失败分类、健康表（跨重启持久化、本地自然日重置）、SSE 分片解析、空闲超时与取消、模型内尝试计划、跨模型隔离、逐候选上限、以及针对本地 mock 端点的完整轮换链；另有 15 个用例用手写迷你 React 运行时真正执行浏览器半侧（渲染、保存、增删、复位、探测）。

真实运行时验收（需要 Windows 上的 DeepSeek Harness）：

```sh
node tools/install.mjs --profile <profileDir>
cmd.exe /c tools\verify.cmd
# → custom-provider self-check: PASS (36/36)
```

## 已知限制与延期工作

- **图片输入**依赖会话已挂载附件服务；纯文本端点请把 `input` 设为 `["text"]`。
- **推理等级（reasoning effort）**未暴露。
- **模型发现**未注册：模型来自配置本身。
- **不注册「可配置供应方目录」条目**：设置 → 模型页不会出现本供应方，配置入口只在插件页。
- **降级只在首个可见分片前生效**。
- **本地午夜自然恢复**只有单元级证据（可注入时钟），真实进程无法快进时钟；跨重启持久化已有真实运行时证据（`tools/persistence-*.cmd`）。

## 开发备注

<details>
<summary>维护者工作上下文</summary>

- 纯逻辑模块（`quota`/`health`/`openai`/`plan`/`normalize`/`convert`）刻意不 import 任何 `@deepseek-ai/*`，可用裸 `node` 直接跑测试。
- 浏览器半侧是手写的 `window.__ModuleLoader__.load` factory，**没有构建步骤**；只 `require('react')`，控件自绘并使用 `--dsw-alias-*` token（官方实践禁止第三方插件 require primitives）。
- 页面所有 setState 都是函数式更新：同一次批处理里的连续编辑不能互相覆盖。
- 每个控件都有稳定的 `id`（`cc-...`），测试与无障碍都依赖它。

</details>
