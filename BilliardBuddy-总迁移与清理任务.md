# BilliardBuddy 产品重构与清理施工合同

> 文档日期：2026-07-24
>
> 施工前比较基线：`2a6e79846a49f45a24080a9b50e93a7c66c12e61`（开始本轮重构前最后一次推送到远端的状态）
>
> 当前施工基础：本地 `main`；不得回退或重置到比较基线
>
> 目标：Windows x64 与 macOS arm64 的单一 Electron 桌面产品

`README.md` 只负责项目介绍、目录入口和基础运行方式，不承担重构裁决。本文是本轮开发的唯一施工合同，重点定义要提供的功能、希望达到的用户结果、必须守住的系统边界和完成标准；它不规定使用什么开发工具、如何拆窗口、如何分工或如何管理临时分支。

本文各模块中的“结果”和“验收”是必须兑现的合同，“做法”只是主要方向。除明确写出的硬边界、唯一真相源和外部兼容合同外，施工者可以根据当前代码选择更简单可靠的实现，不必照搬旧类、旧接口、旧目录或旧流程。

---

## 1. 最终要做成什么

BilliardBuddy 是面向台球门店经营者的桌面 Agent。用户在一个 GUI 中完成日常任务、内容创作、定时工作和招聘辅助；Agent 负责理解目标、调用工具、修改文件、生成媒体、恢复长任务并说明结果。

最终产品必须同时满足：

1. 只有一个正式 GUI、一个 Electron Main、一个本地 Product Server；每个业务领域只有一个权威状态源。
2. Agent 能力是产品核心，保留原有 Core 的循环、Tools、Skills、Hooks、MCP、子任务、resume 与 compact；GUI 通过内部 `agent-worker` 使用它，不通过公共 CLI 绕行。
3. 普通任务以 `ProductTask` 为唯一真相；图片和视频以 `MediaProject` 为唯一真相。
4. 文本、视觉、图片生成和语音各有清晰能力边界；不可用时显式失败，不偷偷切换供应商。
5. 用户看见的是任务、作品、权限、额度和恢复状态，不是模型、密钥、MCP 或内部运行时配置。
6. 旧版本可安全升级；迁移完成后，重复运行时、旧路由、旧页面和无消费者代码从源码与安装包中彻底删除。
7. 完成以真实安装包中的用户旅程为准，不以页面截图、类型检查或字符串搜索代替。

现有代码没有天然的保留义务：符合目标且足够简单的直接复用，部分有用的迁移或重构，重复、失效、无消费者或妨碍目标的直接删除；如果继续修补比重写更复杂，可以用最小的新实现重做。判断标准是最终功能和验收是否成立，而不是复用了多少旧代码。这里的“最小代码”是状态源最少、运行时最少、依赖最少，而不是省略数据迁移、持久化、安全、恢复和验收。

---

## 2. 从什么状态继续

### 2.1 基线的含义

- `2a6e7984…` 只用于回答“本轮施工搬了什么、删了什么、是否丢功能”，不是要恢复的代码版本。
- 当前 `main` 是唯一施工基础。已经实现且符合本文的代码直接保留；不符合的迁移或重写；未被当前产品消费的旧实现不因“以前做过”而自动保留。
- 历史提交、旧 renderer 和 HTML 只提供证据与参考，不能成为第二套运行时或第二份产品真相。

### 2.2 已有成果

截至本文日期，`main` 已经包含以下可继续使用的基础：

| 范围 | 状态 | 已有落点 |
|---|---|---|
| 单一 GUI 基线 | 已完成 | `3ca8b509…`，修订 `29025d35…` |
| ProductTask 权威与 durable run | 已完成 | `0f40b5d7…` |
| 内部 agent-worker、Core 解耦与标准 MCP Host | 已完成并经回查删除旧 CLI 执行残留 | `901e05e4…`、`f207dbf4…`、`2289725b…` |
| Provider registry、DeepSeek、MiMo 与网关 | 已完成并经回查收口授权、部署闭包和双机加密链路 | `ae1effa9…` |
| DeepSeek 原生 Web Search | 当前代码已有路由与测试，必须保留 | `gateway/deepseekChat.ts`、`gateway/app.ts` 及测试 |
| Preview 选元素改源码 | 已完成；只提交一次性只读 DOM 证据和原生截图，源码 revision/Diff 是完成依据 | `c5b5df7c…` |
| MediaProject 统一基础 | 已完成；图片与视频共享 owner、operation/job、不可变 Asset/Version、CAS、writer fence 和可恢复删除 | `ad1cb028…` |

这些条目代表已经具备、不得丢失的产品能力，不代表现有实现被冻结。先按本文验收；符合目标的保留，存在合同缺口或结构负担的可以重构、替换或重写，但迁移后的用户功能、数据和对外合同必须连续。

### 2.3 当前实现不是最终形态

当前代码处于迁移中。以下差异是后续施工输入，不能因“已有代码可运行”而被当成目标已经完成：

