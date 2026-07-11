# Codex 后端代码视图

> 📌 状态:✅现行 · 最后核对 2026-07-11
> 逆向对象:本机 `ChatGPT.app` 内置的 Codex 桌面版(`openai-codex-electron` v26.707.31428)+ 开源 `github.com/openai/codex`(Rust `codex-rs`)。
> 记录口径:标 ✅ = 从真实代码/文档/asar 读到;标 🔶 = 按结构推断、未逐行确认。

## 来源

| 来源 | 内容 | 读法 |
|---|---|---|
| `/Applications/ChatGPT.app/Contents/Resources/app.asar` | 桌面壳,`package.json` name = `openai-codex-electron` | `asar` 解包 `.vite/build/*.js`,grep 字符串/依赖 |
| `github.com/openai/codex` → `codex-rs/`(99 crate) | Codex 引擎本体 | GitHub API 拉 tree + `raw` 读 `docs/protocol_v1.md` 与源码路径 |

桌面 App 内嵌开源 Codex 引擎(Rust);Electron 主进程是宿主 + UI 桥。✅

## 1. 架构分层

```
UI 层 · Electron 渲染进程(webview/,React) ← 逆向档案 01~05
 capnweb RPC + ipcMain
宿主层 · Electron 主进程(.vite/build/main-*.js) ✅
 ipcMain(×20)、node-pty(终端)、better-sqlite3(本地缓存)、
 Sentry、codex-micro-service —— 拉起并托管 app-server
── UDS `.sock` ── ✅(main 里 app_server/.sock/--listen/app-server-control)
引擎层 · Codex(Rust codex-rs,独立进程)
 app-server(daemon/transport/protocol)对外收发
 SQ(提交队列)/ EQ(事件队列)
 core(Session→Task→Turn 循环)
 tools / exec / execpolicy / sandboxing / mcp / config …
模型层 · OpenAI Responses REST API(/responses) ✅(protocol_v1.md)
```

UI 与引擎解耦:`protocol_v1.md` 原文「Codex is intended to be operated by arbitrary UI implementations」。TUI、VSCode 插件、桌面 App 是同一引擎的不同 UI。传输层可换(进程内 channel / UDS / stdin-stdout / TCP / HTTP2 / gRPC),事件统一序列化为换行分隔 JSON(NDJSON)。

## 2. 核心协议:SQ / EQ 提交-事件双队列

权威源 `codex-rs/docs/protocol_v1.md` + `protocol/src/protocol.rs` + `core/src/agent.rs`。✅

**实体**:
- `Model` —— OpenAI Responses API。
- `Codex` —— 核心引擎,本地跑(后台线程或独立进程),经 **SQ(UI→Codex)/ EQ(Codex→UI)** 一对队列通信。
- `Session` —— 当前配置+状态;首条消息为 `Op::ConfigureSession` 初始化;可重配(重配中止在跑的活)。
- `Task` —— 响应一次用户输入的工作;一个 Session 同时只有一个 Task;`Op::UserTurn` 起一个 Task。
- `Turn` —— Task 里的一轮:①向 Model 发请求(prompt 或上轮输出 + 可选 `last_response_id`)②Model SSE 流式回,收到 completed 收束 ③执行命令/打补丁/输出消息 ④需要时暂停要审批。上一 Turn 的输出是下一 Turn 的输入;某 Turn 无输出则 Task 结束。

**接口两端**:
- `Submission`(SQ,UI→Codex):带 UI 给的 `sub_id`;`Op` 枚举(`non_exhaustive`)。常见:`UserTurn`(起一轮,带 cwd/model/sandbox/approval policy/可选 `approvals_reviewer`)、`UserInput`(旧式)、`Interrupt`、`ExecApproval`、`UserInputAnswer`。`UserTurn` 内容项:`text` / `image`·`local_image` / `skill`(带 `SKILL.md` 路径)/ `mention`(`app://{connector_id}`)。`personality` 覆盖取 `friendly`/`pragmatic`/`none`。
- `Event`(EQ,Codex→UI):`id` = 起这轮的 `sub_id`;`EventMsg` 枚举(`non_exhaustive`)。常见:`AgentMessage`、`AgentMessageContentDelta`、`PlanDelta`、`ExecApprovalRequest`、`RequestUserInput`、`TurnStarted`(带 `model_context_window`/`collaboration_mode_kind`)、`TurnComplete`(带 `response_id`)、`Error`、`Warning`。v1 线上 `TurnStarted`/`TurnComplete` 序列化为 `task_started`/`task_complete`,反序列化两种 tag 都收。

**线程续接**:每轮结束把 Model `response.completed` 的 `response_id` 存进 Session,下轮带上续线;给未来 turn 可从早点分叉。`response_id` = OpenAI `/responses` 存的 id。

## 3. crate 地图(codex-rs · 99 crate)

