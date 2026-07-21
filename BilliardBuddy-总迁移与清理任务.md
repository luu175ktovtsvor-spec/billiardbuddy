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
- `[HARD]` 每个 Work Unit 只派一个拥有写权限的实施子代理，负责产出当前任务的完整代码变更；其他子代理只能做只读调查或对抗审查，不能并行写入。若子代理运行时可共享主工作树，它直接把未提交变更留在当前本地 `main`；若工具强制隔离，子代理只返回可机械应用的完整 patch，主代理可原样应用 patch，但不得自行设计、补写或调整产品代码。主代理必须先记录 `Base-Commit` 与开工前 `git status`，子代理不得触碰、清理或纳入既有修改。应用后由主代理复核范围、合同、diff、测试和未验证项。
- `[HARD]` 用户可见的开发流程不创建或保留临时分支/worktree/候选提交，不 cherry-pick；本地 `main` 是唯一串行施工线和 accepted 集成线。工具内部强制的临时隔离只用于生成 patch，结束即清理，不构成项目施工分支。文档中 ProductTask/worktree 指最终产品给用户的任务隔离能力，不是开发 AI 的 Git 工作方式。
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

实施子代理交付后，主代理只接受同时满足以下条件的 Work Unit：范围没有越界；当前已有消费者全部闭合；类型、协议、失败语义和测试一致；工作树中没有混入开工前修改；所有跳过的真实外部验证均明确记录。部分完成或阻塞不得伪装成 accepted commit。子代理把未提交变更留在当前 `main`，或在工具强制隔离时提供由主代理原样应用的 patch；主代理不能在应用时自行修产品代码。独立审查/验证通过后，主代理直接在 `main` 创建唯一 accepted commit。是否 push 仍由用户或既有发布授权决定。

每个 accepted commit 的标题必须带 Work Unit ID，例如 `feat(bb-07a): persist accepted message submissions`。commit body 是唯一跨窗口文字交接，必须包含：

```text
BB-Task: BB-07A
Module: 07
Module-Status: active | blocked | complete
Spec-Commit: <施工合同 SHA>
Base-Commit: <开工父提交 SHA>
Status: complete
Lease-Recovery: none | <接管证据>

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

### 0.8 一个主代理窗口负责一个模块

- `[HARD]` 一个模块从首次派工到模块完成，只能有一个主代理窗口作为 Module Owner。该窗口负责登记和依次完成本模块全部 Work Unit、派子代理、修合同、审查、验证和提交；不得让两个主代理窗口同时负责同一模块。
- 简单模块可以只有一个 Work Unit；复杂模块可以在同一主代理窗口内形成多个串行 accepted commit。上下文压缩不改变 Module Owner；窗口意外终止时，新的恢复窗口只能按第 0.9 节接管同一模块，不能另开平行实现。
- 模块状态固定为 `planned → active → blocked | ready_for_completion → complete`。`blocked` 必须立即写入 lease，包含阻塞原因、复现证据和恢复条件；若需要跨窗口接管，主代理还必须修订对应 Work Unit 登记并创建 Spec-Commit 记录阻塞，但不得提交部分产品实现或伪造 accepted commit。最近一个已完成 Work Unit 的 accepted commit 可预先写下一依赖导致的 `Module-Status: blocked`；无法预知的中途阻塞不追改历史 commit。
- 模块只有同时满足以下条件才成为 `complete`：所有登记 Work Unit 均有 accepted commit；模块卡全部 Oracle 与模块级纵向测试通过；交接物已进入 commit body/机器证据；工作树干净；没有未处理合同冲突；最后一个 accepted commit body 写入 `Module-Status: complete`、本模块全部 Work Unit SHA、Checks、Evidence、Known-Risks、External-Verification 和下一模块启动条件。
- 模块完成不创建空提交或额外 Markdown 报告。若最后一个 Work Unit 提交时尚不能满足模块完成条件，保持 `Module-Status: active|blocked`，通过原模块 repair Work Unit 补齐后，由该 repair commit 标记 complete。

### 0.9 本地 main 施工 lease、HEAD 与脏工作树

本地 `main` 是唯一施工线。每个 Module Owner 开工前必须以原子独占方式创建 `.git/billiardbuddy-construction-lease.json`；该文件不提交，字段固定为：`version/module_id/current_work_unit/window_id/active_writer_ids/base_commit/spec_commit/accepted_head/status/blocked_target_module/blocked_reason/acquired_at/heartbeat_at/preexisting_status`。每次启动/结束写入型子代理都必须原子更新 `active_writer_ids`；非 blocked 状态的 `blocked_target_module/blocked_reason` 固定为 null。

1. 取得 lease 前必须证明当前分支是 `main`、不存在其他 active lease，并记录 `git status --porcelain=v2 --untracked-files=all`。正常新模块只允许从干净工作树启动；发现用户修改、其他任务修改或来源不明文件时固定 `NO_START`，不得 stash、reset、clean、覆盖或顺手提交。
2. 新 Work Unit 派工瞬间必须满足 `HEAD == Base-Commit == lease.accepted_head`，且 `Spec-Commit` 是该 HEAD 可达的最新适用合同。任一不等立即停止，先由主代理解释新增提交/合同变化并更新 lease；不得让子代理在漂移基线上继续。
3. 子代理写入前后都检查实际修改路径。所有 diff 必须属于当前 Work Unit 允许范围；出现范围外修改立即阻塞，不能靠提交时排除来掩盖并发写入。
4. 每个 accepted commit 后，主代理确认工作树干净，再把 lease 的 `accepted_head/base_commit/current_work_unit/heartbeat_at` 原子更新到新 HEAD。模块 complete 后只在工作树干净且 HEAD 等于最后 accepted commit 时删除 lease。
5. 窗口异常退出留下 dirty tree 时，恢复窗口只能接管原模块：读取 lease、确认原 holder 已不存在、HEAD 等于 lease.accepted_head、diff 全部落在 current Work Unit 允许路径并通过补丁审查，然后写入新 `window_id`。任一项不能证明则 `NO_START`，不得猜测归属或自动清理。
6. 若 accepted commit 已创建但窗口在推进 lease 前退出，恢复窗口只能走 `committed_not_advanced` 分支：确认旧 holder 已不存在、工作树干净、`lease.accepted_head` 是 `HEAD` 祖先，且从该值到 HEAD 恰好一个提交；该提交的 BB-Task、Module、Spec-Commit、Base-Commit 与 lease/current Work Unit 全匹配并通过独立审查。满足后原子把 `accepted_head/base_commit` 推进到 HEAD；多提交、字段不符或范围越界一律 `NO_START`。
7. 若窗口在 `status=blocked`、工作树干净且 lease 已推进后退出，只允许 `clean_blocked_recovery`：恢复窗口证明旧 holder 已不存在、`HEAD == lease.accepted_head`、`active_writer_ids` 为空且经进程/任务清单确认没有仍运行的写入子代理；随后以原子 compare-and-swap 只接管同一 `module_id` 并更新 `window_id/heartbeat_at`。不得跨模块接管、直接删除 lease 或把 blocked 改成 complete；接管后的 Module Owner 才能按下一条执行 handoff。
8. active lease 不因时间到期自动抢占；heartbeat 只用于诊断，不能单独证明 owner 已死亡。若旧窗口或任一写入子代理可能仍在运行，新窗口不得写入。接管证据和 lease 的 `blocked/recovery` 变化进入下一 accepted commit body 的 `Lease-Recovery`；若最终未形成 accepted 产品提交，则进入后续 Spec-Commit/恢复登记，不能为记录 lease 状态创建空产品提交。
9. 模块 `blocked` 且必须让所属 repair 模块或模块 24 新候选先施工时，只允许受控 `blocked_handoff`：当前 owner 停止全部子代理并确认 `active_writer_ids=[]`，工作树干净，HEAD 等于 lease.accepted_head；主代理在本 Markdown 登记目标 repair/new-candidate Work Unit、阻塞证据与返回条件并创建 Spec-Commit，再把该控制提交及目标模块写入 lease。复核 holder 已退出且 HEAD 等于该 Spec-Commit 后才可删除旧 lease，由目标 Module Owner 从该 HEAD 申请新 lease。禁止直接删除/覆盖 lease；原模块恢复时必须重新申请 lease并消费 handoff 记录。

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
| `DEC-026` | `[HARD]` 桌面进程拓扑固定 | Electron Main 是本机唯一生命周期 owner，只启动一个 local sidecar server；server supervisor 按 TaskRun 启动短生命周期 agent-worker child；renderer 不启动进程；gateway/relay 是部署系统启动的远程服务；Chrome 启动独立 Native Messaging host。第二应用实例只向第一 Main 转交受控 intent 后退出，不连接或另启 sidecar |
| `DEC-027` | `[HARD]` MediaProject 迁库不复制或重绑 Asset | Asset 的出生 `owner_scope`、ID、route、hash 和 bytes 永久不可变；显式 transfer 只原子改变 MediaProject 的 library binding。历史引用保存 `{asset_id, asset_owner_scope}`，经项目授权读取；新 Operation/Asset 才归目标 library，不建立 library alias 或跨库枚举 |
| `DEC-028` | `[HARD]` VoiceService 是转写真相源 | `VoiceOperation`、`Transcript`、不可变 `TranscriptRevision` 由 VoiceService 唯一写入；Composer 与视频 Evidence 只保存同一个 `transcript_revision_id` 的受控 binding，不复制转写正文成为第二真相源 |
| `DEC-029` | `[HARD]` 项目指令冲突顺序固定但不重写自由文本 | 系统/工具/权限/安全合同永远优先；项目指令层内先按更近目录覆盖祖先目录，再按同目录 `BilliardBuddy.md > AGENTS.md > Claude 兼容源` 解释直接冲突。非冲突内容累加；resolver 保留来源和全部入选文本，不假装能对自由 Markdown 做结构化 merge |
| `DEC-030` | `[HARD]` D4 前必须通过未删除版本纵向闸 | 模块 22 accepted 后，模块 23 的首个 Work Unit 只能运行 `G22_PRE_D4_VERTICAL_GOLDEN_GATE`，不得删除代码；核心新链路在 legacy execution fail-fast 条件下通过后才允许首行 D4 |
| `DEC-031` | `[HARD]` 一个模块只有一个 Module Owner 窗口 | 同一主代理窗口从模块 active 持有到 complete；复杂模块在同一窗口串行完成多个 Work Unit；异常恢复只能持 lease 接管，不允许平行模块实现 |
| `DEC-032` | `[HARD]` 本地 main 施工必须持独占 lease | 开工时 `HEAD == Base-Commit == lease.accepted_head` 且工作树归属明确；脏树、HEAD 漂移、active lease 或无法证明的恢复一律 `NO_START`，禁止 stash/reset/clean 猜测处理 |
| `DEC-033` | `[HARD]` 所有进程/部署组件按单一兼容矩阵握手 | `component-compatibility-matrix.json` 是 Main、renderer、server、worker、gateway、relay、extension、native-host、provider contract 和 migration capability 的唯一版本兼容源；未登记或不兼容 fail-closed，不靠“版本接近”猜测 |
| `DEC-034` | `[HARD]` 所有重资源统一由 ProductResourceScheduler 准入 | worker、scheduled run、FFmpeg/ffprobe、ASR、视觉、图片生成、Browser batch、迁移与更新闸都先取得 typed permit；模块不得各建无关并发池或绕过全局内存/进程/字节预算 |
| `DEC-035` | `[HARD]` 发布默认 NO_GO 且必须 USER_ACCEPTED | 机器门禁全部通过只能形成冻结 Release Candidate；只有用户本人对同一 candidate identity 完成人工验收并写入绑定 hash 的 `USER_ACCEPTED` receipt，ReleaseDecision 才能从 `NO_GO` 变为 `GO`；任何候选变化立即失效 |
| `DEC-036` | `[HARD]` ProductTask 删除是可恢复状态机 | 只有已静止且无外部引用的 archived task 可进入 deleting；运行、队列、Schedule/Recruiting/Fork 引用先显式处理；删除按冻结 cleanup plan 幂等推进，失败进入 delete_failed，不删除 Workspace 或用户源文件 |
| `DEC-037` | `[HARD]` TaskAttachment 与临时文件有统一生命周期 | 外部文件只引用不删除；应用副本以 owner/ref graph 管理；草稿、失败、解析临时和 orphan 按版本化 TTL/profile 回收，禁止按路径前缀或 content hash 猜测所有权 |
| `DEC-038` | `[HARD]` 所有 Preview/解析/转码输入均不可信 | renderer/Main/worker 不直接解析；网页 Preview 无 Node/产品权限，文档/图片/媒体进入一次性无网络 sandbox；magic-byte、CSP/导航策略及 CPU/内存/页帧/解压/输出上限 fail-closed |
| `DEC-039` | `[HARD]` Workspace 身份与路径分离 | `workspace_id` 不变、canonical root 可变；每次文件操作复核根 identity/revision 和文件 hash；移动、外部替换、只读、断盘或 worktree 删除进入明确 unavailable/stale/relink 状态，不静默重绑 |
| `DEC-040` | `[HARD]` Relay 不是长期媒体库 | 输入/输出 blob 只按冻结 retention policy 加密短存；本地 durable asset ack 后有界清除，最长离线恢复 7 天；unknown 只保留脱敏 durable receipt 30 天并且绝不自动重放 |
| `DEC-041` | `[HARD]` 招聘原始证据短存且不进模型/诊断 | 原始 HTML/截图/完整简历/联系方式不进入持久 checkpoint、prompt、日志、记忆或诊断包；按 15 分钟/7 天/30 天分级 TTL，计划关闭与用户删除触发有界清除，视觉不明转用户接管 |
| `DEC-042` | `[HARD]` 更新成功必须达到健康启动里程碑 | 目标版本只在包/矩阵、sidecar 握手、存储读取和首个可交互 renderer 全通过后确认；10 分钟内连续两次未健康进入 recovery_required，回退受 rollback floor/schema 限制，否则只读恢复并导出 |
| `DEC-043` | `[HARD]` 用户诊断包严格 allowlist 且不自动上传 | Main 只在用户显式操作时导出版本、握手、短错误码、任务状态、resource profile 与脱敏日志；正文、绝对路径、附件、媒体、Cookie、密钥、候选人信息和原始 crash dump 永不进入 |

## 2. 术语、实体和唯一身份

### 2.1 普通任务实体

| 实体 | 含义 | 父实体 | 唯一写入者 | UI 是否显示 |
|---|---|---|---|---|
| `Workspace` | 稳定 `workspace_id` 与可变 canonical root；保存根 file identity、revision 和 availability | 安装实例 | ProductTaskService | 显示为“项目文件夹”及可用/重新关联状态 |
| `ProductTask` | 用户可见任务容器；保存独立于 TaskRun 的 lifecycle/revision | Workspace | ProductTaskService | 显示为“任务” |
| `TaskAttachment` | 草稿或已发送任务附件；外部安全引用或应用拥有副本，含 owner/ref/TTL/inspection 状态 | ProductTask/draft owner | ProductTaskService 写身份与 binding；AttachmentStore 只执行受控字节操作 | 显示名称、类型、大小和安全/清理状态 |
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
| `Evidence` | 与 source、时间范围、fingerprint、revision 绑定的结构化证据；转写证据只引用 TranscriptRevision | MediaProjectService |

所有 Asset 引用必须保存 `{asset_id, asset_owner_scope}`，不能只保存裸 `asset_id`。Asset 的 `owner_scope` 是不可变出生归属；MediaProject 转移 library 不改变历史 Asset、Version 或 Operation identity。

### 2.3 语音与转写实体

| 实体 | 含义 | 唯一写入者 |
|---|---|---|
| `VoiceOperation` | 一次受控音频转写意图；保存 installation、source owner/fingerprint、provider receipt、状态与 revision | VoiceService |
| `Transcript` | 一个 VoiceOperation 的稳定转写身份和当前 confirmed revision | VoiceService |
| `TranscriptRevision` | 不可变 raw 或 user_edited 文本/时间戳证据；含递增 revision、source fingerprint | VoiceService |
| `TranscriptBinding` | 消费者对某个 TranscriptRevision 的受控引用；kind 为 composer_draft、thread_entry 或 video_evidence | 对应消费者 service；只能写 binding，不能写 Transcript正文 |

Composer 和 MediaProjectService 只能通过 owner-checked binding 读取指定 `transcript_revision_id`；用户编辑必须创建新的 TranscriptRevision。已有 Composer/Video Evidence binding 不随 current revision 静默漂移。

`artifact` 只用于 UI 的“成果”投影；`output` 只用于外部响应字段，不能作为持久身份。

### 2.4 浏览器与招聘实体

| 实体 | 含义 | 唯一写入者 |
|---|---|---|
| `BrowserCapability` | observe/action/re-observe 的上层协议 | 协议，无持久状态 |
| `ChromeSessionBridge` | 本机单会话桥：Core/MCP Tool → request owner → Native Messaging host → BilliardBuddy Chrome Extension | 只保存短期 session/request 路由，不保存业务真相或 Cookie |
| `RecruitingPlan` | 门店、岗位、筛选条件和允许动作 | RecruitingService |
| `RecruitingBatch` | 一批候选人的可恢复处理单元 | RecruitingService |
| `BrowserCheckpoint` | 当前 batch 的页面版本、短期 ref hash、非识别性筛选结论和回读状态；不含原始候选证据 | RecruitingService 根据 bridge 回执写入 |
| `RecruitingEphemeralEvidence` | 原始 HTML、截图、完整简历、联系方式等 session-scoped 加密短期数据；不是业务真相 | Extension/bridge 临时区按 TTL 写入和销毁，不进入 RecruitingService 长期存储 |
| `RecruitingOperation` | 发送、标记、状态变更等副作用意图；正文只在 pending/unknown 有界加密保存 | RecruitingService |

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

`accepted` 的唯一含义是：ProductTaskService 已在同一个原子提交中持久化用户 ThreadEntry、TaskRun（含 immutable permission/provider snapshot）、`client_operation_id` receipt、首个 TaskEvent、durable dispatch record，以及请求中全部 `ready` TaskAttachment 到该 ThreadEntry/TaskRun 的不可变 binding。任何附件未 ready/owner 不符或任一写入失败都整体回滚，不返回 accepted，也不清空草稿。worker 不参与这个原子提交，且不得在提交成功前启动该 run。

提交成功后 dispatcher 可重复投递同一 `run_id`；agent-worker 必须用 run ID 和 dispatch generation 做幂等 claim。只有 claim 成功的 worker 可以创建/恢复 CoreSession 并把 `dispatch_pending → running` receipt 交回 ProductTaskService。服务在 accepted 后、投递前崩溃时，重启扫描 durable dispatch record；重复投递或 worker 重启不得创建第二 TaskRun、第二用户消息或自动重放外部副作用。

固定规则：

- 未收到 `accepted` 回执时只能显示“尚未发送”，草稿不能清空；
- `accepted` 后尚未被 worker claim 时显示“等待开始”，不得显示模型正在运行；
- 同一 `client_operation_id` 重放必须返回同一个受理结果；
- `stopping` 后等待 worker/Core 权威收尾；迟到 delta 不得进入已结束 run；
- 重连使用 `resume_cursor`，并以权威 transcript 对账缺失内容。

#### ProductTask 生命周期与删除

```text
active ↔ archived
archived → deleting → deleted | delete_failed
delete_failed → deleting | archived
```

1. `archive/restore/delete/retry_delete/cancel_delete` 均由 ProductTaskService 以 `client_operation_id + expected_revision` 写 durable receipt；renderer 不乐观删除。archive 只接受所有 TaskRun 终态、QueuedMessage 为空且无活动 PTY/Preview/worker 的 active task，否则 `TASK_BUSY`，不得隐式 stop 或隐藏运行任务；成功后禁止新 submit/enqueue/fork，但不删除正文或附件。
2. active task 不可永久删除；只有 archived 且所有 TaskRun 终态、QueuedMessage 为空、无活动 PTY/Preview/worker、无 Schedule/RecruitingBatch/ForkSource 等强引用时才能形成 immutable delete plan。存在引用返回 `TASK_DELETE_BLOCKED` 和逐项解除入口；不得隐式 stop、取消计划或删除 worktree。
3. 用户确认后先原子写 `deleting + cleanup_plan hash + fencing token`。随后按计划幂等清理 ThreadEntry/TaskRun/Event/queue/checkpoint、task-owned 应用附件副本和明确由该 task 创建且用户另行确认删除的 managed fork worktree；Workspace、用户源文件/源仓库、外部附件、共享 Asset 和被其他实体引用的副本永不删除。
4. 任一步失败进入 `delete_failed`，保留未完成 cleanup plan、失败项和重试入口；task 不从列表消失。删除采用两阶段：`deleting` 的可取消阶段只冻结引用并把正文、附件和 checkpoint 原子移入同一 owner-scoped 可恢复隔离区，不物理删除任何不可恢复 item；用户取消则完整原子还原。用户第二次确认关闭取消窗口并持久化 `purge_committed` 后才按 plan 物理删除，此后只能重试完成，不能回 archived。plan 对每项记录顺序、owner、ref count、recoverable/purged receipt；重启以同一 token/operation 续做，不重复副作用。
5. `deleted` 只保留无正文、无路径、无原始业务 ID 的短期 tombstone/receipt hash 30 天，用于幂等和同步删除投影，之后清除。所有 task-bound API 在 deleting/delete_failed/deleted 分别返回稳定 `TASK_DELETING/TASK_DELETE_FAILED/TASK_DELETED`。

#### TaskAttachment 与临时文件

```text
staged → inspecting → ready → accepted_bound
staged | inspecting | ready → failed | cancelled | discarded
```

1. TaskAttachment 记录 attachment/task/draft owner、source fingerprint、content hash、magic-byte verified media type、`external_reference|app_owned_copy`、byte size、state、ref graph、operation lease、created/last_activity/expires_at；ThreadEntry 不存二进制/Base64。
2. 外部引用只保存受控相对 route/identity/hash，永不删除原文件。应用副本先进入 owner-scoped staging，安全检查通过后原子 rename；相同 content hash 只可去重字节，不能合并 owner/ref identity。
3. 未绑定草稿附件自最后用户活动保留 7 天；failed/cancelled 的应用临时副本在 1 小时内清除；解析/转码临时目录在终态立即删，崩溃 orphan 最迟 24 小时后由 fenced sweeper 回收；accepted_bound 随 task 保留，永久删除时仅在 ref count 为零且 owner 可证时删除。
4. `attachment-retention-policy.json` 冻结单文件、每草稿/任务、installation 总容量、最小保留磁盘、TTL 和清理 batch。达到软上限先阻止新复制并提供按大小/年龄的用户清理入口；低于硬磁盘余量只允许清理/导出，不接受新附件。sweeper 只按 identity/lease/ref graph 删除，失败保留记录并退避重试，不递归猜路径。
5. 启动和每日 orphan scan 对账索引/字节/lease；不能证明 owner 的文件移入隔离清单而非删除。所有计时使用可注入时钟；policy 版本进入诊断和发布证据。

### 3.2 外部副作用与付费媒体

```text
draft
  → intent_persisted
  → submitted
  → running
  → succeeded

