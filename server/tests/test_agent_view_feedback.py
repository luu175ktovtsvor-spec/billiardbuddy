"""工具产出图片回灌（借 Kimi Code）：computer screenshot 等把截图写进 ctx，loop 在本批 tool 结果
全部追加、配对完整后，把图拼成一条 user 图片消息注入，让模型下一轮真【看见】自己截的屏。

锁住：
- _drain_view_images：有图 → 追加一条 user 图片消息 + 清空 ctx；空/非图 → 不注入空消息（仍清空）
- 注入点在【一批 tool 结果之后】：sync + stream 集成里，二次模型调用时 messages 已带回灌截图
- computer screenshot 工具：成功 → 路径写进 ctx.pending_view_images；失败 → 不写
"""
import asyncio

from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.context import AgentContext
from services.agent.loop import run_agent_loop, run_agent_loop_stream, _drain_view_images
from services.agent.registry import Tool, ToolRegistry


def _make_png(path, size=(48, 36)):
    from PIL import Image
    Image.new("RGB", size, (10, 120, 200)).save(path, format="PNG")
    return str(path)


def _tc(name, args="{}", tid="c1"):
    return {"id": tid, "type": "function", "function": {"name": name, "arguments": args}}


def _has_user_image(messages):
    for m in messages or []:
        if m.get("role") == "user" and isinstance(m.get("content"), list):
            if any(isinstance(it, dict) and it.get("type") == "image_url" for it in m["content"]):
                return True
    return False


async def _collect(agen):
    return [ev async for ev in agen]


# ──────────────── 单元：_drain_view_images ────────────────

def test_drain_injects_user_image_and_clears(tmp_path):
    png = _make_png(tmp_path / "shot.png")
    ctx = AgentContext()
    ctx.pending_view_images.append(png)
    messages: list[dict] = []
    _drain_view_images(messages, ctx)
    assert len(messages) == 1 and messages[0]["role"] == "user"
    assert _has_user_image(messages)
    assert ctx.pending_view_images == []   # 取后清空


def test_drain_noop_when_empty():
    ctx = AgentContext()
    messages: list[dict] = []
    _drain_view_images(messages, ctx)
    assert messages == []


def test_drain_skips_non_image_but_clears(tmp_path):
    bad = tmp_path / "note.txt"
    bad.write_text("x")
    ctx = AgentContext()
    ctx.pending_view_images.append(str(bad))
    messages: list[dict] = []
    _drain_view_images(messages, ctx)
    assert messages == []                   # 非图 → 不注入空消息
    assert ctx.pending_view_images == []     # 仍清空（不卡住）


# ──────────────── 集成：截图 → loop 回灌 ────────────────

def _reg_with_snap(png):
    reg = ToolRegistry()

    async def _snap(args, ctx):
        ctx.pending_view_images.append(png)
        return "已截屏"

    reg.register(Tool(name="snap", description="截屏",
                      parameters={"type": "object", "properties": {}}, handler=_snap))
    return reg


def _snap_then_final():
    return [
        TextResponse(content="", model="mock", tool_calls=[_tc("snap")], finish_reason="tool_calls"),
        TextResponse(content="我看清屏幕了，完成", model="mock", finish_reason="stop"),
    ]


class _RecProvider(MockTextProvider):
    """记录每次 generate 调用时 messages 是否已带 user 图片（证明回灌发生在二次调用前）。"""

    def __init__(self, scripted):
        super().__init__(scripted=scripted)
        self.saw_user_image: list[bool] = []

    async def generate(self, request):
        self.saw_user_image.append(_has_user_image(request.messages or []))
        return await super().generate(request)


class _RecStreamProvider(MockTextProvider):
    def __init__(self, scripted):
        super().__init__(scripted=scripted)
        self.saw_user_image: list[bool] = []

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        self.saw_user_image.append(_has_user_image(request.messages or []))
        async for tok in super().generate_stream(
            request, usage_sink=usage_sink, tool_calls_sink=tool_calls_sink, finish_sink=finish_sink):
            yield tok


def test_sync_screenshot_fed_back_to_model(tmp_path):
    png = _make_png(tmp_path / "screen.png")
    provider = _RecProvider(scripted=_snap_then_final())
    ctx = AgentContext()
    res = asyncio.run(run_agent_loop(
        user_message="帮我截个屏看看", registry=_reg_with_snap(png), provider=provider, ctx=ctx))
    assert "完成" in res.final_text
    # 首调无图（老板纯文字），二调已带回灌截图 → loop 在工具结果之后注入了 user 图片消息
    assert provider.saw_user_image == [False, True]
    assert ctx.pending_view_images == []


def test_stream_screenshot_fed_back_to_model(tmp_path):
    png = _make_png(tmp_path / "screen2.png")
    provider = _RecStreamProvider(scripted=_snap_then_final())
    ctx = AgentContext()
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="帮我截个屏看看", registry=_reg_with_snap(png), provider=provider, ctx=ctx)))
    final = [e for e in events if e["type"] == "final"]
    assert final and "完成" in final[0]["content"]
    assert provider.saw_user_image == [False, True]


# ──────────────── computer screenshot 工具写 ctx ────────────────

def test_computer_screenshot_records_path(monkeypatch, tmp_path):
    from services.agent import computer_tools as ct
    monkeypatch.setattr(ct, "_screenshot_dir", lambda: tmp_path)
    async def fake_run_py(code, timeout=20):
        return ("", None)
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    ctx = AgentContext()
    out = asyncio.run(ct._view_handler({"action": "screenshot"}, ctx=ctx))
    assert ".png" in out
    assert len(ctx.pending_view_images) == 1
    assert ctx.pending_view_images[0].endswith(".png")


def test_computer_screenshot_failure_records_nothing(monkeypatch, tmp_path):
    from services.agent import computer_tools as ct
    monkeypatch.setattr(ct, "_screenshot_dir", lambda: tmp_path)
    async def fake_run_py(code, timeout=20):
        return (None, "权限不足")
    monkeypatch.setattr(ct, "_run_py", fake_run_py)
    ctx = AgentContext()
    out = asyncio.run(ct._view_handler({"action": "screenshot"}, ctx=ctx))
    assert "[截屏失败]" in out
    assert ctx.pending_view_images == []
