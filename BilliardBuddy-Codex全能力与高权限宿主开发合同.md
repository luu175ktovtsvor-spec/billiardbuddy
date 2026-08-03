# BilliardBuddy Codex 全能力与高权限宿主开发合同

> 文档性质：Agent 宿主、桌面能力、扩展能力与远程能力的后端开发合同
>
> 目标仓库：`luu175ktovtsvor-spec/billiardbuddy`
>
> 静态审阅基线：`main` 分支提交 `1cc5d6d4`
>
> 参考：锁定的 `third_party/codex-engine` Rust 源码，以及官方 Codex 桌面手册
> 产品边界：BilliardBuddy 使用 Codex Rust App Server 作为 Agent 内核；图片、视频由 BilliardBuddy 自己的工作台承担；不建设语音输入、语音对话、语音合成和声音克隆。

---

## 1. 目标与完成定义

BilliardBuddy 不重写 Codex 的 Agent Loop、上下文压缩、工具选择、Thread/Turn、Sandbox、审批、MCP、Skills、Hooks 或插件运行语义。

目标是让用户在 BilliardBuddy 中获得与 Codex 桌面产品同类的本地 Agent 能力，并由 BilliardBuddy 自己拥有桌面权限、密钥、远程服务、模型路由、产品状态与品牌。

```text
BilliardBuddy Desktop
├── Codex Rust App Server
│   ├── Agent Loop / Thread / Turn / Context / Compaction
│   ├── Files / Shell / Git / Sandbox / Approval
│   ├── MCP / Skills / Hooks / Plugins / Collaboration
│   └── Native event stream
├── BilliardBuddy Electron Host
│   ├── Window / trusted IPC / Keychain / lifecycle
│   ├── 显示 Codex 原生插件与设置
│   └── 打包的本地 Codex 插件和 MCP 服务
├── BilliardBuddy model routes
│   ├── Managed DeepSeek Responses Gateway
│   ├── Personal Responses Key proxy
│   └── Personal Chat Completions adapter
└── BilliardBuddy product domains
    ├── Image Workbench
    └── Video Workbench
```

“全能力对齐”不等于复用 OpenAI 的 ChatGPT 账号、云端计费、远程市场或私有服务。对于这些能力，完成的标准是提供 BilliardBuddy 自己的等价产品能力；不能调用的 OpenAI 私有服务不得被假称为已经迁移。

---

## 2. 三类能力边界

### 2.1 Rust 内核原生能力：直接保留

这类能力已经由锁定的 Codex Rust App Server 负责。BilliardBuddy 只转发协议、提供模型和显示事件，不写第二个实现。

- Thread、Turn、恢复、归档、Fork、Rollback、Goal；
- Prompt、Context、原生压缩与任务循环；
- 文件读取、补丁、Shell、Git、统一终端与后台终端；
- Workspace Sandbox、网络限制、审批与自动审批审阅；
- MCP、Skills、Hooks、插件声明与生命周期；
- 子 Agent、协作模式、Review；
- 工作区规则、`AGENTS.md`、项目 Skills 与外部 Agent 配置检测/迁移；
- 原生事件、工具调用、审批和交互请求流。

### 2.2 高权限桌面能力：由 BilliardBuddy 宿主实现

这类能力需要真实操作系统权限、窗口状态、浏览器会话或用户选择。Codex Rust 可以调度工具，但不能代替操作系统授予权限，也不包含 OpenAI 桌面产品私有的执行器。BilliardBuddy 只提供对应插件的本地执行端，不再另建通用权限中台。

- Computer Use：屏幕、窗口、点击、输入、滚动、允许的 App 启动；
- Browser Use：BilliardBuddy 受控浏览器、页面检查和网页操作；
- Chrome Control：用户选择的 Chrome Profile/标签页与开发者模式 CDP；
- 剪贴板、文件选择和工作区外文件导入；
- 系统通知、后台任务和受控的开机后恢复；
- 本地设备/桌面主机的远程连接与配对；
- 未来自建云执行环境的提交、状态和结果取回。

### 2.3 OpenAI 产品/云端专属能力：做 BilliardBuddy 等价物

以下不是把 Rust 源码编译进安装包就会出现的能力：

- ChatGPT 账号、订阅、OpenAI Credits、官方远程插件市场；
- OpenAI Cloud 环境、GitHub 云端代码审查、Slack 云端集成；
- ChatGPT Remote 的账号配对与中继服务；
- OpenAI 托管网页搜索、原生图像生成和实时语音。

处理原则：

- 模型、额度、计费：继续走 BilliardBuddy Gateway 与用户自带 Key；
- 图片/视频：继续走 BilliardBuddy 自己的工作台，不启用 Codex 原生 Image Generation；
- 语音：明确不做；
- 远程与云：后续由 BilliardBuddy 自己的 Host Pairing / Remote Runner 服务实现；
- 远程插件市场：不接入 OpenAI 账号体系，只支持 BilliardBuddy 本地、工作区和以后自有市场。

---

## 3. Codex 能力矩阵与当前状态

