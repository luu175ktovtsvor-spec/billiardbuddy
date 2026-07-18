# BilliardBuddy Agent Runtime

本目录包含 BilliardBuddy 的 Coding Agent 内核、本地服务、CLI、共享契约和 Electron 桌面应用。

## 主要能力

- 会话与模型工具循环、子代理、后台任务和 worktree。
- 文件、命令、编辑和搜索工具；人工 Browser/Preview 已接线。Agent 浏览器自动化当前只有 feature-gated stub，Computer Use 仍依赖 Python、系统权限和安装包真机验收。
- Skills、Plugins、MCP、Hooks、权限、计划模式和上下文管理。
- REST、WebSocket、Provider Proxy、工作区、Diff 和终端。
- CLI 与 Electron GUI 两种运行入口。

球房业务能力位于产品外层、Skill、渐进式知识资源和专业工作台，不修改 Agent 核心循环。当前已内置媒体、招聘和五个球房运营 Skill；它们描述业务目标与完成证据，由 Agent 根据现场能力选择连接器、浏览器、脚本、代码或工作台。当前产品范围与完成状态见仓库根目录的 `BilliardBuddy-当前重构任务.md`。

## 从源码运行

```bash
bun install
bun run start
```

桌面开发：

```bash
cd desktop
bun install
bun run dev
```

Electron 开发：

```bash
cd desktop
bun run electron:dev
```

## 聚焦验证

```bash
bun run check:server
cd desktop && bun run test -- --run
cd desktop && bun run lint
```

模型、凭据、网络和服务器部署以仓库根目录 `docs/` 中的现行文档为准。
