"""Agent 工具注册表。

工具(Tool) = Agent 可调用的一次能力（查 / 写 / 发）。每个工具声明：
- name + description（描述写清"何时该调我"，是大脑选对工具的关键）
- JSON Schema 入参 parameters
- handler（async 执行体）
- requires_approval（对外/不可逆/写入类=True：发布到平台、群发客户、删数据等，审批闸 P2 据此先弹确认，
  防自动对外/账号被封——这是安全闸，不是"花钱"闸。做海报/写内容这类只产成品给老板看的不属此列）

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
    requires_approval: bool = False  # 对外/不可逆/写入类=True（发布/群发/删数据）；审批闸据此先弹安全确认
    # 审批类别（决定"自动批准/信任模式"下哪些可免确认直接执行）：
    #   "file"  本机文件读改——可逆（改前自动备份），信任模式可免确认自动改；
    #   "spend" 对外/不可逆动作（未来的平台发布、群发客户、删数据）——有外部后果/不可撤回，仅"全自动"最高档才免确认。
    #           （类别名沿用历史 "spend"，但定性是"对外/不可逆安全闸"，不再因为"花钱/生图"而弹确认。）
    approval_class: str = "spend"
    # 审批预览器（可选）：(args, ctx) -> str，给老板看"确认前到底会改什么"的人话 diff
    #   （如 edit_excel 读现值算"B2 32000→38000"）。审批闸据此让前端展示预览，不再"瞎确认"。
    preview: Callable[[dict, Any], str] | None = None
    # SH-8 审批理由生成器（可选）：(args, ctx) -> dict，产出结构化的「为什么要你确认」——
    #   {what: 这步要做什么, why: 为什么需要你点头, impact: 会有什么影响(改哪个文件/可否回滚)}。
    #   不给则 loop 据工具元信息(approval_class/名字/args)自动拼一份兜底理由，审批卡总有话说、不再干巴巴。
    approval_reason: Callable[[dict, Any], dict] | None = None
    # 工具自描述行为标记（借鉴 cc-haha 的 Tool.isReadOnly/isDeliverable，让"这是不是成品/能否并发"
    # 跟着工具走、不再靠外部手抄白名单——白名单和工具两处维护必漂移，write_batch 漏登记就是这么来的）：
    #   deliverable 结果是给老板直接拿去用的成品（前端原样渲染成可复制卡片、需并进会话 result 落库）；
    #   read_only   纯查询、无副作用——同一轮里多个只读调用可安全并发执行。
    deliverable: bool = False
    read_only: bool = False
    # F-7 复审修复（Critical 竞态）：read_only=True（无副作用、可安全重复查）不等于"可以被 asyncio.gather
    #   并发跑"——get_today_recommendation/recall_my_content 这类工具虽 read_only=True，但 handler 内部
    #   `await ctx.db.execute(...)`（AsyncSession），而 AsyncSession 不允许被多个协程并发操作（会抛
    #   `InvalidRequestError: This session is provisioning a new connection; concurrent operations are
    #   not permitted`，真实用 sqlite+aiosqlite 复现 100% 必炸，不是理论风险）。故并发分组判据
    #   （loop.py:_group_plans_for_concurrency）从 read_only 改成这个新增、默认 False 的显式白名单字段——
    #   fail-safe：只有逐个审计确认"纯网络/纯内存查询、不碰 ctx.db/ctx 共享可变状态、不碰其它外部有状态
    #   资源"的工具才手动标 True（现为 get_current_date/find_scenario/look_up_knowledge/read_knowledge/
    #   web_search）；其余一律保持默认 False（含所有碰 db 的 read_only 工具、run_subagent——它与外层共享
    #   同一个 ctx.db、读写边界不透明，永远不能标 True——以及任何未来新增/未经审计的工具）。
    #   与 read_only 各司其职、互不影响，别混用；不进 to_openai_schema（纯后端分组用字段，不发给模型）。
    concurrent_safe: bool = False
    # 高危不可逆/对外操作（如未来的群发短信、平台发布、删数据）——即使在"全自动托管"(full) 模式也强制弹安全确认。
    # 借鉴 cc-haha 权限瀑布的 bypass-immune：某些操作的人工确认永不被任何"放行模式"旁路。
    force_confirm: bool = False
    # 提问工具（AskUserQuestion，借鉴 cc-haha）：循环里不执行，改吐 ask_question 事件让前端渲染选项卡片，
    # 老板点选后把选择作为下一条消息发回。问题与选项由模型填进 args（question/options）。
    is_question: bool = False
    # SH-3 工具结果落盘阈值（单位：字符）：超阈值且非成品/非自读类 → 落盘 tool-results/，回灌路径+预览。
    #   None = 用全局默认 _MAX_TOOL_RESULT_CHARS；给 read 类自读工具设很大值/特判可避免"读出来又落盘读不回"。
    max_result_chars: int | None = None
    # G.1/E.3.7 工具调用统一超时兜底（秒）：循环执行该工具时外层包 asyncio.wait_for。
    #   防"不自带超时的工具（网络抓取 / DB / 将来的视频生图）挂死 → 无限期卡住整个请求、SSE 流挂住、
    #   max_turns 也救不了（到不了下一轮）"。None = 用全局默认 _DEFAULT_TOOL_TIMEOUT；
    #   <=0 = 不设兜底（极少数确需无限期跑的流式工具）。run_command/MCP 自带超时，被这层更宽的兜底罩着不受影响。
    timeout: float | None = None
    # M5b 动态审批钩子：(args, ctx) -> bool。部分调用才需审批的工具（如 read_file 读敏感文件）用此替代静态 requires_approval=True。
    requires_approval_for: Callable[[dict, Any], bool] | None = None
    # 审批闸 2.0 · ①"撞墙才问"的命令类判据：(args, ctx) -> str | None。命中返回【人话拒绝原因】，
    #   命中即在 _plan_tool_call 里直接拒绝（plan.error，不进入审批卡、不执行 handler）——用于命中
    #   即永不允许执行的判据（如 run_command 的危险黑名单），别让老板在 ask/auto_files 档看一张
    #   "确认执行"卡、点了也没用（handler 内部还会再拒一次），也别让 full 档"自动放行→执行时才失败"。
    #   None（默认）= 不做此类预判，走既有 requires_approval/审批闸流程。
    fatal_reason_for: Callable[[dict, Any], str | None] | None = None
    # 审批闸 2.0 · ③ Roo 式安全前缀白名单：(args, ctx) -> bool。命中 True 时【任何权限档】（含 ask）
    #   都可自动放行、不弹审批卡——只用于登记过的、明确无副作用的只读命令前缀（如 ls/cat/pwd/git status），
    #   由工具自身在判据里先复核一遍危险黑名单，双保险。None（默认）= 不启用此豁免。
    safe_prefix_for: Callable[[dict, Any], bool] | None = None

    def to_openai_schema(self) -> dict:
        """导出成 DeepSeek/OpenAI 兼容的 tools 数组元素。

        审批闸 2.0 · ②（OpenHands 式）：无条件给每个工具的 parameters 追加一个可选 `security_risk`
        自评字段——"无条件"是关键：所有工具一视同仁地加，不按条件开关，否则不同请求间 tools 前缀字节
        不一致会打穿 prompt-cache（F8 铁律，见 docs/耦合地图与改动检查清单.md「prompt-cache 前缀稳定纪律」）。

        F4 Focus Chain（抄 Cline）：同样无条件追加一个可选 `task_progress` 自评字段——模型顺手在
        任意工具调用里贴一份 markdown 复选清单，loop.py 摘出来更新进度状态、渲染成前端常驻的清单卡。
        与 security_risk 并存、互不覆盖（两个属性分开写进 properties，见下方两行）；同样"无条件"，
        理由与 security_risk 一致——按条件开关会打穿 prompt-cache 前缀。

        每次都返回【新 dict】（不就地改 self.parameters）——工具对象在多个 ToolRegistry 间共享，
        原地改会污染其它持有同一 Tool 实例的注册表。"""
        params = dict(self.parameters or {})
        props = dict(params.get("properties") or {})
        props["security_risk"] = _SECURITY_RISK_SCHEMA_PROPERTY
        props["task_progress"] = _TASK_PROGRESS_SCHEMA_PROPERTY
        params["properties"] = props
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": params,
            },
        }


# 审批闸 2.0 · ② 模型自评风险的 schema 片段（单独提出来，供 to_openai_schema 复用、避免每次重建字面量）。
# 只读、可选——模型不填不受影响；系统侧只信任它"加严"（high 时可能新增审批），绝不因它说 low 就放松
# 既有 requires_approval（见 loop.py `_pop_security_risk` / `_plan_tool_call` 的用法与注释）。
_SECURITY_RISK_SCHEMA_PROPERTY: dict = {
    "type": "string",
    "enum": ["low", "medium", "high"],
    "description": (
        "可选：你对本次调用风险的自评。low=常规只读/无副作用；medium=一般写入/有限影响；"
        "high=有较大副作用或不可逆风险（如可能涉及删除、外传数据、危险系统命令等）。"
        "仅供系统参考决定要不要额外找人确认，不替你做最终决定；拿不准可以不填。"
    ),
}

# F4 Focus Chain 的 schema 片段（单独提出来，供 to_openai_schema 复用）。只读、可选——不填不受影响；
# 只在处理多步骤任务时才有意义，一步到位的简单调用不需要。
_TASK_PROGRESS_SCHEMA_PROPERTY: dict = {
    "type": "string",
    "description": (
        "可选：如果当前是个需要好几步才能做完的任务，把最新的 markdown 复选清单贴这，顺手更新进度，"
        "如 `- [x] 已做\n- [ ] 待做`。方便老板看到你做到哪了，也帮你自己别跑偏；"
        "一步到位的简单任务不用管这个参数。"
    ),
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
    concurrent_safe: bool = False,
    force_confirm: bool = False,
    is_question: bool = False,
    max_result_chars: int | None = None,
    timeout: float | None = None,
    approval_reason: Callable[[dict, Any], dict] | None = None,
    requires_approval_for: Callable[[dict, Any], bool] | None = None,
    fatal_reason_for: Callable[[dict, Any], str | None] | None = None,
    safe_prefix_for: Callable[[dict, Any], bool] | None = None,
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
                concurrent_safe=concurrent_safe,
                force_confirm=force_confirm,
                is_question=is_question,
                max_result_chars=max_result_chars,
                timeout=timeout,
                approval_reason=approval_reason,
                requires_approval_for=requires_approval_for,
                fatal_reason_for=fatal_reason_for,
                safe_prefix_for=safe_prefix_for,
            )
        )
        return fn

    return deco


# ══════════════════════════════════════════════════════════════════════════
# 通用 Agent 化 · 工具集分层
#   默认（通用模式）= 通用工具（文件/命令/上网/清单/子代理/生图/看日期/问选项）。
#   @「台球行业知识库」(billiards_mode) = 通用 + 台球专用工具（写文案/海报/诊断/约客/玩法/平台/团购…）。
# 不删台球工具——它们仍登记在 default_registry，只是默认不挂、@ 台球时才进工具集（台球业务后面再接）。
# ══════════════════════════════════════════════════════════════════════════

# 台球行业专用工具名（通用模式下不暴露给模型；@ 台球知识库时才加进来）。
# 注：recall_my_content（翻你以前写的）M1 已移出 → 通用模式也能用（让通用助手能回看自己过往产出，是长期记忆的一部分）。
BILLIARDS_TOOL_NAMES: set[str] = {
    "get_today_recommendation", "find_scenario", "look_up_knowledge", "read_knowledge",
    "write_operation_content", "write_batch", "plan_activity", "assistant_outreach",
    "diagnose_operation", "recommend_games", "make_poster", "make_platform_content",
    "make_groupbuy_content", "diagnose_from_pos",
}


def general_registry() -> "ToolRegistry":
    """通用 Agent 默认工具集 = default_registry 减去台球专用工具。
    每次调用现建一个临时 ToolRegistry（工具对象共享、不复制 handler），开销可忽略。"""
    reg = ToolRegistry()
    for t in default_registry.all():
        if t.name in BILLIARDS_TOOL_NAMES:
            continue
        reg.register(t)
    return reg


def billiards_registry() -> "ToolRegistry":
    """@ 台球知识库时的工具集 = 全部（通用 + 台球）。建临时表（不复用全局 default_registry——
    否则上层往里加 MCP 等动态工具会污染全局、下次请求重复注册报错）。"""
    reg = ToolRegistry()
    for t in default_registry.all():
        reg.register(t)
    return reg