| 能力组 | Codex 形态 | BilliardBuddy 当前状态 | 最终处理 |
| --- | --- | --- | --- |
| Agent Loop、Context、压缩 | Rust Core | 已使用 Rust Core | 保持原样 |
| Thread、Turn、Fork、Rollback、Goal、恢复 | App Server | 已桥接 | 未来新前端投影原生状态 |
| 文件、Shell、Git、Sandbox、后台终端 | Rust/Exec | 内核已具备；桥接后台终端管理；Windows Sandbox 初始化尚未接入 | 不重写；Windows 版须先完成原生 Sandbox readiness/setup |
| 三级 Agent 权限 | Rust Sandbox + approval | 已有 `ask/approve-for-me/full-access` | 保留，不能代替桌面权限 |
| MCP、OAuth、Skills、Hooks | App Server | 已桥接本地配置/列表/授权请求 | 保持 Rust 为唯一注册表 |
| 本地/工作区插件市场 | App Server | 已桥接 | 保持；安装仍须 Electron 确认 |
| OpenAI 远程插件市场 | ChatGPT 服务 | 刻意未接 | 后续 BilliardBuddy 自有市场，不复用 OpenAI 账号 |
| 外部 Agent 配置迁移 | App Server | 检测/导入已通过受限 Electron 桥接；新前端未投影 | 仅迁移安全类别，逐项确认 |
| Collaboration、子 Agent、Review | Rust Core | 已桥接协作/Review 协议，暂无新 UI | 新前端直接消费原生事件 |
| Worktrees、Handoff、本地环境 | 桌面宿主 + Git | 只有 Rust Workspace 与 Git 基础；没有受管工作树、Handoff、初始化脚本或恢复规则 | BilliardBuddy Host 负责 Git 生命周期；不建设第二个 Git 状态或 Agent Loop |
| Scheduled Tasks | Codex 产品能力 + 宿主调度 | Host 调度、受限 IPC、持久化与原生 Thread/Turn 唤醒已进入源码链；未能选择独立工作树 | BilliardBuddy Host 调度原生 Thread/Turn；工作树隔离完成前不得把任务默认放在主目录 |
| 本地 Memories / 项目长期上下文 | Codex Core/产品状态 | Rust 已具备；`thread/memoryMode/set` 与 `memory/reset` 尚未接入产品桥 | 以 Rust 的 Thread/项目状态为事实；不混入媒体 Project，也不另建记忆引擎 |
| Web Search | 模型/服务工具 | 取决于当前模型 Provider | 只在 Provider 真正支持时启用；不伪造结果 |
| Built-in Browser / Browser Use | 桌面宿主 + 浏览器服务 | 独立 Electron profile、受限 loopback Host 与 MCP 已进入源码链；尚未两端构建 | 后续前端投影设置/标签状态 |
| Chrome Extension / CDP | 扩展 + 浏览器宿主 | 扩展、Native Messaging Host、MCP 与打包链已进入源码链；完整 CDP Developer Mode 尚未接入 | 先完成结构化控制，再以每网站审批方式开放完整 CDP |
| Computer Use | 桌面插件 + OS 权限 | macOS/Windows 原生适配器、MCP、允许列表配置与打包链已进入源码链；尚未两端构建 | 后续设置入口与系统授权验收 |
| 远程连接到本机 Host | 账号配对 + 桌面服务 | Gateway 配对/撤销/有界命令队列与 Electron Host 轮询已进入源码链；尚未双设备实机验证 | 后续前端投影配对、状态和设备列表 |
| Cloud 环境/云任务 | OpenAI 云服务 | 未接 | 建设 BilliardBuddy Remote Runner |
| Appshots、用户主动视觉/文件附件 | 桌面宿主 + App Server Turn 输入 | Turn 已能传递图片；没有前台窗口捕获、可访问文本提取、文件选择或附件保留合同 | 用户主动采集后作为原生 Thread/Turn 输入；不等同 Computer Use |
| Auto-review 拒绝管理 | Rust Guardian / App Server | `approve-for-me` 已映射 Auto-review；拒绝记录和单次精确覆盖尚未接 | 保持 Rust 审阅权威，只显示理由并允许用户对某一次动作明确重试 |
| MCP Apps 与自有插件市场 | App Server + 桌面宿主 + BilliardBuddy 服务 | 本地/工作区插件已接；资源 UI、签名市场、搜索、发布、撤销尚未接 | 采用开放 MCP Apps UI；未来市场为 BilliardBuddy 自有服务，不使用 OpenAI 账号 |
| 图像生成 | OpenAI 图像服务 | 已关闭原生入口 | 由 BilliardBuddy Image Workbench 等价承担 |
| 视频剪辑 | 非 Codex 原生领域 | BilliardBuddy 自有领域 | 由 Video Workbench 承担 |
| 语音 | 桌面/云服务 | 不采用 | 不建设 |

当前 Electron 桥已经把 Thread、Turn、权限模式、MCP、Skills、Hooks、插件、协作、Review、后台终端及受限的外部 Agent 迁移转发至 Rust。Computer Use、Chrome、Browser Use、Record & Replay、计划任务与 Remote Host 已进入后端源码；前四项尚无真实跨平台构建，所有模块也尚无用户设置页。Cloud Runner 仍缺失；迁移、计划任务和 Remote Host 的新前端入口也仍缺失。本合同下述顺序是后端建设优先级，不代表这些用户入口已经存在。

---

## 4. 高权限宿主的正式架构

### 4.1 按 Codex 插件形态接入

不新增通用 `PrivilegedCapabilityBroker`、自定义能力注册表或常驻系统服务。高权限能力按 Codex 的现成形态接入：**每一类能力是一个打包的本地插件，由 Skill + 本地 MCP server 组成；MCP server 直接调用该插件随附的 macOS/Windows 原生执行器。** macOS 的执行器是随插件启动的、具备稳定签名身份的 `BilliardBuddy Computer Use.app`；它不是常驻守护进程，也不经过 Electron 逐次转发。

```text
Codex Rust Core
→ 已安装并启用的 Computer Use plugin
  ├── Skill：何时应使用视觉操作
  └── local stdio MCP server：screenshot / click / type / scroll / launch
→ 插件自带的 macOS `BilliardBuddy Computer Use.app` / Windows adapter
→ 操作系统权限与目标 App
→ 原生工具结果 / 原生事件流
```

Electron 的职责只保留：启动打包的 Codex App Server、转发原生插件状态/审批事件、在用户主动操作时打开系统授权页面。它不介入每一次工具调用，更不保存第二份 Agent 审批或权限状态。

系统权限、App 允许列表和工具审批仍是三层各自负责：

- macOS Screen Recording / Accessibility 或 Windows 活动桌面：操作系统；
- 允许某个 App 或“始终允许”：Computer Use 插件的原生配置；
- 工具是否可调用：Codex 原生插件/MCP 工具审批与当前 Thread 的 Sandbox 设置。

### 4.2 不把桌面权限伪装成三个 Agent 档位

三个 Agent 权限档保持其原生含义：

| Agent 权限 | Rust 代码工具 | 桌面能力 |
| --- | --- | --- |
| `ask` | 工作区写入/高风险代码动作请求确认 | 可以请求插件工具；是否批准仍由原生工具审批决定 |
| `approve-for-me` | Rust 按原生规则审阅可批准的代码动作 | 不改变任何系统或插件授权范围 |
| `full-access` | `danger-full-access`，代码工具可访问更广文件与网络 | 仍只可以请求已启用的插件；不会自动获得屏幕、鼠标键盘、浏览器登录态或 Keychain |

`full-access + Computer Use` 的正确体验是：用户先安装并启用插件，首次按系统提示授予权限并在插件中批准目标 App；之后 Agent 才能按 Codex 原生工具审批在这些已允许 App 内连续执行。三个 Agent 档位不是 BilliardBuddy 自定义的桌面权限表，也不能把权限横向扩展到浏览器 Cookie、摄像头、麦克风或 Keychain。

### 4.3 本地插件/MCP 接法

Computer Use、Chrome、Browser 和 Record & Replay 都作为 BilliardBuddy 随安装包提供的独立本地 Codex 插件接入；不得把它们拼成 Electron 工具集合。Computer Use 的形态如下：

```text
billiardbuddy-computer-use
  ├── Skill：告诉 Agent 何时适合视觉操作
  ├── MCP tools：inspect / screenshot / click / type / scroll / launch
  └── native adapter：直接调用 macOS / Windows 的视觉与输入 API
```

