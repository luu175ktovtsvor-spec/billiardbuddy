"""F8甲 · 结构性"上下文/token 超限"错误自愈（safety net：强制压一次 + 重试一次）。

锁住：
- context_overflow 纯函数：识别 OpenAI/DeepSeek/Kimi/GLM 各家真实报错原文（已核实来源，见模块 docstring）、
  识别结构化 code=context_length_exceeded、深挖 provider_error 包裹层；反例：余额/限流/vision 错都不误判。
- 同步 run_agent_loop：首调撞"超限"错 → 强制压缩(_autocompact)一次 + 重试成功 → 拿到最终答复，只重试一次。
- 流式 run_agent_loop_stream：同上（建流时报错、尚未吐 token，可干净重试）。
- 反例①：非超限错（如真·余额不足）不触发这个自愈，原样抛出，且【只调了一次 provider】（没有多余重试）。
- 反例②：超限错但 ctx 没配 model_ctx_window（_autocompact 直接返回 None、压不了）→ 强制压缩失败 → 原样抛出
  （"仍失败才走既有兜底"）。
- _force_recompact 单元：压成功置 ctx.just_autocompacted=True 且替换 messages；压不了返回 False、不崩。
"""
import asyncio

import pytest

from core.exceptions import AIProviderError
from services.ai.base import TextRequest, TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop, run_agent_loop_stream, _force_recompact, _AUTOCOMPACT_SUMMARY_MARK
from services.agent.registry import Tool, ToolRegistry
from services.agent import context_overflow as co


# ════════════════════════ 纯函数层 ════════════════════════

def test_looks_like_context_overflow_on_openai_message():
    # OpenAI 官方文档确认的报错原文（type=invalid_request_error, code=context_length_exceeded）
    e = ValueError("This model's maximum context length is 4097 tokens. However, you requested 4927 "
                   "tokens (3927 in the messages, 1000 in the completion). Please reduce the length "
                   "of the messages or completion.")
    assert co.looks_like_context_overflow_error(e) is True


def test_looks_like_context_overflow_on_deepseek_message():
    # DeepSeek（OpenAI 兼容端点）实测同款措辞（GitHub issue 原文核实）
    e = ValueError("This model's maximum context length is 65536 tokens. However, you requested "
                   "190402 tokens (182402 in the messages, 8000 in the completion). Please reduce "
                   "the length of the messages or completion.")
    assert co.looks_like_context_overflow_error(e) is True


def test_looks_like_context_overflow_on_kimi_message():
    # Moonshot/Kimi 实测报错原文（GitHub issue 核实）
    e = ValueError("Invalid request: Your request exceeded model token limit: 262144 (requested: 269030)")
    assert co.looks_like_context_overflow_error(e) is True


def test_looks_like_context_overflow_on_glm_chinese_message():
    # 智谱 GLM 官方错误码文档核实：错误码 1261 / HTTP 400 → "Prompt 超长"
    e = ValueError("Prompt 超长")
    assert co.looks_like_context_overflow_error(e) is True


def test_looks_like_context_overflow_structured_code():
    """结构化信号优先：openai SDK 异常的 .code == context_length_exceeded，即便报错文本本身
    不含任何关键词也该命中（本项目实际走 openai SDK 的 APIStatusError，body.code 就是这个字段）。"""
    class _FakeAPIError(Exception):
        def __init__(self, message, code=None):
            super().__init__(message)
            self.message = message
            self.code = code

    e = _FakeAPIError("请求失败", code="context_length_exceeded")
    assert co.looks_like_context_overflow_error(e) is True


def test_looks_like_context_overflow_unwraps_provider_error():
    """provider 把第三方 400 包成 AIProviderError，真实报错串藏在 .provider_error —— 必须深挖才认得出
    （与 vision_degrade 同一模式，因为 deepseek.py 的 _classify_api_error 对所有 400 都这样包）。"""
    raw = ValueError("This model's maximum context length is 8000 tokens. However, you requested "
                     "12000 tokens. Please reduce the length of the messages or completion.")
    wrapped = AIProviderError(message="AI 请求参数有误，请简化输入内容后重试",
                              status_code=400, provider_error=raw)
    assert co.looks_like_context_overflow_error(wrapped) is True