| 子系统 | crate | 职责 |
|---|---|---|
| 协议 | `protocol` `app-server-protocol` `exec-server-protocol` `code-mode-protocol` | Op/EventMsg、各服务线协议 |
| 对外服务 | `app-server` `app-server-daemon` `app-server-transport` `app-server-client` `stdio-to-uds` `uds` | 引擎对 UI 的门面、UDS/stdio 传输 |
| 代理核心 | `core` `core-api` `core-plugins` `core-skills` | Session/Task/Turn 循环、客户端、压缩、工具编排 |
| 工具 | `tools` `apply-patch` `file-search` `file-system` `file-watcher` | 工具定义/执行/发现、打补丁、文件搜索 |
| 执行+沙箱 | `exec` `exec-server` `exec-server-protocol` `execpolicy` `sandboxing` `linux-sandbox` `windows-sandbox-rs` `bwrap` `shell-command` `shell-escalation` `process-hardening` | 跑命令、危险分类、三平台沙箱、提权 |
| MCP | `codex-mcp` `mcp-server` `rmcp-client` | 作为 MCP server 暴露、接外部 MCP、Rust MCP 客户端 |
| 模型接入 | `model-provider` `model-provider-info` `models-manager` `chatgpt` `ollama` `lmstudio` `login` `aws-auth` `http-client` `backend-client` `codex-client` `codex-api` `responses-api-proxy` `network-proxy` | 多供应商、登录鉴权、Responses 代理 |
| 存储/上下文 | `rollout` `rollout-trace` `message-history` `thread-store` `memories` `context-fragments` `state` `keyring-store` `secrets` | 会话录制、历史、线程、记忆、密钥 |
| 配置 | `config` `cloud-config` `codex-home` | config.toml、家目录 |
| 连接器/插件/技能/钩子 | `connectors` `plugin` `core-plugins` `core-skills` `skills` `hooks` | 连接器、插件、技能、生命周期钩子 |
| 云/定时 | `cloud-tasks` `cloud-tasks-client` `cloud-config` | 云任务/定时 |
| 协作/代理编排 | `agent-graph-store` `agent-identity` `external-agent-sessions` `external-agent-migration` `collaboration-mode-templates` `code-mode` `code-mode-host` | 多代理、外部代理会话迁移 |
| UI(引擎自带) | `tui` `cli` `exec` `ansi-escape` `terminal-detection` | 官方 TUI/CLI/headless |
| 可观测 | `otel` `analytics` `feedback` `response-debug-context` | OpenTelemetry、埋点、反馈 |

## 4. 核心循环(core crate)

✅ `codex-rs/core/src/` 真实文件。

- 代理循环:`agent/mod.rs` `agent/control.rs`(+`control/execution.rs`/`spawn.rs`/`residency.rs`)`agent/registry.rs` `agent/role.rs` `codex_thread.rs` `codex_delegate.rs`。
- 模型客户端:`client.rs` `client_common.rs`(拼 Responses 请求、收 SSE)。
- 上下文压缩:`compact.rs` + `compact_remote*.rs`(远端压缩)、`compact_token_budget.rs`、`compact_model_fallback.rs`。本地 + 远端两路压缩,含 token 预算与降级模型。
- 打补丁:`apply_patch.rs`。
- 指令上下文:`agents_md.rs` `agents_md_manager.rs`(读 `AGENTS.md` 作项目指令)。
- 命令规范化:`command_canonicalization.rs`。

## 5. 工具系统(tools crate + core/src/tools)

✅ `codex-rs/tools/src/` + `codex-rs/core/src/tools/`。

- 工具骨架:`tool_definition.rs` `tool_spec.rs` `tool_config.rs` `tool_executor.rs` `tool_call.rs` `tool_output.rs` `tool_payload.rs` `json_schema.rs`。
- 动态/发现/搜索:`dynamic_tool.rs` `tool_discovery.rs` `tool_search.rs`。
- MCP 工具:`mcp_tool.rs`。
- 代码模式:`code_mode.rs` + `core/src/tools/code_mode/*`(execute/wait handler);模型写代码批量调工具。
- 核心 handler(`core/src/tools/handlers/`):`apply_patch`、`agent_jobs`(派子代理:`spawn_agents_on_csv.rs` / `report_agent_job_result.rs`)、`code_mode`、`approvals.rs`。
- 执行(`core/src/`):`exec.rs` `exec_env.rs` `exec_policy.rs` `shell.rs` `shell_snapshot.rs`。
- 装插件:`tools/src/request_plugin_install.rs`。

## 6. 执行与沙箱

✅ crate 源文件。