插件通过 Codex 原生的 stdio MCP 生命周期启动、启用、禁用和审批；不监听局域网端口，不给它模型 Key，也不单独造一套 Electron-MCP 私有协议。运行时必须使用名为 `CODEX_HOME` 的环境变量，但它实际指向 BilliardBuddy 私有的 `agent-runtime/` 目录，与用户机器上其他 Codex 产品隔离。原生插件的“已启用”状态由 Core 的插件配置决定；Electron 只转发该配置写入，不能另存一份开关。

不做常驻“高权限系统服务”或后台守护进程。只有未来明确需要 macOS 锁屏后继续操作时，才单独评估锁屏辅助组件；该能力不属于当前 Computer Use 首版。

### 4.4 源码、参考与自研边界

锁定的 Codex Rust 源码提供 App Server、插件协议、插件/MCP 生命周期、Agent 工具审批和事件流；这些保持原样使用。已安装的 Codex/ChatGPT 桌面产品中，Computer Use、Chrome、Browser 与 Record & Replay 的实际宿主执行器为专有组件，不能复制其二进制、Skill 文本、manifest 或品牌资源。

因此，BilliardBuddy 的实现方式是：遵循公开的 Codex 插件/MCP 协议，自行编写 BilliardBuddy 品牌的 manifest、Skill、stdio MCP 工具和平台适配层。macOS 使用官方 Screen Recording / Accessibility 等系统 API；Windows 使用活动桌面与 UI Automation/Win32 等官方 API。功能以产品结果为目标，不修改 Rust Core 来迁就某个系统 API。

### 4.5 安装位置与私有运行数据

安装包和用户数据是两套位置，绝不把 Thread、模型 Key 或插件允许列表写进应用安装目录。

| 平台 | 应用本体 | BilliardBuddy 私有运行数据 |
| --- | --- | --- |
| macOS | 用户把 `BilliardBuddy.app` 从 DMG 拖到 `/Applications/`（也可选用户自己的 Applications 目录） | `~/Library/Application Support/BilliardBuddy/agent-runtime/` |
| Windows，仅当前用户安装 | NSIS 默认的 `%LOCALAPPDATA%\\Programs\\BilliardBuddy\\` | `%APPDATA%\\BilliardBuddy\\agent-runtime\\` |
| Windows，所有用户安装 | `%ProgramFiles%\\BilliardBuddy\\`（64 位系统使用 64 位 Program Files） | 每个登录用户各自的 `%APPDATA%\\BilliardBuddy\\agent-runtime\\` |

当前 NSIS 是辅助安装器：用户可选择“仅当前用户”或“所有用户”，并可改安装目录。`agent-runtime/` 首次启动 Agent 后才创建，目录名称不含 Codex；Rust Core 只是通过固定环境变量名 `CODEX_HOME` 取得该路径。模型 Key 使用 Electron 的系统安全存储，不放在 `agent-runtime/`。

首版明确不做：锁屏/安全桌面操作、读取密码字段、Keychain 或浏览器 Cookie、摄像头/麦克风、剪贴板后台监听、绕过系统授权、隐式安装扩展或任意后台进程控制。

---

## 5. 高价值高级能力的后端优先级

这一轮先完成 Agent 的本地扩展后端，不开始图片或视频工作台。优先级按“用户日常可感知价值、能够复用 Codex 原生 Agent、风险是否能清楚收口”排序：

1. **Windows Sandbox 接入**：这是现有 Codex Agent 权限在 Windows 的真实缺口；只桥接原生 readiness/setup，不另造安全系统。
2. **受管 Worktree、本地环境与 Handoff**：它把并行开发、恢复和计划任务从“主目录直接写入”收口到可管理的项目生命周期，且不增加第二个 Agent。
3. **本地插件装配基础**：让 BilliardBuddy 能以原生 Codex 方式安装、启用、运行和撤销自带插件；这是所有高级能力的共同前提，不是另一个运行时。
4. **Chrome Control**：在用户明确连接的既有 Chrome 标签页中完成网页任务；它比泛化鼠标操作更结构化、可解释，也最适合真实的网页登录、表单和资料整理场景。
5. **Computer Use**：处理没有结构化接口的原生桌面 App；能力最广，但必须以最小权限和系统授权失败关闭。
6. **Record & Replay**：把用户明确录制的重复操作整理为可审阅的 Skill/工作流，不做坐标盲回放。
7. **BilliardBuddy Browser Use、Developer Mode、Appshots**：Browser 与 Chrome 登录态隔离；开发调试与用户主动视觉附件在独立权限下补齐。
8. **Memories、外部 Agent 配置迁移、计划任务、Remote Host、Remote Runner、MCP Apps/市场**：均有价值，但分别依赖原生状态控制、安全导入、宿主调度、设备配对、云隔离或新 Renderer，不能抢在上述本机基础之前。

“先做后端”意味着每一模块先交付 Rust/MCP/原生适配器、Core 生命周期、审批/中断/撤销和打包；Renderer 只在对应后端存在后再投影状态。没有后端能力时不以按钮、演示界面或“开发中插件”冒充完成。

### 5.0 M0：Windows 原生 Sandbox 接入

Codex Rust Core 已拥有 Windows Sandbox 的协议和策略语义；BilliardBuddy 目前缺的是桌面宿主对其 `windowsSandbox/readiness` 与 `windowsSandbox/setupStart` 请求的**原生转发和安装流程**。这不是要自研一个 Sandbox，也不能通过把权限档改成 `full-access` 来绕开。

正确的调用链是：

```text
Rust Core 请求 Windows Sandbox 状态/初始化
→ Electron Main 显示状态并由用户明确发起安装
→ Windows 提权/UAC 与官方 Sandbox 组件安装
→ Rust Core 重新取得 readiness 状态
→ 需要隔离时仍由 Core 使用其原生 Sandbox 策略
```

要求：

- 只桥接 Rust App Server 已定义的状态和初始化方法；不重写 Sandbox 策略、镜像或执行器；
- 初始化必须由用户明确启动并经历 Windows 原生 UAC；拒绝、重启待完成或系统不支持时，准确回传原生失败状态；
- 隔离不可用时只能按当前 Rust 权限策略降级或失败，不能静默扩大到完全访问；
- 安装、失败和撤销只记录状态与诊断，不记录项目文件、提示词、模型 Key 或工具输出；
- Windows runner 至少验证协议桥、未准备状态、用户取消和已准备状态；真实 Sandbox 安装以 Windows 实机验收为准。

### 5.0a W1：受管 Worktree、本地环境与 Handoff

Codex 内核能理解工作区和 Git，但桌面产品的受管 Worktree、Handoff 与本地环境是**宿主层的项目生命周期能力**。它们不应被误做成第二套 Git 状态、第二个任务队列或第二个 Agent。

