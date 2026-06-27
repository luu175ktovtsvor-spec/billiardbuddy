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
import asyncio
import json
import logging
import os
from dataclasses import dataclass, field

from config import settings
from services.agent.approval import sign_approval
from services.agent.context import AgentContext
from services.agent.hooks import run_post_tool_hooks, run_pre_tool_hooks, run_stop_hooks
from services.agent.local_tools import path_in_workspace  # auto_files 收口判定(无循环依赖;注册 DESKTOP_LOCAL 门控,云端 import 无副作用)
from services.agent.message_repair import ensure_tool_pairing
from services.agent.registry import ToolRegistry
from services.agent.vision_degrade import (
    looks_like_vision_error,
    messages_have_images,
    prepend_degrade_hint,
    strip_images_from_messages,
)
from services.ai.base import TextProvider, TextRequest, ReasoningChunk
from services.ai.factory import ProviderFactory

logger = logging.getLogger(__name__)

# 编排（选工具/规划）用低温度：实测 0.7（TextRequest 默认）下 DeepSeek 会"有时兴起自己聊、
# 不调工具"，导致该写文案/推玩法的需求被直接闲聊掉。工具选择要的是稳定可复现，不是创意——
# 故循环统一压到 0.3。真正要创意的内容生成在各工具内部走 run_generation（自带 0.7），不受此影响。
# G.1 P2：编排温度做成可配。0.3 是为防 DeepSeek 跑题打的补丁，一刀切会压死强模型的发挥；
# 强模型(mimo 等)想放开创意可经 DESKTOP_ORCH_TEMPERATURE 调高。非法值回落 0.3。
try:
    _ORCH_TEMPERATURE = float(os.environ.get("DESKTOP_ORCH_TEMPERATURE") or 0.3)
except (TypeError, ValueError):
    _ORCH_TEMPERATURE = 0.3

# G.1/E.3.7 工具调用统一超时兜底（秒）：任何不自带超时的工具挂死时，外层 asyncio.wait_for 兜底掐断，
# 把"超时"作为工具结果回灌让模型自纠，绝不让单个工具无限期卡住整个请求 / SSE 流 / 循环。
# 取值要足够宽，别误杀正经慢活（生图 settings.openai_image_timeout≈900s、子代理递归多轮）——它是"防挂死"
# 的最后一道，不是性能闸。可经 DESKTOP_TOOL_TIMEOUT 覆盖；工具自身可用 Tool.timeout 收紧或（<=0）豁免。
try:
    _DEFAULT_TOOL_TIMEOUT = float(os.environ.get("DESKTOP_TOOL_TIMEOUT") or 1200)
except (TypeError, ValueError):
    _DEFAULT_TOOL_TIMEOUT = 1200.0

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

# ── SH-8 连续拒绝自动回退 ──
# 老板对【同一动作】连续点拒绝达 _DENIAL_FALLBACK_N 次 → loop 不再反复提请该动作（别没完没了地烦），
# 改回灌一句"这个就先不做了、换个法子"，让模型走文本答复 / 提替代方案。阈值 N=2（拒两次就够明确了）。
# 另设全局累计闸 _DENIAL_FALLBACK_TOTAL：跨不同动作累计拒太多次也整体回退（防"换个参数接着烦"）。
_DENIAL_FALLBACK_N = 2
_DENIAL_FALLBACK_TOTAL = 20
# 命中回退时回灌给模型的提示（让它别再提该动作、改用文字答复或换方案，给老板一句台阶话）。
_DENIAL_FALLBACK_MSG = (
    "[这个先不做了] 老板已经多次没同意执行「{name}」这个动作，就别再反复请求确认了。"
    "用一句话告诉老板这个就先不做了、你换个法子，然后改用文字直接答复或提个替代方案，"
    "不要再调用「{name}」。"
)

# 达到 max_turns 仍未收敛时，强制模型基于已有结果给一段最终答复（不再给工具），
# 避免直接返回空答复让用户看到"AI 没反应"。
_FORCE_FINAL_MSG = "请基于上面已有的工具结果，直接用一段话给用户最终答复，不要再调用任何工具。"
# 强制收尾仍拿不到内容时的静态兜底（极端情况）。
_FALLBACK_FINAL = "这个需求我拆了好几步还没完全收尾。你可以把要求说得更具体一点，或者分两次让我来做。"
# 模型偶尔（尤其碰敏感词、或被自身安全过滤）吐【完全空白】的最终答复 → 绝不能把空白丢给用户（看着像卡死/坏了）。
_EMPTY_FINAL_FALLBACK = "这个我没法给出回应——可能是要求太敏感、或没说清楚。换个说法、把需求说具体点再试试。"


def _final_or_fallback(text: str) -> str:
    """最终答复兜底：非空白原样返回；空白则给友好兜底，绝不把空白丢给用户。"""
    return text if (text and text.strip()) else _EMPTY_FINAL_FALLBACK


def _finalize_text(text: str, ctx) -> str:
    """收尾统一出口：先空白兜底，再【若本轮发生过非识图降级】在开头加一句温和提示。
    所有 final 文本（同步/流式、正常/预算停/强制收尾）都过这道，确保降级提示一定带上。"""
    out = _final_or_fallback(text)
    if ctx is not None and getattr(ctx, "vision_degraded", False):
        out = prepend_degrade_hint(out)
    return out

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

# ── SH-6 三级上下文压缩 · 第三级 autocompact（超长对话顶满窗口时的语义兜底）──
# 前两级（SH-3 落盘 _cap_tool_result / microcompact 清旧只读结果）都是零 LLM 的轻压缩；
# 当超长多步任务把上下文顶到临近窗口时，仍可能溢出——此时花【一次】文字 provider 调用，把
# 【较早的非近 N 轮】消息总结成一段精简摘要（保留：关键事实 / 已产出 / 老板诉求 / 待办；丢：冗余来回），
# 用一条摘要消息替换那一大段，再拼上最近 N 轮原文，重建出更短的 messages。
#
# ⚠️ 触发顺序铁律：snip(SH-3 落盘，在工具执行时已发生) → microcompact → autocompact。autocompact 排最后、
#    且【只在临近窗口才触发】（est < 窗口*ratio 直接跳过），平时一动不动、不花这次昂贵调用。
# ⚠️ SH-9 prompt-cache 纪律：autocompact 是【整个 loop 里唯一允许重建 messages 前缀的点】（microcompact 是
#    就地改单条 content；这里是重排/替换前面一大段）。重建必然让那一刻起 cache 全 miss——这是「拿一次大 miss
#    换掉一大段顶满窗口的旧文 + 续命不让请求溢出」的划算交易，且仅临近窗口才发生（低频）。除本函数外任何
#    代码都不应重建前缀，详见 docs/耦合地图与改动检查清单.md「prompt-cache 前缀稳定纪律」。
# 故障安全：估算/总结任一步抛错 → 跳过压缩、用原 messages 继续，绝不让主循环崩。
# 循环每轮响应的 max_tokens 默认值（可配）。原 2000 偏小：写运营方案/长文案常超 2000 token，
# 会把【工具调用的超长 content 参数】截断 → 入参 JSON 不完整 → 解析失败 → 写空文件 → 打转到 502。
# 提到 4096 让多数方案一次写完；仍超长的由 _plan_tool_call 的"截断专属回灌"兜底（让模型写精简/分次）。
try:
    _DEFAULT_AGENT_MAX_TOKENS = max(2000, int(os.environ.get("DESKTOP_AGENT_MAX_TOKENS", "4096") or 4096))
