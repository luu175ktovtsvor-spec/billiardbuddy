# BilliardBuddy 单一产品重构与交付执行合同

> **文档状态：唯一实施版**
> **适用基线：每个 Work Unit 记录的 `Spec-Commit SHA` 与 `Base-Commit SHA`**
> **目标产品：Windows x64 / macOS arm64 的单一 BilliardBuddy Electron GUI**
> **前端参考：** `BilliardBuddy-frontend-restoration.html` 只提供视觉方向与信息架构参考，不是施工合同、母版、Oracle、逐像素标准或第二套前端

这份 Markdown 是本轮施工的唯一合同，只定义最终产品架构、模块边界、迁移顺序、失败语义和验收证据。HTML、历史调查、旧草稿和其他说明都不是实施依据；实施 AI 不得从 Git 历史、HTML 或临时记录重新开启已经裁决的架构选择。

---

## 0. 实施 AI 先读这里

### 0.1 如何使用本文

每个模块是一个架构里程碑；每个 Work Unit 是一个实施窗口内可独立审查、验证、回滚和提交的一窗任务。简单模块可以只有一个 Work Unit；复杂模块必须由主代理拆成多个有序 Work Unit，不得为了“一窗做完模块”制造巨大提交。

每个新窗口的主代理必须读取：

1. 本节的全局合同；
2. 第 1 节的决策登记表；
3. 第 2—4 节的术语、状态机、安全与非功能边界；
4. 当前模块卡和当前 Work Unit；
5. 当前 Work Unit 明确列出的前置模块或前置 Work Unit 交接；
6. 当前 `Spec-Commit SHA`、`Base-Commit SHA` 和工作树状态。

主代理不得只看模块标题或“实施合同”就派工。用户结果、权威状态、失败语义、验收 Oracle 和交接条件同样是硬合同。后续窗口不得依赖上一窗口聊天，只能依赖最新 Spec-Commit、已接受的前置 commit body 和仓库中的机器证据。

### 0.2 规范标签

| 标签 | 含义 |
|---|---|
| `[FACT]` | 已由当前源码、构建配置或固定 Git 参考核实的事实；开工时仍要做最小复核 |
| `[HARD]` | 不允许实施 AI改变的产品或架构决定 |
| `[TARGET]` | 当前尚未完成、但本模块必须实现的结果 |
| `[VERIFY]` | 必须留下可重复证据的验收项 |
| `[EXTERNAL]` | 依赖账号、服务器、签名或第三方页面，源码不能单独证明的事实 |
| `[DEFERRED]` | 有明确触发条件的后续清理，不得假装已经完成，也不得提前执行 |

### 0.3 删除阶段术语

针对**源码、运行时、配置、依赖、迁移器和发布物**的“删除”必须带下面一个阶段。没有阶段标签的技术删除项不得执行。用户在产品中删除任务、队列项、记忆或项目属于领域操作，按对应状态机和 owner 合同处理，不使用 D1—D5：

| 阶段 | 含义 | 允许动作 |
|---|---|---|
| `D1_STOP_WRITES` | 停止创建旧数据或进入旧路线 | 关闭注册/入口；保留旧数据读取与迁移 |
| `D2_MIGRATE_CONSUMERS` | 把所有运行时消费者切到新合同 | 可删除无状态 UI/adapter，但保留 legacy reader |
| `D3_LEGACY_READ_ONLY` | 旧实现只服务升级读取与恢复 | 不得执行旧业务副作用；必须进入最终升级包 |
| `D4_PHYSICAL_DELETE` | 消费者、迁移前置和包入口均已核对后物理删除 | 删除实现、测试、依赖、配置和文案；不得删除仍受支持的 reader |
| `D5_PACKAGE_ABSENT` | 证明最终包内没有已删除运行时 | 只由模块 24 在实际 package/ZIP/安装目录上通过包清单和可达图验证；模块 23 只能提供 D4 后的 package input 白名单，源码搜索不能代替 D5 |

同一对象可以在不同模块推进不同阶段，但只能有一个 `D4_PHYSICAL_DELETE` 负责人。模块交接必须写明当前停在哪一阶段。

不得使用“优先、尽量、视情况、必要时、以后再说”表达架构分支。局部函数名、文件拆分和无状态 UI 细节可以由实施 AI 选择最少代码方案，但不能改变状态所有权、输入输出、失败状态和删除阶段。

### 0.4 冲突优先级

发现冲突时按以下顺序处理：

```text
当前可运行源码与构建证据（只纠正 FACT）
  > 本文决策登记表
  > 本文术语、实体和状态机
  > 当前模块卡
  > HTML 视觉与信息架构参考（只辅助理解布局，不裁决产品行为）
  > 固定历史参考提交（只读代码证据；不能改变本文裁决）
```

源码只能够纠正“当前是什么”，不能推翻本文的最终产品决定。若源码事实与 `[FACT]` 不符，主代理先记录证据并修正文档事实。

若主代理发现本文存在逻辑缺口、依赖缺口、状态所有权冲突或无法闭合的验收条件，必须立即停止受影响 Work Unit 的派工，由主代理负责把这份唯一 Markdown 修正和补充完整，并先形成新的 Spec-Commit。只有更新依赖图、相关模块卡和受影响验收后，才能以新的 `Spec-Commit SHA` 重新拆分和派发 Work Unit。实施子代理只能报告合同问题，不能自行选择架构路线、修改本 Markdown 或以产品代码绕过合同缺口。

### 0.5 开发角色、施工委派与产品运行时必须分开

- `[HARD]` **主代理不写产品代码**：主代理只负责读取和维护唯一施工合同、核对源码事实、拆分 Work Unit、指定修改边界、派实施子代理、审查 diff、独立运行验证、执行最终 Git 提交，并决定接受、退回或阻塞。主代理只能亲自修改本 Markdown 和 HTML 视觉参考，不能借“集成修复”直接改产品实现。
- `[HARD]` **实施子代理写产品代码**：实施子代理只在指定 Work Unit 范围内修改产品代码、测试、fixture、manifest 和构建证据；不得修改本 Markdown，不得自行改变架构、模块依赖、状态所有权、失败语义、provider 路由或删除阶段。
- `[HARD]` 主代理发现合同缺口或逻辑错误时，必须由主代理先修改本 Markdown、补齐所有受影响条款并形成新的 Spec-Commit；不得把架构裁决下放给实施子代理。HTML 只在视觉参考本身表述不准确时由主代理同步修改。
- `[HARD]` 每个 Work Unit 只派一个拥有写权限的实施子代理；其他子代理只能做只读调查或对抗审查，不能并行修改同一工作树。实施子代理可在主代理指定的独立 worktree 创建候选提交，或在主工作树留下未提交变更；不得 push、合并或把候选提交自行标记为 accepted。主代理必须逐项复核范围、合同、测试和未验证项，不能把子代理的“完成”当作验收证据。
- `[HARD]` 主代理发现的是产品代码缺陷而非合同缺陷时，不得亲自补代码；必须退回原实施子代理，或在原模块创建 repair Work Unit 并派新的实施子代理。
- `[HARD]` **最终 BilliardBuddy 产品运行时**：保留 CC-Haha Core 原生 Agent loop、工具、权限、Skills、Hooks、MCP、子代理、后台任务、resume 和 compact。
- `[HARD]` 模块 03 的 `agent-worker` 是产品运行时进程，不是开发施工的子代理工具。

### 0.6 Work Unit、提交与跨窗口交接

模块是架构里程碑，Work Unit 是一窗任务、审查、提交和交接边界。复杂模块允许多个有序 Work Unit；每个已接受 Work Unit 必须对应一个内聚提交，一个提交不得跨模块或混入未授权清理。

主代理派工前必须为当前 Work Unit 写清：

```text
Work Unit ID：BB-<模块号><序号，例如 BB-07A>
单一用户结果：
Spec-Commit SHA：
Base-Commit SHA：
前置 accepted commit SHA：
允许修改路径：
禁止修改路径：
必须消费的冻结合同：
本 Work Unit 不负责：
验收命令、行为断言与机器证据：
完成条件：
```

实施子代理交付后，主代理只接受同时满足以下条件的 Work Unit：范围没有越界；当前已有消费者全部闭合；类型、协议、失败语义和测试一致；工作树中没有混入开工前修改；所有跳过的真实外部验证均明确记录。部分完成或阻塞不得伪装为 accepted commit。若子代理提供候选提交，主代理必须先审查其 diff 和验证结果，再以 cherry-pick 或等价方式纳入当前集成线；若子代理留下未提交变更，主代理验证后创建提交。只有集成线上的主代理提交才是 accepted commit，是否 push 仍由用户或既有发布授权决定。

每个 accepted commit 的标题必须带 Work Unit ID，例如 `feat(bb-07a): persist accepted message submissions`。commit body 是唯一跨窗口文字交接，必须包含：

```text
BB-Task: BB-07A
Module: 07
Spec-Commit: <施工合同 SHA>
Base-Commit: <开工父提交 SHA>
Status: complete

Result:
- <一句话用户结果>
Scope:
- <实际修改路径>
Contracts:
- <新增或修改的 schema/API/IPC/event；没有写 none>
Checks:
- <命令> — PASS | FAIL | SKIPPED: <原因>
Evidence:
- <测试/fixture/JSON manifest/包清单等仓库路径>
External-Verification:
- <项目> — VERIFIED | NOT_VERIFIED_EXTERNALLY | NOT_APPLICABLE
Known-Risks:
- <没有写 none>
Next:
- <下一 Work Unit ID 与启动条件>
```

当前提交自己的 SHA 不得写入其 commit body；提交完成后直接由 Git 读取。只记录 `Spec-Commit`、`Base-Commit` 和必要的前置 accepted commit，避免自引用 SHA。

后续窗口不得以聊天作为前置条件。聊天完成回报最多六行，只报告 Work Unit 状态、commit、用户结果、验证、未验证/风险和下一 Work Unit；不得重复全局背景、长代码摘要或完整测试输出。

每个 Work Unit 对本次引入或修改的运行时合同负责闭合：shared schema、IPC/API、所有当前已有消费者、失败语义和测试必须在同一提交完成，不得提交“当前消费者以后再接”的半合同。后续 Work Unit 可以消费依赖图和模块卡明确冻结的合同。若集成验证发现冻结合同本身有缺陷，主代理必须先修订本 Markdown 并创建新 Spec-Commit，再回到合同所属模块创建 repair Work Unit；不得无记录地顺手改字段。

不为施工交接新建额外 Markdown 报告。文字交接进入 commit body；机器证据进入测试、fixture、JSON/机器可读 manifest、构建输出或包清单。现有模块卡中的“交接物”表示需要进入 commit body 或机器证据索引的内容，不表示另建报告文件。

### 0.7 Work Unit 注册与冻结规则

每个可派发 Work Unit 必须在本 Markdown 的对应模块卡中登记。登记项至少包含 `Work Unit ID`、顺序、单一用户结果、依赖、允许/禁止路径、冻结合同、验收和完成条件；没有登记的 Work Unit 不得靠聊天临时派发。

`Spec-Commit SHA` 和 `Base-Commit SHA` 是运行时值，不能预写当前提交自己的 SHA。主代理先把 Work Unit 定义提交为 Spec-Commit，派工时把该 SHA 与开工 HEAD 写入子代理任务；accepted commit body 再固化两者。若施工中合同变化，旧 Work Unit 立即失效，主代理必须更新登记并创建新的 Spec-Commit 后重新派发。

当前 25 张模块卡是模块级 Work Unit registry 的初始定义：每个模块在首次开工前，由主代理依据真实消费者图把该模块卡细化为一个或多个 `BB-<模块号><序号>` 条目并提交。简单模块登记 `A` 一个 Work Unit；复杂模块必须先完整登记 A/B/C… 的顺序和边界，不能做完一半后才用聊天补编号。文档准备提交本身属于 `SPEC` 变更，不冒充模块 01 产品 Work Unit。

---

# 第一部分：全局架构合同

## 1. 不可变决策登记表

| ID | 决策 | 固定实现与失败退化 |
|---|---|---|
| `DEC-001` | `[HARD]` 当前 `ts/desktop/src` 是唯一 renderer 基座 | 最终仍只有 `ts/desktop/src/main.tsx` 一个 renderer 入口；不恢复 `renderer-react`、第二个 AppShell、第二套 Vite 或新旧壳开关 |
| `DEC-002` | `[HARD]` `4fab121e` 只读参考旧产品体验 | 只通过 `git show` 读取；允许提取无旧状态依赖的小组件、领域契约和纯函数，不迁旧 store、API、Agent、workflow runtime 或整页目录树 |
| `DEC-003` | `[HARD]` `30945a22` 只读参考第 3/4 栏联动 | 第 3 栏负责文件、Diff、图片和 Preview；第 4 栏负责文件树/变更；底部终端横跨第 2—4 栏；不恢复其 Provider/模型暴露 |
| `DEC-004` | `[HARD]` HTML 只作视觉与信息架构参考 | `BilliardBuddy-frontend-restoration.html` 可以帮助确认布局层级、导航分组、栏位关系和视觉方向；它不是产品 Oracle、母版、逐像素标准或第二施工依据，不进入正式构建，不承载状态机、失败语义或架构决定 |
| `DEC-005` | `[HARD]` 主导航为“任务、创作、经营、已安排、设置” | 图片和视频从“创作”直接进入独立工作台；BOSS 与台球经营归“经营”；文件、Diff、Preview、终端按需展开，不占主导航 |
| `DEC-006` | `[HARD]` ProductTask 是普通任务唯一产品真相源 | 普通任务只走 `/api/product/*`、ProductTask WebSocket、`ts/shared/product` 和当前数据根；不恢复旧 session/store/WebSocket |
| `DEC-007` | `[HARD]` GUI 只通过内部 `agent-worker` 使用 Core | 先抽 worker 并以 `D2_MIGRATE_CONSUMERS` 迁移所有 GUI/定时消费者；公共 CLI/TUI 由模块 23 执行 `D4_PHYSICAL_DELETE`；worker 继续调用原生 Core，不重写 Agent loop |
| `DEC-008` | `[HARD]` 文本、视觉理解、图片生成与语音能力分开 | DeepSeek 是唯一文本主模型；MiMo 只输出显式视觉证据；GPT Image 2 / Seedream 4.5 只通过 provider-neutral `ImageGeneration` 执行图片生成/编辑；Fun-ASR 只转写音频；Qwen/Sonnet/Anthropic 不作为隐藏 fallback；能力不可用时显式失败 |
| `DEC-009` | `[HARD]` context window 使用已核实真实值 | 产品合同字段为 `verified_context_window`；只有整链证据均为 1,000,000 时才能显示 1M，否则使用最小已证实上限，不关闭 compact 伪造大窗口 |
| `DEC-010` | `[HARD]` 项目指令复用 Core 原生 resolver | 同层加载顺序为 Claude 兼容源 → `AGENTS.md` → `BilliardBuddy.md`；品牌文件进入 user context/`nested_memory`，不升为临时 system prompt |
| `DEC-011` | `[HARD]` 项目指令、Session Memory、AutoMem 分开 | TeamMem 在模块 05/21 执行 `D1_STOP_WRITES`/`D2_MIGRATE_CONSUMERS`，模块 23 只执行 `D4_PHYSICAL_DELETE`，模块 24 统一执行 `D5_PACKAGE_ABSENT`；项目指令不复制进 Session/AutoMem；记忆失败不阻塞主任务；敏感内容不进入长期记忆 |
| `DEC-012` | `[HARD]` 三档产品权限固定 | `ask → default`、`allow_edits → acceptEdits`、`plan_only → plan`；权限是 TaskRun 创建时的不可变快照，修改只影响下一次 run |
| `DEC-013` | `[HARD]` Preview 模块只处理 DOM/源码修改 | DOM selection → ProductTask → Core 修改源码；图片 mask/inpaint 只属于 MediaProject，不得出现“Core 或 Media”并列所有者 |
| `DEC-014` | `[HARD]` 图片/视频不经过主聊天媒体草稿 | 工作台内部处理 Brief、追问、证据、进度、确认、版本和结果；跨工作台只传显式 immutable `asset_id`，不复制 Base64 |
| `DEC-015` | `[HARD]` MediaProjectService 是唯一媒体写入者 | 文件型存储继续使用，但同一数据根只能有一个 sidecar 写者；项目、Operation、Job、Asset、Version 都由 MediaProjectService 持久化 |
| `DEC-016` | `[HARD]` 媒体 owner 由服务端派生且支持无 Workspace 创作 | owner scope 固定为 `installation_id + media_library_id`；选择 canonical Workspace 时 `media_library_id=workspace:<canonical workspace_id>`，未选择项目文件夹时使用唯一 `media_library_id=installation-default`。`media_project_id` 是其子实体；客户端路径、ProductTask 关联或显示名称不能替代 owner 校验 |
| `DEC-017` | `[HARD]` 未知付费结果不能自动重放 | `outcome_unknown` 只能对账原 Operation；确认失败前不得创建新付费 Operation；UI 不直接消费 relay 内部枚举 |
| `DEC-018` | `[HARD]` 图片模型路由在服务端 | 局部 mask/精确编辑 → GPT Image 2；中文海报/多参考/组图 → Seedream 4.5；其余普通单图 → GPT Image 2；目标上游失败不静默跨供应商 |
| `DEC-019` | `[HARD]` 普通图片体验固定三候选 | UI 请求 `requested_count=3`；服务端内部兼容范围 `1..4`；15 仅是上游合法性上限，不是产品数量或默认值 |
| `DEC-020` | `[HARD]` 视频采用五阶段证据流水线 | `ingest → evidence → plan → edit/preview → export`；源素材只读；模型只处理 Brief 和结构化证据，不直接生成 FFmpeg 命令 |
| `DEC-021` | `[HARD]` BOSS 只使用受控浏览器能力和唯一 packaged transport | 上层协议是 `BrowserCapability`，本机实现是 `ChromeSessionBridge`；正式传输固定为 BilliardBuddy Chrome Extension + Chrome Native Messaging，MCP 仅是 Core 到 bridge 的内部 Tool 协议，不是另一 transport；不使用远程 WebSocket bridge 或 Electron Preview 冒充用户 Chrome 会话；登录、扫码、验证码和人机验证交给用户 |
| `DEC-022` | `[HARD]` 通用桌面 Computer Use 退出产品 | 模块 18/21 执行 `D1_STOP_WRITES` 与 `D2_MIGRATE_CONSUMERS`，模块 23 只执行 `D4_PHYSICAL_DELETE`，模块 24 统一执行 `D5_PACKAGE_ABSENT`；不保留 macOS/Windows 坐标控制、屏幕录制、辅助功能、Python helper 和隐式截图回合换模型；视觉状态无法映射浏览器 ref 时转用户接管 |
| `DEC-023` | `[HARD]` 本机终端是用户 PTY | Electron IPC → `node-pty` → 当前用户 shell/canonical cwd；与 Agent Bash、worker 和公共 CLI/TUI 完全分开 |
| `DEC-024` | `[HARD]` 只发两个 GUI 产品 | Windows x64 与 macOS arm64；ZIP、blockmap、latest manifest 只是更新附属文件；Chrome Web Store Extension 是模块 18 的浏览器伴随组件，不是第三个桌面产品/target，但其 ID、版本与协议必须纳入同一 release manifest；不交付 Linux/Tauri/公共 CLI/TUI |
| `DEC-025` | `[HARD]` 数据迁移先冻结支持范围、再迁移、最后物理删除 | 模块 01 必须根据当前 reader、真实历史 fixture 和测试冻结 `legacy-support-matrix.json`；未登记或无正向 fixture 的旧格式不承诺自动迁移。最终升级包携带登记范围内的版本化迁移器和只读 reader；reader 不能与首个迁移发布同版删除 |