```text
用户或原生 Thread 选择隔离开发
→ BilliardBuddy Host 在该仓库创建/登记受管 Git Worktree
→ 可选运行用户审阅过的项目初始化脚本
→ Rust Core 仍以该 Worktree 路径创建/恢复同一个 Thread/Turn
→ Handoff 只切换工作路径与恢复点，不复制模型 Key、Agent 状态或插件权限
```

要求：

- 每个隔离任务有明确的仓库、分支、Worktree 路径、创建时间、状态和清理动作；主工作区与其他 Worktree 不被隐式改写；
- 支持项目受版本控制的环境初始化说明；不自动执行未知脚本，不复制未跟踪的秘密文件；若用户明确允许共享未跟踪文件，使用最小、可预览的包含列表；
- Handoff、快照/恢复与清理都是 BilliardBuddy 的目录和 Git 生命周期操作，恢复后仍调用 Rust 原生 Thread/Turn；
- Scheduled Task 只要可能写代码，默认要求显式选定现有 Worktree 或创建新的受管 Worktree，不能默认落到主目录；
- Worktree 删除前必须确认并确认无未提交工作；BilliardBuddy 运行目录、模型 Key、浏览器 Profile、插件配置和截图不得复制进 Worktree。

### 5.1 M1：本地高级插件装配

这是下一正式开发模块。先建立可供各个 BilliardBuddy 高级插件复用的**源码、构建与打包约定**，但不建设共享 Broker、共享工具路由或常驻服务。每个插件仍是独立 Skill + stdio MCP + 平台适配器。

交付：

- `native/<plugin>/` 的 Rust 工程、固定目标平台构建和 GitHub 原生 runner 编译；
- 每个插件自己的 manifest、Skill、`.mcp.json` 与 stdio MCP 启动约定；
- 未来 `runtime-assets/plugins/` 的 staging、签名/解包和跨平台二进制约定；
- 已有 Electron 对原生插件状态与审批事件的纯转发边界；
- 子进程退出、禁用、应用退出与异常中断时的清理规则。

不交付：面向用户的插件、插件市场注册、实际鼠标键盘控制、浏览器控制、远程连接、云端执行或一个抽象的“万能权限 API”。

首个工程以 Computer Use 为例验证 stdio MCP 进程与跨平台构建；它是源码侧的开发验证，不进入用户安装包、不注册到 Rust Core，也不显示为一个可用的半成品插件。只有 M3 具备真实、受控的桌面工具后，才将同一工程正式打入 `runtime-assets/plugins/`，再由 Rust Core 原生安装和启用。

推荐实现形态：

```text
native/billiardbuddy-computer-use/
  ├── Cargo.toml
  └── src/                    # Rust stdio MCP 与 macOS/Windows adapter

ts/desktop/runtime-assets/plugins/
  └── billiardbuddy-computer-use/
      ├── .codex-plugin/plugin.json
      ├── .mcp.json
      ├── skills/computer-use/SKILL.md
      └── bin/<platform executable>
```

### 5.2 M2：Chrome Control

Chrome Control 是第一个完整的高价值连接器。它只连接用户明确选择的 Chrome Profile/标签页或由用户确认启用的 BilliardBuddy Chrome 扩展；不读取 Chrome 原始 Profile 文件。

本机实际安装的 ChatGPT/Codex Chrome 组件证明，正确分层不是 Electron 模拟浏览器动作：Chrome 扩展通过 Chrome Native Messaging 启动一个独立的本地 Host；该 Host 校验固定扩展来源、读取运行时兼容信息，并以随机 loopback 端口转发到 App Server。BilliardBuddy 复用这一**职责划分**，但不复制 OpenAI 的专有 Host、二进制或私有 WebSocket 协议：BilliardBuddy Host 用公开 Native Messaging 协议连接我们自己的本地插件/MCP 与锁定 Rust Core。

```text
用户点击 BilliardBuddy Chrome 扩展，选择当前标签页
→ Chrome Native Messaging（Chrome 启动 BilliardBuddy Chrome Host）
→ Host 仅在 127.0.0.1 临时开放带随机令牌的桥接端点
→ BilliardBuddy Chrome stdio MCP
→ Codex Rust Core 原生插件/MCP 生命周期、工具审批与 Turn
```

`native/billiardbuddy-chrome/` 是一个 Rust 包，分别构建 `billiardbuddy-chrome`（stdio MCP）与 `billiardbuddy-chrome-native-host`（Chrome Native Host）。同一份受限 Host 源码在 macOS/Windows 原生 runner 上构建；平台差异只在注册位置：macOS 用户级 Chrome `NativeMessagingHosts/` 清单，Windows 当前用户 `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts` 注册表项。两端都只允许固定的 BilliardBuddy 扩展 ID，且 Native Host 退出即删除私有 runtime 中的 loopback 令牌文件。

交付：

- 独立的 `billiardbuddy-chrome` 本地插件，具有自己的 Skill、stdio MCP 和 Chrome 扩展/受控 CDP 连接；
- 仅用户点选连接的标签页列举、当前页面结构读取、截图、导航、元素点击、填写和有限按键等结构化工具；
- 用户选择标签页、域名允许/阻止列表与连接状态；不扫描 Profile 或任意打开的标签页；
- 发消息、提交表单、发布、删除、付费和账户/安全变更通过 Codex 原生 MCP 工具审批；
- 不读取/导出 Cookie、密码、令牌、浏览器存储或整个历史记录。

首版不交付：任意 Chrome Profile 扫描、隐式安装扩展、接管所有网页、绕开网站登录或后台读取用户会话、文件上传下载、书签/历史读取、任意 JavaScript 执行或完整 CDP 命令透传。它们必须在单独的产品确认与安全审查后才增加。

### 5.3 M3：Computer Use

实现 M1 已装配的 Computer Use 插件的原生适配层与工具行为。工具统一使用平台原生 `appId`：macOS 是已允许 App 的 Bundle ID，Windows 是已允许 App 的规范化 `.exe` 路径；不把 macOS 的 Bundle ID 概念硬套到 Windows。

允许的最小工具：

- 读取允许 App 的窗口列表和标题；
- 截取已允许 App/显示器的视觉内容；
- 聚焦、点击、键入、快捷键、滚动；
- 启动已允许的 App；
- 等待指定窗口或界面状态。

强制边界：

- macOS：屏幕录制与辅助功能权限缺失时失败关闭；
- Windows：仅前台活动桌面；不宣称后台桌面自动化；
- `screenshot` 的 MCP 图像结果只在当前模型 Provider 支持标准图像输入时向 Agent 提供；纯文本模型不伪造视觉理解，也不修改 Codex 原生上下文压缩；
- 未允许 App、密码/支付/身份验证页面、系统安全设置和破坏性操作必须再次确认；
- 截图只作为当前 Turn 的工具结果；持久化前必须另行确认；
- 用户本地输入、任务中断或权限撤销必须立刻停止自动化。