| 当前事实 | 目标改造 |
|---|---|
| ProductTask 对外权限值仍是 `ask/allow_edits/plan_only` | 模块 08 迁成本文三档产品语义；旧值只由模块 22 映射，不能把 `plan_only` 改名冒充 Full Access |
| Provider registry 只有四类 provider-neutral capability | 保持四类；原生 Web Search 是 DeepSeek `TextReasoning` 请求能力和独立协议路由，不新增第五个模型槽 |
| MediaProject 基础已统一，但工作台仍暴露 image model，并保留旧 outputs 和简化 timeline | 模块 13—16 继续迁成 provider-neutral Brief、完整 Image Operation、Evidence 与 Timeline Version；旧字段只读迁移 |
| ProductTask 中仍有 media draft、inline media 和旧 task-media bridge | 新媒体消费者稳定后停止写入，迁移旧数据，再由模块 23 删除执行链 |
| 通用 Computer Use、Python helper、AutoDream、Qwen/旧 provider 文件仍存在 | 它们是过渡代码，不是目标能力；消费者归零并通过删除闸后物理删除 |
| BrowserCapability 目前主要存在于删除/合同记录，尚非完整产品运行时 | 模块 18 建立 Chrome Extension、Native Messaging 和 ChromeSessionBridge 的正式实现 |

### 2.4 冲突判断

冲突时按以下顺序判断：

1. 本文定义的最终用户结果、安全边界和唯一真相源；
2. 当前 `main` 已接受的领域合同及其测试；
3. 当前页面和现有实现细节；
4. 历史代码、旧 renderer、HTML 原型和旧文档。

下层只能帮助实现上层，不能反过来改变产品方向。

---

## 3. 目标架构

```text
单一 Electron Renderer
        │ typed IPC
Electron Main ── 本机用户 PTY
        │ 启动、鉴权、密钥与本机能力
Local Product Server
        ├── ProductTaskService ── agent-worker ── Agent Core
        ├── MediaProjectService ── 图片/视频工作台
        ├── VoiceService
        ├── BrowserCapability / ChromeSessionBridge
        └── ProductResourceScheduler
                         │
                    Gateway / Relay
                         ├── DeepSeek：文本推理与原生联网搜索
                         ├── MiMo：结构化视觉证据
                         ├── GPT Image 2 / Seedream：图片生成与编辑
                         └── Fun-ASR：语音转写
```

硬边界：

- Renderer 只持有视图状态，不写领域真相，不接触供应商密钥。
- Electron Main 管理窗口、本机权限、安全存储、sidecar 生命周期和受控 IPC。
- Product Server 是本机领域权威；Agent Core 不能越过它直接改 ProductTask 或 MediaProject。
- Gateway/Relay 持有远程凭据、授权、额度、调度、费用回执和远程任务状态。
- 所有有成本或外部副作用的动作都必须有 owner、operation identity、幂等键、状态和可对账结果。

---

## 4. 哪些东西要搬，哪些不搬

### 4.1 保留或迁移

| 内容 | 决定 | 原因 |
|---|---|---|
| 当前 React renderer 与产品壳 | 在原位置继续建设 | 已是唯一正式 GUI，避免第二套 Vite/AppShell |
| Agent Core 循环、Tools、Skills、Hooks、MCP、子任务、resume、compact | 保留并通过内部 worker 接入 | 这是 Agent 产品的核心能力 |
| ProductTask、TaskRun、事件流、审批和工作区能力 | 保留并补齐持久化与恢复 | 普通任务只能有一套身份和生命周期 |
| Gateway、Relay、Provider registry | 保留并收口 | 已形成服务器侧密钥、能力和资源边界 |
| MediaProjectService | 作为图片和视频唯一写入者继续扩展 | 避免聊天草稿、旧工作台和新工作台各存一份 |
| 历史生图/视频编排 | 迁移好的领域思想，不复制旧运行时 | 旧版有成熟的 Brief、Evidence、Scene、Version 和 Job 设计 |
| Chrome Extension、Native Messaging 与 ChromeSessionBridge | 按 BrowserCapability 收口 | 招聘需要结构化浏览器状态，不需要通用桌面像素控制 |
| 台球经营 Skills 与知识 | 逐项核验后迁移 | 领域能力有产品价值，但完成声明必须对应真实工具和状态 |
| 受支持旧数据 reader 与 fixtures | 暂时保留只读 | 已安装用户必须能够升级，不能为清爽源码丢数据 |

### 4.2 只作参考，不搬代码

| 参考 | 可借鉴 | 不得复制 |
|---|---|---|
| `BilliardBuddy-frontend-restoration.html` | 信息层级、密度、产品感觉 | 假数据、脚本、DOM 结构和第二套页面 |
| `704bb4f2…` 中旧生图工作台 | Brief、参考图角色、三候选、版本、画布、质检、导出流程 | 旧 Store、旧 API、前端领域状态和供应商字段 |
| `704bb4f2…` 中旧视频工作台 | 素材分析、Evidence、Scene、可比较方案、revision 操作、本机导出 | 旧 VideoEditingService、旧 TaskService 接法、旧 ASR/VLM 和进程内任务状态 |
| 其他历史 UI | 控件语言、空状态、进度与失败反馈 | 整页回滚、旧 Zustand store、旧路由和旧枚举 |

