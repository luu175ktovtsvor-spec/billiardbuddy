# BilliardBuddy Codex Agent 客户端后端开发合同

> 状态：架构与施工边界冻结，当前代码事实更新至 2026-08-04
>
> 范围：Agent 客户端后端、桌面宿主、模型接入、本地插件与打包
>
> 暂不包含：新 Renderer、图片工作台、视频工作台、远程控制与云端 Runner

## 1. 最终架构判定

BilliardBuddy 不开发第二套 Agent，也不重写 Codex。

正式产品只有一个 Agent 状态权威：从锁定 OpenAI Codex 源码构建的 Rust App Server/Core。Agent Loop、Thread、Turn、Item、上下文与自动压缩、工具选择、Shell/文件工具、Sandbox、审批、MCP、Skills、Hooks、插件、Review、子 Agent、Memory 和恢复全部由这份上游 Rust 代码负责。

BilliardBuddy 开发的是自己的桌面客户端后端：

```text
未来 BilliardBuddy Renderer
        ↓ 类型化 IPC
Electron Main（BilliardBuddy 客户端后端）
        ↓ JSON-RPC over stdio
锁定源码构建的 Codex App Server / Core
        ↓ Responses
本机短生命周期模型代理
        ├─ BilliardBuddy 托管 DeepSeek Gateway
        ├─ 用户自带 Responses Key
        └─ 用户自带旧 Chat Key → 无状态 Responses 适配
```

这套结构与本机 ChatGPT/Codex 桌面产品的组件边界一致：桌面包内同时存在 Agent 二进制、Code Mode companion、`rg`、Electron 宿主、插件清单、Skills 和需要系统权限的专用执行器。BilliardBuddy 只复用开源 Agent 与公开扩展边界，不复制 OpenAI 的专有二进制、账号服务、私有远控协议或品牌资源。

## 2. 上游源码所有权

### 2.1 锁定源码

- 源码：`third_party/codex-engine`
- 上游：`https://github.com/openai/codex`
- 当前 revision：`2b5bdcf67547860f2e5c5a605009a70026796b2b`
- 产品合同：`ts/shared/product/codexEngineContract.ts`

