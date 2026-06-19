"""ReAct Agent 循环（同步 + 流式两个入口，共享同一套状态机逻辑）。

模型 →（产出思考/工具调用）→ 执行工具 → 把结果作 role:tool 消息回灌 → 再调模型，
直到模型不再要求调工具（收敛到最终答复）或达到 max_turns 兜底。

架构（2026-06-19 对照成熟 Agent 实现重构）：
- 一轮 = 调模型 → 若有 tool_calls 则逐个先经 `_plan_tool_call` 判定（审批闸 or 直接执行）、
  结果作 role:tool 回灌 → 否则收敛为最终答复。
- 同步版 `run_agent_loop` 与流式版 `run_agent_loop_stream` 只在两点上分叉：①怎么调模型
  （generate 整包 vs generate_stream 逐片）②怎么对外吐（AgentStep 列表 vs SSE event）。
  **真正重复、最易"改一处漏另一处"的逻辑——入参解析 + 审批闸判定 + 消息初始化——统一收进
  `_plan_tool_call` / `_init_messages`，单点维护。**
- 每条退出路径有命名原因（`_STOP_FINAL` / `_STOP_MAX_TURNS`），便于落库标注与测试断言。

设计取舍：
- 工具执行失败（不存在 / 抛异常 / 入参非法）不崩循环，而是把错误文本作为工具结果回灌，
  让模型自行决定补救——这是 agentic 系统稳健性的关键。
- steps 记录每一步（thinking / tool_call / tool_result / approval_request / final），供 SSE 流式展示与测试断言。
- 默认用编排大脑 provider + 编排模型（可与内容生成分离，见 settings.effective_orchestration_*）。
"""
import json
import logging
import os
from dataclasses import dataclass, field

from config import settings
from services.agent.approval import sign_approval
from services.agent.context import AgentContext
from services.agent.hooks import run_post_tool_hooks, run_pre_tool_hooks, run_stop_hooks
from services.agent.message_repair import ensure_tool_pairing
from services.agent.registry import ToolRegistry
from services.ai.base import TextProvider, TextRequest
from services.ai.factory import ProviderFactory

logger = logging.getLogger(__name__)

# 编排（选工具/规划）用低温度：实测 0.7（TextRequest 默认）下 DeepSeek 会"有时兴起自己聊、
# 不调工具"，导致该写文案/推玩法的需求被直接闲聊掉。工具选择要的是稳定可复现，不是创意——
# 故循环统一压到 0.3。真正要创意的内容生成在各工具内部走 run_generation（自带 0.7），不受此影响。
_ORCH_TEMPERATURE = 0.3

# 审批闸（proposal 模式）：requires_approval 的工具不在循环里执行，
# 改提请用户确认；这条作为工具结果回灌给模型，让它把方案讲给用户、不要假装已完成。
_APPROVAL_PENDING_MSG = (
    "[待用户确认] 已请求执行「{name}」，需用户确认后才会真正执行。"
    "请用一两句话把你打算做的事告诉用户、并请他确认，不要假装已经做完或已生成。"
)

# 提问工具（AskUserQuestion）：选项已展示给用户、等他点选，回灌提示让模型简短提示、别替他选。
_QUESTION_PENDING_MSG = (
    "[等用户选择] 已把选项展示给用户、等他点选。用一句话提示他从中选一个即可，"
    "不要替他选、也不要假装他已经选了。"
)

# 达到 max_turns 仍未收敛时，强制模型基于已有结果给一段最终答复（不再给工具），
# 避免直接返回空答复让用户看到"AI 没反应"。
_FORCE_FINAL_MSG = "请基于上面已有的工具结果，直接用一段话给用户最终答复，不要再调用任何工具。"
# 强制收尾仍拿不到内容时的静态兜底（极端情况）。
_FALLBACK_FINAL = "这个需求我拆了好几步还没完全收尾。你可以把要求说得更具体一点，或者分两次让我来做。"

# 循环退出原因（命名常量，值保持稳定——落库/前端/测试据此判断；不要随意改字面值）。
_STOP_FINAL = "final"          # 模型不再调工具，收敛到最终答复
_STOP_MAX_TURNS = "max_turns"  # 达到 max_turns 兜底强制收尾

# 单个工具结果回灌给模型的字符上限（借鉴 cc-haha maxResultSizeChars）：超出则截断 + 提示，
# 护住上下文窗口与 BYOK token 成本。只作用于"喂回模型推理"的查询/读取类结果；成品不截断。
_MAX_TOOL_RESULT_CHARS = 12000

# microcompact（借鉴 cc-haha microCompact）：循环内把【旧的只读工具结果】内容换成占位符（保留最近 N 条原文），
# 省上下文 token、零 LLM。只动可重查的只读结果、按 tool_call_id 定位、不改消息结构（保 prompt cache 前缀稳定）。
_MICROCOMPACT_KEEP = 4
_CLEARED_RESULT_MARK = "[旧的查询结果已清理以省上下文；需要可重新查]"

# 防打转（anti-spin）：同一工具 + 完全相同参数最多放行几次；再多结果也不会变（是在空转），拦下逼模型换思路。
_MAX_SAME_CALL = 3