submitted | running
  → outcome_unknown
  → succeeded | confirmed_failed | result_expired | outcome_unresolvable

intent_persisted
  → cancelled_before_submit
submitted | running
  → cancel_requested
  → cancelled | outcome_unknown
```

固定规则：

- `outcome_unknown` 只能查询原 Operation；Relay 仍有 durable 查询证据时不得人为终结；
- `result_expired` 只表示 Relay 已知输出 blob 超过 7 天且本地从未 durable ack，`outcome_unresolvable` 只表示 Relay 的 30 天 resolution window 已结束仍无 terminal result；二者都必须由 Relay 当前签发、绑定 operation/owner/policy/server_time 的 idempotent terminal receipt 驱动。客户端 retention envelope/deadline 只用于 UI 预计与查询调度，任何 wall/monotonic clock 都不能自行终结付费 Operation。二者是不可重放终态，保留无正文解释并解除 transfer/update/delete 阻塞，但绝不等于 confirmed_failed或未扣费；
- 只有 `confirmed_failed`、上游确认未执行，或用户看见费用/不可恢复警告后对 `result_expired|outcome_unresolvable` 明确创建**新** Operation，才允许再次付费；系统永不自动重提；
- 网络恢复不自动发送、生成、删除、招聘沟通或执行终端命令；
- relay 的 `failed_unknown` 在 media adapter 归一为产品 `outcome_unknown`，不进入 renderer。

Relay 数据固定按 `relay-retention-policy.json` 加密保存并由模块 04 在首个可执行图片链路前实现、模块 14 生产化。Relay 在首次 accepted/submitted receipt 中返回签名 `retention_envelope`：operation/owner hash、submitted_at、blob expiry（7 天）、resolution deadline（30 天）、policy revision 和签名；MediaProjectService 必须与 Operation 原子持久化，缺失则不进入 submitted。该 envelope 只安排查询和显示预计期限，不能由本机时钟转换终态。输入/参考 blob 在 provider durable receipt 落库后立即清除，失败时最迟 24 小时；输出 blob 在 owner-scoped 本地 durable Asset ack 后立即清除，桌面离线时最多保留 7 天；terminal 脱敏 audit 最多 30 天。Relay 在整个 30 天 resolution window 内保留最小 expiry facts或确定性重建 receipt；第 7 天后查询返回当前签发的 `result_expired` terminal receipt。第 30 天后客户端即使长期离线，也可在原 Operation 查询中提交原始 signed envelope；Relay 无状态验证自身签名、operation/owner/policy 和当前 server time 后签发 `outcome_unresolvable` terminal receipt，不需要继续保存 blob、provider ID、正文或 PII。客户端只有验证 terminal receipt 的签名、owner、operation 和单调 Relay server_time 后才落终态；Relay 不可达、时钟前跳/回拨、签名异常时保持 `outcome_unknown` 和全部阻塞，不允许新付费 Operation。Relay 不是历史图库，不能把过期推断为 confirmed_failed 或自动重提。

所有 blob 使用独立服务端加密密钥和 owner-scoped route；renderer 不能伪造 durable Asset ack。用户删除本地 MediaProject/Asset 时，经 MediaProjectService durable delete intent 向 Relay 发送幂等 purge，仍受 unknown 对账约束；purge sweeper 使用 typed claim/lease/fencing。到期或用户 purge 失败保留 `purge_failed` 元数据并告警/重试，不能先标已删；policy revision/hash 进入 Relay deployment manifest、component matrix 和 Release Candidate。

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

### 4.1 路径、Workspace 与归属

- 所有 task、附件、Diff、Preview 和 PTY 路径绑定稳定 `workspace_id`，不把绝对路径当身份或授权。Workspace 保存 mutable `canonical_root`、平台根 file identity（volume + file ID/inode 等价物）、`workspace_revision` 和 `available|missing|read_only|identity_changed|relink_required`；媒体路径绑定 MediaLibrary/Asset immutable owner；语音源绑定 installation + source owner。统一拒绝 `..`、符号链接逃逸、跨 worktree/owner、任意 `file://`、Windows UNC/盘符越界和大小写混淆。
- 每个文件读写、Diff、Preview、PTY create/write 和 worker 工具边界都重新 realpath，核验 root identity/revision、owner 和目标 file hash；watcher 只用于提示，不能授权。外部单文件变化返回 `FILE_STALE` 并要求刷新；根消失/断盘/只读返回 `WORKSPACE_UNAVAILABLE|WORKSPACE_READ_ONLY`，写操作停止且不换路径。
- 同卷移动且根 file identity 未变时，用户确认的 `workspace.relocate(client_operation_id,expected_revision)` 可原子更新 root/revision。跨卷复制、根被替换、identity 无法证明或 managed worktree 被手动删除时进入 `relink_required`；用户只能明确重绑或创建新 Workspace，不能自动猜目录。Git workspace 额外核验 repo/worktree common-dir 与 HEAD identity；非 Git workspace 使用根 identity + 用户确认，绝不伪造 Git 语义。
- Workspace revision/identity 改变时，活动 TaskRun 的后续文件副作用、Preview selection、Diff reference 和 PTY 固定 `WORKSPACE_STALE`；只读 transcript 仍可查看。managed fork worktree 丢失标 `WORKTREE_MISSING`，保留 task/checkpoint 并提供重新创建或解除引用，不能重建后假装是同一 worktree。
- Asset 原始 route 只按其 immutable `asset_owner_scope` 授权。迁库后的项目读取历史 Asset 时，必须先校验请求者拥有当前 MediaProject，再校验当前 Version/Evidence 显式引用同一 `{asset_id, asset_owner_scope}`；禁止凭 source Asset ID 跨库枚举。
- 外部导入的视频、图片、音频和用户项目文件永不因删除 ProductTask/MediaProject 被删除；只删除应用明确拥有且能由身份链证明的副本。
- 所有 policy 文件都必须由所属 registry 生成并有 schema/version/hash：模块 01 冻结结构；attachment 由模块 07 填充本机 retention/capacity 值，content safety 由 03/07/10/16 共同消费的受控 benchmark/profile 填充，Relay retention 由 04 定义最低合同、14 填充生产部署，diagnostic allowlist 由 21 填充。未登记/过期 policy fail-closed，不允许 renderer 或远程 flag 覆盖。
- 正式桌面 sidecar 必须有每次启动生成的鉴权会话；不能仅依赖 loopback 或“ID 难猜”。

### 4.2 多窗口和单写者

- ProductTask 与媒体 mutation 都携带 owner、`client_operation_id` 和 `expected_revision`；冲突返回显式错误，不静默 last-write-wins。
- 同一媒体数据根最多一个 sidecar 写者，启动时取得跨进程锁；进程内 Promise 锁只能证明单实例串行，不能作为跨进程证据。
- 更新、退出和休眠前停止新后台写入，在有界时间内完成或留下 durable intent，重启后对账。

### 4.3 日志、隐私与用户诊断包

普通日志不得记录：密钥、Authorization、Cookie、完整提示词/附件正文、截图/Base64、录音、候选人联系方式、完整 URL query、绝对用户路径或环境变量。开发诊断只记录脱敏 scope、operation ID hash、状态、耗时和短错误码。

`DiagnosticBundleService` 只运行于 Electron Main。用户在设置/About 显式选择“导出诊断信息”和目标路径后才生成，绝不自动上传或调用支持端点。机器可读 `diagnostic-bundle-policy.json` 使用严格 allowlist：app/candidate/component matrix 版本/hash、组件握手 selected version/reason、ProductTask/Operation 的状态计数与短错误码、resource profile revision/聚合用量、脱敏 migration/update manifest、stack fingerprint，以及最近 7 天且总计最多 5 MiB 的结构化脱敏日志。

每个包使用随机 salt 对 task/run/operation/installation ID 做 HMAC，使包内可关联、跨包不可追踪。永久排除聊天/提示词/ThreadEntry、工具 JSON/命令正文、绝对路径、附件/文档/媒体/HTML/截图/音频、简历/候选人字段、Cookie/Authorization/密钥/环境变量、URL query、原始日志和 crash dump。生成采用 allowlist schema，再做 deny-pattern/canary 二次扫描；任一字段或文件不合规即 `DIAGNOSTIC_REDACTION_FAILED`，删除 staging，不输出半包。成功包含 policy/schema revision、included file SHA-256、excluded counts 和 bundle SHA-256；应用不自动删除用户选定的最终包。

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

默认在当前本地 `main` 串行推进 accepted Work Unit；任何时刻最多一个写入型实施子代理，其他子代理只能只读调查或审查。共享合同、迁移、清理和发包同样串行。主代理必须记录并保留开工前已有修改，不得让子代理覆盖、提交或清理不属于当前 Work Unit 的文件。用户不需要创建、切换或合并施工 worktree；工具若强制临时隔离，只把子代理 patch 原样落到 `main` 后立即结束隔离。最终产品功能本身需要的用户 worktree 仍按模块 09 合同实现。

### 4.8 进程、部署、启动与鉴权拓扑

