# BilliardBuddy 产品重构合同

> 目标：Windows x64 与 macOS arm64 的单一 Electron 桌面产品。

## 文档职责

- 重构完成后，BilliardBuddy 打开**用户项目**时，`AGENTS.md` 与 `BilliardBuddy.md` 是同一层项目指令入口；它们的产品语义等同于 Claude 的 `CLAUDE.md` 与 Codex 的 `AGENTS.md`。`.BilliardBuddy/BilliardBuddy.md`、`.BilliardBuddy/rules/*.md` 和 `.BilliardBuddy/BilliardBuddy.local.md` 是 BilliardBuddy 的目录化入口。Harness 将它们从根目录到当前目录合并为一次任务快照，再交给 DeepSeek；模型不直接读取本机磁盘。
- 本仓库根目录的 `AGENTS.md` 仅约束本仓库的开发智能体；它和用户项目中同名的 `AGENTS.md` 处于不同作用域，不能据此改变 BilliardBuddy 的产品语义。
- 本文：BilliardBuddy 产品本身的重构合同，定义产品定位、架构边界、研究方法、实施顺序和完成标准；它不是要注入每个用户项目的 Agent 提示词。
- `README.md`：项目介绍、运行入口和用户如何配置项目指令。

本文是本轮开发的唯一产品裁决依据。它规定要提供的用户结果、必须守住的系统边界、可验证的研究方法和完成标准；不冻结旧类、旧接口、旧目录或旧流程。现有代码只有在符合本文合同且有验证证据时才保留，其他实现可以以更小、更可靠的方式迁移、重构或删除。

最终只保留 BilliardBuddy GUI 产品实际需要的代码：Electron 桌面壳、界面、其调用的本地服务以及模型适配。独立 CLI、TUI、开发智能体入口和旧兼容层不属于最终产品，完成 GUI 调用链迁移后直接删除；不把它们改名后继续作为第二套产品保留。所有用户可见的项目状态与配置统一使用 BilliardBuddy 名称和 `.BilliardBuddy` 目录。

---

## 1. 最终要做成什么

BilliardBuddy 是面向台球门店经营者的桌面 Agent。用户在一个 GUI 中完成日常任务、内容创作和定时工作；Agent 负责理解目标、调用工具、修改文件、生成媒体、恢复长任务并说明结果。

最终产品必须同时满足：

1. 只有一个正式 GUI、一个 Electron Main、一个本地 Product Server；每个业务领域只有一个权威状态源。
2. Agent 能力是产品核心；最终 Harness 必须提供连续模型—工具循环、Tools、Skills、Hooks、MCP、子任务、resume 与 compact。它以 Codex、Pi、Claude 的可验证合同重新实现，GUI 只通过内部 `agent-worker` 使用它，不通过公共 CLI 绕行。
3. 普通任务以 `ProductTask` 为唯一真相；图片和视频以 `MediaProject` 为唯一真相。
4. 文本、视觉、图片生成和语音各有清晰能力边界；不可用时显式失败，不偷偷切换供应商。
5. 用户看见的是任务、作品、权限、额度、恢复状态和可管理的 Agent 扩展；Skills、Plugins 与 MCP 是成熟 Agent 产品的通用能力名称，保留它们不等于展示底层技术；provider、model、密钥、协议、并发和内部运行时配置不是普通用户界面。
6. 旧版本可安全升级；迁移完成后，重复运行时、旧路由、旧页面和无消费者代码从源码与安装包中彻底删除。
7. 完成以真实安装包中的用户旅程为准，不以页面截图、类型检查或字符串搜索代替。

现有代码没有天然的保留义务：符合目标且足够简单的直接复用，部分有用的迁移或重构，重复、失效、无消费者或妨碍目标的直接删除；如果继续修补比重写更复杂，可以用最小的新实现重做。判断标准是最终功能和验收是否成立，而不是复用了多少旧代码。这里的“最小代码”是状态源最少、运行时最少、依赖最少，而不是省略数据迁移、持久化、安全、恢复和验收。

**实现选择规则：**同一用户结果只保留一条权威状态和一条正式执行路径。现有代码已满足合同、失败行为和验证要求时直接复用；缺少边界时在原路径上最小收紧；若继续套壳、兼容或转译比替换更复杂，就重写成唯一实现。不得为了迁就旧内核增加“旧对象 → 中间协议 → 新对象”的常驻链路、镜像 Store、双写、无消费者 adapter 或仅转发数据的服务。跨 GUI/本地服务、权限隔离、持久化恢复和真实远程 API 的类型契约仍应保留，因为它们承担不可替代的安全、故障或演进边界；迁移 reader 只在支持期内单向读取旧数据，不能成为正式运行路径。

**上游源码复用规则：**直接复制、移植或改造上游公开源码是正式实现选项；当它比重新写一份更小、更稳定时，应优先采用，而不是人为绕开。每次引入必须在变更中记录上游仓库、固定 commit、文件范围和许可证，并保留该许可证要求的声明、NOTICE 与商标边界。`codex-frontend-reference/` 是本轮 Codex 前端的本地源码参考，必须直接阅读其 `raw`、`reverse-readable` 与 `host-bridge`；可复用部分可直接移植到 BilliardBuddy renderer，不把它作为运行时依赖。没有源码或只有产品行为时，才以行为为参考；这不是禁止学习或复用代码，而是该材料本身没有可直接导入的源码链。许可证与本产品发行方式不兼容时，也不是假装“不能抄”，而是明确选择：接受该许可证义务后直接复用，或只复用已验证的设计/行为并自行实现。

Agent 内核同样不冻结。当前 `cc-haha` 衍生代码和 Claude Code Harness 只是不完整的待审计材料，不构成保留理由；最终 Harness 以 Codex、Pi、Claude 的公开且可验证的循环、事件、Session、权限、恢复与扩展合同重新定义。只有逐项证明符合最终合同、失败行为和验证要求的局部才可直接复用；其余直接重写或删除，不为来源、目录或历史兼容保留任何执行链。

Skill 在这个结构中是给 Agent 按需加载的操作说明、领域知识和工作流程，不是独立应用，也不是新的执行内核。Agent 负责理解和编排，Tool、MCP 和产品 API 提供真实能力，ProductTask、MediaProject 等权威状态源保存结果。Skill 可以教 Agent 如何做事，但不能自建业务数据、绕过权限或用提示词声称代替工具回执。

界面平衡以 Codex App 这类成熟 Agent GUI 为参考：不用技术炫技来证明能力，也不因为“不要太技术”就隐去 Agent 本身的通用概念。中央会话、`/` 能力入口、任务队列、右侧工作区和设置都应先呈现用户目标、当前状态和下一个可执行动作；只有在管理扩展时才使用 Skills、Plugins、MCP 等稳定名称，其余技术细节收进诊断和内部运行层。

前端设计获得主动学习 Codex App 等成熟 Agent GUI 的授权：后续发现整体气质、布局、样式、信息密度、留白、层级、文案、状态反馈、动效或操作细节不如成熟 Agent App 时，可在不损害 BilliardBuddy 台球经营场景、产品合同和真实能力的前提下主动调整。学习的是完整的产品秩序和交互质量，不是像素级复刻品牌资产；验收看整条用户旅程是否自然、一致、游刃有余，不以单个页面或按钮相似度代替。

---

## 2. 当前施工基线

本文以当前用户确认的产品定位为唯一施工基线：BilliardBuddy 是以聊天为主的桌面 Agent 产品，聊天由 DeepSeek 与 Agent Harness 驱动；生图和视频是独立工作台，工作台内的多模态理解与规划由 MiMo V2.5 负责。它们共享同一个 App 壳、身份、权限、资源调度和持久化底座，但不共享错误的 Agent 执行链。

现有代码、测试、部署和历史提交都只是待核对的候选实现，不自动构成正确架构或完成证据。每次改动必须先按第 3.0 节读取外部可得源码与当前生产调用链，再按第 4 节合同和第 5 节实施轮次决定保留、迁移、重写或删除。


