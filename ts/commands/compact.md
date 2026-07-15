---
name: compact
user-invocable: false
description: 总结当前会话，给长会话归档和继续工作的摘要
whenToUse: 用户输入 /compact、要求压缩上下文、准备继续长任务
allowedTools: [file_history, list_background_tasks]
---
# 压缩会话

把当前会话压成一份“继续工作摘要”，方便后续接着做。

摘要必须包含：
- 用户最终目标。
- 已完成的关键改动或产出。
- 未完成事项。
- 重要文件路径、命令、接口、测试结果。
- 风险和下一步建议。

如果有文件改动历史或后台任务，先调用工具读取，再合并进摘要。

不要输出无关聊天内容。不要说你真的删掉了历史；这里只生成可继续工作的摘要。