# SH-4 截断恢复：模型一轮输出被 max_tokens 砍断时 finish_reason="length"（不是正常 "stop"）。
# 收尾分支识别它 → 把已输出的半句 append 回去 + 提示"接着写完"再要一轮，多轮片段拼成完整 final，
# 用户不再看到被砍断的半句。_MAX_CONTINUATIONS 是续写次数上限，防"一直被截一直续"死循环（呼应 max_turns 兜底哲学）。
_LENGTH_FINISH = "length"
_MAX_CONTINUATIONS = 3
# 续写提示：让模型从断点接着写，别重头来也别重复已写的部分。
_CONTINUE_MSG = "你上一段被长度限制截断了，没写完。请从断掉的地方接着写完，不要重复前面已经写过的内容，也不要加开场白。"

# ── SH-2 token 预算递减早停 ──
# "换参数空转、发散打转不收尾"是真实风险（anti-spin 只挡同参重复，挡不住这个）。
# 给一次 Agent 任务设 token 预算：到 90% 或连续多轮增量极小（diminishing=在空转）就停/推动收尾。
# token_budget=None（默认交互式）整段跳过，对现有对话行为零影响。
_BUDGET_STOP_RATIO = 0.9        # 累计消耗到预算 90% → 停（强制收尾，别再发散）
_BUDGET_PUSH_RATIO = 0.5        # 过半才开始下推动语（前期别打扰）
_BUDGET_DIMINISH_DELTA = 500    # 单轮增量低于此阈值算"几乎没产出新东西"
_BUDGET_DIMINISH_TURNS = 3      # 连续这么多轮增量都极小 → 判定 diminishing（在空转）→ 停
# 还有预算时的推动语：催它收口、别没完没了地调工具发散（中性措辞，不提 token/预算）。
_BUDGET_PUSH_MSG = "请抓紧基于已有结果给老板最终答复，别再发散调工具了。"

# _check_budget 返回值：三态。
_BUDGET_OK = "ok"        # 预算未触线 → 正常走收尾分支（含 Stop hook）
_BUDGET_PUSH = "push"    # 还有预算但已过半且本轮有产出 → 回灌推动语、让它收口
_BUDGET_STOP = "stop"    # 到 90% 或 diminishing → 强制停（优先级高于 Stop hook，不让 hook 拉回空转）


