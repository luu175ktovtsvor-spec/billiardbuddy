# BilliardBuddy Codex 全能力与高权限宿主开发合同

> 文档性质：Agent 宿主、桌面能力、扩展能力与远程能力的后端开发合同
>
> 目标仓库：`luu175ktovtsvor-spec/billiardbuddy`
>
> 锁定内核审阅基线：`third_party/codex-engine` 提交 `2b5bdcf67547860f2e5c5a605009a70026796b2b`；BilliardBuddy 当前状态须以本仓库实时代码和验证结果为准，不以过期的 `main` 提交号代替事实。
>
> 参考：锁定的 `third_party/codex-engine` Rust 源码，以及官方 Codex 桌面手册
> 产品边界：BilliardBuddy 使用 Codex Rust App Server 作为 Agent 内核；图片、视频由 BilliardBuddy 自己的工作台承担；不建设语音输入、语音对话、语音合成和声音克隆。
>
> 最后一次源码审计：2026-08-03。本文严格区分四种状态：**源码已接入**、**本机已验证**、**跨平台构建已验证**、**真实用户旅程已验证**。只有具备对应证据时才能使用相应表述；“源码存在”“能够编译”“已放入安装包”和“用户可用”不是同一件事。

---

## 0. 最终架构判定

**判定：当前主架构正确，并且已经把可合法复用、可从源码验证的 Codex Agent 部分用到了应有边界。** 正式产品只有一个 Agent：锁定源码构建出的 Rust App Server/Core。Electron 是它的桌面客户端和高权限宿主，模型代理只解决凭据与协议，图片/视频 Sidecar 只解决 BilliardBuddy 自有领域；三者都不是第二个 Agent。

这也是比“把 Codex 再包进一个自写 Harness”更稳的形态：Thread/Turn、Agent Loop、上下文压缩、工具选择、Sandbox、审批、MCP、Skills、Hooks、插件、协作与恢复仍由同一份 Rust 状态权威完成。BilliardBuddy 只在开源源码没有包含、但桌面产品必须拥有的边界上写自己的宿主执行端，例如系统截图与输入、受控浏览器、Chrome Native Messaging、录制器和以后用户主动触发的 Appshot。

本机 `ChatGPT.app` 的只读实物再次证明官方桌面产品也是这种分层，而不是“所有桌面能力都写在 Rust Core 里”：App Server 与 Code Mode Host 是内核运行资源；Computer Use、Record & Replay、Browser、Chrome 等通过 Skill、MCP、浏览器宿主或专用执行器进入同一个 Core。官方包中的部分浏览器客户端、Computer Use launcher 和账号/远程服务是未开源产品组件，BilliardBuddy 不复制它们的二进制或私有协议，而是在相同公开扩展边界上实现自己的等价宿主。

因此“已使用 Codex 后端”的准确含义是：**Agent 操作系统与状态机来自原生 Rust Core；产品桌面能力通过 Core 的公开插件/MCP/输入边界接入。** 它不等于已经获得 OpenAI 的 ChatGPT 账号、云端计费、远程控制、私有浏览器运行时或尚未完成的 BilliardBuddy 用户界面，也不允许把后续路线图写成当前已交付功能。

开发说明与产品内容必须永久分开。诸如“写工具由 Core 的 MCP 审批处理”“锁定源码尚未提供某接口”“当前只有录制骨架”只写在本合同、源码注释和验证中；安装包内的 Skill、插件描述、弹窗和错误提示只说明 BilliardBuddy 用户能做什么、何时确认、如何撤销和怎样恢复。构建脚本会拒绝随包产品内容混入 Core 所有权或施工状态措辞。

## 1. 目标与完成定义

BilliardBuddy 不重写 Codex 的 Agent Loop、上下文压缩、工具选择、Thread/Turn、Sandbox、审批、MCP、Skills、Hooks 或插件运行语义。

目标是让用户在 BilliardBuddy 中获得与 Codex 桌面产品同类的本地 Agent 能力，并由 BilliardBuddy 自己拥有桌面权限、密钥、模型路由、产品状态与品牌。

### 1.1 事实判定顺序

发生冲突时按以下顺序判断，不允许用更新版产品界面反推当前锁定源码一定存在某个 API：

1. `third_party/codex-engine` 的锁定 revision 是 BilliardBuddy 当前 Rust 内核运行能力和协议的第一事实；
2. BilliardBuddy 当前代码、打包脚本和实际验证结果是“产品是否已接入”的第一事实；
3. 官方文档和本机较新 Codex/ChatGPT App 用于判断目标用户结果、组件边界和升级方向；
4. 官方桌面 App 中未开源的二进制、Skill 文本、私有协议和账号服务只作只读证据，不复制，也不假定锁定 revision 已拥有同名配置。

例如，本机较新产品可以出现 Windows Computer Use 的 App allowlist 配置，但当前锁定 revision 中不存在 `[computer_use.windows].always_allowed_app_ids`。因此当前 BilliardBuddy Computer Use 插件必须保留自己的目标 App 范围配置；这不是第二个 Agent 审批引擎。未来升级到确有该原生配置的 revision 后，才重新评估迁移。

```text
BilliardBuddy Desktop
├── Codex Rust App Server
│   ├── Agent Loop / Thread / Turn / Context / Compaction
│   ├── Files / Shell / Git / Sandbox / Approval
│   ├── MCP / Skills / Hooks / Plugins / Collaboration
│   ├── Native event stream
│   └── Codex Code Mode → 随包的 codex-code-mode-host companion
├── BilliardBuddy Electron Host
│   ├── Window / trusted IPC / Keychain / lifecycle
│   ├── 受限协议桥与未来 Renderer 的原生状态投影
│   ├── BrowserWindow / Chrome Native Messaging / 系统权限宿主
│   └── 打包的本地 Codex 插件、Skills、MCP 与宿主运行资源
├── BilliardBuddy model routes
│   ├── Managed DeepSeek Responses Gateway
│   ├── Personal Responses Key proxy
│   └── Personal Chat Completions adapter
└── BilliardBuddy product domains
    ├── Image Workbench
    └── Video Workbench
```

“全能力对齐”不等于复用 OpenAI 的 ChatGPT 账号、云端计费、远程市场或私有服务。当前阶段只完成本机 Agent 后端和明确选择的本机高级能力；Remote Host、SSH、Cloud Runner 等列为后续规划时，不得提前把运行代码、Gateway 路由或设置入口塞进当前产品。

### 1.2 本次一次性构建的范围

本文既记录当前 Agent 后端，也保留后续高价值路线。为避免把路线图误当成这次必须一次做完的代码，本次 GitHub 跨平台构建只验证以下已经进入正式源码链的范围：

1. 锁定 Codex Rust App Server/Core、同 revision 的 `codex-code-mode-host`、三份凭据隔离补丁及双二进制清单；
2. Electron Main 对原生 Thread/Turn、状态、审批/交互回调、MCP、Skills、Hooks、插件、协作、Review、Memory、Windows Sandbox 的类型化桥；
3. 托管 Responses、用户 Responses 与旧 Chat Completions 本机协议适配三条模型路线；
4. Computer Use、Chrome Control、Browser Use 和 Record & Replay 的当前源码、MCP、平台适配器、staging 与安装包资源校验；
5. 已进入源码的简化计划任务恢复链，以及旧 Remote Host、自建 Agent 设置和旧 Agent 运行路径的清除。

其中 Record & Replay 仍是安全录制骨架，四个高级插件仍缺签名安装包与 macOS/Windows 真实用户旅程；它们可进入构建验证，但不得因此标为正式可用。WSL2、Worktrees/Handoff、集成终端、Browser Developer Mode、Appshots 桌面采集、完整 Activity/子 Agent 图、自有在线市场、SSH、Remote Host、Remote Runner 和新前端是后续模块，**不属于这次构建门禁，也不得以空壳提前塞入运行代码**。

### 1.3 “全部做完再构建”的准确含义

本轮所说的“全部做完”是：第 1.2 节已经进入正式源码链的内容完成总审计、必要修正、文档同步和所有本机可执行验证，然后只触发一次 macOS/Windows GitHub 构建。它不表示为了跑这一次构建，要先把第 5 节全部路线图或新前端一起开发完。

GitHub runner 只承担本机不能代替的平台证据：Windows MSVC/Win32 编译，以及 macOS/Windows 干净 checkout 下的 App Server、Code Mode Host、Sandbox 辅助程序、本地插件和受管运行资源生成。类型错误、协议遗漏、源码不可达、Skill 施工文字、macOS 本机插件编译和可本地运行的 MCP/Browser 链路必须在触发 GitHub 之前发现，不能把 Actions 当成逐文件试错环境。完整桌面安装包还依赖媒体工具链、macOS Developer ID/公证凭据和媒体模块最终合入，属于后续发行工作流，不与本轮 Agent 后端矩阵混为一次构建。

---

## 2. 三类能力边界

### 2.1 Rust 内核原生能力：直接保留

这类能力已经由锁定的 Codex Rust App Server 负责。BilliardBuddy 只转发协议、提供模型和显示事件，不写第二个实现。

- Thread、Turn、恢复、归档、Fork、Rollback、Goal；
- Prompt、Context、原生压缩与任务循环；
- 文件读取、补丁、Agent Shell/Git 工具与 Agent 后台终端；
- Workspace Sandbox、网络限制、审批与自动审批审阅；
- MCP、Skills、Hooks、插件声明与生命周期；
- Code Mode 的工具编排与执行语义；启用时使用锁定源码配套的 `codex-code-mode-host`，不另写执行器；
- 子 Agent、协作模式、Review；
- 工作区规则、`AGENTS.md`、项目 Skills 与外部 Agent 配置检测/迁移；
- 原生事件、工具调用、审批和交互请求流。

`CODEX_HOME` 只是 Rust 的固定兼容环境变量，在本产品中始终指向 BilliardBuddy 私有 `agent-runtime/`，不是用户的 `~/.codex`。但项目中的 `.codex/` 仍是锁定 Core 识别 Hooks、插件等上游兼容配置的文件位置，`$HOME/.agents/skills` 也是 Core 原生发现用户安装 Skill 的共享位置；不能为了品牌把这些兼容路径静默改名后宣称原生兼容。Electron 只允许显式 Skill 选择读取 Core 已定义的工作区、私有 runtime、随包插件与 `$HOME/.agents/skills` 根，并继续校验真实普通 `SKILL.md`；BilliardBuddy 不自动创建、复制或写入其中的 Key、账号文件或用户全局配置。

### 2.2 高权限桌面能力：由 BilliardBuddy 宿主实现

这类能力需要真实操作系统权限、窗口状态、浏览器会话或用户选择。Codex Rust 可以调度工具，但不能代替操作系统授予权限，也不包含 OpenAI 桌面产品私有的执行器。BilliardBuddy 只提供对应插件的本地执行端，不再另建通用权限中台。

- Computer Use：屏幕、窗口、点击、输入、滚动、允许的 App 启动；
- Browser Use：BilliardBuddy 受控浏览器、页面检查和网页操作；
- Chrome Control：用户选择的 Chrome Profile/标签页与开发者模式 CDP；
- 剪贴板、文件选择和工作区外文件导入；
- 用户主动打开的集成终端、项目 Actions 与 Git Diff/Stage/Revert/Commit/Push/PR 操作；
- 系统通知、后台任务和受控的开机后恢复；
- 未来自建云执行环境的提交、状态和结果取回。

### 2.3 OpenAI 产品/云端专属能力：做 BilliardBuddy 等价物

以下不是把 Rust 源码编译进安装包就会出现的能力：

- ChatGPT 账号、订阅、OpenAI Credits、官方远程插件市场；
- OpenAI Cloud 环境、GitHub 云端代码审查、Slack 云端集成；
- ChatGPT Remote 的账号配对与中继服务；
- OpenAI 服务器执行的托管网页搜索、原生图像生成和实时语音；这些不是仅靠本地 Core 就能凭空提供的服务。

处理原则：