def test_looks_like_context_overflow_negative():
    """余额不足 / 限流 / None 都不是超限错——别把普通错误也当成超限重试一次。"""
    assert co.looks_like_context_overflow_error(AIProviderError(
        message="AI 服务余额不足，请联系管理员充值", status_code=503,
        provider_error=ValueError("Insufficient Balance"))) is False
    assert co.looks_like_context_overflow_error(ValueError("rate limit exceeded")) is False
    assert co.looks_like_context_overflow_error(None) is False


def test_looks_like_context_overflow_does_not_confuse_vision_error():
    """vision 错和超限错是两个不同的关注点——vision 错误文本(image_url/expected text)不该被误判成超限。"""
    e = ValueError("unknown variant 'image_url', expected 'text'")
    assert co.looks_like_context_overflow_error(e) is False


# ════════════════════════ _force_recompact 单元 ════════════════════════

def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    return reg


def _long_history(n_pairs: int, chunk: int = 4000) -> list[dict]:
    """造一段超长 user/assistant 来回（每条 chunk 字，够 _autocompact 的"较早段"值得压）。"""
    msgs: list[dict] = [{"role": "system", "content": "你是台球房运营助手"}]
    for i in range(n_pairs):
        msgs.append({"role": "user", "content": f"老板诉求{i}：" + "啊" * chunk})
        msgs.append({"role": "assistant", "content": f"助手答复{i}：" + "好" * chunk})
    return msgs


def test_force_recompact_success_sets_flag_and_replaces_messages():
    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=6)  # 窗口够大，常规阈值判据不会触发
    provider = MockTextProvider(scripted=[TextResponse(content="精简摘要", model="mock")])
    msgs = _long_history(10)
    before_len = len(msgs)
    ok = asyncio.run(_force_recompact(msgs, ctx, provider, "mock", 0.3))
    assert ok is True
    assert len(msgs) < before_len          # 就地压短
    assert ctx.just_autocompacted is True  # F9 信号复用
    assert any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in msgs)


def test_force_recompact_fails_gracefully_without_window():
    """没配 model_ctx_window → _autocompact 直接跳过（不启用）→ 强制压缩也压不了，故障安全返回 False。"""
    ctx = AgentContext(model_ctx_window=None)
    provider = MockTextProvider(scripted=[TextResponse(content="摘要", model="mock")])
    msgs = _long_history(10)
    before = list(msgs)
    ok = asyncio.run(_force_recompact(msgs, ctx, provider, "mock", 0.3))
    assert ok is False
    assert msgs == before  # 没被动过
    assert ctx.just_autocompacted is False


# ════════════════════════ 循环集成层 ════════════════════════

class _FailFirstOverflowProvider(MockTextProvider):
    """主答复第一次调用抛"结构性超限"错；force-recompact 内部驱动的摘要调用（识别 prompt 特征）正常返回；
    主答复第二次(重试)调用成功。用来驱动"强制压缩+重试一次"的端到端集成测试。"""

    def __init__(self, reply="收到，已帮你处理好了", err=None):
        super().__init__(scripted=None)
        self._reply = reply
        self.main_calls = 0
        self._err = err or AIProviderError(
            message="AI 请求参数有误，请简化输入内容后重试", status_code=400,
            provider_error=ValueError(
                "This model's maximum context length is 65536 tokens. However, you requested "
                "190402 tokens (182402 in the messages, 8000 in the completion). Please reduce "
                "the length of the messages or completion."))

    @staticmethod
    def _is_summary_request(request: TextRequest) -> bool:
        msgs = request.messages or []
        return len(msgs) == 1 and "较早对话记录" in (msgs[0].get("content") or "")

    async def generate(self, request: TextRequest) -> TextResponse:
        if self._is_summary_request(request):
            return TextResponse(content="此前要点：老板要一周文案，已产出大半，待办收尾", model="mock")
        self.main_calls += 1
        if self.main_calls == 1:
            raise self._err
        return TextResponse(content=self._reply, model="mock", finish_reason="stop")

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        self.main_calls += 1
        if self.main_calls == 1:
            raise self._err
        if finish_sink is not None:
            finish_sink["finish_reason"] = "stop"
        yield self._reply