def _accumulate_usage(ctx, resp_tokens: int, fallback_text: str) -> None:
    """把本轮 provider usage 累加进 ctx.tokens_used，并更新 last_total/last_delta + diminishing 计数。
    端点没返回（resp_tokens<=0）则按 len//4 粗估。token_budget=None 也照常累加（顺带喂成本看板，零行为影响）。
    diminishing 判定靠 budget_continuations 当"连续低增量轮"计数：本轮 delta 极小则 +1、否则归零。"""
    if ctx is None:
        return
    delta = resp_tokens if (resp_tokens and resp_tokens > 0) else (len(fallback_text or "") // 4)
    ctx.last_total = ctx.tokens_used
    ctx.tokens_used += delta
    ctx.last_delta = delta
    # 连续低增量轮计数（diminishing/空转检测）：低于阈值累加、否则清零
    if delta < _BUDGET_DIMINISH_DELTA:
        ctx.budget_continuations = getattr(ctx, "budget_continuations", 0) + 1
    else:
        ctx.budget_continuations = 0


def _check_budget(ctx) -> str:
    """SH-2 预算判定（三态 ok/push/stop）。token_budget=None → 恒 ok（交互式零影响）。
    - 到 90% 预算 → stop（强制收尾，优先级高于 Stop hook）；
    - 连续 _BUDGET_DIMINISH_TURNS 轮增量都 < 阈值（在空转）→ stop；
    - 还有预算、已过半且本轮有产出（delta>=阈值）→ push（回灌推动语催收口）；
    - 否则 ok。"""
    if ctx is None or getattr(ctx, "token_budget", None) is None:
        return _BUDGET_OK
    budget = ctx.token_budget
    if budget <= 0:
        return _BUDGET_OK
    used = getattr(ctx, "tokens_used", 0)
    delta = getattr(ctx, "last_delta", 0)
    # 到 90% → 停
    if used >= budget * _BUDGET_STOP_RATIO:
        return _BUDGET_STOP
    # 连续多轮增量极小（diminishing/空转）→ 停
    if getattr(ctx, "budget_continuations", 0) >= _BUDGET_DIMINISH_TURNS:
        return _BUDGET_STOP
    # 还有预算、过半、本轮有产出 → 推动收口（仅在有产出时出现，避免空转还催）
    if used >= budget * _BUDGET_PUSH_RATIO and delta >= _BUDGET_DIMINISH_DELTA:
        return _BUDGET_PUSH
    return _BUDGET_OK


def _auto_spend_limit() -> int:
    """full(跳过确认)模式下，一轮 Agent 运行内允许「免确认自动执行对外/写入动作」的次数上限。
    幕后静默兜底：超过即使 full 也强制弹确认，挡住"老板切跳过确认后被批量自动执行对外/写入动作而失控"(B-5/C-1·痛点#7)。
    经 DESKTOP_AGENT_AUTO_SPEND_LIMIT 配置；默认 5；设 0 = full 也从不自动放行对外/写入动作。"""
    try:
        return max(0, int(os.environ.get("DESKTOP_AGENT_AUTO_SPEND_LIMIT", "5")))
    except (TypeError, ValueError):
        return 5


def _auto_approve(tool, ctx) -> bool:
    """据 ctx.permission_mode 决定一个 requires_approval 工具是否免确认、直接自动执行。
    有序判定（借鉴 cc-haha 权限瀑布）：force_confirm（bypass-immune）> 权限模式。
    - force_confirm=True 的高危不可逆/对外操作（未来的群发/平台发布/删数据）**任何模式都强制确认**；
    - ask=都弹确认（默认）；auto_files=仅文件类(可逆、已自动备份)免确认；full=全部免确认（含对外/写入）。"""
    # bypass-immune：高危操作的人工确认永不被放行模式旁路。放在最前，优先级高于一切模式。
    if getattr(tool, "force_confirm", False):
        return False
    mode = getattr(ctx, "permission_mode", "ask") or "ask"
    if mode == "ask":
        return False
    kind = getattr(tool, "approval_class", "spend")
    if mode == "auto_files":
        return kind == "file"
    if mode == "full":
        # full=所有动作免确认；但「对外/写入类」(发布、群发等)加一道【一轮内自动放行上限闸】：
        # 老板切到"跳过确认"后，模型批量自动对外/写入会失控(痛点#7)——超上限即使 full 也强制弹安全确认。
        # 文件类(可逆、改前已自动备份)不计入、不设限。
        if kind == "file":
            return True
        # 上限值：优先用本店设置 ctx.auto_spend_limit（老板可在 UI 调高/调低/关闭），没设才用环境默认。
        # 这是老板自己机器上的对外动作、应由他掌控：负数 = 老板关闭上限闸，full 下对外/写入也全自动。
        raw = getattr(ctx, "auto_spend_limit", None)
        limit = raw if raw is not None else _auto_spend_limit()
        if limit < 0:
            return True
        if getattr(ctx, "auto_spend_count", 0) >= limit:
            return False
        ctx.auto_spend_count = getattr(ctx, "auto_spend_count", 0) + 1
        return True
    return False


def _approval_preview(tool, args, ctx) -> str | None:
    """调工具自带预览器算"确认前给老板看的人话 diff"（如 edit_excel 的 B2 32000→38000）。
    没有预览器或生成失败都返回 None——绝不因预览出错而拖垮审批。"""
    fn = getattr(tool, "preview", None)
    if not fn:
        return None
    try:
        return fn(args, ctx)
    except Exception:
        logger.exception("审批预览生成失败: %s", getattr(tool, "name", "?"))
        return None


@dataclass
class AgentStep:
    type: str  # thinking | tool_call | tool_result | final
    content: str = ""
    tool_name: str | None = None
    tool_args: dict | None = None
    tool_call_id: str | None = None
    preview: str | None = None  # approval_request 专用：确认前给老板看的"会改成什么"diff
    meta: dict | None = None    # B-2：tool_result 携带的附加信息（如 {"knowledge_used": [...]} 依据可见）


@dataclass
class AgentResult:
    final_text: str
    steps: list[AgentStep] = field(default_factory=list)
    turns: int = 0
    stopped_reason: str = _STOP_FINAL  # final | max_turns
    messages: list[dict] = field(default_factory=list)  # 完整对话轨迹（含工具调用/结果），供落库与续接


@dataclass
class _ToolPlan:
    """对单个 tool_call 的"该怎么处理"判定——同步/流式两入口共用同一套审批闸逻辑，
    只判定不执行（执行留给各入口，以保住流式"先吐 tool_call 事件、再跑工具"的实时反馈顺序）。"""
    name: str | None
    args: dict
    tool_call_id: str | None
    needs_approval: bool = False    # True=命中审批闸（不在循环里执行，回灌"待确认"待用户点）
    error: str | None = None        # 非空=入参校验失败：不执行，把错误回灌让模型改参数重试
    is_question: bool = False        # True=提问工具：吐 ask_question 事件、不执行，等老板点选
    question: dict | None = None     # is_question 时的 {question, options, multi}
    pending_msg: str | None = None  # needs_approval 时回灌给模型的"待确认"文本
    preview: str | None = None      # needs_approval 时给老板看的人话 diff


def _init_messages(system_prompt: str | None, history: list[dict] | None, user_message: str) -> list[dict]:
    """组装初始 messages：system（可选）+ 历史（可选）+ 本轮 user。两入口完全一致，单点维护。"""
    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": user_message})
    return messages


def _plan_tool_call(tc: dict, registry: ToolRegistry, ctx: AgentContext) -> _ToolPlan:
    """解析一个 tool_call 的入参，并据审批闸判定它该"待确认"还是"可直接执行"。
    审批闸（proposal 模式）：requires_approval 且未被 permission_mode 自动批准的工具不在循环里执行，
    改回灌"待确认"提示、让模型把方案讲给用户；用户确认后走独立的 /agent/execute 真正执行。"""
    tc_id = tc.get("id")
    fn = tc.get("function") or {}
    name = fn.get("name")
    args = _parse_args(fn.get("arguments"))

    tool = registry.get(name) if name else None
    if tool is not None:
        # 入参校验先于审批闸：参数都不合法就别提请确认，直接把错误回灌让模型改参数重试。
        err = _validate_args(tool, args)
        if err:
            return _ToolPlan(name=name, args=args, tool_call_id=tc_id, error=err)
        if getattr(tool, "is_question", False):
            return _ToolPlan(
                name=name, args=args, tool_call_id=tc_id, is_question=True,
                question={
                    "question": args.get("question", "") or "",
                    "options": args.get("options", []) or [],
                    "multi": bool(args.get("allow_multiple")),
                },
            )
        if tool.requires_approval and not _auto_approve(tool, ctx):
            return _ToolPlan(
                name=name, args=args, tool_call_id=tc_id, needs_approval=True,
                pending_msg=_APPROVAL_PENDING_MSG.format(name=name),
                preview=_approval_preview(tool, args, ctx),
            )
    return _ToolPlan(name=name, args=args, tool_call_id=tc_id)


# JSON Schema 基本类型 → Python 类型（够覆盖工具入参那些简单 schema；纯标准库，不引第三方校验库，免打包/部署多依赖）
_JSON_PY_TYPES: dict = {
    "string": str, "integer": int, "number": (int, float),
    "boolean": bool, "array": list, "object": dict,
}


def _validate_args(tool, args: dict) -> str | None:
    """据工具声明的 parameters(JSON Schema 子集) 校验入参：必填项是否齐 + 已给项类型对不对。
    返回错误描述（供回灌让模型改参数重试）或 None（通过）。借鉴 cc-haha 工具脊椎的 schema 校验思路，
    但只用标准库实现（不引 jsonschema，避免打包/部署多一个依赖）——覆盖最常见的两类失败：漏必填、类型不符。
    校验失败不执行工具：给模型一句"缺哪个参数/类型不对"，比让 handler KeyError 后回灌笼统的"[工具执行失败]"强得多。"""
    schema = getattr(tool, "parameters", None)
    if not isinstance(schema, dict):
        return None
    name = getattr(tool, "name", "?")
    for key in (schema.get("required") or []):
        if key not in args:
            return f"[入参校验失败] 工具「{name}」缺少必填参数 {key}。请补上 {key} 后重新调用。"
    props = schema.get("properties") or {}
    for key, val in args.items():
        spec = props.get(key)
        if not isinstance(spec, dict) or val is None:
            continue
        want = spec.get("type")
        py = _JSON_PY_TYPES.get(want)
        if py is None:
            continue
        # bool 是 int 的子类：别把 True/False 当合法 integer/number
        if want in ("integer", "number") and isinstance(val, bool):
            return f"[入参校验失败] 工具「{name}」参数 {key} 应为{want}、给的是布尔值。请修正后重新调用。"
        if not isinstance(val, py):
            return f"[入参校验失败] 工具「{name}」参数 {key} 类型不对（应为 {want}）。请修正后重新调用。"
    return None


async def run_agent_loop(
    *,
    user_message: str,
    registry: ToolRegistry,
    ctx: AgentContext | None = None,
    system_prompt: str | None = None,
    provider: TextProvider | None = None,
    model: str | None = None,
    history: list[dict] | None = None,
    max_turns: int = 8,
    max_tokens: int = 2000,
    temperature: float = _ORCH_TEMPERATURE,
) -> AgentResult:
    provider = provider or ProviderFactory.get_orchestration_provider()
    model = model or settings.effective_orchestration_model
    ctx = ctx or AgentContext()

    messages = _init_messages(system_prompt, history, user_message)
    tools = registry.to_openai_tools()
    steps: list[AgentStep] = []
    stop_blocked = False  # Stop hook 每轮最多阻断一次（防死循环；仍受 max_turns 兜底）
    final_segments: list[str] = []  # SH-4：被 length 截断的最终答复，多轮续写片段在此拼接
    continuations = 0               # SH-4：续写次数（防"一直被截一直续"死循环）

    for turn in range(1, max_turns + 1):
        _microcompact(messages, registry)  # 清理旧的只读工具结果，省上下文 token
        # SH-1：发请求前补缺失/删孤儿/去重 tool_result，堵 OpenAI 兼容端点的配对 400（纯函数返回新列表，就地替换内容）。
        messages[:] = ensure_tool_pairing(messages)
        resp = await provider.generate(TextRequest(
            messages=messages,
            tools=tools,
            tool_choice="auto",
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
        ))
        # SH-2：累加本轮真实 token 用量（端点没返回则粗估），喂预算判定 + 成本看板。
        _accumulate_usage(ctx, getattr(resp, "tokens_used", 0), resp.content or "")

        # 无工具调用 → 准备收尾。Stop hook 可阻断停止让它继续（默认无 hook → 直接收尾）。
        if not resp.tool_calls:
            # SH-4 截断恢复：finish_reason="length" = 这段没说完被砍断。把已输出 append + 提示"接着写完"，
            # 再要一轮，多轮片段拼成完整 final；续写到上限就强制收尾（不死循环）。
            if resp.finish_reason == _LENGTH_FINISH and continuations < _MAX_CONTINUATIONS:
                final_segments.append(resp.content or "")
                messages.append({"role": "assistant", "content": resp.content or ""})
                messages.append({"role": "user", "content": _CONTINUE_MSG})
                continuations += 1
                continue
            # SH-2 token 预算（放在 Stop hook 之前：预算到了优先级最高，不让 Stop hook 把空转拉回来）。
            #   budget=None → _BUDGET_OK，整段跳过（交互式零影响）。
            _budget = _check_budget(ctx)
            if _budget == _BUDGET_STOP:
                full_final = "".join(final_segments) + (resp.content or "")
                steps.append(AgentStep(type="final", content=full_final))
                return AgentResult(
                    final_text=full_final, steps=steps, turns=turn,
                    stopped_reason=_STOP_FINAL, messages=messages,
                )
            if _budget == _BUDGET_PUSH:
                if resp.content:
                    messages.append({"role": "assistant", "content": resp.content})
                messages.append({"role": "user", "content": _BUDGET_PUSH_MSG})
                continue
            if not stop_blocked:
                cont = await run_stop_hooks(messages, ctx)
                if cont:
                    stop_blocked = True
                    if resp.content:
                        messages.append({"role": "assistant", "content": resp.content})
                    messages.append({"role": "user", "content": cont})
                    continue
            full_final = "".join(final_segments) + (resp.content or "")
            steps.append(AgentStep(type="final", content=full_final))
            return AgentResult(
                final_text=full_final, steps=steps, turns=turn,
                stopped_reason=_STOP_FINAL, messages=messages,
            )

        # 工具调用前可能带一段思考文本，记一笔
        if resp.content:
            steps.append(AgentStep(type="thinking", content=resp.content))

        # 把 assistant 的 tool_calls 原样回灌（下一轮模型需要看到自己调了什么）
        messages.append({"role": "assistant", "content": resp.content or "", "tool_calls": resp.tool_calls})

        # 逐个处理工具调用：审批闸判定 → （待确认 回灌"待确认" | 执行 回灌结果）
        for tc in resp.tool_calls:
            plan = _plan_tool_call(tc, registry, ctx)
            if plan.error:  # 入参校验未过：记一笔调用 + 错误结果，回灌让模型改参数重试，不执行
                steps.append(AgentStep(type="tool_call", tool_name=plan.name, tool_args=plan.args,
                                       tool_call_id=plan.tool_call_id))
                steps.append(AgentStep(type="tool_result", tool_name=plan.name,
                                       tool_call_id=plan.tool_call_id, content=plan.error))
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.error})
                continue
            if plan.is_question:  # 提问：记一笔 ask_question + 回灌"等用户选"，不执行
                steps.append(AgentStep(type="ask_question", tool_name=plan.name, tool_args=plan.question,
                                       tool_call_id=plan.tool_call_id))
                steps.append(AgentStep(type="tool_result", tool_name=plan.name,
                                       tool_call_id=plan.tool_call_id, content=_QUESTION_PENDING_MSG))
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": _QUESTION_PENDING_MSG})
                continue
            if plan.needs_approval:
                steps.append(AgentStep(type="approval_request", tool_name=plan.name, tool_args=plan.args,
                                       tool_call_id=plan.tool_call_id, preview=plan.preview))
                steps.append(AgentStep(type="tool_result", tool_name=plan.name,
                                       tool_call_id=plan.tool_call_id, content=plan.pending_msg))
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.pending_msg})
                continue

            steps.append(AgentStep(type="tool_call", tool_name=plan.name, tool_args=plan.args,
                                   tool_call_id=plan.tool_call_id))
            result_str = await _execute_tool(registry, plan.name, plan.args, ctx)
            # B-2 依据可见：工具若注入了行业知识（deliverable 工具写进 ctx.last_knowledge_used），
            # 把名字挂到本条 tool_result 的 meta；取后立即复位，防串到下一个工具。
            _meta = None
            if ctx.last_knowledge_used:
                _meta = {"knowledge_used": ctx.last_knowledge_used}
            ctx.last_knowledge_used = None
            steps.append(AgentStep(type="tool_result", tool_name=plan.name,
                                   tool_call_id=plan.tool_call_id, content=result_str, meta=_meta))
            messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": result_str})

    # 达到 max_turns 仍未收敛（兜底，防止循环跑飞）：强制模型基于已有结果给最终答复，不返回空。
    logger.warning("agent loop 达到 max_turns=%s 仍未结束，强制收尾", max_turns)
    final_text = await _force_final_text(provider, messages, model, max_tokens, temperature)
    steps.append(AgentStep(type="final", content=final_text))
    return AgentResult(final_text=final_text, steps=steps, turns=max_turns,
                       stopped_reason=_STOP_MAX_TURNS, messages=messages)