- 模型、额度、计费：继续走 BilliardBuddy Gateway 与用户自带 Key；
- 图片/视频：继续走 BilliardBuddy 自己的工作台，不启用 Codex 原生 Image Generation；
- 语音：明确不做；
- 远程与云：当前不实现；未来另立合同后再决定是否建设 BilliardBuddy Host Pairing / Remote Runner；
- 远程插件市场：不接入 OpenAI 账号体系，只支持 BilliardBuddy 本地、工作区和以后自有市场。

---

## 3. Codex 能力矩阵与当前状态

| 能力组 | Codex 形态 | BilliardBuddy 当前状态 | 最终处理 |
| --- | --- | --- | --- |
| Agent Loop、Context、压缩 | Rust Core | 已使用 Rust Core | 保持原样 |
| Thread、Turn、Fork、Rollback、Goal、恢复 | App Server | 已桥接 | 未来新前端投影原生状态 |
| Code Mode / `codex-code-mode-host` | Rust Core + 官方源码配套 companion | staging、schema 6 manifest、启动前双二进制哈希校验和 GitHub 构建脚本已补齐；macOS arm64 companion 已在同 revision/补丁集下从源码构建、暂存并通过启动校验，Windows x64 仍待 GitHub 原生构建，真实 Core Turn 仍未验收 | 用同一 revision、补丁集和目标平台完成一次最终构建；不重写或强开实验 Code Mode |
| 受管 `rg` 搜索运行时 | 锁定源码 `scripts/codex_package` + Core Install Context/PATH | 审计发现旧 staging 只依赖用户系统 PATH，不能保证 Windows 或全新 macOS 安装具备 `rg`；现已改为复用锁定源码的版本、目标、下载源、大小和 SHA-256 清单，纳入 schema 6 并在启动前校验后加入 Agent PATH | macOS/Windows 最终构建都必须包含并校验该目标的 `rg[.exe]`；不自行维护另一份版本表 |
| 文件、Shell、Git、Sandbox、后台终端 | Rust/Exec | 已桥接后台终端与 Windows Sandbox readiness/setup；Windows 原生辅助程序纳入受管运行时 | 不重写；等待 Windows runner 与实机 UAC 验收 |
| Windows WSL2 Agent 环境 | Linux Codex Core + WSL2/bwrap | 未接；当前 Windows 只启动原生 App Server | 允许用户在 Windows Native/WSL2 间明确选择；不支持 WSL1 |
| 三级 Agent 权限 | Rust Sandbox + approval | 已有 `ask/approve-for-me/full-access` | 保留，不能代替桌面权限 |
| 原生配置、Rules、项目信任、Permission Profiles | App Server + `config.toml`/`.codex` | `configRequirements/read` 与 `permissionProfile/list` 已经类型化 Main 桥接；任意 `config/read` 因可能夹带敏感配置而不暴露给 Renderer | Rust 配置层级是唯一权威；后续只补受限、去秘密的状态投影/逐字段写入 |
| MCP、OAuth、Skills、Hooks | App Server | 已桥接本地配置/列表/授权请求 | 保持 Rust 为唯一注册表 |
| 本地/工作区插件市场 | App Server | 目录/安装协议已桥接；锁定源码仍把 `plugin/install`/`uninstall` 标为 under development | 保持 Rust 注册表和用户确认；在上游接口成熟且实测前不得宣称发布稳定 |
| OpenAI 远程插件市场 | ChatGPT 服务 | 刻意未接 | 后续 BilliardBuddy 自有市场，不复用 OpenAI 账号 |
| 外部 Agent 配置迁移 | App Server | 检测/导入已通过受限 Electron 桥接；新前端未投影 | 仅迁移安全类别，逐项确认 |
| Collaboration、子 Agent、Review | Rust Core | 已桥接协作/Review 调用和通用事件；Thread 列表尚不能按父子/祖先读取完整子 Agent 图 | 补齐只读 Thread 图与状态投影；不自建调度器 |
| Thread 资料库、Sections、Activity/通知 | App Server + 桌面宿主 | 历史、搜索、精确匹配、归档、Sections 增删改查与 Thread 移动已桥接；loaded/unsubscribe、未读/需处理聚合与通知策略未接 | Rust Thread Store 为事实，Host 只保存显示偏好和系统通知授权 |
| 多文件夹本地项目 | 桌面宿主 + Core runtime roots | 未接；当前每个 Thread 固定 `runtimeWorkspaceRoots: [cwd]` | 一个 primary 负责 cwd/Git/配置发现，secondary 只作为明确授权的附加 workspace roots |
| Worktrees、Handoff、本地环境 | 桌面宿主 + Git | 只有 Rust Workspace 与 Git 基础；没有 Codex 语义的受管工作树、代码迁移式 Handoff、初始化或可恢复快照 | BilliardBuddy Host 负责 Git 生命周期；不建设第二个 Git 状态或 Agent Loop |
| 集成终端、项目 Actions、Git 操作面板 | 桌面宿主 + 受限进程/Git 服务 | Agent 后台终端已接；用户终端、Actions 与显式 Git 操作未接 | 与 Agent 工具严格分开；不得把原始进程 JSON-RPC 暴露给 Renderer |
| Scheduled Tasks | Codex 产品能力 + 宿主调度 | Host 调度、受限 IPC、持久化与原生 Thread/Turn 唤醒已进入源码链；尚无 Local/受管 Worktree 目标选择 | 默认隔离 Worktree；用户可明确选择 Local，绝不默认写入主目录 |
| 本地 Memories / 项目长期上下文 | Codex Core/产品状态 | `thread/memoryMode/set` 和经 Main 破坏性确认的 `memory/reset` 已桥接；记忆内容仍由 Rust Core 生成、压缩和存储 | 以 Rust 的 Thread/项目状态为事实；不混入媒体 Project，也不另建记忆引擎 |
| Web Search | 模型/服务工具 | 托管 Responses 与个人 Responses 原样保留 Core 的 hosted web-search 请求；旧 Chat Completions 无标准对应物，因此只在该 Provider 路线关闭 hosted web search | 不改 Core、不加第二套搜索适配；真实 Responses Provider 是否执行该服务器端工具由其兼容能力决定，普通本地/MCP 搜索与 hosted web search 不互相冒充 |
| Built-in Browser / Browser Use | Skill 插件 + 桌面浏览器宿主 + 工具运行时 | 独立 Electron profile、受限 loopback Host 与 stdio MCP 已进入源码链；这是公开插件边界内的等价实现，但不是本机 ChatGPT 当前的 Node REPL/browser-client 内部路径；尚未两端构建 | 保持 Core 原生插件生命周期；按用户结果验收，不宣称复用了 OpenAI 私有 Browser runtime |
| Chrome Extension / CDP | Skill 插件 + 扩展 + Native Messaging/浏览器宿主 | 扩展、Native Messaging Host、stdio MCP、打包链及用户确认的安装/卸载/状态 IPC 已进入源码链；这是公开插件边界内的等价实现；完整 CDP Developer Mode 尚未接入 | 先完成结构化控制的两端构建与真实 Chrome 旅程，再单独设计完整 CDP |
| Computer Use | 桌面插件 + OS 权限 + 原生服务 | macOS/Windows 原生适配器、MCP、插件专用允许列表与打包链已进入源码链；尚未两端构建和真实权限验收；macOS locked use 未实现 | 锁定 revision 没有可复用的 Windows Core allowlist API，插件配置暂为唯一目标 App 范围；升级后再评估上游迁移 |
| 远程连接到本机 Host | 账号配对 + 桌面服务 | 按用户边界明确暂不做；旧提交中的 Electron/Gateway Remote Host 运行链已清除 | 仅保留路线图，未来另立合同后再实现 |
| SSH 远程项目 | OpenSSH + 远端 App Server | 未接 | 通过 SSH stdio 启动匹配 revision 的 BilliardBuddy App Server；不暴露公网端口 |
| Cloud 环境/云任务 | OpenAI 云服务 | 未接 | 建设 BilliardBuddy Remote Runner |
| Appshots、用户主动视觉/文件附件 | 桌面宿主 + App Server Turn 输入 | 文本、内联/本地图片、内联/本地音频、Skill 与 Mention 已按 Core 原生 `UserInput` 类型接入，Turn start 与 steer 使用同一映射；本地文件经过真实路径、允许根、符号链接、大小和文件头校验。前台窗口捕获、可访问文本提取及工作区外文件选择授权仍未实现 | 用户主动采集/选择后作为原生 Thread/Turn 输入；不等同 Computer Use，也不代表建设独立语音产品 |
| Auto-review 拒绝管理 | Rust Guardian / App Server | `approve-for-me` 已映射 Auto-review；拒绝记录和单次精确覆盖尚未接 | 保持 Rust 审阅权威，只显示理由并允许用户对某一次动作明确重试 |
| MCP Apps 与自有插件市场 | App Server + 桌面宿主 + BilliardBuddy 服务 | 本地/工作区插件已接；资源 UI、签名市场、搜索、发布、撤销尚未接 | 采用开放 MCP Apps UI；未来市场为 BilliardBuddy 自有服务，不使用 OpenAI 账号 |
| 图像生成 | OpenAI 图像服务 | 已关闭原生入口 | 由 BilliardBuddy Image Workbench 等价承担 |
| 视频剪辑 | 非 Codex 原生领域 | BilliardBuddy 自有领域 | 由 Video Workbench 承担 |
| 语音 | 桌面/云服务 | 不采用 | 不建设 |
| App Server 生命周期、恢复、诊断与上游升级 | Rust 进程 + Electron Host + 构建链 | 已有 App Server/companion 清单和启动前真实哈希校验、子进程失效通知、凭据撤销和 Thread 再恢复基础；尚无完整 Activity 恢复/诊断验收 | 不复制 Thread；升级锁定 revision 后重跑协议、补丁、两端构建和真实旅程 |

当前 Electron 桥已经把 Thread/Turn 的主调用链及原生文本、图片、音频、Skill/Mention 输入，模型目录/能力、权限 Profiles/受管 requirements、Memory 控制、Thread Sections/精确搜索、MCP、Skills、Hooks、插件、协作、Review、Agent 后台终端及受限的外部 Agent 迁移转发至 Rust。Sidecar 中旧 `webSearch`/`deepThinkingEnabled` 自建 Agent 设置已清除；网页搜索和推理行为只由 Rust Core 与真实 Provider 能力决定。未完成的原生状态投影主要是去秘密的有效配置/项目信任、loaded/unsubscribe 生命周期和完整子 Agent Thread 图；Appshots 还缺桌面采集与用户授权入口，但不再缺 Core 输入协议。`codex-code-mode-host` 的源码构建、staging、manifest 与启动校验已补入工作树，macOS arm64 已生成并校验本地产物；Windows 和真实 Core Turn 仍待最终验证。Computer Use、Chrome、Browser Use、Record & Replay 和计划任务已进入后端源码；前四项尚缺跨平台发布级验证，其中 Record & Replay 仅是安全录制骨架。Remote Host 已按“暂不做”从运行代码清除。Cloud Runner、SSH 和新 Renderer 仍未实现。本合同下述顺序是后端建设优先级，不代表这些用户入口已经存在。

### 3.1 锁定 Rust 协议的完整审计结论

对锁定版本 App Server 的全部 Client Request 做了逐项审计：目前有 **59 个**请求经类型化 Electron Main 桥直接进入 Rust，另有 **77 个**已被验证脚本逐项登记为不暴露。登记不等于遗漏：它们必须属于刻意排除的云账号/远程服务、危险原始旁路、源码内部/实验迁移接口，或者在合同中明确列为后续产品模块。边界如下：