## 3. 目标架构

```text
┌──────────────────── 一个 Desktop App Shell ────────────────────┐
│ 左：项目/板块/任务/扩展   中：当前主工作   右：成果预览 或 运行检查器 │
│                         Chat | Image | Video                   │
└─────────────────────────────┬──────────────────────────────────┘
                              │ typed IPC
                     Electron Main
              本机权限、安全存储、窗口与 sidecar 生命周期
                              │
┌────────────────────── Local Product Server ────────────────────┐
│                                                                  │
│ 聊天域：ProductTask / Thread / Turn / Item                       │
│   DeepSeek ↔ Agent Harness ↔ Tool / MCP / Skill                  │
│        └─ 媒体附件 → MiMo VisualEvidence → 证据 → DeepSeek       │
│                                                                  │
│ 图片域：Image MediaProject → MiMo MediaReasoning → Image Job     │
│ 视频域：Video MediaProject → MiMo MediaReasoning → Timeline Job  │
│   两个工作台均不进入聊天 Harness，也不转 DeepSeek                  │
│                                                                  │
│ 共享控制面：身份/权限/版本/持久 Job/资源调度/计划任务/审计         │
└─────────────────────────────┬──────────────────────────────────┘
                              │ 受控远程能力
          ┌───────────────────┴───────────────────┐
          │ Gateway                                │ Relay
          │ DeepSeek TextReasoning                 │ ImageGeneration
          │ MiMo VisualEvidence（仅聊天）          │ 异步回执 / blob
          │ MiMo MediaReasoning（仅工作台）        │
          │ Fun-ASR SpeechTranscription            │
          └───────────────────────────────────────┘
```

硬边界：

- Renderer 只持有视图状态，不写领域真相，不接触供应商密钥。
- Electron Main 管理窗口、本机权限、安全存储、sidecar 生命周期和受控 IPC。
- Product Server 是本机领域权威；Agent Core 不能越过它直接改 ProductTask 或 MediaProject。
- Gateway/Relay 持有远程凭据、安装身份、额度、调度、上游回执和远程任务状态；这是 Harness 的运行基础设施，不是用户可见的“付费操作”或逐操作出境确认系统。
- 不能安全重放的外部动作和长时异步任务必须有 operation identity、幂等键、状态和可对账结果；这是可恢复执行约束，不是另一套用户审核流程。

### 3.0 调研与实施的不可跳过门槛

本文的三条主线必须分别以**外部可验证证据 + 当前代码事实 + 可验收差距**作出决定，不能以产品宣传、截图、模型印象或“看过类似产品”替代。每一次进入代码改动前，负责人必须在同一变更说明或 PR 中留下以下五项：

1. 已读的外部源码仓库、固定 commit/版本、具体文件与许可证；若完整实现未公开，明确写“未公开”，只引用公开的 SDK、协议或产品资料；
2. 已读的 BilliardBuddy 生产调用链、权威状态、测试和失败路径，不能从历史文档或 UI 名称推断现状；
3. 外部做法解决的用户问题、它不适用于本项目的条件，以及本项目选择/拒绝它的理由；
4. 最小改动后的合同、状态迁移、权限、取消、重试、恢复和资源释放行为；
5. 对应的定向测试、故障注入和真实用户旅程证据。未验证的上游能力必须明确标为未验证，不能以模型文档推定已经可用。

| 主线 | 必读外部实现与资料 | 已得到的架构结论 | 每次实施前必须核对的本项目事实 |
|---|---|---|---|
| 聊天 Harness 与 GUI | Codex 公开 `Turn` loop、App Server，以及本地 `codex-frontend-reference/` 的前端代码；Pi 的 `agentLoop`；Claude Code 的公开 Session/Tool 合同。 | Codex 前端代码负责聊天 GUI 的信息架构、组件和交互参考；Codex/Pi/Claude 的 Harness 代码与合同负责连续模型—工具循环、流式事件、steer、compact、resume、权限和工具授权。 | `query`/agent-worker、ProductTask/TaskRun、Tool/MCP/Skill 发现、`visionBridge`、桌面 Thread/Composer/`/`/右侧检查器及其测试。 |
| 生图工作台 | InvokeAI 已读 `session_queue`、工作流调用和前端 queue 状态事件源码；Firefly Boards 的画布/参考图/候选交互资料。 | 图像创作是项目、版本、持久 Job 与候选资产的工作流，不是聊天子循环；前端状态来自权威 Job/Event，不靠轮询猜测。 | `MediaProject`/`MediaOperation`/`MediaJob`、ImageWorkbench、图片 provider adapter、版本/Asset 合同、取消与迟到回执测试。 |
| 视频工作台 | OpenShot 已读项目数据更新、时间线状态机与独立预览线程源码；OpenCut 的源码仅作为仍在重构中的布局/分层观察，不能当成熟执行内核；再以 Runway、Premiere、Descript 的公开产品资料核对素材、检索、时间线、预览与导出体验。 | 视频编辑需要独立项目真相、有限状态机、非阻塞预览与可重放导出；VLM 只提供证据/建议，不能持有时间线或代替渲染。 | `videoAnalysis`、VideoStudio、素材 fingerprint、Evidence/Transcript、Timeline Version、FFmpeg Job、预览/导出/恢复及其真实素材测试。 |

#### 3.0.1 源码阅读、混淆推理与落地方法

“读源码”不是搜索几个关键词，也不是把别人的目录结构搬过来。每项结论必须先写成一条证据链：**外部产物/源码 → 可观察状态与转换 → 用户行为 → BilliardBuddy 的权威状态与调用链 → 可测试的改动**。没有这条链，就不能开始重构。

| 证据等级 | 可以据此决定什么 | 不能据此声称什么 |
|---|---|---|
| 直接证据 | 已读的固定 commit 源码、官方协议、未改写的 bundle、实际事件名/参数/宿主调用 | 未读部分的内部算法或私有服务 |
| 交叉推理 | 两个以上独立产物一致，例如页面组件、中文文案、动作注册和 host bridge 都指向同一状态转换 | 逐像素设计稿、隐藏 feature flag 的最终产品语义 |
| 假设 | 仅用于提出待验证问题和实验 | 实施依据、产品承诺或完成声明 |

`codex-frontend-reference/` 是本轮 Codex 前端的唯一指定本地源码参考，前端重构必须先读它，而不是凭截图仿制。读取顺序固定为：先读 `README.md` 的提取版本与完整性说明；再从不可改写的 `raw/webview/` 读取实际 chunk/import/字符串；随后在 `reverse-readable/` 追踪组件边界、动作、事件、中文文案和参数；最后用 `host-bridge/build/` 验证前端如何调用 Electron 宿主。可读且适配的组件、状态组织和交互可以直接移植、拆分或改造到 BilliardBuddy renderer；变量名混淆或 source-map 缺失时，再通过“入口 → 状态 → 动作 → UI 反馈 → host/API”补足理解。它不是 BilliardBuddy 的运行时依赖；移植后的代码必须接到 BilliardBuddy 自己的状态和 IPC，不能把原 bundle 整体塞进安装包或用假状态模拟后端。

