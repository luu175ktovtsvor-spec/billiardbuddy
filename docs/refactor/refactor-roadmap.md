# BilliardBuddy 重构施工路线图

## 1. 这份文档解决什么问题

本文的首要读者是继续开发本仓库的智能体。它只回答三件事：现在先做什么、为什么必须先做、用什么证据才能进入下一模块。长期产品结果与总体架构仍由 `BilliardBuddy-重构合同.md` 裁决；当前 Agent 模块的具体施工边界由 `docs/refactor/agent-harness-construction-direction.md` 说明；专题 `*-reference-change.md` 只保存参考与改动证据，不得反向改变路线顺序。

OpenAI 的长期工作文档建议用 **Outcome、Constraints、Verification** 定义可持续目标，而不是只罗列活动。BilliardBuddy 的每个施工模块也固定使用这三个字段：

- **Outcome**：用户或产品最终得到的可观察结果；
- **Constraints**：唯一权威、兼容边界、安全要求以及明确不属于本模块的内容；
- **Verification**：哪些当前代码、生产调用链、失败/恢复路径和构建证据能够证明结果成立。

官方参考：[Long-running work](https://learn.chatgpt.com/docs/long-running-work.md)。

路线图中的 R0—R11 是全局依赖模块，不是一次交给编程 Agent 的宽任务。真正施工时每次只允许一个 **active work unit**，并且必须同时写清：

1. 唯一 Outcome；
2. 当前代码与参考证据；
3. 本点的 Constraints 与明确不改的内容；
4. 允许修改的文件和权威边界；
5. Verification 与退出证据；
6. 证据成立后的唯一下一游标。

新发现的其他缺口只记录到它所属的后续模块，不立即跳线修改。只有错误结果、数据丢失、重复副作用、权限越界或无法恢复可以中断当前游标。

每次移动游标时，用下面这张固定施工单替换“当前施工游标”，不能只写一句宽泛任务：

```text
Work-unit 格式: R?/A?/M? — 单点名称
Outcome: 本轮唯一要形成的产品或架构结果
Evidence: 必读参考、当前入口和需要追踪的真实调用链
Constraints / Non-goals: 本轮明确不能顺手处理什么
Allowed scope: 唯一允许写入的权威边界和文件范围
Verification / Exit: 哪些静态、构建、运行、失败或恢复证据全部成立才算退出
下一游标格式: 退出后唯一允许进入的下一点
```

## 2. 已关闭的总架构裁决

### 2.1 产品形态

Codex 桌面 GUI 与 CLI TUI 是同一 Agent Core 的两种客户端；桌面端通过 `codex app-server` 的 Thread / Turn / Item 协议使用 Core，不解析终端文本。BilliardBuddy 采用同一种职责形态：

```text
Desktop Renderer
  → Product Server / Authority（App-Server-like 产品协议）
  → Agent Worker / Harness Core（唯一 Agent 运行时）
  → Provider Adapter / Gateway model port
```

### 2.2 当前运行时选择

当前官方 Codex commit `4642370542739d5dd080b0c87a9de06a6435d3db` 的 `WireApi` 只保留 Responses，并明确拒绝 `wire_api = "chat"`。BilliardBuddy 还要忠实支持 Responses、OpenAI-compatible Chat Completions 与 Anthropic Messages，直接把 Codex Rust App Server 设为唯一运行时会丢失已承诺协议能力；同时运行 Rust Core 与 TypeScript Core 又会形成双重会话、工具和恢复权威。

因此当前裁决已经关闭：

1. 只保留一套 BilliardBuddy Agent Core / Worker；
2. Codex Core、App Server、Protocol 与 Prompts 是语义规范和可移植源码来源；
3. 多供应商差异只进入 Provider Adapter，不进入 ProductTask、Agent Loop、工具权限或恢复；
4. 只有当官方运行时以后完整覆盖本产品协议与状态边界，才重新开启直接替换评估；现阶段不反复重做这项选择。

证据见 `docs/refactor/codex-agent-core-reference-change.md` 与 `docs/refactor/codex-cli-client-backend-verification.md`。

## 3. 文档权威链

| 文档层 | 只负责什么 | 不负责什么 |
| --- | --- | --- |
| 根 `AGENTS.md` | 每个仓库任务都要遵守的热路径开发规则 | 不记录产品模块、施工状态或长篇实现设计 |
| `BilliardBuddy-重构合同.md` | 产品愿景、长期边界、模块关系和完成定义 | 不保存逐轮流水和临时缺口列表 |
| 本文 | 全局依赖顺序、当前施工游标和模块进入/退出条件 | 不重复各领域的全部实现细节 |
| 当前模块施工总纲 | 当前唯一模块的内部顺序、权威边界和完成标准 | 不替其他模块排期 |
| 专题参考—改动文档 | 一项能力的参考事实、真实差异、改动和验证证据 | 不宣布整个模块或产品完成 |
| 运维/发布文档 | 当前服务器、部署、构建与发布事实 | 不决定产品架构 |

出现冲突时，先按上表确定文档职责，再更新错误文档；不能用较旧、较细的专题记录推翻新的产品合同或路线图。

### 3.1 开发智能体读取与执行协议

任何新的开发智能体进入本仓库后，按以下顺序建立上下文：

1. 读取根 `AGENTS.md`，只取得每次任务都需要遵守的仓库规则；
2. 读取 `BilliardBuddy-重构合同.md`，取得产品结果、总体架构和不可跨越的权威边界；
3. 读取本文的“当前施工游标”，只取得一个 active work unit；
4. 只读取该单元指向的模块总纲、参考证据和允许范围内的当前源码；
5. 先证明当前调用链和状态所有者，再决定保留、移动、替换或删除；不得从目标目录名反推当前实现；
6. 完成退出验证后，先更新证据和游标，再开始下一项。

其他模块即使发现明显可优化点，也只记录到对应模块的后续清单。文档不是要求智能体一次理解并修改整个系统的超长 Prompt，而是用合同保存稳定主题、用路线图提供唯一游标、用模块总纲提供当前局部上下文。模型不需要知道的额度明细、服务器秘密、供应商私有配置和其他工作台内部状态不得塞入 Agent 系统提示词；这些事实由代码合同与 Host 权限保证。

## 4. 目标软件架构

### 4.1 架构形态裁决与参考链

当前最合理的目标是 **模块化单体 + 明确进程边界 + 远端控制面**。这不是抽象偏好，而是以下证据的共同结果：

参考关系必须分清：Codex 直接提供 Agent Core、App Server 协议、桌面 Host 连接和 Provider/账户分层的实现基线；Bounded Context 与 Ports/Adapters 提供按业务真相和依赖方向拆分的方法；BilliardBuddy 当前代码、数据生命周期、本地/远端安全边界和三条用户旅程最终决定本项目的模块边界。后两层是基于事实的产品架构推理，不冒充 Codex 原目录，也不因为“行业通常会拆”就先拆代码。

| 证据 | 证明什么 | 对 BilliardBuddy 的裁决 |
| --- | --- | --- |
| Codex 官方 Core、App Server、Protocol 与本地客户端 `raw`、`reverse-readable`、`host-bridge` | GUI、客户端协议、Agent Core、Host 与账户/Provider 可以分层，但不需要复制多套 Agent | 桌面只消费 Product Protocol；本地只保留一套 Agent Core；Host、Provider 和账户/额度通过端口接入 |
| Bounded Context 与 Ports/Adapters 的职责方法 | 模块应围绕独立业务真相、变化原因和依赖方向形成，而不是围绕技术名词或文件大小形成 | Agent、Image、Video 各自拥有领域状态；外部系统只通过 Port 实现，不反向成为业务权威 |
| 当前 `taskService.ts`、`productAgentHarness.ts` 及 `product/`、`agent-worker/`、`services/` 的双向引用 | 当前问题不是功能少，而是状态所有权、用例编排和适配职责互相穿透 | 先证明调用链和所有权，再按业务事务迁移；不能按旧目录或大文件行数机械切割 |
| Electron 桌面、本地文件/进程/FFmpeg/凭据和远端模型/额度/异步任务的真实运行差异 | 安全、故障与资源边界确实需要少量独立进程，但多数业务模块不需要独立部署 | 本地保持一个产品级模块化系统；只把 Host、Worker、Gateway 和远端执行器放到必要的进程边界 |
| Agent、图片、视频拥有不同项目、任务、资产、恢复和交付结果 | 三条线共享底座，但不能共享同一业务状态机 | 建立三个同级业务域，通过稳定 Port 协作，不把图片/视频塞进 Agent Harness 内部 |

“最合理”只针对当前产品事实成立，不是永远不可修改。只有新的生产证据证明某个模块需要独立扩缩容、独立故障域、独立安全权限或独立发布节奏时，才重新评估进程/服务拆分；不能以框架潮流、文件数量或未来想象重新打开已关闭裁决。

### 4.2 三个同级业务域

BilliardBuddy 只把直接拥有用户任务与作品状态的模块定义为业务域：

| 业务域 | 自己拥有的真相 | 不拥有的内容 |
| --- | --- | --- |
| Agent | Thread、Turn、Item/Event、Agent Session、模型—工具循环、上下文、权限、进程、停止、恢复、Skills、Plugins、MCP、Hooks、协作与 Review | 不拥有图片项目、视频时间线、供应商 Key、运营额度或桌面窗口状态 |
| Image | 图片项目、Brief、素材、生成任务、候选、蒙版、编辑、版本、质检、领取与导出 | 不复用 Agent Thread 充当图片项目，不拥有 Gateway 物理容量 |
| Video | 视频项目、素材、完整帧域与声音证据、方案、时间线、字幕、配音、预览、渲染、版本与导出 | 不复用 Agent Turn 充当渲染任务，不让 LLM 直接拥有时间线或文件写入 |

三者是同级、独立、可单独演进的业务板块。它们可以通过明确合同请求共享能力，但不能直接读取彼此的仓储、Service 或内部状态机。Agent 可以调用图片或视频的公开能力端口，但调用结果仍分别落入对应业务域的权威任务；这不把三个域合并成一个 Harness。

### 4.3 支撑层不是第四个业务域

- **Desktop Shell**：窗口、导航、命令、通知、设置入口和三个业务域的公开投影；不裁决业务终态。
- **Local Runtime**：Electron Main/Preload、文件系统、Shell/PTY、进程、FFmpeg、系统凭据和桌面 Host；只实现业务端口。
- **Remote Platform**：Gateway、Relay、能力路由、托管模型、额度、容量和远端 operation 结果；不拥有 ProductTask 或媒体项目。
- **Shared Kernel**：不透明 ID、时间、事件信封、有限校验、operation 围栏和真正跨域的基础合同；不得导入任何业务域。

“共享”只表示稳定机制可以复用，不表示把所有代码继续放进 `product/`、`services/` 或一个大 Service。任何只被一个业务域使用的类型、状态机、仓储和策略都回到该业务域。

### 4.4 进程与部署拓扑

| 边界 | 拥有什么 | 为什么独立 | 不能拥有什么 |
| --- | --- | --- | --- |
| Desktop Renderer | 有界输入草稿、视图状态、公开 Projection | 浏览器权限最低，便于渲染和交互 | 任务终态、Key、文件系统任意权限、额度账本 |
| Electron Main / Preload | 窗口、系统凭据、受控 IPC、安装生命周期和桌面 Host 能力 | 操作系统权限与 Renderer 必须隔离 | Agent Thread、媒体项目状态机、供应商业务真相 |
| Local Product Server | 三个业务域的 Application、Authority、仓储入口和公开协议；受信个人模型 Host 只在请求时使用 Main 注入的本机凭据 | 本机项目与恢复需要一个稳定权威，多个窗口共享 | Renderer 临时状态、Key 持久副本或公开投影、远端额度权威 |
| Agent Worker / 受控工具进程 | 单次 Run 的模型—工具循环、隔离执行和可回收进程资源 | 长任务、工具副作用与宿主崩溃需要隔离 | ProductTask 最终裁决、长期凭据、第二份任务仓储 |
| 本地媒体工具链 | FFprobe/FFmpeg 解码、预览、渲染和导出 | CPU/内存/进程负载与 Agent 不同，可独立取消回收 | 远端模型额度、图片/视频项目终态 |
| Remote Gateway / Relay | 托管身份、额度、运行策略、供应商凭据、容量和远端 operation | 秘密、成本控制、跨用户容量与异步任务必须在服务器 | 本地 Thread、项目、时间线、桌面导航 |
| 必要远端执行器 | 已受理的长耗时供应商任务和结果物化 | 需要独立排队或扩缩容时才存在 | 公网客户端协议、另一套额度或用户身份 |

这些是运行边界，不要求一一对应代码仓库或目录。Image/Video 业务域可以同时使用 Local Product Server、媒体工具链和 Remote Gateway；同一业务域跨进程时仍只有一个领域权威，通过 operation、回执和事件维持单向状态流。

### 4.5 每个业务域内部的固定分层

每个域按同一依赖方向组织，但不强制机械复制文件名：

```text
Client / Desktop Feature
  ↓ 只消费公开 Projection 和 Command
Projection / API
  ↓
Application（Use Case、编排、事务与恢复）
  ↓
Domain（实体、值对象、状态机与不变量）
  ↑
Ports（仓储、模型、工具、Host、远端能力接口）
  ↑
Infrastructure Adapters（SQLite/文件、Worker、Electron、Provider、Gateway）
```

依赖规则固定如下：

1. Domain 不导入 Electron、HTTP、供应商 SDK、React、文件路径或另一个业务域；
2. Application 只通过 Ports 使用外部能力，并拥有一次用户动作的事务、幂等和恢复编排；
3. Infrastructure 实现 Ports，不能把供应商返回体或进程状态提升为业务真相；
4. Projection/API 只能把权威状态公开给客户端，不能反向发明第二套状态机；
5. Client 只保存有界界面草稿和视图状态，不能拥有任务终态；
6. 跨域协作通过公开 Command、Query、Event 或 Capability Port 完成，不直接 import 对方内部 Service。

目录名称可以随实际迁移调整；以下只是目标所有权示意，不是冻结实现：

```text
ts/src/domains/agent/{domain,application,ports,infrastructure,projection}
ts/src/domains/image/{domain,application,ports,infrastructure,projection}
ts/src/domains/video/{domain,application,ports,infrastructure,projection}
ts/src/platform/{desktop,local-runtime,remote-client}
ts/shared/{kernel,contracts}
ts/desktop/src/{shell,features/agent,features/image,features/video}
```

### 4.6 模块抽取判断表

| 问题 | 是时怎么处理 | 否时怎么处理 |
| --- | --- | --- |
| 是否拥有独立业务不变量、状态机和生命周期？ | 形成业务域或域内聚合 | 留在现有用例或普通模块 |
| 是否拥有唯一数据写入权威和恢复责任？ | 抽出 Authority/Repository Port | 不为只读 helper 建第二份仓储 |
| 是否因安全、凭据或 OS 权限必须隔离？ | 建立 Host/IPC/进程边界 | 只做代码模块，不增加进程 |
| 是否需要独立故障、取消、资源保护或扩缩容？ | 建立 Worker/Executor 边界与持久 operation | 保持同进程调用，减少分布式状态 |
| 是否会由不同原因独立替换？ | 通过 Port 接 Adapter，例如 Provider、Gateway、FFmpeg | 若必须同步变化，优先保持内聚 |
| 拆分后是否仍需双向 import、共享可变状态或同步两份真相？ | 拆分无效，重新确定唯一所有者与单向合同 | 边界可以保留 |

禁止按照名词数量创建模块，禁止把每个类都包装成 Service，禁止为了追求小文件引入只转发参数的层，禁止让 `shared` 成为无法归属代码的收容所。允许一个高内聚文件暂时较大；只有当它包含多个不同写入权威、不同恢复事务或不同替换原因时才拆。

### 4.7 当前代码的真实结构缺口

当前代码已经拥有大量可复用能力，但物理边界仍未收口：

- `ts/src/server/product/taskService.ts` 约 8,869 行，同时聚合任务接纳、运行、队列、投影、恢复和多种产品接线；
- `ts/src/server/agent-worker/productAgentHarness.ts` 约 2,367 行，同时承载 Session、Prompt、Context、模型采样、工具循环、压缩、Hook 和持久化协调；
- Agent 状态和合同横跨 `ts/shared/product/`、`server/product/`、`server/agent-worker/` 与 `desktop/src/product/`；
- 图片、视频的领域能力主要散落在通用 `server/services/` 和桌面通用 Store 中，目录形状没有表达三条业务域的真实所有权。

文件很大不是单独缺陷，真正缺陷是一次变化会同时触碰多个权威边界，并且无法从目录和类型依赖直接判断谁拥有状态。拆分必须按**业务不变量、写入权威和用例事务**进行，不能只是把大文件机械切成更多 helper。

因此当前最有用的代码工作已经确定为 R2/A0.1：先只画出 Agent 正式调用链。调用链证据闭合后，再依次完成状态所有权地图、目标依赖边界和物理收口；不把这四种判断塞进同一轮，也不在边界未清楚时继续向大 Service 添加能力。

## 5. 全局依赖图与严格施工顺序

```text
R0 文档与架构收口
  ↓
R1 共享产品内核
  ↓
R2 Agent Core / Harness
  ↓
R3 模型接入与使用权控制面
  ↓
R4 Agent 桌面客户端闭环
  ↓
R5 生图工作台闭环
  ↓
R6 视频工作台闭环
  ↓
R7 跨工作台桌面壳收口
  ↓
R8 旧代码、迁移与依赖收口
  ↓
R9 软件层完成审计
  ↓ 用户最终确认
R10 生产部署
  ↓
R11 桌面构建、自动更新与发布
```

这是一条依赖顺序，不是时间估算。已有代码不等于对应模块完成；进入某模块后先盘点并复用合格实现，再修正、替换或删除。除非发现更高优先级的数据丢失、重复副作用、权限越界或无法恢复问题，否则不跨模块插入功能。

## 6. 模块卡片

### R0 文档与架构收口

- **Outcome**：任何新会话都能从合同、本文和当前模块总纲得到同一产品结构、同一当前目标和同一下一步，不再从几十份专题文档猜施工顺序。
- **Constraints**：不把历史流水改写成当前裁决；不在 `AGENTS.md` 堆产品细节；不以文档模块名冻结代码目录。
- **Verification**：合同已裁决“模块化单体 + 明确进程边界 + 远端控制面”；本文明确直接参考、架构方法与本项目推理的区别，拥有唯一全局游标和开发智能体读取协议；Agent 总纲拥有唯一当前模块内部顺序；冲突的 App Server、Gateway、微服务化和机械拆文件方向已经关闭。

### R0.2 模块施工与提交收口

- **Outcome**：现有混合工作树被明确视为待分类资产；后续每次只有一个 active work unit，按差异块归属、独立核验、独立提交，附属文档只记录证据。
- **Evidence**：`docs/refactor/module-commit-protocol.md`、`docs/refactor/worktree-module-inventory.md`、当前 `git status` 与暂存区快照。
- **Constraints / Non-goals**：不重置或覆盖已有改动；不把历史“已完成”记录当作代码完成；不在本单元改写 Agent、图片、视频或发布实现。
- **Allowed scope**：模块施工协议、路线图当前游标、工作树归属盘点和核验账本的 R0 记录。
- **Verification / Exit**：权威顺序、施工单格式、脏工作树拆分规则、暂存门禁和提交语义写入单一文档；全库只有一个 active work unit；本单元只提交 R0 文档，不带代码或其他模块差异。
- **Next cursor**：R1.1 — 共享产品内核的权威边界回溯核验。

### R1 共享产品内核

- **Outcome**：Agent、图片和视频共用稳定身份、持久事件、operation 围栏、能力目录、设置、凭据边界、迁移入口和本机 Host 通道，但各领域状态仍由各自 Authority 拥有。
- **Constraints**：共享的是基础机制，不共享工作台状态机；renderer、Gateway、供应商和临时进程不能成为第二份业务真相。
- **Verification**：每类身份与状态只有一个写入权威；进程中断、重复请求、迟到结果和结果未知都有确定归属；旧共享模块没有并行入口；Server/Electron 类型、生产构建和源码可达性成立。

### R1.1 Shared Kernel 资源与执行合同

- **Outcome**：跨 Agent、图片和视频共用一份进程无关的资源调度合同与一份持久调度实现；资源租约、fencing、幂等重复观察和队列容量不再由业务域各自定义。
- **Evidence**：`ts/shared/kernel/resourceScheduler.ts`、`ts/src/server/product/resourceScheduler.ts`、`ts/src/server/product/resourceProfiles.ts` 及仍未迁移消费者的单一兼容转发文件 `ts/shared/product/resourceScheduler.ts`。
- **Constraints / Non-goals**：本轮不迁移 Agent Authority、模型额度、安装身份、设置或媒体领域状态；兼容转发不得包含第二份类型、状态或实现。
- **Allowed scope**：Shared Kernel resource scheduler、桌面 Host resource profile、其服务端实现和对应核验记录。
- **Verification / Exit**：类型检查、生产构建、源码可达性和暂存差异证明只有 Kernel 实现拥有资源合同；旧路径只能转发；重复结果、跨进程 lease 和同进程并发 mutation 保持确定语义。
- **Next cursor**：R1.2 — 共享身份、能力目录、设置与迁移入口。

### R1.2 共享身份、能力目录、设置与迁移入口

- **Outcome**：稳定 installation id、可轮换匿名安装会话、能力降级、受信凭据存储和可回滚存储升级由本机共享控制面承担；公开安装包不携带激活凭据或 License。
- **Evidence**：`gateway/installationAuth.ts`、`gateway/app.ts`、`ts/desktop/electron/services/installationSession.ts`、`productConfig.ts`、`serverRuntime.ts`、`ts/src/server/services/gatewayAccessTokenRuntime.ts`、`productCapabilitySnapshot.ts`、`productStorageMigrations.ts`。
- **Constraints / Non-goals**：不改变 Agent Model Port、个人模型执行、额度账本、媒体项目状态或桌面壳体验；Renderer、Agent Worker 和公开安装包不得获得 refresh token、Gateway access-token capability 或任何可复用密钥。
- **Allowed scope**：安装身份/会话、匿名 Gateway 主体、公共 Gateway 配置、受信 bearer 热更新、能力目录降级、设置凭据恢复、迁移入口和 R1.2 证据记录。
- **Verification / Exit**：安装启动不等待 Gateway bootstrap；过期或损坏会话可静默恢复；Gateway 只从验证后的匿名 installation principal 结算；token 更新只接受 Main 注入的一次性 capability；设置/迁移保持原子写入、文件锁和 rollback journal；Server/Desktop 类型检查、生产构建、源码可达性和暂存差异全部通过。
- **Next cursor**：R2.1 — Agent Harness Authority 与 Worker/Host 生产调用链。

### R2 Agent Core / Harness

- **Outcome**：一个模型无关 Agent Core 持续完成 Thread / Turn / Item、模型—工具循环、上下文、权限、停止、恢复、扩展、协作和审阅；更换模型只改变适配器，不改变 Agent 行为合同。
- **Constraints**：以 Codex Core/App Server/Protocol/Prompts 为主规范；不保留旧 Honey、旧 Core 或供应商专用会话；当前不直接嵌入 Responses-only Codex Runtime。
- **Verification**：按第 7 节顺序逐项收口；每项只有一条 Worker—Host—Authority 生产链；错误与恢复语义不靠 renderer；已替代入口退出；类型、生产构建、源码审计与最终差异检查通过。真实模型效果仍在软件层最终验收单独确认。

### R3 模型接入与使用权控制面

- **Outcome**：同一 Agent Core 通过同一 Model Execution Port 使用托管额度或个人 API Key；两种来源只改变凭据、费用承担方、Provider 和额度投影，不改变 Agent 能力与工作面。
- **Constraints**：Gateway 只拥有托管身份、额度、运营路由、物理容量和远端 operation；个人 Key 只留在本机受信 Host；Agent Core 不计算额度；Renderer 不保存 Key 或复制账本；媒体工作台继续只用托管能力。
- **Verification**：managed/personal 从同一 Port 进入并产生同一 Harness 结果；托管额度在上游调用前准入；个人请求不经 Gateway；已受理结果可回放与 ACK；更换托管策略不发布客户端。详细顺序见 `docs/refactor/codex-managed-and-personal-model-architecture.md`。

### R4 Agent 桌面客户端闭环

- **Outcome**：BilliardBuddy GUI 像 Codex App 一样完整消费同一 Agent Core：项目、任务、消息、活动、计划、队列、审批、审阅、进程、Diff、侧任务、恢复和错误都来自结构化权威事件。
- **Constraints**：复用 Codex 信息架构与交互，但不运行其已编译前端 bundle、不展示参考品牌、不建立 renderer 业务状态副本。
- **Verification**：每个可见动作都有真实 Product Server/Host 消费者；刷新、断线、重启和多窗口投影一致；没有静态演示状态；桌面类型与生产 renderer 构建成立。

### R5 生图工作台闭环

- **Outcome**：用户从 Brief 和参考素材建立持久图片任务，得到真实候选，完成比较、编辑、蒙版、版本、质检、领取和导出。
- **Constraints**：图片项目、任务、资产与版本是独立领域；模型和额度由 Gateway 能力目录控制；同项目未确认付费 operation 受限，不用工作台全局锁阻止其他项目。
- **Verification**：提交、排队、状态唤醒、结果领取、本地提交、ACK、未知结果和恢复是一条持久链；项目切换不串状态；失败不会重复付费调用；旧图片路径退出。

### R6 视频工作台闭环

- **Outcome**：用户导入真实素材，得到完整帧域与声音证据，在可编辑时间线中形成方案、预览、配音、渲染、版本和最终导出。
- **Constraints**：视频项目、证据、时间线和渲染拥有独立 Authority；视觉批次大小不等于总抽帧上限；最终渲染留在本机；LLM 只提出结构化建议，不直接拥有 TTS、时间线或文件写入。
- **Verification**：逐帧/镜头证据、ASR、声音理解、规划、时间线、预览和导出都有持久中间状态及恢复；取消、崩溃和已有目标文件不会造成重复调用或覆盖；旧视频路径退出。

### R7 跨工作台桌面壳收口

- **Outcome**：Agent、图片和视频共享一致的导航、设置、通知、能力状态、诊断、窗口恢复、中文交互和资源管理，同时保持三个领域任务互不锁死。
- **Constraints**：只统一真正共享的桌面行为，不把三种任务合并成一个状态机；页面挂载不决定后台任务是否被观察。
- **Verification**：跨项目后台任务持续对账；通知和未查看状态去重；设置跨窗口收敛；项目级错误不串线；所有工作面从同一壳层恢复且不复制领域真相。

### R8 旧代码、迁移与依赖收口

- **Outcome**：正式构建只剩一套 BilliardBuddy 运行路径，受支持旧数据仍可迁移，无消费者代码、旧品牌、旧页面、旧 Server、旧 Store、测试资产和安装包污染退出。
- **Constraints**：按消费者和升级支持范围删除，不按来源或文件名删除；许可证要求随真实复用代码保留；参考源码不进入运行时和安装包。
- **Verification**：入口、import、脚本、依赖、构建资源、存储 reader 和安装资源逐项有消费者证明；迁移提交后正常运行不再读取旧源；源码可达性和安装资源清单一致。

### R9 软件层完成审计

- **Outcome**：三条用户旅程和共享底座没有已知会导致错误结果、数据丢失、重复副作用、权限越界或无法恢复的代码缺口。
- **Constraints**：不把类型通过、页面存在或未发现问题冒充真实效果；当前仓库不编写或运行自动化测试。
- **Verification**：逐模块核对 Outcome、Constraints、Verification；检查正式调用链、失败和恢复窗口、被替代路径、类型、生产构建、静态审计和差异；需要真实模型或真机才能证明的事项单独列为未验证并交给用户最终确认。

### R10 生产部署

- **Outcome**：用户确认软件层后，唯一服务器以 Docker/Nginx/HTTPS 运行与仓库合同一致的 Gateway、Relay 和必要执行器，运行策略、凭据、目录、监控和恢复事实清楚。
- **Constraints**：部署不能反向决定产品架构；服务器 operator-owned 策略不被普通软件发布覆盖；不在软件层未确认时提前部署。
- **Verification**：仓库与服务器版本、Compose、端口、路由、健康、容量、凭据引用、持久目录和运行文档一致；生产差异被明确处理。

### R11 桌面构建、自动更新与发布

- **Outcome**：在软件与生产部署确认后，Windows x64 安装包可安装、保留用户数据并通过生产服务器更新；macOS 代码能力保留，签名条件具备后再正式启用发布链。
- **Constraints**：打包永远排在软件完成之后；构建产物不是 Docker 镜像；更新应用程序文件，不覆盖用户数据目录。
- **Verification**：平台构建来源、签名、产物哈希、更新元数据、版本、下载地址、升级中断与回退事实进入发布记录；没有用户确认不进入正式发布。

## 7. R2 Agent Core 的内部严格顺序（仅在 R2 被路线图选中时使用）

R2 被路线图选中时，内部不按“看到一个缺口就补一个功能”跳转：

| 顺序 | 子模块 | 清晰目标 | 进入下一项的条件 |
| --- | --- | --- | --- |
| A0.1 | 正式调用链证据 | 只追踪 `ProductTask → TaskRun → Worker → Harness → model port → Event`，列出每个转换的当前入口、输出和消费者；不同时搬代码 | 可从正式 API 一路追到事件重放，每一跳都有文件与符号证据 |
| A0.2 | 状态所有权地图 | 只判定每类状态的唯一写入者、读取者和恢复者 | ProductTask、Run、Session、Tool、Process、Provider 和 Projection 都有且只有一个权威归属 |
| A0.3 | 目标依赖边界 | 只定义 Domain / Application / Ports / Infrastructure / Projection 的依赖方向与迁移批次 | 每个现有模块都有目标所有者，不出现循环依赖或“通用 Service”逃避归属 |
| A0.4 | 物理边界收口 | 按 A0.3 批次移动职责、收窄依赖并删除并行入口，每次只改一个权威边界 | 正式生产链与所有权地图一致，每个运行阶段可从代码与目录直接定位 |
| A1 | Thread / Turn / Item / Event Authority | 接纳、队列、Item 生命周期、分页、分叉、归档和重放只有一份权威 | renderer 与 Worker 都不能绕过 Authority 写产品真相 |
| A2 | Session、Prompt、Context 与 Model Port | 冻结系统指令、项目指令、历史、附件、压缩、模型能力与预算；Provider 只通过 model port 采样 | 恢复同一 Run 不读取后来变化的默认值，不丢多模态或供应商私有续接状态 |
| A3 | Tool Runtime、Host、权限与进程 | 工具发现、延迟加载、审批、沙箱、文件、Shell、长进程和结果闭合只有一个执行权威 | 模型不能自行授予权限；所有副作用都能确定完成、停止或结果未知 |
| A4 | Turn 控制与恢复 | steer、queue、stop、interrupt、continuation、compaction、崩溃和重复派发遵守单调状态机 | 任一中断窗口不会盲重跑模型、工具或 Hook |
| A5 | 扩展与协作 | Skills、Plugins、MCP、Hooks、Commands、协作 Agent 与 Review 复用同一 Core 和恢复语义 | 不存在阻塞式旧子任务、扩展专用会话或审阅临时聊天路径 |
| A6 | App-Server-like 产品协议 | API、WebSocket、IPC 与产品 Projection 完整表达 Thread / Turn / Item、审批、错误和恢复 | 桌面无需读取私有 Harness 或供应商 JSON 就能还原完整状态 |

专题功能已经存在不代表可以跳过前置项。审阅、协作、进程、压缩等现有实现先保留为待审计资产；A0.1 到 A6 依序判断其是否属于唯一生产链、是否等价、是否需要移动或替换。

## 8. 当前施工游标

- **已完成的路线图工作**：R0 文档层级、全局依赖顺序、Codex 客户端—后端关系和当前运行时裁决已经写清。
- **R2 当前源码证据**：R2 的调用链、状态权威、依赖方向、物理端口和退出条件集中记录于 `docs/refactor/agent-harness-construction-direction.md`；细粒度追踪分别留在其四份附属记录。它们只以当前源码为证，不再引用不存在的章节或把历史提交当作完成证明。
- **R2 静态结论**：`ProductTaskAuthorityRepository` 独占用户可见 Task/Run/event 事实；Server Composition Root 独占 Scheduler、Supervisor、IPC Launcher 和 Host factory 装配；Harness 经注入端口使用 Host model/tool；Worker sink 先持久化再投影；桌面只消费公开 HTTP/WebSocket 协议。服务端类型检查、桌面生产构建、源码可达性审计和差异空白检查均通过。
- **R2 未验证事实**：真实模型、工具、协作、副作用、进程树与多窗口网络时序尚未运行，不能由上述静态证据替代。R3 只在 R2 的 Model Port 与 Host 边界之上施工。
- **R3.1 当前源码证据**：`ProductTaskService` 在 Run 获得派发权时冻结非秘密 `provider/model` 与 route digest；`resolveTaskRunCoreBinding()` 只把该绑定交给 server-private Host factory。Host 使用受信本机配置重建 route 并比较 digest，个人 profile、端点、能力、模型或 Key 的变化均失败关闭。Worker 和 Renderer 不接触 Key。
- **R3.1 当前执行链**：`StandardProductAgentHostRuntime` 通过同一个 `runProductModel()` 端口执行托管与个人模型。托管分支只请求 Gateway；个人分支直接请求已冻结的 OpenAI-compatible、Responses 或 Anthropic endpoint，并将完成的 assistant item 写入本机受信 operation store，重新进入同一 operation 时只回放已持久结果。显式可确认的客户端/上游失败释放 reservation，其余中断保留 unknown 围栏，不自动重试。
- **R3.1 静态验证**：服务端 TypeScript 检查、桌面 lint/生产构建、差异空白检查均通过；未新增或运行测试、smoke、模拟请求、桌面试运行、安装或发布。
- **R3.2 当前源码证据**：Gateway 的 `/v1/chat/completions` 以验证后的 installation principal、稳定 operation id 和精确请求指纹取得 `gateway_operation_results_v4` fencing。已成功的 operation 只回放已持久 SSE，不再接触 DeepSeek；进行中的 operation 返回冲突；中断、上游不确定或账本无法完成时保留 unknown 围栏，不自动重发。
- **R3.2 结果与结算**：成功 SSE 的原始字节、内容类型和实际额度先写入 Gateway result store，随后才按上游 `usage.completion_tokens` 结算；上游未报告 usage 时保留预留输出额度，不能猜测较小消耗。结果头只交给受信 Host；ACK 的 durable-consumer 时点由 R3.3 单独裁决。ACK 前的结果受有界 backlog 保护，重复 ACK 不会产生第二次模型请求。
- **R3.2 静态验证**：Gateway Bun 生产 bundle、服务端 TypeScript 检查、源码可达性审计（496 个源文件、0 个缺失 import、322 个生产源可达）、桌面 lint/生产构建和差异空白检查均通过；未新增或运行测试、smoke、模拟请求、桌面试运行、真实模型调用或发布。
- **R3.2 未验证与后续**：真实 Gateway/DeepSeek 的断流、跨进程恢复、ACK 网络失败和上游 usage 缺失仍未运行，不能由静态证据替代。R3.3—R3.5 依次收口各类 consumer 的 durable receipt；unknown 的显式新 attempt 留在 R3.6，不得把 WebSearch、媒体能力或桌面设置 UI 混入。
- **R3.3 当前源码证据**：`ProductAssistantMessage.operation_receipt` 只存在于私有 Harness trajectory，包含非秘密 source、capability、operation id 和请求 fingerprint；Worker 公开帧、Task event、WebSocket 与 Renderer 都不投影该字段。`runProductAgentLoop()` 在 assistant 已由 `ProductHarnessSessionRepository` 原子写入后才调用 receipt ACK；恢复同一 active Turn 时先对持久 assistant receipt 重试 ACK，再交付既有结果。
- **R3.3 失败与恢复边界**：Gateway 或本机个人 store 的 ACK 失败会使主 Harness 进入 `recovery_required`，而不是把已消费结果误报完成或再次请求模型。下次恢复只使用已持久的 receipt；重复 ACK 幂等。缺少同一 private-session 消费边界的嵌套模型调用仍不 ACK，其 handoff 另列后续 R3 单元，不能借此回退为运行时即时 ACK。
- **R3.3 静态验证**：服务端 TypeScript 检查、源码可达性审计（496 个源文件、0 个缺失 import、322 个生产源可达）、桌面 lint/生产构建和差异空白检查均通过；未新增或运行测试、smoke、模拟请求、桌面试运行、真实模型调用或发布。
- **R3.3 未验证与下一项**：真实 session 落盘、ACK 断线、Worker 崩溃与恢复时序尚未运行。R3.4 只处理 Subtask/Plugin agent 的父工具结果 handoff；Hook 与 unknown 新 attempt 继续分开，不得改动 WebSearch、媒体能力或桌面设置 UI。
- **R3.4 当前源码证据**：Subtask 与 Plugin agent 收集自身及递归子工具结果中的私有 receipt，作为 `operation_receipts` 附在父 `tool_result` 上。`runProductTools()` 不把 receipt 放入模型可见 content；主 `runProductAgentLoop()` 先把该 tool result 写入私有 Harness session，才以同一 receipt callback ACK。嵌套循环没有 session 时只继续向上携带 receipt，不即时 ACK。
- **R3.4 失败与恢复边界**：子循环、父工具、session 写入或 ACK 任一环节中断时，Gateway/个人 result 都保持未 ACK，可由包含该 tool result 的主 session 恢复重试；不会将子 agent 完成误作其结果已经被父任务消费，也不会重新请求模型。
- **R3.4 静态验证**：服务端 TypeScript 检查、源码可达性审计（496 个源文件、0 个缺失 import、322 个生产源可达）、桌面 lint/生产构建和差异空白检查均通过；未新增或运行测试、smoke、模拟请求、桌面试运行、真实模型调用或发布。
- **R3.4 未验证与下一项**：真实嵌套 worker 崩溃、递归子任务回放与 ACK 网络失败尚未运行。下一游标为 **R3.5 — Hook 模型消费者的持久 receipt 边界**；托管 unknown 的显式新 attempt 留给后续独立单元。
- **已完成的当前模块证据**：R4.1 桌面 Agent 公开事件消费链审计已完成。桌面任务 runtime 只消费 Product Server 的结构化 WebSocket 事件与线程/队列快照；resume cursor 由同一 durable event ledger 驱动，重连先回放、再读取当前 run snapshot、最后交接 live 事件。页面的局部 store 只保留连接、提交、草稿、滚动、面板和其他可丢失 UI 状态，线程、活动、计划、审批、错误、恢复、模型路由与队列都能从服务端重新投影。侧任务变更以 authority revision 触发服务端 refresh，审阅/Diff 与进程面板分别从正式 API 刷新/轮询，因此不依赖聊天事件或浏览器缓存。
- **R4.1 验证**：相关 TypeScript 源码链路和公开协议 parser 已静态审阅；R3 最终检查中的服务端类型检查、桌面 production renderer 构建、Gateway bundle、运行策略解析、源码可达性审计和 diff whitespace audit 均通过。未新增或运行测试、smoke、模拟请求、桌面试运行、安装或发布。
- **已完成的当前模块证据**：R4.2 桌面 Agent 动作与幂等回执审计已完成。新建任务、普通消息和冻结 Review Run 都保留未知 HTTP 结果对应的原始 client operation 与精确 revision/附件请求，重试只读取同一 Authority receipt；队列编辑、删除、重试、重排、转向和恢复同样复用原 mutation。继续、改写以及任务生命周期操作走通用 durable envelope；侧任务和审阅批注各自保留可重放 operation。审批/问题以已持久化 request id 幂等结算，停止则只在当前 socket 已接收 durable replay、run snapshot 与 resume cursor 后才可送至 generation-fenced Host。服务端也拒绝尚未完成 replay hand-off 的入站动作，因此旧窗口/旧连接状态不会批准或停止未观察到的新 Run。权威 revision、receipt、event ledger 和重连 snapshot 是多窗口交接的唯一裁决，Renderer 只保留可丢失的交互 pending 状态。
- **R4.2 验证**：动作入口、Product API/WebSocket ingress、Authority mutation 和 Host RPC 均已静态追踪；服务端 TypeScript 检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过。桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、桌面试运行、安装或发布。
- **已完成阶段：R4 Agent 桌面客户端闭环**。项目、任务、线程、活动、计划、队列、审批、审阅、进程、Diff、侧任务、恢复、错误和动作回执均只经 Product Server/Host 的结构化权威链路进入桌面；刷新、重连和多窗口不依赖 renderer 业务状态副本。R4 的代码与静态验收范围已收口。
- **已完成的当前模块证据**：R5.1 局部重绘的 Seedream 视觉标记输入已收回图片领域服务端。公开图片操作只接受基础 Version、透明 PNG mask 和编辑指令；服务端校验并持久化 mask 后，从该不可变 Version 的真实字节和该 mask 确定性合成红色标记参考图。Renderer 不再提交可替换的 `visual_signal_data_url`，因此不能让同一个图片操作混入另一张同尺寸图片。GPT Image 2 仍接收原始基础图和独立 mask，不改变其原生编辑合同。
- **R5.1 验证**：服务端类型检查、桌面 production renderer 构建、源码可达性审计（443 个源文件、0 缺失 import、442 个生产源可达）和该范围 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R5.2 已沿 `ImageProjectCommandService → ImageSubmissionCoordinator → ImageRemoteTaskCoordinator → ImageResultMaterializer → MediaTaskCoordinator → MediaTask/Event cursor → mediaWorkbenchStore` 审计受理、远端查询、物化、项目发布、Relay ACK、`failed_unknown` 与中断提交恢复。审计发现 Gateway 能力目录可将单次候选上限配置到 20，而 Relay 输入、Seedream receipt 累计、结果 schema 与本地结果检查仍有 4/16 的硬上限；现统一为协议上限 20，且本地只接受不超过该 Task 已冻结 `output_count` 的远端候选，避免能力目录已接受、下游却错误拒绝或误标未知结果。
- **R5.2 验证**：Relay 生产 bundle、服务端类型检查、桌面 production renderer 构建、源码可达性审计（443 个源文件、0 缺失 import、442 个生产源可达）和相关 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R5.3 已沿候选物化、Asset/Version 归档、公开版本投影、当前版本选择、质检、比较和导出追踪完整性边界。`ImageArtifactRepository` 在展示、编辑和导出前验证来源是非符号链接普通文件、哈希、MIME 与尺寸；`ImageVersionService` 原本在切换 `current_version_id` 时只检查 Version 记录存在，现改为先走同一 `versionBytes` 校验，损坏或被替换的候选不能成为项目当前版本。任务运行或本地提交中仍由 Project Server 拒绝选择/提交版本；质检不可用只作为非阻断结果，已验证候选继续可比较、继续编辑与导出。
- **R5.3 验证**：服务端类型检查、桌面 production renderer 构建、源码可达性审计（443 个源文件、0 缺失 import、442 个生产源可达）和相关 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R5.4 已审计图片 API、项目/任务 owner、公开资产 URL、桌面 consumer、持久 reader 与聊天边界。图片 API 全部以 standalone `MediaProject` owner 进入 `MediaProjectService`；聊天正式源码没有 `MediaWorkbench`、`ProductTaskMedia` 或 task-scoped 图片写入消费者。`ImageWorkbench` 只消费 `/api/media/images/projects/...` 的版本、参考图和图层 identity URL；通用 `/api/media/assets/<project>/<file>` 因仍有视频预览/音频消费者而保留，但对 image Project 明确返回 404，不能再作为图片的公开便利路径或恢复旁路。
- **R5.4 验证**：相关正式入口、旧消费者关键字、图片 URL consumer 和 import graph 已静态审计；服务端类型检查、桌面 production renderer 构建、源码可达性审计（443 个源文件、0 缺失 import、442 个生产源可达）和相关 diff whitespace audit 均通过。桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、桌面试运行、安装、付费生成或发布。
- **已完成阶段：R5 生图工作台静态收口**。Brief/参考素材、独立 Project/Task/Asset/Version、模型能力目录、同项目付费围栏、候选物化/领取/ACK、未知结果、局部重绘、质检、比较、版本选择与导出均只有图片领域的正式权威链；聊天 Harness 不拥有或代理图片项目。真实模型返回、真实网络中断、付费结果、桌面 Canvas/HiDPI 和设备级恢复尚未执行，不能被上述静态证据替代。

- **已完成的当前模块证据**：R6.1 已从桌面 `VideoStudio` / `mediaWorkbenchStore`、产品 media mutation/API、`MediaProjectService` 装配、视频 Source/Evidence/Timeline/Audio/Subtitle/Preview/Render 协调器、`MediaTaskCoordinator` 与 FFmpeg/Gateway 端口追踪唯一调用链。桌面只保存未提交手势草稿和项目/任务事件投影；项目 revision、时间线版本、证据、音频/字幕、Task 与 Asset 都由 Product Server 持久服务写入。`video.preview` 与 `video.render` 是分离 Task，均在校验输出后才发布；取消和中断恢复由 `MediaTaskCoordinator` 分发回各自协调器。审计发现内容 mutation 会删除已发布节目预览，现已改为只撤销当前最终导出身份，保留带 project revision/timeline version 的历史预览；桌面同时按两种身份标出音频、字幕或时间线变更后的旧预览，新预览发布成功后才替换旧资产。
- **R6.1 验证**：服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实媒体/模型调用、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R6.2 已审计 `VideoSourceService → VideoEvidenceService → VideoAnalysisCoordinator → VideoPlanCommit/VideoPlanRecoveryService → VideoTimelineService` 的持久提交链。FFmpeg 解码器以实际 `showinfo` 时间戳逐项闭合 JPEG 帧；声音理解与转写按源素材时间块保存；evidence revision 只从持久事实派生；分析提交先写私有 plan checkpoint，再以 project revision、evidence revision、父时间线版本和 Task identity 作 CAS，崩溃时只会确认已提交或按同一 checkpoint 重放。审计发现 evidence identity 未包含项目内 `source_id`，同一文件二次导入会冲突，且一项素材的可变声音结果会改变后一素材的视觉 ID；现已升级为 v2 身份，按项目素材、fingerprint、证据语义和素材内出现序号生成，避免跨素材漂移或碰撞。
- **R6.2 验证**：服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实 FFmpeg/模型调用、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R6.3 已审计 `VideoAudioPanel` / `VideoSubtitlePanel`、对应 media mutation、`VideoAudioService`、`VideoSubtitleService`、`videoProjectPolicy` 和预览/导出准入。音频资产落到项目受管目录，音频时间线以 `audio_timeline_version_id` 明示是否已按当前视频版本复核；旁白在调用供应商前持久化 operation 并锁住目标 revision；预览和导出均再次拒绝未复核音频。字幕轨绑定创建时的时间线，服务端烧录前再次核对活动轨版本。审计发现旧字幕轨只能由桌面禁用而仍可经 mutation 重新绑定；现已在唯一服务端更新入口同时校验轨道自身版本，旧轨只能导出留档，不能被写成当前轨。
- **R6.3 验证**：服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实音频/字幕/FFmpeg 调用、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R6.4 已审计 `VideoPreviewCoordinator`、`VideoRenderCoordinator`、`VideoOutputService`、`MediaFilePublisher` 与 `MediaTaskCoordinator`。预览和导出都先写 Task checkpoint、以 FFprobe/尺寸/帧率/时长/流和 SHA-256 校验临时产物、再使用 hard-link 或排他复制发布，且只在冻结 revision、时间线版本和项目 Task 指针仍匹配时写终态；取消、迟到提交和重启读取都走各自 coordinator 的恢复分支。审计发现最终导出可用性检查会跟随符号链接，现已在项目迁移、MIME 投影和内容读取三处拒绝链接，避免发布后被替换的外部路径继续冒充该项目已验证的成片。
- **R6.4 验证**：服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过；桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实 FFmpeg 导出/中断、桌面试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R6.5 已审计视频的 public contracts、桌面 mutation consumer、media API、`MediaProjectService` 装配、Task/Event 恢复、受管资产/源素材/音频 URL 与 Agent 边界。所有视频写操作由桌面经 `MediaWorkbenchMutation` 交给 Product Server，renderer 仅保留未提交交互草稿和事件投影；`video.preview`/`video.render` 与主分析任务的状态分别由持久 Task 负责。视频预览使用受管 Asset URL，源素材和音频分别经过项目身份解析，聊天 Harness 没有视频项目写入消费者或 task-scoped 媒体回流路径。
- **R6.5 验证**：相关 mutation/API/URL/task-kind/旧消费者/import graph 已静态审计，`git diff --check` 通过；本轮各代码改动后的服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）均通过，桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实媒体/模型调用、桌面试运行、安装、付费生成或发布。
- **已完成阶段：R6 视频工作台静态收口**。素材指纹、逐帧/声音证据、可恢复规划提交、不可变时间线、受管音频和字幕、旧节目预览、最终导出、取消和中断恢复均在视频领域各有唯一权威链；图片和聊天 Harness 不拥有这些状态。真实 FFmpeg 转码/中断恢复、长素材性能、真实模型与语音供应商结果、设备级字幕字体和安装后行为尚未执行，不能被静态证据替代。

- **已完成的当前模块证据**：R7.1 已追踪主窗口 `AppShell`、`MainApp`、`ContentRouter`、tab 恢复、产品任务 runtime、`useProductTaskDirectorySync`、`useMediaWorkbenchRuntime` 与通知导航的全链。产品任务页拥有实时 run socket；关闭页签后 `monitorTaskUntilIdle` 保持未结束任务，再由壳层目录同步投影后台状态。图片和视频不由各自页面维持后台工作：主窗口壳层持续对账目录、订阅当前或未结束项目事件、投影 attention，页面关闭不会令项目任务失联。固定工作面只恢复 tab 身份，领域 Project/Task 和本地编辑草稿不写入共享 tab 持久化。通知点击只打开领域工作面并选择同一领域项目；若目标项目已被可靠目录刷新移除，选择现明确为空而不再回退到列表第一个项目，避免陈旧通知把用户导向无关图片或视频。
- **R7.1 验证**：相关壳层、导航、store、任务 runtime、图片/视频工作面与持久化路径已静态审计；服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过。桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实桌面通知、试运行、安装、付费生成或发布。

- **已完成的当前模块证据**：R7.2 已审计 ProductTask 与媒体两类 attention 的持久 observation、实时事件、目录轮询、可见性确认、storage 同步、系统通知去重与点击导航。终态以 `taskId + status_sequence` 或 `sourceTaskId + eventSequence/requestId` 去重；媒体的 main/preview slot 分开保存并按项目显示 completed/failed；任务的主任务和侧边任务未读源独立清除。项目级操作错误留在对应项目键，目录/事件错误只投影到拥有它的工作台。审计发现独立任务窗口虽禁止原生通知，却仍会先消费目录 attention，使主窗口随后无法发现同一终态并发送唯一系统通知；现已令独立窗口只确认当前可见任务，不再写入目录 observation，通知权仍唯一属于主窗口。
- **R7.2 验证**：相关 attention store、实时事件发布、目录同步、主/独立窗口 hook、通知发送/点击、sidebar 和项目 rail 的错误/未读投影均已静态审计；服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过。桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实系统通知、桌面试运行、安装、付费生成或发布。
- **已完成阶段：R7 跨工作台桌面壳静态收口**。共享壳层拥有启动、tab 身份恢复、跨窗口设置同步、后台目录对账、通知呈现和导航投影；Agent、图片和视频各自仍拥有 Project/Task 与领域恢复。真实多窗口焦点切换、系统通知平台行为、设备休眠恢复和真实安装后的窗口生命周期尚未执行，不能由静态审计替代。

- **已完成的当前模块证据**：R8.1 已从 renderer、Electron main/preload、preview agent、单一 sidecar、Gateway 与 Relay 入口重建运行可达图；当前生产源 441 个且全部可达。`ts/package.json` 与 `desktop/package.json` 均没有测试脚本、测试 runner 或测试依赖；已核对正式依赖有 MCP、Sandbox、文档解析、图像视觉、锁、React/桌面更新/终端/渲染等真实消费者。旧 Core、旧 ProductTask、媒体 owner 与桌面 localStorage 的 reader 均由启动升级或迁移协调器调用，仍属于受支持升级路径。`codex-reference/` 由根 `.gitignore` 隔离，不进入构建；安装资源审计还明确拒绝旧运行路径与旧品牌字符串。唯一 HEAD 中仍可定位的测试 fixture 是一个已无消费者的 Qwen 历史模型映射；它已作为工作区既有删除存在，本轮未恢复、未暂存或提交该用户变更。
- **R8.1 验证**：正式入口、import graph、scripts、依赖直接消费者、迁移调用链、`.gitignore` 与包清单均已静态审计；服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过。桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实桌面试运行、打包、安装、付费生成或发布。

- **已完成的当前模块证据**：R8.2 已把既有 `audit-packaged-resources.ts` 接入 Electron 的 `afterPack`。每次正式桌面打包在 FFmpeg/ffprobe 校验后，都会对实际 `app.asar`、配置、sidecar、Windows 沙箱归属和禁用旧路径/品牌字符串执行静态安装资源审计；审计失败会直接中止打包，不能再依赖手动调用脚本。
- **R8.2 验证**：`electron-after-pack.cjs` 已通过 Node 语法检查；服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过。未执行真实打包或安装资源审计，因为当前模块不授权构建发布、真实设备运行或自动化测试。
- **已完成阶段：R8 旧代码、迁移与依赖静态收口**。正式运行入口与构建资源均有可追踪消费者，升级读者保留在启动链，参考源码保持隔离；实际发行包仍需在未来获准打包时由 `afterPack` 对真实产物验证。

- **已完成的当前模块证据**：R9.1 已按三条旅程和共享底座复核正式生产链。Agent 从 Authority、权限请求、worker dispatch、run terminal/恢复到目录和桌面投影具有持久事件与启动恢复；图片和视频均在提交前记录 Provider operation 与不确定结果，未知结果不会自动重试，恢复只确认或等待用户明确确认。媒体只由 `MediaProjectService` 与独立 API/桌面工作台消费，聊天 ProductTask 没有媒体项目写入回流。共享壳层对后台同步、未读、通知和导航只做投影；安装包从 `beforePack` 到 `afterPack` 对公开配置、工具链、资源归属和旧路径建立失败关闭。当前静态审计没有发现新的、会确定造成错误结果、数据丢失、重复付费副作用、权限越界或不可恢复的阻断缺口。
- **R9.1 验证**：最终调用、失败、恢复、权限、媒体隔离、旧路径和打包资源路径均已静态审计；本轮代码后的 Node 语法检查、服务端类型检查、桌面 production renderer 构建、源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）和相关 diff whitespace audit 均通过。桌面构建只有既有 `::highlight(...)` CSS 优化 warning。未新增或运行测试、smoke、模拟请求、真实模型/媒体调用、真实系统通知、多窗口/休眠场景、桌面试运行、安装、打包、发布或生产改动。
- **已完成阶段：R9 软件层静态完成审计**。Agent Harness、图片工作台、视频工作台和共享桌面壳已完成当前软件层的静态施工与收口；下一阶段必须由用户确认后，才可按发布路线进行真实构建、安装、设备行为、生产部署或商业控制面工作。

- **R9.2 只读生产库存**：2026-07-31 已按发布合同只读核对 `96.9.225.212`。`/srv/billiardbuddy/current` 指向 `gateway-20260730T231932Z`；Gateway、Relay、Static 容器均为 healthy，Gateway 与 Static 只绑定宿主机 loopback，Relay 只暴露 Docker 私网端口，Nginx 配置检查和本机健康端点均通过。当前本地工作区仍含 Gateway、Relay、Compose、Nginx、部署脚本与运行文档的未提交变更，因此该库存只证明当前服务器运行闭包健康，不能证明它已与本地施工结果一致；本轮没有写服务器、重启容器、触发模型请求、构建桌面包或切换发布元数据。

- **R10.1 发布闭包审计**：已核对本地 `deploy/production` 的 Compose、Dockerfile、Nginx、部署脚本、发布包脚本与 Gateway/Relay 实际 import。Gateway 新增的声音理解、语音合成、声音样本、图片额度、安装身份、操作结果、运行策略和重试模块，以及 Relay 的 PNG 掩码依赖，均已进入 Docker build 与 production archive 清单；部署脚本会先校验 operator-owned runtime policy、凭据引用和容量配置，再等待三项服务健康、检查 Nginx，最后切换 `current` 软链接。`bash -n`、服务端类型检查、生产源码可达性审计（442 个源文件、0 缺失 import、441 个生产源可达）与相关 diff whitespace audit 均通过。
- **R10.1 已处理的生产差异**：服务器仍运行 `gateway-20260730T231932Z`，而本地 Gateway、Relay、Compose、Nginx 和发布闭包包含未提交修改及未跟踪的正式运行文件。正式工作流刻意以 `git archive <revision>` 生成发布包；这些文件不在当前 `HEAD`，所以不能把该混合工作区或旧提交直接作为本次生产 release。此结论阻止了错误部署；本轮没有写服务器、构建镜像、重启容器、调用模型或切换公网路由。

- **R10.2 已完成部署与运行事实核对**：2026-07-31 以最小 archive 部署 release `f7fcdaa51202`，release manifest 的源码提交为 `f7fcdaa51202b98ec248d4d4734f4a1020360217`。三项服务镜像与 `/srv/billiardbuddy/current` 均使用这一 release；Gateway、Relay、Static 均为 healthy，Gateway/Static 只绑定 `127.0.0.1:8799/8788`，Relay 只在 Docker 私网监听，Nginx 配置检查通过。HTTPS `/healthz` 与 `/gw/healthz` 返回 200，公网 `/relay/` 返回 404。未构建或发布桌面安装包、未切换任何 `latest*.yml`、未调用付费模型。
- **R10.2 部署过程收口**：首次实际部署暴露宿主机没有 Bun，已把鉴权环境与运行策略校验改为在刚构建的 Gateway 镜像中执行；随后发现既有 operator-owned runtime policy 缺少新 schema 字段，新增幂等迁移器，只补齐 `text_reasoning` 和五类缺失用量字段，并在 `/srv/billiardbuddy/config/` 写入带时间戳备份，不改写原有策略值。Docker build 又发现迁移器未列入 `.dockerignore` 白名单，已补齐。每次失败都发生在切换 `current` 前，旧 release 持续健康；最终通过后才原子切换。

- **R10.3 发布闭包重新核对**：2026-08-01 只读核对确认服务器 `current` 为 `/srv/billiardbuddy/releases/f7fcdaa51202`，manifest 的源码提交为 `f7fcdaa51202b98ec248d4d4734f4a1020360217`；Gateway、Relay、Static 均 healthy，Gateway/Static 仅绑定宿主机 loopback，Relay 只在 Docker 私网监听，HTTPS `/healthz` 与 `/gw/healthz` 返回 200。服务器上的 Compose 与 Nginx 配置解析通过，runtime policy schema 为 1，持久化挂载只包括 operator-owned runtime policy、Gateway/Relay 数据与桌面更新目录。该运行提交是本地 `HEAD` `15e07e127eb673c4a499b85d84d38672407ea3e9` 的祖先；两者之间的已提交改动仅涉及 Windows 沙箱和桌面构建准备，生产 release archive 的 `.dockerignore`、`deploy/production`、Gateway、Relay 和 Provider 合同没有差异，当前工作树也没有修改这些 archive 输入。工作树仍有 450 条状态记录和 208 个未跟踪文件，不能将它整体误认成可发布输入；`package-release.sh` 只从指定 Git commit 的 archive 构建闭包，因此本轮没有重新部署、构建镜像、写入配置或发布安装包。
- **已完成阶段：R10.3 发布闭包只读核对**。线上服务健康且与其明确的 archive 输入一致；当前桌面/Windows 施工资产与脏工作树仍需在 R11 按原生构建和更新边界独立处理。

- **R11.1 桌面发布链审计**：已以 `0.5.0`、生产 Gateway `/gw` 合同和匿名安装会话为基线，追踪 Electron 主进程、更新状态、beforePack/afterPack 资源审计、Windows/macOS 原生构建工作流和更新元数据。安装包只携带公开 `product-config.json`；`product-secrets.json`、Gateway 启动凭据和 License 配置均被打包审计拒绝，工作流也不再从服务器读取它们。Windows 只经原生 x64 脚本构建，正式发布强制 P12 签名，macOS 候选可在无签名凭据时构建但正式发布强制 Developer ID 与公证；两平台都只在显式 `publish=true` 后上传不可变安装文件与 blockmap，最后原子切换 `latest*.yml`，Git tag 不再触发公网发布。新增更新清单校验器，核对版本下限、哈希、大小、更新文件和平台产物唯一性；发布源码门禁同时覆盖工作流、桌面、共享/服务端、脚本、锁文件与 Windows 原生沙箱目录，拒绝未追踪或未提交输入，避免远端候选构建使用旧提交。更新检查可以后台下载，但下载完成后只显示明确的“安装并重启”操作；设置页不再在检查后自动安装或重启。当前门禁如实阻止候选构建：发布输入有 170 个未追踪文件和 259 个未提交文件，必须按已完成模块审阅并形成可追溯提交后才能进入原生候选构建。随后原生审计发现 helper 在构建时 `git fetch` Codex 参考仓库，并把其多个内部 crate 引入构建链；这违反“参考仓库不进入运行时、构建或安装包”的边界，因此 Windows 原生候选构建继续失败关闭，必须先迁入产品自有、保留原生权限/进程语义且不包含测试资产的实现。`check:desktop`、`check:server`、`audit:source`、工作流 YAML 解析和相关 diff whitespace audit 均通过；未生成原生候选包、未上传安装包或更新清单、未切换官网入口或调用付费模型。

- **R11.1 本地 Windows 沙箱迁入与静态闭包**：`native/windows-sandbox-runtime/` 现为产品自有 Cargo workspace，包含 ACL、受限令牌、WFP、提权 IPC、Job object、ConPTY、绝对路径、PTY 和权限协议所需运行源码；导入树没有测试模块、测试文件、测试依赖、Bazel/README 构建包装或参考仓库路径。`native/windows-sandbox-helper/build.ps1` 只从本地 runtime 与 helper 源生成三项二进制，不会网络 fetch。两端都锁定 Rust 1.88、提交完整锁文件，并以 `x86_64-pc-windows-msvc` 目标和 locked 依赖完成静态编译；运行时对 `time` 锁定兼容版本，helper 与 runtime 都由各自的工具链文件约束。发布门禁覆盖 runtime 目录、拒绝 Rust `cfg(test)` 与 smoke/test 资产；安装资源审计要求三个二进制及必要的许可证/NOTICE。当前静态闭包不等于 Windows 安装包：真正的原生候选构建只可在 GitHub `windows-latest` 原生 runner 进行，任何失败都继续阻止候选包和公开发布。

- **R11.2 旧私有 VM 构建路径退出**：历史的服务器 QEMU/KVM、Windows ISO 和私有 VM 管理方案不再属于产品构建链。仓库中的 `deploy/windows-build-vm/` 已删除，正式 Windows 构建只由 GitHub `windows-latest` runner 执行；服务器只保存和通过 HTTPS 提供最终静态产物，不承载桌面 VM。现有服务器上的历史宿主工具不在本模块删除范围内，除非后续获得单独的运维清理授权。

- **R11.3 原生构建与更新来源静态审计**：Windows/macOS 工作流 YAML 均可解析，分别固定 `windows-latest` 与 `macos-14`，并在默认构建命令中使用 `--publish never`；只有显式 `publish=true` 的独立步骤才具备上传和原子更新清单切换能力。两端都先执行发布源码门禁、再校验唯一安装文件、blockmap、更新清单和解包后的安装资源；Windows 原生 helper 只从仓库内的自有 runtime 源构建，工作流下载的 Bun 与媒体工具链均要求 HTTPS 与 SHA-256。发布输入中没有实际引用 `codex-reference` 或参考仓库，也没有测试资产；唯一命中是门禁脚本自身的扫描规则。当前源门禁如实拒绝候选构建：163 个未跟踪发布输入和 257 个未提交发布输入尚未按模块形成可追溯提交。未触发 GitHub Actions、原生构建、上传或更新元数据切换。

- **R9.3 施工游标一致性收口**：移除了路线图末尾遗留的 R3/R4 重复施工记录与回跳游标。R3 至 R9 的完成证据以本文件前述记录为准；R9.1 的软件层静态审计和 R9.2 的只读生产库存不等同于真实设备验收或新的发布授权。
- **R9.3 验证**：当前工作树已按合同建立模块归属盘点；跨域包清单、锁文件、环境样例、安装配置和官网配置按实际消费者收紧到差异块级别。合同、仓库规则和 Agent 总纲均已删除第二份当前模块断言，路线图只保留一个真实 active work unit。服务端类型检查和相关文档差异空白检查通过；未构建安装包、未写服务器、未切换生产或更新元数据。
- **已完成阶段：R9.3 软件层施工游标与工作树归属收口**。脏工作树是按合同待审阅的模块资产，不是一个可直接发布或混合提交的单元。

- **R0.1 回溯核验启动**：发现路线图中段仍把 R2 称作“当前唯一施工主线”，而底部同时指向 R11.3；Agent 总纲标题和一份参考—改动文档也把 Agent 模块误写成当前主线。这些冲突说明历史“已完成”记录不能直接当作当前施工许可。R11.3 暂不进入，先按合同从 R0 开始重新核验模块目标、当前源码、状态权威、消费者、失败/恢复边界和静态证据。
- **R0.1 验证**：全库施工文档扫描只保留本路线图的一处 `Active work unit`；合同和根 `AGENTS.md` 均只将游标指向本路线图，Agent 总纲和专题参考文档只在路线图选中其所属模块时适用。相关文档差异空白检查通过。
- **已完成阶段：R0.1 重构合同与施工证据回溯核验、R1.1 共享产品内核的权威边界回溯核验、R2 Agent Harness Authority 与 Worker/Host 生产链回溯及物理收口**。历史阶段记录仍只是候选证据，不能替代当前源码核验或发布许可。

```text
Active work unit: R3.5 — Hook 模型消费者的持久 receipt 边界
Outcome: Hook 使用模型时，receipt 必须进入可恢复的主 Harness 状态，且只在该状态已持久后 ACK；不能用临时条件判断替代结果消费。
Evidence: Hook evaluator、compaction、lifecycle Hook 的 Model Port 调用入口，以及 R3.3/R3.4 的 session 与 receipt handoff。
Constraints / Non-goals: 不改变 R2 的 Thread/Turn/Tool/恢复语义，不进入 unknown retry、图片、视频、WebSearch、桌面设置、安装包或生产发布；不发送真实模型或付费请求。
Allowed scope: Hook 模型调用的 receipt 载体、主 Harness session 持久化/恢复、ACK 时点及 R3 证据记录。
Verification / Exit: Hook 的模型结果和 receipt 具有同一可恢复所有者；写入或 ACK 失败不重发模型；类型、生产构建、源码审计和失败/恢复证据成立。
Next cursor: R3.6 — 托管 TextReasoning unknown 的显式新 attempt 账本。
```
- **Interrupt rule**：只有发现会造成错误结果、数据丢失、重复副作用、权限越界或无法恢复的事实才可中断；其余发现进入对应后续模块。

当前游标只在模块退出证据成立后移动。不能用“已经改了很多”“类型通过”“某个按钮可见”或固定迭代轮数替代模块完成。