- OpenAI 账号、云端额度、远程应用和反馈服务：不接入，使用 BilliardBuddy 自己的账号、Gateway 和未来 Remote Runner；
- Agent 发起的文件系统、Shell、PTY 与进程操作：刻意不向 Renderer 暴露原始 JSON-RPC，必须由 Rust 工具、Sandbox 和审批链执行；用户主动终端/Actions 是独立宿主能力，只能通过限定 cwd、会话句柄、输出上限和显式关闭的类型化 API；
- 源码调试、实验开关和历史导入内部步骤：不作为产品 API；
- Remote Environment/设备控制：不复用 OpenAI 私有服务，按 M8/M9 走 BilliardBuddy 自有配对与隔离；
- `configRequirements/read` 与 `permissionProfile/list` 已做类型化 Main 桥；`config/read` 可含模型、MCP 或环境配置，不将其任意结构直接交给 Renderer。后续如需显示有效配置，必须在 Main 逐字段去秘密；写设置仍只能调用明确允许的 Core key；
- `threadSection/*`、`thread/section/move` 和 `thread/searchOccurrences` 已直接接入 Rust Thread Store；`thread/loaded/list`、`thread/unsubscribe`、`thread/metadata/update` 以及 `thread/list` 的 Section/cwd/source/父子过滤仍属于生命周期、Handoff、Activity 和子 Agent 图后续缺口，不能用 Electron 的第二份状态代替；
- `model/list`、`modelProvider/capabilities/read`、`thread/memoryMode/set` 与 `memory/reset` 已接入；它们只读取/修改 Core 的原生事实。BilliardBuddy 的托管模型与用户 Key 仍由产品模型路由选择；不得从模型名猜窗口、输出上限或多模态能力，也不得改写 Core 压缩策略。

协议验证会在锁定上游新增方法时失败，要求将新增方法接入类型化桥，或在上述边界中写明具体原因；不能依赖“源码存在但产品尚未判断”的默认遗漏。

---

## 4. 高权限宿主的正式架构

### 4.1 按 Codex 插件形态接入

不新增通用 `PrivilegedCapabilityBroker`、自定义能力注册表或第二套 Agent 工具路由。高权限能力按 Codex 的现成扩展边界接入，但不能把所有能力误写成同一条链。插件可以是 **Skills only、MCP only，或 Skills + MCP**；系统权限和浏览器对象由真正拥有它们的宿主提供。

本机 `ChatGPT.app`（`26.727.51351`）的只读盘点证明当前桌面产品至少有三种正式形态：

- Computer Use 与 Record & Replay：包内插件同时声明 Skill 和 `.mcp.json`，MCP 再连接独立的 Computer Use/事件流执行端；
- Browser 与 Chrome：包内插件声明 Skill 和浏览器客户端资源，但 manifest 不声明 `.mcp.json`；Electron 按 Thread 动态注入受限 Node REPL/浏览器宿主配置，并持有内置 Browser 或 Chrome 扩展连接；
- Appshots：由桌面宿主和 Computer Use 原生服务主动采集，再作为 Thread 附件输入，不是一个让 Agent 后台截图的普通插件工具。

本机包内可读的四份 `SKILL.md` 还证明了另一条边界：Skill 负责选择正确能力、描述工作流、要求在副作用发生前确认、处理断连和失败；它不授予系统权限，也不能替代执行端的硬校验。BilliardBuddy 因此在自己的 Skill 中保留“优先连接器、显式浏览器选择、第三方内容不构成授权、录制后不轮询”等操作语义，同时由代码强制 App/网站允许范围、前台窗口、凭据字段拒绝、短期连接令牌和文件范围。标准 MCP `annotations` 只标出真正只读的工具；写操作继续由 Codex Core 的原生 MCP 审批决定，不在 Electron 再实现第二套点击审批。

必须把**开发事实**与**产品内容**分开：上段关于 Core、MCP、审批归属和验证状态的说明只属于本合同、源码注释和测试。随安装包交付的 `SKILL.md`、插件介绍、弹窗与错误提示只能使用 BilliardBuddy 产品语言，说明何时使用、用户会看到什么、哪些动作需要确认以及怎样恢复；不得写入“Codex Core 负责审批”“当前源码尚未支持”“以后补齐”等施工说明。`CODEX_HOME`、`.codex-plugin`、App Server 方法名和固定 companion 文件名属于内部兼容接口，可以保留在实现中，但不得主动显示成产品品牌或用户设置概念。

因此 BilliardBuddy 的原则是“复用同一个 Codex Core 与原生插件生命周期，按能力选择最小宿主”，不是强行让每个模块拥有相同目录。macOS Computer Use 执行器可以是按需启动、具备稳定签名身份的 `BilliardBuddy Computer Use.app`；Browser/Chrome 则必须经过 Electron 持有的浏览器会话。两者都不能变成第二个 Agent Loop。

```text
Codex Rust Core
→ 已安装并启用的 Computer Use plugin
  ├── Skill：何时应使用视觉操作
  └── local stdio MCP server：screenshot / click / type / scroll / launch
→ 插件自带的 macOS `BilliardBuddy Computer Use.app` / Windows adapter
→ 操作系统权限与目标 App
→ 原生工具结果 / 原生事件流
```

Electron 的职责包括：启动打包的 Codex App Server 与配套 companion、转发原生插件状态/审批事件、在用户主动操作时打开系统授权页面，以及持有只能由桌面宿主掌握的 BrowserWindow、Chrome Native Messaging 连接和系统输入入口。Computer Use 的本地 MCP 可以直接连接原生执行器；Browser/Chrome 的工具调用必须经过 Electron 宿主。Electron 无论是否在数据路径中，都不决定 Agent Loop、上下文、工具选择或最终审批，也不保存第二份 Agent 审批状态。

系统权限、App 允许列表和工具审批仍是三层各自负责：

- macOS Screen Recording / Accessibility 或 Windows 活动桌面：操作系统；
- 允许某个 App 或“始终允许”：Core/Computer Use 的原生配置与平台 App 身份校验；
- 工具是否可调用：Codex 原生插件/MCP 工具审批与当前 Thread 的 Sandbox 设置。

### 4.2 不把桌面权限伪装成三个 Agent 档位

三个 Agent 权限档保持其原生含义：

| Agent 权限 | Rust 代码工具 | 桌面能力 |
| --- | --- | --- |
| `ask` | 工作区写入/高风险代码动作请求确认 | 可以请求插件工具；是否批准仍由原生工具审批决定 |
| `approve-for-me` | Rust 按原生规则审阅可批准的代码动作 | 不改变任何系统或插件授权范围 |
| `full-access` | `danger-full-access`，代码工具可访问更广文件与网络 | 仍只可以请求已启用的插件；不会自动获得屏幕、鼠标键盘、浏览器登录态或 Keychain |

`full-access + Computer Use` 的正确体验是：用户先安装并启用插件，首次按系统提示授予权限并在插件中批准目标 App；之后 Agent 才能按 Codex 原生工具审批在这些已允许 App 内连续执行。三个 Agent 档位不是 BilliardBuddy 自定义的桌面权限表，也不能把权限横向扩展到浏览器 Cookie、摄像头、麦克风或 Keychain。

### 4.3 本地插件与宿主运行时接法

Computer Use、Chrome、Browser 和 Record & Replay 都作为 BilliardBuddy 随安装包提供的独立本地 Codex 插件接入；不得把它们拼成一个 Electron 工具集合。Computer Use 的形态如下：

```text
billiardbuddy-computer-use
  ├── Skill：告诉 Agent 何时适合视觉操作
  ├── MCP tools：inspect / screenshot / click / type / scroll / launch
  └── native adapter：直接调用 macOS / Windows 的视觉与输入 API
```

Computer Use 与 Record & Replay 通过 Codex 原生的 stdio MCP 生命周期启动、启用、禁用和审批。BilliardBuddy 当前 Browser/Chrome 也采用独立 stdio MCP，这是 Codex 公共插件架构允许的等价实现；它与本机 ChatGPT 当前使用的 Skill + Node REPL/browser-client 宿主路径不是同一内部代码形态，文档与产品不得将其宣传为“直接复用了官方 Browser runtime”。验收以同一用户能力、权限边界、失败与撤销质量为准；仅为模仿私有内部形态而增加一层运行时没有价值。

Codex Code Mode 与浏览器的 Node REPL 也不能混为一个东西：`codex-code-mode-host` 是 Rust Core 配套的 Code Mode companion；`mcp_servers.node_repl` 是桌面宿主为 Browser/Chrome/Computer Use 注入的受限 MCP 运行环境。BilliardBuddy 必须先把前者按锁定源码正式打包，后者只有在选择 Node REPL 浏览器实现时才建设；不能拿现有 Browser MCP 冒充 Code Mode Host。

所有本地工具均不监听局域网端口，不持有模型 Key。若宿主桥使用 loopback 或 native pipe，只能绑定本机、使用每次启动的随机 capability，并验证连接端身份。运行时必须使用名为 `CODEX_HOME` 的环境变量，但它实际指向 BilliardBuddy 私有的 `agent-runtime/` 目录，与用户机器上其他 Codex 产品隔离。原生插件及其 server/skill 组件的启用状态由 Core 的插件配置决定；Electron 只转发允许范围内的原生配置写入，不能另存一份开关。

不做常驻“高权限系统服务”或后台守护进程。只有未来明确需要 macOS 锁屏后继续操作时，才单独评估锁屏辅助组件；该能力不属于当前 Computer Use 首版。

### 4.4 源码、参考与自研边界

锁定的 Codex Rust 源码提供 App Server、`codex-code-mode-host`、插件协议、插件/MCP 生命周期、Agent 工具审批和事件流；这些保持原样构建使用。已安装的 Codex/ChatGPT 桌面产品中，Computer Use、Chrome、Browser 与 Record & Replay 的实际宿主执行器和 browser-client 等资源包含专有组件，不能复制其二进制、Skill 文本、manifest、私有协议或品牌资源。

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

### 4.6 模型请求与本地数据边界

“本地 Agent”不等于模型永远看不到用户发送的内容。只要用户提交提示、截图、可访问文本或文件内容，所选模型 Provider 就必须收到相应输入：托管 DeepSeek 路线经 BilliardBuddy Gateway 转发，个人 Key 路线经本机适配器直达用户选择的 Provider。正确承诺是**不产生额外副本和旁路持久化**，而不是虚假承诺“数据绝不经过 Gateway/Provider”。

- 托管路线：Gateway 只做安装身份/额度、协议转发、路由和用量统计；请求内容可在传输中经过 Gateway，但不得写入业务日志、长期会话库、分析事件或对象存储；
- 个人 Key：原始 Key 只在系统安全存储与本机短生命周期代理内使用，不进入 Rust 持久配置、Renderer 或 BilliardBuddy Gateway；请求内容会发送给用户选择的 Provider；
- 三条模型路线在 Rust 中都注册为非 OpenAI、非 Azure 的 `billiardbuddy` 自定义 Responses Provider。锁定 Core 因此使用自己的本地压缩流程：压缩模型仍通过当前路线调用，生成的摘要由 Core 作为普通历史消息重新注入。用户不填写上下文窗口、最大输出或压缩阈值，Chat 适配器也不保存会话、不计算阈值、不生成摘要；它只把 Core 已形成的消息、函数调用、工具结果和流式事件转换成旧 Chat 可表达的格式；
- 旧 Chat 的标准图片和 WAV/MP3 音频输入会按 Chat 多模态格式转换。Computer Use、Browser 或 Chrome 返回的图片/音频工具结果会成为紧随工具结果的标准多模态消息，不能静默丢弃；厂商私有视觉/音频字段和 Responses 专属托管工具不伪造兼容；
- 本地工具、Worktree、截图仓库、浏览器 Profile、Computer Use 画面与原始文件不会因为启用 Agent 自动上传。只有本次 Turn 明确引用的内容或工具返回给模型的必要结果进入模型请求；
- Electron、MCP 和本地桥的诊断日志必须过滤模型请求体、授权头、Cookie、Key、完整附件和敏感工具输出。

---

## 5. 高价值高级能力的后端优先级

这一轮先完成 Agent 的本地扩展后端，不开始图片或视频工作台。优先级按“用户日常可感知价值、能够复用 Codex 原生 Agent、风险是否能清楚收口”排序：

