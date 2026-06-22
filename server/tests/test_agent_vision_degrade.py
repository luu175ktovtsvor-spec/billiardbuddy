"""非识图模型优雅降级（带图请求撞"模型不支持图片" → 去图、纯文字重试一次 + 温和提示）。

锁住：
- vision_degrade 纯函数：识别带图 content、识别"不支持图片"报错（含 provider 包裹的 AIProviderError）、去图拍平、加提示
- 同步 run_agent_loop：带图首调报 vision 错 → 去图重试成功 → ctx.vision_degraded=True → final 带提示
- 流式 run_agent_loop_stream：同上（建流时报错、尚未吐 token，可干净重试）
- 反例①：非 vision 错（如真·余额不足）不降级，原样抛出
- 反例②：messages 里本就没图 → 即便错误含 vision 关键词也不降级（避免误判把别的失败当降级）
- 模型无关：不依赖任何"识图/非识图模型清单"，纯靠"报错→去图重试"反应式
"""
import asyncio

import pytest

from core.exceptions import AIProviderError
from services.ai.base import TextRequest, TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.agent import vision_degrade as vd


# ════════════════════════ 纯函数层 ════════════════════════

def _img_msgs():
    """一条带图的 user 消息（OpenAI 兼容多模态 content）。"""
    return [{"role": "user", "content": [
        {"type": "text", "text": "看看这张图是什么"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ]}]


def test_messages_have_images():
    assert vd.messages_have_images(_img_msgs()) is True
    assert vd.messages_have_images([{"role": "user", "content": "纯文字"}]) is False
    assert vd.messages_have_images([]) is False


def test_looks_like_vision_error_on_raw_deepseek_400():
    # DeepSeek 实测：非识图模型撞 image_url → 400 这串
    e = ValueError("Failed to deserialize the JSON body into the target type: "
                   "messages[1].content[1]: unknown variant 'image_url', expected 'text'")
    assert vd.looks_like_vision_error(e) is True


def test_looks_like_vision_error_unwraps_provider_error():
    """关键：provider 把第三方 400 包成 AIProviderError，友好中文在 .message、
    原始 image_url 串藏在 .provider_error —— 必须深挖 provider_error 才认得出。"""
    raw = ValueError("unknown variant 'image_url', expected 'text'")
    wrapped = AIProviderError(message="AI 请求参数有误，请简化输入内容后重试",
                              status_code=400, provider_error=raw)
    assert vd.looks_like_vision_error(wrapped) is True


def test_looks_like_vision_error_negative():
    # 余额不足 / 限流 / 一般报错都不是 vision 错
    assert vd.looks_like_vision_error(AIProviderError(
        message="AI 服务余额不足，请联系管理员充值", status_code=503,
        provider_error=ValueError("Insufficient Balance"))) is False
    assert vd.looks_like_vision_error(ValueError("rate limit exceeded")) is False
    assert vd.looks_like_vision_error(None) is False


def test_strip_images_flattens_to_text():
    msgs = _img_msgs()
    changed = vd.strip_images_from_messages(msgs)
    assert changed is True
    assert msgs[0]["content"] == "看看这张图是什么"  # 留 text、去 image_url
    # 再来一次：已无图 → 不改、返回 False
    assert vd.strip_images_from_messages(msgs) is False


def test_strip_images_empty_text_gets_placeholder():
    msgs = [{"role": "user", "content": [
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
    ]}]  # 只发了图、没文字
    vd.strip_images_from_messages(msgs)
    assert isinstance(msgs[0]["content"], str) and msgs[0]["content"].strip()  # 给了占位、非空


def test_prepend_degrade_hint():
    out = vd.prepend_degrade_hint("这是正文")
    assert out.startswith(vd.VISION_DEGRADED_HINT)
    assert "这是正文" in out
    # 不重复加
    assert vd.prepend_degrade_hint(out) == out


# ════════════════════════ 循环集成层 ════════════════════════

def _reg():
    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x",
                      parameters={"type": "object", "properties": {}}, handler=lambda a, c: None))
    return reg


class _FailFirstVisionProvider(MockTextProvider):
    """第一次调用（messages 里有图）→ 抛 vision 错；之后（已去图）→ 正常答复。
    用来驱动"去图重试一次"的集成测试。记录每次调用时 messages 是否带图，便于断言去图生效。"""

    def __init__(self, reply="这看起来像一张图片", err=None):
        super().__init__(scripted=None)
        self._reply = reply
        self._calls = 0
        self.saw_image_on_call = []  # 每次调用时 messages 是否含图
        self._err = err or AIProviderError(
            message="AI 请求参数有误，请简化输入内容后重试", status_code=400,
            provider_error=ValueError("unknown variant 'image_url', expected 'text'"))

    def _has_img(self, request: TextRequest) -> bool:
        return vd.messages_have_images(request.messages or [])

    async def generate(self, request: TextRequest) -> TextResponse:
        self._calls += 1
        has = self._has_img(request)
        self.saw_image_on_call.append(has)
        if has:
            raise self._err
        return TextResponse(content=self._reply, model="mock", finish_reason="stop")

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        self._calls += 1
        has = self._has_img(request)
        self.saw_image_on_call.append(has)
        if has:
            raise self._err
        if finish_sink is not None:
            finish_sink["finish_reason"] = "stop"
        yield self._reply