| 对象 | 必读源码/产物 | 推理结果如何映射到本项目 |
|---|---|---|
| Codex | 公共 `Turn` loop、App Server 协议；本地 `codex-frontend-reference` 的 thread shell、Composer、queued message、side panel、artifact preview、projects/worktrees、settings chunks | 先直接读并移植可用的前端组件/状态组织；再把 Thread/Turn/Item、队列、Diff/结果预览、右侧工作面映射到 `ProductTask`、`TaskRun`、Item/Event、桌面侧栏/Composer/右栏。原 bundle 不作为最终运行依赖，移植代码接入 BilliardBuddy 自己的 IPC 与状态。 |
| Claude Code | 先盘点公开仓库实际内容；核心执行器未公开时只读公开 SDK/Session/Tool/MCP/Hook 合同与可运行集成 | 把“未公开”作为边界，学习可验证的 Session、结构化 tool result、权限和恢复合同；绝不从 CLI 外观倒推私有 Harness。 |
| Pi | `packages/agent/src/agent-loop.ts` 以及 Harness、Session、Hook、Skill、steer/follow-up/compact 相邻实现 | 先判断直接移植或改造是否比重写更小；抽取/复用内循环、外循环和事件边界，映射到现有 Query/Core、agent-worker、TaskRun 和持久事件。 |
| 生图工作台 | InvokeAI 的 session queue、workflow invocation、前端 queue event、Canvas/Workflow 源码；Firefly 仅作为公开交互资料 | 抽取“项目/画布/候选/版本/持久 Job/状态事件”合同，映射到 `MediaProject`、`MediaOperation`、`MediaJob`、`Asset/Version` 和 ImageWorkbench；MiMo 只负责可校验的理解/计划。 |
| 视频工作台 | OpenShot 的 ProjectDataStore、时间线状态机、preview worker；OpenCut 仅限其已实现部分；Runway/Premiere/Descript 仅作产品体验资料 | 抽取“项目真相、有限状态交互、异步预览、时间线版本、确定性导出”，映射到素材 fingerprint、Evidence/Transcript、Timeline Version、FFmpeg Job 和 VideoStudio；不把 VLM 文本当成已渲染视频。 |

每一次落地必须交付一张“参考—改动”表：参考文件/commit、直接证据或推理等级、要解决的用户问题、BilliardBuddy 当前代码路径、唯一状态源、最小改动、失败/恢复行为、测试与真实旅程。该表未完成时，只能继续调研，不能修改生产执行链。

论文和技术报告用于验证模型能力边界、抽帧/时序理解的假设和评测条件，不能直接替代产品架构。当前 MiMo-VL 技术报告支持将 VLM 用于视觉理解与多模态推理；视频时序研究也支持“采样策略必须受任务约束”这一原则。因此，在真实素材和上游 API 合同验证前，聊天与工作台都保持本机有限抽帧、音轨分离、可追溯来源与 schema 校验，不假定可安全直传任意整段视频。

调研也明确排除了一个不应自创的产品层：Codex 与 Claude 的确认发生在工具权限边界，Pi 的 loop 只发出事件并执行受宿主控制的工具；它们都不要求每个任务进入“请审核”“请发布”或“请确定”的通用流程。生图和视频工作台的成熟做法是候选/版本、画布或时间线、预览与导出。BilliardBuddy 因此只保留工具权限确认，以及可查看的真实结果、版本和运行历史；不得新增泛化审核、发布确认或 review inbox 工作流。

### 3.1 Agent Harness 的固定责任

#### 3.1.0 为什么要学习 Codex、Pi 与 Claude Code

学习对象不是它们的品牌、界面像素或某个内部类，而是它们都必须解决的同一组生产问题：模型会连续调用工具，用户会在运行中补充指令，长会话会超出上下文，桌面程序会断线/重启，工具会失败或需要工具授权，定时任务会在用户不在场时触发。一个可替换模型的 Agent 产品，必须先把这些边界做成稳定合同，前端才可能自然。

| 参考对象 | 已核实的做法 | 本项目学习的原则 | 直接复用/改造决定 |
|---|---|---|---|
| Codex | 公开 App Server 以 `Thread → Turn → Item` 表示会话、一次执行和可流式的消息/工具/工具授权项；支持 start、resume、fork、steer、compact、分页历史和 item 终态事件。Core 在同一 Turn 内把 tool result 再送回模型，直到最终回复。 | 让 GUI 消费稳定事件与终态，不能从聊天 DOM 猜执行结果；Turn 是唯一可写边界，历史可分页、恢复和分叉。 | 官方开源 Harness/App Server 与本地前端参考中的可用部分，都可直接移植或改造；最终只保留 BilliardBuddy 所需的最小一套。 |
| Pi | `agentLoop` 明确区分“工具结果继续采样”的内循环与“follow-up 继续工作”的外循环；Harness 持有 Session、Hooks、Tools、Skills、steer/follow-up 队列与 compact，并把每一步变成事件。 | 保留一个小而清晰的模型—工具循环；把队列、持久化、compact 和 Hook 放在 Harness 周围，而不是塞进业务 Tool。 | Pi 的 MIT 源码可在记录 commit/许可证后直接复用或移植；不需要保留其 CLI/TUI 或把 Cron 塞进 loop。 |
| Claude Code / Agent SDK | Claude 的公开 CLI 仓库不包含完整核心执行器，不能伪称已读；官方 SDK/平台则明确 Session、工具/MCP、Hook、客户端 tool result、resume 与环境是独立合同。 | Tool 只返回结构化请求，Host 执行后回传结果；Session/环境/权限与业务实体分离，恢复必须有持久记录。 | 对有明确复用授权的公开包可直接复用；核心执行器不在可自由复用的源码范围内时，以公开合同和产品行为补全。 |

因此，本项目不预设保留当前 cc-haha 衍生 Harness。先以 Codex 的 Turn/Item、Pi 的小循环和 Claude 的 Session/Tool/权限合同定义一个唯一 Harness，再逐个审计现有模型流、Tools、Skills、Hooks、MCP、compact、resume 与错误恢复：符合者直接纳入，不符合者重写或删除；不得在旧 Harness 外再包一层“新 Harness”。

BilliardBuddy 不再把 Agent Core 理解成一组需要被产品层包围的供应商功能，而是整个产品的执行脚手架。先固定四个不能混用的概念：

| 概念 | 本项目中的含义 |
|---|---|
| 模型 | DeepSeek 等可替换的推理核心；输入上下文，输出文本或 tool call，不自己拥有持久任务、文件系统或工作台状态 |
| Agent Harness | 让模型可以连续工作的运行环境；提供上下文、tool loop、Skill、MCP、权限、事件、compact、resume、取消和恢复 |
| Agent 产品 | 用户真正交互的整体；本项目中是 BilliardBuddy，包含 GUI、Product Server、Harness 和选定模型 |
| 工具与工作台 | Agent Tool 是聊天 Harness 的真实执行能力；生图和视频是独立工作台，拥有自己的项目、Job、Version 和产物，不是 Agent Tool，也不是第二、第三套 Agent Harness |

Codex CLI 可以被理解为长在终端里的 Agent 运行与交互表面：模型提供推理，CLI/Core 提供 Harness，终端提供工作环境。同理，BilliardBuddy 是嫁接选定模型的 Agent 产品；本项目以后由 DeepSeek 处理主聊天推理，由本项目的 Harness 给它提供能做事、能持续、能恢复的环境。“Agent”因此不是 DeepSeek 的别名，也不是单独一个聊天组件。

参考 Codex、Pi 与 Claude 的公开实现后，只固定以下职责：

| 层 | 责任 | 不应承担 |
|---|---|---|
| Agent loop | 组装当前上下文，调用模型，执行 tool call，将 tool result 送回模型，直到最终回复 | 产品领域状态数据库 |
| Session | 持久消息、事件、队列、steer/follow-up、compact、resume 和中断边界 | 第二套 ProductTask |
| Tools | 执行文件、Shell、浏览器和业务 API，返回可验证结果 | 用提示词伪造完成回执，或操控独立工作台项目 |
| Skills | 按需向模型注入操作说明、领域知识和工作流程 | 独立运行时或业务状态 |
| MCP / Plugins | 发现、组合和管理外部工具、资源与可复用扩展 | 绕过当前任务权限 |
| GUI / App Server | 把 Harness 事件投影成聊天、`/`、队列、工具授权请求和成果预览 | 再实现一次 Agent loop |