公开依据以 [Codex App Server 官方文档](https://developers.openai.com/codex/app-server/)、[上游 App Server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[配置参考](https://developers.openai.com/codex/config-reference/)、[Skills](https://developers.openai.com/codex/skills/) 和 [MCP](https://developers.openai.com/codex/mcp/) 为语义对照。精确方法、字段和运行行为仍以本仓库锁定 revision 的协议枚举、消息处理器、Core 调用链和测试为准；公开文档或本机 `.app` 的文件名不能替代源码证据。

每次升级只做四件事：

1. 更新锁定 revision；
2. 审阅上游协议、运行资源和安全边界变化；
3. 重新应用、缩减或删除 BilliardBuddy 的最小产品补丁；
4. 重跑协议总账、本机构建、macOS/Windows 构建和真实用户旅程。

不得为 BilliardBuddy 重写或长期维护以下上游语义：

- Agent Loop 与工具循环；
- 上下文窗口、自动压缩阈值与摘要生成；
- Thread/Turn/Item 状态机；
- Shell、文件、Git、网页、MCP 和插件工具调度；
- Sandbox、审批、Guardian、Memory、Review 与子 Agent；
- CLI/TUI/SDK 行为。

CLI、TUI 和 SDK 属于 Codex 项目的其他客户端。BilliardBuddy 不需要把它们改成自己的产品，也不需要随桌面安装包分发。

### 2.2 唯一允许的 Core 产品补丁

当前构建合同只保留两份凭据隔离补丁：

- `0001-sanitize-hook-environment.patch`
- `0002-sanitize-non-tool-child-environment.patch`

原因是 BilliardBuddy 给 App Server 的进程环境包含一枚只能访问本机模型代理的短生命周期 capability。用户可控制的 Hook、插件安装辅助进程和非工具子进程不能继承它。源码审计确认产品私有 `CODEX_HOME` 没有需要保留的旧 `notify` 配置、IPC 或迁移路径，因此删除了原先会扩大上游分叉面的第三份补丁。

这些补丁只删除子进程继承的 `KEY`、`SECRET`、`TOKEN` 类环境变量，不改变 Agent、压缩、工具、Sandbox、审批、MCP、Skill、插件或恢复语义。若上游以后原生解决同一问题，应删除补丁，不保留无意义分叉。

## 3. BilliardBuddy 客户端后端职责

Electron Main 只负责客户端与操作系统职责：

- 启动、校验、退出和恢复 App Server；
- 将受信 Renderer 动作映射到类型化 App Server 请求；
- 通用转发原生通知；
- 将原生审批、追问和 MCP 表单交给用户，并把原生响应形状回填；
- 保存用户模型配置与 Key；
- 提供系统权限、窗口、浏览器、文件选择和打包能力；
- 维护临时窗口/Thread/Turn 所有权，防止不同 Renderer 越权；
- 在应用退出时停止本产品启动的子进程和本地桥。

Electron Main 不得：

- 保存第二份 Agent 会话、消息、压缩摘要或工具账本；
- 根据通知顺序自行推断子 Agent 图或 Turn 最终状态；
- 在 TypeScript 中实现 Tool Router、Agent 重试循环或审批数据库；
- 把任意 `config/read`、TOML、文件系统、Shell 或进程接口直接交给 Renderer；
- 让媒体 Sidecar、Gateway 或 Renderer拥有模型 Key 或 Agent Thread。

## 4. 当前 Agent 客户端后端事实

### 4.1 App Server 运行资源

安装包从同一 revision 构建并校验：

- `codex-app-server`，产品资源名为 `billiardbuddy-agent-engine`；
- `codex-code-mode-host`，保留上游运行时要求的内部文件名；
- 上游清单对应的 `rg`；
- Windows 原生 Sandbox setup 与 command runner 辅助程序；
- revision、补丁集、文件大小和独立哈希清单。

启动前缺失、版本不符、补丁不符或哈希不符都会失败关闭。`CODEX_HOME` 仍是上游要求的环境变量名，但值固定到 BilliardBuddy 用户数据目录下的 `agent-runtime/`，不会读写用户独立的 `~/.codex` 会话和凭据。

### 4.2 原生协议覆盖

锁定 App Server 当前共有 136 个 Client Request：

- 73 个已通过类型化 Electron Main 桥接；
- 63 个逐项登记为不暴露；
- 6 类 Server Request 已处理。

“6 类”是 Rust 主动向客户端索取审批、用户输入、MCP 表单或动态工具结果的回调类型，不是只有 6 个工具。文件、Shell、Git、网页、MCP、插件和子 Agent 工具仍在 Rust Core 内部运行，所有原生通知继续通用透传。

不暴露的 63 个方法必须属于以下一种：

- OpenAI 账号、用量、App、远控或云端服务；
- 会绕过产品边界的原始文件、进程或 Shell 客户端 API；
- 上游内部迁移、诊断或实验接口；
- 明确不做的 realtime voice、远程环境、插件共享或 Guardian 临时入口。

验证脚本会把上游新增方法当成失败，直到它被正式桥接或写出明确排除理由。

当前官方 Manual 还公开记录了 App Server WebSocket、Unix socket transport、远程 Code Mode Host，以及仍标为开发中的 `plugin/list`、`plugin/read`；其中 WebSocket 路径明确标为实验性且不支持生产。锁定 revision 确实包含这些源码，但 BilliardBuddy 只以 `stdio://` 启动随包 App Server 和本地 Code Mode Host；不会把额外 transport 或远程 host 暴露为产品能力。插件目录调用则包在固定的 BilliardBuddy 类型化 IPC 后面，只读取本地或 workspace marketplace，并依赖 revision 锁定与协议总账吸收上游变化，不能把上游“开发中”状态写成跨版本稳定承诺。

### 4.3 Thread、Turn、设置与子 Agent 图

当前客户端后端已经接入：

- Thread 创建、列表、全文搜索、恢复、读取、Fork、归档、解归档、删除、命名、回滚、压缩；
- Turn 启动、steer、中断、Review、历史 Turn/Item 分页和通知；
- Thread Sections、移动排序、Goal 和后台终端状态/停止；
- loaded Thread 列表与 idle Thread unsubscribe；
- Thread Git 元数据更新；
- `thread/list` 的 cwd、source kind、section、直接父 Thread 和祖先 Thread 筛选；
- 模型目录、模型 Provider capability、Permission Profiles 和 managed requirements；
- `config/read` 的安全投影；
- per-Thread permission profile、reasoning effort、reasoning summary 和 personality 更新；
- Memory 启用/禁用与清理；
- Collaboration Mode 与原生子 Agent Thread 通知。

`config/read` 不会原样进入 Renderer。客户端只投影模型、Provider、Core 当前识别的上下文/压缩只读值、审批策略、Sandbox、网页搜索、推理设置、来源类型和配置层版本；指令、developer instructions、compact prompt、MCP、环境变量、未知配置和配置层正文全部删除。

用户不填写上下文窗口、最大输出或压缩阈值。投影的上下文与压缩数值只是 Core 当前有效状态，不能由客户端写回。自动压缩仍完全由 Rust Core 决定。

App Server 异常退出时，待处理审批立即失败，活动 Turn 的客户端投影被清理，Renderer收到脱敏的 runtime-unavailable 事件；Thread 所有权保留用于从 Rust Store 恢复。Renderer销毁时，其临时所有权和待处理回调会释放，避免新窗口被死所有者阻塞。

### 4.4 模型接入

三条路线最终都向 Core 表现为 `billiardbuddy` 自定义 Responses Provider：

1. 托管 DeepSeek：本机代理 → BilliardBuddy Gateway `/v1/responses` → DeepSeek；
2. 用户 Responses Key：本机代理直接请求用户选择的 Responses endpoint；
3. 用户旧 Chat Key：本机无状态适配器把 Core 的 Responses 请求、函数调用、工具结果和 SSE 事件转换成标准 Chat Completions。

用户 Key 只在系统安全存储和本机短生命周期代理中出现，不写入 `agent-runtime`、Renderer、Gateway、日志或项目。Gateway 不拥有 Agent Thread、Turn、工具、压缩或任务执行；它只负责安装身份、额度、路由、用量和模型流转。

Chat 适配器不保存会话、不生成摘要、不计算压缩阈值、不重试 Agent，也不伪造 Responses-only 托管工具。它只做协议转换。直接 Responses 路线不转换协议。

## 5. 审批与高权限宿主边界

Rust Core 的审批仍是 Agent 工具审批权威。Electron 不为每次点击、输入、文件写入或 MCP 工具再建一套审批状态。

桌面宿主仍必须负责 Core 无法代替的系统边界：

- macOS Screen Recording / Accessibility；
- Windows UI Automation、活动桌面、UIPI 与 UAC；
- 用户允许操作的 App 范围；
- Chrome 扩展连接的标签页与网站范围；
- BilliardBuddy Browser 的独立 Profile 和网站范围；
- 用户主动文件选择、截图与一次性路径授权。

这些是操作系统或产品资源授权，不是第二个 Agent 审批引擎。

随包 Skill 中关于危险外部副作用的确认规则是给 Agent 的产品行为指令，官方 Computer Use Skill 也采用同一形态。它不保存批准、不绕过 Core，也不能扩大 Core 提供的权限。Browser、Chrome、Computer Use 与 Record & Replay 的写工具都显式声明 `readOnlyHint: false` 和 `destructiveHint: true`，由 Core 的 MCP 工具策略生成审批请求，再沿既有 Server Request 回调进入 Electron；没有第二套批准状态机。若用户明确切到 `full-access`，Core 会按原生语义跳过这些逐项审批，因此 Main 的高权限确认必须同时明示文件、网络和四类本地插件写操作都会放开。

## 6. 本地插件架构

当前随包本地市场包含：

```text
runtime-assets/agent-marketplace/
  plugins/
    billiardbuddy-computer-use/
      .codex-plugin/plugin.json
      .mcp.json
      skills/computer-use/SKILL.md
      bin/
    billiardbuddy-chrome/
    billiardbuddy-browser-use/
    billiardbuddy-record-replay/
```

这与本机 ChatGPT/Codex 包中“manifest + Skill + 可选 MCP/专用宿主”的公开组件边界一致，但所有名称、说明、执行器和协议均属于 BilliardBuddy。

当前源码能力：

- Computer Use：macOS AX 与 Windows UIA 的语义快照、稳定元素指纹、前台窗口复核、截图和受限输入；敏感控件拒绝输入；坐标点击、拖拽和滚动只是当语义树没有可靠控件动作时的受控兜底，必须取自当前窗口或截图，且仍受 app/window/前台/边界复核；
- Chrome：固定 BilliardBuddy 扩展、Native Messaging、只操作用户连接的标签页；元素句柄绑定主 frame/execution context，Developer Mode 只开放三项只读 CDP 投影；
- Browser：独立 Electron Profile、隔离世界元素句柄、受限网页快照/截图/导航/点击/输入，以及脱敏 Console/Network/Performance 与只读 CDP 投影；
- Record & Replay：用户明确开始、限时、脱敏、事件时固定应用/进程/窗口、记录控件语义与可访问性差量；录制只作为生成可审阅 Skill 的证据，不提供坐标宏播放器。

插件不会读取 Chrome Profile 文件、Cookie、密码、Keychain、其他应用历史或模型 Key。插件启用、MCP 生命周期和工具审批仍由 Core 负责。

随包 manifest、Skill、弹窗和错误只描述 BilliardBuddy 用户行为。Rust/Core 所有权、施工状态、尚未实现内容和未来路线只允许出现在本合同、源码注释和验证脚本中。

## 7. 源码交叉验证证据矩阵

逐能力证据、完整调用链、macOS/Windows 状态、已验证项、真实缺口和非目标在 [Agent 后端能力证据矩阵](docs/重构/Agent后端能力证据矩阵.md) 维护。本合同不再用“文件存在”“旧提交”或未打包的静态路径作为完成证据。

本次交叉审计已经确认并修正三项实际缺口：Appshot 的第三方 AX 文本降为 `untrusted` context、宿主遵守 `allowAppshots`、已托管 Worktree 的恢复/Fork/Review 不再采信 Renderer 指定 cwd。当前 Renderer 仍没有这些 API 的消费方，因此它们是可供后续前端调用的后端边界，不是已交付页面。

### 7.1 当前仍需保留的完成门

1. 真实 Provider 仍只能以可撤销、低额度专用 Key 的固定两 Turn smoke 取得证据；不读取、导出或猜测用户已有长期 Key。
2. Windows x64/ARM64 目前只有静态和跨架构 fail-closed 证据。用户明确说“构建”前，不打包、不推送、不触发 GitHub；之后的一次 Windows workflow 才能证明 MSVC、Rust target、NSIS、解包与 PE 审计。
3. Computer Use、Chrome、Record & Replay、Appshots、Worktree、Git 和 Local Environment 均无前端用户旅程；系统权限、Chrome 扩展人工安装和现场行为不能由类型检查替代。
4. Scheduled Tasks 只在桌面应用和主窗口存活时运行原生 Turn；没有关闭应用后的系统调度、RRULE、显式时区或重叠策略。
5. 正式安装包资源审计必须以生成的 `app.asar`/NSIS 成品为对象；staging 清单不能替代它。

### 7.2 明确不进入当前范围

- OpenAI/ChatGPT 登录、云端计费、账号用量、推理集群和远程插件市场；
- OpenAI Remote Control、专有 device-key、私有 relay、Cloud Runner / Remote Runner；
- 上游额外的 App Server WebSocket/Unix socket transport 与远程 Code Mode Host，其中 WebSocket 路径官方标为实验性且不支持生产；BilliardBuddy 固定使用本地 `stdio://` 和随包本地 Host；
- BilliardBuddy Remote Host、移动端遥控、SSH 远程项目和 Windows WSL2；
- realtime voice；
- OpenAI 原生生图。图片和视频继续由 BilliardBuddy 自有工作台负责，本轮不修改其业务。

## 8. 本机 `.app` 只读审计结论

本次只读检查对象：`/Applications/ChatGPT.app` 版本 `26.727.51351`。

可验证事实：

- 包内存在独立的 `codex`、`codex-code-mode-host`、`rg` 和 Electron `app.asar`；
- Computer Use 与 Record & Replay 由插件清单、Skill、MCP launcher/专用执行器组成；
- Browser 与 Chrome 由 Skill、浏览器客户端、扩展和宿主组件组成；
- Worktree 的前端代码调用桌面宿主操作 `codex-worktrees`，证明 Worktree 是客户端宿主能力，不属于 Agent Loop；
- Appshots、Worktree、插件页、Skills 页和 Computer Use 设置均是桌面产品层。

这份实物只用于反推职责边界和用户结果。专有二进制、Skill 原文、私有协议、账号服务和品牌资源不得复制到 BilliardBuddy。

## 9. 验收与一次构建规则

在用户明确说“构建”以前：

- 只在本地改代码、改文档和执行本机验证；
- 不推送当前改动；
- 不触发 GitHub Actions；
- 不用一次远程构建代替静态审计。

准备触发唯一一次 GitHub 构建前必须同时满足：

1. 锁定源码与产品补丁合同通过；
2. 136 个 Client Request 和全部 Server Request 重新审计；
3. Electron Main、Preload、IPC 和 Sidecar 类型/构建通过；
4. 模型、凭据、审批、Thread 恢复和退出清理测试通过；
5. 四个插件完成本机可运行的内容、协议、静态与 TypeScript 验证；Rust/C++ 编译、MCP handshake 和 native smoke 由一次远程 Windows workflow 证明；
6. 打包前资源清单审计不含旧 Agent、旧前端、明文 Key 或临时文件；`app.asar`/NSIS 成品审计由同一次远程 workflow 证明；
7. 任务启动的测试服务、浏览器、打包进程和辅助进程全部停止；
8. `git diff` 只包含本轮有意变更；
9. 文档中的“已完成”与真实代码和证据一致；
10. 用户明确说“构建”。

本次唯一的 GitHub Windows 构建职责是提供 Windows 原生编译、安装包与目标架构证据，不是发现基础架构遗漏的第一道检查。构建失败后只根据真实日志修复一次根因，再由用户决定是否继续触发。

### 9.1 本轮本地验证快照

本段只记录本次仍可复核的命令结果；旧的本机构建缓存、旧提交或文件存在不算证据。最终命令输出同步写入 [Agent 后端能力证据矩阵](docs/重构/Agent后端能力证据矩阵.md)。

- 完整 Bun 套件通过：`283 pass`、`1 skip`、`0 fail`、`1830 expect`、`42 files`。`bun run check:server`、`bun run check:electron`、`bun run audit:source` 也通过；后者没有缺失导入目标，两个既有人工审阅入口不属于本轮 Agent 路径。
- 锁定源码、两份产品补丁和协议总账已通过 `bun run verify:codex-engine-source`：73 个直连 client request、63 个逐项审计但不暴露的请求、6 类 server request。任何上游 revision 或协议变化都要求重新审计。
- 已暂存 macOS arm64 Core/插件通过 App Server `thread/search`/ripgrep smoke、受管 Responses Thread/Turn/恢复 E2E、Hook capability 隔离 E2E、四个插件 verify/MCP smoke 和独立 Browser Use Electron E2E；两个 macOS 原生 Swift 服务通过 `swiftc -typecheck`。以上均不使用真实 Provider。
- Windows workflow YAML 和 `git diff --check` 已通过本地语法/空白审计；这不是 Windows 成品证据。
- 当前机器按用户明确限制不进行 Rust `cargo` 编译或测试，避免再次耗尽磁盘/内存；Rust `fmt/check/test`、Windows C++/MSVC 链接、NSIS 解包和成品 smoke 由用户说“构建”后的远程 Windows workflow 取得证据。
- 真实 Provider 冒烟需要的显式确认、端点、模型、协议和专用 Key 环境变量当前均未配置，因此没有产生计费请求。真实 Screen Recording/Accessibility、Chrome extension 连接、安装包 UI 旅程和真实远端 Git push 均不因源码或 mock 通过而自动视为已验证；它们保留在证据矩阵的受控验证计划中。
- 本轮不提交、不推送、不触发 GitHub，直到用户明确说“构建”。

## 10. 最终完成标准

Agent 客户端后端完成时必须能证明：

- BilliardBuddy 运行的是锁定、可校验、可升级的 Codex Rust Agent；
- BilliardBuddy 没有第二套 Agent、上下文、压缩、工具、审批或会话数据库；
- 客户端能完整承载本产品需要的 Thread、Turn、设置、子 Agent、审批、模型、插件和桌面宿主能力；
- 用户自带 Key 与托管 DeepSeek 都只通过 Responses 边界进入同一 Core；
- 用户数据、系统权限、浏览器会话和模型凭据遵循最小权限；
- 未完成能力明确列为缺口，不以源码文件、按钮或文档冒充交付；
- 上游升级只需更新 revision、审阅最小补丁和重跑验证，不重新开发 Agent。
