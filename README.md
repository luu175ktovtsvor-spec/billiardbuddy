# BilliardBuddy

BilliardBuddy 是桌面端产品。它由一个 Codex 原生 Agent 运行时，以及独立的图片、视频和语音工作台组成。

## 当前架构

```text
空 Renderer（等待新前端）
  -> Electron Main（窗口、系统安全存储、受信 IPC）
      -> 打包的 codex-app-server（Rust / stdio JSON-RPC）
          -> Codex 原生 Thread、Turn、Context、Tools、Sandbox、审批、MCP、Skills、Hooks
      -> 本地媒体 Sidecar（图片、视频、语音与设置）

托管模型：Rust -> 本机凭据代理 -> BilliardBuddy Gateway /v1/responses -> DeepSeek
用户 Responses Key：Rust -> 本机凭据代理 -> 用户 Responses endpoint
用户 Chat Key：Rust -> 本机协议适配器 -> 用户 Chat Completions endpoint
图片生成：本地媒体 Sidecar -> Gateway /v1/images/tasks -> 私网 Image Relay -> GPT Image 2 / Seedream 4.5
```

Rust App Server 是唯一的 Agent 执行和会话所有者。Electron 只负责宿主、密钥、进程生命周期和协议转发；Gateway 负责托管模型与图片任务的鉴权、额度、用量、路由、幂等与安全转发；它们都不保存或调度 Agent 会话。图片 Project、Candidate、Canvas 和版本事实只保存在本地 Sidecar，Relay 仅持有受 ACK 约束的异步任务结果。

当前桌面 Renderer 是刻意保留的空入口，不含旧 React 页面或旧自建 Agent。新的前端只能投影 Rust Thread/Turn/Item 与各媒体领域状态，不能重建 Agent Loop 或第二份会话状态。

## 目录

| 路径 | 职责 |
| --- | --- |
| `third_party/codex-engine` | 锁定的 OpenAI Codex Rust 源码，构建为 `codex-app-server` |
| `ts/desktop/electron` | Electron 主进程、preload、原生 App Server 桥、凭据与打包脚本 |
| `ts/desktop/src` | 空 Renderer 装配点，供后续前端重建 |
| `ts/src/server` | 自研图片、视频、语音、本地媒体与设置 Sidecar；不执行 Agent |
| `ts/shared` | 桌面、Sidecar 与 Gateway 的共享产品契约 |
| `gateway` | 托管 DeepSeek Responses 与图片异步任务的鉴权、额度、用量、路由、幂等和安全转发 |
| `relay` | 图片/视频异步任务结果交接；不保存图片项目事实 |
| `docs` | 当前架构、运行与领域边界 |

## 模型配置

用户可选择 BilliardBuddy 托管模型，或添加自己的 Provider。个人 Provider 预设包含官方申请 Key 链接、请求地址、认证方式和可选的 `/models` 发现；不会维护或要求用户填写上下文窗口、最大输出或压缩阈值。`/models` 只用于发现模型名，不推断能力。

只有两条个人协议路径：`Responses` 直接代理，或旧 `Chat Completions` 在本机无状态转换为 Responses。两条都进入同一个 Rust Codex Agent。

## 开发与验证

需要 Bun、Node.js、Electron 工具链和 Rust/Cargo（构建原生 App Server 时）。

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
