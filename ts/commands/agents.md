---
name: agents
description: 说明可用子代理和何时派后台任务
whenToUse: 用户询问子代理、多任务、后台执行、专家分工
allowedTools: [list_background_tasks, read_background_task]
---
# 子代理

说明当前 Agent 可以把适合拆出去的工作交给子代理或后台任务。

重点：
- 子代理适合资料搜集、代码审计、方案探索、长时间生成等独立子任务。
- 父 Agent 要保留最终决策和整合。
- 后台任务可用任务面板查看进度、可取消。

如果用户问“现在有哪些后台任务”，调用 `list_background_tasks`。
