# BilliardBuddy

BilliardBuddy 是桌面端产品。目标产品由一个 Codex 原生 Agent 运行时，以及独立的图片、视频工作台组成。仓库仍保留既有产品语音转写兼容路径，并承载视频所需的音频分析；它不是新的独立语音工作台或语音 Agent，后续只能随媒体迁移按明确退出条件收口。

## 当前架构

```text
空 Renderer（等待新前端）
  -> Electron Main（窗口、系统安全存储、受信 IPC）
      -> 打包的 codex-app-server（Rust / stdio JSON-RPC）
          -> 同 revision 的 codex-code-mode-host（仅由 Core 按 feature gate 启动）
          -> Codex 原生 Thread、Turn、Context、Tools、Sandbox、审批、MCP、Skills、Hooks
      -> 本地媒体 Sidecar（图片、视频、设置、视频所需转写及既有语音兼容路径）

托管模型：Rust -> 本机凭据代理 -> BilliardBuddy Gateway /v1/responses -> DeepSeek
用户 Responses Key：Rust -> 本机凭据代理 -> 用户 Responses endpoint
用户 Chat Key：Rust -> 本机协议适配器 -> 用户 Chat Completions endpoint
图片生成：本地媒体 Sidecar -> 公网 Image Relay /v1/images/tasks -> GPT Image 2 / Seedream 4.5；Relay 仅回查 Gateway 私网身份内省
图片理解/非阻断视觉评估：本地媒体 Sidecar -> Gateway /v1/image/reasoning -> Qwen3-VL-Flash
视频远程分析：本地 Video Sidecar -> Video Media Relay -> 阿里云百炼 / 北京临时对象存储
```

Rust App Server 是唯一的 Agent 执行和会话所有者。Electron 只负责宿主、密钥、进程生命周期和协议转发；Gateway 负责自己执行的托管短模型治理及两个 Relay 的私网身份内省，不代理图片或视频任务。它们都不保存或调度 Agent 会话。图片 Project、Candidate、Canvas 和版本事实只保存在本地 Sidecar，Image Relay 仅持有受 ACK 约束的异步任务结果。

Qwen 只返回有 receipt/confidence 的可见事实、风险和 Repair Action 建议；不能采纳、删除、发布或修改用户事实。最终发布仍由本地确定性 Release Check 与风险接受回执决定。

Video Media Relay、Image Relay 与 Gateway 是三条不重叠的正式执行路径：Video Media Relay 只承接经项目 Consent 和预算确认的 Qwen、Fun-ASR 与 `text-embedding-v4` 视频派生物，Image Relay 只承接图片生成/编辑，Gateway 执行托管 Agent、既有产品语音、MiMo 与 Qwen 图片建议。两个 Relay 只回查 Gateway 私网身份内省；它们都不保存项目、时间线、画布或创作状态，Sidecar 仍是媒体领域事实与项目预算的唯一 writer。

当前桌面 Renderer 是刻意保留的空入口，不含旧 React 页面或旧自建 Agent。新的前端只能投影 Rust Thread/Turn/Item 与各媒体领域状态，不能重建 Agent Loop 或第二份会话状态。

Agent 后端的实际调用链、能力归属、平台状态、验证结果、真实缺口和非目标见 [docs/重构/Agent后端能力证据矩阵.md](docs/重构/Agent后端能力证据矩阵.md)。这里的后端边界不表示当前空 Renderer 已向用户交付对应界面。

## 目录