## 2. 术语、实体和唯一身份

### 2.1 普通任务实体

| 实体 | 含义 | 父实体 | 唯一写入者 | UI 是否显示 |
|---|---|---|---|---|
| `Workspace` | canonical 项目文件夹身份 | 安装实例 | Product service | 显示为“项目文件夹” |
| `ProductTask` | 用户可见任务容器 | Workspace | ProductTaskService | 显示为“任务” |
| `TaskRun` | 一次 Agent 执行；创建时已包含不可变 permission/provider snapshot 与 durable dispatch intent | ProductTask | ProductTaskService 在返回 accepted 前原子写入 | 显示为一次处理过程，不显示 ID |
| `ThreadEntry` | 用户消息、助手回答、审批、结果投影 | ProductTask | ProductTaskService | 显示在对话中 |
| `CoreSession` | worker 内部 Core 会话 | TaskRun | agent-worker/Core | 永不直接显示或作为产品外键 |
| `ClientOperation` | 一次用户副作用意图 | Task/Project | 对应产品 service | 不显示 ID；用于幂等与恢复 |
| `TaskEvent` | ProductTask 权威事件 | ProductTask/TaskRun | ProductTaskService | 只显示业务投影 |

固定区别：

- `revision`：实体内容版本，用于 compare-and-swap；
- `event_sequence`：事件流单调序号，用于重连去重；
- `resume_cursor`：客户端最后确认的事件位置；
- `client_operation_id`：用户意图幂等身份；
- `run_id`：一次执行身份；
- 它们不得互相代替。

### 2.2 媒体实体

| 实体 | 含义 | 唯一写入者 |
|---|---|---|
| `MediaLibrary` | MediaProject 的稳定 owner 容器；类型为 installation-default 或 canonical Workspace library | MediaProjectService |
| `MediaProject` | 图片或视频项目容器 | MediaProjectService |
| `MediaOperation` | 一次用户有副作用的意图，例如生成、编辑、放大、导出 | MediaProjectService |
| `MediaJob` | Operation 内部的可恢复执行阶段 | MediaProjectService（gateway/relay 只返回 adapter receipt，不直接写持久化状态） |
| `Asset` | 不可变文件身份，包含 hash、bytes、owned route 或受控外部路径 | MediaProjectService |
| `Version` | 项目的不可变编辑快照，引用 Asset 和画布/时间线 revision | MediaProjectService |
| `Candidate` | 生成阶段返回的 Asset 集合成员 | 不是独立存储系统，只是 Asset 在当前 Operation 中的角色 |
| `Evidence` | 与 source、时间范围、fingerprint、revision 绑定的结构化证据 | MediaProjectService |

`artifact` 只用于 UI 的“成果”投影；`output` 只用于外部响应字段，不能作为持久身份。

### 2.3 浏览器与招聘实体

| 实体 | 含义 | 唯一写入者 |
|---|---|---|
| `BrowserCapability` | observe/action/re-observe 的上层协议 | 协议，无持久状态 |
| `ChromeSessionBridge` | 本机单会话桥：Core/MCP Tool → request owner → Native Messaging host → BilliardBuddy Chrome Extension | 只保存短期 session/request 路由，不保存业务真相或 Cookie |
| `RecruitingPlan` | 门店、岗位、筛选条件和允许动作 | RecruitingService |
| `RecruitingBatch` | 一批候选人的可恢复处理单元 | RecruitingService |
| `BrowserCheckpoint` | 当前 batch 的页面版本、候选 ref 和回读状态 | RecruitingService 根据 bridge 回执写入 |
| `RecruitingOperation` | 发送、标记、状态变更等副作用意图 | RecruitingService |

Skill 只读业务数据并提供语义指导；Core 只拥有工具循环与审批；ProductTask 只投影目标、审批和结果摘要。

## 3. 全局状态机

### 3.1 用户消息与 TaskRun

```text
composer_draft
  → submit_intent_persisted
  → accepted(run_id, event_sequence)
  → dispatch_pending
  → running
  → waiting_for_user | stopping
  → completed | stopped | failed
```

`accepted` 的唯一含义是：ProductTaskService 已在同一个原子提交中持久化用户 ThreadEntry、TaskRun（含 immutable permission/provider snapshot）、`client_operation_id` receipt、首个 TaskEvent 和 durable dispatch record。任何一项写入失败都整体回滚，不返回 accepted，也不清空草稿。worker 不参与这个原子提交，且不得在提交成功前启动该 run。

提交成功后 dispatcher 可重复投递同一 `run_id`；agent-worker 必须用 run ID 和 dispatch generation 做幂等 claim。只有 claim 成功的 worker 可以创建/恢复 CoreSession 并把 `dispatch_pending → running` receipt 交回 ProductTaskService。服务在 accepted 后、投递前崩溃时，重启扫描 durable dispatch record；重复投递或 worker 重启不得创建第二 TaskRun、第二用户消息或自动重放外部副作用。

固定规则：

- 未收到 `accepted` 回执时只能显示“尚未发送”，草稿不能清空；
- `accepted` 后尚未被 worker claim 时显示“等待开始”，不得显示模型正在运行；
- 同一 `client_operation_id` 重放必须返回同一个受理结果；
- `stopping` 后等待 worker/Core 权威收尾；迟到 delta 不得进入已结束 run；
- 重连使用 `resume_cursor`，并以权威 transcript 对账缺失内容。

### 3.2 外部副作用与付费媒体

```text
draft
  → intent_persisted
  → submitted
  → running
  → succeeded

submitted | running
  → outcome_unknown
  → succeeded | confirmed_failed

intent_persisted
  → cancelled_before_submit
submitted | running
  → cancel_requested
  → cancelled | outcome_unknown
```

固定规则：

- `outcome_unknown` 只能查询原 Operation；
- 只有 `confirmed_failed` 或上游确认未执行，才允许用户明确创建新 Operation；
- 网络恢复不自动发送、生成、删除、招聘沟通或执行终端命令；
- relay 的 `failed_unknown` 在 media adapter 归一为产品 `outcome_unknown`，不进入 renderer。

### 3.3 数据迁移

```text
legacy_detected
  → backup_created
  → migration_running
  → migrated_and_verified
  → legacy_runtime_disabled

migration_running
  → failed_read_only
  → retry_same_migration
```

迁移失败时不得初始化空库、覆盖旧文件或继续有风险写入。首个迁移发布必须保留 migration reader；只有满足“第四部分：后续删除触发条件”，才允许在未来版本删除。

## 4. 全局安全与非功能边界

### 4.1 路径与归属

- 所有 task、附件、Diff、Preview、PTY 和媒体路径绑定 canonical workspace/owner；拒绝 `..`、符号链接逃逸、跨 worktree、任意 `file://`、Windows UNC/盘符越界和大小写混淆。
- 外部导入的视频、图片、音频和用户项目文件永不因删除 ProductTask/MediaProject 被删除；只删除应用明确拥有且能由身份链证明的副本。
- 正式桌面 sidecar 必须有每次启动生成的鉴权会话；不能仅依赖 loopback 或“ID 难猜”。

### 4.2 多窗口和单写者

- ProductTask 与媒体 mutation 都携带 owner、`client_operation_id` 和 `expected_revision`；冲突返回显式错误，不静默 last-write-wins。
- 同一媒体数据根最多一个 sidecar 写者，启动时取得跨进程锁；进程内 Promise 锁只能证明单实例串行，不能作为跨进程证据。
- 更新、退出和休眠前停止新后台写入，在有界时间内完成或留下 durable intent，重启后对账。

### 4.3 日志与隐私

普通日志不得记录：密钥、Authorization、Cookie、完整提示词/附件正文、截图/Base64、录音、候选人联系方式、完整 URL query、绝对用户路径或环境变量。开发诊断只记录脱敏 scope、operation ID hash、状态、耗时和短错误码。

### 4.4 可访问性与尺寸

- 键盘可完成主要流程；弹窗锁焦并支持 Escape；状态使用 `aria-live/status/alert`；图标按钮有可读名称。
- 1280×720 可用区域和 100%—200% 应用缩放下，主输入、停止、审批、错误恢复和保存按钮必须可达。
- 空间不足时先收起第 4 栏，再收起第 3 栏高级内容，不把控件挤出窗口。

### 4.5 外部事实

只有以下事实可标记为未验证，不得因此另建第二架构：

1. GPT Image 2 / Seedream 当前账号配额、429、Retry-After 和真实并发；
2. 美国服务器反代、下载和结果查询的实际 300 秒媒体 deadline；
3. DeepSeek 实际 model ID 与 context window；
4. Windows 签名、macOS 签名/公证和真实更新安装；
5. BOSS 当前页面结构、登录态和真实发送回读；
6. Chrome Web Store 正式 extension ID、审核发布、真实安装/升级和与 Native Messaging host 的版本握手。

未验证时使用模块规定的 fail-closed 结果，并在交接记录中明确写“未做”，不得把静态代码存在写成真实成功。

### 4.6 完成等级、黄金旅程与可观测性

每个能力必须分别报告，不得把较低等级写成较高等级：

| 等级 | 含义 |
|---|---|
| `IMPLEMENTED` | 代码与合同存在，但不代表运行通过 |
| `LOCALLY_VERIFIED` | 本地开发环境的类型、测试和真实纵向链通过 |
| `PACKAGED_VERIFIED` | 目标平台安装包中的同一能力通过 |
| `EXTERNALLY_VERIFIED` | 真实账号、供应商、BOSS、签名/公证或更新链通过 |

`NOT_VERIFIED_EXTERNALLY` 只能表示接线和受控 fixture 已验证，不能同时宣称真实外部能力已经完成。模块 25 必须运行端到端黄金旅程：首次启动与普通任务、断线/worker 崩溃恢复、图片项目、视频项目、招聘副作用、旧数据升级与更新。每条旅程必须覆盖 empty、loading/slow、offline、conflict、partial、failed、restoring 状态，并证明没有无限 spinner、重复副作用或无恢复入口的错误。

所有跨 renderer、IPC、sidecar、ProductTask、worker、Core、媒体和招聘的诊断都使用可关联的脱敏 task/run/operation ID 与短错误码；不得记录第 4.3 节禁止内容。发布验收记录冷启动到可交互、Composer 输入与首反馈、停止响应、任务切换、长会话/大 Diff、后台任务 CPU/内存等测量值；阈值必须在对应 Work Unit 开工前写入完成条件，不能验收后按结果放宽。

### 4.7 开发窗口并发规则

默认串行推进 accepted Work Unit。只有修改路径完全不重叠，且不共同修改 shared schema、IPC/API、数据库/文件迁移、事件协议、lockfile、构建配置或生成物时，主代理才可并行派只读调查；本轮产品代码实现始终每次只允许一个写入型实施子代理。共享合同、迁移、清理和发包必须串行。主代理必须保留开工前已有修改，不得让子代理覆盖、提交或清理不属于当前 Work Unit 的文件。

---

# 第二部分：模块依赖与交付阶段

## 5. 阶段与依赖图

```text
阶段 A：冻结基础合同
  01 单一基线
  01 → 02 ProductTask 身份、revision 与事件合同
  02 → 03 内部 agent-worker
  03 → 04 模型与上下文合同
  01 + 03 + 04 → 05 项目指令与记忆

阶段 B：恢复目标任务前端
  01 + 02 → 06 产品壳与目标视觉
  02 + 03 + 06 → 07 对话与 Composer
  02 + 03 + 07 → 08 三档权限
  02 + 07 + 08 → 09 队列、文本引用、分叉与恢复
  02 + 06 + 07 + 09 → 10 文件、Diff 与文件引用
  07 + 09 + 10 → 11 Preview DOM 修改

阶段 C：建立独立创作与业务工作台
  01 + 02 + 04 → 12 媒体领域基础
  04 + 06 + 12 → 13 图片工作台
  12 + 13 → 14 图片可靠性、容量与五分钟链路
  04 + 07 + 12 → 15 Fun-ASR
  04 + 06 + 12 + 14 + 15 → 16 视频五阶段工作台
  02 + 03 + 07 → 17 已安排与通知
  02 + 03 + 04 + 06 + 07 + 08 → 18 BrowserCapability 与 BOSS
  04 + 05 + 07 + 08 + 12 + 13 + 16 + 17 + 18 → 19 台球经营 Skills

阶段 D：产品收口
  02 + 03 + 06 + 10 → 20 用户本机终端
  04—20 → 21 设置、能力快照与技术表面收口
  01—21 → 22 版本化数据迁移与 legacy reader

阶段 E：删除、发包和统一验收
  01—22 → 23 死运行时与依赖物理清理
  01—23 → 24 双平台发包、签名与自动更新
  01—24 → 25 全链路验证与最终交接
```

