---
name: doctor
description: 检查本机 Agent 运行环境、模型配置、工具和扩展状态
whenToUse: 用户怀疑模型、工具、MCP、工作区或环境异常
allowedTools: [run_command, list_dir, list_commands, list_skills, list_background_tasks]
---
# 本机诊断

做一次只读诊断，目标是判断“当前 Agent 壳子能不能稳定跑任务”。

优先检查：
- 当前工作目录和可见文件。
- Git 状态是否有大量未提交改动。
- Bun/Node 运行时是否可用。
- 可用 slash 命令、技能和后台任务。
- 如果用户提到 MCP、插件、媒体后端或打包，再按问题补查。

可用只读命令示例：
- `pwd`
- `git status --short`
- `bun --version`
- `node --version`

输出格式：
- 先给结论：正常 / 有风险 / 需要用户配置。
- 再列问题和影响。
- 最后给可以直接执行的修复建议。

不要读取或展示 `.env`、密钥、token、证书内容。