except (TypeError, ValueError):
    _DEFAULT_AGENT_MAX_TOKENS = 4096

# 工具入参被截断（raw 非空却 JSON 解析不出，多半是 content 太长撞上 max_tokens）时回灌给模型的指令：
# 不拿空参去执行(会写空文件/反复重试同一个超大写入→打转到502)，而是明确让它换策略——写精简或分次。
_ARGS_TRUNCATED_MSG = (
    "【工具 {name} 的参数没收全、解析失败】很可能是 content 等长内容超出单次输出上限被截断了。"
    "别再原样重发同一个超大调用。请改写法：① 把内容写精简（砍掉冗长表格/重复段，只留能直接用的主干）；"
    "或 ② 分多次写——先用 write_file 写主干骨架，再用 edit_file 逐段追加。一次别塞超长内容。"
)

_AUTOCOMPACT_MIN_OLD = 6   # 较早段至少要有这么多条消息才值得花 LLM 压（太少不划算、直接跳过）
_AUTOCOMPACT_SUMMARY_MAX_TOKENS = 1024  # 摘要生成的 max_tokens（够装关键事实/待办，又不喧宾夺主）
_AUTOCOMPACT_SUMMARY_PROMPT = (
    "下面是一段较早的 AI 助手与老板的对话记录（含工具调用与结果）。请把它压成一段精简摘要，"
    "只保留对【接下来继续完成任务】有用的信息：老板的核心诉求、已确认的关键事实/数据、已经产出了什么、"
    "还没做完的待办。丢掉寒暄、重复的来回、已无意义的中间过程。直接给摘要正文，不要加任何开场白或标题。\n\n"
    "=== 较早对话记录 ===\n{transcript}"
)
# 摘要消息的标记前缀（落进 messages 的 assistant 消息，便于人/测试识别这是压缩产物）。
_AUTOCOMPACT_SUMMARY_MARK = "[此前对话摘要]"
# autocompact 连续"真失败"达这么多次 → 熔断停手，不再每轮空烧昂贵的摘要 LLM（如 BYOK key 额度耗尽 / 模型对超长
# prompt 反复报错时，上下文已顶到窗口*ratio 之上，否则每一轮都会再徒劳地试一次摘要、白烧 token）。借鉴 CC s08。
_AUTOCOMPACT_FAIL_MAX = 3

# Gap C：autocompact 触发阈值口径——"窗口 − 固定 buffer"（官方做法，留 13k；我们大窗放宽到留约 48k）。
# 旧口径"窗口×0.7"在 1M 大窗下 700k 就压（太早、白丢上下文、毁 prompt cache）。改成留固定余量 →
# 接近顶满(~952k)才压。阈值 = max(窗口−buffer, 窗口×ratio)：大窗由 buffer 主导(压得更晚)，小窗仍由 ratio
# 兜底(buffer 若吃掉过半小窗，ratio 下限护住、不至于"永远触发")。可被 ctx.autocompact_buffer 覆盖。
_AUTOCOMPACT_BUFFER_TOKENS = 48000

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


def _accumulate_usage(ctx, resp_tokens: int, fallback_text: str, *, prompt_tokens: int = 0) -> None:
    """把本轮 provider usage 累加进 ctx.tokens_used，并更新 last_total/last_delta + diminishing 计数。
    端点没返回（resp_tokens<=0）则按 len//4 粗估。token_budget=None 也照常累加（顺带喂成本看板，零行为影响）。
    diminishing 判定靠 budget_continuations 当"连续低增量轮"计数：本轮 delta 极小则 +1、否则归零。

    Gap C：prompt_tokens（本轮真实输入 token = 上下文有多大）>0 时记进 ctx.last_prompt_tokens，
    供 autocompact 触发判据当真值（0/未知则不动，保留上一轮真值或退回估算）。"""
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
    if prompt_tokens and prompt_tokens > 0:
        ctx.last_prompt_tokens = prompt_tokens


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


def _auto_approve(tool, args, ctx) -> bool:
    """据 ctx.permission_mode 决定一个 requires_approval 工具是否免确认、直接自动执行。
    有序判定（借鉴 cc-haha 权限瀑布）：force_confirm（bypass-immune）> 权限模式。
    - force_confirm=True 的高危不可逆/对外操作（未来的群发/平台发布/删数据）**任何模式都强制确认**；
    - ask=都弹确认（默认）；auto_files=仅文件类且在工作区内免确认；full=全部免确认（含对外/写入）。"""
    # bypass-immune：高危操作的人工确认永不被放行模式旁路。放在最前，优先级高于一切模式。
    if getattr(tool, "force_confirm", False):
        return False
    mode = getattr(ctx, "permission_mode", "ask") or "ask"
    if mode == "ask":
        return False
    kind = getattr(tool, "approval_class", "spend")
    if mode == "auto_files":
        if kind != "file":
            return False
        path = (args or {}).get("path")
        if not path:                       # 没 path 的文件类(理论不出现)→ 保守维持原免确认,防回归
            return True
        return path_in_workspace(path, ctx)   # 工作区内免确认;区外→False(弹卡)
    if mode == "full":
        # full=所有动作免确认；但「对外/写入类」(发布、群发等)加一道【一轮内自动放行上限闸】：
        # 老板切到"跳过确认"后，模型批量自动对外/写入会失控(痛点#7)——超上限即使 full 也强制弹安全确认。
        # 文件类(可逆、改前已自动备份)及敏感读取(只读、owner 拍板 full 不 force_confirm)不计入、不设限。
        if kind in ("file", "sensitive_read"):
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


def _action_key(name: str | None, args: dict) -> str:
    """SH-8 动作标识：工具名 + 规范化 args（与 anti-spin sig / approval canonical 同套 sort_keys 思路）。
    用作"连续被拒"计数的 key——同一工具+同参视为同一动作；序列化失败退回 repr（绝不抛错拖垮审批）。"""
    try:
        return f"{name}|{json.dumps(args or {}, sort_keys=True, ensure_ascii=False)}"
    except (TypeError, ValueError):
        return f"{name}|{args!r}"