def test_sync_context_overflow_recovers_via_forced_compaction():
    provider = _FailFirstOverflowProvider(reply="这是最终答复")
    # 窗口设够大：常规每轮阈值判据(_compact_pipeline)不会触发，只有 F8甲 安全网在报错后强制触发一次。
    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=6)
    history = _long_history(10)[1:]  # 去掉 system（loop 自己加 system_prompt）
    res = asyncio.run(run_agent_loop(
        user_message="继续完成", registry=_reg(), provider=provider, ctx=ctx,
        system_prompt="你是台球房助手", history=history, max_turns=5))
    assert res.final_text == "这是最终答复"
    assert provider.main_calls == 2  # 第一次超限报错 + 第二次(压缩后)重试成功，只重试一次
    assert any(_AUTOCOMPACT_SUMMARY_MARK in (m.get("content") or "") for m in res.messages)


def test_stream_context_overflow_recovers_via_forced_compaction():
    provider = _FailFirstOverflowProvider(reply="流式最终答复")
    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=6)
    history = _long_history(10)[1:]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="继续", registry=_reg(), provider=provider, ctx=ctx,
        system_prompt="sys", history=history, max_turns=5)))
    final = [e for e in events if e["type"] == "final"][0]
    assert final["content"] == "流式最终答复"
    assert provider.main_calls == 2
    done = [e for e in events if e["type"] == "done"][0]
    assert done["stopped_reason"] == "final"


def test_sync_non_overflow_error_not_recovered():
    """真·余额不足这类非超限错 → 不触发这个自愈，原样抛出，且没有多打一次重试(只调了一次 provider)。"""
    boom = AIProviderError(message="AI 服务余额不足，请联系管理员充值", status_code=503,
                           provider_error=ValueError("Insufficient Balance"))
    calls = {"n": 0}

    class _AlwaysBalanceErr(MockTextProvider):
        async def generate(self, request):
            calls["n"] += 1
            raise boom

    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=6)
    with pytest.raises(AIProviderError):
        asyncio.run(run_agent_loop(
            user_message="x", registry=_reg(), provider=_AlwaysBalanceErr(), ctx=ctx,
            history=_long_history(10)[1:]))
    assert calls["n"] == 1  # 没有触发"强制压缩+重试"这条自愈路径
    assert ctx.just_autocompacted is False


def test_stream_non_overflow_error_not_recovered():
    boom = AIProviderError(message="AI 服务余额不足", status_code=503,
                           provider_error=ValueError("Insufficient Balance"))
    calls = {"n": 0}

    class _AlwaysBalanceErr(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            calls["n"] += 1
            raise boom
            yield  # pragma: no cover  (让它是 async generator)

    ctx = AgentContext(model_ctx_window=1_000_000, autocompact_keep=6)
    with pytest.raises(AIProviderError):
        asyncio.run(_collect(run_agent_loop_stream(
            user_message="x", registry=_reg(), provider=_AlwaysBalanceErr(), ctx=ctx,
            history=_long_history(10)[1:])))
    assert calls["n"] == 1
    assert ctx.just_autocompacted is False


def test_sync_context_overflow_without_window_falls_through_to_existing_fallback():
    """超限错命中判定，但 ctx 没配 model_ctx_window → 强制压缩压不了(_force_recompact 返回 False)→
    走"仍失败才走既有兜底"：原样抛出，不吞、不假装成功。"""
    ctx = AgentContext(model_ctx_window=None)
    err = AIProviderError(
        message="AI 请求参数有误，请简化输入内容后重试", status_code=400,
        provider_error=ValueError("This model's maximum context length is 8000 tokens. "
                                  "Please reduce the length of the messages or completion."))

    class _AlwaysOverflow(MockTextProvider):
        async def generate(self, request):
            raise err

    with pytest.raises(AIProviderError):
        asyncio.run(run_agent_loop(
            user_message="x", registry=_reg(), provider=_AlwaysOverflow(), ctx=ctx,
            history=_long_history(10)[1:]))


async def _collect(agen):
    return [ev async for ev in agen]