#### M3a：macOS 原生执行器（当前源码实现）

`native/billiardbuddy-computer-use/macos/BilliardBuddyComputerUseService.swift` 通过 Apple 的 Screen Recording、Accessibility、Core Graphics、AppKit API 提供：状态检查、已允许 App/窗口枚举、窗口截图、焦点元素检查、App 启动/激活、点击、Unicode 键入、限定按键、滚动和有限等待。

- 配置只从 BilliardBuddy 私有 Agent runtime（macOS 默认为 `~/Library/Application Support/BilliardBuddy/agent-runtime/computer-use/config.json`）的 `allowedBundleIds` 读取；没有配置、未允许 App、窗口失焦、窗口消失或权限缺失都失败关闭；
- 截图只经 MCP 作为当前 Turn 的图像结果返回，不写入项目或磁盘；
- 原生执行器随 Rust MCP 子进程按需启动，不监听端口、不常驻、不拥有模型 Key；
- 当前仍是后端源码阶段：在 macOS/Windows 都具备正式安装、启用与设置入口前，不进入用户安装包或插件市场。

#### M3b：Windows 原生执行器（当前源码实现）

`native/billiardbuddy-computer-use/windows/BilliardBuddyComputerUseService.cpp` 使用活动桌面、UI Automation、Win32 输入与 GDI/WIC 内存截图实现与 M3a 相同的工具语义。

- 允许列表只从 BilliardBuddy 私有 Agent runtime 的 `computer-use/config.json` 的 `allowedExecutablePaths` 读取；路径规范化后精确匹配，不扫描或接管其他 App；
- 仅当前活动 Windows Desktop 中的可见、允许 App 窗口可观察或操作；锁屏、安全桌面、窗口失焦和 UIPI 拒绝都失败关闭；
- `SendInput` 只能发送给同等或更低完整性级别的进程；不绕过 UAC、不控制其他用户会话或后台桌面；
- 截图由 GDI/WIC 在内存编码为当前 Turn 的 PNG MCP 结果，不写入文件。

Windows 编译目标是 `x86_64-pc-windows-msvc`。Win32 是 Windows API 的历史名称，适用于 64 位 Windows 桌面程序，不是 32 位专用实现。

### 5.4 M4：Record & Replay

Record & Replay 是 Computer Use 的后续能力：用户明确开始一次有限时长的录制，插件记录经脱敏的操作语义与界面状态，Agent 将其整理为一个可审阅、可编辑的 BilliardBuddy Skill/工作流。它不是自动重放坐标的宏工具。

本机 Codex/ChatGPT 当前公开形态的 Record & Replay 是 **macOS 首版**，并依赖已启用的 Computer Use；Windows 没有可直接迁移的官方实现。因此 BilliardBuddy 的 macOS 版本按同样的“明确开始 → 有限录制 → 停止 → Rust Core 生成并审阅 Skill → 以后按当前授权重放”形态接入。Windows 若提供相同用户结果，必须明确标为 BilliardBuddy 自研等价录制器，不能把它误说成 Codex Windows 原生模块。

当前源码实现为独立 `billiardbuddy-record-replay` MCP：macOS 使用 listen-only Quartz event tap，Windows 使用 `WH_KEYBOARD_LL` / `WH_MOUSE_LL` 与消息循环。两端开始前显示系统级确认，录制最长 30 分钟；只写入点击、滚动、前台窗口标题和“发生过文本输入”的脱敏事件，绝不写入键值、输入文字、剪贴板、Cookie、密码、截图或视频。停止后 Agent 只能据此起草可审阅 Skill，保存的 Skill 仍要在未来每次运行时重新经过当时的 Codex 工具审批与目标应用授权。

要求：

- 用户明确开始、停止并选择保存范围；不在后台持续记录；
- 记录不包含密码、Cookie、原始剪贴板、敏感输入或完整屏幕视频；
- 生成的 Skill/工作流需要用户审阅后才可安装/执行；
- 重复执行仍使用当时的插件系统授权、目标 App 范围和 Codex 原生工具审批，不继承一次录制的无限权限。

### 5.5 M5：Browser Use

Browser Use 与 Chrome Control 是两个不同模块，不能混用。

| 模块 | 目标 | 权限 |
| --- | --- | --- |
| BilliardBuddy Browser Use | 产品自带受控浏览器，用于检索、网页测试和开发预览 | 域名、下载、上传、CDP 开发者模式分别授权 |
| BilliardBuddy Chrome Control | 用户已登录 Chrome 的指定 Profile/标签页 | 浏览器扩展或明确 CDP 连接、Profile 选择、每网站确认 |

要求：

- 优先使用结构化浏览器/MCP 能力；视觉点击只作为退路；
- CDP 完整访问必须每网站明确确认；
- 不读取、导出或向 Agent 返回 Cookie、密码或完整浏览历史；
- 上传文件、提交表单、发消息、下单、删除数据等外部副作用一律需要确认；
- 浏览器下载和上传遵循该浏览器插件自身的文件选择与工具审批，不给任意路径。

当前源码实现为 `billiardbuddy-browser-use`：Electron Main 以 `persist:billiardbuddy-browser` 创建与用户 Chrome 隔离的 BrowserWindow，持有一个仅监听 `127.0.0.1`、随机 token 的短生命周期桥；Rust MCP 只能打开 HTTP(S) 页面、列出本模块窗口、读取有界元素快照、截图、导航、点击、输入及限定按键。新站点须经原生确认，点击始终经原生确认，密码/验证码/支付字段、上传、下载、Cookie、历史、存储及完整 CDP 都不暴露。

### 5.5a M5b：Browser Developer Mode

Browser Use 的结构化工具与完整 Developer Mode 是两种权限。前者服务于正常网页任务；后者才允许开发场景需要的 DOM、Console、Network、Styles、Performance Trace 等调试信息。它不能以“用户已打开 Browser Use”为由自动获得。

实现只扩展现有 BilliardBuddy Browser/Chrome 插件的 MCP 工具与原生审批，不修改 Core：

- 每个网站、每次连接明确显示 Developer Mode 的范围；关闭标签、断开 Chrome 连接、撤销站点许可或应用退出后立即失效；
- 调试工具先提供只读的 DOM/Console/Network 摘要和性能 trace；执行 JavaScript、修改请求、文件下载/上传或会产生外部副作用的操作仍走逐项审批；
- 任何调试输出都须过滤 Cookie、`Authorization`、密码字段、浏览器本地存储与其他 Profile 数据；工具不提供 Profile 文件读取或任意 CDP 命令透传；
- Browser Use 与 Chrome Control 各自拥有独立连接和授权记录，不能由一个入口扩大另一个入口的范围。

### 5.5b M5c：Appshots 与用户主动附件

