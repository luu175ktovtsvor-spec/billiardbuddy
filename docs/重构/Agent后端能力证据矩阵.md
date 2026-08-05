# Agent 后端能力证据矩阵

## 使用方式

本表是 BilliardBuddy Agent 后端的当前证据，不是产品路线图。证据顺序固定为：锁定的 Codex 源码和 App Server 协议、BilliardBuddy 的真实调用链和自动验证、官方公开文档与本机 ChatGPT.app 的只读边界、最后才是本文件。只有已经经过前三级验证的结论可以写成“已接线”或“已验证”。

锁定上游 revision 为 `2b5bdcf67547860f2e5c5a605009a70026796b2b`。产品仅保留两份环境变量隔离补丁：`0001-sanitize-hook-environment.patch` 与 `0002-sanitize-non-tool-child-environment.patch`；它们不改变 Codex 的 Agent Loop、Thread/Turn、上下文压缩、工具、审批、Sandbox、MCP、Skills、Hooks、Memory 或多 Agent 语义。

“后端已接线”不等于“用户已能在当前版本点击使用”：`ts/desktop/src` 仍是空 Renderer，以下所有 Preload API 都是供后续前端消费的稳定边界。没有消费方的功能必须保持未对用户承诺的状态。

| 用户结果 | 能力归属 | 官方证据 | BilliardBuddy 生产调用链 | macOS / Windows 状态 | 当前验证 | 真实缺口 | 明确非目标 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 原生 Agent 规划、工具调度、上下文与自动压缩 | Codex Rust Core | `core/src/session/turn.rs` 的 Turn loop、`core/src/context_manager.rs`、`core/src/compact.rs`；[App Server](https://learn.chatgpt.com/docs/app-server) 是外部产品接入边界 | Preload `nativeAgent.startTurn` -> IPC payload 校验 -> Main 的 Thread/Turn 所有权 -> `ElectronCodexNativeRuntime.startTurn` -> `turn/start` -> 原生通知回传 | 同一 Rust Core；系统 Sandbox 按目标平台由上游实现 | `verify:codex-engine-source` 与 `verify:codex-native-protocol` 对照 Core、协议和 Electron 调用；完整 Rust 编译/测试待远程 | 当前没有 Renderer 事件视图；本机禁止 Rust 编译，不能将源码审计写成二进制运行证明 | TypeScript Harness、第二个 Loop、第二份压缩、工具路由、审批或 Sandbox |
| Thread、Turn、恢复、Fork、历史、Review、协作和子 Thread | Codex App Server/Core；Electron 仅负责窗口/工作区路由 | `app-server-protocol/src/protocol/v2/thread.rs`、`turn.rs`、`review.rs`、`collaboration_mode.rs`；官方 App Server Thread/Turn/流式通知说明 | Preload -> IPC -> Main -> `thread/*`、`turn/*`、`review/start`；`thread/started` 只继承父 Thread 的窗口所有权与已登记工作区，Core 仍拥有图关系 | 协议两平台相同 | 协议脚本核对 73 个直连 client request、63 个已审计未暴露请求和 6 类 server request；工作区恢复、Fork、Review alias 有单测 | 无前端显示 Thread 图、历史和 Review；通知实际桌面旅程待打包后复验 | Electron 自建 Thread Store、子 Agent 调度器、handoff 状态机或云端 Thread 迁移 |
| 原生 Memory、每 Thread 模式和 reset | Codex Core/App Server | `core/src/memories/`、`thread/memoryMode/set`、`memory/reset`、`config/batchWrite` 协议 | Preload -> IPC -> Main -> Runtime 原样调用原生配置和 Memory 方法 | 同一 Core 语义 | 协议对照和类型/边界测试覆盖请求形状 | 尚无 UI；外部 Agent Memory 迁移受上游探测规则限制 | 自建向量库、第二套摘要、外层 Memory 数据库 |
| 审批、追问、MCP 表单与通知回调 | Core 发起 server request；Electron 只转发并绑定发起窗口 | `app-server-protocol` 的 server request 定义和 [App Server](https://learn.chatgpt.com/docs/app-server) 审批/事件模型 | App Server request -> Runtime 校验 -> Main 以 Thread/Turn 绑定 `webContents.id` -> 后续 Renderer 回答同一 request id；窗口销毁时拒绝未决请求 | 两平台相同；系统权限另由宿主管理 | 6 类 server request 合同、所有权释放和崩溃清理受测试/协议脚本保护 | 无审批 UI 时必须 fail-closed；没有用户可见旅程 | Electron 审批数据库、自动批准或绕过 Core |
| 原生终端和模糊文件搜索 | Codex App Server；Main 仅守住 workspace 与窗口所有权 | 协议 `command/exec*`、`fuzzyFileSearch*`；上游 App Server message processor | Preload 窄参数 -> Main 从 Thread 取已绑定 cwd -> Runtime -> 原生 PTY/搜索；process/session id 的输出只回发起窗口 | 两平台协议；PTY 实现归上游 | 协议及所有权/输入边界测试 | Windows 真正 PTY、终端 UI 及打包产物待远程与前端验证 | Renderer 任意 `spawn`、任意 cwd、任意 fs/write 或独立 Shell 服务 |
| MCP、Skills、Hooks、Plugin、本地市场和外部 Agent 配置迁移 | Codex Core/App Server；BilliardBuddy 只随包提供本地市场 | 上游 `mcp`、`skills`、`hooks`、`external-agent-migration` 模块；[Plugins](https://learn.chatgpt.com/docs/plugins) 和 App Server 文档 | Preload -> IPC -> Main -> 原生 `mcpServer*`、`skills*`、`hooks/*`、`plugin/*`、`marketplace/*`、迁移请求；Hook 信任仅在 Main 明确确认后写入上游已有 hash 状态 | 同一配置语义；本地插件二进制按平台 | 锁定协议、补丁内容和 Hook 子进程环境验证；插件 stage/verify/smoke 由本地和远程门禁执行 | 本地市场条目是 `AVAILABLE`，不是启动即安装；没有插件/迁移 UI；上游标为实验/开发中的接口不承诺跨 revision 稳定 | ChatGPT 私有市场、远程插件共享、MCP Apps UI、绕过原生权限或自建 MCP 生命周期 |
| 托管 DeepSeek、用户 Responses Key、旧 Chat Completions Key 进入同一个 Core | BilliardBuddy 本机凭据桥/无状态协议适配；Core 仍是唯一 Agent | Codex Core 只走 Responses wire；锁定 provider/config 源码；[DeepSeek Responses 兼容性](https://api-docs.deepseek.com/zh-cn/guides/responses_api) | 安装会话或个人 Key -> Main 路由 -> loopback capability -> Rust App Server -> 本机 adapter；旧 Chat 只做 request/SSE 协议转换，不能保存 Thread 或重写工具 | TypeScript 路径两平台相同 | 本地 adapter 回归 9 项通过（50 个 expect），覆盖协议转换、Key 脱敏、视觉输入拒绝和 DeepSeek Responses 默认值；锁定协议/源码检查通过。远程 macOS 运行 `31033977788` 的真实网络前置链通过，但第 11 步在发请求前报 `PERSONAL_MODEL_BASE_URL_INVALID`；修复空/空白 Secret 后，`31037680817` 因 GitHub 账单阻断未启动，因此没有真实 Provider 通过证据 | 账单状态恢复后，必须重新执行专用可撤销 Key 的两 Turn+重启恢复探针；在此之前不能把真实网络、额度、模型权限或 Provider 响应写成已验证 | OpenAI 登录/计费/云推理；用户填写上下文窗口或最大输出；改写 Core 压缩 |
| 多模态模型的视觉输入 | 所选 Provider 的模型能力；BilliardBuddy 只按模型能力传递输入 | Responses 输入图片语义和 Core 的 image input；模型是否视觉由 Provider/模型决定，不由 Agent 伪造 | Appshot 或普通 image Turn -> Main -> Runtime -> adapter；托管 DeepSeek 文本模型在 adapter 入口拒绝 `input_image`，视觉模型则按其 Responses 能力直通 | 与 Provider 无关的宿主边界两平台相同 | capability registry 和 adapter 负例测试 | 没有把非视觉模型“补成视觉”的隐式 Agent 功能；用户自接视觉模型需做真实图片 smoke | 用 Skill/MCP 把视觉结果伪装成模型原生视觉，或为模型设置上下文/输出限制 |
| Computer Use 的语义化系统操作 | BilliardBuddy Computer Use 插件和 macOS AX / Windows UIA 服务；Core 管工具调用/审批 | [Computer Use](https://learn.chatgpt.com/docs/computer-use) 的桌面产品语义；本机包的插件/专用宿主形态只用于职责反推 | Core MCP 工具 -> 原生审批回调 -> Rust MCP -> Swift AX 或 C++ UIA -> 动作前重新验证前台 app/window/元素 fingerprint -> 结果回 Core | macOS Swift；Windows C++/UIA | 语义 snapshot、敏感控件拒绝、UTF-16/UIA/DPI/前台复核和打包静态审计有代码与测试；macOS Swift typecheck、插件 verify/smoke 已通过 | 坐标 click/drag/scroll 仍是受 app/window/前台/边界复核的兜底，不能说“没有坐标”；真实权限用户旅程和 Windows 编译待远程 | 后台任意控制、盲目坐标宏、密码/支付输入、复制私有执行器 |
| 独立 Browser Use 与受限 Browser Developer Mode | Electron `InAppBrowserHost` + Browser MCP；Core 管工具 | 本机包的 Browser Skill/客户端形态；Browser 不属于 App Server 会话状态 | Core MCP 工具 -> approval -> loopback capability -> Main 的隔离 Electron partition -> 隔离世界元素句柄；Developer Mode 只投影 DOM/Layout/Performance | Electron 行为两平台一致 | Browser E2E、句柄失效、脱敏 Console/Network/Performance 和 CDP allowlist 有自动验证门 | Windows 打包后 E2E 尚待唯一远程构建；无 Browser UI | 用户 Chrome Profile、Cookie/Storage、任意 CDP、页面主世界注入 |
| Chrome Control 与受限 Chrome Developer Mode | 固定 Chrome 扩展 + Native Messaging host + MCP；Core 管工具 | Chrome 是桌面宿主/扩展能力，不是 Agent Loop；本机包结构仅作边界参考 | Core MCP 工具 -> approval -> Native Messaging -> 已由用户连接的 tab；frame/execution context 绑定元素；只读 CDP allowlist | 扩展共用；host 二进制分平台 | Native Messaging、扩展脚本及 staged PE machine 有测试/静态审计 | 注册 native host 不会安装 Chrome 扩展。用户必须手动以开发者模式安装固定 unpacked extension 并连接 tab；当前无前端引导，故不是开箱可用 | Chrome Profile/Cookie/密码/历史、任意 JS/CDP、静默装扩展或接管标签页 |
| Record & Replay 生成可审阅 Skill，而非坐标宏 | BilliardBuddy 原生录制器 + MCP；Core/Skill 负责后续执行 | [Record & Replay](https://learn.chatgpt.com/docs/extend/record-and-replay) 只公开承诺 macOS 的语义录制到 Skill 流程 | Core MCP -> explicit approval/start -> native event hook -> 事件时 app/PID/window 固定 -> AX/UIA 语义差量 -> JSONL -> 用户审阅后保存 Skill | macOS 是官方相邻能力；Windows 是 BilliardBuddy 自有扩展 | start 对已有记录 fail-closed，防止确认失败/取消覆盖；事件元素必须归属同一窗口才保留控件语义；无 replay tool | 真实两平台系统权限录制旅程、Windows MSVC 编译与 Skill 质量需远程/现场证据 | 坐标/按键宏播放、记录输入值/Cookie/截图/视频、沿用录制时权限、把 Windows 说成官方功能 |
| Worktree、Handoff、Git 与 Local Environment | Electron 受确认宿主；Thread/Memory 仍由 Core | [Git worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)、[Local environment](https://learn.chatgpt.com/docs/environments/local-environment) 与本机包的桌面宿主边界 | Preload -> strict IPC -> Main idle/ownership/confirmation -> `AgentWorkspaceHost`、`AgentGitHost`、`LocalEnvironmentHost`; Worktree alias 持久化后，恢复/Fork/Review 不采信 renderer cwd；handoff 只转移文件/checkout | 两平台 Git/Node；实际工具链依赖系统 | Worktree 路径/alias/restart 单测、Main IPC 链路与 Git/环境服务测试 | Local Environment 的 setup/cleanup 是用户确认后的宿主脚本，不属于 Core Sandbox；仅其后在 Terminal 中执行 action 才进入 Core。无前端、未做真实远端 push | 复制 Thread/Memory/Key；通用命令 API、自动 push、SSH 远程项目或 WSL2 |
| macOS Appshots 把前台窗口截图与可访问文本带入一次 Turn | Electron Main + macOS native capture；Core 接收 image/additional context | [Appshots](https://learn.chatgpt.com/docs/appshots)；协议 `configRequirements/read` 的 `allow_appshots` 和 Core `AdditionalContextKind` 映射 | 专用 Preload action（没有路径/图片/context 参数）-> IPC -> Main 确认并检查 `allowAppshots` -> 一次性 native capture -> PNG/身份/大小校验 -> `turn/start`；固定 Electron 捕获来源进 `application`，第三方 AX 文本进 `untrusted` | 仅 macOS；Windows 明确 unsupported | Appshot Host/IPC/上下文分类有测试；锁定 Core 源码确认 `application` 映射 developer fragment、`untrusted` 映射 user fragment | 真实 Screen Recording 与 Accessibility 权限旅程待现场验证；无 Appshot UI | Renderer 伪造可信来源、后台截图历史、把外部 AX 内容升级为开发者指令、Windows 同名臆造 |
| Windows x64 / ARM64 Agent-only 工具链与安装包资源一致 | Rust/C++/Electron 各自构建；afterPack 做 Agent 成品审计 | 上游 Windows Sandbox helpers；锁定目标三元组和 PE machine 约束 | PowerShell 选 target -> MSVC vcvars/Rust target -> App Server、Agent 插件、sidecar -> Electron package -> afterPack/解包按 PE machine 审计；Agent-only 明确跳过媒体工具链 | x64 与 ARM64 都有脚本/工作流路径 | 远程 `31028522560` 的 x64 已完成 789 个官方测试，1 个 Windows sandbox helper 生命周期测试失败，48 个忽略；失败是 staged helper 被遗留进程占用，不是缺少二进制。已提交 CI 隔离/清理修复 `747be3eb`、`2b06f161`，但修复后的 `31037351605` 两个 job 均因 GitHub 账单阻断而未启动；旧 ARM64 job 仍在打包，未拿到最终产物证据 | 账单状态恢复后必须重跑修复后的 x64/ARM64 workflow，确认隔离测试、MSVC/链接、NSIS 解包、PE machine 和成品 Agent 资源；当前不把静态审计或未启动 job 当作通过 | 把静态审计当作已编译通过；把未开发媒体强行塞进 Agent 包；为避开 CI 关闭 target/PE 校验 |
| 前端可用性与通知呈现 | 后续 BilliardBuddy Renderer；不是 Core 或 Main 的替代状态层 | App Server 仅提供深度集成协议；没有官方要求 Electron 自建 UI 状态机 | 当前仅 `preload.nativeAgent` 和宿主 API；`ts/desktop/src` 没有实际调用方 | 两平台都未交付 | 源码搜索确认没有 Renderer consumer | 当前所有后台已接线功能均待未来前端消费；前端必须投影原生事件、不得重建 Thread/Turn/Agent 状态 | 在 Renderer 复刻 Agent Loop、审批、Thread、Memory 或上下文 |

## 本轮可复核验证

- 当前源树已重新执行 `bun run verify:codex-engine-source` 与 `bun run verify:codex-native-protocol`：锁定 revision、两份最小凭据隔离补丁、73 个直连 client request、63 个审计但不暴露的请求和 6 类 server request 均与源码相符。
- 本地 `bun test --preload ./test/setup.ts ./test/codexNativeProvider.test.ts` 为 `9 pass / 0 fail / 50 expect`；`git diff --check` 和全部 GitHub workflow YAML 解析均通过。
- 本机 `bun run check:server` / `bun run check:electron` 仍因当前工作树没有安装完整依赖而找不到 `tsc`；这不是代码通过证据，远程 macOS job 的第 7 步才是干净依赖环境下的检查证据。
- 远程 macOS run `31033977788`（锁定 revision、commit `03d4f638`）第 1–10 步全部成功：依赖、宿主/IPC/协议、官方 App Server 构建与 smoke、Agent/Chrome/Browser 插件、Main 的 Thread/Turn 恢复、Hook 和 Browser E2E 均已完成。第 11 步在网络请求前失败为 `PERSONAL_MODEL_BASE_URL_INVALID`，所以没有真实 Provider Turn。
- 已提交验收脚本空地址回退 `58e3a7fc` 并触发 `31037680817`；该 run 在 job 调度层被 GitHub 账户付款/支出上限拒绝，未执行任何步骤，也未产生 API 请求。真实 Provider 的两 Turn、重启恢复、历史读取仍是未验证项。
- Windows run `31028522560`（commit `b7266f02`）的 x64 第 1–12 步成功；Rust 结果为 `789 passed; 1 failed; 48 ignored`，唯一失败是官方 `windows_elevated_enforces_deny_read_and_protects_setup_marker` 在 staged helper 被遗留 `codex-windows-sandbox-setup` 进程占用时复制失败。已把两个相关测试改成逐个运行并在每次后清理 helper（`747be3eb`、`2b06f161`），但修复后的 `31037351605` 因同一账单阻断未启动；旧 ARM64 job 仍在打包，尚未给出成品收据。
- 当前仍没有可把“源码存在、mock 通过、job 未启动”提升为成品通过的证据：Windows MSVC/PE/NSIS、macOS 无签名可安装包、真实权限旅程和真实 Provider 网络结果均保持未验证。签名、公证、正式发布和媒体不属于本轮构建门。

## 对抗审计结论

### Codex -> BilliardBuddy

- 发现并修正 Appshot 把第三方 AX 文本当作 `application` context 的问题：只有 Electron 固定的“谁在何时捕获”进入 `application`，AX 结果始终是 `untrusted`。
- 发现并修正 Appshot 忽略 `configRequirements/read.allowAppshots` 的问题：宿主在捕获前 fail-closed。
- 发现并修正 Worktree 在重启恢复后重新采信 Renderer cwd 的问题：持久化 source/worktree 活跃位置与 Fork/Review alias，恢复只取已登记路径。

### BilliardBuddy -> Codex

- 未发现第二套 Agent Loop、Thread/Turn、上下文压缩、工具调度、审批、Sandbox、MCP、Skills、Hooks、Memory 或多 Agent 状态。Electron registry 仅记录工作区路径和窗口所有权，不能保存或解释 Core 会话。
- 去除了 Worktree 子 Thread 人为数量上限；Core 原生多 Agent 图不由 BilliardBuddy 截断。
- Local Environment、Git、Browser、Chrome、Computer Use、Record 与 Appshot 都是受确认宿主能力，不能被描述为 Core 内建或云端能力。

## 真实 Provider 验证计划

真实网络验证只在用户提供的可撤销、低额度、限速测试 Key 已进入受控环境后执行；脚本不读取或打印现有用户长期 Key。

1. 先跑 mock/本地 Core 测试，覆盖协议转换、Thread/Turn、错误脱敏、Key 不进 Rust 子进程和 Hook capability 隔离。
2. 每种协议先运行固定两 Turn（含重启后的 Thread 恢复与历史读取）的小烟测：Responses、旧 Chat Completions、一个确认支持图像的 Responses 模型。只有这一步通过，才允许按协议、工具和视觉能力分组扩大样本；每一批都要有独立的次数、超时和费用上限，并与 CI 和长期 Key 隔离。
3. 多模态烟测使用固定无敏感图片，验证的是该模型自身的视觉输入，不把视觉结果伪装成文本模型原生能力。
4. 在安装包产物上人工完成一次 UI 旅程：保存 Key、创建/恢复 Thread、拒绝一次审批、清除 Key。它才验证 Preload/IPC/Main、安全存储和打包路径。

## 不进入范围

- OpenAI/ChatGPT 登录、账号、云端计费、推理集群、云端工作区、私有 Remote Runner/Cloud Runner、私有 relay/protocol；
- App Server WebSocket、Unix socket、远程 Code Mode Host；产品固定本地 `stdio://`；
- 远程主机、移动端遥控、SSH 项目、Windows WSL2、realtime voice；
- OpenAI 原生生图，以及本轮图片/视频工作台业务。