def _build_approval_reason(tool, args, ctx) -> dict:
    """SH-8 结构化审批理由：{what 做什么 / why 为什么要你确认 / impact 影响}。
    优先用工具自带的 approval_reason(args, ctx) 生成器；没有或失败则据工具元信息(approval_class/名字)兜底拼一份，
    审批卡总有话可说、不再只给一句干巴巴的 label。绝不因理由生成出错而拖垮审批（故障安全）。"""
    fn = getattr(tool, "approval_reason", None)
    if fn:
        try:
            r = fn(args, ctx)
            if isinstance(r, dict) and r.get("what"):
                # 补全缺失字段，保证三件套都在
                return {"what": r.get("what", ""), "why": r.get("why", ""), "impact": r.get("impact", "")}
        except Exception:
            logger.exception("审批理由生成失败，退回兜底: %s", getattr(tool, "name", "?"))
    name = getattr(tool, "name", "?")
    desc = (getattr(tool, "description", "") or "").split("。")[0]
    kind = getattr(tool, "approval_class", "spend")
    if kind == "file":
        path = args.get("path") if isinstance(args, dict) else None
        what = f"{desc}" if desc else f"执行「{name}」"
        why = "这会改动你电脑上的文件，落盘前需要你点头确认。"
        impact = (f"会改动文件：{path}。改前已自动备份原件，确认后可随时回滚。"
                  if path else "会改动内容库里的文件。改前已自动备份原件，确认后可随时回滚。")
    elif kind == "command":
        cmd = args.get("command") if isinstance(args, dict) else None
        what = f"在你电脑上跑命令：{cmd}" if cmd else (desc or f"执行「{name}」")
        why = "这是在你电脑上直接执行命令，可能有副作用，每条都需要你看清原文再点头。"
        impact = f"确认后会真正运行这条命令：{cmd}。请先看清命令原文再决定。" if cmd else "确认后会运行这条命令，请先看清原文。"
    else:
        what = f"{desc}" if desc else f"执行「{name}」"
        why = "这是对外/不可逆的动作（如发布、群发），做出去收不回，需要你点头确认。"
        impact = "确认后会真正执行这个对外动作，请先看清内容再决定。"
    return {"what": what, "why": why, "impact": impact}


def _denial_fallback(name: str | None, args: dict, ctx) -> bool:
    """SH-8：该动作是否已触发"连续拒绝自动回退"——同一动作连续被拒达 _DENIAL_FALLBACK_N 次，
    或全局累计拒绝达 _DENIAL_FALLBACK_TOTAL 次。命中则 loop 不再提请该动作，改走文本/换方案。
    只读 ctx 计数（拒绝时由 /agent/execute 取消路径 record_denial 累加），故障安全：ctx 不全也不抛。"""
    if ctx is None:
        return False
    if getattr(ctx, "denials_total", 0) >= _DENIAL_FALLBACK_TOTAL:
        return True
    by = getattr(ctx, "denials_by_action", None)
    if not isinstance(by, dict):
        return False
    return by.get(_action_key(name, args), 0) >= _DENIAL_FALLBACK_N


@dataclass
class AgentStep:
    type: str  # thinking | tool_call | tool_result | final
    content: str = ""
    tool_name: str | None = None
    tool_args: dict | None = None
    tool_call_id: str | None = None
    preview: str | None = None  # approval_request 专用：确认前给老板看的"会改成什么"diff
    reason: dict | None = None  # SH-8：approval_request 专用，结构化理由 {what/why/impact}
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
    reason: dict | None = None      # SH-8 结构化审批理由 {what/why/impact}，随 approval_request 带给前端
    fallback: bool = False          # SH-8 连续拒绝回退：True=该动作老板已反复拒、不再提请，改走文本/换方案
    fallback_msg: str | None = None  # fallback 时回灌给模型的"这个先不做了、换法子"提示


def _trajectory_with_final(messages: list[dict], final_content: str | None) -> list[dict]:
    """跨轮记忆：把本轮最终答复补成尾部 assistant 消息，得到【完整轨迹】（供端点落盘/续接）。

    loop 内部 messages 只到"最后一轮工具结果/续写片段"，无 tool_calls 的最终答复正文历来没 append 进去——
    续接时下一轮就看不到自己上轮答了啥。这里把它补上。返回【新列表】、不改 messages 本身（零副作用）。
    final_content 为空、或尾部已是同一条 assistant（防御重复）→ 不重复添加。
    注：续写场景（finish=length 多段）各分段早已作为 assistant 消息在 messages 里，这里只补"收敛轮的本段"
    （调用方传本轮 text/final_text，不是拼接后的全文），故不会重复。"""
    if not (final_content and final_content.strip()):
        return list(messages)
    last = messages[-1] if messages else None
    if (isinstance(last, dict) and last.get("role") == "assistant"
            and not last.get("tool_calls") and last.get("content") == final_content):
        return list(messages)
    return list(messages) + [{"role": "assistant", "content": final_content}]


def _init_messages(
    system_prompt: str | None,
    history: list[dict] | None,
    user_message: str,
    user_images: list[str] | None = None,
) -> list[dict]:
    """组装初始 messages：system（可选）+ 历史（可选）+ 本轮 user。两入口完全一致，单点维护。
    user_images：本轮老板随消息带的图片路径 → 按 OpenAI 兼容 image_url 拼进 user content（多模态回灌）。
    模型自带识图就能看；无图则 content 仍是原字符串、行为零变化。"""
    from services.agent.multimodal import build_user_content
    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": build_user_content(user_message, user_images)})
    return messages


async def _generate_with_vision_degrade(provider, request, messages, ctx):
    """调 provider.generate，并对【非识图模型撞图片报错】做一次性优雅降级（同步路径）。

    带图请求若报错 且 错误像"不支持图片"（看 provider_error 里的 image_url/expected text 等）
    且 messages 里确实有图 → 把所有多模态 content 去图成纯文字（就地改共享 list，后续轮也不再带图）→
    用纯文字重试一次，并置 ctx.vision_degraded=True（拼最终答复处据此加温和提示）。
    其它错误 / 本就没图 / 重试仍失败 → 原样抛出（不吞错，行为与原来一致）。"""
    try:
        return await provider.generate(request)
    except Exception as e:
        if (ctx is not None
                and looks_like_vision_error(e)
                and messages_have_images(messages)
                and strip_images_from_messages(messages)):
            ctx.vision_degraded = True
            logger.info("文字模型疑似不支持图片(%s)，已去图改纯文字重试一次", type(e).__name__)
            return await provider.generate(request)
        raise