Appshot 不是 Computer Use 的截图工具：它是用户主动把**此刻**前台 App 的画面和可访问文本附加到当前 Thread，让支持视觉输入的模型理解上下文。截图、文本和文件输入必须作为原生 Turn input 进入 Rust Core；不另建视觉上下文、摘要或记忆系统。

要求：

- 只能由用户菜单/快捷键/文件选择明确触发；默认只采集当前前台窗口，是否附带可访问文本单独可见；
- macOS 使用系统授权的屏幕和辅助功能能力；Windows 采用相同的“用户主动、当前窗口、可撤销”结果，不复制 OpenAI 专有桌面桥；
- 输入图片和选择的文件以当前 Thread/Turn 的附件生命周期处理，模型不支持图像时明确提示，不能假装已理解；
- 密码管理器、身份验证、支付和系统安全窗口必须警告并允许用户在发送前取消；不做后台屏幕历史、连续采集、隐式 OCR 或独立截图仓库；
- 截图/可访问文本不会进入 Gateway、遥测或 Worktree；其保存、删除和导出遵循该 Thread 的原生会话数据策略。

### 5.6 M6：外部 Agent 迁移与第三方连接器

接入 Rust 已有的 `externalAgentConfig/detect` 与 import 协议，但不得把检测返回的原始对象直接暴露给 Renderer 或直接交给导入接口。BilliardBuddy Main 进程以随机、单窗口绑定的短期 detection ID 缓存原始结果；Renderer 只能选择索引，Main 再以原始结果调用 Rust。

```text
扫描 Rust Core 当前支持的外部来源
→ 仅展示可迁移的 AGENTS.md、Skills、子 Agent、命令
→ 用户逐项选择
→ Electron 原生确认
→ 导入 BilliardBuddy 私有 Agent runtime
```

首版明确**拒绝** `CONFIG`、MCP、Hook、插件、Memory 和历史会话：完整配置或 MCP 常含环境变量/密钥，Hook 与插件会引入新的可执行入口，记忆和历史会话可能包含用户私密内容。它们不是“发现后自动导入”的对象；以后若要支持，必须先提供逐字段预览、去密钥化与独立审批，而不是绕过 Rust 的原生安装/启用/工具审批。

### 5.6a M6b：本地 Memories 与 Auto-review 拒绝管理

这两项都已有 Rust Core 的状态与决策权。BilliardBuddy 的工作不是新建“长期记忆引擎”或更宽松的审批规则，而是补齐用户控制和可解释性。

- Memory：桥接 `thread/memoryMode/set`、`memory/reset` 和相关原生状态。用户可全局启用/禁用、为某个 Thread 选择模式、查看状态并清空；Memory 的生成、压缩、作用域与存储仍由 Core 负责，不从外部 Agent 自动导入，不混入图片/视频 Project；
- Auto-review：当 Rust Guardian 拒绝 `approve-for-me` 下的动作时，展示该次原生拒绝原因和影响范围。用户只能对这个确定的动作作一次明确重试；重试仍回到 Rust Guardian，不能把拒绝批量改成 `full-access` 或建立 BilliardBuddy 自己的白名单；
- 用户清理 Memory、关闭 Auto-review 或切换 Thread 后，Electron 只更新原生状态，不保留第二份记忆、拒绝记录或可恢复的批准令牌。

### 5.6b M6c：MCP Apps 与 BilliardBuddy 自有市场

本地/工作区插件已是 Codex Core 的原生能力；下一层高价值能力是让具备 MCP Apps UI 资源的插件能够在未来 Renderer 内安全展示，以及建设 BilliardBuddy 自己的发现、签名和撤销服务。两者都不能依赖 ChatGPT 账号或 OpenAI 远程市场。

- MCP Apps：采用开放的 MCP Apps resource/UI 形态。Renderer 只承载受隔离的资源视图；资源与工具调用均经过 Main 的类型化桥和 Rust 的原生 MCP 生命周期，不把 Node/Electron 权限暴露给 iframe；
- 自有市场：服务器仅提供 BilliardBuddy 插件清单、签名、版本、兼容性、撤销和升级信息；客户端在安装前验证签名、显示来源与所需权限，并由用户确认；
- 本地目录、工作区目录和市场安装来源必须可区分、可禁用、可卸载和可撤销；市场失联不得阻断已安装插件，更不能导致未签名插件被自动安装；
- 前端重写前不制作伪市场界面，但现在可以固定后端包格式、签名校验和资源桥合同。

### 5.7 M7：Scheduled Tasks 与长期任务

Codex 产品提供计划任务，但当前锁定 App Server 只可确认插件目录中的计划任务元数据，未找到可直接嵌入的计划任务执行协议。因此 BilliardBuddy 的 `ScheduledAgentTaskService` 是自己的 **Host Scheduler**：它只持久化触发规则、启停和上次运行结果；到期后的智能体工作仍通过 Rust 原生 Thread/Turn 执行。这样不会复活旧自建 Agent Loop，也不会把产品调度误说成 Rust 内核已有能力。

```text
BilliardBuddy Host Scheduler
→ 到期时用保存的工作区恢复指定 Rust Thread 并创建新 Turn
→ 仍按原 Thread 的模型路由、Sandbox、桌面能力授权执行
→ 通知、事件、取消和撤销
```

当前后端支持一次、固定间隔（至少一分钟）、每天和每周规则。创建或重新启用任务时必须经 Electron 原生确认；任务仅在 BilliardBuddy 应用仍运行且存在其主窗口时执行。若 Rust Core 在任务执行中请求工具/桌面/审批，仍走既有原生审批事件；应用关闭、窗口不可用或 Thread 无法恢复时，本次记录失败而不绕开任何权限。新 Renderer 后续只投影任务列表、状态和运行结果。

要求：

- 计划任务不能隐式升级为 `full-access` 或获得新的 Computer Use 授权；
- 需要桌面控制、浏览器副作用或外部写入时，未存在的授权必须等用户回来确认；
- 任务的下次触发、失败、暂停、取消与结果摘要可被用户查看；
- 媒体 Project 的渲染/恢复调度与 Agent Scheduled Task 保持不同状态权威。

### 5.8 M8：Remote Host

BilliardBuddy 要实现自身的“移动端/另一台设备继续操控本机 Agent”能力时，采用 Host Pairing，而不是复用 OpenAI ChatGPT Remote。

```text
Remote Client
→ BilliardBuddy authenticated relay
→ paired Desktop Host
→ existing local Thread / plugins / permissions / Computer Use
```

这是源码审计得出的硬边界，不是偏好：锁定 Rust 的 `remoteControl/*` 运输层只接受 `chatgpt.com`/其测试域名或 localhost，并使用 OpenAI 账号登记、服务端 token 刷新与专属 relay；本机 ChatGPT 包也随带专有 device-key 二进制。BilliardBuddy 的模型 Gateway 身份不是 OpenAI ChatGPT 账号，因此既不能把自己的地址塞入 Core Remote Control，也不能把该私有二进制当作产品依赖。实现时复用的是“Host 出站连接、短期配对码、设备撤销、Host 上执行”的公开职责，不是它的私有协议。