```text
用户设备（每个 OS 用户 / installation）
└─ Electron Main【唯一桌面生命周期 owner】
   ├─ requestSingleInstanceLock；第二实例只转交受控 task/deep-link intent 后退出
   ├─ 拥有 userData/config root、installation_id、产品 secret、更新器和 OS 能力
   ├─ spawn exactly one：统一 BilliardBuddy sidecar binary `server` mode
   │  └─ Local Product Server【ProductTask/Media/Voice/Recruiting/Schedule/Migration 领域数据的唯一写入宿主】
   │     ├─ loopback HTTP/WS：ProductTask、Media、Voice、Recruiting、Schedule
   │     ├─ 校验 Main 在 spawn 前生成的 server_generation + 随机 local capability
   │     ├─ Session Supervisor
   │     │  └─ 按已持久化 TaskRun spawn：同一 sidecar binary `agent-worker` mode
   │     │     └─ CoreSession / Tool loop；用一次性 run capability 回连 server
   │     └─ HTTPS + managed app credential → Public Gateway
   ├─ 受控 preload IPC → Renderer【无 Node、无产品 secret、不能 spawn】
   │  └─ 携 Main 发放的当前 generation capability 调 local HTTP/WS
   └─ 安装/更新 Native Messaging manifest；不常驻启动 Chrome host

Chrome（用户启动、独立生命周期）
└─ BilliardBuddy Chrome Web Store Extension
   └─ 按需启动 Native Messaging host
      └─ BilliardBuddy sidecar binary `native-host --app-root …`
         └─ 本地 user-only socket/pipe → ChromeSessionBridge → Core MCP Tool

远程部署（不由 Electron 启动）
Public ingress/TLS
└─ Gateway【部署系统/systemd 启动；desktop app credential 鉴权、策略与路由】
   ├─ DeepSeek / MiMo / Fun-ASR / 图片 provider
   └─ 独立 service credential + owner → Relay【部署系统启动；图片异步任务/结果】
```

固定生命周期与鉴权：

1. Main 只启动/停止一个 server mode sidecar；renderer、第二实例、agent-worker 和 Native Messaging host 都不能另启 server。生产环境禁止绕过 single-instance lock；测试绕过必须使用隔离 data root。
2. 第二应用实例不读取 sidecar URL/capability，不连接 sidecar或共享数据根；它只经 Electron single-instance channel 向第一 Main 发送 schema 校验后的 task/deep-link intent，然后退出。第一 Main 决定打开/聚焦窗口。
3. Main 在 spawn server 前生成唯一 `server_generation` 和随机 local capability，只经一次性私有 bootstrap pipe/继承 FD 交给 server；禁止使用环境变量、argv、URL、文件或日志传递。server 完成握手后关闭 bootstrap FD，任何 child 都不能继承。Main 只通过受限 preload IPC 向可信 renderer 发放当前 generation capability。`/api/*`、`/proxy/*` 和 ProductTask WS 强制校验；CORS/loopback/端口难猜都不是鉴权。`/health` 只返回最小无敏感状态。server 启动失败或退出时该 capability 立即失效。
4. server supervisor 只能为已 accepted 的 TaskRun 启动一个 worker child；worker spawn 使用显式环境 allowlist 和 close-on-exec FD，只注入独立、一次性、短期 run capability。worker 环境、argv 和可继承 FD 中必须证明不存在 renderer local capability、产品 secret 或 updater token；server 退出先停止全部 worker。
5. 模块 03 的 `agent-worker` 是统一 sidecar binary 的内部 mode/entry，不是另一个监听端口、常驻 daemon、公开 CLI 产品或第二数据写入者。模块 03 完成前当前 `cli --print` child 是 `[FACT]` 兼容现状，迁移后必须由 `agent-worker` mode 替代。
6. Main 与 Local Product Server 不互写领域存储：sidecar services 只写 ProductTask/Media/Voice/Recruiting/Schedule/Migration 数据；Main 只写隔离的 installation/bootstrap config、UpdateTransaction、PTY session 元数据和 OS capability 状态。各自使用独立路径；Main 不直接打开领域数据文件，sidecar 不写 updater/PTY/bootstrap 状态。正常 sidecar writer、migration coordinator 和 recovery reader 必须竞争覆盖全部领域根的同一个跨进程 `DomainDataLease`，带 mode/generation/fencing；`writer|migration|recovery_read_only` 互斥，任何 holder 恢复都校验 token。
7. Native Messaging host 固定为统一 sidecar binary 的内部 `native-host` mode，由 Chrome 按需启动；不与公共 CLI/TUI 或 TaskRun worker 共用 entry、stdin/stdout、session 或 capability。模块 23 可删除全部 public CLI/bin/help/publish surface，但必须保留不可交互的 `native-host` 内部 mode。Extension/host 未握手只降低 BrowserCapability，不影响 local server。
8. desktop app credential 只证明受管理客户端，在 Gateway 做轮换、撤销和限流；`X-QF-Client-ID` 只作公平调度/owner，不赋权。Gateway → Relay 使用不同的 service credential，relay owner 只能由 Gateway 派生。上游 key 只在 Gateway/Relay，renderer/worker/本地持久化均不可读取。
9. Gateway、Relay、public ingress、路径 rewrite、TLS、secret 注入和 service unit 的交付责任固定：模块 04 冻结 gateway/ingress/service identity 与非图片 provider 部署 manifest；模块 14 冻结 relay/图片路由、容量、owner、secret 与 service unit manifest；模块 24 只消费并核对其版本/hash，不临时补建远程拓扑。开发模式可使用 Vite renderer 和本地构建 sidecar，但拓扑、鉴权、owner 和协议必须与 packaged 一致。
10. 所有 PDF/DOC/Office/HTML/图片/音视频/压缩包的检查、文本抽取、缩略图、probe 和转码都在一次性 extractor child 中执行，不在 Main/renderer/agent-worker 进程直接解析。child 只取得只读输入 FD 和空 owner-scoped 输出目录，无网络、无产品 secret/local capability、无 workspace 写权限、无 shell/再 spawn，使用最小环境与 OS 资源限制；平台无法证明隔离时返回 `SANDBOX_UNAVAILABLE`。
11. 网页 Preview 使用独立 session/partition 和 sandboxed WebContents：`nodeIntegration=false`、`contextIsolation=true`、sandbox 开启。selection picker 完全驻留 isolated preload/world，不向 page world 暴露 `contextBridge` API、DOM event、capability 或可枚举产品 IPC；只有可信 picker overlay 捕获的 `event.isTrusted` 用户手势才能发起。capability 绑定 webContents/document/navigation/frame/task/workspace revision，单次消费且短期；页面只提供被读取的受限 DOM 数据，不能主动调用 bridge。页面自身脚本只能在隔离分区内运行并访问用户明确启动的本机开发 origin；wrapper CSP/permission policy 拒绝插件/object、混合内容、未登记远程 origin 和权限升级。新窗口、外部导航、下载、权限请求、自定义协议、`file:`/`javascript:`/`data:` 顶层导航全部拒绝或交给系统浏览器；页面不能访问 Electron/clipboard/文件系统/产品 IPC。
12. `content-safety-profile.json` 由模块 01 冻结 schema、模块 03执行，至少包含 magic-byte allowlist、源/解压/entry/嵌套/页/帧/像素/字符上限、CPU/wall time、memory、temp/output bytes。压缩内容不递归执行；宏、脚本、可执行/未知二进制只显示元数据。profile 缺失/过期固定 `CONTENT_PROFILE_REQUIRED`；畸形、超限或 extractor 崩溃只隔离该输入并清理临时目录。FFmpeg/ffprobe/文档解析器不能绕过 Scheduler 或这些上限。

### 4.9 D4 前纵向验证闸

`G22_PRE_D4_VERTICAL_GOLDEN_GATE` 是模块 22 accepted 后、模块 23 首个物理删除前的共同硬闸。它在 legacy 源码仍在但其 execution entry 被 fail-fast 的条件下，使用实际 renderer、IPC、local sidecar、ProductTask/Media/Voice/Recruiting service、agent-worker 和公开合同运行；外部 provider/Chrome 可使用受控 fake adapter，但不得用直接 service 单测或 mock 新链本身替代。

闸必须在干净数据根和升级 fixture 数据根各运行一次，覆盖：首次任务 accepted/stream/stop/重连、worker 崩溃与重复 dispatch、default→Workspace 媒体 transfer、Composer/视频共享 TranscriptRevision、图片/视频 partial/unknown/恢复、招聘 approval→intent→action→reobserve、支持矩阵旧数据升级。empty、loading/slow、offline、conflict、partial、failed、restoring 都必须有机器断言。

Gate 通过只授予 `LOCALLY_VERIFIED` 和“允许开始 D4”，不等同 D5、安装包、签名或真实外部验证。每个 D4 Work Unit 后必须重跑受影响旅程；模块 24/25 仍分别执行 packaged/final 黄金旅程。证据进入机器可读 manifest 和测试输出，不新建 Markdown 报告。

### 4.10 组件版本兼容矩阵与握手

`component-compatibility-matrix.json` 是唯一兼容事实源，由构建/部署流水线从各组件 registry 生成，禁止手写平行版本。最小字段固定为：

```text
matrix_schema_version
matrix_revision
release_id
candidate_id
minimum_supported_release
components[]:
  component_name
  artifact_version
  build_id
  platform / arch
  protocols[{name, supported_ranges[{major, min_minor, max_minor}]}]
  capabilities[] / required_capabilities[]
  consumes[] / produces[]
  schemas[{storage_id, current, min_readable, min_writable}]
model_catalog_revision
rollout{accepts_release_range, rollback_floor, retire_after}
```

`artifact_version`、不可变 `build_id`、协议版本、持久化 schema、capability contract 和 model catalog 必须分别编号，不能用一个“版本号”代替。

1. Main 在加载 renderer 前校验安装包内 Main/renderer/sidecar 的 release/build/hash 属于同一 candidate；随后调用带 local capability 的 `/health/compatibility`。每个 protocol offer 必须按 major 分列完整 minor 闭区间；双方求完整版本集合交集，按确定规则选择最高 `(major, minor)` tuple，并在握手 receipt 回传 selected version。交集为空、range 非法/重叠歧义、缺字段、未知 major、required capabilities 不全或 build/candidate 不匹配，固定显示 `COMPONENT_INCOMPATIBLE`，Main 不向 renderer 开放 server URL/产品 IPC，也不继续空壳 UI。fixture 必须覆盖同 major minor 上限不相交、跨 major、缺字段和未知 major。
2. Renderer REST/WS 在业务消息前提交自身 `renderer-api/product-task-ws` offer，server 对连接返回 selected protocol/capabilities 与兼容 receipt；拒绝连接时不发送业务数据、不回退旧 endpoint。server→worker 的 hello/ready、Extension→native-host→bridge 的 hello、Gateway/Relay service handshake 使用同一逐-major 完整交集和确定性 selected-version 算法。
3. Gateway/Relay 启动必须带 `release_id/build_id/matrix_revision`；Gateway 先与 Relay 协商 `relay-image-task`，不兼容时图片能力为 unavailable 且不提交任务。sidecar 在创建 CoreSession 前取得 Gateway capability snapshot，含 gateway API、model catalog revision、每个模型 modality/tool/window/status；未知模型或能力不符返回 `UNSUPPORTED_MODEL`，绝不默认 Qwen或旧 provider。
4. Extension 在任何 tool request 前发送 extension version/build/protocol range/capabilities；native-host 只接受矩阵登记且协议相交的 extension ID/build。Extension 作为外部商店伴随组件若尚无受控 artifact/hash，矩阵把 BrowserCapability 标 unsupported；不能假定商店最新版兼容。
5. `legacy-support-matrix.json` 是数据迁移子矩阵，并由 component matrix 引用其 revision/hash。只执行显式 `from → to` 幂等迁移；future schema、downgrade 或不可读数据 fail-closed 并保留原始快照，不初始化空数据。writer 提升前必须存在兼容 reader。
6. 远程滚动顺序固定：先发布同时接受 N-1/N 的 Gateway/Relay reader，再发布 Desktop N；观测窗口结束且仍有回滚路径后才能提高 minimum supported release。回滚只能到 `rollback_floor` 以上且可读取当前 schema 的版本，否则停止写入并前进修复。
7. 模块 01 定义矩阵 schema；02/03/04/12/15/18/22 分别登记领域协议、worker/provider、数据和浏览器条目；14登记 Relay；24生成候选矩阵并验证所有 artifact/deployment manifest hash；25验证运行时握手。矩阵任一 required edge 没有双向 fixture/包内握手证据，候选 `NO_GO`。

### 4.11 ProductResourceScheduler 全局资源合同

所有会排队、启动、恢复、取消或独占重资源的工作，必须先调用统一合同 `ProductResourceScheduler.submit(claim)`；Cron、Media、Browser、worker、迁移和更新不得各自保留第二套无关调度真相。统一是指资源 key、claim、状态码、公平、预算、lease/fencing 和快照一致；不是错误地跨机器共享一个内存对象。权威 scope 固定为 `desktop-host`、`gateway-account`、`relay-account`，跨 scope 只传幂等 claim/receipt。

资源 key 至少包括：

```text
agent.worker / agent.turn / schedule.dispatch
browser.session / browser.batch
media.ffprobe / media.ffmpeg.encode / media.local-io
content.inspect / content.extract / content.thumbnail / storage.attachment-temp
gateway.ingress-bytes / gateway.mimo.vision / gateway.funasr
relay.image.openai / relay.image.seedream / relay.input-bytes / relay.blob-disk
storage.migration / app.update
```

1. Claim 固定包含 job/owner/idempotency/scope、全部资源及单位、memory/input/temp/output byte budget、priority、deadline、cancel mode、resume policy 和 profile revision。多资源必须按稳定 key 排序做全有或全无的原子预留；拿不到全部就不占任何 permit。队列只存元数据和持久 blob reference，不存图片/音视频正文。
2. 优先级固定 `interactive > recovery > scheduled > batch/prefetch`；同级按可信 owner 轮转，owner 内 FIFO，使用可注入单调时钟、全局 enqueue sequence 和固定 aging 防饥饿。owner 分别来自 installation+task/run、gateway auth+installation、Gateway 派生 relay owner，客户端 ID 不赋权。
3. 每个 profile 固定 `maxActive/maxQueued/maxActivePerOwner/maxQueuedPerOwner` 及字节预算。没有已验证 profile 或 profile 过期/toolchain 不匹配时，重资源固定 `PROFILE_REQUIRED`，不猜并发。单例生命周期锁可固定 active=1/queued=0；本机 profile 只能由内存/磁盘/CPU/GPU和受控 benchmark 生成，上游模型/付费配额必须来自运维配置与真实账号证据。
4. 在读取/解码每个 chunk 前预留 ingress bytes；memory、input、temp disk、output 分开记账。完成、取消、超时、崩溃和 lease 失效都必须恰好释放一次。queued 可直接取消；running 进入 cancelling 并传播 AbortSignal；已提交付费上游且取消结果不明固定 outcome_unknown。
5. Scheduler lease 带 owner、process generation、heartbeat、expiry 和 fencing token；状态写入必须验证 token，旧进程恢复后不能覆盖新 owner。计划任务每个 occurrence 有稳定 ID 并原子 claim，任何重启/回拨/多 tick 至多执行一次。
6. 休眠先停止 dispatch 并持久 checkpoint/lease；唤醒按 generation 恢复，只有幂等且未进入未知付费阶段的 job 可自动继续。迁移和更新先进入 `draining → checkpoint/cancel → quiesced`，再申请独占 lifecycle permit；截止时间内不静止则 blocked，不能直接 kill sidecar 安装。
7. 快照统一输出 active/queued/bytes/oldest wait/owner rejects/profile revision/lease owner，以及 `ready/degraded/overloaded/draining/maintenance` 和稳定原因码：concurrency、queue、bytes、owner quota、profile missing、maintenance、upstream unavailable。UI、API、Gateway 和 Relay 使用同一产品枚举。
8. 模块 03 建 desktop scheduler 基础和 worker claim；04 建 Gateway account executor，并在模块 13 前建立 Relay account 的图片付费任务准入基础；12/13/14/15/16/17/18 迁移媒体、图片、语音、计划和浏览器消费者；14 只强化 Relay 五分钟链路、容量 profile 与部署可靠性，不再后置创建 scheduler 真相；22/24 只申请 migration/update lifecycle claim。旧私有队列在模块 23 D4 前消费者归零。
9. 验收使用 fake clock、可控 executor 和双进程 fixture，证明所有上限不越界、多资源无死锁、取消/超时/重启无泄漏或双释放、两个 scheduler 不重复 occurrence/付费任务、owner 公平、无 profile fail-closed，以及 sleep/update/migration 对运行 worker、FFmpeg和 outcome_unknown 的正确处理。不得 mock 掉 Scheduler 本身。