async def _vision_degrade_stream(provider, request, messages, ctx, **sinks):
    """流式版 generate_stream 的一次性优雅降级包装（异步生成器）。

    与同步版同理：第三方端点对【带图却不支持】的请求在【建流时】就抛 400（DeepSeekProvider 里 create() 先 await、
    报错发生在任何 token 之前）——故只要还【没吐过任何 token】就能安全去图重试，不会重复输出。
    一旦开始吐 token 再出错，则照常抛出（已无法干净重试）。"""
    yielded = False
    try:
        async for tok in provider.generate_stream(request, **sinks):
            yielded = True
            yield tok
    except Exception as e:
        if (not yielded
                and ctx is not None
                and looks_like_vision_error(e)
                and messages_have_images(messages)
                and strip_images_from_messages(messages)):
            ctx.vision_degraded = True
            logger.info("文字模型疑似不支持图片(%s)，已去图改纯文字重试一次(流式)", type(e).__name__)
            async for tok in provider.generate_stream(request, **sinks):
                yield tok
            return
        raise


_VIEW_FEEDBACK_MSG = "（这是刚才看屏/截图工具截取的屏幕画面，请据此判断与继续。）"


def _drain_view_images(messages: list[dict], ctx) -> None:
    """把工具产出、待回灌的图片（ctx.pending_view_images）拼成一条 user 图片消息追加进 messages，让模型真看见。

    ⚠️ 必须在【本批 tool 结果全部追加、tool_call 配对完整之后】调用——user 消息不能插在 tool 结果中间（破坏
    OpenAI 的 tool_call_id 配对）。走 build_user_content 的 image_url 通道（带原始尺寸标签、可被 vision_degrade
    接住）。取后清空 ctx.pending_view_images，防串到下一轮。故障安全：无图/编码全失败 → 不注入空消息。"""
    paths = list(getattr(ctx, "pending_view_images", None) or [])
    if not paths:
        return
    ctx.pending_view_images = []
    from services.agent.multimodal import build_user_content, is_image
    imgs = [p for p in paths if p and is_image(p)]
    if not imgs:
        return
    content = build_user_content(_VIEW_FEEDBACK_MSG, imgs)
    if isinstance(content, str):  # 没有任何图成功编码（build_user_content 退回纯串）→ 别注入空图消息
        return
    messages.append({"role": "user", "content": content})


_PLAN_MODE_SKIP_MSG = (
    "[计划模式] 现在只规划、不动手：「{name}」是会实际操作的步骤，已跳过。"
    "请先把完整、分步的计划讲清楚给老板；等老板切到执行模式或确认后再实际做。"
)