要求：

- 双端二维码或一次性配对码、设备列表、撤销和会话过期；
- 远程端只能发送提示、审批和查看事件；实际文件、工具、浏览器、Computer Use 都在 Host 执行；
- Host 离线、锁屏、睡眠、系统权限取消时明确降级；
- 不把本机 Key、Cookie、完整文件或桌面内容同步到 Relay；
- Remote Host 与 Computer Use 是两层授权，彼此不能自动开启。

当前后端实现：Gateway 持久化一次性配对码的哈希、配对授权、撤销记录和 10 分钟过期的受限命令队列；Desktop Host 只在用户原生确认启用后轮询，并且只接受 `start_turn`、`steer_turn` 两种已校验命令。它们恢复或追加到现有 Rust Thread/Turn，不建立第二个 Agent Loop。锁屏、没有主窗口或应用退出时 Host 不领取新命令；任何 Core 工具、插件、Computer Use 或审批仍留在 Host 原有路径。当前尚未实现跨设备事件观看、远程审批 UI 和两台真机验收，因此不得把它称为发布完成。

### 5.9 M9：Remote Runner / Cloud Environment

Codex Cloud 环境是 OpenAI 服务；BilliardBuddy 的等价物应是自有的短生命周期 Runner：

```text
Desktop creates task package
→ BilliardBuddy Runner service
→ isolated workspace/container
→ events / artifacts / diff
→ user review
→ explicit pull/apply locally
```

此模块需要独立服务器、容器隔离、成本、网络和数据保留合同；不能借用本机完全访问权限，也不能与 Computer Use 混合。

---

## 6. 用户设置形态

未来前端不需要把所有技术开关一次性暴露给用户。设置分为三页：

```text
Agent 权限
  询问我 / 帮我审批 / 完全访问
  Memory：全局开关、当前 Thread 模式、清空
  Auto-review：显示原生拒绝原因，只能确认单次精确重试

桌面控制
  Computer Use、Chrome、Record & Replay、Browser Use、Developer Mode、Appshots、后台任务
  每项显示：已关闭 / 缺少系统授权 / 本次允许 / 已允许的 App

扩展与连接
  MCP、Skills、Hooks、本地插件、MCP Apps、外部 Agent 导入、Remote Host

项目环境
  主工作区 / 受管 Worktree、初始化说明、Handoff、快照与清理
```

用户默认只看到任务目标和当前风险。复杂范围（App ID、Profile、域名、目录、CDP、Worktree）在选择“管理权限”后展开；不能让用户填写上下文压缩、模型窗口或 Codex 内核参数。

---

## 7. 当前代码事实与清理要求

当前已存在：

- Electron 启动并校验打包的 `codex-app-server`；
- Rust 私有 Agent runtime（通过 `CODEX_HOME` 环境变量传入）；
- 三档原生 Agent 权限，`full-access` 在 Electron Main 中确认；
- Thread、Turn、恢复、压缩、Fork、后台终端；
- MCP、Skills、Hooks、本地/工作区插件和协作/Review 协议桥；
- 个人模型凭据安全代理，模型 Key 不交给 Renderer 或 Gateway。

当前明确缺失：

- Windows Sandbox 的原生 readiness/setup 桥、用户发起的安装路径与 Windows 实机验收；
- 受管 Worktree、本地环境、Handoff、快照/恢复/清理，以及计划任务对隔离工作树的选择；
- Computer Use、Chrome Control、Browser Use 与 Record & Replay 的 MCP、宿主源码、Windows/macOS 构建 staging 和安装包校验已进入正式源码链；尚缺 GitHub 两端构建、签名后的安装包和真实用户旅程验证，不能宣称已发布；
- Computer Use 面向用户的启用/允许 App 设置入口，以及 Chrome 扩展的正式发布/安装入口；当前只有后端配置格式、原生 Host 注册服务和插件安装链；
- Browser Developer Mode、Appshots/用户主动附件、Memory 原生控制、Guardian Auto-review 拒绝管理，以及 MCP Apps 资源桥和 BilliardBuddy 自有签名市场；
- Remote Host 的跨设备事件观看、远程审批 UI、两台真机验收，以及 Remote Runner；
- 外部 Agent 迁移的新前端入口（后端受限桥接已存在）；
- 计划任务的新前端入口（Host Scheduler 与原生 Thread/Turn 唤醒已存在）；
- 新 Renderer 的设置、审批、事件与能力管理界面。

当前 `full-access` 仅扩大 Rust 代码工具的文件和网络权限。它不能被改名或解释为“已拥有 Computer Use”。

旧自建 Agent 不得因为增加这些能力而复活；所有 Agent 请求继续由 Codex Rust 发起，高权限执行由对应的 Codex 本地插件完成。

---

## 8. 实施顺序与模块退出条件

| 顺序 | 模块 | 退出条件 |
| ---: | --- | --- |
| 0 | M0 Windows Sandbox | 只桥接 Core 原生 readiness/setup；UAC、取消、不支持和未准备状态均可验证，绝不静默扩大权限 |
| 0a | W1 Worktrees / local environments / Handoff | 受管 Git 生命周期、初始化、Handoff、快照/恢复/清理完整；没有第二个 Agent 或 Git 状态 |
| 1 | M1 本地高级插件装配 | Rust 工程、stdio MCP 协议、跨平台原生构建与 staging 合同完整；不向用户安装包或 Rust Core 注册半成品插件 |
| 2 | M2 Chrome Control | 仅用户选择的标签页/Profile 可连接；结构化网页操作可用；副作用、上传下载与完整 CDP 明确确认 |
| 3 | M3a Computer Use（macOS） | macOS 限定能力可用；未授权/未允许 App 失败关闭；中断和撤销可停止 |
| 3b | M3b Computer Use（Windows） | Windows 活动桌面限定能力可用；不支持场景失败关闭；中断和撤销可停止 |
| 4 | M4 Record & Replay | 录制必须明确开始/停止并脱敏；产物需审阅；重放不继承无限权限 |
| 5 | M5 Browser Use | 受控浏览器与已有 Chrome 会话隔离；副作用、CDP、上传下载均有边界 |
| 5b | M5b Browser Developer Mode | 每网站、每次连接可见授权；调试输出去秘密；关闭/撤销立即失效 |
| 5c | M5c Appshots / 主动附件 | 用户主动采集并作为原生 Turn 输入；无后台历史或独立视觉记忆 |
| 6 | M6 Migration / extensions | 迁移与插件安装逐项确认；不迁移秘密；Rust 是唯一扩展注册表 |
| 6b | M6b Memories / Guardian | 只桥接 Rust Memory 与拒绝管理；清理、关闭和单次精确重试可验证 |
| 6c | M6c MCP Apps / 自有市场 | 类型化资源桥、签名、兼容性、升级、撤销和离线安装边界完整 |
| 7 | M7 Scheduled Tasks | 宿主调度状态、隔离工作树选择、到期恢复原生 Thread/Turn、通知、暂停/取消和权限不升级完整 |
| 8 | M8 Remote Host | 设备配对、撤销、Host 上执行与权限继承边界完整 |
| 9 | M9 Remote Runner | 独立隔离、成本、网络、产物和显式回收合同完整 |
| 10 | 新前端 | 只投影上述原生/宿主状态，不新建 Agent、权限或项目状态权威 |