### 4.12 Release Candidate、Go/No-Go 与 USER_ACCEPTED

发布初始且默认状态永远为 `NO_GO`。Tag、`workflow_dispatch`、聊天确认、实现者自述、环境变量或单一布尔值都不是发布授权。

1. 模块 24 只能构建不可变候选，不得更新正式 feed。候选身份固定为 `candidate_id + source_commit_sha + source_tree_sha + lockfile_sha256 + build-input/package-manifest/gate-policy/release-checklist/component-matrix/attachment-retention/content-safety/relay-retention/diagnostic-bundle-policy digest + sorted artifacts[{platform,arch,filename,sha256}] + build run/provenance digest`；两个平台 artifact 的有序集合共同定义一个 candidate，不能把每个平台误建成同 ID 的不同身份。`source_commit_sha/source_tree_sha` 固定为模块 24 构建候选时的已接受源码基线；候选形成后、GO 前，任一候选输入、源码树、字段或重新构建产物变化都产生新 candidate，旧 gate 和验收失效。gate report 是对该身份执行检查后的不可变结果，不参与生成 candidate ID，但其 digest 必须进入 USER_ACCEPTED receipt；gate/checklist 结果变化要求重跑全部关联检查并生成新 gate report，不能修改旧 report。
2. 版本化 `release-checklist.json` 每项包含 check_id、module、required、platform、candidate input、确定命令/人工步骤、PASS 条件、证据路径和 owner（machine/user）。结果仅 `PASS|FAIL|NOT_RUN|UNVERIFIED`；任何 required 项不是 PASS、证据 hash 不符、已知阻断测试、兼容矩阵 required edge 失败或 release policy 缺失，ReleaseDecision 固定 `NO_GO`。
3. 外部项在候选创建前由版本化 policy 分类：`REQUIRED_FOR_RELEASE` 或 `OUT_OF_SCOPE_DISABLED`。前者未真实验证即 NO_GO；后者必须证明该候选已编译/配置禁用对应入口并向用户明确，不允许候选生成后临时豁免。`NOT_VERIFIED_EXTERNALLY` 不等于 PASS。
4. 机器门禁全 PASS 只得到 `GO_READY_FOR_USER`。模块 25 向用户展示同一 candidate 的安装包、双平台核心旅程、视觉/交互、迁移、性能、已禁用范围和风险清单；用户拒绝产生 `USER_REJECTED` 并终结该 candidate，不能靠重跑局部检查复活。
5. `USER_ACCEPTED` 是受保护发布环境写入的不可变 receipt，不是聊天文本。最小字段：schema/acceptance ID、decision、完整 candidate identity/digest、checklist/gate report/component matrix digest、各人工 check 的 `PASS|FAIL|NOT_RUN|UNVERIFIED` 与证据、被授权用户 identity/role/auth source、accepted_at/expires_at、签名/受保护 provenance。只有所有 required machine/user check 均为 PASS 时 decision 才可为 USER_ACCEPTED。只有用户本人可触发，CI/主代理/发布 workflow 不能自行创建或伪造。
6. 新候选源码/树/lockfile/build script/artifact/hash/checklist/policy/matrix/gate result 任一变化、receipt 到期或受控撤销，立即使 USER_ACCEPTED 失效并回到 NO_GO。只追加发布审计记录、不改变 candidate 输入与产物的 release-record commit 不重定义 candidate，但必须绑定已经验证的 `source_commit_sha/source_tree_sha`，且不得进入该候选安装包；撤销记录 actor/time/reason。USER_REJECTED 必须创建新 candidate 才能重试。
7. 只有 Release Orchestrator 在正式发布前重新验证：candidate 全 hash 未变、全部 required gate PASS、receipt 有效且 decision=USER_ACCEPTED，才可写 `GO` 并原子切换正式 manifest/feed。发布 workflow 只能读取证明，不能生成证明或通过参数覆盖失败。上传前再次计算 artifact SHA-256。
8. 模块 24 负责 candidate、provenance、component matrix、机器 gate 和 `NO_GO|GO_READY_FOR_USER`，不能发布；模块 25 负责人工验收编排、receipt 验证、唯一 ReleaseDecision 和正式 feed 切换。当前 tag/manual 直发路径由 `BB-23L` 先完成 D1/D2 consumer 迁移、再 D4 删除旧脚本/权限；模块 24/25 必须消费该 Manifest 的 D4/D5 证据并验证无旁路。

---

# 第二部分：模块依赖与交付阶段

## 5. 阶段与依赖图

```text
阶段 A：冻结基础合同
  01 单一基线
  01 → 02 ProductTask 身份、revision 与事件合同
  02 → 03 内部 agent-worker
  03 → 04 模型、Gateway 与 Relay 图片准入基础
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
  04 + 06 + 12 → 13 图片工作台（消费模块 04 的 Relay 图片准入基础）
  04 + 12 + 13 → 14 图片可靠性、容量与五分钟链路
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
  01—22 → 23.A `BB-23A / G22_PRE_D4_VERTICAL_GOLDEN_GATE`（只验证，不删除）
  23.A → 23.B+ 死运行时与依赖物理清理
  01—23.B+ → 24 双平台发包、签名与自动更新
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
5. `release-checklist.json` machine/user owner、component compatibility、legacy support、attachment retention、content safety、Relay retention、diagnostic bundle policy 的 schema 与版本/hash 都在模块 01 冻结机器入口；模块 01 只定义结构/生成入口，不猜后续容量或协议值，分别由所属模块填充证据。
6. 记录所有候选删除对象的当前消费者，交给模块 23 的物理删除 Manifest；本模块不做跨域物理删除。

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
| 组件兼容/发布检查 schema | 生成器 + schema fixture | artifact/build/protocol/schema/capability 分开；required edge 与 check owner 可机器校验，不含手写平行版本 |

### 交接物

`single-product-baseline.json`、`legacy-support-matrix.json`、`component-compatibility-matrix` schema 和 `release-checklist` schema（或等价机器可读 manifest）保存入口、消费者图、支持范围与版本/发布检查结构；文字说明进入 accepted commit body，不新建 Markdown 报告。

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
2. submit 使用单个 ProductTask 原子写入边界，同时持久化用户 ThreadEntry、TaskRun immutable snapshot、`client_operation_id` receipt、首个 TaskEvent、durable dispatch record 和全部 ready TaskAttachment binding；任何一项失败整体回滚且不返回 accepted。TaskRun 在 worker 启动前已经存在，worker 只 claim，不创建产品 run。
3. 所有副作用 mutation 接受 `client_operation_id`，并返回 `accepted | duplicate | conflict | rejected` durable receipt；accepted 只在第 3.1 节原子写入提交后返回。
4. TaskEvent 增加 `event_sequence`、`task_id`、必要的 `run_id`；WebSocket 支持 `resume_cursor`。
5. list/detail 的本地请求版本只用于避免迟到 UI 覆盖，不得冒充服务端 revision。
6. 定义少量产品错误码：revision conflict、owner mismatch、not found、storage unavailable、unsupported schema、operation unknown。
7. 协议、通知和第二实例只转交受控 task ID/action，不接受任意路径、URL 或命令。
8. 旧 ProductTask schema 的读取适配器和 fixture 由本模块随新 schema 一起定义并测试为 `D3_LEGACY_READ_ONLY`；只允许覆盖模块 01 `legacy-support-matrix.json` 已登记范围。ProductTask v2 必须先补成功迁移、写回 current、二次运行幂等 fixture 才能从 provisional 升为 supported；模块 22 只调用 adapter 做统一编排，不得重新推导字段映射。
9. 定义并实现第 3.1 节 ProductTask lifecycle/delete plan/tombstone：busy、queue、Schedule/Recruiting/Fork/worktree 引用阻塞，`delete_failed` 可重入且不隐藏 task；模块 02 只删除 task-owned 产品数据，不删除 Workspace、源文件或外部副本。
10. 定义 Workspace immutable ID、root identity/revision/availability 与 relocate/relink receipt；path-only 历史记录不能自动授权。定义 TaskAttachment identity/state/ref graph/retention binding，具体 ingest/sweeper 由模块 07 消费。

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

- archive/restore/delete fixture 覆盖 active run、queue、Schedule/Recruiting/Fork/worktree 强引用阻塞，删除中崩溃、delete_failed 重试、重复 delete 和 tombstone TTL；Workspace/源文件/共享附件始终存在。
- delete 两阶段 fixture 覆盖附件/正文/checkpoint 已进可恢复隔离后取消能完整还原；`purge_committed` 前无物理删除，之后任何失败只可重试，不能恢复成缺附件的 archived task。
- Workspace fixture 覆盖同卷 rename 自动识别后用户确认 relocate、跨卷 copy/root replaced/relink、只读/断盘、两窗口 revision conflict；旧引用不能落到新根。
- TaskAttachment 与 submit 同一原子边界：任一未 ready 或 binding 写失败均无 ThreadEntry/TaskRun；重复 operation 不产生第二 binding。

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
7. 建立 desktop-host `ProductResourceScheduler` 基础：typed claim、持久队列、priority/owner fairness、resource profile、multi-resource atomic reservation、lease/fencing、byte accounting、cancel/drain/snapshot。所有 worker start 和 schedule dispatch 先取得 scheduler receipt；本模块迁移现有 GUI/定时 worker 消费者，不保留 fire-and-forget spawn。
8. 输出 worker protocol/capability range 到 component compatibility registry；worker hello/ready 必须协商 accepted range/build/capabilities，不兼容时不 claim TaskRun。
9. 输出交给模块 04 的 worker 环境 manifest；模型环境不得由不同 launcher 各自拼接。
10. Scheduler 注册 `content.inspect/content.extract/content.thumbnail/storage.attachment-temp`，按 content-safety/attachment policy 对一次性 extractor、staging 和 orphan sweeper 做 multi-resource claim、lease/fencing、取消与字节核算；无 profile 不解析。

### 明确不改

不重写 Core Agent loop、工具、权限、Skills、Hooks、MCP、子代理、resume 或 compact。

### 验收 Oracle

- 固定假 Core fixture：ready → delta → tool activity → complete，ProductTask 只得到一条 run。
- stop：收到 stop 后进入 stopping，最终只有 stopped/complete 一个终态，迟到 delta 被拒绝。
- crash before accepted：整个 submit 原子写入不存在，消息保持未受理；crash after accepted/before claim：重启投递同一 durable dispatch；重复 start 只有一个 claim，均不创建第二 run。
- 大帧、坏 JSON、协议版本不匹配和无 ready 均形成明确 run error，不无限重启。
- 双 scheduler/进程竞争同一 occurrence/run 时只有一个 fencing claim；资源 profile 缺失、owner/字节上限耗尽和 draining 分别返回稳定 reason code，不启动 worker。
- fake clock 下 interactive/recovery/scheduled/batch 的优先级、owner轮转、aging、取消、超时、崩溃恢复无 permit 泄漏或饥饿。
- GUI/cron consumer graph 已指向 worker adapter + ProductResourceScheduler；公共 CLI 尚未删除并在 Manifest 标记模块 23。

### 交接物

worker protocol version、component compatibility entry、ProductResourceScheduler contract/profile/snapshot、launcher 环境字段、run/CoreSession 映射和故障 fixture。

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
10. 模块 04 必须登记并冻结远程 Gateway deployment Work Unit：仓库内受控 ingress/path rewrite、TLS termination、gateway service unit、desktop app credential 注入/轮换、provider secret 注入、health/preflight、部署 manifest version/hash 和回滚。`https://…/gw` 到 gateway `/v1/*` 的 rewrite 必须有配置与契约测试；不能把仓库外现状当证据。模块 24 只消费该 manifest。
11. Gateway account scope 必须实现第 4.11 节 ProductResourceScheduler：ingress bytes、MiMo vision、Fun-ASR 和 provider request claim 使用统一 profile/fairness/owner/overload 枚举；删除当前互不知情的局部默认并发真相。上游配额无真实配置时 profile missing，能力 unavailable，不以代码默认值启动。
12. 将 Gateway API、provider-proxy、model catalog、Relay 图片准入协议和各模型 capability range 登记进 component matrix；gateway/sidecar、Gateway/Relay 握手失败、catalog revision 不兼容或模型未登记时，不创建 CoreSession/上游图片提交。
13. Relay 最小 executor 同时实现第 3.2 节 `relay-retention-policy.json`：encrypted owner-scoped blob、input/provider receipt、local durable Asset ack、7 天 output offline window、30 天 unknown/audit 和 fenced purge；policy/profile 缺失时图片能力 unavailable，模块 13 不得先产生无 retention 的真实付费任务。

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

- Gateway 和 Relay 图片准入 scheduler 的 fake clock/双 executor fixture 证明 ingress/provider/input/blob bytes、profile/owner 上限、公平、取消、unknown 与过载状态统一；无 profile 不发上游请求，模块 13 前置图片调用不能绕过 Relay permit。
- component matrix fixture 覆盖 Gateway N-1/N、model catalog revision、required capability、unknown model 与不兼容协议；全部 fail-closed 且不回退 Qwen。
- Gateway deployment manifest 的 ingress `/gw` rewrite、TLS/service identity、app credential/provider secret 注入、health/preflight 与回滚 fixture 完整；缺任一项模块 04 不完成，外部服务器当前可访问不能替代。

### 交接物

provider-neutral interfaces、model/worker/component compatibility entries、Gateway resource profile/scheduler/deployment manifest、模块 13 前置 Relay 图片准入 executor/profile/receipt、body budget 与 legacy Qwen value mapping。

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

1. 在原生 resolver 集中定义单层目录候选显示顺序：Claude 兼容源 → `AGENTS.md` → `BilliardBuddy.md`。冲突解释不是“全部并列让模型猜”：先服从系统/工具/权限/安全合同；项目指令层内，更近目录覆盖祖先目录，同目录 `BilliardBuddy.md > AGENTS.md > Claude 兼容源`；其他不冲突内容累加。
2. resolver 不删除、改写或假装结构化合并自由 Markdown；所有入选来源保留 path/scope/order。检测不到的自然语言冲突仍按上述顺序解释，并在诊断中显示来源链；真正无法同时满足且会影响施工结果时必须要求用户修正文件，不能静默选择。
3. 启动、额外目录和 nested directory 使用同一 helper；复用 `processMemoryFile`、canonical path、去重、include、Hooks 和 load reason。项目文件必须接入 Core 原生 target-file nested memory 触发：只有实际访问更深目录时才按 root→target 追加该目录链，且每个 canonical source 每个 scope 只注入一次；不得保留 launch-only 的第二 resolver。
4. 字符预算不足时优先保留更近目录，再保留同目录 BilliardBuddy、AGENTS、Claude 兼容源；被截断/淘汰来源必须有诊断，不得因预算悄悄反转冲突优先级。
5. 用户全局品牌文件只来自 BilliardBuddy 隔离产品数据根，不扫描其他 Agent 的 home 配置。
6. `isMemoryFilePath`、`getAllMemoryFilePaths`、compact/诊断/设置消费者同时识别品牌文件；不新增 MemoryType 或附件协议。
7. 对外层品牌注入链执行 `D2_MIGRATE_CONSUMERS`：品牌加载迁到原生 resolver 后停止 `productInstructions.ts → 临时 Markdown → --append-system-prompt-file` 的正式消费；本模块保留待删源码并在交接中证明消费者归零，统一由模块 23 执行 `D4_PHYSICAL_DELETE`；不建立替代临时文件。
8. `/init` 默认在 canonical 项目根创建职责不重复的 `AGENTS.md` 与 `BilliardBuddy.md`；已有文件只给最小 patch；不改写 `CLAUDE.md`。
9. “记住”必须选择唯一目标：项目约定、长期记忆或本次任务摘要。未指定时只生成 AutoMem 建议预览，用户确认后写入。
10. AutoMem 使用 scope+关键词+更新时间的本地索引，不调用隐藏 Sonnet/Anthropic 侧模型；索引损坏不阻塞主任务。
11. 敏感信息、网页 Cookie、候选人隐私、图片/音频 Base64 和绝对路径不进入长期记忆。
12. 仅为模块 01 支持矩阵已登记的项目指令/记忆旧形态提供 `D3_LEGACY_READ_ONLY` adapter 与 immutable fixture；当前 memory 无版本和历史 fixture，默认 unsupported、原文件原位保留，不创建假迁移承诺。TeamMem 的设置、OAuth、watcher、endpoint 和发布消费者交给模块 23 的物理删除 Manifest；本模块先执行 `D1_STOP_WRITES`，模块 21 迁出普通设置消费者。