def _plan_tool_call(tc: dict, registry: ToolRegistry, ctx: AgentContext) -> _ToolPlan:
    """解析一个 tool_call 的入参，并据审批闸判定它该"待确认"还是"可直接执行"。
    审批闸（proposal 模式）：requires_approval 且未被 permission_mode 自动批准的工具不在循环里执行，
    改回灌"待确认"提示、让模型把方案讲给用户；用户确认后走独立的 /agent/execute 真正执行。"""
    tc_id = tc.get("id")
    fn = tc.get("function") or {}
    name = fn.get("name")
    args, parsed_ok = _parse_args_ex(fn.get("arguments"))
    # 入参被截断(非空却解析失败)：别拿空参去执行(会写空文件/反复重试同一超大写入→打转到502)，
    # 回灌"截断专属"指令让模型写精简/分次。这是 502 大文件 bug 的根治点。
    if not parsed_ok:
        return _ToolPlan(name=name, args={}, tool_call_id=tc_id,
                         error=_ARGS_TRUNCATED_MSG.format(name=name or "该工具"))

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
        # 计划模式(plan)：只规划不动手——只读工具放行去探索，会动手的(写文件/跑命令/对外/操作电脑等)一律不执行，
        # 回灌"计划模式下跳过"，让模型把完整计划讲给老板（对标 Claude Code 的 plan mode）。
        if getattr(ctx, "permission_mode", "") == "plan" and not getattr(tool, "read_only", False):
            return _ToolPlan(
                name=name, args=args, tool_call_id=tc_id, fallback=True,
                fallback_msg=_PLAN_MODE_SKIP_MSG.format(name=name),
            )
        needs_approval = tool.requires_approval
        if not needs_approval and callable(getattr(tool, "requires_approval_for", None)):
            try:
                needs_approval = tool.requires_approval_for(args, ctx)
            except Exception:
                logger.exception("动态审批钩子出错，保守弹卡: %s", name)
                needs_approval = True
        if needs_approval and not _auto_approve(tool, args, ctx):
            # SH-8 连续拒绝自动回退：同一动作老板已反复拒（或全局累计拒太多）→ 不再提请该动作，
            # 改回灌"这个先不做了、换个法子"，让模型走文本答复/替代方案，别没完没了地弹同一张确认卡。
            if _denial_fallback(name, args, ctx):
                return _ToolPlan(
                    name=name, args=args, tool_call_id=tc_id, fallback=True,
                    fallback_msg=_DENIAL_FALLBACK_MSG.format(name=name),
                )
            return _ToolPlan(
                name=name, args=args, tool_call_id=tc_id, needs_approval=True,
                pending_msg=_APPROVAL_PENDING_MSG.format(name=name),
                preview=_approval_preview(tool, args, ctx),
                reason=_build_approval_reason(tool, args, ctx),
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
    user_images: list[str] | None = None,
    max_turns: int = 8,
    max_tokens: int = _DEFAULT_AGENT_MAX_TOKENS,
    temperature: float = _ORCH_TEMPERATURE,
) -> AgentResult:
    provider = provider or ProviderFactory.get_orchestration_provider()
    model = model or settings.effective_orchestration_model
    ctx = ctx or AgentContext()
    # 子代理（run_subagent）递归跑时复用同一个 provider/model（同门店 BYOK key、同模型）。
    if getattr(ctx, "provider", None) is None:
        ctx.provider = provider
    if getattr(ctx, "model", None) is None:
        ctx.model = model

    messages = _init_messages(system_prompt, history, user_message, user_images)
    # 缺口 F：进循环前先 drain 一次【已存在】的待回灌图片。多数调用方此处 pending 为空、纯 no-op；
    # 唯一非空场景＝审批后 /agent/execute 先跑完写/处理类工具(edit_image 等已往 ctx.pending_view_images
    # 塞了图)再续接 run_agent_loop——若不在首调前 drain，模型这一轮看不到刚处理好的图(循环内 _drain
    # 只在每批 tool 结果之后触发，而续接的收尾轮常常不再调工具→永远 drain 不到)，append 就成了死代码。
    _drain_view_images(messages, ctx)
    tools = registry.to_openai_tools()
    steps: list[AgentStep] = []
    stop_blocked = False  # Stop hook 每轮最多阻断一次（防死循环；仍受 max_turns 兜底）
    final_segments: list[str] = []  # SH-4：被 length 截断的最终答复，多轮续写片段在此拼接
    continuations = 0               # SH-4：续写次数（防"一直被截一直续"死循环）

    for turn in range(1, max_turns + 1):
        # SH-6 三级压缩流水线（snip→microcompact→autocompact）：临近窗口才语义压、平时只清旧只读结果。
        # autocompact 可能重建前缀（唯一允许点）→ 用返回值重绑 messages（就地切片同步，保后续 append 落到新列表）。
        messages[:] = await _compact_pipeline(messages, registry, ctx, provider, model, temperature)
        # SH-1：发请求前补缺失/删孤儿/去重 tool_result，堵 OpenAI 兼容端点的配对 400（纯函数返回新列表，就地替换内容）。
        messages[:] = ensure_tool_pairing(messages)
        # 非识图模型撞图片报错 → 自动去图、纯文字重试一次（模型无关·反应式降级）；置 ctx.vision_degraded 供收尾加提示。
        resp = await _generate_with_vision_degrade(provider, TextRequest(
            messages=messages,
            tools=tools,
            tool_choice="auto",
            model=model,
            max_tokens=max_tokens,
            temperature=temperature,
        ), messages, ctx)
        # SH-2：累加本轮真实 token 用量（端点没返回则粗估），喂预算判定 + 成本看板。
        # Gap C：同时把真实输入 token(prompt_tokens)喂给 autocompact 触发判据(经 ctx.last_prompt_tokens)。
        _accumulate_usage(ctx, getattr(resp, "tokens_used", 0), resp.content or "",
                          prompt_tokens=getattr(resp, "prompt_tokens", 0) or 0)

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
                full_final = _finalize_text("".join(final_segments) + (resp.content or ""), ctx)
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
            full_final = _finalize_text("".join(final_segments) + (resp.content or ""), ctx)
            steps.append(AgentStep(type="final", content=full_final))
            return AgentResult(
                final_text=full_final, steps=steps, turns=turn,
                stopped_reason=_STOP_FINAL, messages=messages,
            )

        # M10 #1：截断续写途中模型改去调工具 → 之前收集的半截续写片段(final_segments)已被工具路径取代，
        # 清掉它，别让那截悬空半句被拼进最终答复（半句串台）。半截原文仍在 messages 里(模型保有上下文，下面会
        # append assistant)，最终答复由收敛轮的 resp.content 重新产出。续写计数 continuations 不清——它是"防一直
        # 被截一直续"的兜底上限，工具打断不该把它清零让上限重新放开（不清只会更早触顶、是安全方向）。
        # ⚠️ 流式路径 run_agent_loop_stream 同样逻辑，别只改一处。
        if final_segments:
            final_segments.clear()

        # 工具调用前可能带一段思考文本，记一笔
        if resp.content:
            steps.append(AgentStep(type="thinking", content=resp.content))

        # 把 assistant 的 tool_calls 原样回灌（下一轮模型需要看到自己调了什么）
        messages.append({"role": "assistant", "content": resp.content or "", "tool_calls": _sanitize_tool_calls(resp.tool_calls)})

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
            if plan.fallback:  # SH-8 连续拒绝回退：不提请该动作，回灌"换个法子"让模型走文本/替代方案
                steps.append(AgentStep(type="tool_result", tool_name=plan.name,
                                       tool_call_id=plan.tool_call_id, content=plan.fallback_msg))
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.fallback_msg})
                continue
            if plan.needs_approval:
                steps.append(AgentStep(type="approval_request", tool_name=plan.name, tool_args=plan.args,
                                       tool_call_id=plan.tool_call_id, preview=plan.preview, reason=plan.reason))
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

        # 工具产出图片回灌：本批 tool 结果已全部追加、配对完整 → 把截图等拼成一条 user 图片消息注入，让模型下一轮真看见。
        _drain_view_images(messages, ctx)

    # 达到 max_turns 仍未收敛（兜底，防止循环跑飞）：强制模型基于已有结果给最终答复，不返回空。
    logger.warning("agent loop 达到 max_turns=%s 仍未结束，强制收尾", max_turns)
    final_text = await _force_final_text(provider, messages, model, max_tokens, temperature, ctx=ctx)
    if ctx is not None and getattr(ctx, "vision_degraded", False):
        final_text = prepend_degrade_hint(final_text)
    steps.append(AgentStep(type="final", content=final_text))
    return AgentResult(final_text=final_text, steps=steps, turns=max_turns,
                       stopped_reason=_STOP_MAX_TURNS, messages=messages)


def _parse_args(raw) -> dict:
    return _parse_args_ex(raw)[0]


def _parse_args_ex(raw) -> tuple[dict, bool]:
    """解析工具入参，返回 (args, parsed_ok)。
    parsed_ok=False 仅当 raw 是【非空字符串但 JSON 解析失败】——多半是 content 等长字段撞上
    max_tokens 被截断（区别于"模型本就没给参数"的合法空参 {}）。调用方据此回灌"截断专属"指令让模型换策略。"""
    if isinstance(raw, dict):
        return raw, True
    if not raw or (isinstance(raw, str) and not raw.strip()):
        return {}, True
    try:
        parsed = json.loads(raw)
        return (parsed, True) if isinstance(parsed, dict) else ({}, True)
    except (ValueError, TypeError):
        logger.warning("工具入参解析失败(疑被截断)，回灌让模型精简/分次重试: %.120r", raw)
        return {}, False


def _sanitize_tool_calls(tool_calls):
    """回灌进消息历史前，把【解析不出(被截断)的 tool_call 参数】替换成 "{}"。
    防畸形 JSON 参数(content 太长被砍断)被原样重发给 provider → 触发 400/500；同时丢掉超长半截
    内容、缩小上下文。配合 _plan_tool_call 的"截断专属"回灌，让模型拿到干净历史 + 明确指令去重试。"""
    if not tool_calls:
        return tool_calls
    out = []
    for tc in tool_calls:
        fn = tc.get("function") or {}
        if _parse_args_ex(fn.get("arguments"))[1]:
            out.append(tc)
        else:
            out.append({**tc, "function": {**fn, "arguments": "{}"}})
    return out


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
    # 统一超时兜底：tool.timeout 优先（<=0 表示该工具不设兜底），否则全局 _DEFAULT_TOOL_TIMEOUT。
    to = tool.timeout if getattr(tool, "timeout", None) is not None else _DEFAULT_TOOL_TIMEOUT
    try:
        if to and to > 0:
            result = await asyncio.wait_for(tool.handler(args, ctx), timeout=to)
        else:
            result = await tool.handler(args, ctx)
    except (asyncio.TimeoutError, TimeoutError):  # 挂死兜底：掐断并回灌超时，让模型换路子，别卡死整轮
        logger.warning("工具执行超时(%.0fs)，已掐断: %s", to, name)
        return (f"[工具超时] {name} 跑了超过 {int(to)} 秒还没回，已自动掐断。"
                f"换个更小的输入/参数，或改用别的办法，别再用同样的方式重试。")
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