模块 13 必须消费模块 04 已冻结的 `ImageGeneration`，并可消费 `TextReasoning`/`VisualEvidence`；模块 16 必须消费模块 04 的 `TextReasoning`/`VisualEvidence`/`SpeechTranscription`；模块 18 只通过 Core 文本能力和 `VisualEvidence` 获取模型结果。三者不得新增 provider registry、fallback 或临时模型路由。

模块 16 对模块 14 的依赖只消费跨媒体可靠性合同：deadline/timeout matrix、capacity preflight 字段、owner/provider 并发边界和 `outcome_unknown` 原 Operation 查询语义。模块 16 不消费模块 14 的图片 UI、三候选数量或图片 provider 路由，也不得把视频逻辑写回图片工作台。

模块 18 必须消费模块 08 的权限快照和审批合同，不得重新定义权限映射或绕过 ProductTask/Core approval。模块 19 只消费 ProductTask、MediaProject、图片/视频 Operation、ScheduledTask 和 Recruiting 的已冻结公开合同，不拥有这些领域的持久化状态。

## 5.1 每个模块的最小开工定位

本表只给“第一批必须读的当前文件”。实施 AI 先从这些用户入口/契约/服务开始，再用符号消费者图补齐测试、配置、构建和环境变量；不得把本表当作完整修改清单。历史提交只能读取模块明确点名的代码证据，不能作为另一份施工说明。

| 模块 | 当前实现第一入口 |
|---:|---|
| 01 | `ts/desktop/index.html`、`ts/desktop/src/main.tsx`、`ts/desktop/vite.config.ts`、Electron/package build 配置 |
| 02 | `ts/shared/product/domain.ts`、`taskEvents.ts`、`ts/src/server/product/taskService.ts`、ProductTask API/WS、`productTaskStore.ts` |
| 03 | `ts/src/server/services/conversationService.ts`、当前 cron/scheduled Agent consumer、`ts/src/entrypoints/cli.tsx`、CLI print/headless Core 调用 |
| 04 | `qfGatewayProvider.ts`、`providerService.ts`、`providerRuntimeEnv.ts`、`modelContextWindows.ts`、`gateway/app.ts`、worker launcher env |
| 05 | `ts/src/utils/claudemd.ts`、`context.ts`、`attachments.ts`、`commands/init.ts`、`productInstructions.ts`、`memdir/`、`SessionMemory/` |
| 06 | `AppShell.tsx`、`DesktopSidebar.tsx`、`ContentRouter.tsx`、`ProductShell.tsx`、`globals.css`、`uiStore.ts` |
| 07 | `ProductTaskPage.tsx`、`ProductTaskRunPanel.tsx`、`productTaskRuntimeStore.ts`、`taskEvents.ts`、`taskEventProjection.ts`、当前附件 API |
| 08 | `ts/shared/product/domain.ts`、ProductTask create/update API、`taskInboundPolicy.ts`、task service permission mapping、审批 UI |
| 09 | ProductTask queue/continue/fork API 与 stores、Core queue/checkpoint 现有实现、ThreadEntry projection |
| 10 | `ProductTaskReviewDock.tsx`、`ts/shared/product/taskReview.ts`、`taskReviewService.ts`、review API、canonical workspace helper |
| 11 | `ProductTaskBrowserPreviewDock.tsx`、`preview-agent/`、Electron `services/preview.ts`、`ipc/previewMessage.ts`、ProductTask inbound/projection |
| 12 | `ts/shared/contracts/media.ts`、`mediaProjectService.ts`、media API、`mediaWorkbenchStore.ts`、Electron sidecar auth/data-root lifecycle |
| 13 | `ImageWorkbench.tsx`、`MediaProjectRail.tsx`、media API/store/service、`4fab121e` image-workbench 只读参考 |
| 14 | `ts/desktop/src/api/media.ts`、server media timeout、`gateway/app.ts` 与 capacity preflight、`relay/app.ts` 与 production preflight |
| 15 | `VoiceInputControl.tsx`、product voice API、`voiceTranscription.ts`、`ts/shared/contracts/voice.ts`、provider adapter |
| 16 | `VideoStudio.tsx`、media contracts/service、FFmpeg/ffprobe staging、旧 `video-edit/{evidence,planning,render}` 纯函数参考 |
| 17 | `ProductScheduledTasksPage.tsx`、scheduled task API/service、cron scheduler、desktop notifications、worker adapter |
| 18 | `bossRecruiting.ts`、`claudeInChrome.ts`、`utils/claudeInChrome/`、ProductTask approval、待建 RecruitingService |
| 19 | `billiardsOperations.ts`、`billiardsKnowledge.ts`、bundled skill registry、相关 reference/payload |
| 20 | Electron `services/terminal.ts`、terminal IPC/channels、`ProductTaskTerminalDock.tsx`、terminal API/preferences |
| 21 | `Settings.tsx`、`settingsStore.ts`、settings types、provider/plugin services、feature flags、capability inputs |
| 22 | 现有 persistent storage migrations、各模块交接的 legacy adapters/fixtures、ProductTask/media lazy migrations |
| 23 | 模块 01 consumer graph、模块 22 migration manifest、package input graph、lockfiles 和第 23 模块删除 Manifest |
| 24 | Electron updater、desktop package config/scripts、macOS/Windows workflows、图标资源、release feed/manifest |
| 25 | 01—24 的交接 SHA、全仓测试/构建入口、package contents、外部未验证清单 |

---

# 第三部分：模块执行卡

## 阶段 A：冻结基础合同

## 模块 01：单一 GUI 基线与参考边界

**模块主题前缀：** `refactor: establish the single gui baseline`

### 用户结果

无直接 UI 变化。后续模块只有一个可修改产品基座，不会恢复第二前端或旧后端。

### 输入与入口

- 当前 `main`；
- `ts/desktop/index.html`、`ts/desktop/src/main.tsx`、Vite/Electron build；
- 只读参考 `4fab121e`、`30945a22`；
- 非构建用视觉与信息架构参考 `BilliardBuddy-frontend-restoration.html`；只辅助理解布局，不决定产品行为或逐像素验收。

### 实施合同

1. 生成 current renderer、sidecar、ProductTask、media、gateway、relay 的入口与消费者清单。
2. 固定历史参考读取命令和允许提取的文件类型；不 checkout 旧提交开发。
3. 标记 HTML 为非构建视觉/信息架构参考资产，确认不进入 Electron `files`、Vite entry、测试运行时或发布包；其脚本、假数据和内联 CSS 不得成为生产实现来源。
4. 冻结 `legacy-support-matrix.json`：逐项记录 storage ID、层次（disk/wire/localStorage/file shape）、物理位置、current version、已验证旧版本/旧形态、明确不支持范围、reader/migration entry、immutable fixture、测试、备份/隔离策略和已知 release 关联。不同层次的版本绝不能混称：当前 ProductTask **磁盘 store** 为 v4，而公共 wire/domain schema 为 v2，wire v2 不是 disk v2。初始最低事实范围固定为：ProductTask disk v1→v4、disk v3→v4、disk v4 current 已验证；disk v2 仅 provisional，补正向 fixture 前不承诺；ProductTask wire v2 只登记当前协议，不作为磁盘迁移输入；media disk v1 inline `reference_images`→private Asset 已验证；provider root v1/legacy index→provider index v2 已验证；managed settings 与 cron 只登记已测试字段级兼容；普通 settings、memory、recruiting、cron run log 和 desktop localStorage 历史版本不承诺自动迁移。后续模块不得用“受支持旧版”扩大此矩阵，新增支持必须先补 fixture、幂等迁移和本表证据。
5. 记录所有候选删除对象的当前消费者，交给模块 23 的物理删除 Manifest；本模块不做跨域物理删除。

### 明确不改

不重做 UI、不迁 store、不删除 CLI、Qwen、Computer Use、媒体聊天链或旧数据 reader。

### 验收 Oracle

| 输入 | 操作 | 预期 |
|---|---|---|
| 当前构建配置 | 枚举 HTML/Vite/Electron/sidecar entry | 只有 `ts/desktop/src/main.tsx` 是产品 renderer |
| 历史引用 | `git show <commit>:<path>` | 不产生工作树中的第二 renderer 目录 |
| HTML 原型 | 检查 build/package inputs | 不被正式构建引用 |
| 删除候选 | consumer graph | 每项有迁移模块、物理删除模块和保留 reader 说明 |
| 旧 schema 支持 | reader + immutable fixture + 正向/幂等测试 | 只有 `legacy-support-matrix.json` 登记项可称“受支持”；ProductTask v2 等 provisional 项不得进入迁移承诺 |

### 交接物

`single-product-baseline.json` 和 `legacy-support-matrix.json`（或等价机器可读 manifest）保存入口、参考路径、消费者图、删除候选与开工前冻结的旧 schema 支持范围；文字说明进入 accepted commit body，不新建 Markdown 报告。

---

## 模块 02：ProductTask 身份、revision 与事件合同

**依赖：** 01
**模块主题前缀：** `refactor: define authoritative product task contracts`

### 用户结果

多窗口、重连、重复点击和迟到响应不会再静默覆盖任务或创建重复执行。

### 当前事实与入口

- `ts/shared/product/domain.ts`、`taskEvents.ts`；
- `ts/src/server/product/taskService.ts`、projection、API、WebSocket；
- 当前已有原子 JSON、损坏隔离和进程内锁；当前缺少完整服务端 revision/event receipt 合同。

### 权威状态

ProductTaskService 唯一写 `ProductTask`、`TaskRun`、`ThreadEntry`、`TaskEvent`。Renderer store 只保存 view state 和最后确认的 cursor。

### 实施合同

1. 为 ProductTask 和可变子实体增加 schema version、`revision` 与更新时间；定义哪些 mutation 必须使用 `expected_revision`。
2. submit 使用单个 ProductTask 原子写入边界，同时持久化用户 ThreadEntry、TaskRun immutable snapshot、`client_operation_id` receipt、首个 TaskEvent 和 durable dispatch record；任何一项失败整体回滚且不返回 accepted。TaskRun 在 worker 启动前已经存在，worker 只 claim，不创建产品 run。
3. 所有副作用 mutation 接受 `client_operation_id`，并返回 `accepted | duplicate | conflict | rejected` durable receipt；accepted 只在第 3.1 节原子写入提交后返回。
4. TaskEvent 增加 `event_sequence`、`task_id`、必要的 `run_id`；WebSocket 支持 `resume_cursor`。
5. list/detail 的本地请求版本只用于避免迟到 UI 覆盖，不得冒充服务端 revision。
6. 定义少量产品错误码：revision conflict、owner mismatch、not found、storage unavailable、unsupported schema、operation unknown。
7. 协议、通知和第二实例只转交受控 task ID/action，不接受任意路径、URL 或命令。
8. 旧 ProductTask schema 的读取适配器和 fixture 由本模块随新 schema 一起定义并测试为 `D3_LEGACY_READ_ONLY`；只允许覆盖模块 01 `legacy-support-matrix.json` 已登记范围。ProductTask v2 必须先补成功迁移、写回 current、二次运行幂等 fixture 才能从 provisional 升为 supported；模块 22 只调用 adapter 做统一编排，不得重新推导字段映射。

### 明确不改

不修改 CoreSession 语义，不实现 Composer、权限、队列或 UI 重设计。

### 验收 Oracle

| 场景 | 预期持久结果 | 预期客户端结果 |
|---|---|---|
| submit 任一原子成员写入失败 | ThreadEntry/TaskRun/receipt/event/dispatch 全部不出现 | 不返回 accepted，草稿和附件保留 |
| accepted 后服务在 worker claim 前崩溃 | 同一 durable dispatch 重启后继续投递 | 仍显示同一 run“等待开始”，不创建第二消息/run |
| 同一 dispatch 重复投递给两个 worker | 只有一个幂等 claim 成功 | 一个 run、一个 CoreSession；另一个 worker 得到 duplicate/no-op |
| 同一 operation 重放两次 | 只写一次 mutation | 第二次返回同一 receipt |
| 两窗口以同一旧 revision 改标题 | 只允许一个 revision 前进 | 另一窗口收到 conflict 并重新读取 |
| WebSocket 断线后携 cursor 重连 | 不复制事件 | sequence 单调且无重复 |
| JSON 损坏/无权限/磁盘失败 | 原文件不被覆盖 | 显示可恢复错误，不返回空库成功 |
| 未知协议 task ID | 不创建任务 | 安全落到任务页并解释 |

### 交接物

ProductTask schema、operation receipt、错误码和 event/cursor contract。

---

## 模块 03：GUI 内部 agent-worker 与公共 CLI 解耦

**依赖：** 02
**模块主题前缀：** `refactor: introduce the internal agent worker`

### 用户结果

GUI 对话与自动事项继续使用完整 Core，但不再依赖公开 CLI/TUI 产品入口。

### 当前事实与入口

`ConversationService` 当前通过 `entrypoints/cli.tsx --print --input-format stream-json --output-format stream-json` 启动无界面 CLI；正式 `agent-worker` 尚不存在。

### 权威状态

- ProductTaskService 拥有产品 run；
- agent-worker 拥有 CoreSession 和运行进程状态；
- worker 只能通过 framed protocol 返回事件/receipt，不能写 ProductTask 数据文件。

### 实施合同

1. 从现有 headless CLI 路径抽出最小内部 worker entry，继续调用原生 Core。
2. 定义 worker protocol：hello/version、ready、start、claim receipt、input、approval response、stop、event、terminal result、fatal、shutdown。
3. `start` 只能引用已经由 ProductTaskService 原子持久化的 task ID/run ID/dispatch generation，不得创建 ProductTask 或 TaskRun。worker 先幂等 claim；claim 成功后才创建/恢复 CoreSession，并绑定 permission snapshot、provider contract version 和 cancellation signal。
4. 实现背压、最大帧大小、未知消息拒绝、ready timeout、有界重启和优雅退出。
5. ConversationService 与所有当前 GUI、定时任务消费者必须在本模块切换到 worker protocol adapter；公共 CLI 路径只作为待删除源码保留到模块 23。
6. worker 崩溃不得自动重复用户消息；ProductTask 根据 durable run 状态显示失败或恢复查询。
7. 输出交给模块 04 的 worker 环境 manifest；模型环境不得由不同 launcher 各自拼接。

### 明确不改

不重写 Core Agent loop、工具、权限、Skills、Hooks、MCP、子代理、resume 或 compact。

### 验收 Oracle

- 固定假 Core fixture：ready → delta → tool activity → complete，ProductTask 只得到一条 run。
- stop：收到 stop 后进入 stopping，最终只有 stopped/complete 一个终态，迟到 delta 被拒绝。
- crash before accepted：整个 submit 原子写入不存在，消息保持未受理；crash after accepted/before claim：重启投递同一 durable dispatch；重复 start 只有一个 claim，均不创建第二 run。
- 大帧、坏 JSON、协议版本不匹配和无 ready 均形成明确 run error，不无限重启。
- GUI/cron consumer graph 已指向 worker adapter；公共 CLI 尚未删除并在 Manifest 标记模块 23。

### 交接物

worker protocol version、launcher 环境字段、run/CoreSession 映射和故障 fixture。

---

## 模块 04：模型、视觉、语音与上下文合同

**依赖：** 03
**模块主题前缀：** `refactor: finalize provider and context contracts`

### 用户结果

普通用户不再选择模型；产品使用明确的文本、视觉理解、图片生成/编辑和语音能力，能力不足时说真话，不隐藏切换其他模型。

### 权威状态

