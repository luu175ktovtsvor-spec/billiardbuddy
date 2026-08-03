# Codex 原生 Agent 路线

## 结论

BilliardBuddy 的 Agent 不再复刻 Codex。正式实现是锁定的 `third_party/codex-engine` Rust 源码构建出的 `codex-app-server`，以 stdio JSON-RPC 运行在 Electron Main 管理的独立进程中；同 revision 的 `codex-code-mode-host` 作为 Core 固定查找的 companion 随包分发，不由 Electron 重写或强制启用。

这保留 Codex 原生的 Agent 操作系统：ReAct Loop、上下文与压缩、Thread/Turn/Item、工作区规则、文件与命令工具、Exec/Sandbox、审批、MCP、Skills、Hooks、插件、Review、协作、流式通知和会话恢复。BilliardBuddy 不重新实现这些语义。

## 产品接入边界

Electron Main 是官方 App Server 协议的桌面客户端：它启动子进程、创建/恢复 Thread、启动/中断 Turn、转发原生通知，并将需要用户回应的原生 server request 交给将来的 Renderer。工具不是由 Electron 实现；只有审批、追问或外部交互需要壳转发。

目前包装的客户端请求覆盖 Thread 历史与管理、Turn、目标、后台终端、MCP、Skills、Hooks、插件/本地市场、协作和 Review。未为前端提供界面的原生交互必须 fail-closed，不能由壳自行批准。

## 模型协议边界

Codex Core 只使用 Responses wire API。

- 托管 DeepSeek 本身提供 Responses：通过 BilliardBuddy Gateway 转发。
- 用户选择 Responses 的 Provider：本机凭据代理原样转发到用户选定 endpoint。
- 用户只能使用旧 Chat Completions 的 Provider：本机无状态适配器负责 Responses 与 Chat 的请求、工具调用和 SSE 事件转换。

适配器没有 Thread、工具执行、审批、重试账本、上下文压缩或持久化；所有这些仍归 Rust Core。用户 Key 存在 Electron 的安全存储中，Rust 子进程只拿到短生命周期 loopback capability，Key 不写入 `CODEX_HOME`、Renderer、Gateway 或日志。

## 明确不迁移的 Codex 云服务

不迁移或模拟 OpenAI 账号登录、Codex 云端计费、云端工作区、远程插件市场、CLI/TUI 品牌和 OpenAI 原生生图服务。BilliardBuddy 保留自己的品牌、托管模型计费边界和图片/视频工作台；为避免两套生图产品并行，内核的原生 image-generation 工具被关闭。

## 维护规则

更新 Codex 时，先升级锁定源码 revision，再重新应用并审计 BilliardBuddy 的最小安全补丁，最后重新生成协议/双二进制清单并在 macOS、Windows 构建。不得为了兼容而改写 Agent Loop、上下文压缩或工具语义。