### 验收 Oracle

- 同层三种文件按 Claude 兼容源→AGENTS→BilliardBuddy 显示；冲突 fixture 证明同目录 BilliardBuddy 胜、近目录胜祖先，而所有入选原文和来源仍保留。
- 真正无法同时满足的自由文本冲突显示来源并要求用户修正；不得随机服从或声称 resolver 已删除旧规则。
- 深层目录只在首次访问目标文件时按原生 nested trigger 注入一次；launch、resume、compact 和额外目录使用同一 canonical 去重与 precedence。
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
9. AttachmentStore 按第 3.1 节实现 staged/inspect/ready/bound、7 天草稿、1 小时失败临时副本、24 小时 orphan、ref graph 和 installation 容量；外部原文件永不删除。解析只能消费模块 03 的 sandbox/profile/typed claim，MIME 不只信扩展名。
10. PDF/DOC/Office/HTML/图片的提取输出保存为有界、标来源的 immutable attachment derivative；宏/脚本/未知二进制不执行。发送失败或取消保留用户草稿但按状态清理应用临时 derivative；磁盘不足显式 `ATTACHMENT_CAPACITY_EXCEEDED` 并提供清理入口。

### 验收 Oracle

- 同一 operation 双击或重连重放：一条用户消息、一个 run、同一 receipt。
- 未收到 accepted：显示尚未发送，草稿和附件不丢。
- delta 乱序/重复/停止后迟到：transcript 只出现一次且终态稳定。
- `/` 分组/fuzzy/键盘导航、`@` 文件与 Skill、超过产品阈值的长文本转附件、中文输入法组合态、Enter/Shift+Enter 和语音插入均有交互 fixture；候选不显示 provider/model，不依赖旧命令 registry。
- 图片、外部文件、项目内文件、长文本和部分附件失败均有 fixture；有效内容不因一个附件失败而丢失。
- 运行摘要来自真实事件；没有事件时不生成随机“正在思考”文案。
- 原始 thinking/tool JSON/密钥在 UI、普通日志和 transcript 中均不可见。
- 7 天草稿 TTL、1 小时失败清理、24 小时 orphan、共享 content hash 不同 owner/ref、磁盘软/硬阈值和 sweeper 崩溃 fixture 不误删外部/已绑定文件。
- 伪 MIME、宏 Office、畸形/超大 PDF、archive bomb、超像素图片和 extractor timeout/OOM 均 fail-closed；无网络/secret/workspace write，临时目录回收且正常附件不受连带删除。

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
7. ProductTask lifecycle 是本模块强引用前置：archived task 不派发 queue/fork/checkpoint mutation；删除 task 时每个 QueuedMessage、Checkpoint/ForkSource 和 managed worktree 都由本模块返回引用类别与解除/用户确认 cleanup operation，不由模块 02猜路径删除。worktree cleanup 有独立 ID、revision、owner/fingerprint 和 `cleanup_failed`，源 workspace/worktree 永不作为 managed fork 删除。
8. 只为模块 01 支持矩阵登记的旧 ProductTask/Core queue、文本引用、checkpoint 和 fork shape 提供 `D3_LEGACY_READ_ONLY` adapter/fixture；未登记记录保持只读隔离，不能由模块 09自行扩大支持或静默丢弃。

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
8. Workspace root identity/revision 是所有 reference 的前置条件：同卷移动经 relocate receipt 继续；跨卷/替换/relink、外部 IDE 修改、只读/断盘返回统一 stale/unavailable，不刷新旧 Diff 为新真相。Git workspace 额外显示 branch/HEAD/worktree identity；非 Git 不展示伪 Diff base。
9. file preview/图片缩略图/文档文本提取必须复用第 4.8 节 content sandbox 和模块 03 claim；ReviewDock 不导入第二解析器。

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
8. Preview WebContents 严格使用第 4.8 节独立 sandbox/partition/CSP/navigation/download/protocol policy；selection picker 只在 isolated world 处理可信用户手势，不向页面 world 暴露 API/event/capability。页面脚本主动 IPC、iframe 冒充、导航竞态或 capability 重放必须被拒绝。选择截图进入同一 content profile/byte budget。
9. preview_selection 绑定 workspace revision/root identity/file hash；Workspace relocate/relink/断盘、源码被 IDE 修改或 managed worktree 丢失立即失效，不能把旧 selector 应用到新根。

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
2. 服务端唯一派生 `owner_scope=installation_id + media_library_id`。用户选择 canonical Workspace 时使用 `workspace:<canonical workspace_id>`；从“创作”直接进入且尚未选择项目文件夹时使用该安装实例唯一的 `installation-default` 媒体库。所有 list/get/write/delete/cancel/asset/download 路由统一验证 owner scope + sidecar auth。
3. MediaProject 迁库只有一个显式 Operation：`media.project.transfer_library`，包含 source/target library、`client_operation_id`、`expected_revision`。存在 submitted/running/cancel_requested/outcome_unknown Job 时固定拒绝。成功时只在一次原子提交中改变项目 `media_library_id` 并推进 revision；失败/崩溃时项目仍完整属于 source，不能双归属。
4. transfer 不复制 Asset、不修改 Asset/历史 Operation 的出生 owner、不重写历史 Version，也不建立 library alias。每个历史引用保存 `{asset_id, asset_owner_scope}`；目标 Workspace 只能经已迁入项目的 Version/Evidence/候选引用读取，不能按 asset ID 枚举 source library。迁入后的新 Operation、新 Version 输出和新 Asset 才归 target library。
5. schema 定义 MediaLibrary、MediaProject、MediaOperation、MediaJob、Asset、Version、Evidence；每项明确 ID、parent、revision、created/updated、owner。
6. 所有写 mutation 使用 `client_operation_id + expected_revision`；外部副作用前先固化 Operation intent。
7. Asset 不可变：记录 kind、immutable owner scope、owned route 或受控外部 path、hash、bytes、source revision；外部视频不复制且永不删除。
8. Version 是不可变完整快照；图片画布、视频时间线都引用明确 input/output revision，所有 Asset 引用含 owner scope。
9. 使用跨进程数据根锁、临时文件、可用时 fsync、rename 和上一有效快照；启动时对账正文/索引/Job/Asset。
10. 只为模块 01 `legacy-support-matrix.json` 已登记的 media schema/shape 提供 `D3_LEGACY_READ_ONLY` adapter 与 crash fixture；当前最低承诺仅包含 media v1 inline `reference_images` → private Asset。新增旧版支持必须先补 immutable fixture、正向迁移、current 写回和幂等测试；adapter 只读取和标准化，不执行旧 provider、旧 workflow 或外部副作用。
11. 实现第 3.2 节状态机和 adapter 归一；renderer 不消费 relay 原始枚举。
12. 删除项目先停止/拒绝活动 Job，列出只会删除的应用拥有资产；失败时项目不能从列表消失。历史跨库引用的 Asset 只有在全 installation 引用计数为零且属于应用拥有时才可清理。
13. MediaProjectService 不再维护独立 render/probe admission 真相；所有 FFprobe、FFmpeg、local I/O 和 byte-heavy MediaJob 一次声明完整 desktop-host typed claim，只有 ProductResourceScheduler receipt 后执行。Job 保存 claim/lease/fencing/profile revision；过载状态使用全局枚举。

### 验收 Oracle

- 两个进程竞争同一数据根：只有一个获得 writer lock；第二个 sidecar 固定拒绝启动该数据根并返回“已有实例正在使用”，不得进入另一个读写或只读 service 模式。
- FFprobe/FFmpeg/local-I/O 多资源 claim 在取消、超时、崩溃、双 sidecar、profile 失效下不越限、不死锁、不泄漏 permit；无 profile 不启动子进程。
- 两窗口同 revision 写项目：一个成功，一个 conflict。
- 崩溃在 intent、上游调用、结果下载、asset rename 各窗口重启后可对账，不重复副作用。
- 猜 project ID、跨 MediaLibrary/Workspace、无 sidecar auth、外部路径删除全部被拒绝。
- default 项目显式 transfer 到 Workspace A：project revision 原子前进；历史 `asset_id/asset_owner_scope`、route、hash、Version 和 Operation 不变且未复制。Workspace A 只能经项目路由读取历史 Asset；default 不再列出/写项目，Workspace B 与猜 ID 请求被拒绝。
- transfer 有活动或 outcome_unknown Job 时拒绝；重复 operation 返回同一 receipt；崩溃后项目只属于 source 或 target 之一。迁入后编辑旧 Asset 时，输入仍属 default，新 Operation/输出 Asset 属 Workspace A。
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

**依赖：** 04、12、13
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
10. 模块 14 必须登记并冻结远程 Relay deployment Work Unit：仓库内受控 ingress/TLS/allowlist、relay service unit、Gateway→Relay 独立 service credential、owner 派生、provider secret/持久 DB/blob 注入、health/preflight、部署 manifest version/hash 和回滚。Relay 不接受桌面直连或客户端自报 owner；模块 24 只消费该 manifest。
11. Relay account scope 消费模块 04 已建立的唯一 ProductResourceScheduler 图片准入和 retention/ack 基础；本模块补齐五分钟 deadline、生产容量 profile/preflight、N-1/N rolling compatibility、加密 DB/blob 部署、TTL/purge sweeper 可靠性和 outcome_unknown 对账。OpenAI/Seedream、input bytes、blob disk 和 purge 继续使用同一 typed claim/durable queue/owner fairness/lease/fencing；不得新建第二 scheduler，当前独立 semaphore/数组队列必须迁成其 executor 或删除。
12. Gateway↔Relay 的 `relay-image-task` protocol/build/capability 和 image provider profile revision 登记进 component matrix；部署遵守 N-1/N reader overlap，不兼容时 gateway 返回 `RELAY_INCOMPATIBLE` 且不创建 MediaOperation 上游提交。
13. retention fixture 覆盖 accepted receipt 与本地 Operation 原子持久化 signed envelope；provider receipt 后 input 删除、local Asset ack 后 output 删除；桌面离线第 8/14/15/29/31 天恢复，Relay 重启后可幂等签发同一终态语义；重复查询/ack、提交后立即前跳 31 天、重启前跳、NTP 校时、回拨、Relay 不可达、坏签名、用户 purge、跨 owner 与 purge_failed 均有断言。只有有效 Relay server-time terminal receipt 转 `result_expired/outcome_unresolvable`；其余保持 unknown/阻塞且不产生新付费 Operation。

### 验收 Oracle

- 每层 timeout 配置表明确计时类型和来源；60/120 秒媒体断点为零或有合理非结果用途说明。
- production preflight 缺 Seedream/字节预算/300 秒任一字段时失败。
- 队列满返回 Retry-After，客户端使用有抖动有界退避，不立即重试。
- fake upstream 在提交后断网：只出现一个付费 Operation，重启后查询同一 ID。
- 小 Prompt 与参考图容量 fixture 不通过取消上限来“达标”。
- Relay scheduler 双进程/fake clock fixture 证明 provider、bytes、blob disk、owner quota、取消/超时/lease fencing 无越限、重复付费、泄漏或饥饿；无账号 profile 固定 unavailable。
- Gateway/Relay N-1/N protocol fixture 证明 reader overlap、rollback floor 和 `RELAY_INCOMPATIBLE` fail-closed。
- Relay deployment manifest 的 ingress/TLS/allowlist、service identity、Gateway-only credential/owner、provider/DB/blob secret 注入、health/preflight 和回滚 fixture 完整；缺任一项模块 14 不完成。
- 未读取真实线上配置时报告明确写“代码、受控部署 manifest 与配置模板已验收，线上未验证”。

### 交接物

timeout/capacity matrix、Relay resource profile/scheduler/deployment manifest、Gateway/Relay compatibility entry、production preflight 和 unknown-outcome fixture。

---

## 模块 15：Fun-ASR 语音输入

**依赖：** 04、07、12
**模块主题前缀：** `feat: connect fun asr voice transcription`

### 用户结果

用户可录音或上传音频，看到转写并编辑后放入 Composer；取消、迟到和权限拒绝不会串到其他任务。

### 权威状态

VoiceService 是 VoiceOperation、Transcript、TranscriptRevision 的唯一写入者。ProductTaskService 与 MediaProjectService 只写各自的 TranscriptBinding；Composer 只插入用户确认 binding 所指向的 revision，不复制转写正文为第二真相源。

### 实施合同

1. 只实现 Fun-ASR-Flash provider-neutral SpeechTranscription adapter；对 Whisper/旧 ASR 执行 `D1_STOP_WRITES` 与 `D2_MIGRATE_CONSUMERS`，保留支持矩阵登记的 setting mapper 给模块 22，运行时源码由模块 23 `D4_PHYSICAL_DELETE`。
2. VoiceOperation 固定包含 `voice_operation_id`、installation、`client_operation_id`、受控 audio source/route、source owner/fingerprint、provider receipt、状态与 revision；录音、上传、取消和迟到回执只更新同一 Operation。
3. 成功/部分结果创建稳定 Transcript；raw 与每次 user_edited 都创建不可变 TranscriptRevision，保存 `transcript_revision_id`、递增 revision、kind、文本/时间戳证据和 audio fingerprint。编辑不覆盖 raw 或已有 revision。
4. Composer 确认、ThreadEntry 和 Video Evidence 分别创建 TranscriptBinding，保存 revision ID、consumer kind/ID/owner。跨 installation、猜 transcript ID 或 consumer owner 不匹配一律拒绝；没有“凭 transcript ID 直接读取”的公共接口。
5. 空音频、过大、不支持编码、权限拒绝和断网保留 Composer 文字与其他附件。
6. Composer 与视频可绑定同一个 TranscriptRevision。用户编辑产生新 revision 后，旧 Video Evidence 继续指向旧 revision；只有用户显式选择更新时，MediaProjectService 才创建新的 binding/Evidence revision，不复制文本。
7. 原始音频只在 Operation/Binding 生命周期内保存；终态且没有未释放 binding 后按 owner 政策清理，不进入 AutoMem、普通日志或文本 prompt 二进制。

### 验收 Oracle

- 取消 A 后开始 B，A 的迟到结果不得写入 B。
- 麦克风拒绝后可重新授权；不会阻断文字任务。
- fake Fun-ASR 返回空/错误/部分结果时状态真实，不把空文本标成功。
- 转写编辑后创建新 immutable revision；Composer/ThreadEntry 只保存当前确认的 `transcript_revision_id` binding，不复制正文作为权威状态。
- 同一 revision 同时绑定 Composer 和 Video Evidence 时 ID 完全一致；Video Evidence 另校验 source/time/fingerprint。编辑 Composer 后旧 Evidence 不漂移，显式更新才创建新 Evidence binding。
- 跨 installation、无 sidecar auth、猜 transcript ID 和 consumer owner 不匹配的绑定/读取全部拒绝。
- 最终 provider graph 无 Whisper/第二 ASR 可执行路径。

### 交接物