### 4.3 最终删除

以下内容在消费者迁移和升级 reader 就位后必须删除：

- 第二 renderer、旧 AppShell、旧 Vite 入口、重复页面与重复 Store；
- 对普通用户公开的 CLI/TUI；内部 `agent-worker` 和 server-private Core adapter 保留；
- Qwen 可执行 provider、模型选择、fallback 和正式路由；只在迁移期保留只读值映射；
- Tavily、Brave 等旧搜索 key、旧自建搜索路由和重复搜索 Tool；
- Whisper、旧本地 ASR 和第二套转写链；
- 通用桌面 Computer Use、坐标点击、屏幕录制、Python 辅助脚本和相应设置页；
- TeamMem、AutoDream 的产品页面、后台任务和同步链；
- 图片/视频聊天草稿、中转卡和旧 media bridge；
- 面向普通用户的 provider、model、API Key、MCP、Plugin、Python 运行时管理页面；
- 无消费者的测试、fixture、配置、依赖、类型、路由和资源文件。

删除的目的不是减少文件数，而是消灭第二套真相、第二条执行路径和无法验收的维护面。

---

## 5. 不可变产品合同

### 5.1 Agent 与普通任务

- `ProductTask` 是项目、工作区、线程、TaskRun、消息、事件游标和生命周期的唯一普通任务身份。
- 每次写入带 `expected_revision` 或等价 CAS；每次命令带 `client_operation_id`；重放返回同一 receipt，不重复执行。
- 提交、流式输出、工具调用、审批、停止、崩溃恢复和重连都投影为 durable event；UI 刷新后从 cursor 继续。
- `agent-worker` 只接收完成任务所需的最小输入，不能得到 host/Gateway 密钥。stdout 保持协议专用，晚到事件不能改写终态。
- Agent 的文件、Shell、Skill、MCP 和子任务能力保留，但必须受 owner、workspace、权限模式和 ProductResourceScheduler 约束。
- 本机用户终端是独立 PTY；它不是 Agent Bash 的回放板，也不能绕过 Agent 审批。

### 5.2 模型与能力

Provider registry 是 model ID、能力、上下文窗口、body budget、compact 阈值和核验日期的唯一来源。客户端不能自选或覆盖供应商。

| 能力 | 正式实现 | 规则 |
|---|---|---|
| `TextReasoning` | DeepSeek；当前登记为 `deepseek-v4-flash` | 唯一文本主模型；升级模型时整体更新 registry 和验证证据 |
| `VisualEvidence` | MiMo | 只处理受控图片/代表帧，输出结构化证据，不接管文本回合 |
| `ImageGeneration` | GPT Image 2 / Seedream adapter | MediaProject 提交 provider-neutral operation；服务端按能力路由，不静默跨 provider 重试 |
| `SpeechTranscription` | Fun-ASR | 只接收音频，返回 Transcript/时间戳证据 |

原生 Web Search 不加入上表成为第五个 provider capability。它是 DeepSeek `TextReasoning` 的受控请求能力，由 Gateway 的独立 Anthropic-compatible 路由承载；这样既保留原生搜索，又不会产生第二个文本模型或第二套 provider registry。

能力不可用时必须停止在提交前或显示真实失败。不得回退到 Qwen、Sonnet、Anthropic 模型或第二 ASR。

### 5.3 DeepSeek 原生 Web Search

这是必须保留的正式功能：

1. 普通文本继续走受控的 OpenAI-compatible Chat Completions 路由。
2. 仅包含原生搜索工具的 Anthropic Messages 请求走独立窄路由：`/v1/messages` → `https://api.deepseek.com/anthropic/v1/messages`。
3. 基础工具类型保留 `web_search_20250305`；请求字段只在 DeepSeek 当前官方兼容范围内原样透传，未确认支持的字段显式拒绝或忽略，不另造搜索 schema。
4. `server_tool_use`、`web_search_tool_result`、SSE、keep-alive 和终止原因原样处理；客户端必须能恢复中断的流，不把搜索结果伪装成普通函数调用。
5. model 由 registry 强制收口；`metadata.user_id` 只能由可信 owner 派生的匿名 ID 注入，不能接受客户端伪造身份。
6. Anthropic 入口不承担图片或文档理解。图片先经 MiMo 形成结构化证据，再交给 DeepSeek 文本回合。
7. 搜索次数、token、超时、429、取消和 usage 单独计量；密钥、请求正文和搜索结果不得进入普通日志。
8. 不得因为删除旧搜索服务而删除本路由、工具类型、响应块、测试或用户能力。

### 5.4 权限、安全与数据出境

产品面向用户只提供 Codex 的三档权限：