Provider registry 是 model ID、能力、`verified_context_window`、body budget 和 compact threshold 的唯一权威源。`model-contract.json` 与 worker capability manifest 都是由 registry 生成的只读构建/启动产物；worker 校验二者的 contract version/hash 与 registry 一致，不一致时拒绝 ready。UI 只读取模块 21 的业务化 capability snapshot，不直接推断 registry 或 manifest。

### 实施合同

1. 固定四个 provider-neutral 接口：`TextReasoning`、`VisualEvidence`、`ImageGeneration`、`SpeechTranscription`。模块 13 只通过 `ImageGeneration` 执行图片生成/编辑，并可消费 `TextReasoning`/`VisualEvidence` 整理 Brief 和检查结果；模块 15 只消费 `SpeechTranscription`；模块 16 消费 `TextReasoning`/`VisualEvidence`/`SpeechTranscription`；模块 18 只消费 `VisualEvidence`，文本规划仍走 Core 的 `TextReasoning`。
2. `ImageGeneration` 的请求合同固定包含 operation kind、provider-neutral Brief、reference asset IDs、base asset/version、normalized mask、requested count、size/format、owner、`client_operation_id` 和 `expected_revision`；返回只包含 adapter receipt、upstream durable ID、标准状态、候选输出下载/字节描述、usage/错误分类，不生成产品 Asset ID，也不暴露 provider 原始枚举或密钥。MediaProjectService 校验 receipt 后才落盘不可变 Asset/Version。Provider registry 根据 `DEC-018` 在服务端把请求路由到 GPT Image 2 或 Seedream 4.5；renderer、Skill、Core Tool 和 MediaProjectService 均不得直接依赖供应商 SDK/schema。
3. DeepSeek 是唯一文本主模型；MiMo 只接受受控图片输入并返回结构化视觉证据；GPT Image 2 / Seedream 4.5 只实现 `ImageGeneration` adapter；Fun-ASR 只接受音频并返回 transcript。
4. 对 Qwen 运行时执行 `D1_STOP_WRITES` 与 `D2_MIGRATE_CONSUMERS`：移除正式路由、fallback 和模型选择；保留独立 `D3_LEGACY_READ_ONLY` model value mapper 给模块 22，不保留可执行 Qwen provider。
5. 禁止 MiMo 隐式接管整个文本回合。带图输入先走 VisualEvidence，再把结构化证据交回 DeepSeek。
6. 拆分 `CHAT_TEXT_BODY_MAX_BYTES`、`VISION_BODY_MAX_BYTES` 与 `IMAGE_GENERATION_BODY_MAX_BYTES`；文本预算按已核实 token window、JSON/工具历史膨胀和安全余量计算，视觉理解按受控图片数量/总字节限制，图片生成按参考资产、mask 和请求元数据限制。
7. 由 Provider registry 唯一生成非密钥 `model-contract.json` 和 worker capability manifest：实际 model ID、provider、能力、worker env source、window、body cap、compact、resume 证据、contract version/hash 和核验日期；二者不允许手工配置独立值。
8. 只有官方/账号/实际响应证据与 desktop→worker→provider→gateway→Core 全链均支持 1M，registry 才生成 1,000,000；否则生成真实最小值。
9. 未知或被环境变量改写为未注册 model ID 时 worker 固定拒绝 ready，ProductTask 显示“模型配置无效”；不回退打包默认、不切 Qwen/Sonnet/Anthropic。已注册 provider 运行时不可用则显式失败；视觉不可用时要求用户查看/接管；图片生成能力不可用时不创建付费 Operation；语音不可用时保留录音草稿或显示转写失败。

### 验收 Oracle

| 请求 | 预期路由 | 失败断言 |
|---|---|---|
| 纯文本 | DeepSeek | 不能命中视觉 cap 或 Qwen fallback |
| 图片附件 | MiMo 证据 → DeepSeek 文本 | MiMo 不拥有文件写、发送或桌面动作权 |
| 图片生成/编辑 | provider-neutral `ImageGeneration` → 服务端路由 GPT Image 2 / Seedream 4.5 | renderer/Skill/MediaProjectService 不直连供应商，不把 MiMo 当生图模型 |
| 音频 | Fun-ASR | 不恢复 Whisper/第二 ASR |
| 未知 model env override | worker 拒绝 ready，ProductTask 显示配置无效 | 不接受任意模型 ID，不回退打包默认 |
| 长无图请求 | text body cap | 不被 vision cap 提前拒绝 |
| 上下文证据不足 | 真实最小 window | UI/配置不得显示 1M |

### 交接物

provider-neutral TextReasoning/VisualEvidence/ImageGeneration/SpeechTranscription interfaces、model manifest、body budget 和 legacy Qwen value mapping。

---

## 模块 05：BilliardBuddy 项目指令、记忆与 `/init`

**依赖：** 01、03、04
**模块主题前缀：** `feat: unify billiardbuddy project instructions and memory`

### 用户结果

用户可以维护“项目约定、长期记忆、本次任务摘要”，三者来源和删除范围清楚；`/init` 默认创建 BilliardBuddy 品牌文件，不破坏已有 Claude 指令。

### 当前事实与入口

- 原生 resolver：`claudemd.ts`、`context.ts`、`attachments.ts`；
- 当前品牌文件仍由 `productInstructions.ts` 临时拼接并升为 append system prompt；
- `/init` 当前以 `CLAUDE.md` 和子代理向导为目标；
- AutoMem、Session Memory、AutoDream 已有实现，TeamMem 是待删除产品表面。

### 权威状态

- 项目指令：真实文件与 `MemoryFileInfo[]`；
- Session Memory：当前会话摘要；
- AutoMem：项目/用户长期学习；
- TeamMem：最终无运行时状态。

### 实施合同

1. 在原生 resolver 集中定义单层目录候选：Claude 兼容源 → `AGENTS.md` → `BilliardBuddy.md`。
2. 启动、额外目录和 nested directory 使用同一 helper；复用 `processMemoryFile`、canonical path、去重、include、Hooks 和 load reason。
3. 用户全局品牌文件只来自 BilliardBuddy 隔离产品数据根，不扫描其他 Agent 的 home 配置。
4. `isMemoryFilePath`、`getAllMemoryFilePaths`、compact/诊断/设置消费者同时识别品牌文件；不新增 MemoryType 或附件协议。
5. 对外层品牌注入链执行 `D2_MIGRATE_CONSUMERS`：品牌加载迁到原生 resolver 后停止 `productInstructions.ts → 临时 Markdown → --append-system-prompt-file` 的正式消费；本模块保留待删源码并在交接中证明消费者归零，统一由模块 23 执行 `D4_PHYSICAL_DELETE`；不建立替代临时文件。
6. `/init` 默认在 canonical 项目根创建职责不重复的 `AGENTS.md` 与 `BilliardBuddy.md`；已有文件只给最小 patch；不改写 `CLAUDE.md`。
7. “记住”必须选择唯一目标：项目约定、长期记忆或本次任务摘要。未指定时只生成 AutoMem 建议预览，用户确认后写入。
8. AutoMem 使用 scope+关键词+更新时间的本地索引，不调用隐藏 Sonnet/Anthropic 侧模型；索引损坏不阻塞主任务。
9. 敏感信息、网页 Cookie、候选人隐私、图片/音频 Base64 和绝对路径不进入长期记忆。
10. 仅为模块 01 支持矩阵已登记的项目指令/记忆旧形态提供 `D3_LEGACY_READ_ONLY` adapter 与 immutable fixture；当前 memory 无版本和历史 fixture，默认 unsupported、原文件原位保留，不创建假迁移承诺。TeamMem 的设置、OAuth、watcher、endpoint 和发布消费者交给模块 23 的物理删除 Manifest；本模块先执行 `D1_STOP_WRITES`，模块 21 迁出普通设置消费者。

### 验收 Oracle

- 同层三种文件严格按固定顺序加载；深层目录首次访问只注入一次。
- 用户全局只读隔离 data root；worktree/软链接/无 Git workspace 不越界、不重复。
- resume/compact 保留来源与去重；Session Memory 不复制品牌正文或 AutoMem 正文。
- `/init` 二次执行不覆盖现有文件，`CLAUDE.md` 内容和时间戳不变。
- 删除一条 AutoMem 后，正文、索引、缓存和后续召回都消失；已发送当前请求不谎称撤回。
- `rg` 证明品牌临时 system-prompt 注入无消费者。

### 交接物

指令候选顺序、resolver fixture、memory scope/delete contract、TeamMem 删除候选清单。

---

## 阶段 B：恢复目标任务前端

## 模块 06：产品壳、导航、主题与目标视觉

**依赖：** 01、02
**模块主题前缀：** `feat: implement the confirmed billiardbuddy shell`

### 用户结果

启动后看到符合本模块明文信息架构合同的普通用户产品壳：任务、创作、经营、已安排、设置；不先面对 workDir、模型、插件或运行时参数。HTML 只辅助理解整体方向。

### 视觉参考边界

`BilliardBuddy-frontend-restoration.html` 只用于帮助理解已确认的视觉方向和信息架构：

- 可以参考 240px 左侧栏、46px 顶栏、灰白 surface、细边框、浅蓝强调、系统字体；
- 可以参考首屏自然语言 Composer、图片/视频独立工作台，以及任务页按需展开的第 3/4 栏和底部终端；
- 不得把 HTML 的假数据、脚本、内联 CSS、DOM 结构或交互状态复制为生产实现；
- 不得把 HTML 当作 Oracle、母版、逐像素标准或第二施工依据；产品状态、权限、失败语义、调用链和验收条件只由本 Markdown 与机器证据决定。

### 实施合同

1. 只改当前 AppShell、DesktopSidebar、ContentRouter、ProductShell 和当前主题；不复制旧 AppShell。
2. 主导航固定为五项；图片/视频卡直接打开工作台，经营卡进入经营页或把自然语言需求回填主 Composer。
3. 普通首屏隐藏 project ID、Core ID、Provider、模型、MCP/Plugin、worktree 和复制 Markdown；需要文件时再选择项目文件夹。
4. 统一产品名、窗口、通知、协议和助手自称为 BilliardBuddy；保留许可证和内部兼容符号。
5. 任务列表保留搜索、置顶、重命名、归档、恢复和运行状态；永久删除只从归档区进入，且不删除用户项目文件。
6. 当前已有高级能力以渐进展示保留，不因简化 UI 删除 Core 能力。
7. 完成键盘、读屏、长中文/英文、1280×720、200% 缩放和深浅主题检查。

### 明确不改

不改 ProductTask schema、消息协议、媒体后端、Core 或终端进程。

### 验收 Oracle

- 1440×900 与 1280×720 按本模块的导航、栏位、层级、可达性和主题合同验收；HTML 只能作辅助参考，不做逐像素或 DOM 对照 Oracle。
- 新用户不选模型/API Key/目录即可进入首页；点击具体任务后才申请所需能力。
- 缩放到 200% 时输入、停止、审批和错误恢复按钮可达；空间不足按第 4 栏→第 3 栏顺序收起。
- 正式 bundle 不引用 HTML 原型，且不存在第二 renderer/旧壳开关。
- 普通导航和设置中不出现 Claude/CC-Haha/Provider/模型技术品牌。

### 交接物

导航 route contract、主题 token、响应式栏位规则和视觉验收截图。

---

## 模块 07：对话、流式回答与 Composer

**依赖：** 02、03、06
**模块主题前缀：** `feat: restore the task conversation experience`

### 用户结果

用户能自然发送文字、图片和文件，看到真实流式回答与简明执行摘要；停止、断线和切任务不会重复消息或串流。

### 权威状态与调用链

```text
Composer
  → ProductTask submit(client_operation_id)
  → accepted receipt / run_id
  → agent-worker/Core events
  → ProductTask projection + durable transcript
  → renderer by event_sequence/resume_cursor
```

### 实施合同

1. 吸收旧 Composer 的圆角、自动增高、附件、语音、斜杠发现、`@` 文件/Skill 发现、长文本转附件、发送/停止和阅读位置；必须适配当前 ProductTask props。斜杠与 `@` 候选来自当前 Core/Skill/workspace consumer，不恢复旧命令 registry 或暴露 provider/model。
2. 用户消息只有收到 accepted receipt 后才固定为已发送并清空草稿；未受理保留草稿和附件。
3. ProductTask projection 将事件分成思考摘要、执行动作、回答、结果、等待用户；不展示原始 thinking、提示词、工具 JSON、密钥或完整命令流水。
4. assistant delta 按 run ID + sequence 去重；turn complete/stopped 后拒绝迟到 delta。
5. 断线先以 cursor 恢复事件，再用权威 transcript 对账；缺失内容显示“正在恢复内容”，不假装连续。
6. 用户向上阅读时不抢滚动；切任务保留各自草稿、阅读位置和运行卡折叠状态。
7. 外部附件进入受控任务附件或安全引用；PDF/DOC 等先提取可读内容，二进制不序列化为普通消息文本。
8. 同一次拖拽/粘贴同时包含 file/HTML/bitmap 时去重；附件发送、失败、取消和清理绑定 task/operation identity。

### 验收 Oracle

- 同一 operation 双击或重连重放：一条用户消息、一个 run、同一 receipt。
- 未收到 accepted：显示尚未发送，草稿和附件不丢。
- delta 乱序/重复/停止后迟到：transcript 只出现一次且终态稳定。
- `/` 分组/fuzzy/键盘导航、`@` 文件与 Skill、超过产品阈值的长文本转附件、中文输入法组合态、Enter/Shift+Enter 和语音插入均有交互 fixture；候选不显示 provider/model，不依赖旧命令 registry。
- 图片、外部文件、项目内文件、长文本和部分附件失败均有 fixture；有效内容不因一个附件失败而丢失。
- 运行摘要来自真实事件；没有事件时不生成随机“正在思考”文案。
- 原始 thinking/tool JSON/密钥在 UI、普通日志和 transcript 中均不可见。

### 交接物

message operation、delta sequence、stop/reconnect、attachment identity 和 UI projection fixture。

---

## 模块 08：三档权限、审批与结构化追问

**依赖：** 02、03、07
**模块主题前缀：** `feat: align product permission flows`

### 用户结果

Composer 中只有“每次询问、自动修改、只做计划”三档；切换后从下一次执行可靠生效，当前执行不会被暗中改权限。

### 权威状态

- ProductTask 保存下一次 run 的产品权限偏好与 revision；
- TaskRun 保存创建时不可变的 Core permission snapshot；
- Core 拥有实际工具审批状态；renderer 不乐观伪造。

### 实施合同

1. 新建任务和下一次 run 只接受三种产品值并映射固定 Core 值。
2. 活动 run 的权限快照不可变。用户要求立即改变时，产品先停止/收尾当前 run，再用新 revision 创建下一 run。
3. 新增 product-safe permission mutation route，使用 task ID、expected revision、client operation ID；当前 inbound policy 对任意 `set_permission_mode` 的拒绝保持，不能绕过白名单。
4. mutation 经 ProductTask 持久化并在下一 run accepted receipt 中回显；失败恢复上一权威值。
5. 审批、计划反馈和 AskUserQuestion 使用业务化卡片；Core 内部 `dontAsk/auto/bypassPermissions` 不进入普通 UI或持久产品值。

### 验收 Oracle

- 当前 run 处于 `ask` 时切到 plan_only：当前 run 不被改写；停止后下一 run 为 plan snapshot。
- 两窗口并发切换：一个 revision 成功，一个 conflict。
- worker 重启：ProductTask 偏好和下一 run snapshot 一致。
- 未知产品/Core 枚举：服务端拒绝，UI 恢复旧值。
- 普通界面搜索不到第四档完全绕过权限入口。

### 交接物

权限 mutation API、run snapshot 规则、审批事件和冲突 fixture。

---

## 模块 09：排队消息、引用、分叉与恢复

**依赖：** 02、07、08
**模块主题前缀：** `feat: add durable conversation controls`

### 用户结果

Agent 忙时可追加、编辑和删除后续指令；可引用历史文本、从某处继续或恢复，不会串任务或留下孤儿副本。

### 权威状态

ProductTaskService 唯一写 `QueuedMessage`、`TaskReference`、`Checkpoint`、`ForkSource`。Core/CLI 内部 queue/checkpoint 不能作为产品真相源。

