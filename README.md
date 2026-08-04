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
视频远程分析：本地 Video Sidecar -> Video Media Relay -> 阿里云百炼 / 北京临时对象存储
图片生成：本地媒体 Sidecar -> Gateway /v1/images/tasks -> 私网 Image Relay -> GPT Image 2 / Seedream 4.5
```

Rust App Server 是唯一的 Agent 执行和会话所有者。Electron 只负责宿主、密钥、进程生命周期和协议转发；Gateway 负责托管模型与图片任务的鉴权、额度、用量、路由、幂等与安全转发；它们都不保存或调度 Agent 会话。图片 Project、Candidate、Canvas 和版本事实只保存在本地 Sidecar，Relay 仅持有受 ACK 约束的异步任务结果。

Video Media Relay 与 Gateway 是两条不重叠的正式路径：前者只承接经项目 Consent 和预算确认的 Qwen、Fun-ASR 与 `text-embedding-v4` 视频派生物，负责对象租约、账户额度、幂等和 Provider receipt；后者继续承接既有 Agent、产品语音和图片路径。Relay 不保存项目、时间线或创作状态，Sidecar 仍是这些本地事实与预算的唯一 writer。

当前桌面 Renderer 是刻意保留的空入口，不含旧 React 页面或旧自建 Agent。新的前端只能投影 Rust Thread/Turn/Item 与各媒体领域状态，不能重建 Agent Loop 或第二份会话状态。

## 目录

| 路径 | 职责 |
| --- | --- |
| `third_party/codex-engine` | 锁定的 OpenAI Codex Rust 源码，构建为 `codex-app-server` 与配套 `codex-code-mode-host` |
| `ts/desktop/electron` | Electron 主进程、preload、原生 App Server 桥、凭据与打包脚本 |
| `ts/desktop/src` | 空 Renderer 装配点，供后续前端重建 |
| `ts/src/server` | 自研图片、视频、本地媒体与设置 Sidecar；含视频转写及既有语音兼容路径，但不执行 Agent |
| `ts/shared` | 桌面、Sidecar 与 Gateway 的共享产品契约 |
| `gateway` | 托管 DeepSeek Responses 与图片异步任务的鉴权、额度、用量、路由、幂等和安全转发 |
| `relay` | 图片/视频异步任务结果交接；不保存图片项目事实 |
| `video-media-relay` | 视频远程分析的独立 Relay：对象租约、身份内省、账户额度与 Provider receipt |
| `docs` | 当前架构、运行与领域边界 |

## 模型配置

用户可选择 BilliardBuddy 托管模型，或添加自己的 Provider。个人 Provider 预设包含官方申请 Key 链接、请求地址、认证方式和可选的 `/models` 发现；不会维护或要求用户填写上下文窗口、最大输出或压缩阈值。`/models` 只用于发现模型名，不推断能力。

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

跨平台发行构建：

```bash
cd ts/desktop
bun run build:macos-arm64
bun run build:windows-x64
```

构建通过只证明构建闭环。正式发行仍须验证真实安装、Agent Thread/Turn、工具审批、恢复、个人 Key、媒体工作台和升级路径。
