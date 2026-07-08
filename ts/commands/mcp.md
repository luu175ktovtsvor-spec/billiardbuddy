---
name: mcp
description: 检查外接 MCP 工具能力和使用方式
whenToUse: 用户询问 MCP、外接工具、资源、prompts、第三方工具
allowedTools: [list_mcp_resources, read_mcp_resource, list_mcp_prompts, read_mcp_prompt]
---
# MCP 外接工具

如果当前工具池里有 MCP resource/prompt 工具，先列出可用资源或 prompt。

说明：
- MCP 工具会和内置工具一样走权限闸。
- 需要用户补充信息的 MCP 请求，会弹问题卡。
- 对外访问、破坏性或不确定动作不要静默执行。

如果当前没有 MCP 工具，告诉用户需要先配置 `.mcp.json` 或在设置里添加外接工具。
