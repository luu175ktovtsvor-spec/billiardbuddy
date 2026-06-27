"""缺口 F · 图片回灌(read_file / edit_image)。

对标官方 FileReadTool：读到/处理出的图片要能被模型【真看见】，而不是返回一句"二进制不便读取"
或处理完就没了。复用既有的 ctx.pending_view_images → _drain_view_images 现成管道
（截屏 computer_view 已在用），把图当 user 图片消息注入。

锁住：
- read_file 遇图片 → 路径写进 ctx.pending_view_images + 返回"将在下一轮看到"占位（不再是"二进制"）
- read_file 遇普通文本 → 照旧读出文字、不碰 pending
- edit_image 处理成功 → 输出图路径写进 ctx.pending_view_images（模型可自检）
- run_agent_loop 首次调模型【前】会 drain 已存在的 pending（审批后 /agent/execute 续接路径靠这条
  才能把处理后的图喂回模型——否则 edit_image 的 append 是死代码）
"""
import asyncio

import pytest

from services.agent.context import AgentContext


@pytest.fixture
def library(tmp_path, monkeypatch):
    """内容库指向临时目录，隔离真实 ~/.billiards-desktop。"""
    lib = tmp_path / "library"
    lib.mkdir()
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(lib))
    return lib


def _make_png(path, size=(64, 48)):
    from PIL import Image
    Image.new("RGB", size, (10, 120, 200)).save(path, format="PNG")
    return path


# ──────────────── read_file 图片分支 ────────────────

@pytest.mark.asyncio
async def test_read_file_image_appends_to_pending_and_returns_placeholder(library):
    from services.agent import local_tools as lt
    _make_png(library / "shot.png")
    ctx = AgentContext()
    out = await lt.read_file({"path": "shot.png"}, ctx)
    # 占位语：告诉模型"已读到图、下一轮会看见"，绝不是旧的"二进制不便读取"
    assert "二进制" not in out
    assert "shot.png" in out
    assert "图片" in out
    # 路径进了回灌队列，等 _drain_view_images 拼成 user 图片消息
    assert len(ctx.pending_view_images) == 1
    assert ctx.pending_view_images[0].endswith("shot.png")


@pytest.mark.asyncio
async def test_read_file_jpeg_also_image_branch(library):
    from PIL import Image
    from services.agent import local_tools as lt
    Image.new("RGB", (32, 32), (1, 2, 3)).save(library / "pic.jpg", format="JPEG")
    ctx = AgentContext()
    out = await lt.read_file({"path": "pic.jpg"}, ctx)
    assert "二进制" not in out
    assert len(ctx.pending_view_images) == 1
    assert ctx.pending_view_images[0].endswith("pic.jpg")


@pytest.mark.asyncio
async def test_read_file_text_unchanged_and_no_pending(library):
    from services.agent import local_tools as lt
    (library / "note.txt").write_text("一二三四五", encoding="utf-8")
    ctx = AgentContext()
    out = await lt.read_file({"path": "note.txt"}, ctx)
    assert out == "一二三四五"          # 文本读取行为零变化
    assert ctx.pending_view_images == []  # 非图不入回灌队列


# ──────────────── edit_image 输出回灌 ────────────────

@pytest.mark.asyncio
async def test_edit_image_success_appends_output_to_pending(library):
    from services.agent.image_tools import edit_image
    _make_png(library / "src.png", size=(800, 600))
    ctx = AgentContext()
    out = await edit_image(
        {"path": "src.png", "operation": "resize", "scale": 0.5, "output_path": "small.png"}, ctx)
    assert "处理完成" in out
    # 处理后的图进回灌队列 → 模型下一轮能看见自己 P 的结果（自检）
    assert len(ctx.pending_view_images) == 1
    assert ctx.pending_view_images[0].endswith("small.png")


@pytest.mark.asyncio
async def test_edit_image_failure_records_nothing(library):
    from services.agent.image_tools import edit_image
    ctx = AgentContext()
    out = await edit_image({"path": "does-not-exist.png", "operation": "resize", "scale": 0.5}, ctx)
    assert "不存在" in out
    assert ctx.pending_view_images == []  # 没成功就别污染回灌队列


# ──────────────── run_agent_loop 首调前 drain（execute 续接路径） ────────────────

def _has_user_image(messages):
    for m in messages or []:
        if m.get("role") == "user" and isinstance(m.get("content"), list):
            if any(isinstance(it, dict) and it.get("type") == "image_url" for it in m["content"]):
                return True
    return False


def test_run_agent_loop_drains_pending_before_first_model_call(library):
    """审批后 /agent/execute 跑完 edit_image（往 ctx.pending_view_images 塞了图）→ 续接 run_agent_loop。
    模型必须在【第一次】被调用时就看见那张处理后的图（drain 发生在首调前），否则 append 白搭。"""
    from services.ai.base import TextResponse
    from services.ai.providers.mock import MockTextProvider
    from services.agent.loop import run_agent_loop
    from services.agent.registry import ToolRegistry

    png = str(_make_png(library / "edited.png"))

    class _Rec(MockTextProvider):
        def __init__(self, scripted):
            super().__init__(scripted=scripted)
            self.saw_user_image = []

        async def generate(self, request):
            self.saw_user_image.append(_has_user_image(request.messages or []))
            return await super().generate(request)

    provider = _Rec(scripted=[TextResponse(content="处理好啦", model="mock", finish_reason="stop")])
    ctx = AgentContext()
    ctx.pending_view_images.append(png)  # 模拟 edit_image 在 execute 里已跑完
    res = asyncio.run(run_agent_loop(
        user_message="刚才的图处理好了吗", registry=ToolRegistry(), provider=provider, ctx=ctx))
    assert "处理好啦" in res.final_text
    assert provider.saw_user_image == [True]   # 首调就带上了处理后的图
    assert ctx.pending_view_images == []        # drain 后清空
