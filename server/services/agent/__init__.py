"""Agent 编排层：工具注册表、运行时上下文、ReAct 循环（陆续补齐）。

注意：本包不在 __init__ 里自动导入 tools，避免隐式注册副作用；
需要内置工具时由调用方显式 `import services.agent.tools`（或经 bootstrap）触发登记。
"""
from services.agent.context import AgentContext
from services.agent.registry import Tool, ToolRegistry, default_registry, tool

__all__ = ["AgentContext", "Tool", "ToolRegistry", "tool", "default_registry"]