聊天模型请求、聊天视觉理解和聊天 Tool/MCP 都是 Harness 的运行调用；图片生成、工作台媒体推理、语音转写和视频渲染则是独立工作台的受控 Job。两类远程调用都受安装身份、额度、普通权限、超时、取消和幂等约束，但不再创建逐操作“数据出境同意回执”或“付费操作”类型。远程处理事实在隐私说明中一次说清，不在每个 Agent 回合中反复要求确认。

#### 3.1.1 聊天 Harness 的生产闭环

聊天的最小生产循环固定为：

```text
ProductTask/Thread
  → 建立 Turn/TaskRun 和当前上下文快照
  → DeepSeek 返回最终文本或 tool call
  → Harness 在当前权限内执行 Tool/MCP，持久化 Item/Event
  → tool result 返回同一 Turn 的 DeepSeek
  → 直到最终回复、用户停止、需要工具授权或真实失败
```

`ProductTask → TaskRun/Turn → Item/Event` 是对 GUI 和产品层的稳定合同。Core session ID、模型 client、compact 快照和 worker 进程只是私有执行细节；它们可以重建或替换，不能反过来成为第二套用户任务真相。同一 `ProductTask` 同时只有一个可写 Turn；steer/follow-up 进入受控队列，不另起一条无主循环。

聊天的实现路径固定如下：

1. Product Server 创建或恢复 `ProductTask`，为这次运行建立唯一 `TaskRun/Turn`，冻结该 Turn 的权限、工作区、Skill/MCP 清单和上下文快照。
2. agent-worker 只运行 Harness：DeepSeek 采样，持久化 assistant/tool/tool-authorization 的 `Item` 事件；Tool 由 Host 执行，真实结果再回到同一 Turn。
3. 用户运行中输入不是直接并发打进模型，而是写入 steer/follow-up 队列；当前 Turn 可接受时按顺序注入，否则下一 Turn 消费。停止、取消、工具授权、失败和完成都必须写终态。
4. 聊天上传图片保持现有链路不变：`图片 → MiMo VisualEvidence → 带来源的结构化视觉证据 → DeepSeek`。DeepSeek 仍是聊天主模型；MiMo 只负责让不直接看图的文本回合获得受控视觉证据。
5. 聊天上传视频也属于同一视觉委托：`视频 → 本机有界抽帧/必要时音轨转写 → MiMo VisualEvidence → 带来源的结构化视频证据 → DeepSeek`。MiMo 不在聊天中接管对话、Tool/MCP 决策或最终答复；如果上游以后验证了可靠的视频原生输入，替换的也只是该 VisualEvidence 适配器，返回 DeepSeek 的结构化证据合同不变。
6. compact 只替换模型上下文中的历史表示，不删除权威 `Item/Event`；恢复先读取持久快照和分页历史，再决定继续、失败或等待用户。

这条链的边界同样明确：Harness 不直接写 ProductTask、MediaProject 或 renderer store；业务 Tool 不自行开模型循环；GUI 只展示 `Item/Event` 的投影。这样聊天中央区域可以像 Codex 一样始终表达“当前任务正在做什么、接下来等什么、是否已经完成”，而不是展示一串无法核验的模型文本。

#### 3.1.2 Harness 的重建决定

先完整读取 Codex、Pi、Claude 的公开实现/合同与当前调用图，再建立唯一的 BilliardBuddy Harness；不是把当前 Query/Core 继续包起来。它必须具备同一 Turn 内的模型—工具循环、事件化 Tool/工具授权回执、Session/上下文快照、steer/follow-up、compact、resume、取消、权限与扩展发现。当前 `agent-worker`、Query/Core、协议握手、密钥剥离、fencing、Tool/Skill/MCP 和事件代码逐项审计，只有证明满足该合同且比重写更小的部分才复用。

- 聊天 Harness 永远排除媒体项目和全部工作台命令；聊天只可基于聊天自身附件、Tool/MCP 回执输出文字 Brief 或建议，不能创建、打开或操控工作台项目。
- 一个 Turn 只存在一个正式模型会话、权限快照、扩展清单与事件序列；旧 Session、队列、协议或状态镜像没有唯一消费者时直接删除。
- 事件队列和历史读取必须有界、可分页、可从 cursor 恢复；GUI 只投影事件，不从聊天 DOM 或 renderer store 倒推真实任务状态。

### 3.2 生图与视频是两个独立工作台

生图和视频剪辑已经从 Agent Core 中拆出，是两个边界清楚的垂直工作台，不是聊天中临时拼出的两个流程，也不是一项“媒体 Agent”功能。它们可以复用 `MediaProject`、资源调度、权限和持久任务等底层合同，但各自保留独立的用户目标、编排步骤和工作区界面；共享底座不等于重新合并成一个工作台。

因此，两个工作台的研究对象是现有图像/视频工作台，不是 Codex、Pi 或 Claude 的 Agent 界面：生图优先读取 InvokeAI 的画布、工作流、队列与图库源码，并以 Firefly Boards 核对画布、参考图和候选体验；视频优先读取 OpenCut、OpenShot 的项目、时间线、预览与导出源码，并以 Runway、Premiere、Descript 核对成熟产品的素材、预览、时间线和导出体验。Codex 前端只为三个板块提供共同的 App Shell、左中右信息秩序和状态反馈参考，不定义画布、候选或时间线本身。

工作台同样可以直接复用源码：InvokeAI 为 Apache-2.0，可按其许可证移植 queue/workflow/canvas 的合适部分；OpenCut 为 MIT，可移植适合桌面工作台的项目/时间线部分；OpenShot 为 GPLv3，若选择直接复制则 BilliardBuddy 发行物必须接受相应 GPL 义务，否则只采用已验证的架构与行为。Runway、Premiere、Descript、Firefly 是产品体验参考，不假装有它们的源码。这里的判断是源码与许可证的实际差异，不是把“工作台代码不能抄”写成一条虚假的禁令。

| 产品能力 | 自己负责 | 不负责 |
|---|---|---|
| 生图工作台 | Brief、参考图角色、生成/编辑、候选、图片版本、画布质检与导出 | Agent 回合、视频时间线、Skill 发现 |
| 视频工作台 | 素材接入、Evidence、Scene、Timeline Version、预览与本机渲染导出 | Agent 回合、图片候选编排、Skill 发现 |
| 聊天 Agent Harness | 会话、Turn、Tool/MCP、Skill、权限、事件、compact、resume | 创建、修改或持有任何媒体项目、素材、候选或时间线 |
| 自定义 Skill（可选） | 给聊天 Agent 提供操作说明与领域流程 | 成为图片/视频工作台入口，或自建生成/渲染、Job/Store |

图片和视频工作台是桌面 App 的一级产品板块，不是聊天 Tool、不是 `/` 菜单命令，也不因用户安装/编写 Skill 而改变入口。聊天的 `/` 弹层只服务聊天能力：命令、Skills、Plugins、MCP 与受控工具；它不能暗中创建、生成或打开工作台项目。工作台的项目列表、创建按钮、导入、画布、时间线、预览和导出都在各自的独立工作区完成。

工作台之间共享的是 App Shell、身份、权限、资源调度、媒体底座与视觉语言，而不是交叉执行链。图片/视频的唯一事实仍由 `MediaProject`、`MediaOperation`、`MediaJob`、`Asset` 和 `Version` 保存；聊天消息、Skill 上下文、agent-worker 和 renderer store 都不能保存第二份作品真相，也不能成为工作台的隐式入口。

OpenAI 官方图像 Skill 证明的是“Skill 是操作说明，不是生成器或产品界面”。因此 BilliardBuddy 不内置“聊天调用生图/剪辑工作台”的 Skill，也不让用户的自定义 Skill 越过工作台边界；工作台内部固定编排由 Product Server 代码实现，用户在对应工作区完成明确操作。

#### 3.2.1 MiMo/VLM 在两个工作台中的位置