def _parse_args(raw) -> dict:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, dict) else {}
    except (ValueError, TypeError):
        logger.warning("工具入参解析失败，按空参处理: %r", raw)
        return {}


async def _execute_tool(registry: ToolRegistry, name: str | None, args: dict, ctx: AgentContext) -> str:
    tool = registry.get(name) if name else None
    if tool is None:
        return f"[工具不存在] {name}"
    # 防打转（anti-spin）：同一工具+完全相同参数反复调 → 结果不会变，拦下逼它换思路（计数存 ctx、跨轮累计）
    try:
        sig = f"{name}|{json.dumps(args, sort_keys=True, ensure_ascii=False)}"
    except (TypeError, ValueError):
        sig = f"{name}|{args!r}"
    ctx.call_counts[sig] = ctx.call_counts.get(sig, 0) + 1
    if ctx.call_counts[sig] > _MAX_SAME_CALL:
        return (f"[别重复了] 你已用完全相同的参数调用 {name} {ctx.call_counts[sig]} 次，结果不会变。"
                f"请换个参数/思路，或直接根据已有信息回答老板，别再重复调它。")
    # PreToolUse hook（借鉴 cc-haha）：工具执行前可拦截（如发布前敏感词检查 / 群发前校验名单）。故障安全。
    deny = await run_pre_tool_hooks(name, args, ctx)
    if deny:
        return f"[已被拦截] {name}：{deny}"
    try:
        result = await tool.handler(args, ctx)
    except Exception as e:  # 工具失败不崩循环：错误（带类型，给模型更多自纠信号）回灌，让它决定补救
        logger.exception("工具执行失败: %s", name)
        return f"[工具执行失败] {name}（{type(e).__name__}）: {e}"

    if isinstance(result, str):
        text = result
    else:
        try:
            text = json.dumps(result, ensure_ascii=False)
        except (TypeError, ValueError):
            text = str(result)
    capped = _cap_tool_result(tool, text, ctx)
    # PostToolUse hook：工具执行后观察/归档/通知（只观察、不改控制流）。故障安全。
    await run_post_tool_hooks(name, args, capped, ctx)
    return capped