- **Ask for approval**：`workspace-write + on-request + user reviewer`；Agent 在工作区沙箱内执行，越过边界时由用户审批；
- **Approve for me**：`workspace-write + on-request + auto-review`；沙箱不变，只把符合条件的越界请求交给独立 reviewer 判断；
- **Full access**：`danger-full-access + never`；解除普通文件、网络沙箱和常规审批。

以上定义的是 Codex/Agent Core 的本机执行权限。无论选择哪一档，BilliardBuddy 自己的 owner、数据出境、费用、删除、招聘提交和发布等业务闸始终保留；这些是产品规则，不是对 Codex 权限名称的改写。

共同要求：

- 所有路径先 canonicalize，再校验 workspace/owner；拒绝 traversal、symlink 越界和跨项目 ID 猜测。
- Renderer 不启用 Node integration；保持 context isolation、sandbox、CSP、受限导航、受限新窗口和 sender 校验。
- 远程图片、音频、视频代表帧和文本第一次出境前，显示目的、接收能力、保留状态和是否计费，并保存可撤销 consent receipt。
- 未知 retention、无 entitlement、额度不足或远程合同不兼容时不提交上游。
- 日志和诊断包默认脱敏，不保存密钥、正文、图片 base64、Cookie、简历敏感字段或本地绝对路径。

### 5.5 资源、任务和远程副作用

- `ProductResourceScheduler` 是 agent、媒体、语音、浏览器和定时任务的统一资源入口。
- claim 至少绑定 owner、resource kind、数量、lease、fencing token、deadline 和取消信号。
- 本机、Gateway 和 Relay 都要有明确 capacity profile；配置未知即 capability unavailable，不能用乐观默认值冒充容量。
- 付费或外部副作用使用 durable Operation：先 reserve，提交后记录 provider receipt，终态再 settle。
- 网络断开但无法确认上游是否受理时进入 `outcome_unknown`；只查询原 operation，不能自动创建第二次付费提交。
- 公平性、owner 上限、总字节、磁盘、CPU、provider concurrency 和队列都要可观测并有 overload 原因码。

### 5.6 图片与视频的唯一媒体领域

`MediaProjectService` 是媒体领域唯一写入入口；可在内部拆成图片、证据、时间线、导出等服务，但所有写入必须回到同一项目仓储和 revision，不得再建独立产品 Store。

| 目标实体 | 唯一职责 |
|---|---|
| `MediaProject` | 作品的 owner、种类、当前 revision、存储和生命周期根 |
| `MediaOperation` | 一次用户意图、幂等与计费身份；重试不能生成第二次用户意图 |
| `MediaJob` | Operation 内某个执行阶段或 attempt；保存 checkpoint、进度、取消和结果状态 |
| `Asset` | 不可变的输入或输出字节及其 fingerprint、owner 和存储位置 |
| `Version` | 图片画布或媒体作品的一次不可变状态；引用 Asset，不覆盖历史 |
| `Evidence` | 从特定 source fingerprint/time range 派生的可追溯观察，不是模型自由描述 |
| `Timeline Version` | 视频 Scene/layer/锁定状态的一次不可变编排版本 |

- 编辑产生新 Version；回滚只移动 current pointer。
- 每个 Operation 绑定 owner、project、input revision、base asset/version、`client_operation_id` 和费用回执；MediaJob 只能推进所属 Operation。
- 外部素材默认只读引用；应用托管副本按 owner、配额、引用计数和 retention policy 清理。
- 聊天可调用媒体工具创建或打开 MediaProject，但不保存第二份媒体草稿或二进制结果。
- 当前 `MediaTask` 是迁移来源，不是未来第二套概念；模块 22 将仍需恢复的记录映射到 MediaOperation/MediaJob，模块 23 删除旧写入链。

---

## 6. 历史媒体编排的取舍

### 6.1 固定参考快照

旧生图与视频系统最后一个同时包含完整前后端编排的快照为：

`704bb4f2d8fa8728c9abf9358a7ac09fdeaee77f`（2026-07-16，旧 renderer 被整体替换前）

重点阅读：

- 图片：`ts/src/media/mediaJobs.ts`、`imageBriefCompiler.ts`、`imagePromptAdapters.ts`、`imageQC.ts`、`imageWorkbenchStore.ts`；
- 视频：`ts/src/media/video-edit/service.ts`、`evidence/analysisService.ts`、`planning/`、`projectStore.ts`、`render/renderer.ts`；
- 合同：`ts/shared/contracts/image-workbench.ts`、`video-edit.ts`；
- 前端只用于理解编排如何呈现：`ts/desktop/renderer-react/src/features/image-workbench/`、`video-studio/`。

### 6.2 图片中值得迁移的逻辑

1. 先把用户原话编译为可检查 Brief，再生成 provider prompt；Brief 保存用户原话、确定事实、必须保留、允许修改和缺失信息。
2. 海报/宣传图与照片优化共享同一项目和版本模型，不是两个后端。
3. 参考图带明确角色；自动猜测只能是建议，不能悄悄替用户决定。
4. 默认一次 operation 生成三个候选；候选是同一父操作下的独立 Asset，允许 partial success。
5. 选中候选后，edit、inpaint、upscale、文字图层、撤销/重做、回滚和导出都从明确 base version 分叉。
6. 中文硬文字、Logo、二维码优先走确定性画布层；生成结果另做文字、二维码、人像和输入一致性检查。
7. 长任务显示 queued/running/progress/cancel/error，但真正状态由 durable MediaJob 保存。