VoiceOperation/Transcript/TranscriptRevision schema、consumer binding contract、provider fixture 和生命周期规则。

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
3. `evidence`：Fun-ASR 结果必须以全局 `transcript_revision_id` binding 接入 Video Evidence，本机 shot/quality、MiMo 代表帧证据分别绑定 source/time/fingerprint/revision/confidence；不得复制 Transcript 正文成为媒体真相。证据不可用明确 unchecked。
4. `plan`：DeepSeek 只读 Brief 与证据，输出引用真实 source ID/time range 的 timeline draft；确定性 validator 拒绝越界、缺源、重叠非法和未知素材。
5. `edit/preview`：用户操作基于 timeline revision；锁定场景不被重新规划覆盖；字幕、Logo、CTA 和安全区由确定性图层处理。
6. `export`：单实例 FFmpeg 导出新 Asset，不覆盖源文件；完成必须通过 ffprobe 和存在/hash 检查。
7. 每个阶段是 MediaJob，记录 operation/project/input/output revision；阶段失败保留 checkpoint，不跳阶段或假成功。
8. 素材变化使相关 Evidence/旧 AI draft stale，但不删除用户当前 Timeline Version；由用户选择重新规划。
9. 对视频聊天中转执行 `D1_STOP_WRITES`：停止创建 `kind=video` 的 media draft；提供视频 draft/project/source/evidence/unknown Job 的 `D3_LEGACY_READ_ONLY` adapter 与 fixture给模块 22；物理删除统一由模块 23。
10. source ingest、FFprobe、代表帧抽取和 FFmpeg 全部视为不可信媒体解析，必须经 content safety profile + Scheduler claim；限制源/解码像素、帧/时长、CPU/wall、memory/temp/output。畸形媒体或超限只形成安全错误，不让 parser 崩溃 sidecar；外部源移动/断盘按 fingerprint 进入 missing/relink，不能按同名自动替换。

### 验收 Oracle

- source 文件移动后只能用 fingerprint/时长/尺寸重新定位，不按同名误连。
- planner fixture 引用不存在 source 或越界 time range 时 validator 拒绝。
- 同一 TranscriptRevision 被 Composer 与视频 Evidence 引用时 binding ID 指向完全相同的 revision；用户编辑产生新 revision 不改写既有 Evidence，显式更新后 Evidence revision 才前进。
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
5. 每次执行经 agent-worker，使用独立 TaskRun 与 permission snapshot；ScheduledTaskService 只持久化 occurrence/job，不自行 spawn。`schedule.dispatch + agent.worker` 必须作为一个 ProductResourceScheduler claim 原子准入；跨进程 fencing 保证每个 occurrence 至多一次，不得调用公共 CLI。
6. 通知深链只携受控 task/logical run ID；目标不存在落安全页面。
7. 网络错误不自动重复外部副作用；有界重试只用于读取/查询，发送动作沿原 Operation 对账。
8. ScheduledTask 保存 target task strong reference 与 on-delete policy；ProductTask delete plan 遇到 enabled/active schedule 固定阻塞。用户必须先 disable 并选择“保留历史但解除 task 引用”或删除 schedule；occurrence running/outcome_unknown 时不能解除。任何策略都有 receipt，不由任务删除隐式取消。

### 验收 Oracle

- DST 前进/回退、休眠跨多个周期、时区修改和重启 fixture：默认产生 missed 记录且不执行；显式 `run_once_after_wake` 时只补最近一个窗口；每个窗口最多一个 logical run。
- worker 崩溃后不创建第二 run；状态可恢复。
- 双 scheduler/多进程同时 tick 同一 occurrence 时只一个 fencing claim；profile/owner/队列过载产生统一 reason code且不 spawn。
- 通知重复点击只打开一个安全窗口，不创建重复任务。
- UI/日志不显示 cron 表达式、CLI 参数、provider 或 Core ID。

### 交接物

schedule/logical run/occurrence schema、ProductResourceScheduler claim/fencing、missed-run policy、notification receipt 和时间 fixture。

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
2. Extension 与 native host 是模块 18/24 必须验证的同一能力：固定 extension ID/版本协议/native host name；public package 只允许正式 extension origin；sidecar wrapper 必须使用 packaged sidecar 的内部 `native-host --app-root <unpacked-root>` mode，不允许经过或恢复 public CLI entry；extension 未安装、host manifest 失败、版本不兼容或未握手时 capability 为 unavailable，BOSS 退化为人工交接，不展示可执行。
3. Bridge 每次连接生成 `bridge_session_id`，每个调用携带 `request_id + owning_client_id + page_version` 并只回给发起者；不得广播 tool response。断线清除该 session 的短期 ref/pending request；读操作可在重连后重新 observe，写操作断线固定 `outcome_unknown`，必须 reobserve 对账，不能自动重发。
4. observe 的通用 BrowserCapability 可以表达 URL/title/page version/ref/role/name/state/value；但招聘专用 adapter 必须在 Extension/bridge ephemeral 区内先做字段级 allowlist/redaction，只向 Tool/Core 返回去身份化筛选字段、非识别状态和绑定当前 session/page 的短期不透明 `candidate_action_token`。`visible_text_summary`、原始 ref/DOM 属性、姓名/电话/email/简历自由文本不得离开 ephemeral 区；导航/刷新/分页/iframe 变化使 token 失效。
5. action 只引用当前 page version 的 `candidate_action_token`，Extension 在 ephemeral 区解析为当前 ref；Tool/Core 永不接收原始候选 ref，不保存长期 CSS selector，不输出桌面像素坐标。
6. `visual_required` 时，普通非招聘视觉能力可由 MiMo 生成受控证据；招聘候选页面固定转用户接管，不能上传候选截图/DOM/简历。任何视觉结果无法映射当前 ref 时同样转用户接管，MiMo 不执行动作。
7. 登录、扫码、验证码、人机验证和 Chrome 站点权限由用户在可见浏览器处理；不导出 Cookie/storage state/profile，不调用私有接口 header。Extension 站点权限、产品审批与页面当前版本三者任一不满足都不执行 action。
8. 正式只读链固定为：`agent-worker/Core capability discovery → boss-recruiting Skill → recruiting-browser Tool.observe/reobserve（MCP 内部协议）→ BrowserCapability → ChromeSessionBridge → Native Messaging host → BilliardBuddy Chrome Extension → read receipt → RecruitingService 写 BrowserCheckpoint → ProductTask 结果投影`。observe/reobserve 不需要副作用审批，但仍校验 owner、plan/batch、bridge session、当前 page version 和短期证据边界。
9. 正式副作用链固定为：`Skill 提议受限 action → recruiting-browser Tool 请求 ProductTask/Core approval → 用户批准 → RecruitingService 先持久化 RecruitingOperation intent → Tool.action → BrowserCapability/ChromeSessionBridge → Extension 页面动作 → reobserve receipt → RecruitingService 写 succeeded/outcome_unknown → ProductTask 结果投影`。未批准、intent 未持久化、session/page version 不匹配时不得调用 action；点击本身不是完成证据。
10. Tool 通过 Core 现有工具注册边界暴露 `observe/action/reobserve`，只接收 plan/batch/operation ID 与受限 payload；不得让 Skill 直接写 RecruitingService 文件或调用 MCP/native/extension 细节。生产构建不得继续使用 `BROWSER_TOOLS=[]` 的 no-op stub；capability manifest 与 ListTools 必须证明真实工具非空且版本一致。
11. RecruitingPlan 保存门店、岗位事实、筛选条件、话术约束、允许动作；Batch/Operation 使用 revision、idempotency 和页面回读证据。
12. 招聘隐私期限固定：原始 HTML/截图/完整简历/头像/姓名/电话/邮箱只在 Extension/bridge owner-scoped 加密临时区保留 15 分钟，session 断开、页面版本变化、浏览器关闭或用户删除即提前销毁；不得持久化进 BrowserCheckpoint。Checkpoint 只含 ref hash、page version、非识别筛选结论和状态。
13. Core/Skill 只接收 RecruitingPlan 明确 allowlist 的去身份化结构字段；候选页面 `visual_required` 固定转用户接管，不能把截图/DOM/简历上传 MiMo 或其他模型。RecruitingOperation 待发送正文仅在 pending/outcome_unknown 加密保存，terminal 后立即删；unknown 最长 7 天用于同一 operation reobserve，之后删正文但不改成 failed或重发。计划/批次关闭立即清 ephemeral/pending；仅 operation hash/状态/时间的 audit 最长 30 天。清理失败进入 `privacy_purge_failed` 并阻止模块 complete。
14. 用户可从计划/批次删除入口查看将清除的证据类别并发幂等 purge；Cookie/storage 永不进入产品存储。所有期限使用可注入时钟，且 diagnostics、AutoMem、普通日志、migration manifest、跨门店 API 静态拒绝这些字段。
15. 当前仓库没有可证明的旧 Recruiting 持久化 schema，因此模块 01 矩阵将其标为 unsupported，本模块不创建假 legacy adapter；将来发现真实旧数据时必须先更新矩阵、fixture 和 Spec-Commit。
16. 通用桌面 Computer Use 的消费者迁完后列入模块 23 `D4_PHYSICAL_DELETE`；本模块不接 Playwright 第二生产 adapter。
17. Browser session/batch 必须提交 desktop-host `browser.session/browser.batch` typed claim，声明 owner、页面/截图字节、deadline 和取消策略；bridge/Skill 不维护第二把业务锁。profile missing、draining 或 owner quota 耗尽时返回统一 reason code，不打开或继续页面动作。
18. RecruitingPlan/Batch 保存 ProductTask strong reference 时，task delete plan 在任何 active/pending/outcome_unknown batch/operation 下阻塞。用户先关闭计划并完成第 12—14 条 privacy purge，再以 receipt 选择保留脱敏 audit 并解除引用或删除计划；任务删除不得隐式关闭/发送/清候选数据。

### 验收 Oracle

- 固定 bridge/extension fixture 覆盖未安装、manifest/host 启动失败、版本不兼容、登录、站点权限、分页、ref 失效、多 client 路由、断线、弹窗、visual_required、验证码和页面改版；不同 session/client 的 response 不得交叉或广播。
- packaged sidecar 的 native host wrapper 能实际进入内部 `native-host --app-root …` mode，production capability discovery/ListTools 非空；public CLI 不可达，public package 不包含 dev extension origin 或远程 bridge fallback。
- 同一发送 operation 重放不产生第二次动作；页面未回读时不能显示已发送。
- 两个门店的 Plan/Batch/候选 ref 不能串用；关闭计划先停止活动 batch。
- 正式 packaged agent-worker 的 capability discovery 能发现 `recruiting-browser` Tool；只读 fixture 按 observe→checkpoint→投影执行且不产生 approval；副作用 fixture 严格按 approval→intent persisted→action→reobserve receipt→结果写入执行，未批准/intent 写入失败/页面未回读时分别为 rejected/未执行/outcome_unknown。不能只用协议类型或直接调用 bridge 的单测代替。
- 最终运行图无桌面坐标点击 fallback、Cookie 导出或私有 API header。
- browser profile/owner/bytes 上限在双 session、批量任务、取消、断线和更新 draining 下不越限或泄漏；无 permit 时不调用 Extension action。
- 真实 BOSS 发送未做时交接明确写“假页面合同已验证，真实平台未验证”。
- 15 分钟 ephemeral、7 天 unknown payload、30 天 audit 使用 fake clock 准时清理；关闭计划/用户 purge 后无 HTML/截图/简历/姓名/电话/email，purge_failed 不谎称已删。
- prompt、checkpoint、普通日志、AutoMem、diagnostic bundle、migration manifest、跨门店读取均以 canary PII 证明零泄漏；招聘 visual_required 必须人工接管且不调用 MiMo。
- 招聘 observe canary fixture 在可见文本/DOM/ref 注入姓名、电话、email、简历句子：Extension/bridge 外只出现 allowlist 去身份化字段和短期 action token；Core Tool event、prompt、checkpoint、日志均无原文，过期/跨页 token 被拒绝。

### 交接物

BrowserCapability、Chrome Extension/Native Messaging compatibility entry、bridge session/request routing、browser resource profile/claim、Recruiting schema、fake extension/page suite、数据最小留存和 Computer Use 删除清单。

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
6. 招聘 Skill 只能消费脱敏的计划事实、非识别筛选结论和 operation 状态；不得读取 RecruitingEphemeralEvidence、候选 ref 原文、简历、姓名或联系方式，也不得为了生成话术把这些字段复制进 ProductTask prompt。

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
9. About/设置提供“导出诊断信息”：展示允许类别、7 天/5 MiB 上限和“不自动上传”，经受限 IPC 只调用 Main `DiagnosticBundleService`。renderer/sidecar/worker 不传任意路径或文件清单给 collector；用户只选择最终保存路径。导出失败显示短错误码并不留下 staging。
10. About 页显示版本、更新状态、`target_starting/recovery_required/recovery_read_only` 和许可，不显示内部 provider/model；健康与回退资格只投影 ElectronUpdaterService，不自行推断。

### 验收 Oracle

- 正式普通包在非内部 USER_TYPE 下仍有项目约定、长期记忆、Session 摘要和必要业务能力。
- GrowthBook/网络不可达、provider health 过期、系统权限拒绝、浏览器未登录和真实 Job active 五类 fixture 分别产生符合真值表的四态、reason code 与恢复入口。
- UI、API、环境模板和文案 consumer graph 中 WebSearch/Tavily/Brave/Computer Use/TeamMem 普通入口归零。
- Core 的 MCP/Plugin/Hooks 执行机制未被删除，只从普通设置隐藏并移除无消费者产品管理表面。
- 普通设置不出现 model/provider/API key/`tengu_*`/`CLAUDE_CONFIG_DIR`。
- diagnostic bundle canary fixture 注入 prompt、Cookie、secret、绝对路径、URL query、附件正文/Base64、招聘姓名/电话/email 和原始 crash dump：任何一个进入候选字段都整体失败；合法包仅含 allowlist、随机盐 HMAC ID、manifest/hash，且无自动网络请求。

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
| Whisper/旧 ASR setting 与 transcript | 15 | 仅处理支持矩阵登记 shape：映射 setting；每份旧转写恰好创建一个 VoiceOperation/Transcript/TranscriptRevision，并以 binding 接入 Composer 或 Video Evidence，不复制正文 |
| video media draft、source/evidence/timeline/unknown Job | 16 | 有有效 project/source/evidence/job/durable ID 或已提交副作用时转独立视频项目；仅纯文本空 draft 本地只读归档 |
| scheduled task/logical run/notification | 17 | 迁 schedule 和历史，不补执行旧周期 |
| recruiting plan/batch/checkpoint | 18 | 当前无旧持久化 schema，标 unsupported 且不创建假记录；未来只消费支持矩阵登记项 |
| terminal preferences | 20 | 只迁偏好，不迁 PTY session/命令历史 |
| capability/settings/WebSearch key presence/TeamMem setting | 21 | 映射当前设置；不复制密钥值或恢复已删能力 |

4. Qwen/Whisper/旧 provider 值只在矩阵登记的字段形态内通过纯 legacy mapper 转成当前合同或明确 unsupported；不恢复旧可执行 provider。
5. 媒体迁移只处理矩阵登记形态，并分类为已关联项目、未关联 draft、运行中 Job、outcome_unknown、孤儿 Asset。映射时为每个历史 Asset 固化 immutable `asset_owner_scope`，每个 Version/Evidence 引用写 `{asset_id, asset_owner_scope}`；不得通过迁移复制 Asset 或把 owner 改成当前 MediaProject library。已关联项目转到派生的 MediaLibrary；unknown 保留 durable ID 和查询入口。
6. 媒体聊天中转按唯一规则迁移：凡是矩阵已登记且拥有有效 MediaProject、Asset、Job、远端 durable ID 或已提交/unknown 副作用的记录，迁为对应 MediaLibrary 下的独立图片/视频项目并保留身份与恢复入口；未登记格式保持只读隔离。不得让用户选择两套运行路线。
7. 项目指令与记忆只有在矩阵登记具体历史形态后才自动迁移。当前 memory 无版本/历史 fixture，默认保持原文件原位且 unsupported，不由模块 22重写。若未来登记，仍必须遵守：既有 `CLAUDE.md`/兼容源正文、mtime、权限和路径不变，品牌文件不覆盖，Session/AutoMem scope 不提升，TeamMem 不恢复同步。
8. MigrationCoordinator 在任何写入前申请 `storage.migration` 独占 lifecycle claim，驱动 scheduler 进入 maintenance/draining 并取得跨进程 fencing lease；不能用进程内 Promise 当互斥。deadline 内不能 quiesce 则迁移不开始，旧数据保持只读。
9. 迁移可重入，使用版本+hash 备份、checkpoint 和原子替换；同名冲突不覆盖；失败进入 `failed_read_only`。
10. 正式升级包必须继续携带 coordinator、支持矩阵登记的 legacy reader/fixture 和回滚入口；本模块不得删除它们。
11. 迁移 manifest 只记录 storage ID、输入/目标版本或 shape ID、数量、状态、相对/脱敏标识和错误码，不记录用户正文、候选人隐私、密钥或绝对路径。
12. Workspace/TaskAttachment/ProductTask lifecycle 旧形态只按支持矩阵迁移：path-only Workspace 无法证明 root identity 时写 `relink_required`，不能自动授权；旧附件无法证明 owner/ref/bytes 时只读隔离，不进入 sweeper；不凭“记录缺失”创建 deleted tombstone。RecruitingEphemeralEvidence 和 Relay blob 永不作为迁移输入。

