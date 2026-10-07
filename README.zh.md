---
description: "自定义 LLM 供应方插件：两级结构——若干自定义模型，每个模型内部是自己的候选轮询表；候选可直连自备端点，也可一键复用模型列表里已有的模型（官方 DeepSeek、OpenRouter、Our Free Model 免费与白嫖模型等）。"
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

候选有两种形态，由候选的 `provider` 字段决定：

| 形态 | `provider` | 行为 |
|---|---|---|
| **直连** | 留空 | 本插件自己用 OpenAI Chat Completions 协议请求候选的 `baseURL`，用候选自己的密钥 |
| **复用** | 填已注册的路由 id | 请求**交给该路由自己的适配器**（`ctx.llm`），端点、密钥、协议、推理等级全由它负责 |

复用不是「复制一个 baseURL 和密钥」的偷懒版本——对大多数值得复用的路由来说，它是**唯一可行**的机制：Our Free Model 的免费通道是匿名直连、白嫖通道的凭据由宿主封存，根本没有可复制的地址或密钥；`llm-pi-ai` 的密钥在调用时才从凭据引用解析，复制等于冻结一个本该轮换的秘密；官方 DeepSeek 路由要用账号身份与平台扩展签名，只有它自己的适配器会算。

### 一键复用已有模型

配置页多了一段「复用已有模型」：

1. 点**「刷新可用模型」**，宿主会读取当前**所有已注册路由**及其此刻暴露的模型（这是实时列表，不是配置快照）。
2. 展开任一路由，可按 id/名称筛选，点**「导入」**把该模型加进本供应方的模型列表；也可**「全部导入」**一次加完。
3. 导入的行会直接带上该路由公布的上下文窗口与输出上限，所以选择器里立刻是真实数字，而不是等第一次请求才被纠正。

导入后得到的就是一条**复用候选**。它只记「路由 id + 该路由的模型 id」两件事，因为端点与密钥属于那个路由。重复导入同一个模型会被识别并跳过（候选 id 由 `路由-模型` 确定性派生）。

**为什么能力要问原来的路由**：候选真实能吃多少 token 只有服务它的路由知道。复用候选在解析能力时会向该路由 `resolveModelInfo` 问一次（本地注册表调用，不产生网络 I/O）；问不到就退回配置里写的数字，绝不因此拒绝请求。

> **有一点确实拿不到：重放状态（replay state）。** Harness 会主动剥掉历史中属于**别的适配器**的 provider replay 信封，这是它刻意的隔离设计。因此复用模型看到的历史是 provider-neutral 的内容——这是那几轮对话的**能力**损失，不是正确性问题。

| 情况 | 行为 |
|---|---|
| 额度用尽（402，或响应体命中额度关键字） | 该**候选**当天禁用，跨过本地 00:00 自动恢复；状态落盘，重启 Harness 不会复活 |
| 网络错误、超时、5xx、429 限流、流中断 | 该**候选**进入冷却（默认 5 分钟），到期自动重试；成功即清除 |
| 401/403/400 等确定性错误 | 默认**不轮换**，原样报给用户（`failoverOnAnyError` 可打开） |
| 已输出内容后失败 | 结束这一轮并报错。已发出的文本无法撤回，拼接第二段只会更糟 |
| 复用候选：路由未挂载 / 未暴露该模型 | 「复用已有模型」段落与候选的「探测」按钮会明确指出；请求失败时按上表分类 |

配置在**侧栏 → 插件 → 本插件所在行 → 配置**。

## 使用本包

页面分六段：供应方级设置、**降级提示**、**共享密钥库**、诊断、**复用已有模型**、模型列表。