VLM（Vision-Language Model）是“能看懂画面并用语言推理”的模型，不是图片生成器，也不是视频渲染器。小米开放平台把 `mimo-v2.5` 标为全模态基础模型；小米公开的 MiMo-VL 也验证了其图片/视频理解与推理方向。因此本项目固定：聊天继续使用 DeepSeek；图片和视频工作台中需要模型理解、创意规划、参考图解释、候选质检与时间线建议时，统一使用 **MiMo V2.5 (`mimo-v2.5`)**，不用 DeepSeek 代替。

| 工作阶段 | 唯一能力 | 当前决定 |
|---|---|---|
| 聊天文本推理、Tool/MCP 决策、原生联网搜索 | `TextReasoning` | DeepSeek 是聊天唯一主模型；聊天看图先经 MiMo bridge，再回到 DeepSeek |
| 聊天图片/视频理解 | `VisualEvidence` | 保留 `媒体附件 → MiMo 结构化证据 → DeepSeek`；视频先在本机有界抽帧/必要时转写。这是聊天能力，不与工作台混用 |
| 生图/视频的理解、Brief/Scene/Alternative 建议与视觉质检 | `MediaReasoning` | MiMo V2.5 的工作台专用合同、端点、容量和用量；不经过聊天 Harness 或 DeepSeek |
| 图片生成、编辑与局部重绘 | `ImageGeneration` | GPT Image 2 / Seedream 真正生成图片；MiMo 不冒充生成模型 |
| 视频音轨理解 | `SpeechTranscription` | Fun-ASR 生成带时间戳 Transcript |
| 画布排版、素材切分、时间线预览与导出 | 本机确定性引擎 | Canvas/图层逻辑与 FFmpeg 执行；模型不能用文本声明代替产物校验 |

同一个 MiMo 模型可承担两个不同合同，但不能把它们混成一个不透明调用：聊天 bridge 只产出不可信、带来源的视觉证据；工作台 `MediaReasoning` 只产出经 schema 校验的建议/计划。二者有独立 endpoint、operation ID、并发池、超时、用量和审计。当前仍只把受控图片与本机抽取的代表帧发送给 MiMo；视频先由本机 `ffprobe/FFmpeg` 做 fingerprint、轨道检查、有限抽帧和音轨分离，音轨交 Fun-ASR。未经真实素材验证，不假定任意整段视频直传已经可靠可用。

#### 3.2.2 生图工作台的编排

生图不以“先跑一个子 Agent”为前置条件，而是一个项目与画布驱动的创作工作台：

```text
用户请求/参考图/画布选择
  → MiMo V2.5 理解参考图、整理可编辑 Brief 与约束
  → provider-neutral ImageOperation
  → Gateway/Relay 路由 GPT Image 2 或 Seedream
  → 候选 Asset + 不可变 Version + 生成元数据
  → 画布/图层编辑、MiMo 视觉质检、选择、变体与导出
```

MiMo 给出的是可编辑建议，`exact_text`、画布图层、mask、base version、候选选择和导出仍由确定性合同保护；模型不能自由改写硬事实，也不能把文字宣称为已经写进图片。每一次生成、编辑、局部重绘、放大和导出均写入不可变 Version。工作台前端借鉴 Firefly Boards 和 Invoke：把参考素材、候选胶片条/图库、画布、版本与任务状态并列呈现，让用户做“选择和迭代”，而非只在聊天里反复描述图片。

#### 3.2.3 视频工作台的编排

视频工作台也不再造一个视频 Agent loop，而是一条可恢复、可审计的阶段化工作流：

```text
素材接入 → ffprobe/fingerprint
  → FFmpeg 有界抽帧 + 音轨分离
  → MiMo V2.5 MediaReasoning + Fun-ASR Transcript
  → MiMo 基于证据产出 Brief/Scene/Alternative
  → Product Server 校验来源、时间范围、revision 和锁定 Scene
  → 不可变 Timeline Version
  → FFmpeg 预览/导出 → 校验、hash 和 Asset 登记
```

VLM 在这里就是“看画面的模型”：MiMo 说清代表帧里有什么，并在转写与 Evidence 的约束下提出剪辑方案；Fun-ASR 说清音轨讲了什么。DeepSeek 不参与视频工作台。真正的视频读取、截取、排序、预览和导出由 FFmpeg 和领域服务执行；模型输出只是受校验的计划，不是已完成产物。工作台前端借鉴成熟剪辑器：素材箱、源预览、Evidence/Transcript、时间线、节目预览和导出队列同时存在；用户能锁定场景、比较方案、回退版本，而不是接受一条聊天消息替自己改片。任一远程阶段失败时保留已提交的项目版本和可重用证据，临时帧/音轨必须删除；重启后从持久 Job 判断恢复、安全重试或明确失败，不在内存 Map 里假装任务仍存活。

### 3.3 定时任务是 Harness 外的控制面

Codex Automations 将“指令 + 可选 Skills + 时间表”作为独立对象运行，并保留运行结果；它区分每次新开聊天的 standalone 任务与复用既有上下文的 thread task，并允许项目工作在本地目录或隔离 worktree。Claude 的 scheduled deployment 也是 cron 触发新 Session、保留 run history；Pi 的 Harness 没有产品级 Cron，说明调度本来不属于模型—工具循环。

因此定时任务的正确边界是：

```text
Schedule 定义（cron、时区、missed-run policy、权限快照）
  → durable occurrence（确定性 ID）
  → ProductTask / TaskRun
  → 复用聊天 Harness 的一次正常 Turn
  → run history / 结果查看 / 通知
```

`CronService → CronScheduler → ProductTask → ProductResourceScheduler` 只是现有候选链；逐项符合上述合同且无需中转时可复用，否则重写为唯一调度链。不让模型自己计时、sleep 或从旧聊天无限自唤醒。每个 occurrence 只能启动一次；要明确 DST、休眠、错过触发、重试、取消和无人值守权限。默认运行使用独立上下文，只有用户明确选择“关联既有任务”才读取指定任务的摘要与允许的历史；两种模式都必须在 UI 中显示下一次时间、最近结果和运行记录。

### 3.4 一个 App 的前端秩序

Codex 的关键不在炫技，而在于同一个产品壳始终围绕“项目、线程、当前运行、结果和下一步”组织信息。BilliardBuddy 学习这种秩序，并让三个板块共享：左侧一级导航和项目切换、统一的顶部上下文、同一套字号/留白/色彩/图标/状态胶囊、统一任务队列与错误反馈、右侧详情/预览抽屉、键盘导航和一致的空状态。

**品牌边界固定如下：**产品名称始终是 **BilliardBuddy**；保留现有蓝色笑脸作为唯一主图标，源资产为 `ts/desktop/public/app-icon.svg` / `app-icon.png`，各平台安装图标只能由这套资产生成；保留现有品牌蓝的主色关系（`--bb-blue-*` 与笑脸渐变）。学习 Codex 的布局、密度、状态和交互，只学习产品秩序，不能替换 BilliardBuddy 的名称、蓝色笑脸、蓝色调性或品牌资产。所有启动页、侧栏、设置/关于页、任务栏/Dock 与安装包图标必须一致；未从同一源资产生成的图标、其他产品名称或其他品牌色不得进入正式 GUI。

#### 3.4.1 左—中—右不是三份聊天，而是三种职责

Codex 的公开 App 资料和 App Server 清楚地把 project/thread、运行事件、Diff/变更预览、工作树与恢复分开；公开 TUI 源码也把变更预览、patch preview、side thread 与 status feed 当成独立 UI 状态。本项目当前可解析的 Codex 前端参考代码与构建材料统一位于 `codex-frontend-reference/`（包括 `raw/`、`reverse-readable/` 和 host bridge）；它是本地研究基线，不等同于 OpenAI 公开发布的完整 Codex 桌面 App 前端源码，也不能作为“私有实现已被完整读到”的证据。完整桌面 App 前端仍属未公开范围，因此不能伪称逐像素复刻；但可验证的产品结构足以给出本项目的正确映射：

