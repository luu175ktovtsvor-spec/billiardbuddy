"""F9 · 上下文快满时的大白话提示（`context_note` 事件；只在流式循环里、autocompact 真重建时才发一次）。

锁住：
- 真触发常规 autocompact（临近窗口）→ 恰好一条 context_note，措辞大白话不带机制黑话，出现在 final 之前。
- 未配窗口（autocompact 整段不启用） / 窗口够大没临近阈值 → 都不该有 context_note。
- 发完即清标记，不会跨轮重复吐（ctx.just_autocompacted 用后复位）。
- 已知边界：F8甲 安全网触发的压缩若发生在【本轮就收敛】的最后一轮，因为检查点在轮次开头、
  这次压缩晚于检查点，这条大白话提示这一轮不会冒出来（不影响压缩本身与答复正确性，仅提示滞后/缺席）。
"""
import asyncio

from core.exceptions import AIProviderError
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop_stream, _CONTEXT_NOTE_MSG
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


def _long_history(n_pairs: int, chunk: int = 4000) -> list[dict]:
    msgs: list[dict] = [{"role": "system", "content": "你是台球房运营助手"}]
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"老板诉求{i}：" + "啊" * chunk})
        msgs.append({"role": "assistant", "content": f"助手答复{i}：" + "好" * chunk})
    return msgs


async def _collect(agen):
    return [ev async for ev in agen]


def test_stream_emits_context_note_once_on_real_autocompact():
    """真触发常规 autocompact（临近窗口）→ 恰好一条 context_note、大白话措辞、在 final 之前，用后清标记。"""
    class _P(MockTextProvider):
        async def generate(self, request):  # autocompact 摘要
            return TextResponse(content="此前要点摘要", model="mock")

        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "流式最终答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"

    ctx = AgentContext(model_ctx_window=8000, autocompact_keep=6)
    history = _long_history(10)[1:]  # 去掉 system（loop 自己加 system_prompt）
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="继续", registry=_reg(), provider=_P(), ctx=ctx,
        system_prompt="sys", history=history, max_turns=5)))
    notes = [e for e in events if e["type"] == "context_note"]
    assert len(notes) == 1
    assert notes[0]["content"] == _CONTEXT_NOTE_MSG
    # 大白话：不带机制黑话（owner 铁律——前端不露 token/compact/摘要这类词）
    for word in ("token", "compact", "摘要", "上下文", "autocompact", "窗口"):
        assert word not in notes[0]["content"]
    # 顺序：压缩发生在拿到答复之前 → context_note 早于 final
    note_idx = events.index(notes[0])
    final_idx = next(i for i, e in enumerate(events) if e["type"] == "final")
    assert note_idx < final_idx
    assert ctx.just_autocompacted is False  # 发完即清，不留尾巴


def test_stream_no_context_note_when_autocompact_disabled():
    """未配 model_ctx_window → autocompact 整段跳过（交互式默认）→ 不该有 context_note。"""
    class _P(MockTextProvider):
        async def generate(self, request):
            return TextResponse(content="摘要", model="mock")

        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"

    ctx = AgentContext(model_ctx_window=None)
    history = _long_history(10)[1:]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="x", registry=_reg(), provider=_P(), ctx=ctx,
        history=history, max_turns=5)))
    assert not [e for e in events if e["type"] == "context_note"]


def test_stream_no_context_note_when_under_threshold():
    """窗口配了但估算远没到阈值 → 不触发 autocompact、也不该有 context_note（不花那次昂贵 LLM）。"""
    class _P(MockTextProvider):
        async def generate(self, request):
            return TextResponse(content="摘要", model="mock")

        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            yield "答复"
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"

    ctx = AgentContext(model_ctx_window=1_000_000)  # 窗口巨大，永远不临近
    history = _long_history(3)[1:]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="x", registry=_reg(), provider=_P(), ctx=ctx,
        history=history, max_turns=5)))
    assert not [e for e in events if e["type"] == "context_note"]


def test_stream_safety_net_recompact_note_not_emitted_within_same_turn():
    """已知边界行为（非 bug，报告已记）：F8甲 安全网的强制压缩发生在【本轮报错重试】分支里，晚于
    本轮开头唯一的 context_note 检查点；若这轮恰好就收敛（没有下一轮的检查点），这次压缩就不会
    冒出大白话提示——只影响"提示露不露出来"，不影响压缩本身生效、也不影响最终答复正确。"""
    class _FailFirstOverflow(MockTextProvider):
        def __init__(self):
            super().__init__()
            self.main_calls = 0

        async def generate(self, request):  # 只会被 force-recompact 内部调一次（摘要）
            return TextResponse(content="摘要", model="mock")

        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            self.main_calls += 1
            if self.main_calls == 1:
                raise AIProviderError(
                    message="AI 请求参数有误，请简化输入内容后重试", status_code=400,
                    provider_error=ValueError(
                        "This model's maximum context length is 65536 tokens. Please reduce the "
                        "length of the messages or completion."))
            if finish_sink is not None:
                finish_sink["finish_reason"] = "stop"
            yield "最终答复"

    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=6)  # 窗口够大，常规阈值判据不触发
    history = _long_history(10)[1:]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="继续", registry=_reg(), provider=_FailFirstOverflow(), ctx=ctx,
        history=history, max_turns=5)))
    final = [e for e in events if e["type"] == "final"][0]
    assert final["content"] == "最终答复"  # 安全网确实救回来了、答复没受影响
    assert not [e for e in events if e["type"] == "context_note"]  # 但这轮没有下一次检查点，提示没冒出来
    assert ctx.just_autocompacted is True  # 标记还留着（没被清）：若还有下一轮会在那时候补上