1. **Windows Native Sandbox 与 WSL2**：Native 只桥接原生 readiness/setup；WSL2 运行 Linux Core/bwrap。两者是可选执行环境，不另造安全系统。
2. **原生设置、Thread 图与运行时恢复**：先把 Core 已有的配置、权限档、会话关系和生命周期接成后端事实，否则新前端只能猜状态。
3. **受管 Worktree、本地环境、Handoff、终端与 Git 操作**：它把并行开发、恢复和计划任务收口到可管理的 checkout 生命周期，且不增加第二个 Agent。
4. **本地插件装配与 Code Mode companion**：让 BilliardBuddy 能以原生 Codex 方式安装、启用、运行和撤销自带插件，并把同 revision 的 `codex-code-mode-host` 纳入构建、签名、哈希和清理；这是高级工具共同依赖，不是另一个 Agent。
5. **Chrome Control**：在用户明确连接的既有 Chrome 标签页中完成网页任务；它比泛化鼠标操作更结构化、可解释，也最适合真实的网页登录、表单和资料整理场景。
6. **Computer Use**：处理没有结构化接口的原生桌面 App；能力最广，但必须以最小权限和系统授权失败关闭。
7. **Record & Replay**：把用户明确录制的重复操作整理为可审阅的 Skill/工作流，不做坐标盲回放。
8. **BilliardBuddy Browser Use、Developer Mode、Appshots**：Browser 与 Chrome 登录态隔离；开发调试与用户主动视觉附件在独立权限下补齐。
9. **Memories、外部 Agent 配置迁移、计划任务、Remote Host、SSH 远程项目、Remote Runner、MCP Apps/市场**：均有价值，但分别依赖原生状态控制、安全导入、宿主调度、设备配对、远端运行时、云隔离或新 Renderer，不能抢在上述本机基础之前。

“先做后端”意味着每一模块先交付 Rust/MCP/原生适配器、Core 生命周期、审批/中断/撤销和打包；Renderer 只在对应后端存在后再投影状态。没有后端能力时不以按钮、演示界面或“开发中插件”冒充完成。

### 5.0 M0：Windows Native Sandbox 与 WSL2

Codex 在 Windows 有两种不同运行环境：原生 Windows Core 使用 Windows Sandbox，WSL2 中的 Linux Core 使用 bwrap/seccomp。当前 BilliardBuddy 只接了前者的协议：桌面宿主已转发 `windowsSandbox/readiness` 与 `windowsSandbox/setupStart`，并把 Rust 原本依赖的 Windows setup / command-runner 辅助程序按哈希纳入受管运行时；仍缺 Windows runner 的完整构建证明与真实设备上的 UAC 用户旅程验收。WSL2 完全未接。

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
- Windows 设置允许明确选择 `Native` 或 `WSL2`，切换后重启 App Server；不能在一个 Thread 中途把路径、Sandbox 和 Shell 从 Windows 偷换为 Linux；
- WSL2 只支持 WSL2，不兼容 WSL1；使用匹配锁定 revision 的 Linux `codex-app-server` 与 Core 原生 bwrap 策略，不能把 Windows `full-access` 当成 WSL 隔离；
- Windows 路径、`\\wsl$` 项目、Linux 路径、Git 根和 `CODEX_HOME` 必须做明确映射与真实路径校验；用户终端可以独立选择 PowerShell 或 WSL，但 Agent 的当前运行环境始终可见；
- WSL2 未安装、发行版不可用、bwrap 不可用或项目路径无法映射时失败关闭/提示切回 Native，不自动扩大权限。

### 5.0a M0a：原生设置、Thread 图与 Activity

这不是另建“设置后端”或“会话数据库”。锁定 Core 已经拥有配置层级、项目规则、Permission Profiles、Thread Store、Sections、父子 Thread 关系和运行状态；当前缺的是 Electron Main 对这些状态的类型化读取与受限修改。Renderer 不得直接读写 `agent-runtime` 中的 TOML、SQLite 或 rollout 文件。

原生设置链：

```text
Renderer 的明确设置动作
→ Electron Main 校验允许字段和作用域
→ App Server config / requirements / permission-profile 协议
→ Core 解析 CLI > 可信项目 .codex > profile > 用户 > system > default
→ Renderer 只显示有效值、来源、受管限制与 configWarning
```

要求：

- 接入 `config/read`、`configRequirements/read` 与 `permissionProfile/list`，显示有效 Sandbox、审批策略、Rules、项目配置是否生效和被管理策略禁止的选择；不得在 Electron 再保存一份“最终权限”；
- 当前官方将 Permission Profiles 标为 beta、Rules 标为 experimental；`runtimeWorkspaceRoots` 与 `parentThreadId`/`ancestorThreadId` 过滤也属于 experimental API。Main 必须按锁定 revision 的协议与 capability gate 调用，并在升级时重新审计，不能把实验字段固化成 BilliardBuddy 私有永久格式；
- 设置修改采用逐字段白名单和确定作用域，只允许产品明确支持的 Core 配置项；禁止把通用 `config/batchWrite`、任意 TOML 路径或 Key/Secret 字段交给 Renderer；
- 项目 `.codex` 配置、Hooks 和 Rules 只有在 Core 判定项目可信时才生效。用户选择可写项目或权限档时要明确显示这一副作用；信任状态仍由 Core 的项目配置保存，不能靠一个 Electron 布尔值冒充；
- 接入 Thread Sections、移动/排序、loaded 状态、unsubscribe、精确搜索和 metadata 更新；历史、归档、Section、父子关系与最终状态全部来自 Rust Thread Store；
- 扩展 `thread/list` 的 cwd、source、section、`parentThreadId`/`ancestorThreadId` 过滤，子 Agent 面板只显示并操作这些原生子 Thread；不得根据通知顺序自行推断父子图；
- 自定义 Agent 的角色、模型/指令配置继续由 Core 的 Agent 配置加载；界面只显示原生 `agentNickname`、`agentRole`、Thread 关系和配置警告，不建立 BilliardBuddy 角色注册表或并行调度器；
- Activity 的 `running / needs input / ready / failed` 从 `thread/status`、`turn/*`、待处理 server request 和原生错误事件聚合。Host 只可保存未读、过滤和系统通知偏好，不能把显示状态写回成第二份 Turn 状态；
- `model/list` 或 Provider capability 只作可确认信息的投影。模型路由、托管 DeepSeek 和个人 Key 仍遵循 BilliardBuddy 的模型接入合同，Core 压缩、上下文和工具循环不在此模块修改。

### 5.0b M0b：App Server 生命周期、恢复、诊断与升级

当前代码已有锁定二进制哈希校验、`initialize/initialized`、子进程退出失效、进程内模型凭据撤销和下一次操作重新启动/恢复 Thread 的基础。发布级完整性还要求把“进程恢复”与“重新执行用户任务”分开：Host 可以重新建立 App Server 和订阅，但不能猜测失败 Turn 已完成，也不能未经用户判断自动重放可能有副作用的工具。

- App Server 意外退出时，所有待处理请求、审批和本机模型 capability 立即失败/撤销；Activity 标记为可恢复或失败，不显示虚假完成；
- 重启后先从 Rust Thread Store 读取/恢复 Thread，并核对 cwd、模型路由与最后 Turn 状态，再决定是否允许用户继续；不从 Electron 缓存重建历史；
- 应用退出、插件禁用和 Thread 清理必须终止由本产品启动的子进程、后台终端、MCP 和本地桥；Core 的 `SessionEnd`/Thread 生命周期事件仍由 Core 触发；
- 本地诊断只记录 revision、协议方法、进程退出、错误码和脱敏路径；不记录提示词、Key、Authorization、Cookie、完整工具输出或附件内容；
- 上游更新只通过锁定源码 revision 完成：审阅上游差异，重新应用或删除最小产品补丁，重跑协议覆盖、生成物哈希、macOS/Windows 构建和真实 Thread/工具/审批/恢复/模型路由旅程。运行中的客户端不在线拉取未知 Core，也不修改 Agent Loop、压缩或工具语义。

### 5.0c W1：受管 Worktree、本地环境与 Handoff

Codex 内核能以给定 `cwd` 运行 Thread/Turn，却不负责桌面产品的 Git Worktree 创建、代码迁移、快照或清理。受管 Worktree、Local environment 与 Handoff 因而是**宿主层的项目生命周期能力**；它们不能被误做成第二套 Git 状态、第二个任务队列或第二个 Agent。

W1 对齐 Codex 桌面产品的用户语义，而不是把 `thread/resume` 错当成 Handoff：默认受管 Worktree 是每个聊天独占、以用户选定起点创建的 **detached HEAD** checkout；用户只有主动“创建永久 Worktree/分支”时才产生分支。Local 是用户原来的主 checkout，且必须始终由用户显式选择。

```text
用户以 Local 或默认受管 Worktree 启动 Thread
→ Host 用 Git 创建/登记 detached Worktree，并按项目的已审阅环境说明完成初始化
→ Rust Core 在这个 cwd 运行同一个原生 Thread/Turn
→ Handoff 先停止/取消当前 Turn、核对两个 checkout，再用 Git 安全移动代码与恢复点
→ 当前连接从 Thread 退订，确认 Core 可以冷恢复后，才以目标 cwd 恢复同一个 Thread
→ 失败时回滚 Git 迁移并保留原 Thread；绝不复制模型 Key、Agent 状态、插件权限或审批令牌
```

要求：

- 每个环境有明确的仓库、起始提交、Local/managed/permanent 类型、Worktree 路径、创建时间、关联 Thread、状态和清理动作；主 checkout 与其他 Worktree 不被隐式改写；
- 本地项目可包含一个 primary folder 与用户明确添加的 secondary folders。primary 决定新 Thread 的 cwd、Git/Worktree、自动发现的 `AGENTS.md`/Skills/`.codex`；secondary 只进入 Core 的 `runtimeWorkspaceRoots` 供文件搜索、读取和按当前 Permission Profile 编辑，不自动加载其中的项目指令或配置；
- 每个附加 root 都要做真实路径、符号链接、重复/包含关系和当前权限校验。不同仓库可以共同出现在项目 Diff 中，但 Commit/Push/PR/Worktree 默认只作用于 primary 仓库，跨仓库动作必须逐仓库明确选择；远程 SSH 项目首版只支持一个 folder；
- Host 必须在实施前读取并固定公开的 Codex Local environment 配置格式与 `.worktreeinclude` 语义；在格式和跨平台行为有可复现实证前，不得发明 `BilliardBuddy.environment.json` 或自动执行另一套私有脚本协议；
- 初始化与 `.worktreeinclude` 均须在创建前显示命令或文件清单、目标路径、大小和来源。只有用户明确确认后才执行/复制；BilliardBuddy 自身 `agent-runtime`、个人模型 Key、浏览器 Profile、插件配置、截图和应用私有数据永远排除。项目自己明确列入的忽略文件可复制，但不能静默把所有未跟踪文件带过去；
- Handoff 不是“只切 cwd”：必须迁移 Git HEAD、已提交历史、暂存/未暂存修改以及用户确认的包含文件，并在目标 checkout 中验证结果。目标存在冲突、未提交工作或 Core Thread 仍被订阅/运行时失败关闭；
- 快照必须是可验证、可恢复的本地 Git 产物（提交/Bundle/二进制 patch 与包含文件清单），而不只是状态摘要。快照只留在 BilliardBuddy 本机私有目录，不进入 Gateway、日志或遥测；恢复先还原 checkout，再冷恢复 Rust 原生 Thread；
- Scheduled Task 创建时必须明确选择 `managed Worktree` 或 `Local`。Git 项目默认前者；选择后者必须额外提示“会修改主目录”。非 Git 项目只能显式 Local，不能伪造隔离；
- 删除前必须确认。受管 Worktree 有未提交工作时，先创建可恢复快照再删除，或拒绝删除；永久 Worktree 不自动清理。默认保留最近 15 个可清理受管 Worktree，数量、保留与自动清理均须由用户设置控制。

### 5.0d W1b：集成终端、项目 Actions 与 Git 操作

Codex 桌面产品的集成终端、Local environment Actions 和 Git 面板是用户直接操作 checkout 的宿主能力，不是 Agent Shell 工具。BilliardBuddy 必须复用当前 Local/Worktree 选择和同一个真实 Git checkout，但不能把 Renderer 变成任意进程或文件系统客户端。

