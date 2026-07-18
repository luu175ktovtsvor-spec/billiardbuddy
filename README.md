# BilliardBuddy

BilliardBuddy 是面向球房经营者的桌面 Agent。产品保留完整 Coding Agent 的工具执行、子代理、Skills、Plugins、MCP、权限、工作区和终端，并在其外层提供普通用户可理解的桌面交互、产品网关和球房业务能力。

人工 Browser/Preview、Agent 网页执行和 Computer Use 是不同能力。人工 Browser/Preview 属于桌面工作区；Agent 会根据当前真实可用的连接器、浏览器、MCP、脚本、代码和工具选择执行方式，不把 Playwright 或任何固定实现写死成产品逻辑。产品已内置媒体、招聘和五个球房运营 Skill，并让台球知识按任务渐进读取；旧 BOSS 固定评分和机械自动跟进不再迁移。

## 代码结构

| 路径 | 职责 |
|---|---|
| `ts/src` | Agent 内核、CLI、本地服务、工具与扩展机制 |
| `ts/desktop` | React renderer、Electron 桌面宿主和本地 sidecar 打包 |
| `ts/shared` | 桌面与本地服务共享契约 |
| `gateway` | 模型、视觉和 Fun-ASR 网关 |
| `relay` | 图片生成与编辑异步中转 |
| `docs` | 当前架构、网关、服务器和设计边界 |

## 本地开发

```bash
cd ts
bun install
bun run start
```

桌面 renderer：

```bash
cd ts/desktop
bun install
bun run dev
```

Electron 桌面运行：

```bash
cd ts/desktop
bun run electron:dev
```

## 文档

- [当前重构任务](./BilliardBuddy-当前重构任务.md)
- [当前架构与状态](./docs/当前架构与状态-总览.md)
- [网关多模型与 Agent 内核接轨](./docs/网关多模型与Agent内核接轨.md)
- [服务器与部署](./docs/服务器与部署-当前拓扑.md)
- [文档导航](./docs/README.md)

具体能力、命令和完成度以当前源码、测试及实际运行结果为准。