| 区域 | 对用户的意义 | BilliardBuddy 的正式内容 | 不应变成 |
|---|---|---|---|
| 左侧：导航与范围 | “我在哪个项目、哪个板块、哪些任务待处理” | 任务/聊天、图片创作、视频创作、已安排、Skills/Plugins、设置；当前项目和运行列表 | 只有历史聊天标题的无结构侧栏，或把插件设置塞进每个会话 |
| 中间：主工作 | “我正在完成什么” | 聊天的 Thread/Turn/Item；图片的画布与候选；视频的时间线与节目预览 | 三个板块都被降级成一个聊天框，或每个板块各造一套 App 壳 |
| 右侧 A：成果预览 | “实际产物是什么，能否查看和比较” | 文件与 Diff、网页预览、聊天附件、图片大图/候选比较、视频播放器/导出文件 | 只显示模型文本，或把未完成的草稿说成产物 |
| 右侧 B：运行检查器 | “系统现在在做什么，我能安全地改什么” | 聊天的 plan、Tool/授权请求/队列/引用；图片的参考图角色、图层、Version、Job；视频的素材、Evidence/Transcript、Scene 锁、Version、渲染 Job | 技术日志墙、第二个聊天窗口，或由 renderer 临时状态冒充权威任务状态 |

右侧 A 和右侧 B 是同一右侧工作区的两个标签/模式，不要求始终并排占用空间。默认随上下文切换：聊天在有文件/网页/图片时打开“成果”，等待工具权限或排队时打开“运行”；图片默认打开候选/画布预览；视频默认打开预览/时间线相关信息。用户可固定标签和调整宽度，但每个面板只消费 Product Server 的项目、Version、TaskRun 与 Item/Event，不读取模型幻觉或 DOM 临时状态。

这个设计也回答了图片与视频预览的位置：图片和视频预览不是聊天功能，它们是独立工作台的“成果预览”标签；聊天右侧只负责显示该聊天自身的附件、网页、文件和 Diff。这样同一 App 有统一的右侧体验，却不会重新把工作台接回聊天。

但主工作区必须服从任务本身：

| 区域 | 主画布 | 右侧详情 | 统一交互 |
|---|---|---|---|
| 聊天 Agent | Thread/Turn/Item 事件流与底部 Composer | 文件、Diff、网页/图片预览、任务状态 | `/` 只发现聊天命令、Skills、Plugins、MCP；运行卡片、工具权限、停止与恢复一致 |
| 生图工作台 | 画布、图层、候选胶片条/图库 | 参考图角色、生成参数、Version、Job、导出 | 同一项目标题、状态、任务队列、版本历史、空态与错误样式 |
| 视频工作台 | 素材箱、源预览、Evidence/Transcript、时间线、节目预览 | Scene、方案、锁定、Job、导出 | 同一项目标题、状态、任务队列、版本历史、空态与错误样式 |

这样“统一”表现为同一个 App 的节奏，而不是把图片和视频强行改成聊天框。前端改造时优先移除与 Codex 式任务界面不一致的重复侧栏、孤立按钮、技术术语堆砌和只靠 toast 告知状态的路径；保留各工作台不可替代的画布/时间线。Skills、Plugins、MCP 仅在聊天扩展和设置中使用稳定名称，普通用户看到的是能力、进度、结果和下一步。

### 3.5 网关与两台服务器的目标部署

本机 Product Server 继续是 ProductTask、MediaProject、媒体版本、FFmpeg、持久 Job 和恢复的唯一权威。两台远端服务器只做无状态或可恢复的受控执行，不保存第二份业务项目：

| 位置 | 责任 | 明确不做 |
|---|---|---|
| 网关服务器 | 安装身份、DeepSeek 聊天、聊天 MiMo 视觉桥接、MiMo `MediaReasoning`、Fun-ASR、模型并发/超时/用量/审计 | 保存聊天或媒体项目真相；让工作台走聊天端点 |
| Relay 服务器 | 图片生成 provider 的持久提交、异步状态、结果 blob、幂等查询与 ack | 运行 Agent Harness、FFmpeg、视频项目、聊天路由 |

网关至少分成五个明确能力和容量泳道：`TextReasoning`（DeepSeek 聊天）、`VisualEvidence`（聊天看图 bridge）、`MediaReasoning`（MiMo V2.5 工作台）、`SpeechTranscription`（Fun-ASR）和 `ImageGeneration`（转 Relay）。其中前两者虽共用 MiMo 账号，也必须分端点、并发池、operation ID、超时和用量：聊天看图不能被长视频规划挤占，工作台也不能借聊天端点绕过自己的状态合同。部署调整按这个边界进行；先完成本地契约与假上游回归，再做两台服务器的配置、迁移、健康检查和真实素材小流量验证。

本轮已获得对两台服务器、Gateway、Relay、环境配置、容量泳道和部署闭包的调整授权：只要为实现本文合同所必需，可自主实施服务器侧变更，无需把“是否能改服务器”当作额外阻塞条件。该授权不取消工程约束：变更前备份可恢复状态，先以本地契约和假上游验证，再最小化部署；部署后记录版本/配置摘要，执行健康检查和相关真实小流量旅程。不得借此扩大用户数据、公开接口、凭据读取范围或删除不可恢复数据。

---

## 4. 不可变产品合同

### 4.1 Agent 与普通任务

- `ProductTask` 是项目、工作区、线程、TaskRun、消息、事件游标和生命周期的唯一普通任务身份。
- 每次写入带 `expected_revision` 或等价 CAS；每次命令带 `client_operation_id`；重放返回同一 receipt，不重复执行。
- 提交、流式输出、工具调用、工具授权、停止、崩溃恢复和重连都投影为 durable event；UI 刷新后从 cursor 继续。
- `agent-worker` 只接收完成任务所需的最小输入，不能得到 host/Gateway 密钥。stdout 保持协议专用，晚到事件不能改写终态。
- Agent 的文件、Shell、Skill、MCP 和子任务能力保留，但必须受当前项目范围、workspace、权限模式和 ProductResourceScheduler 约束。
- 本机用户终端是独立 PTY；它不是 Agent Bash 的回放板，也不能绕过 Agent 的工具授权。

### 4.2 模型与能力

Provider registry 是 model ID、能力、上下文窗口、body budget、compact 阈值和核验日期的唯一来源。客户端不能自选或覆盖供应商。

| 能力 | 正式实现 | 规则 |
|---|---|---|
| `TextReasoning` | DeepSeek；当前登记为 `deepseek-v4-flash` | 聊天唯一文本主模型；升级模型时整体更新 registry 和验证证据 |
| `VisualEvidence` | MiMo V2.5 | 仅处理聊天图片桥接，输出带来源的结构化证据后回到 DeepSeek |
| `MediaReasoning` | MiMo V2.5；目标登记为 `mimo-v2.5` | 图片/视频工作台专用的多模态理解、Brief、质检和方案合同；不得经过聊天 Harness 或 DeepSeek |
| `ImageGeneration` | GPT Image 2 / Seedream adapter | MediaProject 提交 provider-neutral operation；服务端按能力路由，不静默跨 provider 重试 |
| `SpeechTranscription` | Fun-ASR | 只接收音频，返回 Transcript/时间戳证据 |

原生 Web Search 不加入上表成为第五个 provider capability。它是 DeepSeek `TextReasoning` 的受控请求能力，由 Gateway 的独立 Anthropic-compatible 路由承载；这样既保留原生搜索，又不会产生第二个文本模型或第二套 provider registry。

能力不可用时必须停止在提交前或显示真实失败。不得回退到 Qwen、Sonnet、Anthropic 模型或第二 ASR。

### 4.3 DeepSeek 原生 Web Search

这是必须保留的正式功能：

