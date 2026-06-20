"""BYOK 供应商自动容灾（s11）：某家限流/挂了 → 自动切下一套配置档重试本次调用，老板请求不崩。

锁住：
- generate：可容灾错误(429/5xx/超时)→ 切下一套成功；不可容灾(400)→ 不切直接抛；切满上限 → 抛。
- generate_stream：未吐 token 前可切；已吐 token 后不切（已展示的半段不能吞回去）。
- build_resilient_text_provider：BYOK + ≥2 套有 key 才包；否则原样返回（零行为变化）。
- _make_switch：真把 store.byok_* 换成下一套 + 更新激活指针；切过的不回头。
"""
import asyncio

import pytest

from core.exceptions import AIProviderError
from services.ai.base import TextProvider, TextRequest, TextResponse
from services.ai.failover import (
    FailoverTextProvider, build_resilient_text_provider, _make_switch, _MAX_SWITCHES,
)


class _FakeProvider(TextProvider):
    """可编程假 provider：generate 抛指定错误或成功；generate_stream 可选"先吐 token 再抛"。"""

    def __init__(self, name, err=None, tokens=None, yield_before_err=False):
        self.name = name
        self.err = err
        self.tokens = tokens if tokens is not None else [f"[{name}]"]
        self.yield_before_err = yield_before_err
        self.gen_calls = 0

    async def generate(self, request):
        self.gen_calls += 1
        if self.err:
            raise self.err
        return TextResponse(content=f"[{self.name}]ok", model=self.name)

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        self.gen_calls += 1
        if self.err and not self.yield_before_err:
            raise self.err
        for t in self.tokens:
            yield t
        if self.err and self.yield_before_err:
            raise self.err


def _req():
    return TextRequest(messages=[{"role": "user", "content": "x"}], model="m")


def _switch_to(*providers):
    seq = list(providers)

    def switch():
        return seq.pop(0) if seq else None

    return switch


async def _collect_stream(fp, sink=None):
    out = []
    async for t in fp.generate_stream(_req()):
        out.append(t)
        if sink is not None:
            sink.append(t)
    return out


# ---------- generate ----------

def test_generate_switches_on_retryable():
    bad = _FakeProvider("bad", err=AIProviderError("限流", status_code=429))
    good = _FakeProvider("good")
    fp = FailoverTextProvider(bad, _switch_to(good))
    resp = asyncio.run(fp.generate(_req()))
    assert resp.content == "[good]ok"
    assert bad.gen_calls == 1 and good.gen_calls == 1


def test_generate_no_switch_on_non_retryable():
    bad = _FakeProvider("bad", err=AIProviderError("请求本身错", status_code=400))
    good = _FakeProvider("good")
    fp = FailoverTextProvider(bad, _switch_to(good))
    with pytest.raises(AIProviderError) as ei:
        asyncio.run(fp.generate(_req()))
    assert ei.value.status_code == 400
    assert good.gen_calls == 0  # 400 不可容灾 → 不切


def test_generate_gives_up_after_max_switches():
    err = AIProviderError("过载", status_code=529)
    head = _FakeProvider("b0", err=err)
    tail = [_FakeProvider(f"b{i}", err=err) for i in range(1, _MAX_SWITCHES + 2)]
    fp = FailoverTextProvider(head, _switch_to(*tail))
    with pytest.raises(AIProviderError):
        asyncio.run(fp.generate(_req()))
    # 试了 1(初) + _MAX_SWITCHES 个就放弃，剩下的没被触达
    assert sum(p.gen_calls for p in [head] + tail) == _MAX_SWITCHES + 1


def test_generate_gives_up_when_no_more_profiles():
    bad = _FakeProvider("bad", err=AIProviderError("超时", status_code=504))
    fp = FailoverTextProvider(bad, _switch_to())  # switch 立刻返回 None（没备用档）
    with pytest.raises(AIProviderError):
        asyncio.run(fp.generate(_req()))
    assert bad.gen_calls == 1


# ---------- generate_stream ----------

def test_stream_switches_before_any_token():
    bad = _FakeProvider("bad", err=AIProviderError("网关错", status_code=502))
    good = _FakeProvider("good", tokens=["你好", "世界"])
    fp = FailoverTextProvider(bad, _switch_to(good))
    assert asyncio.run(_collect_stream(fp)) == ["你好", "世界"]