不迁移旧 `ImageWorkbenchStore`、前端自建版本真相、直接 provider 字段、进程内 Promise 锁、聊天 conversation 绑定和简单轮询即真相。上述逻辑并入新的 MediaProject、Operation、Asset、Version 和 Scheduler 合同。

### 6.3 视频中值得迁移的逻辑

保留以下编排顺序：

```text
ingest → analyze evidence → compile brief → plan scenes
      → user operations / alternatives → preview → local export
```

具体保留：

1. `ingest` 为每个真实源记录 fingerprint、ffprobe、音视频轨、时长、尺寸、帧率、旋转和 missing 状态。
2. `analyze` 按 source 产生带 fingerprint 的 Transcript、Shot、Visual、Audio、SourceRole Evidence；每项记录来源、版本、时间范围、置信度和警告。
3. `compile brief` 不预设 30 秒；根据用户目标、内容类型、输出渠道、必须原样文字和真实素材覆盖推荐编排方向，并明确说明理由与缺口。
4. `plan scenes` 只能引用存在的 source ID 和合法 time range。Scene 保存 story role、edit clock、video/audio/graphic layers、evidence refs、rationale、needs review 和最多三个替换候选。
5. 用户操作使用 `base_revision`；支持移动、拆分、合并、删除、替换素材、B-roll、字幕、裁切、速度、音频归属和锁定。锁定 Scene 不被重新规划覆盖。
6. 方案是同一 revision 上可比较的 Alternative，必须说明 trade-off；应用后生成新 Timeline Version，而不是覆盖原方案。
7. analyze、plan、render 是不同 durable MediaJob；每阶段有 checkpoint、输入 revision、输出 revision、取消和失败状态。
8. export 锁定 timeline revision，由本机 FFmpeg 执行，写临时文件后校验 ffprobe/hash，再原子登记新 Asset；不覆盖源素材。

不迁移旧 `VideoEditingService` 作为第二真相、旧 TaskService 适配、进程内 `activeJobs`、旧本地 ASR/VLM、无 fence 的 retry 和旧 JSON 项目目录。Evidence/Scene/Alternative 的好设计应重建在当前 MediaProject 与统一资源合同上。

---

## 7. 25 个施工范围

下面的模块是产品能力清单和依赖顺序，不是 25 套独立实现。每个模块只允许扩展前面建立的唯一合同。

### 阶段 A：基础合同

#### 模块 01：单一 GUI 基线

- 结果：只有当前 React renderer 进入开发、构建和安装包；旧 UI 仅可从 Git 历史查看。
- 做法：冻结入口、构建清单、legacy support matrix 和参考边界。
- 验收：开发态与安装包均无法启动第二 renderer；现有成果继续通过。

#### 模块 02：ProductTask

- 结果：普通任务刷新、重连、并发写入和崩溃后仍有稳定身份与状态。
- 做法：统一 task/run/message/event/revision/idempotency/lifecycle。
- 验收：重复提交不重复执行，冲突不丢写，cursor 可恢复，删除有完整回执。

#### 模块 03：内部 agent-worker

- 结果：GUI 和定时任务使用原生 Agent Core，但不依赖公共 CLI。
- 做法：Product Server 创建短生命周期 worker；只投影安全事件；统一资源 claim。
- 验收：工具、Skill、MCP、子任务、resume/compact 可用；停止只有一个终态；child 无 host 密钥。

#### 模块 04：Provider、授权与网关

- 结果：文本、原生搜索、视觉、图片和语音能力明确可用或明确失败。
- 做法：完成 registry、DeepSeek/MiMo/Fun-ASR/Relay、auth、entitlement、usage、data-egress、deployment manifest 和兼容握手。
- 验收：保留 DeepSeek Anthropic Web Search；无隐藏 fallback；额度、身份、并发和费用可对账。

#### 模块 05：项目指令与记忆

- 结果：Agent 能读取项目指令，恢复当前任务上下文，并在用户可控范围内形成长期记忆。
- 做法：统一解析兼容指令文件、`AGENTS.md` 与 `BilliardBuddy.md`；Session Memory 绑定 task lineage；AutoMem 独立管理。
- 验收：跨项目不串记忆；`/init` 幂等；TeamMem/AutoDream 不再运行。

### 阶段 B：任务前端

#### 模块 06：产品壳与导航

- 结果：导航只呈现任务、创作、经营、已安排和设置。
- 做法：在当前 renderer 建立单一 shell、主题、首启和 capability-aware 空状态。
- 验收：普通用户不先选择模型、provider 或工作目录；键盘、缩放和窄窗可用。

#### 模块 07：对话与 Composer

