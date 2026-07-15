---
name: context
user-invocable: false
description: 查看当前会话上下文、工作区和长会话风险
whenToUse: 用户询问上下文、当前会话、记不记得前面、要不要新会话
allowedTools: [list_dir, file_history, list_background_tasks]
---
# 会话上下文

说明当前会话的可见上下文：
- 当前工作目录。
- 最近任务、后台任务、文件修改历史。
- 用户选择的目标、工作台领域、输出风格如果在系统上下文里出现，也要简短说明。

如果会话很长，要建议：
- 重要结论先落成文件或技能。
- 可用 `/compact` 做摘要归档。
- 新任务跨度太大时开新会话更稳。

不要假装知道未被提供或未被工具读取的历史细节。