| 路径 | 职责 |
| --- | --- |
| `third_party/codex-engine` | 锁定的 OpenAI Codex Rust 源码，构建为 `codex-app-server` 与配套 `codex-code-mode-host` |
| `ts/desktop/electron` | Electron 主进程、preload、原生 App Server 桥、凭据与打包脚本 |
| `ts/desktop/src` | 空 Renderer 装配点，供后续前端重建 |
| `ts/src/server` | 自研图片、视频、本地媒体与设置 Sidecar；含视频转写及既有语音兼容路径，但不执行 Agent |
| `ts/shared` | 桌面、Sidecar 与 Gateway 的共享产品契约 |
| `gateway` | 托管 DeepSeek、MiMo、Qwen 图片建议与既有转写的鉴权、额度、准入、用量、幂等，以及两个 Relay 的私网身份内省；不代理图片/视频任务 |
| `relay` | 独立 Image Relay：图片生成/编辑的账号准入、异步任务、结果交接与 ACK；不保存图片项目事实 |
| `video-media-relay` | 视频远程分析的独立 Relay：对象租约、身份内省、账户额度与 Provider receipt |
| `docs` | 当前架构、运行与领域边界 |

## 模型配置

每个完成安装认证的用户默认可以使用托管 Agent、图片生成和视频远程分析，无需先配置个人 Key。三类托管额度独立结算：Agent 额度耗尽只限制托管 Agent，图片额度耗尽只限制图片生成，视频远程额度耗尽只限制视频分析；容量排队和上游短暂故障仍是可重试服务状态，不能伪装成额度耗尽。各额度在 UTC 周期重置，正式错误合同携带对应能力和重置时间。

用户也可为 Agent 添加自己的 Provider。个人 Provider 预设包含官方申请 Key 链接、请求地址、认证方式和可选的 `/models` 发现；不会维护或要求用户填写上下文窗口、最大输出或压缩阈值。`/models` 只用于发现模型名，不推断能力。个人 Agent Key 只保存在 Electron Main 的系统安全存储，经本机短生命周期代理直连用户选择的 Provider；它不经过 Gateway、不会消耗托管 Agent 额度，也不改变图片和视频额度。

安装包的 `product-config.json` 仅包含固定 HTTPS Gateway、Image Relay 与 Video Media Relay 路由，不包含模型 Key、Relay service token、额度或并发数字。容量、队列、RPM、额度、账号绑定和跨境媒体传输超时均由服务器/桌面运行环境的受控 policy 配置解析；最终 Provider 调用点仍保留硬性准入，不能只靠 Nginx 或外部面板限制连接数。

只有两条个人协议路径：`Responses` 直接代理，或旧 `Chat Completions` 在本机做无状态协议适配。两条都进入同一个 Rust Codex Agent，Agent Loop、Thread、工具执行和压缩不会因此另写一套；但旧 Chat 接口无法表达的 Responses 专属托管工具不会被伪造，例如 hosted web search 只在真实 Responses Provider 上保留。标准 Chat 图片与 WAV/MP3 音频输入会按旧接口格式转换；工具返回的图片或音频会转换成紧随工具结果的标准多模态消息，不会被静默丢弃。厂商私有多模态协议不在兼容范围。

## 开发与验证

需要 Bun、Node.js、Electron 工具链和 Rust/Cargo（构建原生 App Server、Code Mode Host 与本地插件时）。

```bash
cd ts
bun install
bun run audit:source
bun run check:server
bun run check:electron
bun run verify:codex-engine-source
```

桌面开发启动：

```bash
cd ts/desktop
bun install
bun run electron:dev
```

跨平台 Agent-only 发行构建由 GitHub Actions 执行：`桌面版-Windows Agent-only出包` 与 `桌面版-macOS Agent-only出包`。当前不在开发机执行 Rust、Electron 或安装包构建；两条 workflow 不下载、不 staging、不审计 FFmpeg/ffprobe，也不运行 Canvas golden。媒体工作台保留独立的后续发行路径。

本地 `ts/desktop/scripts/build-macos-arm64.sh` 与 `build-windows-x64.ps1` 仍支持维护和故障复现；需要显式设置 `BB_AGENT_ONLY_BUILD=1` 或 Windows `-AgentOnly` 才会跳过媒体工具链。

构建通过只证明 Agent 构建闭环。正式发行仍须验证真实安装、Agent Thread/Turn、工具审批、恢复、个人 Key 和升级路径；媒体工作台另行验收。