- 终端只能由用户明确打开，绑定一个已验证的 Local/Worktree cwd 和不可伪造的会话句柄；Main 控制 PTY、resize、stdin、输出上限、退出和应用关闭清理；
- 若复用 App Server 的 `process/*`、`command/*` 或 `thread/shellCommand`，必须明确它们是用户发起的**非 Agent Sandbox**执行，并在 Main 封装为最小类型化 API。尤其 `thread/shellCommand` 是全访问接口，不能因 Thread 处于 `workspace-write` 就误称受沙箱保护；
- 项目 Actions 只运行已审阅的 Local environment 动作，显示实际脚本、平台、cwd 和运行状态；Worktree setup 与 Actions 使用同一公开项目配置，不维护 BilliardBuddy 私有第二份脚本清单；
- Git Diff/Stage/Revert/Commit/Push/PR 面板每次从目标 checkout 读取真实状态。Stage/Commit/Push/PR 都是用户显式动作；Revert、丢弃或覆盖未提交工作必须二次确认并提供可恢复边界；
- Agent 产生的 Git 变更仍通过 Core 工具和审批执行；用户终端/Git 面板不会向 Agent 注入一个绕过审批的后台工具。

### 5.1 M1：本地高级插件装配

本模块的插件源码、构建与 staging 约定已经进入仓库，`electron:package` 也会在目标平台构建后把本地市场放入安装包的 `runtime-assets/agent-marketplace`；它仍需要跨平台、签名安装包与真实权限旅程验证，不能因“源码或包内文件存在”宣称用户已可用。它不建设共享 Broker、共享工具路由或常驻服务。每个插件保持独立，但具体可以是 Skill、MCP 或二者组合；只有实际需要系统执行端的能力才增加平台适配器。

锁定源码自己的 `scripts/codex_package` 把 `codex-app-server`、`codex-code-mode-host`、目标平台 `rg` 和按平台可用的受管资源定义为同一个规范运行包。当前工作树已经把 App Server、companion 与官方 `rg` 加入 `stage-codex-engine.ts`、schema 6 engine manifest、macOS/Windows GitHub 构建和 Electron 启动门：App Server 与 companion 必须来自同一 revision/补丁集，`rg` 必须由该 revision 的官方 DotSlash 清单下载并校验，manifest 分别记录文件名、大小和哈希，启动前逐个读取真实文件。Electron 仅把通过清单校验的运行目录前置到 App Server 的 `PATH`，让 Core 的搜索路径获得官方 `rg`，不接管搜索语义。macOS arm64 schema 6 runtime 已在本机重新 staging，并真实完成 App Server 初始化与 `thread/search` smoke；这仍不等于 Code Mode 真实 Core Turn 已经运行验收，Windows 产物也仍需原生 runner 构建。

锁定 revision 还提供 patched zsh 打包资源，但对应 `shell_zsh_fork` 与 `unified_exec_zsh_fork` 均是默认关闭的 under-development feature；本机当前 ChatGPT/Codex App 实物也没有把该 zsh 作为可见独立资源交付。BilliardBuddy 不强开实验 feature，也不把该 zsh 计入本轮缺失。未来升级 revision 或明确启用该 feature 时，必须同时采用当版官方资源清单并补齐两端验证。

锁定 revision 中 `code_mode_host` 已是 stable 且默认启用，但 `code_mode`/`code_mode_only` 仍是 under development 且默认关闭。打包 companion 是补齐 Core 的规范运行资源，不代表 BilliardBuddy 可以强行打开实验模式；是否向某个模型提供 Code Mode 继续由该 revision 的 Core 配置、模型能力和上游 feature gate 决定。

交付：

- `native/<plugin>/` 的 Rust 工程、固定目标平台构建和 GitHub 原生 runner 编译；
- 每个插件自己的 manifest，以及按需存在的 Skill、`.mcp.json`、stdio MCP 和平台适配器；
- 同 revision 的 `codex-code-mode-host` macOS/Windows 构建、staging、签名、manifest 校验和进程清理；
- 锁定源码官方清单中的目标平台 `rg[.exe]` 下载、SHA-256 校验、staging 与受管 PATH 注入；
- 未来 `runtime-assets/plugins/` 的 staging、签名/解包和跨平台二进制约定；
- 已有 Electron 对原生插件状态与审批事件的纯转发边界；
- 子进程退出、禁用、应用退出与异常中断时的清理规则。

M1 单独不证明：插件已被用户添加、安装、启用、获得系统权限或完成真实鼠标键盘/浏览器旅程。包内本地市场只是可安装来源；只有用户明确操作并经 Rust 原生插件生命周期后，插件才进入运行态。M1 不交付远程连接、云端执行或一个抽象的“万能权限 API”。

锁定 App Server README 仍把 `plugin/install`、`plugin/uninstall` 标为 **under development / production client 暂勿调用**。因此当前桥只能作为锁定版本集成与测试路径；正式发行前必须重新确认上游成熟度，或把包内市场保持为不可安装状态。不得通过在 Electron 另写安装器来绕过这个原生边界。

Computer Use 已作为首个工程验证了 stdio MCP 进程与跨平台 staging；当前产物只属于待验证的包内本地市场，尚不等同“已安装/启用给用户”。只有 M3 的真实、受控桌面工具、签名安装包和系统授权验收均通过，且用户经 Rust 原生插件生命周期明确安装/启用后，才可宣称该插件可用。Code Mode Host 是否可用必须用真实 Core Turn 另行验证，不能由 Computer Use MCP smoke test 代替。

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

ts/desktop/runtime-assets/binaries/
  ├── billiardbuddy-agent-engine-<target>
  ├── codex-code-mode-host[.exe]        # Core 固定查找名，不为品牌改 Core
  └── agent-engine-manifest-<target>.json