def _run_with_image_history(provider, ctx):
    """绕过文件依赖：直接用 history 注入一条带图 user 消息（content 数组含 image_url），
    再发一句纯文字 user_message —— messages 里就含图，触发降级链路。"""
    history = [{"role": "user", "content": [
        {"type": "text", "text": "这张图"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}},
    ]}]
    return asyncio.run(run_agent_loop(
        user_message="看看这张图是什么", registry=_reg(), provider=provider, ctx=ctx,
        history=history))


def test_sync_degrade_end_to_end():
    provider = _FailFirstVisionProvider(reply="这是一张台球桌的照片")
    ctx = AgentContext()
    res = _run_with_image_history(provider, ctx)
    # ① 没整个失败、出了文字结果
    assert "台球桌" in res.final_text
    # ② 触发了降级提示
    assert vd.VISION_DEGRADED_HINT in res.final_text
    assert ctx.vision_degraded is True
    # ③ 第一次带图(报错)、第二次已去图(成功) —— 证明"去图重试"
    assert provider.saw_image_on_call == [True, False]


def test_sync_non_vision_error_not_degraded():
    """真·余额不足这类非 vision 错 → 不降级、原样抛出（不吞错）。"""
    boom = AIProviderError(message="AI 服务余额不足，请联系管理员充值", status_code=503,
                           provider_error=ValueError("Insufficient Balance"))

    class _AlwaysBalanceErr(MockTextProvider):
        async def generate(self, request):
            raise boom

    ctx = AgentContext()
    with pytest.raises(AIProviderError):
        asyncio.run(run_agent_loop(
            user_message="x", registry=_reg(), provider=_AlwaysBalanceErr(), ctx=ctx,
            history=[{"role": "user", "content": [
                {"type": "text", "text": "图"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            ]}]))
    assert ctx.vision_degraded is False


def test_sync_no_image_vision_keyword_not_degraded():
    """messages 本就没图 → 即便错误含 vision 关键词也不降级（避免误判），原样抛出。"""
    err = AIProviderError(message="AI 请求参数有误", status_code=400,
                          provider_error=ValueError("unknown variant 'image_url', expected 'text'"))

    class _NoImgButVisionErr(MockTextProvider):
        async def generate(self, request):
            raise err

    ctx = AgentContext()
    with pytest.raises(AIProviderError):
        asyncio.run(run_agent_loop(
            user_message="纯文字请求", registry=_reg(), provider=_NoImgButVisionErr(), ctx=ctx))
    assert ctx.vision_degraded is False


# ---------- 流式 ----------

async def _collect(agen):
    return [ev async for ev in agen]


def test_stream_degrade_end_to_end():
    provider = _FailFirstVisionProvider(reply="这是一张台球桌的照片")
    ctx = AgentContext()
    history = [{"role": "user", "content": [
        {"type": "text", "text": "这张图"},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,iVBORw0KGgo="}},
    ]}]
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="看看这张图是什么", registry=_reg(), provider=provider, ctx=ctx,
        history=history)))
    final = [e for e in events if e["type"] == "final"]
    # ① 出了文字结果、② 带降级提示
    assert final and "台球桌" in final[0]["content"]
    assert vd.VISION_DEGRADED_HINT in final[0]["content"]
    assert ctx.vision_degraded is True
    # ③ 去图重试：首调带图(报错)、二调无图(成功)
    assert provider.saw_image_on_call == [True, False]
    # token 也流出了去图后的正文
    tokens = "".join(e["content"] for e in events if e["type"] == "token")
    assert "台球桌" in tokens


def test_stream_non_vision_error_not_degraded():
    boom = AIProviderError(message="AI 服务余额不足", status_code=503,
                           provider_error=ValueError("Insufficient Balance"))

    class _AlwaysBalanceErr(MockTextProvider):
        async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
            raise boom
            yield  # pragma: no cover  (让它是 async generator)

    ctx = AgentContext()
    with pytest.raises(AIProviderError):
        asyncio.run(_collect(run_agent_loop_stream(
            user_message="x", registry=_reg(), provider=_AlwaysBalanceErr(), ctx=ctx,
            history=[{"role": "user", "content": [
                {"type": "text", "text": "图"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}},
            ]}])))
    assert ctx.vision_degraded is False