- 结果：提交、流式回答、停止、恢复、引用和附件形成完整任务体验。
- 做法：UI 只消费 ProductTask snapshot/event；附件先安全摄取并绑定 owner。
- 验收：重连不重复消息，停止不出现晚到内容，附件失败不丢文字草稿。

#### 模块 08：权限与审批

- 结果：三档权限语义一致，危险动作显示将做什么、作用范围和后果。
- 做法：统一 permission snapshot、approval request/receipt 和自动 reviewer；显式迁移当前 `ask/allow_edits/plan_only`，不得仅改显示名称。
- 验收：Approve for me 不扩大沙箱；Full access 下 Codex 不再执行常规审批，但产品业务闸仍然生效。

#### 模块 09：队列、引用、分叉与恢复

- 结果：运行中可排队后续消息、引用历史、从某点分叉并恢复失败任务。
- 做法：队列和 fork 都写 durable intent；分叉保持独立 lineage 和执行目录。是否使用 Git worktree 是产品实现选择，不是本文规定的开发流程。
- 验收：崩溃后顺序稳定；分叉不篡改父任务；重复恢复不重复执行。

#### 模块 10：文件、Diff 与行评论

- 结果：用户可安全查看文件树、选区、修改 Diff 和逐行意见。
- 做法：统一 WorkspaceFileRef、revision、stale detection 和 comment identity。
- 验收：越界路径拒绝；旧 revision 不能覆盖新文件；二进制和大文件有安全降级。

#### 模块 11：Preview 选元素改源码

- 结果：用户在预览中选中元素，Agent 修改真实源码并返回 Diff。
- 做法：沙箱化预览，只发一次性 DOM evidence/capability；源码 revision 才是完成依据。
- 验收：远程页面无 Node 权限；选择失效会重选；仅改运行时 DOM 不算完成。
- 当前落点：`c5b5df7c…` 启用 ProductTask 内的源码预览面板，复用 Electron 原生 `WebContentsView` 和既有 durable TaskRun/附件摄取链。Electron Main 与 Renderer 共同单次消费选择授权，证据绑定当前页面 URL，导航或来源不一致即失效；页面数据经上限净化并标记为不可信，只用于定位。原生截图随任务输入进入 Core，提交后转到模块 10 的 Workspace revision/Diff 审阅。
- 已删除：旧 `editBubble`/`popover` 页面内编辑链、DOM 文本/样式写入和 `html2canvas` 页面截图依赖。预览注入脚本只选取和短暂标注元素，不再存在“改了运行时 DOM 就算完成”的第二条路径。
- 保持边界：远程页面仍为 `sandbox: true`、`contextIsolation: true`、`nodeIntegration: false`；通用 BrowserCapability 和招聘浏览器属于模块 18，本模块不提前开放被禁用的通用浏览器入口。

### 阶段 C：创作与经营

#### 模块 12：MediaProject 基础

- 结果：图片和视频共享稳定 owner、operation、job、asset、version、storage 和 deletion 语义。
- 做法：扩展当前 MediaProjectService，建立不可变 Asset、CAS、幂等 operation、writer fence、retention 和 GC。
- 验收：并发编辑不丢写；崩溃不重复付费；跨 owner 读取失败；删除可恢复和对账。
- 当前落点：`ad1cb028…` 在原 MediaProject JSON 权威源内增量建立 canonical owner、稳定 operation ID/现有 `MediaTask` job、不可变 Asset、Version 链和 writer fence；没有另建媒体状态源。旧项目/任务首次读取时原位补齐基础记录，现有生图 idempotency key、`outcome_unknown` 和远端任务恢复保持不变。
- 存储与并发：托管图片按 SHA-256 写入全局内容寻址存储并去重，项目私有副本继续兼容现有读取；跨进程 `proper-lockfile` 与每次写入更新的 fence 共同阻止静默覆盖。Asset ID 已存在时，角色、存储位置、大小或内容哈希变化一律拒绝，视频外部素材和用户导出文件只登记、绝不纳入托管删除。
- owner 边界：普通媒体 API 只枚举和操作 `local_workbench` owner；项目一旦显式归属 ProductTask，通用项目、任务和资产路由统一表现为不存在，只能经已验证的 task-scoped 投影读取。持久层 owner、围栏、CAS locator 和本机路径不进入 Renderer 公共合同。
- 删除与恢复：删除先写 durable receipt，再让项目下线并迁移任务及托管资产；回执记录 owner、task IDs、文件数、字节数、删除时间和清理时间。`GET /api/media/deletions` 与 `POST /api/media/project/:id/restore` 提供同 owner 恢复；重复删除、删除中崩溃和恢复发布后崩溃均可重放。默认保留 30 天，可由 `BB_MEDIA_DELETION_RETENTION_DAYS` 在 1—365 天内调整；本地服务启动时清理到期回收区、孤立 CAS blob 和中断临时文件，同时永久保留对账回执。
- 验收证据：媒体服务/API 49 项通过；服务端 1341 项通过、1 项显式 live skip；桌面 908 项、类型检查和生产构建通过。`check:product-contracts` 仍只命中施工前已登记的模块 23 `autodream-teammem` consumer 缺口，本模块未伪造引用绕过。