- **可折叠**：每个模型卡片和每个候选卡片都能折叠，折叠后模型行仍显示 id、名称、候选数量与健康汇总（可用 / 额度用尽 / 冷却中），因此长配置也能一眼扫过；顶部有「全部折叠 / 全部展开」。
- **共享密钥库**：密钥在这里填一次，多个候选通过「密钥来源」下拉复用；轮换或改错只需改一处。候选留「内联密钥」时仍可各自填写。
- **复用已有模型**：见上；候选卡片头部会标出它是「复用」还是「直连」，且复用候选隐藏端点/密钥字段——那些字段存了也不会生效，显示出来只会诱导一次无效编辑。
- **降级提示**：模型发生自动降级时（例如 `modelscope1` 额度用尽 → 轮到 `modelscope2`），这里会显示「哪个模型的哪个候选、因为什么、降级到了哪个候选」，并保留上游原文；同时写入 Harness 日志。降级记录会持久化，重启后仍能看到。
- 每个模型卡片里嵌套它自己的候选列表，各自可增删、上下排序、逐个启用/停用、探测与恢复。**探测按钮对复用候选会去核对实时注册表**（路由在不在、有没有暴露这个模型），而不是去拨号。

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
| `provider` | 空 | **复用路由 id**。非空 = 复用候选（`model` 是该路由暴露的模型 id，端点/密钥字段不生效）；留空 = 直连候选 |
| `baseURL` | — | 该候选的端点；已含 `/chat/completions` 时原样使用。**复用候选忽略** |
| `keyId` | 空 | 复用共享密钥库里的某一条；留空则用下面的内联密钥。**复用候选忽略** |
| `apiKey` | 空 | 明文密钥；留空则不发鉴权头。**复用候选忽略** |
| `credentialRef` | 空 | DSH 凭据名；非空时**优先于** `apiKey`。**复用候选忽略** |
| `model` | — | 直连时 = 上游模型名；复用时 = 该路由暴露的模型 id |
| `maxTokens` | 0 = 跟随模型 | **该端点自己的输出上限**。发送时取「请求值 ∩ 该上限」 |
| `contextWindow` | 0 = 跟随模型 | 该端点自己的窗口；参与上面的最小值计算 |
| `headers` | `{}` | 附加请求头。**复用候选忽略** |
| `enabled` | true | 关闭后不参与轮换 |

> **复用候选只需要两样东西**：路由 id 与模型 id。归一化会对两种形态分别校验——复用候选绝不会被抱怨「缺少端点」，直连候选也绝不会被要求填路由；而 `provider` 指向不存在的路由 id、或指向**本供应方自己**（会绕回自身），都是**阻断性错误**，该候选直接不可用。复用候选上遗留的端点/密钥字段不会静默丢弃，而会给出「不生效」的警告。

> **为什么输出上限必须在候选上**：不同中转站的上限不一样。把某个模型的 393216 发给只允许 65536 的端点，上游会直接 400 拒绝——这正是「明明是备选，却因为容量设置被拒」的成因。因此插件做两层保护：上报能力时取候选最小值（复用候选还会先问一次原路由），实际发送时再按该候选上限夹一次。

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

> 旧的扁平 `entries` 配置仍可加载：会自动迁移成「每个条目一个模型、一个候选」，并把条目容量上提到模型层，保持发送值不变；页面会给出一条迁移提示。老配置里没有 `provider` 字段的候选仍然按**直连**解释，含义完全不变。

### 复用的等价手写配置

```yaml
- id: custom-provider
  config:
    providerId: custom
    models:
      - id: high
        name: high
        candidates:
          # 直连：本插件自己请求这个端点
          - id: modelscope1
            baseURL: https://api-inference.modelscope.cn/v1
            apiKey: ms-...
            model: deepseek-ai/DeepSeek-V4.1-Flash
            maxTokens: 393216
          # 复用：交给路由自己的适配器；端点与密钥由它负责
          - id: our-free-model-space-bunny-free
            provider: our-free-model
            model: space-bunny-free
          - id: official-ds
            provider: deepseek-official
            model: deepseek-v4.1-flash
```

同一条候选列表里两种形态可以混用，轮换逻辑完全一致。

## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| `index.js` | 行入口：易变配置、路由注册同步、健康表、HTTP 路由（state/catalog/reset/probe）、复用委托（`streamVia`/`resolveVia`） |
| `src/config.js` | schemastery 模式（全部字段 `.volatile()`） |
| `src/normalize.js` | 纯逻辑：id 派生、诊断、能力最小值、逐候选夹取、复用/直连两种形态 |
| `src/reuse.js` | 纯逻辑：委托失败的分类、实时模型目录的投影、复用 id 派生 |
| `src/plan.js` | 尝试计划：只在**该模型内部**向下顺延 |
| `src/openai.js` | 无依赖的 OpenAI 兼容 SSE 客户端与失败分类 |
| `src/quota.js` | 「额度用尽 / 临时故障 / 确定性错误」分类 |
| `src/health.js` | 持久化健康表，键为 `模型id/候选id` |
| `src/convert.js` | Harness 消息/工具 → Chat Completions 载荷 |
| `src/adapter.js` | `LlmAdapter` 实现、模型内轮换、复用候选的委托 |
| `client/client.js` | 浏览器半侧：`plugins.row.config` 配置页（两级编辑器 + 复用导入面板） |
| `probe.js` | 端到端验收行（默认不挂载） |

### 关键不变量

- **健康记录的键是 `模型id/候选id`**：两个模型可以重用同名候选而互不影响，复用候选与直连候选也共用同一张表。
- **能力上报取最小值**：`contextWindow`、`maxTokens` 都取各可用候选的最小值，Harness 据此做压缩与默认输出决策；复用候选的"自己的值"是向原路由问来的。
- **发送时再夹一次**：`max_tokens` = min(请求值, 该候选上限)，复用候选同样适用。
- **复用不重新投影请求**：载荷原样转发给原路由的适配器，由它做唯一一次转换——在它上面再转一次会把图片和工具双编码。
- **复用失败仍走同一套分类**：内层适配器报出的 `code` 被翻译回本插件的 `quota`/`transient`/`fatal` 三态，再交给同一个 `shouldFailover`，所以复用候选与直连候选的轮换语义完全一致。
- **volatile 配置**：settings 平面只投影/写入易变字段，因此这是页面能读写配置的前提；改动就地生效，`apply` 不重跑。
- **适配器自己就是重试机制**：`providerRetryPolicy()` 返回 `maxRetries: 0`，避免同一候选被外层重试多次才轮到下一个。
- **降级只在首个可见分片之前**：额度与连接类失败都在响应头阶段决定。

</details>

## 测试

```sh
npm test          # 发现并运行 test/*.test.mjs
```

61 个用例：失败分类、健康表（跨重启持久化、本地自然日重置）、SSE 分片解析、空闲超时与取消、模型内尝试计划、跨模型隔离、逐候选上限、复用（归一化两形态、委托、失败翻译、目录投影、id 派生），以及针对本地 mock 端点的完整轮换链；另有 13 个用例用一个最小 React shim 真正执行浏览器半侧（复用面板、导入去重、模式切换、失效路由提示）。

`test/host.test.mjs` 用一个最小 stub 运行时真正挂载 `apply()`，验证 `/catalog` 投影的是**实时注册表**而非配置、`/state` 会报出路由已消失的候选、探测按钮对复用候选走的是注册表。它需要 Harness 提供的 `@deepseek-ai/schemastery`——那不在本仓库的依赖里——因此在源码目录下运行时**明确跳过**（而不是伪装成失败），要真正执行它请到 profile 里跑：

```sh
cd <profile>/node_modules/@local/dsh-custom-provider && npm test
```

真实运行时验收（需要 Windows 上的 DeepSeek Harness）：

```sh
cmd.exe /c tools\verify.cmd
```

## 已知限制与延期工作

- **图片输入**依赖会话已挂载附件服务；纯文本端点请把 `input` 设为 `["text"]`。
- **复用模型拿不到重放状态**：Harness 会剥掉属于别的适配器的 replay 信封，这是它的隔离设计，无法绕过。复用模型看到的历史是 provider-neutral 内容。
- **推理等级（reasoning effort）**未暴露。复用候选可以用原路由的默认等级，但本插件不代为选择。
- **复用只按「路由 + 模型 id」**：无法把同一个路由的同一个模型用两套不同参数接两次（那需要原路由自己支持）。
- **模型发现**未注册：模型来自配置本身或复用。
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