### 验收 Oracle

- 对 `legacy-support-matrix.json` 每个 supported input 从 immutable fixture 冷启动最终安装目录：备份存在、数据数量一致、owner/revision/ID 映射可追踪；provisional/unsupported 不进入自动迁移。
- CI 对支持矩阵执行一一对应检查：每个 supported entry 都存在 fixture、reader/migration、正向、current 写回和幂等测试；任一缺失则阻断模块完成。
- 当前初始矩阵必须如实标记 ProductTask v2 provisional，memory/recruiting/cron run log/普通 settings/desktop localStorage 历史版本 unsupported；不得因代码中有读取分支或 schemaVersion 常量就升级为 supported。
- 在每个迁移阶段注入崩溃/磁盘满/权限失败：原数据保持、重启可继续、不会初始化空库。
- 两个 coordinator/sidecar 同时迁移时只有一个 fencing lease；旧 lease owner 恢复后无法写入。active worker/FFmpeg/outcome_unknown 阻塞 quiesce 时明确不开始迁移。
- 同一迁移运行两次结果一致，不复制 task/project/asset/operation。
- media unknown、未关联 draft 和孤儿 Asset 均出现在 manifest 与用户可恢复入口；含项目/资产/Job/durable ID 的记录全部迁为独立项目，只有从未提交副作用的纯文本空 draft 进入只读归档。
- 项目指令/记忆 fixture 证明：既有 `CLAUDE.md` 正文、mtime、权限不变；品牌文件不覆盖；AutoMem 不提升为项目指令；scope/source/freshness 保留；冲突进入隔离备份且可回滚。
- 旧 ASR supported fixture 中每份转写只产生一个全局 Transcript/Revision；Composer/Video 通过 binding 接入，不生成第二份文本真相。
- 新安装无 legacy data 时不创建虚假迁移或空备份。

### 交接物

migration coordinator、冻结的 `legacy-support-matrix.json`、矩阵登记的领域 adapter/immutable fixture、manifest 和备份/回滚规则。

---

## 阶段 E：清理、发包与验收

## 模块 23：死运行时与依赖物理清理

**依赖：** 01—22；首个 Work Unit 固定为 `BB-23A`，其唯一 Gate ID 为 `G22_PRE_D4_VERTICAL_GOLDEN_GATE`，通过前禁止任何 D4
**模块主题前缀：** `refactor: remove dead product runtimes`

### Work Unit 注册

以下是模块 23 开工前冻结的完整顺序；每个条目仍必须在派工时填写第 0.6 节的 Spec/Base SHA、精确允许路径和验收命令，但不得重分组或临时新增删除范围：

| Work Unit | 单一结果 / Manifest 范围 | 依赖与允许修改 | 明确禁止 / 完成条件 |
|---|---|---|---|
| `BB-23A` | 运行 `G22_PRE_D4_VERTICAL_GOLDEN_GATE` | 依赖 01—22；只允许 Gate 测试、fixture、机器 manifest、必要验证配置 | 禁止删除/修改产品运行时；干净/升级数据根全旅程通过并 accepted |
| `BB-23B` | 删除第二 renderer、旧壳、旧业务 store/可执行旧 API | 依赖 A；只改该行 consumer graph 与删除路径 | 保留 ProductTask reader、Git 历史和许可证；受影响 Gate 旅程通过 |
| `BB-23C` | 删除 `productInstructions` 外层注入 | 依赖 B；只改该注入链 | 保留原生 resolver/legacy 文件；指令冲突与 nested fixture 通过 |
| `BB-23D` | 删除公共 CLI/TUI/Ink/REPL/Doctor/bin/help/publish | 依赖 C；只改公共 surface | 必须保留且仅内部可达 agent-worker、`native-host` mode、Core handler；package input 和 Gate 通过 |
| `BB-23E` | 删除 Qwen 可执行 runtime | 依赖 D；只改 Qwen provider/route/config/runtime fixture | 保留纯 legacy mapper；模型/worker Gate 通过 |
| `BB-23F` | 删除 Whisper/旧 ASR runtime | 依赖 E；只改旧 ASR runtime | 保留矩阵登记 mapper；Voice/Video binding Gate 通过 |
| `BB-23G` | 删除通用桌面 Computer Use | 依赖 F；只改坐标/录屏/辅助功能/Python helper/runtime route | 保留 BrowserCapability、MiMo Evidence、Core通用 Tool/MCP；招聘 Gate 通过 |
| `BB-23H` | 删除 WebSearch/Tavily/Brave/native search | 依赖 G；只改该搜索 runtime | 保留 WebFetch/BrowserCapability；工具 Gate 通过 |
| `BB-23I` | 删除 TeamMem runtime | 依赖 H；只改 OAuth/watcher/endpoint/settings/diagnostics | 保留必要 migration mapping；记忆 Gate 通过 |
| `BB-23J` | 删除媒体聊天中转 | 依赖 I；只改 mediaWorkbenches Skill/Tool、`media_draft` 新建/线程投影 | 保留独立 MediaProject/migrator；图片/视频 Gate 通过 |
| `BB-23K` | 删除旧 workflow runtime/DSL 与重复 media route/service | 依赖 J；只改该行运行图 | 保留唯一 MediaProjectService；媒体 Gate 通过 |
| `BB-23L` | 先迁移、再删除旧 tag/manual→upload/feed 正式直发 workflow、脚本与发布权限 | 依赖 K；只改 release workflow/script/permission consumer graph；同一 Work Unit 先形成 D1/D2 machine checkpoint，再允许 D4 | 保留的 tag/manual trigger 只能构建候选且无正式 feed 写权限；consumer graph 归零、候选/发布旁路 fixture 通过 |
| `BB-23M` | 删除 Tauri/Linux target 与重复构建 workflow，汇总 D4 | 依赖 L；只改 target/workflow/package input | 保留 Windows/macOS Electron 候选构建、全部 readers/licenses；全 Gate、本地 build、最终运行图通过 |

### 用户结果

源码和本地运行图只剩 BilliardBuddy GUI、内部 worker、ProductTask/媒体/招聘/定时服务，以及升级所需 migration reader；没有第二前端、公共 CLI/TUI、旧模型、旧媒体中转或高权限桌面控制继续参与正式运行。

### 物理删除 Manifest

`D4_PHYSICAL_DELETE` 前每一行必须满足消费者归零，并且 `G22_PRE_D4_VERTICAL_GOLDEN_GATE` 已按第 4.9 节在干净/升级数据根通过。Gate Work Unit 只验证和产出机器证据，不删除任何源码；失败时回原模块 repair。删除对象不得仅凭路径名或一次 `rg` 判断。

| 对象 | `D1_STOP_WRITES` / `D2_MIGRATE_CONSUMERS` 完成模块 | `D4_PHYSICAL_DELETE` 负责人 | 必须保留的 `D3_LEGACY_READ_ONLY` 内容 | `D5_PACKAGE_ABSENT` 负责人 |
|---|---:|---:|---|---:|
| 第二 renderer/旧壳/旧业务 store 与可执行旧 API | 01、06—11 | 23 | Git 历史、许可证；不包括下一行 ProductTask reader | 24 |
| ProductTask `D3_LEGACY_READ_ONLY` reader/adapter/fixture | 02、22 | 不执行 D4；按第四部分未来触发条件单独处理 | 旧 ProductTask schema 读取、ID/revision/sequence 映射和回滚 fixture | 24 验证包内可达 |
| `productInstructions` 外层注入 | 05 | 23 | 原生 resolver 与 legacy 文件兼容 | 24 |
| 公共 CLI/TUI、Ink、REPL、Doctor、bin/help/publish entry | 03、17 | 23 | 内部 agent-worker、不可交互 `native-host` mode 与 Core command handler；三者不能被公共 bin/help 调用 | 24 |
| Qwen 可执行 provider/route/config/test fixture | 04 | 23 | 模块 22 的纯 legacy value mapper | 24 |
| Whisper/旧 ASR 运行时 | 15 | 23 | 模块 22 的 legacy value mapper | 24 |
| 通用桌面 Computer Use、Python helper、专用 API/UI/vision routing | 18、21 | 23 | BrowserCapability、MiMo 普通视觉证据、Core 通用 Tool/MCP | 24 |
| WebSearch、Tavily/Brave、native search route | 21 | 23 | WebFetch 与 BrowserCapability | 24 |
| TeamMem OAuth/watcher/endpoint/settings/diagnostics | 05、21 | 23 | 无运行时；仅必要 migration mapping | 24 |
| mediaWorkbenches Skill/Tool、`media_draft` 新建与线程投影 | 13、16、22 | 23 | 独立 MediaProject 与 legacy migrator | 24 |
| 旧 workflow runtime/DSL、重复 media route/service | 12—16、22 | 23 | 当前 MediaProjectService | 24 |
| 旧 tag/manual→upload/feed 正式直发 workflow、脚本与发布权限 | 23L 在同一 Work Unit 内先以独立 machine checkpoint 执行 D1/D2：trigger 迁为只生成不可变候选，正式 feed 只接受模块 25 Release Orchestrator；consumer graph 归零后才执行 D4 | 23 | 保留无 feed 写权限的候选构建 trigger 和受保护 Release Orchestrator | 24 验证候选包不含凭据/直发脚本；25 验证无旁路 |
| Tauri/Linux target 与重复构建 workflow | 06、20—22 | 23 | Windows/macOS Electron 候选构建资产 | 24 |

### 删除闸

每个对象必须依次满足：

```text
legacy inventory
→ 新消费者接通
→ 对应 D3 reader/mapper/fixture 已由模块 22 编排验证
→ G22_PRE_D4_VERTICAL_GOLDEN_GATE（未删除版本、legacy execution fail-fast）
→ build/package input graph 核对
→ runtime consumer graph 为零
→ D4_PHYSICAL_DELETE
→ lockfile、类型、相关测试、本地 build 与受影响 Gate 旅程再验证
```

实施规则：

1. `G22_PRE_D4_VERTICAL_GOLDEN_GATE` 的 machine manifest 必须记录 Spec/Base SHA、fixture hash、实际调用链版本、旅程/状态覆盖和短错误码；所有 legacy execution entry 在 Gate 中 fail-fast，调用任一旧路线立即失败。Gate 不能 skip，不能 mock 新链自身，不能以 service 单测替代。
2. 删除必须覆盖实现、注册、测试、依赖、环境变量、部署模板、帮助和用户文案；但不得删除 Manifest 明确保留的 reader、mapper、fixture、许可证或 Core 通用机制。
3. `dist/`、`output/`、`electron-dist/` 等本地目录只有在能证明为当前构建拥有的 staging 时才清理；不得递归删除用户成果、旧数据备份或 migration manifest。
4. 删除后的 import graph、route graph、worker graph、provider graph 和 package input graph 必须重新生成；不能用换名或 compatibility shim 保留第二实现。
5. 每个 D4 Work Unit 后必须重跑该行影响的 Gate 旅程；若失败，停止后续删除并回所属模块 repair。若任一消费者、迁移 fixture、许可证或构建入口尚未归零，记录阻塞项；不得影响其他已独立闭合的 Manifest 行。

### 验收 Oracle

- 每个 Manifest 行都有删除前 consumer graph、实际删除路径和删除后 graph；保留项有可达原因。
- renderer、server、sidecar、worker、gateway、relay 的类型/相关测试和本地 build 通过。
- migration coordinator、受支持 legacy readers/mappers、旧 schema fixture 和回滚入口仍可达。
- Qwen、Whisper、桌面 Computer Use、WebSearch、TeamMem、公共 CLI/TUI 和媒体聊天中转没有正式运行时入口。
- Core 的工具、Skills、Hooks、MCP、子代理、权限、resume/compact 仍有消费者和回归证据。
- 删除不触及用户数据目录、迁移备份、Git 历史或许可文件。

### 交接物

逐行 D4 删除 manifest（`BB-23A`—`BB-23M`）、删除前后 consumer graph、保留 reader/mapper/fixture 清单、最终源码运行图、依赖/lockfile 变化、本地 build 结果和交给模块 24 的 package input 白名单；文字摘要进入 accepted commit body。

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
  → target_starting
  → confirmed_on_target_version | startup_unhealthy
startup_unhealthy
  → target_starting | recovery_required
recovery_required
  → target_starting | rollback_pending | recovery_read_only