#### 模块 13：生图工作台

- 结果：用户从 Brief 和参考图获得三候选，继续编辑、局部重绘、放大、文字排版、回滚和导出。
- 做法：迁移第 6.2 节编排；所有生成经 provider-neutral ImageGeneration，所有结果进入 MediaProject；移除 renderer 对 model/provider 的直接选择和提交。
- 验收：三候选属于一个 operation；base/mask/version 校验；精确文字可控；不产生聊天媒体草稿。
- 当前落点：`e2f4be59…` 将用户请求编译为 provider-neutral Brief，为参考图显式标注 subject/style/composition/palette 等作用，并将固定三候选绑定到同一 operation。Renderer 不再选择 provider、model 或候选数；GPT Image 与豆包 Seedream 均为正式 `ImageGeneration` 注册项，由服务端按能力路由。
- 版本工作流：`73c9e88a…` 以显式 base version 创建编辑或局部重绘，局部重绘只接受与基础图同尺寸的 PNG 蒙版；生成、编辑、局部重绘、2×/3×/4× 本机放大和确定性文字图层全部写入不可变 Version 分支。`current_version_id` 只移动当前指针，撤销、重做和回滚不删除后续版本；导出始终按显式 Version 读取受管资产。
- 文字与权限：Brief 的 `exact_text` 必须与独立文字图层精确相等，子串不能冒充；付费图片操作只能由 Electron Main 注入一次性 UI capability。公开工作台合同只暴露 Version 历史和当前指针，不暴露 provider、model、内部 operation、本机路径或旧 outputs；旧 outputs 仅作一版只读迁移兼容，留待模块 22/23 按支持期物理收口。
- 验收证据：服务端全量 1343 项通过、1 项显式 live skip；桌面端 139 个测试文件共 909 项通过，类型检查和生产构建通过；Electron 30 个文件共 210 项通过并完成 Main/preload 构建。`check:product-contracts` 仍只命中施工前已登记的模块 23 `autodream-teammem` consumer 缺口。

#### 模块 14：图片可靠性与容量

- 结果：五分钟级图片任务可等待、恢复、取消和对账，不重复扣费。
- 做法：Gateway/Relay 使用统一 scheduler、分 provider 容量、持久队列、receipt、retention、ack 和 `outcome_unknown`。
- 验收：至少 300 秒媒体 deadline；断网后查询原 operation；真实 preflight/负载证据支持发布声明。

#### 模块 15：Fun-ASR 语音

- 结果：录音或音频上传可转写、编辑并绑定到 Composer 或视频 Evidence。
- 做法：VoiceOperation → Transcript → immutable TranscriptRevision → consumer binding；按策略保留和 GC。
- 验收：取消和迟到不串任务；编辑不覆盖 raw；无 consent/额度不发送音频；最终无第二 ASR。

#### 模块 16：视频工作台

- 结果：导入真实素材后按证据得到可编辑第一版，锁定场景、预览并在本机导出。
- 做法：迁移第 6.3 节编排；DeepSeek 只读 Brief/Evidence，MiMo 只收代表帧，Fun-ASR 只收音轨，FFmpeg 只做本机确定性动作。
- 验收：不存在或越界 source range 被拒绝；Evidence stale 不覆盖用户版本；锁定 Scene 保持；导出校验后才创建 Asset。

#### 模块 17：已安排任务

- 结果：用户可创建、暂停和查看计划任务与桌面通知。
- 做法：持久 schedule、logical occurrence、missed-run policy、scoped grant 和 ProductTask run。
- 验收：休眠恢复不回放无穷积压；同一 occurrence 只执行一次；无人值守权限不超出 grant。

#### 模块 18：浏览器与 BOSS 招聘

- 结果：Agent 可辅助筛选和准备沟通，但真实发送、邀约、拒绝等副作用由人确认。
- 做法：Chrome Extension + Native Messaging + ChromeSessionBridge；结构化读取页面、最小字段、脱敏和审计。
- 验收：无 Cookie 提取、无坐标控制、无通用桌面 Computer Use；保护属性不参与排序；发送前必须人工确认。

#### 模块 19：台球经营 Skills

- 结果：排班、活动、复盘、内容和经营建议能调用真实产品工具形成结果。
- 做法：Skill 只编排，不拥有业务状态；知识按需加载并注明来源、时间和不确定性。
- 验收：没有工具回执不能宣称完成；跨门店数据隔离；过期事实会提示核验。

### 阶段 D：收口与迁移

#### 模块 20：本机终端

- 结果：用户在任务内使用真实交互终端。
- 做法：Electron Main/sidecar 通过 `node-pty` 管理 owner、cwd、env、resize、exit 和恢复边界。
- 验收：不是 Agent 命令回放；跨任务不可接管 PTY；关闭与崩溃后进程状态真实。

#### 模块 21：设置与能力快照

