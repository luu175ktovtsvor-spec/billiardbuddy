"""P0.2 大脑可切换 + 每次调用模型覆写。

锁住：
- TextRequest.model 覆写：本次调用用指定模型（编排可用比生成更强的模型）
- 不传 model 时回落到 settings.text_model_name（现状不变）
- TextResponse.model 反映实际使用的模型
- 编排模型/provider 默认跟随生成（零配置 = 全 DeepSeek，不破坏现状），留好切 GLM 的位
- factory 提供编排大脑入口

同样用假 SDK client，不碰真实 API/Key。
"""
import asyncio
from types import SimpleNamespace

import services.ai  # noqa: F401  触发 provider 注册（deepseek/mock/openai）
from config import settings
from services.ai.base import TextRequest
from services.ai.providers.deepseek import DeepSeekProvider
from services.ai.factory import ProviderFactory


def _fake_response(content="ok"):
    message = SimpleNamespace(content=content, tool_calls=None)
    choice = SimpleNamespace(message=message, finish_reason="stop")
    usage = SimpleNamespace(total_tokens=5, prompt_tokens=3, completion_tokens=2)
    return SimpleNamespace(choices=[choice], usage=usage)


class _FakeCompletions:
    def __init__(self, response):
        self._response = response
        self.captured_kwargs = None

    async def create(self, **kwargs):
        self.captured_kwargs = kwargs
        return self._response


def _provider():
    p = DeepSeekProvider()
    p._client = SimpleNamespace(chat=SimpleNamespace(completions=_FakeCompletions(_fake_response())))
    return p


# ---- 非流式 model 覆写 --------------------------------------------------------

def test_request_model_override_used_in_call():
    p = _provider()
    asyncio.run(p.generate(TextRequest(prompt="x", model="deepseek-v4-pro")))
    assert p._client.chat.completions.captured_kwargs["model"] == "deepseek-v4-pro"


def test_request_model_defaults_to_settings():
    p = _provider()
    asyncio.run(p.generate(TextRequest(prompt="x")))
    assert p._client.chat.completions.captured_kwargs["model"] == settings.text_model_name


def test_response_model_reflects_override():
    p = _provider()
    resp = asyncio.run(p.generate(TextRequest(prompt="x", model="deepseek-v4-pro")))
    assert resp.model == "deepseek-v4-pro"


# ---- 流式 model 覆写 ----------------------------------------------------------

class _FakeStreamCompletions:
    def __init__(self):
        self.captured_kwargs = None

    async def create(self, **kwargs):
        self.captured_kwargs = kwargs

        async def _gen():
            yield SimpleNamespace(
                choices=[SimpleNamespace(delta=SimpleNamespace(content="hi", tool_calls=None))],
                usage=None,
            )

        return _gen()


def test_stream_uses_request_model():
    p = DeepSeekProvider()
    fake = _FakeStreamCompletions()
    p._client = SimpleNamespace(chat=SimpleNamespace(completions=fake))

    async def run():
        return [tok async for tok in p.generate_stream(TextRequest(prompt="x", model="deepseek-v4-pro"))]

    out = asyncio.run(run())
    assert fake.captured_kwargs["model"] == "deepseek-v4-pro"
    assert "".join(out) == "hi"


# ---- 编排模型配置 + factory --------------------------------------------------

def test_orchestration_defaults_follow_generation():
    """零配置时编排模型/provider 跟随生成模型（默认全 DeepSeek，不破坏现状）。"""
    assert settings.effective_orchestration_provider == settings.text_model_provider
    assert settings.effective_orchestration_model == settings.text_model_name


def test_get_orchestration_provider_resolves():
    prov = ProviderFactory.get_orchestration_provider()
    assert isinstance(prov, DeepSeekProvider)
