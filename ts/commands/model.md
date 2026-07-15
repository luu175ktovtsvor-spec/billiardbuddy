---
name: model
user-invocable: false
description: 说明当前模型连接状态和切换入口
whenToUse: 用户要查看或切换大语言模型、API Key、provider
allowedTools: [run_command]
---
# 模型状态

解释当前模型配置应该通过桌面设置或 `/model` 后端状态接口查看/切换。

如果需要检查本地环境，只做脱敏检查：
- 可以看环境变量键名是否存在，但不要输出 key 值。
- 不要读取 `.env` 文件正文。
- 可以建议用户打开设置抽屉查看当前供应商和模型名。

回答重点：
- 当前 Agent 每一轮都会读取 active provider；切换后下一轮应立即生效。
- 没有 active provider 时会回退到环境变量或 bundled 配置。
- 如果模型不可用，让用户先测试连接，再跑 `/doctor`。