- 危险分类 `execpolicy`:`policy.rs` `rule.rs` `parser.rs` `decision.rs` `amend.rs` `executable_name.rs` —— 规则引擎判命令拦/审批。
- 三平台沙箱 `sandboxing` + `linux-sandbox` + `windows-sandbox-rs`:macOS `seatbelt.rs`(sandbox-exec/Seatbelt);Linux `landlock.rs`(Landlock)+ `bwrap.rs`(bubblewrap),`linux-sandbox/` 有 `bundled_bwrap.rs`/`launcher.rs`/`proxy_routing.rs`(沙箱内网络走代理);Windows 独立 crate。统一层 `manager.rs`/`denial.rs`/`policy_transforms.rs`。
- 沙箱模式 `sandbox_mode`:`read-only` / `workspace-write` / `danger-full-access`;审批档 `approval_policy`:`untrusted` / `on-request` / `on-failure` / `never`(🔶取值组合按 crate 结构 + config.toml 语义)。审批走 `ExecApprovalRequest`(EQ)→ `Op::ExecApproval`(SQ)。

## 7. MCP · 连接器 · 技能 · 钩子

- MCP:`codex-mcp`(作 MCP server 暴露)、`rmcp-client`(接外部 MCP)、`mcp-server`、`mcp_tool.rs`。文档 `docs/codex_mcp_interface.md`。
- 连接器 `connectors`:对应桌面 UI「插件/连接器」(`mention` 用 `app://{connector_id}`)。
- 技能 `skills`/`core-skills`:`SKILL.md` 形式,`UserTurn` 可带 `skill`。
- 钩子 `hooks`:生命周期钩子。

## 8. 存储与上下文

- 会话录制 `rollout` + `rollout-trace`(主进程 `rollout` ×29):整段会话落盘可回放。
- 历史/线程:`message-history` `thread-store`。
- 记忆:`memories` + `context-fragments`。
- 配置:`config` + `codex-home`(`~/.codex/`)+ config.toml(smol-toml)。
- 密钥:`keyring-store` `secrets`(系统钥匙串)。
- 桌面壳另用 `better-sqlite3`(×6)做本地缓存/索引。✅

## 9. 云 · 定时 · 模型接入

- 云/定时 `cloud-tasks`(+`cloud-tasks-client`/`cloud-config`):定时/云端任务。
- 模型接入:`model-provider`(+`-info`)、`models-manager`、`chatgpt`、`login`、`aws-auth`、`ollama`/`lmstudio`、`responses-api-proxy`、`network-proxy`。

## 10. 桌面托管层

✅ `.vite/build/main-*.js`(1.7MB)+ `codex-micro-service-*.js` + `package.json` 依赖。

- Electron 主进程,`ipcMain`(×20);`electron-context-menu` + 原生菜单(`native-menu-locales`)。
- 托管引擎:`codex-micro-service` + `main` 里 `app_server`/`--listen`/`.sock`/`app-server-control` —— 拉起 Codex app-server,经 UDS `.sock` 通信,管连接状态(`app-server-connection-state`/`app-server-state-reconciled`)。
- 终端:`node-pty`。
- 本地存储:`better-sqlite3`。
- RPC:`capnweb`(Cap'n Web,主进程↔渲染进程类型化 RPC)。
- 其它依赖:`@sentry/electron`+`@sentry/node`、`ssh-config`、`shlex`、`smol-toml`、`which`、`ws`、`zod`、`protocol`/`commands`/`app-server-types`。
- 健壮性:`crash-reporter`、`child-process-snapshot-worker`、`trace-recording-upload`、`file-based-logger`、`feedback-desktop-log-archive`。

## 11. 一次请求的后端流转

1. UI 敲字 → 渲染进程经 capnweb/ipcMain 给主进程 → 主进程经 UDS 把 `Op::UserTurn`(带 cwd/model/sandbox/approval)放进 SQ。
2. `core` 起 Task 进第一个 Turn:`client.rs` 拼 Responses 请求 → SSE 流式回 → `AgentMessageContentDelta` 进 EQ → UI 流式显示。
3. 跑命令:`command_canonicalization` 归一 → `execpolicy` 判危险 → 需审批则 `ExecApprovalRequest`(EQ)等 `Op::ExecApproval`(SQ);放行则 `exec.rs` 在 `sandboxing` 里跑,输出回灌。
4. 改文件:`apply_patch` 工具打补丁。
5. 本轮无更多输出 → `TurnComplete`(带 `response_id`)进 EQ;有则进下一 Turn。
6. 全程写 `rollout` 落盘;上下文超阈值触发 `core/compact*`。

## 边界

- 云端(Responses API 服务端、云任务后端、账号体系)是专有服务,不在开源仓库、无法逆向;本文只覆盖本地引擎。
- 桌面 v26.707.31428(2026-07 本机);`codex-rs` 取 GitHub `main`,会持续变。
- 桌面 `.vite/build/*.js` 是 minified bundle,只 grep 字符串/依赖佐证,未逐函数还原(引擎逻辑以开源 `codex-rs` 为准)。