```

不存在可由当前进程可靠观测的 `installing` 持久状态。`restart_pending` 必须在调用 `quitAndInstall` **之前**原子持久化，含 source version、target version、artifact hash、transaction ID 和 attempt ID；随后调用安装即可能立即退出。若调用在进程仍存活时同步失败，ElectronUpdaterService 以同一 attempt receipt 把状态恢复到 `downloaded_verified` 并保留错误。目标版本 Main 启动即写 `target_starting`，只有 package/version/hash/matrix、sidecar compatibility、领域存储只读检查和 renderer 首个可交互产品壳 health receipt 全部通过，才能写 `confirmed_on_target_version`。同一目标版本 10 分钟内连续两次在 health receipt 前异常退出/超时即 `recovery_required`；不得因进程曾出现就确认成功或自动再次安装。

失败语义固定：检查/下载失败回到 `idle` 并保留当前版本；下载取消回到 `available`；校验失败删除当前模块拥有的损坏下载并回到 `available`；activity gate 拒绝时保持 `downloaded_verified`；调用安装前任一步失败保持当前应用运行。

### 发包合同

1. 只构建 Windows x64 与 macOS arm64；不存在 Linux/Tauri/公共 CLI/TUI 产品 target。
2. 图标由一个透明角母版生成 icns/ico/png，各尺寸检查无白底、裁切和旧品牌。
3. package 白名单必须包含：renderer、sidecar、agent-worker、FFmpeg/ffprobe、node-pty、preview agent、Chrome Native Messaging host/wrapper、migration coordinator、支持矩阵登记的 legacy readers/mappers、必要字体和许可证。BilliardBuddy Chrome Extension 固定为 Chrome Web Store 分发的**伴随组件**，不是第三个独立 BilliardBuddy 产品或桌面 target；模块 24 同一 release manifest 必须记录正式 extension ID、最低兼容版本、商店安装入口、native host protocol version 和兼容矩阵。桌面安装包不得静默旁载扩展；扩展未安装/未启用/版本不兼容时招聘浏览器能力固定 unavailable，并引导用户从唯一商店入口安装或更新。扩展发布和真实商店安装属于 `EXTERNALLY_VERIFIED`，未验证时不得宣称 BOSS 自动执行已交付。
4. 模块 24 是所有删除对象 `D5_PACKAGE_ABSENT` 的唯一负责人：对模块 23 Manifest 逐行证明已删除运行时在 asar、unpacked resources、sidecar、更新 ZIP 和安装目录中均不存在；模块 23 的源码/输入图不能替代该证明。
5. 模块 24 只构建并保存不可变 Release Candidate artifact、hash、blockmap、签名元数据、provenance、component matrix 和 machine gate report；**不得**更新正式 manifest/feed 或退出任何已安装客户端。任一不一致使 candidate `NO_GO`。
6. 候选身份严格按第 4.12 节生成；macOS/Windows 共享同一 candidate/source tree/lockfile/policy/checklist/matrix digest，两个平台 artifact 的有序集合整体进入身份，每个平台 hash 分别登记。任一平台重新构建即使源码相同也生成新 build/provenance 和新 candidate，并要求重新门禁/验收。
7. `release-checklist.json` 的全部 machine-required 检查在候选 artifact 上执行；模块 24 只能输出 `NO_GO | GO_READY_FOR_USER`。tag push、workflow_dispatch 和上传目录切换只可使用 `BB-23L` 保留的无 feed 写权限候选 trigger；该 Work Unit 的 D4/D5 旁路证据缺失即 NO_GO，不能把 tag 当发布凭据。
8. 更新 UI 提供检查、下载、进度、取消下载、稍后安装和现在安装；所有按钮只发送带 transaction ID 的 mutation，renderer 不直接调用 `quitAndInstall`。
9. 下载可后台进行；进入 `waiting_for_safe_exit` 时通过 ProductResourceScheduler 申请 `app.update` lifecycle claim，执行 draining/checkpoint/cancel/quiesced。可恢复写入先落盘，活动最终导出和 outcome_unknown 付费任务固定阻止安装，前台 PTY要求用户确认；不能直接 stopAll/kill sidecar。
10. `ElectronUpdaterService` 只有在 transaction 为 `downloaded_verified`、scheduler quiesced 且 activity gate 通过时，才先原子写入 `restart_pending`，再立即调用 `quitAndInstall`。同步调用失败且进程仍存活时按同一 attempt 恢复 `downloaded_verified` 并解除 draining；目标版本按本节四项 health receipt 从 `target_starting` 到 `confirmed_on_target_version`，任何首次进程出现、单独 artifact version 或单独 compatibility 核验都不能确认。
11. 更新不自动降级；回退通过仍在 component matrix `rollback_floor` 内、且可读取当前 schema 的完整上一版本完成。不满足则停写并前进修复。
12. 模块 24 只消费模块 04/14 已冻结的 Gateway/Relay deployment manifest version/hash；若 ingress、service identity、secret 注入、health/preflight、compatibility overlap 或回滚证据缺失则 candidate NO_GO。
13. 源码接线、受控远程部署 manifest、candidate machine gate、USER_ACCEPTED 和真实正式发布/更新必须分层报告；模块 24 只记录前两类机器证据，不能生成或宣称 USER_ACCEPTED/GO/真实更新成功。
14. HTML 原型、验收截图、开发 secret、临时报告和未脱敏 fixture 不进入发布包。
15. `recovery_required` 由 Main 启动最小恢复壳，不启动 worker、scheduled dispatch、媒体/浏览器写入、PTY 或自动 updater，只提供：重试目标版本、导出脱敏诊断、检查回退资格、只读打开并导出数据。上一版本安装包只保留到目标版本 healthy confirmed，且必须签名/hash/provenance 验证；回退仅在 rollback floor 内且上一版本可读当前 schema 时由用户明确触发。
16. 若 schema 已提升且上一版本不可读，禁止回退，进入 `recovery_read_only`：Main 只启动统一 sidecar binary 的内部 `recovery-read-only` mode，不直接读领域文件。该 mode 与 normal server/migration 使用第 4.8 节同一原子 `DomainDataLease`，取得 mode=`recovery_read_only` 的独占 lease/fencing 后才读；normal writer 启动必须原子拒绝 active recovery lease，旧 holder 不能恢复写入。该 sidecar 禁止领域 mutation/worker/provider，只经窄 IPC 提供版本化数据导出；用户可另导出 Main 的脱敏诊断。任何 export 不覆盖原数据；恢复壳健康本身不把目标版本标 confirmed。

### 验收 Oracle

- Windows/macOS package contents 与白名单逐项匹配；模块 23 每个 Manifest 行都完成 D5 证明，保留 migration reader 可从 packaged sidecar 冷启动。
- Windows 按可用环境运行 `signtool verify`；macOS 运行 `codesign --verify`、`spctl` 和 notarization ticket 检查。缺平台或凭据时逐项标记 `NOT_VERIFIED_EXTERNALLY`，不得伪造通过。
- manifest→artifact URL/hash/size/version/blockmap 一致；损坏、错签、旧版本和部分上传 fixture 均留在当前版本。
- candidate identity/provenance fixture 覆盖 source commit/tree/lockfile/build input/package manifest/gate policy/release checklist/component matrix/platform/artifact 任一变化：生成新 candidate，旧 gate/acceptance 失效；gate report 作为不可变结果另行绑定且不能原地改写；tag/manual trigger 只生成候选，正式 feed 不变化。
- `release-checklist.json` 每个 machine required check 有 PASS 和证据 digest；FAIL/NOT_RUN/UNVERIFIED/缺失均输出 NO_GO，模块 24 无发布权限。
- component matrix 包内/运行时握手覆盖 Main-renderer-sidecar-worker、Gateway-Relay、Extension-native-host 和 migration schema；required edge 不兼容即 NO_GO。
- update transaction fixture 覆盖 scheduler draining、running worker/FFmpeg、outcome_unknown 阻塞、quiesced 安装、同步失败解除 draining、旧版本重启和目标版本确认；不重复安装。
- 从旧 schema fixture 启动安装目录中的 sidecar，模块 22 migration 可达并保持备份/回滚。
- 目标版本未完成 package/matrix、sidecar、storage-read 和首个可交互 renderer 四个 health receipt 时，报告只能写“包与更新接线已验证”，不能写“更新成功”。
- StartupHealthRecord fixture 覆盖正常健康、renderer/sidecar 在 receipt 前崩溃、10 分钟两次失败、recovery shell 不启动写服务、有效 rollback、schema 不兼容禁止回退和 recovery_read_only 数据导出；normal writer/recovery 同时启动、导出期间 writer 尝试启动、旧 fencing holder 恢复都只有一个 DomainDataLease winner，Main 从不直接打开领域文件。
- package 验证包含受控 extractor/content policy、attachment/Relay retention policy 和 DiagnosticBundleService；canary secret/PII/路径/正文无法进入诊断包，且无自动上传。

### 交接物

冻结 Release Candidate identity/provenance、双平台 artifact/package contents、component matrix、release checklist 与 machine gate report、D5 package manifest、签名/公证机器输出、update scheduler/activity fixture；状态只允许 `NO_GO|GO_READY_FOR_USER`，不写正式 feed。

---

## 模块 25：全链路验证与最终交接

**依赖：** 01—24
**模块主题前缀：** `chore: verify the single billiardbuddy product`

### 用户结果

仓库、受控部署和双平台候选形成一个可解释、可恢复、没有第二运行路线的 BilliardBuddy 产品。模块 25 只对模块 24 冻结的同一 candidate 执行最终机器重验、用户人工验收和 ReleaseDecision；没有有效 `USER_ACCEPTED` 时结果必须是 `NO_GO`。

### 模块边界

本模块只执行同一 Release Candidate 的统一机器重验、用户人工验收、receipt 验证、ReleaseDecision 和唯一正式 feed 切换，不修改候选源码、产品代码、构建输入或 artifact，也不做“最小集成修复”。模块 25 不能生成或替换候选 artifact，不能自己写 `USER_ACCEPTED`，不能用 workflow 参数、聊天文本或环境变量覆盖 gate。模块 25 的 accepted commit 只能在 GO/NO_GO 决策后追加不进入候选的发布审计索引，必须明确标为 `Release-Record-Only: true` 并绑定模块 24 的 `source_commit_sha/source_tree_sha/candidate_id`；它不是新 candidate，也不得被误当成该候选的源码提交。

若发现缺陷，主代理必须先判断缺陷属于哪个原模块或 Work Unit：合同逻辑、依赖或架构有缺口时，先由主代理修订本 Markdown 并创建新的 Spec-Commit；产品代码缺陷则回到所属原模块创建 repair Work Unit，由实施子代理修改、测试和提交。主代理接受 repair Work Unit 后重新运行受影响的验证矩阵。模块 25 不得跨域顺手修复，不得在最终验收提交中混入属于其他模块的产品代码或架构变更。

### 验收 Oracle：必须执行的验证矩阵

| 领域 | 必须证明 |
|---|---|
| 单一产品 | 一个 renderer、一个 ProductTask 产品 API/WS、一个 worker、一个媒体 service、两个桌面发布 target |
| 目标前端 | 首页、任务对话、第 3/4 栏、终端、图片、视频、经营、已安排、设置符合模块 06/10/13/16/18/20/21 的明文信息架构和交互合同；1280×720/200%/深浅主题可用；HTML 只辅助理解方向 |
| Process topology | 单一 Electron Main、单 local server sidecar、短生命周期 worker、按需 Native host、远程 gateway/relay；启动/退出、第二实例转交和各层 capability/credential 边界符合第 4.8 节 |
| ProductTask | operation/revision/event/cursor、双窗口、重复提交、断线、停止、损坏数据和协议深链 |
| Worker/Core | ready、stream、approval、stop、crash、backpressure、resume；Core 原生工具/Skills/Hooks/MCP/子代理未被削弱 |
| 模型 | DeepSeek 文本、MiMo 证据、Fun-ASR；无 Qwen/Sonnet 隐式 fallback；window/body/compact 与 model manifest 一致 |
| 指令/记忆 | 三类文件 conflict precedence、来源诊断、target-file nested、resume/compact、AutoMem 删除、本地索引、TeamMem 包内归零 |
| Voice | VoiceOperation/Transcript/immutable Revision、Composer/ThreadEntry/Video binding、编辑分叉、迟到结果、owner/lifecycle |
| Review/Preview | 文件引用、Diff、行评论、DOM selection、导航失效、高 DPI、真实文件回执 |
| 图片 | 三候选、路由、Operation kinds、unknown、mask/version/export、300 秒配置和容量 preflight |
| 视频 | ingest/evidence/plan/edit/export、source fingerprint、ASR/MiMo、锁定场景、导出产物 |
| BOSS | BrowserCapability 假页面、登录接管、ref 失效、审批、幂等、未知发送、隐私最小化 |
| Scheduled | DST、时区、休眠、logical run、通知深链 |
| Terminal | owner/cwd/env、首输出、大输出、窗口关闭和更新闸 |
| Migration | 全旧 schema fixture、备份、可重入、崩溃恢复、冷启动、migration reader 包内可达 |
| Cleanup | `G22_PRE_D4_VERTICAL_GOLDEN_GATE` 未删除版本通过；每个 D4 Work Unit 后重跑受影响旅程；D1—D5 逐行证据、保留 reader/许可证、无 compatibility shim 或第二运行时 |
| Compatibility | Main/renderer/sidecar/worker/Gateway/Relay/Extension/native-host/provider/migration required edge 均按同一 component matrix 握手；N-1/N rollout 与 rollback floor 可验证 |
| Resources | ProductResourceScheduler 的 desktop/gateway/relay scope、profile、priority/fairness、bytes、lease/fencing、cancel/drain/overload；worker/schedule/FFmpeg/ASR/vision/image/browser/migration/update 无第二调度真相 |
| Release decision | candidate identity/provenance 不变；required machine/user checklist 全 PASS；有效 USER_ACCEPTED receipt 绑定同一 artifact；无 tag/manual/feed 旁路 |
| 隐私 | 日志、包、fixture 和错误 UI 无密钥、Cookie、正文、Base64、候选人隐私和绝对路径 |
| Task lifecycle & attachments | active/archive/restore/deleting/delete_failed/deleted、引用阻塞、崩溃续删；staged/ready/bound、7天/1小时/24小时 TTL、容量/orphan/ref graph、外部文件不删 |
| Untrusted content | Preview CSP/partition/Node/导航/下载/协议；extractor 无网络/secret/write，ZIP bomb/巨大 PDF/畸形图片媒体、FFmpeg timeout/memory/temp/output 全 fail-closed |
| Workspace | 同卷移动、跨卷/根替换/relink、Git/non-Git、IDE 外改 stale、只读/断盘、managed worktree 丢失；无旧引用落错根 |
| Retention & privacy | Relay 24小时输入/7天输出/30天 unknown-audit 与 durable ack/purge；招聘 15分钟 evidence/7天 unknown payload/30天 audit，PII 不进 prompt/log/diagnostics |
| Update recovery | target_starting 四项 health receipt、10分钟两次失败、最小 recovery shell、rollback floor/schema gate、不可回退只读导出 |
| Diagnostics | 用户显式、无自动上传、7天/5MiB allowlist；HMAC ID、manifest/hash、canary prompt/path/Cookie/secret/attachment/PII 全排除 |

### USER_ACCEPTED 与正式发布步骤

1. 先重新计算 candidate、artifact、gate report、component matrix 和 checklist digest；任何变化立即 `NO_GO`，返回模块 24创建新候选。
2. 对 `release-checklist.json` 中所有 user-owned required 项逐项在对应候选安装包执行。至少覆盖 Windows/macOS 首次启动、核心黄金旅程、视觉/交互、升级/回滚、权限、性能阈值和候选 policy 声明的真实外部能力。结果与证据不能复用其他 candidate。
3. 向用户展示 candidate ID、两个 artifact hash、machine gate 摘要、人工检查结果、`OUT_OF_SCOPE_DISABLED` 能力和已知风险。只有用户本人通过受保护验收入口明确选择 `USER_ACCEPTED`，才写不可变 receipt；聊天中的“看起来可以”“提交吧”不构成 receipt。
4. 用户选择拒绝或任一人工 required 项 FAIL/NOT_RUN/UNVERIFIED，写 `USER_REJECTED`/NO_GO；该 candidate 终结，修复后创建新 candidate。
5. Release Orchestrator 验证 receipt identity/role/signature/expiry 与全部 digest 后写唯一 `GO`，再次校验上传文件 SHA-256，原子切换正式 manifest/feed。发布中断时旧 feed 保持；不能出现部分平台先公开。
6. 正式切换后保存 release decision/provenance/receipt/manifest digest，并执行目标版本真实启动确认。receipt 到期、撤销只影响尚未发布 candidate；已发布版本通过新的撤回/回滚决策处理，不篡改历史。

### 最终完成条件

1. `release-checklist.json` 的所有 required machine/user 检查均为 PASS，证据 digest 与同一 candidate 匹配；任何 FAIL/NOT_RUN/UNVERIFIED 都不得 complete/GO。
2. 所有删除 Manifest 项完成 D4/D5，或因明确 reader/migration/许可证合同保留；不存在“以后可能复用”的正式运行时代码。
3. 最终安装包仍包含模块 22 的 migration coordinator、支持矩阵登记的 legacy readers 和回滚入口。
4. 所有 `REQUIRED_FOR_RELEASE` 外部项已绑定同一 candidate 真实验证；未验证能力只能在候选 policy 预先标为 `OUT_OF_SCOPE_DISABLED` 且包内入口确实禁用，否则 NO_GO。
5. 有效 `USER_ACCEPTED` receipt、全部 candidate/gate/matrix/checklist/artifact digest 和正式 ReleaseDecision=GO 均可验证；正式 feed 只包含该候选。
6. 最终 release-record-only accepted commit body 包含：`Release-Record-Only: true`、Module-Status、模块/Work Unit SHA、模块 24 的 source commit/tree、candidate/release decision ID、包清单、compatibility/migration 支持版本、resource profile、D1—D5、验证摘要和禁用范围；该提交只能索引已存在的受控机器证据，不得修改候选输入、正式 feed 或 receipt。机器细节保存在受控 manifest/receipt/build provenance 中，不另建 Markdown 报告。

### 最终代码形态（逻辑职责，不是强制目录迁移）

```text
BilliardBuddy Electron GUI
  ├─ Electron Main（单实例、本地 capability、sidecar/updater/PTY/OS 生命周期）
  ├─ current React renderer（只经 preload IPC + authenticated local API/WS）
  ├─ one Local Product Server sidecar
  │  ├─ ProductTask service / API / WebSocket
  │  ├─ MediaProjectService → provider-neutral ImageGeneration / local FFmpeg
  │  ├─ VoiceService → SpeechTranscription + global TranscriptRevision
  │  ├─ RecruitingService / ScheduledTaskService / migration coordinator
  │  └─ Session Supervisor → ephemeral agent-worker → CC-Haha Core
  ├─ provider-neutral DeepSeek / MiMo / GPT Image 2 / Seedream / Fun-ASR adapters
  ├─ Chrome companion → Native Messaging host → ChromeSessionBridge
  ├─ remote Gateway → Relay（独立部署，不由 Electron 启动）
  └─ supported legacy readers + rollback
```

这棵树只表示职责。默认沿用当前真实目录；不得为了让目录名看起来像示意图而整体搬迁 `server/services`、Core 或 media 文件。

### 交接物

最终 release-record-only accepted commit body、ReleaseDecision、USER_ACCEPTED receipt、candidate/provenance/gate/checklist/component matrix digest、01—24 机器证据索引、模块/Work Unit SHA、包清单、migration/resource profile、D1—D5 和正式 feed manifest；commit body 必须绑定模块 24 的 source commit/tree 且不改变 candidate，不新建最终报告 Markdown。
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