### 实施合同

1. 定义 QueuedMessage：task ID、message ID、client operation ID、order、content revision、status、expected turn revision。
2. enqueue/edit/delete/dispatch 全部返回 durable receipt；当前轮完成与删除竞争时只有一个 revision 生效。
3. 定义文本引用：source entry ID、字符范围、原文 hash、显示文本和用户意见；历史压缩后仍能读取持久引用或明确失效。
4. 本模块只实现文本消息引用；文件/代码引用由模块 10 定义并接入。模块 09 不引用、导入或等待模块 10 的 schema。
5. fork/checkpoint 使用当前 ProductTask 和明确 worktree identity；创建失败回滚 task record 与应用拥有的 worktree，不删除源项目。
6. 普通 UI 使用“排队、加入对话、在独立副本中继续、回到这里”，不显示 CoreSession/checkpoint/rewind 技术术语。
7. 只为模块 01 支持矩阵登记的旧 ProductTask/Core queue、文本引用、checkpoint 和 fork shape 提供 `D3_LEGACY_READ_ONLY` adapter/fixture；未登记记录保持只读隔离，不能由模块 09自行扩大支持或静默丢弃。

### 验收 Oracle

- busy run 下添加 A/B、编辑 A、删除 B，重启后只按最终顺序发送 A。
- dispatch 与 delete 并发只产生一个结果，不能已删仍发送。
- 引用在原消息更新/不存在/hash 不符时明确失效，不静默引用错误文本。
- fork 中途失败不留下半个 ProductTask、孤儿 worktree 或跨任务 queue。
- 所有产品记录只绑定 public task ID，不持久化 Core 私有 session ID。

### 交接物

queue/reference/checkpoint/fork schema、operation API 和恢复 fixture。

---

## 模块 10：文件、Diff、选区与行评论

**依赖：** 02、06、07、09
**模块主题前缀：** `feat: connect structured review feedback`

### 用户结果

任务需要时展开第 3 栏审阅区和第 4 栏文件树；用户选中文件、代码或 Diff 并写意见后，模型收到完全一致的结构化上下文。

### 权威状态

TaskReviewService 只读取并校验 canonical workspace 文件；review mutation 和对应 TaskEvent 统一由 ProductTaskService 写入。Renderer 只保存 tab、选区和栏宽 view state。

### 实施合同

1. 按 `30945a22` 的信息架构融合第 3/4 栏，不直接恢复历史 store；第 4 栏选择驱动第 3 栏打开对应 file/diff/image。
2. 定义 `ProductTaskReference`：kind、task ID、canonical relative path、file revision/hash、line/char range、selected text、comment。
3. 发送前由服务端重新 realpath、owner、hash、范围和长度校验，防止 TOCTOU 与符号链接逃逸。
4. 支持 UTF-8/BOM、CRLF/LF、Unicode 文件名和 Windows 路径边界；不可解码按二进制显示，不写回源文件。
5. 大文件、长行、大 Diff 和大目录采用有界分页/截断/虚拟化，并明确“只显示部分”。
6. Agent 完成后由真实文件和 revision 重新生成 Diff；临时 UI 文本不是完成证据。
7. 当前只读 ReviewDock 被融合后移入模块 23 删除 Manifest；本模块先迁完消费者。

### 验收 Oracle

- 第 4 栏点击 changed file → 第 3 栏打开同一 task/revision 的 Diff；普通文件 → file preview。
- 文件在选中后变化：发送返回 stale reference，要求刷新，不套旧行号。
- `..`、canonical realpath 越界、符号链接逃逸、跨 worktree、未授权 UNC/盘符和删除中路径一律拒绝；无法解码/过大文件则不读取正文，明确降级为元数据或“不可预览”。
- 模型 fixture 收到的 path/range/text/comment 与可见卡片逐字段一致。
- 深浅主题新增/删除对比清晰，键盘可选择与提交评论。

### 交接物

ProductTaskReference schema、review API、canonical path helper 和第 3/4 栏联动 fixture。

---

## 模块 11：Preview DOM 元素选择与源码修改

**依赖：** 07、09、10
**模块主题前缀：** `feat: connect preview dom edits`

### 用户结果

用户在 Preview 点选网页元素、填写修改意见并确认后，Agent 修改真实源码；Diff 和重新加载后的 Preview 能验证结果。

### 权威状态与调用链

```text
Electron short-lived selection capability
  → ProductTask preview_inbound_event
  → TaskRun/Core file mutation
  → ProductTask result receipt
  → Diff + refreshed Preview
```

### 实施合同

1. 模块只处理 `target_kind=product_file` 的 DOM/源码修改；不得调用 MediaProject 写入。
2. 定义 `preview_selection`：task/workspace owner、page URL/version、selector/nthPath/tag、CSS pixel/normalized rect、device scale、style/HTML summary、source hint、user change、screenshot identity、expiry。
3. picker 使用一次性授权；导航、刷新、iframe 变化、任务切换或过期立即失效。
4. Electron 校验顶层来源、协议、消息大小和 capturePage；发送截图前清除 hover/气泡产品遮罩。
5. ProductTask 后端将页面内容视为不可信数据，限制和转义字段；网页文字不能覆盖用户授权或系统指令。
6. 跨域 iframe 无安全定位时只允许整页截图意见并标记 `unsubmitted`，不得猜 selector/坐标。
7. “确认修改并发送”即用户提交；Agent 忙时进入模块 09 队列，不要求回 Composer 二次发送。

### 验收 Oracle

- 结构化 metadata、change、截图三者同时到达 fake Core，缺任一项固定为 unsubmitted。
- 高 DPI、滚动、缩放和 transform 后标注与截图矩形一致。
- 导航后旧 capability 重放被拒绝；页面脚本不能伪造授权。
- 临时 DOM 变化不产生 success；只有真实文件 revision + Diff + refreshed Preview 回执显示完成。
- 搜索代码不存在 `Core/media` 并列路由或模块 11 调用 media mutation。

### 交接物

preview event schema、capability expiry、fake page fixture 和 source modification receipt。

---

## 阶段 C：创作与经营工作台

## 模块 12：MediaProject、Owner、Operation、Asset 与 Version 基础

**依赖：** 01、02、04
**模块主题前缀：** `refactor: establish authoritative media contracts`

### 用户结果

图片和视频项目可安全恢复、跨窗口不会互相覆盖，资产有稳定身份，未知结果不会被误重试。

### 权威状态

MediaProjectService 是唯一写入者；renderer 只保存 view state。正式产品保证同一数据根一个 sidecar 写者，并使用跨进程锁。

### 实施合同

1. 在现有文件型存储中扩展，不迁 SQLite、不建第二 media service。
2. 服务端唯一派生 `owner_scope=installation_id + media_library_id`。用户选择 canonical Workspace 时使用 `workspace:<canonical workspace_id>`；从“创作”直接进入且尚未选择项目文件夹时使用该安装实例唯一的 `installation-default` 媒体库。所有 list/get/write/delete/cancel/asset/download 路由统一验证 owner scope + sidecar auth。媒体项目可以稍后显式迁入 Workspace library，但迁移必须复制/重绑定 owner 下的项目引用并保留 operation/asset identity，不得因当前 UI 目录变化自动改 owner。
3. schema 定义 MediaLibrary、MediaProject、MediaOperation、MediaJob、Asset、Version、Evidence；每项明确 ID、parent、revision、created/updated、owner。
4. 所有写 mutation 使用 `client_operation_id + expected_revision`；外部副作用前先固化 Operation intent。
5. Asset 不可变：记录 kind、owned route 或受控外部 path、hash、bytes、source revision；外部视频不复制且永不删除。
6. Version 是不可变完整快照；图片画布、视频时间线都引用明确 input/output revision。
7. 使用跨进程数据根锁、临时文件、可用时 fsync、rename 和上一有效快照；启动时对账正文/索引/Job/Asset。
8. 只为模块 01 `legacy-support-matrix.json` 已登记的 media schema/shape 提供 `D3_LEGACY_READ_ONLY` adapter 与 crash fixture；当前最低承诺仅包含 media v1 inline `reference_images` → private Asset。新增旧版支持必须先补 immutable fixture、正向迁移、current 写回和幂等测试；adapter 只读取和标准化，不执行旧 provider、旧 workflow 或外部副作用。
9. 实现第 3.2 节状态机和 adapter 归一；renderer 不消费 relay 原始枚举。
10. 删除项目先停止/拒绝活动 Job，列出只会删除的应用拥有资产；失败时项目不能从列表消失。

### 验收 Oracle

- 两个进程竞争同一数据根：只有一个获得 writer lock；第二个 sidecar 固定拒绝启动该数据根并返回“已有实例正在使用”，不得进入另一个读写或只读 service 模式。
- 两窗口同 revision 写项目：一个成功，一个 conflict。
- 崩溃在 intent、上游调用、结果下载、asset rename 各窗口重启后可对账，不重复副作用。
- 猜 project ID、跨 MediaLibrary/Workspace、无 sidecar auth、外部路径删除全部被拒绝。
- 未选择项目文件夹时可在 `installation-default` 创建、重启恢复和导出媒体项目；选择另一个 Workspace 不会隐藏、串用或自动改写其 owner。显式迁入 Workspace 后旧 owner 不再可写，但 Operation/Asset identity 与引用保持。
- 项目删除只移除应用拥有资产，不删除导入源文件或其他项目引用。

### 交接物

media library/schema、owner/auth contract、operation state machine、writer lock 和 crash fixtures。

---

## 模块 13：图片创作工作台

**依赖：** 06、12、04
**模块主题前缀：** `feat: integrate the image workbench`

### 用户结果

从“创作”直接做海报或照片：描述目标、上传参考、获得三候选、选中修改、局部重绘、编辑文字、回滚版本并导出，不经过主聊天。

### 权威状态

MediaProjectService 持久化 Brief、reference roles、Operation、Job、Asset、Version 和 canvas snapshot；ImageWorkbench store 只保存选择和面板 view state。

### 实施合同

1. 视觉层级和工作台分区可以参考 HTML 与 `4fab121e`，但需求、候选、画布、版本和失败语义只由本模块及模块 12/04 合同决定；不复制 HTML 假数据、脚本或旧 store。
2. 工作台提供“海报/宣传图”和“照片优化/修改”两条入口，共享同一数据模型。
3. DeepSeek 只把文字整理为 provider-neutral Brief：用户原话、确定事实、必须保留、允许改变、待确认；不得补猜价格、日期、人数、品牌承诺。
4. MiMo 只分析明确提交的参考图/候选图并返回结构化证据；不可用显示“尚未自动检查”。
5. 所有 generate/edit/inpaint/upscale 只能由 MediaProjectService 根据 durable MediaOperation 调用模块 04 的 provider-neutral `ImageGeneration`；服务端 registry 按 `DEC-018` 路由。renderer/shared schema 不能提交 model/provider，MediaProjectService 不导入供应商 SDK/schema，gateway/relay 只返回 adapter receipt。
6. 普通请求固定三候选；每个输出是独立 immutable Asset，可 partial success；失败不静默补发。
7. 定义 Operation kind：`image.generate`、`image.edit`、`image.inpaint`、`image.upscale`、`image.export`。
8. 精确中文、Logo、二维码优先用确定性画布图层；整图/局部编辑绑定 base asset/version 和 normalized mask。
9. 撤销/重做、自动保存和回滚基于 immutable Version 与 expected revision，不覆盖原生成 Asset。
10. 费用/高耗时动作提交前显示类型、数量和范围；下载只从已持久 Asset/Version 导出。
11. 对图片聊天中转执行 `D1_STOP_WRITES`：停止创建 `kind=image` 的 media draft；同时提供图片 draft/project/unknown Job 的 `D3_LEGACY_READ_ONLY` adapter 与 fixture给模块 22。共享视频兼容代码保持只读可执行到模块 16 完成切流，物理删除统一由模块 23。

### 验收 Oracle

- 固定 Brief fixture 不凭空增加未输入价格/日期；用户修改后 revision 正确。
- 三候选一次受控 Operation，返回 3 个 Asset 或显式 partial；不得拆成无提示多次付费。
- model/provider 字段无法由 renderer 请求覆盖；MediaProjectService 只命中 `ImageGeneration`，目标上游失败不跨供应商。静态依赖图中 renderer/Skill/MediaProjectService 不导入 GPT/Seedream SDK 或供应商 request schema。
- mask 与底图版本不一致时拒绝；inpaint/upscale/export 各有独立 operation identity。
- 崩溃、取消、unknown、切项目和两窗口自动保存不丢 Version、不重复扣费。
- 新图片项目不产生 ProductTask media draft 或聊天关联卡。

### 交接物

image Brief、Operation kinds、canvas/version、routing 和三候选 fixture。

---

## 模块 14：图片可靠性、容量与五分钟链路

**依赖：** 12、13
**模块主题前缀：** `fix: harden image operations and capacity`

### 用户结果

生图慢时可以可靠等待、恢复和对账；用户看到“已受理、排队、生成中、结果待确认、失败”，不会因网络错误被重复扣费。

### 实施合同

1. 媒体结果查询、下载和落盘的产品 deadline 最低 300 秒；分别配置 connect/header/idle/overall/poll，不全局替换普通 API timeout。
2. 保留 gateway Token Bucket → durable queue/owner limit → provider semaphore 三层保护；GPT/Seedream 队列和并发分开。
3. gateway 与 relay preflight 同时校验并输出：入站 rate/queue、owner limit、provider concurrency、task body cap、total in-flight bytes、timeout、最近 429/Retry-After。
4. Seedream 并发与 owner 字段必须纳入 production preflight；小 Prompt 与带参考图请求分别做容量 fixture。
5. 账号配额未知时保持或降低并发，不自动从 6 提到 16；owner/model 默认并发为 1。
6. 组图是一个父 Operation、多 Asset；普通产品仍为三候选，15 只是上游合法上限。
7. 成功响应解析失败、下载失败、落盘失败和网络中断进入 `outcome_unknown` 并查询原 Operation；不自动指数重提付费任务。
8. 容量报告分开写“受理能力、排队能力、provider 实际并发、完成吞吐”，禁止用“100 用户并发”一个数字概括。
9. 冻结供模块 16 消费的跨媒体可靠性接口：deadline/timeout matrix、capacity preflight、owner/provider concurrency、total in-flight bytes 和 `outcome_unknown` 原 Operation 查询。该接口不包含图片候选数量、图片 UI 或图片 provider 路由。

### 验收 Oracle

- 每层 timeout 配置表明确计时类型和来源；60/120 秒媒体断点为零或有合理非结果用途说明。
- production preflight 缺 Seedream/字节预算/300 秒任一字段时失败。
- 队列满返回 Retry-After，客户端使用有抖动有界退避，不立即重试。
- fake upstream 在提交后断网：只出现一个付费 Operation，重启后查询同一 ID。
- 小 Prompt 与参考图容量 fixture 不通过取消上限来“达标”。
- 未读取真实线上配置时报告明确写“代码与配置模板已验收，线上未验证”。

### 交接物

timeout matrix、capacity report、production preflight 和 unknown-outcome fixture。

---

## 模块 15：Fun-ASR 语音输入

**依赖：** 04、07、12
**模块主题前缀：** `feat: connect fun asr voice transcription`

### 用户结果

用户可录音或上传音频，看到转写并编辑后放入 Composer；取消、迟到和权限拒绝不会串到其他任务。

### 权威状态

Voice service 写 `voice_operation_id`、owner/task scope、transcript revision 和状态；Composer 只接收用户确认的 transcript。

### 实施合同

1. 只实现 Fun-ASR-Flash provider-neutral SpeechTranscription adapter；对 Whisper/旧 ASR 执行 `D1_STOP_WRITES` 与 `D2_MIGRATE_CONSUMERS`，保留 `D3_LEGACY_READ_ONLY` setting mapper 给模块 22，运行时源码由模块 23 `D4_PHYSICAL_DELETE`。
2. 录音、上传、取消、迟到回执绑定 operation ID、task owner 和 transcript revision。
3. 空音频、过大、不支持编码、权限拒绝和断网保留 Composer 文字与其他附件。
4. 原始转写、用户修订和最终显示字幕分开；视频模块可引用原始/修订 transcript，不复制为另一真相源。
5. 音频只在当前任务/媒体 evidence 生命周期内保存；不进入 AutoMem、普通日志或文本 prompt 二进制。

