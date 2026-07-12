---
name: maintain-project-skills
description: Keep this repository's engineering Skill suite synchronized with current code and architecture. Use in the same task whenever a module is added, removed, renamed, split, or merged; a connection or deployment boundary changes; verification commands change; or repeated development work reveals a missing or stale workflow. Do not trigger for ordinary implementation details that leave module boundaries unchanged.
---

# 维护工程 Skill

代码和真实运行行为是最终事实。Skill 负责指导工作，不得反过来强迫代码符合过时地图。

## 什么时候立即更新

- 新增、删除、改名、拆分或合并责任模块。
- 改变 REST、WS、SSE、IPC、job 或跨服务连接方式。
- 改变桌面、gateway、relay、dataeye 的部署或兼容边界。
- 改变构建、测试、E2E、发布或回滚命令。
- 同一类问题重复出现，现有单项 Skill 没有覆盖。
- Skill 描述、路径、示例或模块地图与当前代码冲突。

普通组件实现、模块内部算法、文案样式和不改变边界的 Bug 修复不更新 Skill。

## 维护流程

1. 从源码、测试、清单和当前部署配置核实真实结构，不采信旧文档的“已完成”声明。
2. 更新 `../project-change-router/references/project-module-map.md` 的责任、路径和依赖方向。
3. 只有路由判据变化时才更新总路由或单项 Skill；不要把临时实现细节塞进 Skill。
4. 若新增一种稳定且反复使用的工作流，再创建独立 Skill，并同时提供中文 Claude 入口和中文 Codex UI 元数据。
5. 更新根 `AGENTS.md`、`CLAUDE.md` 仅限持久规则确实变化；避免重复同一正文。
6. 运行所有 `.agents/skills/*` 的 `quick_validate.py`，再验证 `.claude/skills` 能被项目加载器发现。
7. 运行 `bun scripts/quality/validate-skills.ts`，确认每个权威 Skill 都有中文 UI 元数据和 Claude 中文入口。
8. 报告更新原因、受影响 Skill 和未改变的模块。

## 实时性的准确含义

- Skill 文件保存后，下一次调用会读取磁盘最新版。
- 新开的 Codex/Claude 任务最可靠；已经加载过 Skill 的进行中任务可能保留旧上下文。
- 不依赖后台定时器自动改 Skill；把维护动作绑定到架构变化的同一次代码任务，避免延迟和误改。