# G.1 单张内联图片的粗略 token 估值：多数视觉模型一图≈数百~数千 token。估算时按固定值计入，
# 绝不把 base64 图片正文当普通文本去数字符（base64 动辄几十万字符，会把估算抬到天文数字、且毫无意义）。
# Gap C：原 1000 偏低（高分辨率图常 1500~2500+），上调到 2000 让"带图的长对话"不被低估而漏触发压缩。
_IMG_TOKEN_EST = 2000


def _estimate_tokens(messages: list[dict]) -> int:
    """粗估 messages 占用的 token 数，分中英文计权——CJK（中/日/韩）一字≈1 token，英文/JSON/符号约 4 字符≈1 token。
    只为 autocompact 阈值判断服务（求"快且零依赖"）。旧版一律 //4 会把中文低估约 4 倍 → 顶满窗口还不触发压缩、
    真溢出；本产品以中文为主，故必须分别计权。多模态 content（list of parts）里的图片按 _IMG_TOKEN_EST 固定计入、
    不数 base64 正文（G.1：旧版 str(list) 会把内联图片要么严重低估、要么把 base64 当字符乱算）。
    任何取值异常都按 0 处理（绝不抛错拖垮主流程）。"""
    cjk = other = imgs = 0
    for m in messages:
        try:
            text = ""
            c = m.get("content")
            if isinstance(c, str):
                text += c
            elif isinstance(c, list):
                # 多模态 content：逐 part 处理——text 段计字符，image_url 段按固定 token 计、不数 base64 正文。
                for part in c:
                    if not isinstance(part, dict):
                        text += str(part)
                    elif part.get("type") == "image_url" or "image_url" in part:
                        imgs += 1
                    else:
                        text += str(part.get("text") or "")
            elif c is not None:
                text += str(c)
            tcs = m.get("tool_calls")
            if tcs:
                text += json.dumps(tcs, ensure_ascii=False)
            for ch in text:
                if "一" <= ch <= "鿿" or "぀" <= ch <= "ヿ" or "가" <= ch <= "힣":
                    cjk += 1
                else:
                    other += 1
        except (TypeError, ValueError):
            continue
    return cjk + other // 4 + imgs * _IMG_TOKEN_EST


def _split_for_autocompact(messages: list[dict], keep: int) -> int:
    """算出"较早段 / 最近段"的分界下标 idx：messages[:idx] 压成摘要、messages[idx:] 保留原文。
    规则（保 tool 配对完整 + system 不动）：
    - system 消息永远留在最前、不进摘要段（返回的 idx 至少跨过开头连续的 system）；
    - 最近至少保留 keep 条；
    - 分界不能落在 assistant(tool_calls)→role:tool 组的中间：若 messages[idx] 是 role:tool（孤儿尾），
      把 idx 往前挪到它所属 assistant 之前，确保最近段不以孤儿 tool_result 开头。
    返回 idx；idx<=system 段长度则表示"没有可压的较早段"（交调用方跳过）。"""
    n = len(messages)
    # 开头连续 system 段长度（system 不压）
    sys_end = 0
    while sys_end < n and messages[sys_end].get("role") == "system":
        sys_end += 1
    idx = n - keep
    if idx <= sys_end:
        return sys_end  # 没有足够的较早段可压
    # 若分界处是 role:tool（说明落在某组中间），往前挪到该组的 assistant 之前，避免孤儿尾
    while idx > sys_end and messages[idx].get("role") == "tool":
        idx -= 1
    # 此刻 messages[idx] 若是带 tool_calls 的 assistant，它属于最近段（连同其结果一起保留），无需再动；
    # 若往前挪过头到 sys_end，调用方会因较早段太短而跳过。
    return idx


def _render_transcript(old: list[dict]) -> str:
    """把待压缩的较早段渲染成可读文本喂给总结 prompt（角色 + 内容 + 工具调用名）。纯本地、零网络。"""
    lines: list[str] = []
    for m in old:
        role = m.get("role", "?")
        content = m.get("content") or ""
        if isinstance(content, str):
            text = content
        else:
            text = str(content)
        tcs = m.get("tool_calls")
        if tcs:
            names = ", ".join((tc.get("function") or {}).get("name", "?") for tc in tcs)
            text = (text + f" [调用工具: {names}]").strip()
        if text:
            lines.append(f"{role}: {text}")
    return "\n".join(lines)


async def _autocompact(messages: list[dict], ctx, provider, model, temperature: float) -> list[dict] | None:
    """SH-6 第三级：把较早的非近 N 轮消息压成一段摘要，重建出更短的 messages。
    成功返回新 messages（重建前缀，唯一允许点）；不值得压 / 摘要失败 → 返回 None（调用方用原 messages 继续）。
    故障安全：任何异常都吞掉返回 None，绝不让主循环崩。"""
    if ctx is None:
        return None
    window = getattr(ctx, "model_ctx_window", None)
    if not window or window <= 0:
        return None  # 未配窗口 = 不启用 autocompact（交互式默认）
    try:
        keep = max(1, int(getattr(ctx, "autocompact_keep", 12) or 12))
        idx = _split_for_autocompact(messages, keep)
        # system 段长度（重建时原样保留在最前）
        sys_end = 0
        while sys_end < len(messages) and messages[sys_end].get("role") == "system":
            sys_end += 1
        old = messages[sys_end:idx]
        if len(old) < _AUTOCOMPACT_MIN_OLD:
            return None  # 较早段太短，压它不划算 → 跳过（让前两级与窗口余量扛着）
        transcript = _render_transcript(old)
        if not transcript.strip():
            return None
        resp = await provider.generate(TextRequest(
            messages=[{"role": "user",
                       "content": _AUTOCOMPACT_SUMMARY_PROMPT.format(transcript=transcript)}],
            model=model,
            max_tokens=_AUTOCOMPACT_SUMMARY_MAX_TOKENS,
            temperature=temperature,
        ))
        summary = (resp.content or "").strip()
        if not summary:
            # 摘要 LLM 返回空 = 真失败（区别于"不值得压"）→ 计入连续失败，达上限即熔断
            ctx.autocompact_fail_streak = getattr(ctx, "autocompact_fail_streak", 0) + 1
            return None  # 别用空摘要顶掉历史，跳过
        # 重建：system 原样 + 一条摘要 assistant 消息 + 最近段原文。
        summary_msg = {"role": "assistant", "content": f"{_AUTOCOMPACT_SUMMARY_MARK}\n{summary}"}
        rebuilt = messages[:sys_end] + [summary_msg] + messages[idx:]
        ctx.autocompact_fail_streak = 0  # 压成功 → 清零连续失败计数
        # Gap C：复位真实 token 信号——刚压短了 messages，上一轮的大 prompt_tokens 已过时；
        # 若不清零，下一轮触发判据会拿这个旧大值立刻又压一次（双重压缩）。清零后退回估算，待下一轮真值重填。
        ctx.last_prompt_tokens = 0
        return rebuilt
    except Exception:
        # 摘要 LLM 抛错 = 真失败 → 计入连续失败，达上限即熔断（防顶满时每轮空烧一次昂贵 LLM）
        ctx.autocompact_fail_streak = getattr(ctx, "autocompact_fail_streak", 0) + 1
        logger.exception("autocompact 压缩失败，跳过、用原 messages 继续")
        return None