def _cap_tool_result(tool, text: str, ctx=None) -> str:
    """超大结果护栏：只处理"喂回模型推理"的查询/读取类大结果，护住上下文窗口与 BYOK token 成本；
    成品（deliverable）是给老板的最终产物，绝不截断不落盘。

    SH-3 落盘优先于硬截断：超阈值且【非 deliverable 且非自读类（read_only）】的大结果 →
    落盘 tool-results/ + 回灌「<persisted-output>路径</persisted-output> + 开头预览 + 用 read 读全」，
    模型按需把后半段拉回来，不丢信息（比"截断+让它缩小范围重查"更省 token 也更稳）。
    自读类（read_only，如 read_file）结果落盘没意义（落了还得再 read 一遍），退回老的硬截断行为。
    阈值：tool.max_result_chars（None=全局默认 _MAX_TOOL_RESULT_CHARS）。"""
    limit = getattr(tool, "max_result_chars", None) or _MAX_TOOL_RESULT_CHARS
    if getattr(tool, "deliverable", False) or len(text) <= limit:
        return text
    # 自读类（read_only）：落盘无意义（再 read 一遍同样大），保持硬截断
    if not getattr(tool, "read_only", False) and ctx is not None:
        try:
            from services.agent.tool_result_store import persist
            path, preview = persist(getattr(tool, "name", None), text, ctx)
            return (f"[结果较长已存盘] <persisted-output>{path}</persisted-output>（共 {len(text)} 字）。\n"
                    f"开头预览：\n{preview}\n…\n"
                    f"需要看完整内容，用 read_file 读上面这个路径。")
        except Exception:
            logger.exception("工具结果落盘失败，退回截断: %s", getattr(tool, "name", "?"))
    kept = text[:limit]
    return (f"{kept}\n\n…[结果较长已截断：原 {len(text)} 字，这里只回灌前 {limit} 字。"
            f"需要更完整内容请缩小范围或分批读取。]")