### 验收 Oracle

- 取消 A 后开始 B，A 的迟到结果不得写入 B。
- 麦克风拒绝后可重新授权；不会阻断文字任务。
- fake Fun-ASR 返回空/错误/部分结果时状态真实，不把空文本标成功。
- 转写编辑后 revision 前进；Composer 只插入当前确认版本。
- 最终 provider graph 无 Whisper/第二 ASR 可执行路径。

### 交接物

voice operation/transcript schema、provider fixture 和生命周期规则。

---

## 模块 16：视频证据流水线与本机导出

**依赖：** 04、06、12、14（只消费跨媒体可靠性/容量/unknown-outcome 合同）、15
**模块主题前缀：** `feat: integrate the evidence based video studio`

### 用户结果

用户导入真实素材、描述目标，系统根据可追溯证据准备第一版时间线；用户按场景修改、锁定、预览并在本机导出。

### 权威状态

MediaProjectService 写 source manifest、Evidence、Timeline Version、Export Operation/Asset；FFmpeg/ffprobe 只执行确定性本地动作。

### 实施合同

1. 工作台的视觉层级可以参考 HTML 和旧 VideoStudio；正式阶段、证据、时间线、锁定和导出行为只由本模块合同决定，不把 HTML 当作施工依据或完成 Oracle。
2. `ingest`：源文件只读，记录 fingerprint、ffprobe、音轨、时长、尺寸、帧率、旋转和缺失状态。
3. `evidence`：Fun-ASR transcript、本机 shot/quality、MiMo 代表帧证据分别绑定 source/time/fingerprint/revision/confidence；证据不可用明确 unchecked。
4. `plan`：DeepSeek 只读 Brief 与证据，输出引用真实 source ID/time range 的 timeline draft；确定性 validator 拒绝越界、缺源、重叠非法和未知素材。
5. `edit/preview`：用户操作基于 timeline revision；锁定场景不被重新规划覆盖；字幕、Logo、CTA 和安全区由确定性图层处理。
6. `export`：单实例 FFmpeg 导出新 Asset，不覆盖源文件；完成必须通过 ffprobe 和存在/hash 检查。
7. 每个阶段是 MediaJob，记录 operation/project/input/output revision；阶段失败保留 checkpoint，不跳阶段或假成功。
8. 素材变化使相关 Evidence/旧 AI draft stale，但不删除用户当前 Timeline Version；由用户选择重新规划。
9. 对视频聊天中转执行 `D1_STOP_WRITES`：停止创建 `kind=video` 的 media draft；提供视频 draft/project/source/evidence/unknown Job 的 `D3_LEGACY_READ_ONLY` adapter 与 fixture给模块 22；物理删除统一由模块 23。

### 验收 Oracle

- source 文件移动后只能用 fingerprint/时长/尺寸重新定位，不按同名误连。
- planner fixture 引用不存在 source 或越界 time range 时 validator 拒绝。
- evidence revision 改变后 AI draft stale，但用户编辑版本仍可打开。
- locked scene 经重新规划保持不变；并发编辑返回 revision conflict。
- export 失败不产生成功 Asset；源文件 hash 不变；输出可由 ffprobe 读取。
- DeepSeek 请求中无视频二进制，MiMo 只收受控代表帧，Fun-ASR 只收音轨。

### 交接物

五阶段 schema、evidence contract、timeline validator、export fixture 和旧视频草稿迁移映射。

---

## 模块 17：已安排、逻辑运行与桌面通知

**依赖：** 02、03、07
**模块主题前缀：** `feat: harden scheduled operations`

### 用户结果

用户用普通语言安排任务，看到下一次时间、运行记录和通知；休眠、时区变化和重启不会重复执行一批过期任务。

### 权威状态

ScheduledTaskService 写 schedule、`logical_run_id`、next occurrence 和 notification receipt；worker 执行 run；renderer 只投影。

### 实施合同

1. 保留当前 server/cron，不建第二调度器；UI 只显示目标、时间、结果、通知。
2. 同一时间窗口生成一个 logical run。系统休眠、关机或应用未运行导致错过时，默认写入 `missed` 记录且不补执行；只有用户对该计划显式启用 `run_once_after_wake` 时，唤醒后才为最近一个错过窗口补一次，绝不回放更早积压周期。
3. 修改时区、系统时间或 schedule 后重新计算 next occurrence 并保留历史。
4. 同时提供旧 schedule/logical run/notification 字段的 `D3_LEGACY_READ_ONLY` adapter 与时间 fixture给模块 22；统一迁移器不得重新推导 DST 或 missed-run 语义。
5. 每次执行经 agent-worker，使用独立 TaskRun 与 permission snapshot；不得调用公共 CLI。
6. 通知深链只携受控 task/logical run ID；目标不存在落安全页面。
7. 网络错误不自动重复外部副作用；有界重试只用于读取/查询，发送动作沿原 Operation 对账。

### 验收 Oracle

- DST 前进/回退、休眠跨多个周期、时区修改和重启 fixture：默认产生 missed 记录且不执行；显式 `run_once_after_wake` 时只补最近一个窗口；每个窗口最多一个 logical run。
- worker 崩溃后不创建第二 run；状态可恢复。
- 通知重复点击只打开一个安全窗口，不创建重复任务。
- UI/日志不显示 cron 表达式、CLI 参数、provider 或 Core ID。

### 交接物

schedule/logical run schema、missed-run policy、notification receipt 和时间 fixture。

---

## 模块 18：BrowserCapability 与 BOSS 招聘工作台

**依赖：** 02、03、04、06、07、08

模块 08 提供产品权限值、TaskRun 不可变 permission snapshot 和审批合同；模块 18 只能消费这些合同，不得重新定义权限映射或绕过 ProductTask/Core approval。
**模块主题前缀：** `feat: integrate the recruiting workbench`

### 用户结果

用户按门店创建招聘计划，BilliardBuddy 在当前 Chrome 会话内筛选和准备沟通批次；登录、验证码、页面改版和发送不确定时停下来让用户接管。

### 权威状态

RecruitingService 唯一写 Plan、Batch、Checkpoint、Operation。Skill、bridge 和 Core 均不是业务状态源。

### 实施合同

1. 定义 `BrowserCapability.observe/action/reobserve`；正式本机实现仅 `ChromeSessionBridge`，唯一 packaged transport 固定为 `BilliardBuddy Chrome Extension ↔ Chrome Native Messaging host ↔ 本地 bridge session`。MCP 只负责 Core Tool 到 BrowserCapability 的内部调用，不是浏览器 transport；禁止远程 WebSocket bridge、Playwright 第二 adapter或 Electron Preview 冒充用户 Chrome 会话。
2. Extension 与 native host 是模块 18/24 必须验证的同一能力：固定 extension ID/版本协议/native host name；public package 只允许正式 extension origin；sidecar wrapper 必须使用 packaged sidecar 的 `cli --app-root <unpacked-root> --chrome-native-host` 模式，不允许缺失 sidecar mode；extension 未安装、host manifest 失败、版本不兼容或未握手时 capability 为 unavailable，BOSS 退化为人工交接，不展示可执行。
3. Bridge 每次连接生成 `bridge_session_id`，每个调用携带 `request_id + owning_client_id + page_version` 并只回给发起者；不得广播 tool response。断线清除该 session 的短期 ref/pending request；读操作可在重连后重新 observe，写操作断线固定 `outcome_unknown`，必须 reobserve 对账，不能自动重发。
4. observe 返回 URL/title/page version、稳定 ref、role/name/state/value、可见文字摘要和 visual_required；导航/刷新/分页/iframe 变化后旧 ref 失效。
5. action 只引用当前 page version 的稳定 ref，不保存长期 CSS selector，不输出桌面像素坐标。
6. visual_required 时 MiMo 只生成视觉证据；无法映射当前 ref 就转用户接管，MiMo 不执行动作。
7. 登录、扫码、验证码、人机验证和 Chrome 站点权限由用户在可见浏览器处理；不导出 Cookie/storage state/profile，不调用私有接口 header。Extension 站点权限、产品审批与页面当前版本三者任一不满足都不执行 action。
8. 正式只读链固定为：`agent-worker/Core capability discovery → boss-recruiting Skill → recruiting-browser Tool.observe/reobserve（MCP 内部协议）→ BrowserCapability → ChromeSessionBridge → Native Messaging host → BilliardBuddy Chrome Extension → read receipt → RecruitingService 写 BrowserCheckpoint → ProductTask 结果投影`。observe/reobserve 不需要副作用审批，但仍校验 owner、plan/batch、bridge session、当前 page version 和短期证据边界。
9. 正式副作用链固定为：`Skill 提议受限 action → recruiting-browser Tool 请求 ProductTask/Core approval → 用户批准 → RecruitingService 先持久化 RecruitingOperation intent → Tool.action → BrowserCapability/ChromeSessionBridge → Extension 页面动作 → reobserve receipt → RecruitingService 写 succeeded/outcome_unknown → ProductTask 结果投影`。未批准、intent 未持久化、session/page version 不匹配时不得调用 action；点击本身不是完成证据。
10. Tool 通过 Core 现有工具注册边界暴露 `observe/action/reobserve`，只接收 plan/batch/operation ID 与受限 payload；不得让 Skill 直接写 RecruitingService 文件或调用 MCP/native/extension 细节。生产构建不得继续使用 `BROWSER_TOOLS=[]` 的 no-op stub；capability manifest 与 ListTools 必须证明真实工具非空且版本一致。
11. RecruitingPlan 保存门店、岗位事实、筛选条件、话术约束、允许动作；Batch/Operation 使用 revision、idempotency 和页面回读证据。
12. 候选人完整简历、联系方式、截图和 HTML 只作短期受控证据，不进 AutoMem、普通日志或跨门店同步。
13. 当前仓库没有可证明的旧 Recruiting 持久化 schema，因此模块 01 矩阵将其标为 unsupported，本模块不创建假 legacy adapter；将来发现真实旧数据时必须先更新矩阵、fixture 和 Spec-Commit。
14. 通用桌面 Computer Use 的消费者迁完后列入模块 23 `D4_PHYSICAL_DELETE`；本模块不接 Playwright 第二生产 adapter。

### 验收 Oracle

- 固定 bridge/extension fixture 覆盖未安装、manifest/host 启动失败、版本不兼容、登录、站点权限、分页、ref 失效、多 client 路由、断线、弹窗、visual_required、验证码和页面改版；不同 session/client 的 response 不得交叉或广播。
- packaged sidecar 的 native host wrapper 能实际进入 `cli --app-root … --chrome-native-host`，production capability discovery/ListTools 非空；public package 不包含 dev extension origin 或远程 bridge fallback。
- 同一发送 operation 重放不产生第二次动作；页面未回读时不能显示已发送。
- 两个门店的 Plan/Batch/候选 ref 不能串用；关闭计划先停止活动 batch。
- 正式 packaged agent-worker 的 capability discovery 能发现 `recruiting-browser` Tool；只读 fixture 按 observe→checkpoint→投影执行且不产生 approval；副作用 fixture 严格按 approval→intent persisted→action→reobserve receipt→结果写入执行，未批准/intent 写入失败/页面未回读时分别为 rejected/未执行/outcome_unknown。不能只用协议类型或直接调用 bridge 的单测代替。
- 最终运行图无桌面坐标点击 fallback、Cookie 导出或私有 API header。
- 真实 BOSS 发送未做时交接明确写“假页面合同已验证，真实平台未验证”。

### 交接物

BrowserCapability、Chrome Extension/Native Messaging transport contract、bridge session/request routing、Recruiting schema、fake extension/page suite、数据最小留存和 Computer Use 删除清单。

---

## 模块 19：台球经营 Skills 与按需知识

**依赖：** 04、05、07、08、12、13、16、17、18

模块 19 只消费已冻结的 ProductTask、MediaProject、图片/视频 Operation、ScheduledTask 和 Recruiting 合同；Skill 不拥有这些领域的持久化状态。
**模块主题前缀：** `feat: integrate billiards operations skills`

### 用户结果

用户可以用自然语言获得台球经营帮助；只有真实存在工具的动作才会被承诺，知识不会夹带来源元数据或虚假结果。

### 权威状态

Skill/reference 保存可复用流程和知识正文；门店差异保存于产品数据；实时状态必须由 Tool/产品 service 读取。

### 实施合同

1. 保留并清洗 `billiardsOperations`、`billiardsKnowledge` 等当前已注册 Skills；按需加载，不常驻完整 prompt。
2. 首次进入模型前，知识载荷只含正文、适用条件和必要安全边界；开发核验来源、URL、脚注和抓取元数据不进入 Skill payload、日志或用户回答。
3. 删除错误、过期、违规和“工具不存在却声称已执行”的内容。
4. 经营动作只能通过真实领域服务的公开合同执行：普通任务使用 ProductTaskService 的 task/run/receipt；自动事项使用 ScheduledTaskService 的 schedule/logical run/notification receipt；图片和视频使用 MediaProjectService 及模块 13/16 已冻结的 Operation/Asset/Version/Evidence；招聘使用 RecruitingService 的 Plan/Batch/Checkpoint/Operation。Skill 不得直接写领域文件、调用 cron/gateway/relay/FFmpeg 或 sidecar 内部存储，不得创建 `media_draft`，也不得把 toast、模型文字或 Skill 输出当成完成结果。
5. 无工具、无实时证据或字段不足时明确“无法执行/需要确认”，不把模型文本当完成结果。

### 验收 Oracle

- 发布包 Skill payload 静态扫描无来源 URL、脚注、抓取日期和开发审计元数据。
- 工具缺失 fixture 只能返回说明/草稿，不显示已发送、已发布、已生成或已修改。
- 门店事实从产品数据读取，AutoMem 旧值不能覆盖当前 Tool 结果。
- Skill 按需加载；普通无关任务上下文不包含台球知识全文。
- 每个经营动作都能在 fixture 中追溯到 ProductTask、ScheduledTask、MediaProject 或 Recruiting 的真实 receipt；缺少对应服务或能力时只能返回“无法执行/需要确认”，不得生成虚假完成状态。

### 交接物

Skill payload schema、机器可读清洗 manifest、能力/工具映射和负面 fixture；文字结论进入 accepted commit body，不新建清洗报告 Markdown。

---

## 阶段 D：产品收口与迁移

## 模块 20：用户本机终端

**依赖：** 02、03、06、10

模块 20 只消费模块 10 冻结的 canonical workspace/path helper 和 owner 校验合同；不得复制第二套 realpath/UNC/盘符边界逻辑，也不得反向修改 Review 领域状态。
**模块主题前缀：** `feat: secure the local terminal dock`

### 用户结果

任务需要时可打开横跨第 2—4 栏的真实本机终端；它使用当前用户 Shell 和项目目录，不显示 Agent Bash 或内部运行日志。

### 权威状态

Electron TerminalService 写 PTY session；每个 session 绑定 owner WebContents、task ID、canonical cwd、request ID 和 exit state。

### 实施合同

1. BottomTerminalDock 的信息架构可以参考 HTML 和 `c2b1304b`；真实 PTY 权限、owner、cwd、环境和生命周期必须以本模块合同为准，不复制 HTML 脚本或假终端输出。
2. create/write/resize/kill 每次验证 owner WebContents、task、canonical workspace/cwd 和 session state；客户端 session ID 不足以授权。
3. 使用当前用户 shell；环境变量采用最小允许/明确剔除策略，移除 gateway/relay/provider/updater/server auth 等内部秘密。
4. Terminal 与 Agent Bash/worker/CLI 不共享权限、输入、输出、history 或 session。
5. 窗口关闭、task 切换、renderer reload、spawn failure 和 PTY exit 幂等清理；PTY 不伪装可恢复，重启后明确结束。
6. 首输出在 renderer listener 建立前有界缓存；大输出有背压/截断，不耗尽 renderer 内存。
7. terminal preferences 只有进入模块 01 支持矩阵并具备 fixture 时才提供 `D3_LEGACY_READ_ONLY` adapter；旧 PTY session 和命令历史固定不迁移，未登记偏好保持原位或明确 unsupported。
8. 更新/退出时若有前台命令，给一次清楚确认，不自动重放最后命令。