```

`codex-code-mode-host[.exe]` 是锁定 Core 的内部兼容文件名：`install-context` 会按此名称在 App Server 相邻目录或规范 package resources 中查找。除非未来上游提供正式的可配置路径，否则不得仅为隐藏 Codex 名称修改 Core 或重命名该文件；它位于应用内部资源目录，不是用户看到的产品名。

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

实现 M1 已装配的 Computer Use 插件的原生适配层与工具行为。工具统一使用平台原生 `appId`：macOS 使用 Bundle ID；Windows 使用 Core/Computer Use 报告的 App ID，例如桌面程序可执行文件名或打包应用 AUMID。当前规范化 `.exe` 绝对路径只可作为 Host 验证实际进程身份的内部证据，不能成为面向 Core 的持久配置格式；不把 macOS 的 Bundle ID 概念硬套到 Windows。

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

- 当前源码从 BilliardBuddy 私有 Agent runtime 的 `computer-use/config.json` 读取 `allowedBundleIds`；最终只能保留一份 App 决策权威，并通过 Core 可管理配置/插件状态暴露给宿主。若 macOS 仍需原生服务专用状态，只能保存 Core 无法表达的签名 App 身份与系统授权结果，不能复制一份相互冲突的“始终允许”列表；
- 截图只经 MCP 作为当前 Turn 的图像结果返回，不写入项目或磁盘；
- 原生执行器随 Rust MCP 子进程按需启动，不监听端口、不常驻、不拥有模型 Key；
- 当前仍是后端源码阶段：构建成功时可作为**未安装、未启用**的包内本地市场资源随安装包分发；在 macOS/Windows 都具备正式安装、启用、设置与系统授权验收前，不得自动注册给 Core 或宣称用户可用。

#### M3b：Windows 原生执行器（当前源码实现）

`native/billiardbuddy-computer-use/windows/BilliardBuddyComputerUseService.cpp` 使用活动桌面、UI Automation、Win32 输入与 GDI/WIC 内存截图实现与 M3a 相同的工具语义。

- 当前源码从 BilliardBuddy 私有 `computer-use/config.json` 的 `allowedExecutablePaths` 读取允许列表。锁定 revision 中没有 `[computer_use.windows].always_allowed_app_ids` 或等价 Computer Use App allowlist API，因此该文件是本插件在当前版本唯一的目标 App 范围，不是与 Core 冲突的第二份 Agent 审批。Core 仍独立负责插件启用和工具审批；以后升级到确有原生 allowlist 的 revision 时再迁移并删除旧字段；
- 仅当前活动 Windows Desktop 中的可见、允许 App 窗口可观察或操作；锁屏、安全桌面、窗口失焦和 UIPI 拒绝都失败关闭；
- `SendInput` 只能发送给同等或更低完整性级别的进程；不绕过 UAC、不控制其他用户会话或后台桌面；
- 截图由 GDI/WIC 在内存编码为当前 Turn 的 PNG MCP 结果，不写入文件。

Windows 编译目标是 `x86_64-pc-windows-msvc`。Win32 是 Windows API 的历史名称，适用于 64 位 Windows 桌面程序，不是 32 位专用实现。

### 5.4 M4：Record & Replay

Record & Replay 是 Computer Use 的后续能力：用户明确开始一次有限时长的录制，插件记录经脱敏的操作语义与界面状态，Agent 将其整理为一个可审阅、可编辑的 BilliardBuddy Skill/工作流。它不是自动重放坐标的宏工具。

本机 Codex/ChatGPT 当前公开形态的 Record & Replay 是 **macOS 首版**，并依赖已启用的 Computer Use；Windows 没有可直接迁移的官方实现。因此 BilliardBuddy 的 macOS 版本按同样的“明确开始 → 有限录制 → 停止 → Rust Core 生成并审阅 Skill → 以后按当前授权重放”形态接入。Windows 若提供相同用户结果，必须明确标为 BilliardBuddy 自研等价录制器，不能把它误说成 Codex Windows 原生模块。

当前源码实现为独立 `billiardbuddy-record-replay` MCP：macOS 使用 listen-only Quartz event tap，Windows 使用 `WH_KEYBOARD_LL` / `WH_MOUSE_LL` 与消息循环。两端开始前显示系统级确认，录制最长 30 分钟；目前只写入点击、滚动、前台应用名称和“发生过文本输入”的脱敏事件，不记录窗口标题，绝不写入键值、输入文字、剪贴板、Cookie、密码、截图或视频。

这只能证明录制生命周期与最小脱敏骨架，尚不足以达到 Codex Record & Replay 的用户结果。本机插件实际以 `events.jsonl` 的 App/window attribution、Accessibility 全量/差量树、selection、focused element、mouse/keyboard target 等语义证据生成 Skill。BilliardBuddy 完成版必须在明确录制范围内补充经过脱敏、大小限制和字段白名单的可访问性结构/差量、控件角色、稳定标识、动作目标与成功状态；密码、OTP、API Key、支付、身份、医疗/法律/HR 等敏感值始终替换为占位符。若没有足够语义证据，应要求用户补充或判定无法生成可靠 Skill，不能输出坐标宏冒充成功。

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

当前源码实现为 `billiardbuddy-browser-use`：Electron Main 以 `persist:billiardbuddy-browser` 创建与用户 Chrome 隔离的 BrowserWindow，持有一个仅监听 `127.0.0.1`、随机 token 的短生命周期桥；Rust MCP 只能打开 HTTP(S) 页面、列出本模块窗口、读取有界元素快照、截图、导航、点击、输入及限定按键。新站点须经宿主确认；点击、输入等写工具不标记为只读，由 Rust Core 的原生 MCP 审批决定是否询问用户，Electron 不再重复实现逐次点击审批。密码/验证码/支付字段、上传、下载、Cookie、历史、存储及完整 CDP 都不暴露。

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
- Electron 已按 Core 原生类型接入 `text`、`image`、`localImage`、`audio`、`localAudio`、`Skill` 与 `Mention`；本地图片和音频当前只允许当前 Thread 的真实工作区文件，Skill 只允许工作区、BilliardBuddy 私有 Agent runtime 或随包本地市场中的真实 `SKILL.md`。工作区外附件必须在本模块由 Main 文件选择器/采集器取得一次性明确授权后再加入允许根；不能让 Renderer 任意读路径，也不能发明 Core 不认识的通用 `file` 输入；
- 输入图片、音频和选择的项目文件以当前 Thread/Turn 的附件生命周期处理，并校验真实路径、符号链接、类型、大小和所选工作区边界；所选模型不具备相应输入能力时必须明确失败，不能假装已理解；
- 密码管理器、身份验证、支付和系统安全窗口必须警告并允许用户在发送前取消；不做后台屏幕历史、连续采集、隐式 OCR 或独立截图仓库；
- 截图/可访问文本不会进入 Worktree、遥测或独立附件库；一旦用户发送，它会按 4.6 所述进入所选模型请求。其本地保存、删除和导出遵循该 Thread 的原生会话数据策略。

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
- 锁定源码把部分 Guardian/auto-review 通知和拒绝覆盖接口标为 unstable/experimental；前端与 Main 必须按 revision capability gate 消费，协议变化时失败关闭，不能把临时结构固化成自建审批数据库；
- 用户清理 Memory、关闭 Auto-review 或切换 Thread 后，Electron 只更新原生状态，不保留第二份记忆、拒绝记录或可恢复的批准令牌。

### 5.6b M6c：MCP Apps 与 BilliardBuddy 自有市场

本地/工作区插件已是 Codex Core 的原生能力；下一层高价值能力是让具备 MCP Apps UI 资源的插件能够在未来 Renderer 内安全展示，以及建设 BilliardBuddy 自己的发现、签名和撤销服务。两者都不能依赖 ChatGPT 账号或 OpenAI 远程市场。

- MCP Apps：采用开放的 MCP Apps resource/UI 形态。Renderer 只承载受隔离的资源视图；资源与工具调用均经过 Main 的类型化桥和 Rust 的原生 MCP 生命周期，不把 Node/Electron 权限暴露给 iframe；
- 自有市场：服务器仅提供 BilliardBuddy 插件清单、签名、版本、兼容性、撤销和升级信息；客户端在安装前验证签名、显示来源与所需权限，并由用户确认；
- 本地目录、工作区目录和市场安装来源必须可区分、可禁用、可卸载和可撤销；市场失联不得阻断已安装插件，更不能导致未签名插件被自动安装；
- 前端重写前不制作伪市场界面，但现在可以固定后端包格式、签名校验和资源桥合同。

### 5.7 M7：Scheduled Tasks 与长期任务

Codex 产品提供计划任务，但当前锁定 App Server 只可确认插件目录中的计划任务元数据，未找到可直接嵌入的计划任务执行协议。因此 BilliardBuddy 的 `ScheduledAgentTaskService` 是自己的 **Host Scheduler**：当前它只持久化触发规则、启停、上次运行时间和最后错误；到期后的智能体工作仍通过 Rust 原生 Thread/Turn 执行。这样不会复活旧自建 Agent Loop，也不会把产品调度误说成 Rust 内核已有能力。

```text
BilliardBuddy Host Scheduler
→ 到期时用保存的工作区恢复指定 Rust Thread 并创建新 Turn
→ 仍按原 Thread 的模型路由、Sandbox、桌面能力授权执行
→ 通知、事件、取消和撤销
```

当前后端只支持“回到一个已有 Thread”的一次、固定间隔（至少一分钟）、每天和每周规则，只持久化任务本体、上次运行时间与最后错误；它还不是 Codex 产品语义完整的 Scheduled。它依赖 BilliardBuddy 应用运行且主窗口仍存在，尚无独立运行 Thread、RRULE、自定义时区、多项目目标、持久运行历史、手动试跑、重叠策略、模型/推理强度选择或无窗口后台恢复。

完成形态必须同时支持：在现有 Thread 中继续（继承上下文），以及每次创建独立原生 Thread 的 standalone 任务（每次运行相互独立）。创建或重新启用任务必须经 Electron 原生确认；W1 完成后，Git 项目默认以该任务专属的受管 Worktree 运行，用户也可明确选择 Local 并接受主目录写入风险。若 Rust Core 在任务执行中请求工具/桌面/审批，仍走既有原生审批事件；应用关闭、项目不可用或 Thread 无法恢复时，本次记录失败而不绕开任何权限。

要求：

- 计划任务不能隐式升级为 `full-access` 或获得新的 Computer Use 授权；
- 需要桌面控制、浏览器副作用或外部写入时，未存在的授权必须等用户回来确认；
- 任务必须区分 `existing-thread` 与 `standalone`；standalone 每次建立新的 Rust Thread/Turn，existing-thread 才能继承原 Thread 上下文，Host 不能复制或拼接上下文；
- 自定义计划采用经过校验的 RFC 5545 RRULE、明确时区和下一次触发预览；保留简单的一次/间隔/每天/每周编辑器，但不能让两套计划成为不同状态权威；
- 每次运行有独立持久记录：计划触发时间、实际开始/结束、目标项目/环境、Thread/Turn id、最终状态、结果摘要或脱敏错误。支持手动试跑、暂停、取消、重试与分页查看，不能只覆盖 `lastRunAt/lastError`；
- 同一任务上一次仍运行时必须按明确策略跳过或排队，默认不并发；应用重启后按策略处理错过的触发，不能一次性补跑所有历史时间点；
- 多项目任务为每个项目建立独立目标与运行记录；模型和推理强度可选择“使用默认”或显式值，但实际 Agent 工作仍只由 Rust Core 执行；
- 每次运行记录目标为 Local 还是受管 Worktree；不能把“默认隔离”伪装成绝不允许用户选择 Local；
- 媒体 Project 的渲染/恢复调度与 Agent Scheduled Task 保持不同状态权威。

### 5.8 M8：Remote Host

本模块明确暂缓，不属于当前 Agent 后端施工范围。旧提交曾加入 Gateway 配对/命令队列、Electron Host 轮询和对应 IPC，但这与“远程控制先不做”的用户边界冲突，已从当前运行代码、部署清单和构建路径清除。

未来若另立合同实现“移动端/另一台设备继续操控本机 Agent”，采用 Host Pairing，而不是复用 OpenAI ChatGPT Remote。

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

当前完成标准只有一条：仓库运行路径中不存在 Remote Host、配对 Relay 或远程命令队列；路线图文字不会触发任何服务、端口、轮询、数据库表或用户权限。未来重新启动该模块时再按上述边界设计和验收。

### 5.8a M8b：SSH 远程项目

SSH 远程项目与 Remote Host 不同：Remote Host 是另一设备操控这台桌面宿主；SSH 模式是本机桌面通过 OpenSSH 在远端机器启动 App Server，让文件、Shell、Git、MCP 和 Sandbox 都在远端项目环境执行。它也不是 Cloud Runner，因为远端主机、账号、资源和长期状态由用户自己管理。

```text
BilliardBuddy Desktop
→ system OpenSSH / concrete host alias
→ matching BilliardBuddy codex-app-server on remote host over stdio
→ remote Thread / workspace / tools / sandbox
```

- 只读取用户 `~/.ssh/config` 中可解析的具体 Host alias，并调用系统 OpenSSH；SSH Key/agent、known_hosts 和主机校验仍由 OpenSSH 管理，BilliardBuddy 不复制私钥或自己实现 SSH；
- 远端运行匹配锁定 revision/协议的 BilliardBuddy App Server，可由用户预装或经明确确认部署到远端私有缓存；不得悄悄使用远端另一个版本的 `codex` 命令，也不得把 App Server 暴露到公网 TCP/WebSocket；
- 项目文件、Shell、Git、MCP、Skills 和 Sandbox 都以远端为权威；本机 Renderer 只经类型化桥显示事件和审批，不把远端目录伪装成本地目录；
- 托管模型只向远端进程提供短期、可撤销的 BilliardBuddy 模型 capability。个人 Key 必须由用户明确选择“保存在远端安全存储”或以后经过专门审计的加密转发；首版不得自动复制本机 Key、`agent-runtime`、浏览器 Profile 或插件凭据；
- 本地与 SSH Handoff 必须匹配同一 Git 仓库/项目子目录，先中断 Turn，再迁移并验证 Git 状态，最后在目标 Host 冷恢复 Thread；模型会话历史和审批令牌不靠文件复制伪造；
- 主机指纹改变、连接中断、远端 revision 不匹配、远端 Sandbox 不可用或路径无法验证时失败关闭，并保留可恢复的 Git/Thread 状态。

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

未来前端不需要把所有技术开关一次性暴露给用户。以下是五个产品领域入口，不要求机械地做成五个独立页面：

```text
Agent 与模型
  模型路线 / 原生 Permission Profile / 有效 Sandbox 与受管限制
  Windows Agent 环境：Native / WSL2（仅 Windows）
  Memory：全局开关、当前 Thread 模式、清空
  Auto-review：显示原生拒绝原因，只能确认单次精确重试

会话与活动
  Thread Sections / 搜索 / 归档 / 子 Agent 图
  Running / Needs input / Ready / Failed / Scheduled
  完成、审批和追问的系统通知策略

桌面控制
  Computer Use、Chrome、Record & Replay、Browser Use、Developer Mode、Appshots、后台任务
  每项显示：已关闭 / 缺少系统授权 / 本次允许 / 已允许的 App

扩展与连接
  MCP、Skills、Hooks、本地插件、MCP Apps、外部 Agent 导入；Remote Host 与 SSH Hosts 只在未来另立合同后出现

项目环境
  Primary / Secondary folders、Local / 受管 Worktree、初始化说明、Handoff、快照与清理
  集成终端 / 项目 Actions / Git 操作 / Scheduled 目标与运行历史