def _microcompact(messages: list[dict], registry: ToolRegistry) -> None:
    """就地清理【旧的只读工具结果】内容，保留最近 _MICROCOMPACT_KEEP 条原文，省 loop 内上下文 token（零 LLM）。
    只读工具的结果是可重查/已消化的，清掉最安全；写/成品类结果一律不动。按 tool_call_id 定位、只换 content。

    ⚠️ SH-9 · prompt-cache 纪律：本函数【就地改靠前的 tool 消息 content】（messages[i]={**messages[i],"content":占位符}）。
    这是【故意为之】——按 PC（prompt caching）缓存以 tools→system→messages 为前缀层级命中，改前缀块会让那一刻起
    后面全部 cache miss。这里【拿一次 cache miss 换掉一大段旧只读结果占的 token】，是省 token 的划算交易。
    为把 miss 频率压到最低，触发被【对齐到压缩边界】：只在只读结果【超过 _MICROCOMPACT_KEEP 条】时才动手
    （`len(ro_msg_idx) <= _MICROCOMPACT_KEEP` 直接 return），不是每轮都改前缀；且一旦清成占位符就不再重复清同一条
    （`content != _CLEARED_RESULT_MARK` 过滤），避免反复 touch 同一前缀位置造成无谓的连环 miss。
    除本函数与 SH-6 的 autocompact（唯一允许整段重建前缀的点）外，任何代码都不应就地改 messages 靠前部分——
    详见 docs/耦合地图与改动检查清单.md「prompt-cache 前缀稳定纪律」。"""
    # 从 assistant 的 tool_calls 建「tool_call_id → 是否只读」映射
    ro_ids: set = set()
    for m in messages:
        if m.get("role") == "assistant":
            for tc in (m.get("tool_calls") or []):
                name = (tc.get("function") or {}).get("name")
                tool = registry.get(name) if name else None
                if tool is not None and getattr(tool, "read_only", False):
                    ro_ids.add(tc.get("id"))
    if not ro_ids:
        return
    ro_msg_idx = [i for i, m in enumerate(messages)
                  if m.get("role") == "tool" and m.get("tool_call_id") in ro_ids
                  and m.get("content") != _CLEARED_RESULT_MARK]
    if len(ro_msg_idx) <= _MICROCOMPACT_KEEP:
        return
    for i in ro_msg_idx[:-_MICROCOMPACT_KEEP]:  # 除最近 N 条外，旧的只读结果换占位符
        messages[i] = {**messages[i], "content": _CLEARED_RESULT_MARK}