### 验收 Oracle

- 窗口 A 创建的 session，窗口 B write/kill 被拒绝。
- cwd 符号链接、移动、删除、UNC/盘符和 workspace 越界安全拒绝。
- PTY env fixture 中无产品内部 token/key；用户正常 PATH/locale 可用。
- 首输出、快速退出、大输出、窗口关闭、task 切换和 renderer reload 无丢失敏感状态或僵尸进程。
- UI 只显示“本机终端”，不显示 CC-Haha 远程终端/Agent Bash 日志。

### 交接物

TerminalSession schema、IPC auth、env policy、cleanup 与输出 fixture。


---

## 模块 21：设置、能力快照与技术表面收口

**依赖：** 04—20
**模块主题前缀：** `refactor: simplify product settings and capabilities`

### 用户结果

设置只展示外观、通知、项目约定、业务能力和安全状态；用户不再管理 Provider、模型、API Key、MCP/Plugin/Python/WebSearch 或通用桌面控制。

### 权威状态

ProductCapabilityService 是 capability snapshot 的唯一汇总者；设置 store 只保存用户允许修改的产品偏好，不推断能力。四态定义如下：

| 状态 | 唯一判定 | 为 false 时的 UI 与行为 |
|---|---|---|
| `compiled` | 构建 manifest 与 package input graph 明确包含该能力实现 | 显示“此版本未包含”，隐藏执行入口；不得下载脚本或远程开启 |
| `configured` | 本地产品配置/部署环境的必需非密钥字段合法，密钥只做存在性与可解密检查 | 显示“尚未配置/配置无效”，禁止启动 Operation；不切第二 provider |
| `available` | `compiled && configured`，且当前权限、sidecar/tool/provider health 满足能力自己的 freshness deadline | 显示“暂不可用/需要授权/需要登录”及唯一恢复入口；旧健康缓存过期后不得继续显示可用 |
| `running` | 对应 service 返回当前 owner 下真实的 active Operation/Job/Session ID | 只用于显示当前运行态；不能由 loading 动画、页面打开或代码存在推断 |

快照附带 `source/version/hash/checked_at/stale_after/reason_code`。状态冲突按 `compiled → configured → available → running` 逐层收窄；远程 flag 不能把本地正式能力从 false 改 true，也不能覆盖用户已经明确开启的本地核心设置。

### 实施合同

1. 按本模块列出的设置分组实施；HTML 只辅助理解信息层级：常规、功能/工作方法、门店资料、项目约定与记忆、本机终端、关于。
2. 每项正式能力按上述真值表输出四态与固定退化；构建 feature、产品设置、部署环境、权限/登录、provider health 和 active operation 分别提供证据，不能用“代码存在”代替 available/running。
3. 本地产品配置与部署环境是权威；远程 flag 只能建议未设置用户的默认/灰度，网络不可达使用打包明确默认，不静默关闭核心能力。快照在启动、配置/权限变化、sidecar 重启和 freshness deadline 到期时刷新，旧快照过期只降低 available，不猜测 running。
4. 对普通用户 Provider、模型、API Key、MCP/Plugin/Python 管理页与 routes 执行 `D1_STOP_WRITES`/`D2_MIGRATE_CONSUMERS`；保留 Core 内部机制和必要开发诊断，死源码由模块 23 `D4_PHYSICAL_DELETE`。
5. 对 WebSearch、Tavily/Brave key、DeepSeek native web-search 工具/路由/配置执行 `D1_STOP_WRITES`/`D2_MIGRATE_CONSUMERS`；保留 WebFetch 和受控 BrowserCapability，死源码由模块 23执行 `D4_PHYSICAL_DELETE`。
6. 对 Computer Use 设置、权限安装页和屏幕录制/辅助功能引导执行 `D2_MIGRATE_CONSUMERS`；通用桌面控制源码由模块 23 `D4_PHYSICAL_DELETE`。
7. TeamMem 不出现在快照、设置或诊断；项目指令、Session Memory、AutoMem 使用业务化名称。
8. 只为模块 01 支持矩阵登记的 provider/model、WebSearch key presence（不复制密钥值）、capability/TeamMem/user setting 旧 shape 提供 `D3_LEGACY_READ_ONLY` adapter/fixture；普通无版本 settings 不承诺任意历史格式。本模块只移除普通运行时入口，不破坏已登记 reader。
9. About 页显示版本、更新状态和许可，不显示内部 provider/model。

### 验收 Oracle

- 正式普通包在非内部 USER_TYPE 下仍有项目约定、长期记忆、Session 摘要和必要业务能力。
- GrowthBook/网络不可达、provider health 过期、系统权限拒绝、浏览器未登录和真实 Job active 五类 fixture 分别产生符合真值表的四态、reason code 与恢复入口。
- UI、API、环境模板和文案 consumer graph 中 WebSearch/Tavily/Brave/Computer Use/TeamMem 普通入口归零。
- Core 的 MCP/Plugin/Hooks 执行机制未被删除，只从普通设置隐藏并移除无消费者产品管理表面。
- 普通设置不出现 model/provider/API key/`tengu_*`/`CLAUDE_CONFIG_DIR`。

### 交接物

capability snapshot schema、设置 IA、技术表面删除候选和 fallback fixture。

---

## 模块 22：版本化数据迁移与 legacy reader

**依赖：** 02—21
**模块主题前缀：** `feat: add versioned product data migration`

### 用户结果

安装新版本后，只有模块 01 `legacy-support-matrix.json` 在对应 Spec-Commit 中明确登记、且具备 immutable fixture 与正向/幂等测试的旧数据会自动迁移；失败时旧数据保持只读可恢复，不出现空库。未登记、provisional 或 unsupported 格式必须明确提示并保持原数据，不得声称支持。

### 权威状态

统一 MigrationCoordinator 只拥有迁移顺序、备份、checkpoint、回滚和 manifest；各 `D3_LEGACY_READ_ONLY` adapter 只能读取、验证并标准化旧数据，不能写目标存储或执行外部副作用；迁移后的 ProductTask、Memory、Media、Schedule、Recruiting、Settings 等目标实体只能由对应领域 service 通过专用 migration mutation 落盘，该 mutation 复用 owner、幂等、revision 和原子写入规则。Migration manifest 记录版本、数量、hash、状态和脱敏失败，不保存正文或绝对路径。

### 实施合同

1. 读取并锁定模块 01 `legacy-support-matrix.json`；模块 22 不得新增、猜测或扩大支持范围。每个 supported input 必须有不可变历史 fixture、明确 reader/migration entry、迁到 current、写回 current、二次运行幂等和损坏/future-version 策略；provisional/unsupported 只隔离或保持只读。
2. 定义启动迁移顺序：检测 → 备份 → adapter 只读标准化 → 领域 service migration mutation → 重建索引 → 冷启动读取验证 → 开启新写入。Coordinator 不得直接写任何领域数据文件。
3. 领域 adapter 必须按下表由所属模块提前定义并测试，且只处理支持矩阵登记项；模块 22 只编排，不重新推导字段映射。每类探测到的旧数据必须按矩阵迁移、只读隔离或明确 unsupported，并写入 manifest。

| Legacy 数据 | Adapter / fixture 负责人 | 模块 22 固定动作 |
|---|---:|---|
| ProductTask、TaskRun、ThreadEntry、事件 cursor | 02 | 迁到当前 schema 并校验 ID/revision/sequence |
| QueuedMessage、文本 TaskReference、Checkpoint、ForkSource | 09 | 安全映射到 ProductTask 子实体；无法映射逐项只读归档并计入 manifest |
| provider/model/Qwen context value | 04 | 映射到当前 model contract 或标 unsupported |
| 项目指令、Session Memory、AutoMem、TeamMem legacy state | 05 | 当前 unsupported，保持原文件/只读隔离；未来只有支持矩阵登记后才按 scope 迁移，TeamMem 永不恢复同步运行时 |
| media project/task/asset/version | 12 | 迁到统一 owner/Operation/Asset/Version |
| image media draft、候选、unknown Job | 13 | 有有效 project/asset/job/durable ID 或已提交副作用时转独立图片项目；仅纯文本空 draft 本地只读归档 |
| Whisper/旧 ASR setting 与 transcript | 15 | 映射 Fun-ASR setting；保留原始/修订 transcript 边界 |
| video media draft、source/evidence/timeline/unknown Job | 16 | 有有效 project/source/evidence/job/durable ID 或已提交副作用时转独立视频项目；仅纯文本空 draft 本地只读归档 |
| scheduled task/logical run/notification | 17 | 迁 schedule 和历史，不补执行旧周期 |
| recruiting plan/batch/checkpoint | 18 | 当前无旧持久化 schema，标 unsupported 且不创建假记录；未来只消费支持矩阵登记项 |
| terminal preferences | 20 | 只迁偏好，不迁 PTY session/命令历史 |
| capability/settings/WebSearch key presence/TeamMem setting | 21 | 映射当前设置；不复制密钥值或恢复已删能力 |

4. Qwen/Whisper/旧 provider 值只在矩阵登记的字段形态内通过纯 legacy mapper 转成当前合同或明确 unsupported；不恢复旧可执行 provider。
5. 媒体迁移只处理矩阵登记形态，并分类为已关联项目、未关联 draft、运行中 Job、outcome_unknown、孤儿 Asset。已关联项目转到派生的 MediaLibrary owner 并保留身份；unknown 保留 durable ID 和查询入口。
6. 媒体聊天中转按唯一规则迁移：凡是矩阵已登记且拥有有效 MediaProject、Asset、Job、远端 durable ID 或已提交/unknown 副作用的记录，迁为对应 MediaLibrary 下的独立图片/视频项目并保留身份与恢复入口；未登记格式保持只读隔离。不得让用户选择两套运行路线。
7. 项目指令与记忆只有在矩阵登记具体历史形态后才自动迁移。当前 memory 无版本/历史 fixture，默认保持原文件原位且 unsupported，不由模块 22重写。若未来登记，仍必须遵守：既有 `CLAUDE.md`/兼容源正文、mtime、权限和路径不变，品牌文件不覆盖，Session/AutoMem scope 不提升，TeamMem 不恢复同步。
8. 迁移可重入，使用版本+hash 备份、checkpoint 和原子替换；同名冲突不覆盖；失败进入 `failed_read_only`。
9. 正式升级包必须继续携带 coordinator、支持矩阵登记的 legacy reader/fixture 和回滚入口；本模块不得删除它们。
10. 迁移 manifest 只记录 storage ID、输入/目标版本或 shape ID、数量、状态、相对/脱敏标识和错误码，不记录用户正文、候选人隐私、密钥或绝对路径。

### 验收 Oracle

- 对 `legacy-support-matrix.json` 每个 supported input 从 immutable fixture 冷启动最终安装目录：备份存在、数据数量一致、owner/revision/ID 映射可追踪；provisional/unsupported 不进入自动迁移。
- CI 对支持矩阵执行一一对应检查：每个 supported entry 都存在 fixture、reader/migration、正向、current 写回和幂等测试；任一缺失则阻断模块完成。
- 当前初始矩阵必须如实标记 ProductTask v2 provisional，memory/recruiting/cron run log/普通 settings/desktop localStorage 历史版本 unsupported；不得因代码中有读取分支或 schemaVersion 常量就升级为 supported。
- 在每个迁移阶段注入崩溃/磁盘满/权限失败：原数据保持、重启可继续、不会初始化空库。
- 同一迁移运行两次结果一致，不复制 task/project/asset/operation。
- media unknown、未关联 draft 和孤儿 Asset 均出现在 manifest 与用户可恢复入口；含项目/资产/Job/durable ID 的记录全部迁为独立项目，只有从未提交副作用的纯文本空 draft 进入只读归档。
- 项目指令/记忆 fixture 证明：既有 `CLAUDE.md` 正文、mtime、权限不变；品牌文件不覆盖；AutoMem 不提升为项目指令；scope/source/freshness 保留；冲突进入隔离备份且可回滚。
- 新安装无 legacy data 时不创建虚假迁移或空备份。

### 交接物

migration coordinator、冻结的 `legacy-support-matrix.json`、矩阵登记的领域 adapter/immutable fixture、manifest 和备份/回滚规则。

---

## 阶段 E：清理、发包与验收

## 模块 23：死运行时与依赖物理清理

**依赖：** 01—22
**模块主题前缀：** `refactor: remove dead product runtimes`

### 用户结果

源码和本地运行图只剩 BilliardBuddy GUI、内部 worker、ProductTask/媒体/招聘/定时服务，以及升级所需 migration reader；没有第二前端、公共 CLI/TUI、旧模型、旧媒体中转或高权限桌面控制继续参与正式运行。

### 物理删除 Manifest

`D4_PHYSICAL_DELETE` 前每一行必须满足消费者归零。删除对象不得仅凭路径名或一次 `rg` 判断。

| 对象 | `D1_STOP_WRITES` / `D2_MIGRATE_CONSUMERS` 完成模块 | `D4_PHYSICAL_DELETE` 负责人 | 必须保留的 `D3_LEGACY_READ_ONLY` 内容 | `D5_PACKAGE_ABSENT` 负责人 |
|---|---:|---:|---|---:|
| 第二 renderer/旧壳/旧业务 store 与可执行旧 API | 01、06—11 | 23 | Git 历史、许可证；不包括下一行 ProductTask reader | 24 |
| ProductTask `D3_LEGACY_READ_ONLY` reader/adapter/fixture | 02、22 | 不执行 D4；按第四部分未来触发条件单独处理 | 旧 ProductTask schema 读取、ID/revision/sequence 映射和回滚 fixture | 24 验证包内可达 |
| `productInstructions` 外层注入 | 05 | 23 | 原生 resolver 与 legacy 文件兼容 | 24 |
| 公共 CLI/TUI、Ink、REPL、Doctor、bin/help/publish entry | 03、17 | 23 | 内部 agent-worker 与 Core command handler | 24 |
| Qwen 可执行 provider/route/config/test fixture | 04 | 23 | 模块 22 的纯 legacy value mapper | 24 |
| Whisper/旧 ASR 运行时 | 15 | 23 | 模块 22 的 legacy value mapper | 24 |
| 通用桌面 Computer Use、Python helper、专用 API/UI/vision routing | 18、21 | 23 | BrowserCapability、MiMo 普通视觉证据、Core 通用 Tool/MCP | 24 |
| WebSearch、Tavily/Brave、native search route | 21 | 23 | WebFetch 与 BrowserCapability | 24 |
| TeamMem OAuth/watcher/endpoint/settings/diagnostics | 05、21 | 23 | 无运行时；仅必要 migration mapping | 24 |
| mediaWorkbenches Skill/Tool、`media_draft` 新建与线程投影 | 13、16、22 | 23 | 独立 MediaProject 与 legacy migrator | 24 |
| 旧 workflow runtime/DSL、重复 media route/service | 12—16、22 | 23 | 当前 MediaProjectService | 24 |
| Tauri/Linux target 与重复构建 workflow | 06、20—22 | 23 | Windows/macOS Electron 构建资产 | 24 |

### 删除闸

每个对象必须依次满足：

```text
legacy inventory
→ 新消费者接通
→ 对应 D3 reader/mapper/fixture 已由模块 22 编排验证
→ build/package input graph 核对
→ runtime consumer graph 为零
→ D4_PHYSICAL_DELETE
→ lockfile、类型、相关测试和本地 build 再验证
```

实施规则：