async def _compact_pipeline(messages: list[dict], registry: ToolRegistry, ctx,
                            provider, model, temperature: float) -> list[dict]:
    """SH-6 三级压缩有序流水线（每轮发请求前调一次）。返回当前应使用的 messages 列表。
    顺序铁律：snip(SH-3，已在工具执行时落盘) → microcompact(就地清旧只读结果) → autocompact(临近窗口才语义压)。
    - microcompact 就地改 messages（不重建前缀，省 token、零 LLM）；
    - 仅当估算 token 超过 窗口*ratio 时才走 autocompact（前两级省下的已反映在 _estimate_tokens 上，省下就不触发）。
    autocompact 返回 None（不启用/不值得/失败）→ 原 messages 不变。"""
    _microcompact(messages, registry)  # 第二级：清旧只读结果（就地，零 LLM）
    window = getattr(ctx, "model_ctx_window", None) if ctx is not None else None
    if not window or window <= 0:
        return messages  # 未配窗口 → autocompact 整段跳过（交互式零影响）
    # Gap C 阈值口径：max(窗口−buffer, 窗口×ratio)——大窗由固定 buffer 主导(接近满才压)、小窗由 ratio 兜底(不回归)。
    ratio = getattr(ctx, "autocompact_ratio", 0.7) or 0.7
    buffer = getattr(ctx, "autocompact_buffer", None) or _AUTOCOMPACT_BUFFER_TOKENS
    threshold = max(window - buffer, window * ratio)
    # Gap C 触发判据：用真实输入 token(若有)兜住估算误差——effective = max(估算, 上一轮真实 prompt_tokens)。
    # 估算反映"当前 messages"(catch 本轮新增的大块)，真值反映"上次发出时上下文多大"(catch 估算的系统性低估)，
    # 取 max 两头都不漏。压缩成功后真值会被 _autocompact 复位，避免旧的大真值在下一轮立刻再触发。
    effective = max(_estimate_tokens(messages), getattr(ctx, "last_prompt_tokens", 0) or 0)
    if effective < threshold:
        return messages  # 没临近窗口 → 不花那次昂贵 LLM，原样返回
    # 熔断：autocompact 已连续真失败 _AUTOCOMPACT_FAIL_MAX 次 → 不再每轮空烧昂贵摘要 LLM，直接用原 messages 继续。
    if getattr(ctx, "autocompact_fail_streak", 0) >= _AUTOCOMPACT_FAIL_MAX:
        return messages
    rebuilt = await _autocompact(messages, ctx, provider, model, temperature)  # 第三级：语义压（唯一重建前缀点）
    return rebuilt if rebuilt is not None else messages