async def _force_final_text(provider, messages: list[dict], model, max_tokens: int, temperature: float) -> str:
    """max_turns 强制收尾（非流式）：追加"别再调工具、直接答"的提示再要一段答复。
    自身失败也不崩，走静态兜底，绝不返回空。"""
    messages.append({"role": "user", "content": _FORCE_FINAL_MSG})
    try:
        resp = await provider.generate(TextRequest(
            messages=messages, model=model, max_tokens=max_tokens, temperature=temperature,
        ))
        final_text = (resp.content or "").strip()
    except Exception:
        logger.exception("max_turns 强制收尾失败")
        final_text = ""
    return final_text or _FALLBACK_FINAL


async def run_agent_loop_stream(
    *,
    user_message: str,
    registry: ToolRegistry,
    ctx: AgentContext | None = None,
    system_prompt: str | None = None,
    provider: TextProvider | None = None,
    model: str | None = None,
    history: list[dict] | None = None,
    max_turns: int = 8,
    max_tokens: int = 2000,
    temperature: float = _ORCH_TEMPERATURE,
):
    """流式版 ReAct 循环：边跑边 yield 事件 dict，供 SSE 推给前端。

    与同步版 `run_agent_loop` 共享审批闸/入参解析逻辑（`_plan_tool_call`），只在"逐片调模型 +
    逐事件吐给前端"上不同。事件类型：
    - {"type": "token", "content": <片段>}        最终答复文本（逐片）
    - {"type": "tool_call", "tool", "args", "id"}  模型决定调某工具
    - {"type": "approval_request", "tool", "args", "id", "token", "preview"}  受审批工具待确认
    - {"type": "tool_result", "tool", "id", "content"}  工具执行结果/待确认提示
    - {"type": "final", "content": <完整答复>}     收敛的最终答复全文
    - {"type": "done", "turns", "stopped_reason"}  收尾（恒为最后一条）
    """
    provider = provider or ProviderFactory.get_orchestration_provider()
    model = model or settings.effective_orchestration_model
    ctx = ctx or AgentContext()

    messages = _init_messages(system_prompt, history, user_message)
    tools = registry.to_openai_tools()
    stop_blocked = False  # Stop hook 每轮最多阻断一次（防死循环；仍受 max_turns 兜底）
    final_segments: list[str] = []  # SH-4：被 length 截断的最终答复，多轮续写片段在此拼接
    continuations = 0               # SH-4：续写次数（防"一直被截一直续"死循环）

    for turn in range(1, max_turns + 1):
        _microcompact(messages, registry)  # 清理旧的只读工具结果，省上下文 token
        # SH-1：发请求前补缺失/删孤儿/去重 tool_result，堵 OpenAI 兼容端点的配对 400（纯函数返回新列表，就地替换内容）。
        messages[:] = ensure_tool_pairing(messages)
        sink: list[dict] = []
        finish: dict = {}  # SH-4：本轮 finish_reason 由 provider 写回（="length" = 被截断）
        usage: dict = {}   # SH-2：本轮 token 用量由 provider 写回（total_tokens 等），按请求独立避免并发串号
        parts: list[str] = []
        async for tok in provider.generate_stream(
            TextRequest(messages=messages, tools=tools, tool_choice="auto", model=model,
                        max_tokens=max_tokens, temperature=temperature),
            tool_calls_sink=sink,
            finish_sink=finish,
            usage_sink=usage,
        ):
            parts.append(tok)
            yield {"type": "token", "content": tok}
        text = "".join(parts)
        # SH-2：累加本轮真实 token 用量（端点没返回 total_tokens 则按 len//4 粗估），喂预算判定 + 成本看板。
        _accumulate_usage(ctx, usage.get("total_tokens", 0) or 0, text)

        # 无工具调用 → 准备收尾。Stop hook 可阻断停止让它继续（默认无 hook → 直接收尾）。
        if not sink:
            # SH-4 截断恢复：finish_reason="length" = 这段没说完被砍断。不发 final，把已收片段回灌 + 提示"接着写完"，
            # 再要一轮（token 已逐片吐过，前端会接着流出续写部分）；多轮片段拼成完整 final；到上限强制收尾不死循环。
            if finish.get("finish_reason") == _LENGTH_FINISH and continuations < _MAX_CONTINUATIONS:
                final_segments.append(text)
                messages.append({"role": "assistant", "content": text})
                messages.append({"role": "user", "content": _CONTINUE_MSG})
                continuations += 1
                continue
            # SH-2 token 预算（放在 Stop hook 之前：预算到了优先级最高，不让 Stop hook 把空转拉回来）。
            #   budget=None → _BUDGET_OK，整段跳过（交互式零影响）。⚠️ 同步路径同样逻辑，别只改一处。
            _budget = _check_budget(ctx)
            if _budget == _BUDGET_STOP:
                full_final = "".join(final_segments) + text
                yield {"type": "final", "content": full_final}
                yield {"type": "done", "turns": turn, "stopped_reason": _STOP_FINAL,
                       "tokens_used": getattr(ctx, "tokens_used", 0)}
                return
            if _budget == _BUDGET_PUSH:
                if text:
                    messages.append({"role": "assistant", "content": text})
                messages.append({"role": "user", "content": _BUDGET_PUSH_MSG})
                continue
            if not stop_blocked:
                cont = await run_stop_hooks(messages, ctx)
                if cont:
                    stop_blocked = True
                    if text:
                        messages.append({"role": "assistant", "content": text})
                    messages.append({"role": "user", "content": cont})
                    continue
            full_final = "".join(final_segments) + text
            yield {"type": "final", "content": full_final}
            yield {"type": "done", "turns": turn, "stopped_reason": _STOP_FINAL,
                   "tokens_used": getattr(ctx, "tokens_used", 0)}
            return

        # 工具调用轮：assistant(tool_calls) 回灌 → 逐个处理 → 结果回灌
        messages.append({"role": "assistant", "content": text, "tool_calls": sink})
        for tc in sink:
            plan = _plan_tool_call(tc, registry, ctx)
            if plan.error:  # 入参校验未过：吐 tool_call + 错误结果，回灌让模型改参数重试，不执行
                yield {"type": "tool_call", "tool": plan.name, "args": plan.args, "id": plan.tool_call_id}
                yield {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": plan.error}
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.error})
                continue
            if plan.is_question:  # 提问：吐 ask_question 事件(带选项)让前端渲染卡片 + 回灌"等用户选"，不执行
                yield {"type": "ask_question", "tool": plan.name, "id": plan.tool_call_id, **(plan.question or {})}
                yield {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": _QUESTION_PENDING_MSG}
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": _QUESTION_PENDING_MSG})
                continue
            if plan.needs_approval:
                # 审批闸（proposal 模式）：吐 approval_request 让前端弹确认，把"待确认"回灌让模型讲方案；
                # token 绑定本组 args，/agent/execute 校验防前端篡改（P3.2）。
                yield {
                    "type": "approval_request", "tool": plan.name, "args": plan.args, "id": plan.tool_call_id,
                    "token": sign_approval(plan.name, plan.args),
                    "preview": plan.preview,
                }
                yield {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": plan.pending_msg}
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.pending_msg})
                continue

            # 先吐 tool_call 事件（前端即时显示"正在调 X"），再跑工具（可能慢），最后吐结果
            yield {"type": "tool_call", "tool": plan.name, "args": plan.args, "id": plan.tool_call_id}
            result = await _execute_tool(registry, plan.name, plan.args, ctx)
            # B-2 依据可见：工具若注入了行业知识，把名字一并带进 tool_result 事件（前端成品卡显示「依据：…」）。
            # 取后立即复位，防串到下一个工具。⚠️ 同步路径同样要改，别只改一处（见上面 run_agent_loop）。
            _evt = {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": result}
            if ctx.last_knowledge_used:
                _evt["knowledge_used"] = ctx.last_knowledge_used
            ctx.last_knowledge_used = None
            yield _evt
            messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": result})

    # 达到 max_turns 仍未收敛：强制模型基于已有结果给最终答复（不再给工具），逐片流式吐出，不返回空。
    logger.warning("agent stream loop 达到 max_turns=%s 仍未结束，强制收尾", max_turns)
    messages.append({"role": "user", "content": _FORCE_FINAL_MSG})
    final_parts: list[str] = []
    try:
        async for tok in provider.generate_stream(
            TextRequest(messages=messages, model=model, max_tokens=max_tokens, temperature=temperature),
        ):
            final_parts.append(tok)
            yield {"type": "token", "content": tok}
    except Exception:  # 强制收尾失败也不崩，走静态兜底
        logger.exception("max_turns 强制收尾(流式)失败")
    final_text = "".join(final_parts).strip() or _FALLBACK_FINAL
    yield {"type": "final", "content": final_text}
    yield {"type": "done", "turns": max_turns, "stopped_reason": _STOP_MAX_TURNS,
           "tokens_used": getattr(ctx, "tokens_used", 0)}
