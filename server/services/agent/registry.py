"""Agent 工具注册表。

工具(Tool) = Agent 可调用的一次能力（查 / 写 / 发）。每个工具声明：
- name + description（描述写清"何时该调我"，是大脑选对工具的关键）
- JSON Schema 入参 parameters
- handler（async 执行体）
- requires_approval（写/花钱/对外类=True，审批闸 P2 据此先弹确认）

handler 签名约定: async def fn(args: dict, ctx: AgentContext) -> Any
"""
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

ToolHandler = Callable[[dict, Any], Awaitable[Any]]


@dataclass
class Tool:
    name: str
    description: str
    parameters: dict
    handler: ToolHandler
    requires_approval: bool = False  # 写/花钱/对外类=True；审批闸据此先弹确认
    # 审批类别（决定"自动批准/信任模式"下哪些可免确认直接执行）：
    #   "file"  本机文件读改——可逆（改前自动备份），信任模式可免确认自动改；
    #   "spend" 花钱/对外（生图/发布/团购）——不可逆/有外部后果，仅"全自动"最高档才免确认。
    approval_class: str = "spend"
    # 审批预览器（可选）：(args, ctx) -> str，给老板看"确认前到底会改什么"的人话 diff
    #   （如 edit_excel 读现值算"B2 32000→38000"）。审批闸据此让前端展示预览，不再"瞎确认"。
    preview: Callable[[dict, Any], str] | None = None
    # 工具自描述行为标记（借鉴 cc-haha 的 Tool.isReadOnly/isDeliverable，让"这是不是成品/能否并发"
    # 跟着工具走、不再靠外部手抄白名单——白名单和工具两处维护必漂移，write_batch 漏登记就是这么来的）：
    #   deliverable 结果是给老板直接拿去用的成品（前端原样渲染成可复制卡片、需并进会话 result 落库）；
    #   read_only   纯查询、无副作用——同一轮里多个只读调用可安全并发执行。
    deliverable: bool = False
    read_only: bool = False
    # 高危不可逆/对外操作（如未来的群发短信、平台发布、删数据）——即使在"全自动托管"(full) 模式也强制弹确认。
    # 借鉴 cc-haha 权限瀑布的 bypass-immune：某些操作的人工确认永不被任何"放行模式"旁路。
    force_confirm: bool = False

    def to_openai_schema(self) -> dict:
        """导出成 DeepSeek/OpenAI 兼容的 tools 数组元素。"""
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters,
            },
        }


class ToolRegistry:
    """工具注册表：注册/查找/导出。可建多个实例（不同场景/权限给不同工具集）。"""

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(self, tool: Tool) -> Tool:
        if tool.name in self._tools:
            raise ValueError(f"工具重复注册: {tool.name}")
        self._tools[tool.name] = tool
        return tool

    def get(self, name: str) -> Tool | None:
        return self._tools.get(name)

    def all(self) -> list[Tool]:
        return list(self._tools.values())

    def names(self) -> list[str]:
        return list(self._tools.keys())

    def deliverable_names(self) -> set[str]:
        """声明了 deliverable=True 的工具名集合——成品落库白名单的单一来源（替代手抄常量）。"""
        return {t.name for t in self._tools.values() if t.deliverable}

    def to_openai_tools(self) -> list[dict]:
        return [t.to_openai_schema() for t in self._tools.values()]


# 全局默认注册表（内置工具登记于此）
default_registry = ToolRegistry()


def tool(
    *,
    name: str,
    description: str,
    parameters: dict | None = None,
    requires_approval: bool = False,
    approval_class: str = "spend",
    deliverable: bool = False,
    read_only: bool = False,
    force_confirm: bool = False,
    registry: ToolRegistry | None = None,
) -> Callable[[ToolHandler], ToolHandler]:
    """装饰器：把一个 async 函数登记为工具。

    用法::

        @tool(name="get_today", description="查今日运营推荐",
              parameters={"type": "object", "properties": {}})
        async def get_today(args, ctx):
            ...
    """
    def deco(fn: ToolHandler) -> ToolHandler:
        (registry or default_registry).register(
            Tool(
                name=name,
                description=description,
                parameters=parameters or {"type": "object", "properties": {}},
                handler=fn,
                requires_approval=requires_approval,
                approval_class=approval_class,
                deliverable=deliverable,
                read_only=read_only,
                force_confirm=force_confirm,
            )
        )
        return fn

    return deco