```

用户默认只看到任务目标和当前风险。复杂范围（App ID、Profile、域名、目录、CDP、Worktree）在选择“管理权限”后展开；不能让用户填写上下文压缩、模型窗口或 Codex 内核参数。

---

## 7. 当前代码事实与清理要求

当前已存在：

- Electron 只从受管清单解析打包的 Codex App Server；当前工作树会在启动前分别校验 App Server、同版本 `codex-code-mode-host` 与锁定源码官方 `rg` 的文件身份、大小和哈希；
- Rust 私有 Agent runtime（通过 `CODEX_HOME` 环境变量传入）；
- 三档原生 Agent 权限，`full-access` 在 Electron Main 中确认；
- Thread、Turn、恢复、压缩、Fork、后台终端；
- MCP、Skills、Hooks、本地/工作区插件和协作/Review 协议桥；
- 个人模型凭据安全代理，模型 Key 不交给 Renderer 或 Gateway。
- 锁定二进制校验、App Server 初始化、进程失效通知、模型 capability 撤销和 Thread 再恢复基础；
- Chrome Native Messaging 的固定扩展身份、安装状态、明确确认的安装/卸载和受限 Preload IPC；
- 计划任务的简化 Host Scheduler；它恢复原生 Thread/Turn，不包含第二个 Agent Loop；
- Remote Host、设备配对和远程 Gateway 队列不在当前运行代码中。

当前明确缺失：

- `codex-code-mode-host[.exe]` 的源码构建、staging、schema 6 manifest、启动校验和 CI 脚本已补齐；官方 `rg[.exe]` 已纳入同一 manifest 与运行 PATH；macOS arm64 staged runtime 已重建并完成 App Server 初始化/`thread/search` smoke，仍需验证 Windows x64 产物、签名安装包和 Code Mode 真实 Core Turn；
- Windows Sandbox 已有原生 readiness/setup 桥、用户发起的安装路径与辅助程序封装校验；仍缺 Windows runner 构建证明及 Windows 实机 UAC 验收；
- Windows WSL2 Agent 环境、Linux App Server staging、路径映射、bwrap readiness 和 Native/WSL 切换；
- 受管 requirements 与 Permission Profiles 已接；仍缺经 Main 去秘密的有效配置、项目规则/信任的用户可见状态与逐字段安全写入；
- Thread Sections/移动与精确匹配已接；仍缺 loaded/unsubscribe、完整 cwd/source/父子过滤、子 Agent Thread 图，以及从原生状态派生的 Activity/通知策略；
- 多文件夹项目、primary/secondary 权限边界及 Core `runtimeWorkspaceRoots` 传递；
- 受管 Worktree、本地环境、Handoff、快照/恢复/清理，以及计划任务对隔离工作树的选择；
- 用户集成终端、项目 Actions 和 Git Diff/Stage/Revert/Commit/Push/PR 宿主链；
- Computer Use、Chrome Control、Browser Use 与 Record & Replay 的 MCP、宿主源码、Windows/macOS 构建 staging 和安装包校验已进入正式源码链；尚缺最终两端构建、签名安装包和真实用户旅程验证。当前 Windows Computer Use 的插件专用 JSON 是锁定 revision 可用的唯一 App 范围配置；Record & Replay 仍缺可生成可靠 Skill 的脱敏 Accessibility 语义事件，不能宣称已发布；
- Computer Use 面向用户的启用/允许 App 设置入口，以及 Chrome 扩展的正式发布/安装入口；Chrome 注册后端已经接通，但没有新 Renderer 入口和真实扩展安装验收；
- Browser Developer Mode、Appshots 的桌面采集/工作区外附件授权、Memory 的用户可见状态、Guardian Auto-review 拒绝管理，以及 MCP Apps 资源桥和 BilliardBuddy 自有签名市场；`image`/`localImage`、`audio`/`localAudio`、`Skill` 与 `Mention` 原生输入协议已接入，不再计为缺口；
- Remote Host、SSH 与 Remote Runner 均为暂缓项目，不属于本轮完成条件；在另立合同前不恢复对应 Electron/Gateway 运行代码；
- SSH Host 发现、远端匹配运行时、远端凭据边界、项目选择与跨 Host Handoff；
- 外部 Agent 迁移的新前端入口（后端受限桥接已存在）；
- 计划任务的 standalone/existing-thread 模式、RRULE/时区、多项目、持久运行历史、重叠/错过策略、无窗口后台执行与新前端入口（当前仅有简化 Host Scheduler 和已有 Thread/Turn 唤醒）；
- 新 Renderer 的设置、审批、事件与能力管理界面。

当前 `full-access` 仅扩大 Rust 代码工具的文件和网络权限。它不能被改名或解释为“已拥有 Computer Use”。

旧自建 Agent 不得因为增加这些能力而复活；所有 Agent 请求继续由 Codex Rust 发起，高权限执行由对应的 Codex 本地插件完成。

### 7.1 一次性跨平台构建门禁

本轮不采用“改一个文件就推送一次、跑一次 GitHub”的方式。GitHub macOS/Windows runner 是最终跨平台证据，不是用来替代本地静态审计的试错终端。满足以下条件前，不 push Agent 变更、不手动 dispatch、不启动安装包构建：

1. 锁定 Codex Client Request 已全量分类，新增协议会让验证失败；
2. 第 1.2 节列出的本次构建范围均完成代码审查，删除与用户边界冲突的旧实现；后续路线图不以空壳假装完成；
3. TypeScript/Gateway/Electron 类型检查、源码可达性、源码锁定、补丁校验、协议校验全部通过；
4. 本机能够验证的 Rust 插件、Swift 服务、staging、MCP smoke、Browser E2E、App Server/Code Mode Host/官方 `rg` 清单和运行 smoke 全部通过；依赖 Windows 原生二进制的部分留给本轮 GitHub 矩阵，依赖媒体工具链和签名凭据的完整安装包审计留给后续发行工作流；
5. 工作树只包含本轮正式源码和文档，没有临时文件、旧二进制或他人并行模块的内容；
6. 临时测试进程、浏览器、MCP、Cargo 和打包进程均已停止并再次检查；
7. 文档中的状态与真实代码一致，未验证项明确写为未验证。

门禁通过后只推送一次，并只让 `Codex 源内核-构建验证` 进行一轮 macOS arm64 / Windows x64 矩阵构建。该轮的目标是证明第 1.2 节 Agent 源码可以在两个平台形成结构正确、可校验的 App Server/companion/Sandbox/本地插件运行包，不等同于完整 Electron 安装包，也不等同于四个高级插件已完成真实系统授权和用户旅程。若 GitHub 暴露平台专属问题，修复后可以只重跑失败平台，但不能在本地未收口时用反复 CI 猜问题。完整签名安装包由桌面发行工作流在媒体模块和发行凭据齐备后单独验收；Remote Host、SSH、Cloud Runner、新前端及第 1.2 节明确列出的后续模块不阻塞这一本机 Agent 后端构建门禁。

### 7.2 2026-08-03 总审计收口记录

| 审计对象 | 最终判定与修正 |
| --- | --- |
| Agent 所有权 | 当前产品运行路径只有锁定 Rust App Server/Core 拥有 Thread、Turn、Agent Loop、上下文、压缩、工具、审批和恢复；旧 TypeScript Agent、Gateway Agent Worker、旧浏览器宿主和 Remote Host 运行链已删除。 |
| 原生协议接入 | 锁定 Client Request 已逐项分类：59 个经类型化 Main 桥接，77 个因云账号、危险原始旁路、源码内部接口或明确后续模块而登记为不暴露；6 类 Server Request 是 Core 向宿主索取审批/交互结果的回调类型，不代表 Core 只有 6 个工具。 |
| 模型与压缩 | Responses 两条路线只做凭据代理；旧 Chat 只做无状态协议转换。Core 的本地压缩摘要仍作为普通消息经过 Chat 转换；工具图片/音频结果不再被旧 Chat 路线丢弃。没有模型窗口、最大输出或压缩阈值的产品必填表。 |
| Rust Core 补丁 | 三份补丁只清除 Hook、通知、插件管理、Shell snapshot 和 Exec companion 子进程继承的模型 capability 环境变量；不改 Agent Loop、Thread/Turn、压缩、工具选择、Sandbox、MCP 或 Skills 语义。 |
| 插件与审批 | 真正只读的 MCP 工具才声明 `readOnlyHint`；写工具保持未标只读，由 Core 原生 MCP 审批。Browser 的网站访问授权和 Computer Use 的 App/系统权限仍由宿主硬边界负责，但 Electron 不再为每次点击再建第二套 Agent 审批状态。 |
| 产品与开发文字 | 随包 Skills、插件描述、弹窗和错误提示只写 BilliardBuddy 用户行为，不再写 Core 所有权、Rust、当前开发状态或以后补齐；这些技术事实只保留在合同、源码注释、验证脚本和内部错误码中。 |
| Record & Replay | 自动到期后的轨迹可以继续取回；停止超时时保留 stop marker，不让延迟的录制器继续运行；MCP 主进程会主动回收已退出的原生录制子进程；Windows 只记录前台应用程序名，不记录可能含敏感内容的窗口标题。该模块仍是脱敏录制骨架，不冒充可靠语义回放。 |
| 桌面操作边界 | macOS Computer Use 除校验前台 App 外，还要求目标窗口就是该 App 当前最前窗口；Windows 保持目标 HWND、PID 和当前前台窗口三者一致。Chrome 元素 ID 绑定当前文档随机代次，导航后旧 ID 不得作用到新页面；页面检查不返回任何表单当前值。 |
| macOS/Windows 出包 | macOS 正式出包和本地脚本已补齐四个插件的 staging；两端在打包前执行同一 Agent/模型/协议预检，afterPack 再验证实际包内引擎和插件。`codex-code-mode-host` 直接复用锁定源码自带的 `scripts/codex_package/v8.py`：它选择同版本、开启 V8 Sandbox 的 Codex release 静态库与 binding，并按官方同组校验清单验证 SHA-256；BilliardBuddy 不自建第二套 V8 下载协议，不误请求 `rusty_v8` 上游未发布的 `ptrcomp_sandbox` 文件，也不复制 ChatGPT.app 的二进制。已删除与每台安装自行建立会话的设计冲突、且会被 `beforePack` 拒绝的 `product-secrets.json` 生成步骤；普通构建不读服务器凭据，上传私钥只在明确发布步骤临时使用。Windows 冷编译总时限调整为 180 分钟，macOS 为 150 分钟，避免已知的 90 分钟链接超时。 |
| 本机 Codex/ChatGPT App 证据 | 只读实物确认了 Core/companion、Skills、插件、Computer Use 与浏览器宿主的职责分层；BilliardBuddy 复用公开架构边界和用户结果，不复制专有二进制、私有 browser-client 协议或品牌内容。 |
| 本机最终门禁 | 四个插件完成 macOS arm64 release staging、Swift/Rust 编译、产品内容检查和 MCP 握手；Browser 完成 Electron Host ↔ Rust MCP 端到端验证；受管 App Server、Code Mode Host 与官方 `rg` 从锁定源码重新生成 schema 6 清单，并通过真实 `initialize` 与 `thread/search` smoke。全仓 44 个测试、Server/Electron/Renderer 检查、106 个生产源码可达性和协议总账通过。Windows 只保留 GitHub 原生 runner 才能给出的 MSVC/Win32 与安装包证据，尚未把它写成已通过。 |
| 构建入口复核 | 审计发现 Windows 正式构建脚本曾漏掉四个本地 Agent 插件的 staging，且最近一次 GitHub Windows 失败来自 `cmd.exe /s` 破坏带空格的 Visual Studio `vcvars64.bat` 引号；两项均已修正，并把 macOS/Windows 两个正式入口的四项 staging 纳入源码协议门禁。GitHub 构建仍未在本地门禁完成前启动。 |

---

## 8. 实施顺序与模块退出条件

| 顺序 | 模块 | 退出条件 |
| ---: | --- | --- |
| 0 | M0 Windows Native / WSL2 | Native 只桥接 Core 原生 readiness/setup；WSL2 使用匹配 Linux Core/bwrap；切换、路径、UAC、不支持和未准备状态均可验证 |
| 0a | M0a 原生设置 / Thread 图 / Activity | 有效配置、受管限制、Profiles、Sections、父子图、loaded/unsubscribe 与原生状态投影完整；无第二份权限、会话或 Turn 状态 |
| 0b | M0b 生命周期 / 恢复 / 升级 | 进程退出失败关闭、冷恢复不重放副作用、诊断脱敏；上游 revision、最小补丁、协议和两端构建可重复审计 |
| 0c | W1 Projects / Worktrees / local environments / Handoff | primary/secondary roots、detached 受管 Worktree、显式 Local、已审阅初始化/包含文件、实际 Git 迁移式 Handoff、可恢复快照与清理完整；没有第二个 Agent 或 Git 状态 |
| 0d | W1b 集成终端 / Actions / Git 操作 | 仅用户显式动作、绑定真实 checkout、类型化会话与进程清理完整；不成为 Agent 绕过 Sandbox 的工具 |
| 1 | M1 本地高级插件装配 / Code Mode companion | 插件按需采用 Skill/MCP/平台适配器；`codex-code-mode-host[.exe]` 与 App Server 同 revision 构建、签名、哈希和清理完整；包内市场可分发，但半成品不自动安装、启用或向 Rust Core 注册 |
| 2 | M2 Chrome Control | 仅用户选择的标签页/Profile 可连接；结构化网页操作可用；副作用、上传下载与完整 CDP 明确确认 |
| 3 | M3a Computer Use（macOS） | macOS 限定能力可用；未授权/未允许 App 失败关闭；中断和撤销可停止 |
| 3b | M3b Computer Use（Windows） | Windows 活动桌面限定能力可用；不支持场景失败关闭；中断和撤销可停止 |
| 4 | M4 Record & Replay | 录制必须明确开始/停止并脱敏；产物需审阅；重放不继承无限权限 |
| 5 | M5 Browser Use | 受控浏览器与已有 Chrome 会话隔离；副作用、CDP、上传下载均有边界 |
| 5b | M5b Browser Developer Mode | 每网站、每次连接可见授权；调试输出去秘密；关闭/撤销立即失效 |
| 5c | M5c Appshots / 主动附件 | 用户主动采集并作为 `image/localImage/Mention/Skill` 原生 Turn 输入；无后台历史或独立视觉记忆 |
| 6 | M6 Migration / extensions | 迁移与插件安装逐项确认；不迁移秘密；Rust 是唯一扩展注册表 |
| 6b | M6b Memories / Guardian | 只桥接 Rust Memory 与拒绝管理；清理、关闭和单次精确重试可验证 |
| 6c | M6c MCP Apps / 自有市场 | 类型化资源桥、签名、兼容性、升级、撤销和离线安装边界完整 |
| 7 | M7 Scheduled Tasks | standalone/existing-thread、RRULE/时区、多项目、运行历史、隔离工作树、重叠/错过策略、通知、暂停/取消和权限不升级完整 |
| 暂缓 | M8 Remote Host | 当前没有运行代码；未来另立合同后才定义设备配对、撤销、Host 执行与权限继承 |
| 8b | M8b SSH 远程项目 | OpenSSH 主机校验、匹配远端 App Server、远端项目/Sandbox、凭据边界和跨 Host Handoff 完整 |
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
- Native/WSL2 切换会重启 App Server，既有 Thread 不在运行中偷换执行环境；WSL2 只运行匹配 revision 的 Linux Core；
- `\\wsl$`、Windows 和 Linux 项目路径被正确映射/拒绝；WSL2、发行版或 bwrap 不可用时不会退化为未声明的全访问。

### M0a–M0b

- 有效配置、受管限制、Permission Profiles、项目 Rules/信任、configWarning 全部来自 Core；Renderer 不能读取任意 TOML，也不能写任意 config key；
- Thread Sections、父子/祖先关系、loaded 状态、状态变化和精确搜索来自 App Server；刷新或重启 Renderer 不改变真实 Thread 状态；
- 子 Agent 事件与 Thread 图在应用重启后仍可从 Rust 恢复；Activity 的运行、待输入和完成状态可用原生事件与读取结果互相校验；
- App Server 异常退出会使待处理请求和模型 capability 失败关闭；冷恢复不自动重放可能产生副作用的 Turn；
- 安装包含与主 App Server 同 revision/target 的 `codex-code-mode-host[.exe]`，Core 能实际启动、取消并清理它；缺失、哈希不匹配或崩溃时准确降级/失败，不以 Computer Use 或 Browser MCP smoke test 冒充 Code Mode 验证；
- 上游升级能明确列出 revision、产品补丁、协议增删和构建哈希，并通过 macOS/Windows 的 Thread、工具、审批、恢复和两条模型路线验证。

### W1

- 受管 Worktree 默认 detached HEAD，永久 Worktree 才有分支；每个创建、Handoff、恢复和清理动作都能追溯到单一仓库、起始提交、环境类型和路径；
- primary 决定 cwd、Git、配置/Skill 自动发现和 Worktree；secondary 只作为经过验证的 runtime workspace roots。移除 root 后新 Turn 不再拥有访问权，且不会继续沿用 Electron 的过期 roots；
- 初始化与 `.worktreeinclude` 的命令/文件清单在执行前经用户预览确认；BilliardBuddy Key、运行数据、浏览器数据、插件配置和截图绝不复制；
- Handoff 在 Git 代码已迁移并验证、源 Thread 已退订且空闲后才执行原生 `thread/resume`。无法安全迁移或 Core 不接受 cwd 覆盖时失败关闭，绝不只改 Electron 的 cwd 映射；
- 删除前检查未提交更改。若允许清理脏受管 Worktree，必须先生成并验证可恢复 Git 快照；恢复只还原项目代码和用户明确包含的文件，绝不复制或重建 Agent Loop、Memory、审批和模型凭据；
- Scheduled Task 必须记录并确认目标环境：Git 项目默认专属 Worktree，Local 只能显式选择并显示主目录写入风险；非 Git 项目不伪造隔离。

### W1b

- 每个终端/Action 绑定一个已验证 checkout 和受 Main 控制的进程句柄；关闭终端、切换项目、退出应用后没有遗留进程；
- UI 不能发送任意 App Server JSON-RPC 或文件系统调用；用户终端的非沙箱属性清楚可见，不能继承/伪装 Agent 权限档；
- Git 面板读取当前 checkout 的真实状态；Stage、Commit、Push、PR 和破坏性 Revert 均按各自动作边界确认并在失败后重新读取状态；
- Local environment setup、Actions 与 Worktree 使用同一份公开项目配置，不存在 Electron 私有脚本副本。

### M1

- Computer Use 工程是独立 Rust stdio MCP，不依赖 Electron、Bun 或局域网服务；
- macOS 与 Windows 原生 runner 都能从同一锁定源码构建该工程；
- 插件 manifest 与实际存在的 Skill/MCP/平台资源一致；Skills-only 插件不得虚构 `.mcp.json`，MCP 插件的启动文件和目标平台二进制必须存在；
- Code Mode companion 使用 Core 固定内部文件名，与 App Server 同 revision、target 和补丁集，进入 engine manifest、签名和安装包审计；`code_mode` 仍按 Core feature gate，不由 Electron 强制开启；
- M1 产物可作为未安装的本地市场进入安装包，但不会被自动添加、安装、启用或注册为可调用工具，也不会仅因包内文件存在而触发系统权限；
- 当锁定 App Server 仍把安装/卸载标为 under development 时，发布构建不得开放该生产入口；升级后须重新验证安装原子性、失败清理、启用状态和卸载残留；
- `full-access` 不会自动启用任何桌面能力。

### M2

- 用户明确选择 Chrome Profile/标签页或主动连接扩展后才可建立连接；
- Agent 只能取得连接范围内的结构化页面信息，不能读取 Cookie、密码、令牌或浏览器原始存储；
- 网站副作用、上传下载与完整 CDP 高权限操作均有可见的原生确认；
- 断开连接、撤销扩展授权或关闭插件后立即失效。

### M3

- M3a 用户明确启用后才请求 macOS 系统权限；仅 `allowedBundleIds` 内的 App 可被截图/操作；Screen Recording 或 Accessibility 缺失时失败关闭；
- M3b 仅在 Windows 活动桌面上操作；非前台场景失败关闭；
- 当前锁定 revision 下，Windows 持久 App 范围只来自 BilliardBuddy Computer Use 插件的 `allowedExecutablePaths`，macOS 只来自同一插件配置的 `allowedBundleIds`；Core 继续独立负责插件启用和工具审批。升级后只有在上游确实提供等价 App allowlist API 时才迁移，迁移后删除旧字段，任何平台都不得同时保留两份“始终允许”权威；
- 密码、支付、身份验证、系统安全设置和破坏性动作重新确认；
- 任务中断、用户输入、窗口失焦或撤销权限后停止。
- macOS locked use 未交付时必须明确显示不支持；不得以普通前台 Computer Use 通过验收来宣称这一能力已对齐。

### M4

- 录制没有用户明确开始时绝不进行；结束后立即停止；
- 事件含足够的 App/window、Accessibility 全量/差量、焦点/选择、控件角色、稳定目标和成功状态语义，能在不依赖坐标盲猜的情况下起草 Skill；证据不足时明确失败；
- 记录的输入/页面/截图遵循字段白名单、大小上限、脱敏与最小保留范围；密码、OTP、Key、支付及高敏字段绝不原样进入事件或 Skill；
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
- 本地图片、项目文件引用和显式 Skill 分别映射 Core 的 `localImage`、`Mention`、`Skill`，路径/符号链接/大小/范围失败时不发送；
- 模型不支持图像时不会将 Appshot 伪装成已理解的视觉内容；发送前明确告知所选模型 Provider 会收到本次附件。

### M6–M6c

- Memory 的开启、Thread 模式和清除调用 Rust 原生接口；BilliardBuddy 不另存记忆，也不从外部 Agent 导入记忆；
- Guardian 拒绝只展示原生理由并允许确定动作的一次确认重试；不得形成主机白名单或权限升级；
- MCP Apps 资源运行在隔离视图，不能直接取得 Electron/Node 权限；市场包必须验签且可撤销，离线时不自动安装未知包。

### M7

- standalone 每次创建独立 Rust Thread，existing-thread 只恢复目标 Thread；两者都没有 Host 自建上下文或 Agent Loop；
- 简单计划与 RRULE 解析到同一权威计划，时区、下一次触发、错过/重叠策略可测试；
- 每次运行都保留独立 Thread/Turn、环境、状态和脱敏错误记录；任务历史不会被下一次运行覆盖；
- Git 项目可选专属 Worktree 或显式 Local；多项目运行相互隔离，应用退出或项目缺失时不扩大权限补跑；
- 无窗口后台执行不依赖 Renderer；需要用户审批或桌面授权时进入 `needs input`，不会静默批准。

### M8–M9

- 迁移、插件、远程主机、云 Runner 都不扩大本地 Agent 的默认权限；
- 设备、插件、MCP、Hook 和远程 Runner 均可独立撤销；
- SSH 远程项目只通过系统 OpenSSH 连接匹配的远端 App Server；主机校验、远端 revision、Sandbox 或路径异常时不公开监听、不回退到本机执行，也不复制本机 Key；
- BilliardBuddy 不依赖 OpenAI 账号、ChatGPT Subscription 或 OpenAI 私有 Remote/Cloud 服务；
- Key、令牌和 Cookie 不进入 Gateway、日志或不受信 Relay；模型请求中用户明确发送的提示/附件遵循 4.6，其余完整桌面截图与原始文件不因远程或计划任务被额外上传。

---

## 10. 参考证据

- 锁定源码：`third_party/codex-engine/codex-rs/app-server/README.md`；
- 锁定源码：`third_party/codex-engine/codex-rs/features/src/lib.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/core-plugins/src/discoverable.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/app-server/src/request_processors/plugins.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/core/src/mcp_tool_call.rs`；
- 锁定源码：`third_party/codex-engine/codex-rs/install-context/src/lib.rs` 与 `third_party/codex-engine/scripts/codex_package/README.md`（App Server 与 Code Mode Host 的规范打包关系）；
- 当前桥：`ts/desktop/electron/services/codexNativeAppServer.ts`；
- 当前权限确认：`ts/desktop/electron/main.ts`；
- 本机产品实物（只读审计，不作为可复制源码）：`/Applications/ChatGPT.app` `26.727.51351` 的签名包结构、`app.asar` 宿主配置、`plugins/openai-bundled`、`codex`、`codex-code-mode-host`、`cua_node` 与原生模块；该证据只用于确认组件边界和当前产品形态，版本升级后须重新审计；
- 升级边界：`docs/重构/Codex运行时源码所有权与精简边界.md`；
- 官方 Codex 手册：[Config basics](https://learn.chatgpt.com/docs/config-file/config-basic)、[Permissions](https://learn.chatgpt.com/docs/permissions)、[Rules](https://learn.chatgpt.com/docs/agent-configuration/rules)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[Local projects/multiple folders](https://learn.chatgpt.com/docs/projects)、[Local environments](https://learn.chatgpt.com/docs/environments/local-environment)、[Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Scheduled tasks](https://learn.chatgpt.com/docs/automations)、[Appshots](https://learn.chatgpt.com/docs/appshots)、[Image inputs](https://learn.chatgpt.com/docs/image-inputs)、[Notifications](https://learn.chatgpt.com/docs/notifications)、[Windows/WSL](https://learn.chatgpt.com/docs/windows/wsl)、[Computer Use](https://learn.chatgpt.com/docs/computer-use)、[Browser](https://learn.chatgpt.com/docs/browser?surface=app)、[Chrome extension](https://learn.chatgpt.com/docs/chrome-extension)、[Remote connections/SSH](https://learn.chatgpt.com/docs/remote-connections)、Cloud environments、MCP、Skills、Hooks 与 Plugins。
- 平台 API：Apple [ScreenCaptureKit](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos?changes=_9)、Apple [Accessibility API](https://developer.apple.com/documentation/applicationservices/axuielement_h)、Microsoft [UI Automation](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-uiautomationoverview)。

本合同只规定 BilliardBuddy 的产品实现边界；第三方插件、浏览器扩展、远程服务和操作系统自动化在接入前仍须分别审查许可证、平台政策、隐私、系统 API 和发布渠道要求。