1. 普通文本继续走受控的 OpenAI-compatible Chat Completions 路由。
2. 仅包含原生搜索工具的 Anthropic Messages 请求走独立窄路由：`/v1/messages` → `https://api.deepseek.com/anthropic/v1/messages`。
3. 基础工具类型保留 `web_search_20250305`；请求字段只在 DeepSeek 当前官方兼容范围内原样透传，未确认支持的字段显式拒绝或忽略，不另造搜索 schema。
4. `server_tool_use`、`web_search_tool_result`、SSE、keep-alive 和终止原因原样处理；客户端必须能恢复中断的流，不把搜索结果伪装成普通函数调用。
5. model 由 registry 强制收口；`metadata.user_id` 只能由可信安装身份派生的匿名 ID 注入，不能接受客户端伪造身份。
6. Anthropic 入口不承担图片或文档理解。图片先经 MiMo 形成结构化证据，再交给 DeepSeek 文本回合。
7. 搜索次数、token、超时、429、取消和 usage 单独计量；密钥、请求正文和搜索结果不得进入普通日志。
8. 不得因为删除旧搜索服务而删除本路由、工具类型、响应块、测试或用户能力。

### 4.4 权限与安全

产品面向用户的权限层级直接学习 Codex 的三档用户决策边界，不另造第四套 Agent 权限，也不把它混成业务流程：

- **Ask for approval**：`workspace-write + on-request + user confirmation`；Agent 在工作区沙箱内执行，越过边界时等待用户决定；
- **Approve for me**：`workspace-write + on-request + automatic policy`；沙箱不变，只由明确的本机策略决定符合条件的越界请求；
- **Full access**：`danger-full-access + never`；解除普通文件、网络沙箱和常规工具授权。

权限能力的作用是为一个 `TaskRun/Turn` 决定三件事：**工具能做什么**（读、写、Shell、网络、MCP 或子任务）、**它能触及什么范围**（工作区、允许的目录、网络域和资源上限）、以及**何时必须停下等待确认**。它不决定模型、Skill 内容、用量扣费、远程数据处理或媒体 Job 成败。

| 学习对象 | 已验证的权限思想 | BilliardBuddy 的保留方式 |
|---|---|---|
| Codex | 将“技术上能否执行”的 sandbox 与“何时询问用户”的 approval policy 分开；默认收紧，按可信工作流再放宽。 | 三档 UI 只选择这两个维度的组合；每次工具调用仍由 Host 重新校验当前 workspace、网络和权限快照。 |
| Claude Code / Agent SDK | 权限是 Session 级策略，可在会话中调整；自动文件编辑仍受工作目录限制，子任务继承父任务策略。 | `TaskRun/Turn` 启动时冻结 profile；后续升级须写新的权限事件，子任务不能借机扩大权限。 |
| Pi | Agent loop 负责上下文、事件和 tool-result 循环，不承担产品级授权判断。 | Harness 不自行允许操作；每个 tool call 先经 Product Server/Host 的策略检查，再执行并持久化真实回执。 |

以上定义的是从 Codex、Claude 与 Pi 抽取出的本机执行权限合同。正式实现必须把 profile、实际批准/拒绝、执行范围和结果写为 durable `Item/Event`，GUI 只展示和发起选择，不能自行放行。

共同要求：

- 所有路径先 canonicalize，再校验 workspace/当前项目范围；拒绝 traversal、symlink 越界和跨项目 ID 猜测。
- Renderer 不启用 Node integration；保持 context isolation、sandbox、CSP、受限导航、受限新窗口和 sender 校验。
- 远程模型与远程工具是产品的正常运行路径；不设逐操作出境 consent、计费确认或 provider 工具授权。
- 安装身份无效、额度不足、能力不可用或远程合同不兼容时不提交上游，并返回用户可理解的失败。
- 日志和诊断包默认脱敏，不保存密钥、正文、图片 base64、Cookie、用户上传的敏感附件或本地绝对路径。

### 4.5 资源、任务和远程副作用

- `ProductResourceScheduler` 是 agent、媒体、语音、浏览器和定时任务的统一资源入口。
- claim 至少绑定项目范围、resource kind、数量、lease、fencing token、deadline 和取消信号。
- 本机、Gateway 和 Relay 都要有明确 capacity profile；配置未知即 capability unavailable，不能用乐观默认值冒充容量。
- 不能安全重放的长时远程任务或真实外部副作用使用 durable Operation：先 claim，提交后记录上游回执，终态再结算资源 claim。
- 网络断开但无法确认上游是否受理时进入 `outcome_unknown`；只查询原 operation，不能自动创建第二次远程提交。
- 公平性、项目范围上限、总字节、磁盘、CPU、provider concurrency 和队列都要可观测并有 overload 原因码。

### 4.6 图片与视频的唯一媒体领域

`MediaProjectService` 是媒体领域唯一写入入口；可在内部拆成图片、证据、时间线、导出等服务，但所有写入必须回到同一项目仓储和 revision，不得再建独立产品 Store。

| 目标实体 | 唯一职责 |
|---|---|
| `MediaProject` | 作品的项目范围、种类、当前 revision、存储和生命周期根 |
| `MediaOperation` | 一次用户意图与幂等身份；重试不能生成第二次用户意图 |
| `MediaJob` | Operation 内某个执行阶段或 attempt；保存 checkpoint、进度、取消和结果状态 |
| `Asset` | 不可变的输入或输出字节及其 fingerprint、项目范围和存储位置 |
| `Version` | 图片画布或媒体作品的一次不可变状态；引用 Asset，不覆盖历史 |
| `Evidence` | 从特定 source fingerprint/time range 派生的可追溯观察，不是模型自由描述 |
| `Timeline Version` | 视频 Scene/layer/锁定状态的一次不可变编排版本 |

- 编辑产生新 Version；回滚只移动 current pointer。
- 每个 Operation 绑定项目范围、project、input revision、base asset/version、`client_operation_id` 和上游任务回执；MediaJob 只能推进所属 Operation。
- 外部素材默认只读引用；应用托管副本按项目范围、配额、引用计数和 retention policy 清理。
- 聊天不创建或打开 MediaProject；聊天中只能给出图片/视频 Brief、建议和可复制的文字，实际作品始终从独立工作台开始。
- 当前 `MediaTask` 是迁移来源，不是未来第二套概念；仍需恢复的记录映射到 MediaOperation/MediaJob，旧写入链只在新消费者稳定并通过删除闸后移除。

---

## 5. 实施轮次

本轮不再以编号凑齐模块，而以三个可独立验收、又共享同一产品壳的工作流完成重构。每一轮开始前必须先满足第 3.0 节的源码阅读与当前调用链核对门槛；不得一边猜测外部实现、一边改生产路径。

### 第一轮：聊天 Agent Harness

- 目标：把聊天做成以 DeepSeek 为主模型、可连续执行、可中断、可恢复、可查看结果的 Agent 运行面，而不是堆叠聊天 UI 或把工作台塞进 Tool。
- 实施：先用 Codex `Thread → Turn → Item`、Pi loop 和公开 Claude Session/Tool 合同定义完整 Harness，再审计当前 Query/Core、agent-worker、ProductTask/TaskRun、事件 cursor、steer、compact、resume、`/`、工具授权与右侧运行检查器；符合者直接复用，不符合者重写并删除旧链，绝不在旧链外加中转层。
- 视觉边界：聊天图片与视频均走 `媒体附件 → MiMo VisualEvidence → 结构化证据 → DeepSeek`；视频先本机有限抽帧/必要时转写。DeepSeek 负责最终回答和聊天 Tool/MCP 决策，MiMo 不接管聊天。
- 验收：每个 Turn 的事件、工具授权、取消、错误、恢复与工具回执有唯一持久真相；桌面重开后 cursor 可续；聊天不能创建或操控图片/视频工作台项目。

### 第二轮：生图工作台