1. 删除必须覆盖实现、注册、测试、依赖、环境变量、部署模板、帮助和用户文案；但不得删除 Manifest 明确保留的 reader、mapper、fixture、许可证或 Core 通用机制。
2. `dist/`、`output/`、`electron-dist/` 等本地目录只有在能证明为当前构建拥有的 staging 时才清理；不得递归删除用户成果、旧数据备份或 migration manifest。
3. 删除后的 import graph、route graph、worker graph、provider graph 和 package input graph 必须重新生成；不能用换名或 compatibility shim 保留第二实现。
4. 若任一消费者、迁移 fixture、许可证或构建入口尚未归零，停止该行删除并记录阻塞项；不得影响其他已独立闭合的 Manifest 行。

### 验收 Oracle

- 每个 Manifest 行都有删除前 consumer graph、实际删除路径和删除后 graph；保留项有可达原因。
- renderer、server、sidecar、worker、gateway、relay 的类型/相关测试和本地 build 通过。
- migration coordinator、受支持 legacy readers/mappers、旧 schema fixture 和回滚入口仍可达。
- Qwen、Whisper、桌面 Computer Use、WebSearch、TeamMem、公共 CLI/TUI 和媒体聊天中转没有正式运行时入口。
- Core 的工具、Skills、Hooks、MCP、子代理、权限、resume/compact 仍有消费者和回归证据。
- 删除不触及用户数据目录、迁移备份、Git 历史或许可文件。

### 交接物

逐行 D4 删除 manifest、删除前后 consumer graph、保留 reader/mapper/fixture 清单、最终源码运行图、依赖/lockfile 变化、本地 build 结果和交给模块 24 的 package input 白名单；文字摘要进入 accepted commit body。

---

## 模块 24：双平台发包、签名与自动更新

**依赖：** 01—23
**模块主题前缀：** `release: finalize desktop packaging and updates`

### 用户结果

可生成且只生成 Windows x64 与 macOS arm64 的 BilliardBuddy GUI 包；安装包包含运行和升级所需组件，更新校验失败时继续安全使用当前版本。

### 权威状态

CI/feed 拥有 release artifact 与 release manifest；ElectronUpdaterService 是本机 `UpdateTransaction` 的唯一写入者；renderer update store 只投影 transaction。ProductTask、MediaProject、Memory 和 Terminal service 只提供安装闸状态，不写 release manifest 或 update transaction。

更新状态机固定为：

```text
idle
  → checking
  → up_to_date | available
available
  → downloading
  → downloaded_verified
  → waiting_for_safe_exit
  → restart_pending
  → confirmed_on_target_version
```

不存在可由当前进程可靠观测的 `installing` 持久状态。`restart_pending` 必须在调用 `quitAndInstall` **之前**原子持久化，含 source version、target version、artifact hash、transaction ID 和 attempt ID；随后调用安装即可能立即退出。若调用在进程仍存活时同步失败，ElectronUpdaterService 以同一 attempt receipt 把状态恢复到 `downloaded_verified` 并保留错误；一旦进程退出，只有目标版本首次启动核验 transaction/artifact version 后才能写 `confirmed_on_target_version`。若重新启动后仍是旧版本或无法确认，显示“更新结果待确认”，不得自动再次安装。

失败语义固定：检查/下载失败回到 `idle` 并保留当前版本；下载取消回到 `available`；校验失败删除当前模块拥有的损坏下载并回到 `available`；activity gate 拒绝时保持 `downloaded_verified`；调用安装前任一步失败保持当前应用运行。

### 发包合同

1. 只构建 Windows x64 与 macOS arm64；不存在 Linux/Tauri/公共 CLI/TUI 产品 target。
2. 图标由一个透明角母版生成 icns/ico/png，各尺寸检查无白底、裁切和旧品牌。
3. package 白名单必须包含：renderer、sidecar、agent-worker、FFmpeg/ffprobe、node-pty、preview agent、Chrome Native Messaging host/wrapper、migration coordinator、支持矩阵登记的 legacy readers/mappers、必要字体和许可证。BilliardBuddy Chrome Extension 固定为 Chrome Web Store 分发的**伴随组件**，不是第三个独立 BilliardBuddy 产品或桌面 target；模块 24 同一 release manifest 必须记录正式 extension ID、最低兼容版本、商店安装入口、native host protocol version 和兼容矩阵。桌面安装包不得静默旁载扩展；扩展未安装/未启用/版本不兼容时招聘浏览器能力固定 unavailable，并引导用户从唯一商店入口安装或更新。扩展发布和真实商店安装属于 `EXTERNALLY_VERIFIED`，未验证时不得宣称 BOSS 自动执行已交付。
4. 模块 24 是所有删除对象 `D5_PACKAGE_ABSENT` 的唯一负责人：对模块 23 Manifest 逐行证明已删除运行时在 asar、unpacked resources、sidecar、更新 ZIP 和安装目录中均不存在；模块 23 的源码/输入图不能替代该证明。
5. release artifact、hash、blockmap、签名元数据全部校验通过后才原子发布 manifest；任一不一致不进入 `downloaded_verified`、不提示安装、不退出当前版本。
6. 更新 UI 提供检查、下载、进度、取消下载、稍后安装和现在安装；所有按钮只发送带 transaction ID 的 mutation，renderer 不直接调用 `quitAndInstall`。
7. 下载可后台进行；进入 `waiting_for_safe_exit` 时读取 ProductTask/媒体/记忆/PTY 的统一 activity gate。可恢复写入先落盘，活动最终导出固定阻止安装，前台 PTY 固定要求用户确认，其他可恢复 TaskRun 保存 checkpoint 后才允许继续。
8. `ElectronUpdaterService` 只有在 transaction 为 `downloaded_verified` 且 activity gate 通过时，才先原子写入 `restart_pending`，再立即调用 `quitAndInstall`。同步调用失败且进程仍存活时按同一 attempt 恢复 `downloaded_verified`；进程退出后不得靠当前版本推测安装结果，目标版本首次启动核验 artifact version 和 transaction 后才写 confirmed。
9. 更新不自动降级；回退通过重新发布完整上一版本完成。旧客户端或旧 sidecar遇到不支持 schema 时返回“需要更新/恢复”，不得写回旧格式。
10. 源码接线、CI artifact 签名验证、真实安装/更新验证分成三个状态报告；前两档不能写成“真实更新成功”。
11. HTML 原型、验收截图、开发 secret、临时报告和未脱敏 fixture 不进入发布包。

### 验收 Oracle

- Windows/macOS package contents 与白名单逐项匹配；模块 23 每个 Manifest 行都完成 D5 证明，保留 migration reader 可从 packaged sidecar 冷启动。
- Windows 按可用环境运行 `signtool verify`；macOS 运行 `codesign --verify`、`spctl` 和 notarization ticket 检查。缺平台或凭据时逐项标记 `NOT_VERIFIED_EXTERNALLY`，不得伪造通过。
- manifest→artifact URL/hash/size/version/blockmap 一致；损坏、错签、旧版本和部分上传 fixture 均留在当前版本。
- update transaction fixture 覆盖检查无更新、下载中断/继续、用户取消、artifact 校验失败、稍后安装、activity gate 拒绝、写 `restart_pending` 前失败、`restart_pending` 写入后 `quitAndInstall` 同步失败并回到 `downloaded_verified`、调用后进程退出、旧版本重启未确认以及目标版本首次启动确认；状态机中不存在持久 `installing`，每个中断点不重复安装。
- 从旧 schema fixture 启动安装目录中的 sidecar，模块 22 migration 可达并保持备份/回滚。
- 目标版本未真实启动时，报告只能写“包与更新接线已验证”，不能写“更新成功”。

### 交接物

双平台 artifact 清单、package contents、D5 package manifest、签名/公证机器输出、更新 manifest 校验、activity gate fixture、保留 migration reader 清单和真实外部未验证项；文字摘要进入 accepted commit body。

---

## 模块 25：全链路验证与最终交接

**依赖：** 01—24
**模块主题前缀：** `chore: verify the single billiardbuddy product`

### 用户结果

仓库和安装包形成一个可解释、可恢复、没有第二运行路线的 BilliardBuddy 产品；所有未做的真实外部验证被明确列出。

### 模块边界

本模块只执行统一验证、包内容核对、机器证据汇总和最终交接，不修改产品代码，也不做“最小集成修复”。

若发现缺陷，主代理必须先判断缺陷属于哪个原模块或 Work Unit：合同逻辑、依赖或架构有缺口时，先由主代理修订本 Markdown 并创建新的 Spec-Commit；产品代码缺陷则回到所属原模块创建 repair Work Unit，由实施子代理修改、测试和提交。主代理接受 repair Work Unit 后重新运行受影响的验证矩阵。模块 25 不得跨域顺手修复，不得在最终验收提交中混入属于其他模块的产品代码或架构变更。

### 验收 Oracle：必须执行的验证矩阵

| 领域 | 必须证明 |
|---|---|
| 单一产品 | 一个 renderer、一个 ProductTask 产品 API/WS、一个 worker、一个媒体 service、两个桌面发布 target |
| 目标前端 | 首页、任务对话、第 3/4 栏、终端、图片、视频、经营、已安排、设置符合模块 06/10/13/16/18/20/21 的明文信息架构和交互合同；1280×720/200%/深浅主题可用；HTML 只辅助理解方向 |
| ProductTask | operation/revision/event/cursor、双窗口、重复提交、断线、停止、损坏数据和协议深链 |
| Worker/Core | ready、stream、approval、stop、crash、backpressure、resume；Core 原生工具/Skills/Hooks/MCP/子代理未被削弱 |
| 模型 | DeepSeek 文本、MiMo 证据、Fun-ASR；无 Qwen/Sonnet 隐式 fallback；window/body/compact 与 model manifest 一致 |
| 指令/记忆 | 三类品牌/兼容文件顺序、nested、resume/compact、AutoMem 删除、本地索引、TeamMem 包内归零 |
| Review/Preview | 文件引用、Diff、行评论、DOM selection、导航失效、高 DPI、真实文件回执 |
| 图片 | 三候选、路由、Operation kinds、unknown、mask/version/export、300 秒配置和容量 preflight |
| 视频 | ingest/evidence/plan/edit/export、source fingerprint、ASR/MiMo、锁定场景、导出产物 |
| BOSS | BrowserCapability 假页面、登录接管、ref 失效、审批、幂等、未知发送、隐私最小化 |
| Scheduled | DST、时区、休眠、logical run、通知深链 |
| Terminal | owner/cwd/env、首输出、大输出、窗口关闭和更新闸 |
| Migration | 全旧 schema fixture、备份、可重入、崩溃恢复、冷启动、migration reader 包内可达 |
| Cleanup | D1—D5 逐行证据、保留 reader/许可证、无 compatibility shim 或第二运行时 |
| Release | 类型、单测、集成、renderer/sidecar/worker build、双平台 package manifest、签名/更新分级报告 |
| 隐私 | 日志、包、fixture 和错误 UI 无密钥、Cookie、正文、Base64、候选人隐私和绝对路径 |

### 最终完成条件

1. 所有受控检查通过；失败项有真实输出，不能删除测试或放宽断言换取绿色。
2. 所有删除 Manifest 项完成 D4/D5，或因明确 reader/migration/许可证合同保留；不存在“以后可能复用”的正式运行时代码。
3. 最终安装包仍包含模块 22 的 migration coordinator、受支持 legacy readers 和回滚入口。
4. 真实付费生图、真实 BOSS 发送、真实双平台安装/签名/公证/更新若未执行，accepted commit body 逐项标记 `NOT_VERIFIED_EXTERNALLY`。
5. 最终 accepted commit body 包含：模块/Work Unit SHA 表、架构交接、包清单、migration 支持版本、D1—D5 结果、验证命令摘要和外部未验证项；机器细节只保存在测试、fixture、manifest、包清单或构建输出中，不另建 Markdown 报告。

### 最终代码形态（逻辑职责，不是强制目录迁移）

```text
BilliardBuddy Electron GUI
  ├─ current React renderer
  ├─ ProductTask service / API / WebSocket
  ├─ internal agent-worker → CC-Haha Core
  ├─ provider-neutral DeepSeek / MiMo / Fun-ASR adapters
  ├─ MediaProjectService → gateway / relay / local FFmpeg
  ├─ RecruitingService → BrowserCapability / ChromeSessionBridge
  ├─ ScheduledTaskService
  ├─ Electron PTY / updater / notifications
  └─ versioned migration coordinator + legacy readers
```

这棵树只表示职责。默认沿用当前真实目录；不得为了让目录名看起来像示意图而整体搬迁 `server/services`、Core 或 media 文件。

### 交接物

最终 accepted commit body、01—24 机器证据索引、模块/Work Unit SHA 表、最终逻辑架构、包清单、migration 支持版本、D1—D5 结果、验证命令摘要，以及逐项 `NOT_VERIFIED_EXTERNALLY` 清单；不新建最终报告 Markdown。
---

# 第四部分：后续删除触发条件

## 6. 首个迁移发布之后才能做的事

以下不属于模块 01—25 的当前交付，不得提前执行：

`[DEFERRED]` 删除 migration coordinator、某个 legacy reader 或旧 schema fixture，必须同时满足：

1. 已发布至少一个包含该 reader 的稳定升级版本；
2. 所有仍受支持的升级来源都不再产生该旧 schema；
3. 升级/回滚支持策略明确不再覆盖该版本；
4. 冷启动迁移测试和真实升级证据表明旧 schema 数量为零；
5. 删除后仍能解释用户如何从最老受支持版本升级；
6. 单独创建维护任务和提交，不能夹在功能模块中。

没有匿名统计或真实线上证据时，不得声称“所有用户已迁移”。可以根据明确的最低支持版本政策删除 reader，但必须先把该政策写入发布说明，并提供分阶段升级路径。

---

# 第五部分：证据索引

## 7. 固定本地参考

| 用途 | 参考 |
|---|---|
| 当前唯一 renderer | `ts/desktop/src/main.tsx` 与当前 AppShell/ProductShell |
| 旧业务产品感、Composer、生图、视频 | `4fab121e:ts/desktop/renderer-react/` |
| 第 3/4 栏与底部终端布局 | `30945a22` 及 `da078a5f`、`0f28cf07`、`63623220`、`c2b1304b` |
| 视觉与信息架构参考 | `BilliardBuddy-frontend-restoration.html`；不作为 Oracle、母版、逐像素标准或第二施工依据 |
| ProductTask | `ts/shared/product/`、`ts/src/server/product/`、`ts/desktop/src/product/` |
| Media | `ts/shared/contracts/media.ts`、`mediaProjectService.ts`、`gateway/`、`relay/` |
| Core 指令与记忆 | `ts/src/utils/claudemd.ts`、`context.ts`、`attachments.ts`、`memdir/`、`SessionMemory/` |
| 当前 GUI→CLI 依赖 | `conversationService.ts`、`ts/src/entrypoints/cli.tsx` |

## 8. 外部资料的使用边界

外部文档只用于核验供应商/平台事实，不改变本文架构：

- OpenAI 图片模型与 rate limit：<https://developers.openai.com/api/docs/models>、<https://developers.openai.com/api/docs/guides/rate-limits>
- Seedream 模型能力：<https://www.volcengine.com/docs/6492/2172373?lang=zh>
- Electron 安全清单：<https://www.electronjs.org/docs/latest/tutorial/security>
- OpenAI Computer Use：<https://developers.openai.com/api/docs/guides/tools-computer-use>
- Anthropic Computer Use：<https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool>
- Google Computer Use：<https://ai.google.dev/gemini-api/docs/computer-use>

供应商宣传、静态模型表和代码注释都不能单独证明账号配额、真实 context window、点击质量、签名、公证或生产环境已生效。

---

# 结语：实施完成的唯一判断

实施完成不是“页面画出来了”“字符串删掉了”或“类型检查通过”。每个模块都必须同时证明：

```text
用户能做什么
+ 权威状态由谁写
+ 输入输出身份如何关联
+ 失败后停在哪里并如何恢复
+ 旧消费者何时迁完
+ 用什么固定 Oracle 判断对错
```

如果其中任何一项没有证据，该模块就没有完成，不得把缺口留给模块 25 或下一版产品。
