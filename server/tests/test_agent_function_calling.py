"""P0.1 模型抽象层 function calling 回归测试。

锁住的关键不变量：
- TextRequest 能携带 tools/tool_choice
- DeepSeekProvider.generate 把 tools/tool_choice 透传进 SDK 调用
- 把 message.tool_calls 解析为 provider 无关的标准化 dict（可回灌进 messages）
- ⚠️ 核心坑：模型返回 tool_calls 但 content 为空时，绝不能把工具调用丢掉
  （旧 deepseek.py:75 的「空内容守卫」会把这种响应当空响应返回）
- 无工具调用时行为完全不变

测试用假 SDK client 注入 provider._client，绕过 _get_client（不碰真实 API、不花钱、不要 Key）。
异步用 asyncio.run 跑，不依赖 pytest-asyncio 插件。
"""
import asyncio
from types import SimpleNamespace

from services.ai.base import TextRequest
from services.ai.providers.deepseek import DeepSeekProvider


# ---- 假 SDK 响应构造 ----------------------------------------------------------

def _fake_response(content=None, tool_calls=None, finish_reason="stop", total_tokens=42):
    message = SimpleNamespace(content=content, tool_calls=tool_calls)
    choice = SimpleNamespace(message=message, finish_reason=finish_reason)
    usage = SimpleNamespace(total_tokens=total_tokens, prompt_tokens=10, completion_tokens=32)
    return SimpleNamespace(choices=[choice], usage=usage)


class _FakeCompletions:
    def __init__(self, response):
        self._response = response
        self.captured_kwargs = None

    async def create(self, **kwargs):
        self.captured_kwargs = kwargs
        return self._response


class _FakeClient:
    def __init__(self, response):
        self.chat = SimpleNamespace(completions=_FakeCompletions(response))


def _provider_with(response):
    p = DeepSeekProvider()
    p._client = _FakeClient(response)  # 绕过 _get_client，不碰真实 API/Key
    return p


SAMPLE_TOOLS = [{
    "type": "function",
    "function": {
        "name": "get_today",
        "description": "查这家店的今日运营推荐",
        "parameters": {"type": "object", "properties": {}},
    },
}]


def _raw_tool_call(name="get_today", arguments="{}", call_id="call_1"):
    return SimpleNamespace(
        id=call_id, type="function",
        function=SimpleNamespace(name=name, arguments=arguments),
    )


# ---- 测试 --------------------------------------------------------------------

def test_tools_passed_through_to_sdk():
    p = _provider_with(_fake_response(content="好的"))
    asyncio.run(p.generate(TextRequest(prompt="你好", tools=SAMPLE_TOOLS, tool_choice="auto")))
    kw = p._client.chat.completions.captured_kwargs
    assert kw["tools"] == SAMPLE_TOOLS
    assert kw["tool_choice"] == "auto"


def test_no_tools_means_no_tools_kwarg():
    """不带工具时不能往请求里塞 tools/tool_choice（避免影响普通生成路径）。"""
    p = _provider_with(_fake_response(content="好的"))
    asyncio.run(p.generate(TextRequest(prompt="你好")))
    kw = p._client.chat.completions.captured_kwargs
    assert "tools" not in kw
    assert "tool_choice" not in kw


def test_tool_calls_parsed_into_standardized_dict():
    p = _provider_with(_fake_response(
        content=None,
        tool_calls=[_raw_tool_call(name="get_today", arguments='{"x":1}', call_id="call_abc")],
        finish_reason="tool_calls",
    ))
    resp = asyncio.run(p.generate(TextRequest(prompt="今天干啥", tools=SAMPLE_TOOLS)))
    assert resp.tool_calls is not None and len(resp.tool_calls) == 1
    tc = resp.tool_calls[0]
    assert tc["id"] == "call_abc"
    assert tc["type"] == "function"
    assert tc["function"]["name"] == "get_today"
    assert tc["function"]["arguments"] == '{"x":1}'
    assert resp.finish_reason == "tool_calls"


def test_tool_calls_not_dropped_when_content_empty():
    """⚠️核心坑回归：content 为空 + 有 tool_calls 时，旧守卫会返回空响应、丢掉工具调用。"""
    p = _provider_with(_fake_response(
        content=None,
        tool_calls=[_raw_tool_call()],
        finish_reason="tool_calls",
    ))
    resp = asyncio.run(p.generate(TextRequest(prompt="今天干啥", tools=SAMPLE_TOOLS)))
    assert resp.tool_calls, "content 为空时工具调用被错误丢弃了"
    assert resp.content == ""  # 模型只调工具、不出文本是正常的


def test_plain_text_generation_unchanged():
    """没有工具调用的普通生成：行为与改造前一致。"""
    p = _provider_with(_fake_response(content="今天适合搞个充值活动", finish_reason="stop"))
    resp = asyncio.run(p.generate(TextRequest(prompt="给点建议")))
    assert resp.content == "今天适合搞个充值活动"
    assert resp.tool_calls is None
    assert resp.tokens_used == 42
