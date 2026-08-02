# BilliardBuddy

BilliardBuddy 是面向球房经营者的 Electron 桌面 Agent。产品由通用 Agent、生图工作台和视频工作台三个独立工作面组成；它们共享受控桌面运行时，但各自保持自己的领域状态和执行链。

产品方向、不可变边界和完成标准以 [BilliardBuddy 产品重构合同](./BilliardBuddy-重构合同.md) 为准。

## 重构模块

重构总纲是 [BilliardBuddy 产品重构合同](./BilliardBuddy-重构合同.md)。每个建设文档只对应一个可独立验收的大模块：

- [共享运行时与桌面壳](./docs/重构/共享运行时与桌面壳.md)
- [通用 Agent 工作台](./docs/重构/通用Agent工作台.md)
- [生图工作台](./docs/重构/生图工作台.md)
- [视频工作台](./docs/重构/视频工作台.md)
- [迁移与发行](./docs/重构/迁移与发行.md)

默认模型由 BilliardBuddy 服务控制能力和额度；用户明确选择的个人 API Key 只在本机直连上游。Agent 同时支持 Chat Completions 和 Responses 协议。

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
| `ts/src/server` | 本地 Product Server 与图片、视频、语音、设置等独立领域服务；不承载 Agent 执行 |
| `ts/desktop/electron` + `third_party/codex-engine` | Electron Main 连接并随包分发的 Codex Rust App Server；它拥有 Agent Harness、Tool、Skill、Hook、Plugin、MCP、审批和会话恢复 |
| `ts/shared` | 桌面、本地服务和 Gateway 共用的产品契约 |
| `ts/desktop` | 空的 renderer 装配点、Electron Main、preload、sidecar 与发行脚本；新的产品界面将在此重建 |
| `gateway` | 五条 provider 能力泳道、安装身份、用量、容量和 Relay 代理 |
| `relay` | GPT Image 2 / Seedream 持久任务、幂等、结果 blob 与 ack |
| `ts/fixtures/migrations` | 当前支持升级范围内的旧数据样本；只用于证明 reader 与迁移连续性 |
| `docs/重构` | 按用户结果划分的中文大模块建设文档 |

生产服务器的真实进程、端口、路由、环境变量名称和验证结果见 [生产服务器运行文档](./docs/operations/production-servers.md)。

## 本地开发

需要 Bun、Node.js，以及 Electron 所需的本机工具链。

```bash
cd ts
bun install
cd desktop
bun install
bun run electron:dev
```

常用源码检查：

```bash
cd ts
bun run audit:source
bun run check:server
bun run check:desktop
bun run check:electron
```

## 发行

发行阶段必须在源码、迁移、部署和文档收口后执行。macOS arm64 与 Windows x64 分别使用：

```bash
cd ts/desktop
bun run build:macos-arm64
bun run build:windows-x64
```

最终验收必须解包两个平台的产物，审计运行闭包与旧入口，并从真实安装包完成激活、普通任务、三档权限、原生搜索、图片三候选、视频证据编排、语音、计划任务、本机终端、升级、断网、重启和失败恢复。源码搜索或 `electron-builder --dir` 不能替代这一步。