- 结果：设置只展示用户能理解和能行动的项目、权限、通知、额度、存储、更新和隐私状态。
- 做法：服务端汇总 `configured/available/running/degraded` capability snapshot；高级技术信息只进诊断包。
- 验收：不提供 provider/model/key/MCP/Python 管理面；不可用原因与修复入口准确。

#### 模块 22：版本化迁移

- 结果：从所有受支持版本升级时，任务、媒体、设置和计划不丢失。
- 做法：backup-first、versioned、idempotent migrator；legacy reader 只读；每个来源有 fixture 和支持期限。
- 验收：重复迁移结果一致；失败可回滚；最老支持版本有真实升级测试；未知 schema fail closed。

### 阶段 E：删除、发包与验收

#### 模块 23：物理删除

- 结果：所有已迁移且无 reader 责任的旧代码、依赖、配置、测试和资源从仓库消失。
- 做法：按第 8 节删除闸执行，并清理 package、构建脚本、环境变量和安装包清单。
- 验收：源码、依赖图、构建产物和安装包均不存在旧运行时；正式能力仍通过纵向旅程。

#### 模块 24：双平台发包与更新

- 结果：Windows x64 与 macOS arm64 可安装、签名、启动、更新、失败恢复和回滚。
- 做法：固定构建输入、组件兼容矩阵、签名/公证、update manifest、健康检查和 rollback floor。
- 验收：干净机器真实安装；升级保留数据；坏更新不循环；安装包不含开发入口和旧运行时。

#### 模块 25：全链路验收

- 结果：可以基于证据决定发布，而不是基于“代码看起来完成”。
- 做法：执行用户旅程、故障恢复、隐私、安全、容量、升级、安装包和自动更新矩阵。
- 验收：所有阻断项关闭；未验证的线上容量明确写未验证；最终由真实安装包用户验收。

---

## 8. 最终删除闸

每条旧链必须依次经过：

1. **停止写入**：新版本不再产生旧 schema 或旧任务；
2. **迁移消费者**：正式 UI、Agent、计划任务和工具全部改走新合同；
3. **只读兼容**：受支持旧数据只由登记 reader 读取，不能继续执行旧 provider/业务逻辑；
4. **物理删除**：删除源码、路由、依赖、配置、测试、资源和构建入口；
5. **安装包证明**：解包 Windows/macOS 产物，证明旧文件、命令、字符串、依赖和网络入口不存在。

只有同时满足以下条件才可物理删除：

- 消费者图为零，或只剩明确登记且仍在支持期的迁移 reader；
- 新链已有纵向测试和真实用户旅程；
- 旧数据有 fixture、迁移、备份和失败恢复；
- 删除后产品合同、类型检查、测试、打包和安装验证通过；
- Git 历史和必要第三方许可证仍能追溯。

迁移 reader 不能永久保留。至少发布一个包含该 reader 的稳定版本，并在最低支持版本政策允许后，单独删除 reader 与 fixture。

---

## 9. 总体验收标准

每个能力完成时都要证明：

```text
用户得到的结果
+ 唯一权威状态
+ 明确 owner / revision / operation identity
+ 取消、冲突、崩溃和重连行为
+ 权限、隐私、费用和资源边界
+ 旧消费者已迁移
+ 安装包中的真实可用性
```

最低验证包括：

- `bun run check:product-contracts`
- `bun run check:server`
- `bun run check:desktop`
- 相关单元、集成、契约、故障注入和真实媒体 fixture
- `git diff --check`
- Windows x64 与 macOS arm64 安装包解包审计
- 从最老受支持版本升级、更新失败恢复和回滚演练
- 普通任务、三档权限、DeepSeek 原生搜索、图片三候选、视频证据编排、语音、计划任务、招聘人工确认和本机终端的端到端旅程

不得用 mock 页面证明产品完成，不得用源码搜索证明安装包完成，不得用代码中的并发数字证明线上容量。

---

## 10. 外部事实来源

外部资料只用于核验协议和平台事实，不改变本文产品方向：

- DeepSeek Anthropic-compatible API：<https://api-docs.deepseek.com/guides/anthropic_api>
- DeepSeek 模型与 API 更新：<https://api-docs.deepseek.com/updates/>
- Anthropic server-side Web Search 协议：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>
- Electron 安全清单：<https://www.electronjs.org/docs/latest/tutorial/security>

供应商宣传、静态模型表、代码注释和本地配置不能单独证明账号配额、保留期限、真实吞吐、签名、公证或生产部署已经生效。

---

## 11. 完成定义

当且仅当以下事实同时成立，本轮重构才算完成：

- 一个安装包内只有一套 GUI、任务领域、媒体领域和 Agent 执行链；
- Agent Core 的正式能力保留，DeepSeek 原生 Anthropic Web Search 可用；
- 图片和视频吸收了历史上成熟的后端编排，但没有复活旧运行时；
- 用户能完成主要旅程，并在失败、断网、取消、升级和重启后继续；
- 所有副作用、费用、资源和数据出境可控制、可观察、可对账；
- 不再使用的代码、依赖、配置、测试、资源和安装包内容已经实际删除。
