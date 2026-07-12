---
name: change-frontend-module
description: Implement React renderer changes within a feature boundary, separating components, state, API adapters, normalization, and desktop host access. Use for pages, components, Zustand stores, frontend workflows, loading/error states, local preferences, and UI-only behavior that preserves backend contracts.
---

# 前端模块开发

先确定所属 `features` 功能域，再修改页面。若请求或响应契约变化，切换到共享契约 Skill；不要在前端伪造后端能力。

## 分层责任

- `components`：渲染和用户交互，不拼 API 路径，不解释原始 JSON。
- `store`：业务状态和动作；纯事件转换优先拆成可测试 reducer。
- `api`：路径、method、Schema 解析、超时和错误映射。
- `lib/desktopHost`：Electron 能力的唯一 renderer 入口。
- `localStorage`：只保存换机器丢失也可接受的偏好；业务事实以后端为真相源。

## 执行流程

1. 追踪现有页面、store、API、类型和后端契约。
2. 把状态分为服务器状态、会话业务状态、临时 UI 状态和持久偏好，避免重复真相源。
3. 复用同功能域 API 与组件；不要把新调用散落到页面或通用组件。
4. 实现成功、加载、空数据、失败、重试、取消/中断和组件未就绪状态。
5. 为 reducer、归一化和关键交互补测试；涉及界面时做真实浏览器/Electron 验证。

## 项目约束

- 遵守根 `CLAUDE.md` 的 Codex UI 设计口径和白标规则。
- A 线对话走统一 WS；B 线慢任务走 REST submit/poll 或事件进度；OS 能力走 IPC。
- 不直接扩大 `chatStore.ts`；新增事件逻辑优先提取纯 reducer。
- 保证所有按钮有真实动作或明确不可用状态，禁止静默假按钮。