每个模块单独提交。模块完成必须说明：实际调用链、状态权威、用户确认、系统权限、失败/撤销、中断/恢复、密钥边界和当前未验证部分。不得以“源码有 feature”或“能够编译”作为用户能力已完成的证据。

---

## 9. 验收矩阵

### M0

- Windows Sandbox 状态、准备、安装和失败均来自锁定 Rust App Server 的原生协议；Electron 不解释或重写 Sandbox 策略；
- 用户没有明确确认时不触发安装；UAC 拒绝、重启待完成、系统不支持和组件未准备均有准确可见结果；
- Sandbox 不可用时不自动改为 `full-access`，也不替换为 BilliardBuddy 自制隔离器；
- Windows runner 验证桥接状态机；Windows 实机验证一次实际安装与 Core 隔离执行。

### W1

- 创建、Handoff、恢复和清理的每个 Worktree 都能追溯到单一仓库、分支和路径；不会改写主目录或其他任务的 Worktree；
- 初始化脚本与未跟踪文件包含清单均须预览和明确确认；Key、运行数据、浏览器数据、插件配置和截图绝不复制；
- 删除前检查未提交更改；快照恢复不复制或重建 Agent Loop、Memory、审批和模型凭据；
- Scheduled Task 对可能写入代码的任务必须使用选定/新建的隔离 Worktree，或在无法隔离时明确拒绝创建。

### M1

- Computer Use 工程是独立 Rust stdio MCP，不依赖 Electron、Bun 或局域网服务；
- macOS 与 Windows 原生 runner 都能从同一锁定源码构建该工程；
- 未来正式 manifest、Skill、MCP 配置和二进制 staging 路径一致；
- M1 产物不进入用户安装包、不出现在插件列表，也不会触发系统权限；
- `full-access` 不会自动启用任何桌面能力。

### M2

- 用户明确选择 Chrome Profile/标签页或主动连接扩展后才可建立连接；
- Agent 只能取得连接范围内的结构化页面信息，不能读取 Cookie、密码、令牌或浏览器原始存储；
- 网站副作用、上传下载与完整 CDP 高权限操作均有可见的原生确认；
- 断开连接、撤销扩展授权或关闭插件后立即失效。

### M3

- M3a 用户明确启用后才请求 macOS 系统权限；仅 `allowedBundleIds` 内的 App 可被截图/操作；Screen Recording 或 Accessibility 缺失时失败关闭；
- M3b 仅在 Windows 活动桌面上操作；非前台场景失败关闭；
- 密码、支付、身份验证、系统安全设置和破坏性动作重新确认；
- 任务中断、用户输入、窗口失焦或撤销权限后停止。

### M4

- 录制没有用户明确开始时绝不进行；结束后立即停止；
- 记录的输入/页面/截图遵循脱敏与最小保留范围；
- 导出的能力是用户审阅后的 Skill/工作流，而不是盲目坐标回放；
- 每次运行仍走当前插件系统授权和 Codex 工具审批。

### M5

- Browser Use 与 Chrome Control 使用不同 Profile/连接边界；
- Agent 永远不能读取/导出 Cookie、密码或浏览器原始密钥；
- 网站副作用和 CDP 高权限操作可见且可确认；
- 下载、上传和网页内容进入项目时有文件来源和权限记录。

### M5b–M5c

- Developer Mode 以网站和连接为最小范围，调试数据过滤 Cookie、授权头、密码与浏览器存储；撤销/关闭后不能再调用；
- Appshot 只有用户主动触发时采集当前前台窗口；屏幕与可访问文本均可取消，作为当前原生 Turn 输入而非后台历史；
- 模型不支持图像时不会将 Appshot 伪装成已理解的视觉内容。

### M6–M6c

- Memory 的开启、Thread 模式和清除调用 Rust 原生接口；BilliardBuddy 不另存记忆，也不从外部 Agent 导入记忆；
- Guardian 拒绝只展示原生理由并允许确定动作的一次确认重试；不得形成主机白名单或权限升级；
- MCP Apps 资源运行在隔离视图，不能直接取得 Electron/Node 权限；市场包必须验签且可撤销，离线时不自动安装未知包。

### M7–M9

- 迁移、插件、远程主机、云 Runner 都不扩大本地 Agent 的默认权限；
- 设备、插件、MCP、Hook 和远程 Runner 均可独立撤销；
- BilliardBuddy 不依赖 OpenAI 账号、ChatGPT Subscription 或 OpenAI 私有 Remote/Cloud 服务；
- 任何 Key、令牌、Cookie、完整桌面截图或用户原始文件不会进入 Gateway、日志或不受信 Relay。

---

## 10. 参考证据

- 锁定源码：`third_party/codex-engine/codex-rs/app-server/README.md`；
- 锁定源码：`third_party/codex-engine/codex-rs/features/src/lib.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/core-plugins/src/discoverable.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/app-server/src/request_processors/plugins.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/core/src/mcp_tool_call.rs`；
- 当前桥：`ts/desktop/electron/services/codexNativeAppServer.ts`；
- 当前权限确认：`ts/desktop/electron/main.ts`；
- 官方 Codex 手册：[Computer Use](https://learn.chatgpt.com/docs/computer-use)、[Browser](https://learn.chatgpt.com/docs/browser?surface=app)、[Chrome extension](https://learn.chatgpt.com/docs/chrome-extension)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Appshots](https://learn.chatgpt.com/docs/appshots)、[Remote connections](https://learn.chatgpt.com/docs/remote-connections)、Cloud environments、MCP、Skills、Hooks、Plugins、Scheduled tasks。
- 平台 API：Apple [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos?changes=_9)、Apple [Accessibility API](https://developer.apple.com/documentation/applicationservices/axuielement_h)、Microsoft [UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview)。

本合同只规定 BilliardBuddy 的产品实现边界；第三方插件、浏览器扩展、远程服务和操作系统自动化在接入前仍须分别审查许可证、平台政策、隐私、系统 API 和发布渠道要求。