def test_stream_no_switch_after_token_yielded():
    bad = _FakeProvider("bad", err=AIProviderError("中途断", status_code=502),
                        tokens=["半句"], yield_before_err=True)
    good = _FakeProvider("good", tokens=["不该用到"])
    fp = FailoverTextProvider(bad, _switch_to(good))
    got = []
    with pytest.raises(AIProviderError):
        asyncio.run(_collect_stream(fp, sink=got))
    assert got == ["半句"]       # 已吐的保留
    assert good.gen_calls == 0    # 已开始流 → 不容灾切换


# ---------- build 门控 ----------

def test_build_gates_on_profile_count(monkeypatch, tmp_path):
    from services.ai import failover as fo
    from services import byok_profiles
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    monkeypatch.setenv("DESKTOP_BYOK_DIR", str(tmp_path))
    byok_profiles.reset_for_test()
    base = _FakeProvider("base")
    monkeypatch.setattr(fo.ProviderFactory, "get_text_provider_for_store",
                        classmethod(lambda cls, store: base))

    class _Store:
        id = "store-1"
        byok_enabled = True

    store = _Store()
    assert fo.build_resilient_text_provider(store) is base          # 0 档 → 不包
    byok_profiles.save_profile("store-1", "主", "https://a", "m", "enc1")
    assert fo.build_resilient_text_provider(store) is base          # 1 档 → 不包
    byok_profiles.save_profile("store-1", "备", "https://b", "m", "enc2")
    wrapped = fo.build_resilient_text_provider(store)
    assert isinstance(wrapped, fo.FailoverTextProvider)             # 2 档 → 包


def test_build_no_wrap_when_not_byok(monkeypatch):
    from services.ai import failover as fo
    base = _FakeProvider("base")
    monkeypatch.setattr(fo.ProviderFactory, "get_text_provider_for_store",
                        classmethod(lambda cls, store: base))

    class _Store:
        id = "s"
        byok_enabled = False

    assert fo.build_resilient_text_provider(_Store()) is base  # 非 BYOK → 原样


# ---------- _make_switch ----------

def test_make_switch_swaps_store_and_activates(monkeypatch, tmp_path):
    from services.ai import failover as fo
    from services import byok_profiles
    monkeypatch.setenv("DESKTOP_BYOK_DIR", str(tmp_path))
    byok_profiles.reset_for_test()
    byok_profiles.save_profile("s2", "主", "https://a", "ma", "encA")
    byok_profiles.save_profile("s2", "备", "https://b", "mb", "encB")
    byok_profiles.set_active("s2", "主")
    monkeypatch.setattr(fo.ProviderFactory, "get_text_provider_for_store",
                        classmethod(lambda cls, store: _FakeProvider("rebuilt")))

    class _Store:
        id = "s2"
        byok_enabled = True
        byok_base_url = "https://a"
        byok_model = "ma"
        byok_api_key_enc = "encA"

    store = _Store()
    switch = _make_switch(store)
    nxt = switch()
    assert nxt is not None
    assert store.byok_api_key_enc == "encB"    # 内存 store 换成"备"
    assert store.byok_base_url == "https://b"
    active = next(p["name"] for p in byok_profiles.list_profiles("s2") if p["is_active"])
    assert active == "备"                        # 激活指针变"备"
    assert switch() is None                      # 主已挂、备刚试 → 没得切了


# ---------- 端到端：真实循环里透明容灾 ----------

def test_failover_inside_real_loop_stream():
    """把容灾 provider 喂进真实 run_agent_loop_stream：首选 429 挂了 → 自动切 → 正常出最终答复。"""
    from services.agent.loop import run_agent_loop_stream
    from services.agent.context import AgentContext
    from services.agent.registry import Tool, ToolRegistry
    from services.ai.providers.mock import MockTextProvider

    reg = ToolRegistry()
    reg.register(Tool(name="noop", description="x", parameters={"type": "object", "properties": {}},
                      handler=lambda a, c: None))
    bad = _FakeProvider("bad", err=AIProviderError("限流", status_code=429))
    good = MockTextProvider(scripted=[TextResponse(content="切过来后正常答复", model="good", finish_reason="stop")])
    fp = FailoverTextProvider(bad, _switch_to(good))

    async def run():
        return [ev async for ev in run_agent_loop_stream(
            user_message="帮我写个东西", registry=reg, ctx=AgentContext(),
            system_prompt="你是助手", provider=fp, model="m", max_turns=3)]

    evs = asyncio.run(run())
    final = next((e["content"] for e in evs if e.get("type") == "final"), None)
    assert final == "切过来后正常答复"
    assert bad.gen_calls == 1  # 首选被真试过一次（然后才切）