- 目标：把图片创作作为独立的项目—画布—候选—版本—导出工作台，而非聊天 Skill 或一次模型调用。
- 实施：在已读 InvokeAI 队列/状态事件源码和 Firefly/Invoke 画布交互的基础上，核对当前 `MediaProject`、`MediaOperation`、`MediaJob`、ImageWorkbench、provider adapter 与 Asset/Version；由 MiMo V2.5 直接完成参考图理解、可编辑 Brief、创意建议和质检，图片 provider 只负责生成/编辑。
- 模型边界：工作台不经过 DeepSeek，也不经过聊天 Harness；MiMo 的计划需 schema 校验，生成结果需以 provider 回执、不可变 Version、Asset 和导出校验确认。
- 验收：生成、编辑、取消、迟到结果、重试、项目重开、候选比较和导出均可恢复、可对账，且前端只展示权威 Job/Event 状态。

### 第三轮：视频工作台

- 目标：把视频处理做成独立的素材—证据—场景—时间线版本—预览/导出工作台，不把“模型建议”误报为已剪出视频。
- 实施：在已读 OpenShot 的项目更新、时间线状态机、独立预览线程源码，以及 Runway/Premiere/Descript 的资料基础上，核对 `videoAnalysis`、VideoStudio、素材指纹、Evidence/Transcript、Timeline Version、FFmpeg Job 与预览恢复。素材本机 `ffprobe/FFmpeg` 有界抽帧并分离音轨；MiMo V2.5 直接规划 Brief/Scene/Alternative，Fun-ASR 提供带时间的 Transcript，FFmpeg 负责预览和导出。
- 模型边界：工作台不转 DeepSeek；MiMo 输出只是可追溯、可校验的计划，不能直接修改时间线真相或声称导出成功。
- 验收：源范围、revision、场景锁、迟到结果、取消、崩溃恢复、预览线程和导出 hash 都有明确行为；必须用真实素材执行用户旅程。

### 第四轮：共享控制面与统一 App 壳

- 目标：三个板块共享项目范围、身份/权限、持久任务、资源调度、网关能力、左中右信息秩序、设置、空态和错误恢复，但不共享错误的执行链。
- 实施：复核 Gateway 的五条能力泳道、Relay、`CronService → CronScheduler → ProductTask → ProductResourceScheduler`、安装身份、用量、超时、取消与幂等；按 Codex 的项目/线程/结果查看秩序统一 Shell。右侧固定为“成果预览”和“运行检查器”两种工作面：聊天展示附件/Diff/网页与 Turn 状态，工作台展示各自的图片或视频产物与 Job/版本状态。
- 验收：定时任务是 Harness 外控制面；工作台不会借聊天端点或 quota 运行；同一 App 外观一致而不强行把画布、时间线改成聊天框。

### 第五轮：数据迁移与清理收尾

- 目标：把已验证的新合同迁入旧数据，删除被取代的执行链，并以真实安装包证明产品而非源码自证。
- 实施：逐个 reader/consumer 做停止写入、只读兼容、迁移、物理删除和安装包审计；任何已有状态、测试、配置和部署记录都重新核验，不继承“已完成”结论。
- 验收：macOS/Windows 安装、升级、回滚、断网、重启、真实上游、真实图片/视频素材与主要用户旅程全部通过；未做的容量或线上验证明确列为未验证。

## 6. 删除与迁移闸

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

迁移 reader 不能永久保留。至少交付一个包含该 reader 的稳定版本，并在最低支持版本政策允许后，单独删除 reader 与 fixture。

---

## 7. 总体验收标准

每个能力完成时都要证明：

```text
用户得到的结果
+ 唯一权威状态
+ 明确项目范围 / revision / operation identity
+ 取消、冲突、崩溃和重连行为
+ 权限、隐私、用量和资源边界
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
- 普通任务、三档权限、DeepSeek 原生搜索、图片三候选、视频证据编排、语音、计划任务和本机终端的端到端旅程

不得用 mock 页面证明产品完成，不得用源码搜索证明安装包完成，不得用代码中的并发数字证明线上容量。

---

## 8. 外部事实来源

外部资料只用于核验协议和平台事实，不改变本文产品方向：

- DeepSeek Anthropic-compatible API：<https://api-docs.deepseek.com/guides/anthropic_api>
- DeepSeek 模型与 API 更新：<https://api-docs.deepseek.com/updates/>
- Anthropic server-side Web Search 协议：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool>
- Codex Agent 回合与工具循环：<https://github.com/openai/codex/blob/main/codex-rs/core/src/session/turn.rs>；公开仓库许可证：Apache-2.0。
- Codex App Server 的 Thread / Turn / Item / 事件与恢复：<https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md>
- Codex App、Skills 与 Automations：<https://openai.com/index/introducing-the-codex-app/>
- Pi Agent loop / Harness / Skills：<https://github.com/earendil-works/pi/tree/main/packages/agent/src>；公开仓库许可证：MIT。
- cc-haha 流式 Agent 循环：<https://github.com/NanmiCoder/cc-haha/blob/main/src/query.ts>
- Claude Code 公开仓库：<https://github.com/anthropics/claude-code>；其仓库 `LICENSE.md` 为 Anthropic Commercial Terms，当前公开内容主要是插件、Skills、集成和发布记录，不把未公开的核心执行器当成已读源码。
- Claude Agent 的 Session、Tools、MCP、Skills：<https://platform.claude.com/docs/en/managed-agents/sessions>、<https://platform.claude.com/docs/en/managed-agents/tools>
- Claude scheduled deployment 的 cron 与 run history：<https://platform.claude.com/docs/en/managed-agents/scheduled-deployments>
- 小米 MiMo-VL 图片/视频理解与推理：<https://github.com/XiaomiMiMo/MiMo-VL>；MiMo V2.5 开放平台模型定位：<https://platform.xiaomimimo.com/token-plan>
- MiMo-VL 技术报告：<https://arxiv.org/abs/2506.03569>；视频任务条件化时序采样参考：<https://arxiv.org/abs/2507.13353>
- 图片工作台参考：Adobe Firefly Boards 的画布、参考图、变体与胶片条：<https://helpx.adobe.com/firefly/web/create-mood-boards/firefly-boards/add-images.html>；Invoke 的画布、工作流与图库：<https://github.com/invoke-ai/InvokeAI>（Apache-2.0）。本轮实际阅读 InvokeAI commit `68b90174aafebbbba45d14b049fb6852271c76a8` 的 `session_queue/session_queue_base.py` 与 `queueStatusEvents.ts`。
- 视频工作台参考：Runway Edit Studio：<https://runwayml.com/news/introducing-aleph-2-and-edit-studio>；Premiere 的素材智能检索：<https://helpx.adobe.com/premiere/desktop/organize-media/file-organization/media-intelligence-and-search-panel.html>；Descript 的时间线：<https://help.descript.com/hc/en-us/articles/10249275208717-Timeline-overview>。本轮实际阅读 OpenShot commit `9cd2b3f3ee9024c3496487a2de30a402515ed659` 的 `project_data.py`、`timeline_backend/state.py` 与 `preview_thread.py`（GPLv3）；OpenCut commit `4d8c49ed0706c4dc145361e01c6b1f1a87cbb863`（MIT）仅作早期重构中的面板拆分参考，不作为成熟内核。
- Electron 安全清单：<https://www.electronjs.org/docs/latest/tutorial/security>
- Chrome Native Messaging 协议：<https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>

供应商宣传、静态模型表、代码注释和本地配置不能单独证明账号配额、保留期限、真实吞吐、签名、公证或生产部署已经生效。

---

## 9. 完成定义

当且仅当以下事实同时成立，本轮重构才算完成：

- 一个安装包内只有一套 GUI、任务领域、媒体领域和 Agent 执行链；
- Agent Core 的正式能力保留，DeepSeek 原生 Anthropic Web Search 可用；
- 图片和视频吸收了历史上成熟的后端编排，但没有复活旧运行时；
- 用户能完成主要旅程，并在失败、断网、取消、升级和重启后继续；
- 所有真实外部副作用、远程用量和资源调度可控制、可观察、可对账；
- 不再使用的代码、依赖、配置、测试、资源和安装包内容已经实际删除。
