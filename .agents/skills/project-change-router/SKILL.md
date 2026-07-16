---
name: project-change-router
description: Route every code change in this repository to the owning module and the correct engineering workflow before editing. Use for feature work, bug fixes, refactors, frontend/backend changes, API or event changes, Electron IPC, gateway/relay/dataeye changes, and any request that may affect more than one layer.
---

# 项目改动总路由

在改任何代码前先完成分类和影响面说明。不要把“前后端不能联动”当目标；把必要联动识别为契约或全栈变更，把不必要联动隔离在模块内部。

## 必读顺序

1. 读取仓库根 `CLAUDE.md`、适用范围内最近的 `AGENTS.md`，以及它们指向的当前架构文档。
2. 读取 [references/project-module-map.md](references/project-module-map.md)，确定唯一主责模块。
3. 读取 [references/change-classes.md](references/change-classes.md)，判定改动类别。
4. 使用 [references/change-brief.md](references/change-brief.md) 在动手前输出精简的“改动说明”。
5. 读取并执行一个主单项 Skill；必要时叠加共享契约或跨服务 Skill。

需要快速搜影响面时运行：

```bash
node .agents/skills/project-change-router/scripts/inspect-change-surface.mjs <关键词或符号> [...更多关键词]
```

## 路由规则

- 需求或根因未定位：执行 `../analyze-change-impact/SKILL.md`。
- 只改 React 展示、交互或前端本地状态：执行 `../change-frontend-module/SKILL.md`。
- 保持外部协议不变的后端实现：执行 `../change-backend-module/SKILL.md`。
- 改 REST、SSE、WS、IPC 的路径、字段、事件、状态码或错误结构：执行 `../change-shared-contract/SKILL.md`。
- 新功能纵向跨越契约、后端和前端：执行 `../deliver-fullstack-feature/SKILL.md`。
- 改桌面端与 `gateway/`、`relay/`、`dataeye/` 之间的协议：执行 `../change-cross-service-api/SKILL.md`。
- 只调整目录、依赖方向或拆巨型文件且必须保持行为：执行 `../refactor-module-boundaries/SKILL.md`。
- 新功能、回归修复、契约或重构需要选择测试证据：叠加 `../design-test-strategy/SKILL.md`。
- 涉及文件、命令、权限、IPC、密钥、远程调用、扩展或更新：叠加 `../audit-security-boundaries/SKILL.md`。
- 需要后端真实 Agent 链路：执行 `../verify-backend-e2e/SKILL.md`；需要 Electron 用户路径：执行 `../verify-desktop-runtime/SKILL.md`。
- 改版本、打包、打 tag 或交付安装包：执行 `../release-desktop-safely/SKILL.md`。
- 改 AI 开发规则、工程 Skill、质量门或 CI 治理：执行 `../maintain-project-skills/SKILL.md`。
- 新增/删除/改名模块，或改变连接、部署、验证流程：同次执行 `../maintain-project-skills/SKILL.md`。
- 完成实现后：执行 `../verify-modular-change/SKILL.md`。

纯文档任务不强行套代码类别：深度审计使用 `../audit-project-documents/SKILL.md`，明确候选的快速清理使用 `../clean-project-documents/SKILL.md`。若文档随代码改动更新，仍以代码主责模块和主 Skill 为准。

一个任务可有一个主类别和附加类别。例如“新增生图任务状态字段”是 `FULLSTACK + CONTRACT + CROSS-SERVICE`，主责模块仍只能有一个。

## 开工硬闸

未回答以下问题，不编辑文件：

1. 用户可观察行为是什么？
2. 唯一主责模块是什么？
3. 数据由谁生产、经什么传输、被谁消费、落到哪里？
4. 是否改变共享契约或远程协议？
5. 哪些文件预计修改，哪些相邻模块明确不改？
6. 用什么测试证明两端接通且没有破坏兼容性？
7. 是否跨越安全、部署或发布边界？失败后如何回滚？

## 项目专属边界

- 先判 A 线 Agent 循环还是 B 线确定性产品功能；不要创建第三套“衔接层”。
- 保持本地内核的 JSONL/JSON 文件存储，不引入 SQL。
- 不在 React 组件里拼路由或解释原始响应；通过功能 API 和 store 入口归一化。
- WS/SSE 事件契约落 `ts/src/server/ws/events.ts`,跨层 REST 契约由 `ts/src/server/api` 对应 handler 定义并在边界解析;同一契约只留一处、消费者导入,禁止新增手写镜像。
- 不继续向 `ts/src/server/index.ts` 堆独立业务逻辑；新增路由优先进入责任模块。
- 本地 renderer 与 sidecar 同包发布，可原子改契约；远程服务必须向后兼容并按服务器先、客户端后发布。
- 保留工作树中用户已有改动；禁止借模块化之名扩大重构范围。
- 模块边界变化时立即维护工程 Skill；模块内部普通实现不改 Skill，避免把短期细节固化。

## 收工条件

只有在契约、实现、消费者、测试、运行验证和必要文档全部闭环，且 `bash scripts/quality_gate.sh` 通过后才宣布完成。最终回复列出主责模块、实际改动、验证证据和剩余风险。