async def _force_final_text(provider, messages: list[dict], model, max_tokens: int, temperature: float,
                            ctx=None) -> str:
    """max_turns 强制收尾（非流式）：追加"别再调工具、直接答"的提示再要一段答复。
    自身失败也不崩，走静态兜底，绝不返回空。带 ctx 时同样走非识图降级（去图重试一次）。"""
    messages.append({"role": "user", "content": _FORCE_FINAL_MSG})
    try:
        resp = await _generate_with_vision_degrade(provider, TextRequest(
            messages=messages, model=model, max_tokens=max_tokens, temperature=temperature,
        ), messages, ctx)
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
    user_images: list[str] | None = None,
    max_turns: int = 8,
    max_tokens: int = _DEFAULT_AGENT_MAX_TOKENS,
    temperature: float = _ORCH_TEMPERATURE,
    thinking: dict | None = None,
):
    """流式版 ReAct 循环：边跑边 yield 事件 dict，供 SSE 推给前端。
    thinking（F.2 思考强度）：如 {"type":"enabled"}/{"type":"disabled"}，透传进 TextRequest → provider 的 extra_body；
    None＝跟随模型默认（mimo 默认开思考）。归一由端点做（前端"开/关" → 这里的 enabled/disabled）。

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
    # 子代理（run_subagent）递归跑时复用同一个 provider/model（同门店 BYOK key、同模型）。
    if getattr(ctx, "provider", None) is None:
        ctx.provider = provider
    if getattr(ctx, "model", None) is None:
        ctx.model = model

    messages = _init_messages(system_prompt, history, user_message, user_images)
    tools = registry.to_openai_tools()
    stop_blocked = False  # Stop hook 每轮最多阻断一次（防死循环；仍受 max_turns 兜底）
    final_segments: list[str] = []  # SH-4：被 length 截断的最终答复，多轮续写片段在此拼接
    continuations = 0               # SH-4：续写次数（防"一直被截一直续"死循环）

    for turn in range(1, max_turns + 1):
        # SH-6 三级压缩流水线（snip→microcompact→autocompact）：临近窗口才语义压、平时只清旧只读结果。
        # ⚠️ 同步路径同样逻辑，别只改一处（见上面 run_agent_loop）。autocompact 可能重建前缀（唯一允许点）。
        messages[:] = await _compact_pipeline(messages, registry, ctx, provider, model, temperature)
        # SH-1：发请求前补缺失/删孤儿/去重 tool_result，堵 OpenAI 兼容端点的配对 400（纯函数返回新列表，就地替换内容）。
        messages[:] = ensure_tool_pairing(messages)
        sink: list[dict] = []
        finish: dict = {}  # SH-4：本轮 finish_reason 由 provider 写回（="length" = 被截断）
        usage: dict = {}   # SH-2：本轮 token 用量由 provider 写回（total_tokens 等），按请求独立避免并发串号
        parts: list[str] = []
        # 非识图模型撞图片报错 → 自动去图、纯文字重试一次（建流时即 400、尚未吐 token，可干净重试）；
        # 置 ctx.vision_degraded 供收尾加提示。⚠️ 同步路径同样逻辑，别只改一处。
        async for tok in _vision_degrade_stream(
            provider,
            TextRequest(messages=messages, tools=tools, tool_choice="auto", model=model,
                        max_tokens=max_tokens, temperature=temperature, thinking=thinking),
            messages, ctx,
            tool_calls_sink=sink,
            finish_sink=finish,
            usage_sink=usage,
        ):
            if isinstance(tok, ReasoningChunk):  # F.1 思考过程：只展示、不进正文 parts（不污染历史/不参与上下文）
                yield {"type": "reasoning", "content": tok.text}
                continue
            parts.append(tok)
            yield {"type": "token", "content": tok}
        text = "".join(parts)
        # SH-2：累加本轮真实 token 用量（端点没返回 total_tokens 则按 len//4 粗估），喂预算判定 + 成本看板。
        # Gap C：把真实输入 token(prompt_tokens，由 usage_sink 写回)喂给 autocompact 触发判据。
        _accumulate_usage(ctx, usage.get("total_tokens", 0) or 0, text,
                          prompt_tokens=usage.get("prompt_tokens", 0) or 0)

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
                full_final = _finalize_text("".join(final_segments) + text, ctx)
                ctx.final_messages = _trajectory_with_final(messages, text)  # 跨轮记忆：暴露完整轨迹供落盘
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
            full_final = _finalize_text("".join(final_segments) + text, ctx)
            ctx.final_messages = _trajectory_with_final(messages, text)  # 跨轮记忆：暴露完整轨迹供落盘
            yield {"type": "final", "content": full_final}
            yield {"type": "done", "turns": turn, "stopped_reason": _STOP_FINAL,
                   "tokens_used": getattr(ctx, "tokens_used", 0)}
            return

        # M10 #1：截断续写途中模型改去调工具 → 清掉旧的半截续写片段，别让它被拼进最终答复（半句串台）。
        # 同步路径 run_agent_loop 同样逻辑（见上）。半截原文仍随下面 assistant 消息留在 messages、模型保有上下文。
        if final_segments:
            final_segments.clear()

        # 工具调用轮：assistant(tool_calls) 回灌 → 逐个处理 → 结果回灌
        messages.append({"role": "assistant", "content": text, "tool_calls": _sanitize_tool_calls(sink)})
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
            if plan.fallback:  # SH-8 连续拒绝回退：不提请该动作，回灌"换个法子"让模型走文本/替代方案
                yield {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": plan.fallback_msg}
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.fallback_msg})
                continue
            if plan.needs_approval:
                # 审批闸（proposal 模式）：吐 approval_request 让前端弹确认，把"待确认"回灌让模型讲方案；
                # token 绑定本组 args，/agent/execute 校验防前端篡改（P3.2）。
                # SH-8：带结构化理由 reason{what/why/impact}，审批卡能说清"为什么要你确认"。
                yield {
                    "type": "approval_request", "tool": plan.name, "args": plan.args, "id": plan.tool_call_id,
                    "token": sign_approval(plan.name, plan.args),
                    "preview": plan.preview,
                    "reason": plan.reason,
                }
                yield {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": plan.pending_msg}
                messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": plan.pending_msg})
                continue

            # 先吐 tool_call 事件（前端即时显示"正在调 X"），再跑工具（可能慢），最后吐结果
            yield {"type": "tool_call", "tool": plan.name, "args": plan.args, "id": plan.tool_call_id}
            # 命令边跑边显示：挂一个 progress 通道给工具，执行期间把它推的 tool_progress 实时 yield 给前端
            # （借鉴 Claude Code 的 onProgress/pendingProgress：进度与最终结果分流、边跑边出）。
            _pq: asyncio.Queue = asyncio.Queue()
            ctx.progress_emit = lambda ev, _q=_pq, _id=plan.tool_call_id: _q.put_nowait({**ev, "id": _id})
            _exec = asyncio.create_task(_execute_tool(registry, plan.name, plan.args, ctx))
            _ka = 0
            try:
                while not _exec.done():
                    try:
                        yield await asyncio.wait_for(_pq.get(), timeout=0.15)
                        _ka = 0
                    except asyncio.TimeoutError:
                        _ka += 1
                        if _ka >= 33:
                            yield {"type": "keepalive"}
                            _ka = 0
                while not _pq.empty():  # 收尾把残余进度吐净
                    yield _pq.get_nowait()
                result = await _exec
            finally:
                ctx.progress_emit = None
            # B-2 依据可见：工具若注入了行业知识，把名字一并带进 tool_result 事件（前端成品卡显示「依据：…」）。
            # 取后立即复位，防串到下一个工具。⚠️ 同步路径同样要改，别只改一处（见上面 run_agent_loop）。
            _evt = {"type": "tool_result", "tool": plan.name, "id": plan.tool_call_id, "content": result}
            if ctx.last_knowledge_used:
                _evt["knowledge_used"] = ctx.last_knowledge_used
            ctx.last_knowledge_used = None
            yield _evt
            messages.append({"role": "tool", "tool_call_id": plan.tool_call_id, "content": result})

        # 工具产出图片回灌：本批 tool 结果已全部追加、配对完整 → 把截图等拼成一条 user 图片消息注入，让模型下一轮真看见。
        _drain_view_images(messages, ctx)

    # 达到 max_turns 仍未收敛：强制模型基于已有结果给最终答复（不再给工具），逐片流式吐出，不返回空。
    logger.warning("agent stream loop 达到 max_turns=%s 仍未结束，强制收尾", max_turns)
    messages.append({"role": "user", "content": _FORCE_FINAL_MSG})
    final_parts: list[str] = []
    try:
        async for tok in _vision_degrade_stream(
            provider,
            TextRequest(messages=messages, model=model, max_tokens=max_tokens, temperature=temperature),
            messages, ctx,
        ):
            final_parts.append(tok)
            yield {"type": "token", "content": tok}
    except Exception:  # 强制收尾失败也不崩，走静态兜底
        logger.exception("max_turns 强制收尾(流式)失败")
    final_text = "".join(final_parts).strip() or _FALLBACK_FINAL
    if ctx is not None and getattr(ctx, "vision_degraded", False):
        final_text = prepend_degrade_hint(final_text)
    # 跨轮记忆：暴露完整轨迹供落盘。剥掉刚 append 的 _FORCE_FINAL_MSG 内部催收语（不该进续接历史），补真·最终答复。
    _traj = (messages[:-1] if (messages and isinstance(messages[-1], dict)
                               and messages[-1].get("content") == _FORCE_FINAL_MSG) else messages)
    ctx.final_messages = _trajectory_with_final(_traj, final_text)
    yield {"type": "final", "content": final_text}
    yield {"type": "done", "turns": max_turns, "stopped_reason": _STOP_MAX_TURNS,
           "tokens_used": getattr(ctx, "tokens_used", 0)}
