# BilliardBuddy

BilliardBuddy 是面向球房经营者的单一 Electron 桌面 Agent。产品由聊天 Agent、生图工作台和视频工作台三个并列板块组成；它们共享一个桌面壳、身份与资源控制面，但各自保持正确的执行链和领域真相。

产品方向、不可变边界和完成标准以 [BilliardBuddy 产品重构合同](./BilliardBuddy-重构合同.md) 为准。

## 产品结构

| 板块 | 用户结果 | 权威状态 | 正式执行链 |
|---|---|---|---|
| 聊天 Agent | 连续对话、工具执行、Skills、Plugins、MCP、子任务、权限、恢复和定时执行 | `ProductTask`、`TaskRun`、durable event | DeepSeek `TextReasoning` ↔ Product Agent Harness ↔ Tool/MCP/Skill；聊天图片先经 MiMo `VisualEvidence` |
| 生图工作台 | 参考图、画布、三候选、版本、编辑、比较和导出 | `MediaProject`、Operation/Job、Asset、Version | MiMo `MediaReasoning` → Gateway/Relay → GPT Image 2 或 Seedream |
| 视频工作台 | 素材、证据、转写、场景、时间线、预览、渲染和导出 | `MediaProject`、Evidence、Timeline Version、持久 Job | 本机 FFmpeg/ffprobe + Fun-ASR + MiMo `MediaReasoning` |

Renderer 只保存视图投影；Electron Main 负责受限 IPC、窗口、安全存储和 sidecar 生命周期；本机 Product Server 是 ProductTask、MediaProject、计划任务和资源调度的唯一写入权威。远端 Gateway 只承担安装身份、模型能力、用量与容量控制，Relay 只承担图片 provider 的持久异步任务和结果 blob，不保存第二份业务项目。

## Agent Harness

正式聊天路径位于本地 `agent-worker` 内，不经过公共 CLI。每个 Turn 由唯一的模型—工具循环推进，工具调用先经过 Host 的工作区、权限和资源校验，再把真实回执写入 durable event。桌面重开后从事件 cursor 恢复；取消、工具授权、compact、resume、MCP OAuth、Skills、Hooks、Plugins 和子任务都属于这条 Harness，而不是 renderer 临时状态。

用户权限只有三档：

- Ask for approval：工作区沙箱 + 按需询问。
- Approve for me：工作区沙箱 + 本机自动策略。
- Full access：完整本机权限，不做常规工具询问。

本机终端是独立 PTY，不是 Agent Bash 回放，也不会继承产品管理的 Gateway 凭据。

## 项目指令

打开用户项目时，Harness 会从仓库根目录到当前工作目录逐层收集以下文件，并在 Turn 开始时冻结为有明确来源的上下文：

1. `AGENTS.md`
2. `BilliardBuddy.md`
3. `.BilliardBuddy/BilliardBuddy.md`
4. `.BilliardBuddy/rules/*.md`
5. `.BilliardBuddy/BilliardBuddy.local.md`

同一目录中后加载的规则优先，路径更深的规则覆盖上层规则。模型不会自行扫描磁盘或把普通文件冒充成项目指令。本仓库根目录的 `AGENTS.md` 只约束本仓库开发，不能与用户项目指令混淆。

## 目录

| 路径 | 职责 |
|---|---|
| `ts/src/server` | 本地 Product Server、ProductTask、Agent Host、媒体、语音、计划任务和资源调度 |
| `ts/src/server/agent-worker` | 正式 Product Agent Harness、Tool、Skill、Hook、Plugin、MCP 和子任务运行时 |
| `ts/shared` | 桌面、本地服务和 Gateway 共用的产品契约 |
| `ts/desktop` | React renderer、Electron Main、preload、sidecar 与发行脚本 |
| `gateway` | 五条 provider 能力泳道、安装身份、用量、容量和 Relay 代理 |
| `relay` | GPT Image 2 / Seedream 持久任务、幂等、结果 blob 与 ack |
| `ts/product-contracts` | 可生成、可校验的产品策略、迁移 reader 与删除消费者证据 |
| `docs/refactor` | 外部参考源码到本项目改动的证据链 |

生产服务器的真实进程、端口、路由、环境变量名称和验证结果见 [生产服务器运行文档](./docs/operations/production-servers.md)。

## 本地开发

需要 Bun、Node.js，以及 Electron/node-pty 支持的本机工具链。

```bash
cd ts
bun install
cd desktop
bun install
bun run electron:dev
```

常用源码门禁：

```bash
cd ts
bun run check:product-contracts
bun run check:server
bun run check:desktop
bun run check:electron
bun run check:media-real-fixture
```

真实 PTY 用 Electron 对应的 Node/Vitest 运行时验收：

```bash
cd ts/desktop
BB_LIVE_PTY_TEST=1 bunx vitest run electron/services/terminal.test.ts --testTimeout 30000
```

Gateway 与 Relay 测试从仓库根目录运行：

```bash
bun test gateway relay --timeout 30000
```

测试通过只证明对应源码边界；不能替代真实上游、安装、升级、恢复、签名、公证或安装包用户旅程。

## Provider 与容量边界

Provider registry 是 model ID、能力、上下文和 body budget 的唯一来源。客户端不能选择供应商或覆盖模型：

- `TextReasoning`：DeepSeek `deepseek-v4-flash`
- `VisualEvidence`：MiMo `mimo-v2.5`，只用于聊天看图桥接
- `MediaReasoning`：MiMo `mimo-v2.5`，只用于图片/视频工作台
- `SpeechTranscription`：Fun-ASR
- `ImageGeneration`：GPT Image 2 / Seedream，经 Relay 持久任务

当前 MiMo 生产分区为 `GW_MIMO_CONC=64`、`GW_MIMO_MEDIA_CONC=48`、`GW_VISION_CONC=16`，三者必须满足 `48 + 16 = 64`。`gateway/validate-mimo-capacity-env.sh`、`gateway/validate-production-capacity-env.sh` 和 `relay/validate-production-env.sh` 会在重启服务前校验非敏感容量配置与持久存储条件；这些数字是准入上限，不是线上吞吐承诺。

## 发行

发行阶段必须在源码、迁移、部署和文档收口后执行。macOS arm64 与 Windows x64 分别使用：

```bash
cd ts/desktop
bun run build:macos-arm64
bun run build:windows-x64
```

最终验收必须解包两个平台的产物，审计运行闭包与旧入口，并从真实安装包完成激活、普通任务、三档权限、原生搜索、图片三候选、视频证据编排、语音、计划任务、本机终端、升级、断网、重启和失败恢复。源码搜索或 `electron-builder --dir` 不能替代这一步。
