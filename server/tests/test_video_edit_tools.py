"""视频剪辑 Agent 工具端到端:inventory → edit_timeline → render_video 全链(真 ffmpeg,打桩 whisper)。

F-10：render_video 改成"提交 media job 立即返回任务号"，真正渲染挪进后台任务——下面全链测试
（test_full_pipeline）也跟着改成"给 ctx 一个真实 store/user(内存 DB) → 拿任务号 → 轮询 media_jobs
到 done"，而不是直接断言同步返回值里有视频链接（那是旧的同步行为，已随实现一起作废）。
"""
import asyncio
import json
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401
from db.base import Base
from models.store import Store
from models.user import User
from services import media_jobs_service as mj
from services import media_jobs_runner as runner
from services.agent import video_edit_tools as vt
from services.agent.context import AgentContext
from services.agent.registry import ToolRegistry
from services.video_edit.ffbin import ffmpeg_bin


def _synth(path: Path, dur: int = 6):
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc=size=720x1280:duration={dur}:rate=30",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _fake_transcribe(video_path, edit_dir, **kw):
    cache = Path(edit_dir) / "transcripts"
    cache.mkdir(parents=True, exist_ok=True)
    res = {"words": [{"text": "约球", "start": 1.0, "end": 1.5},
                     {"text": "福利", "start": 1.5, "end": 2.0}],
           "has_speech": True, "language": "zh"}
    (cache / f"{Path(video_path).stem}.json").write_text(json.dumps(res, ensure_ascii=False))
    return res


@pytest.fixture
def setup(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr("services.video_edit.transcribe.transcribe", _fake_transcribe)
    src = tmp_path / "探店.mp4"
    _synth(src, dur=6)
    return src


async def _seed_store(db, sid):
    u = User(id=uuid.uuid4(), phone="13800000002", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    db.add(Store(id=sid, owner_id=u.id, name="店"))
    await db.commit()
    return u.id


async def _poll_job_done(sid, jid, tries=3000):
    # E4④两遍法 loudnorm(先测真实响度再精确校正)比原来的单遍近似多一趟 ffmpeg,真实渲染耗时
    # 变长——原来 500 次*0.01s=5s 的轮询预算,在整个"video"测试集一起跑、机器负载重时偶发不够,
    # 放宽到 30s 只是给足真实渲染时间,不改变"失败判定"本身(仍是拿到 done/error 就立刻退出,
    # 正常情况几秒内就完成,这只是兜底上限,不会拖慢正常测试速度)。
    got = None
    for _ in range(tries):
        await asyncio.sleep(0.01)
        async with runner.async_session() as db:
            got = await mj.get_job(db, jid, sid)
        if got and got.status in ("done", "error"):
            break
    return got


def _extract_job_id(tool_result: str) -> str:
    import re
    m = re.search(r"任务号\s*([0-9a-fA-F-]{8,})", tool_result)
    assert m, f"没在工具返回文本里找到任务号:{tool_result}"
    return m.group(1)


def test_tools_registered():
    reg = ToolRegistry()
    n = vt.register_video_edit_tools(reg)
    assert n == 4
    assert reg.get("inventory_footage").read_only is True
    assert reg.get("render_video").deliverable is True
    assert reg.get("render_video").requires_approval is False  # 出成品不弹安全审批


def test_full_pipeline(setup, monkeypatch, tmp_path):
    """全链路(真 ffmpeg)：inventory → edit_timeline → auto_caption 仍是同步；出片(render_video)
    F-10 起改成提交 media job 立即返回任务号，这里轮询到 done 再断言真视频文件已经渲出来。"""
    src = setup

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        # render_video 完成后落 Generation 完成行(_write_completion_generation)也开自己的 DB
        # session(`from db.session import async_session` 延迟导入)，得连源头一起换，否则打到
        # 真实(未启动的)默认引擎去——虽有 try/except 兜底不炸测试，但这条链路就没被真正验证到。
        monkeypatch.setattr("db.session.async_session", Session)
        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed_store(db, sid)
        ctx = AgentContext(store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid),
                           conversation_id="33333333-3333-3333-3333-333333333333")

        # ① 理解素材
        r1 = await vt.inventory_footage({"video_paths": [str(src)], "project": "proj1"}, ctx)
        assert "项目号" in r1 and "proj1" in r1
        assert vt._doc_path("proj1").exists()

        # ② 挑两段进视频轨
        r2 = await vt.edit_timeline({"project": "proj1", "operations": [
            {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
            {"op": "add_clip", "track": "v", "media": "m1", "src_in": 3.0, "src_out": 5.0},
        ]}, ctx)
        assert "改好了" in r2

        # ③ 自动配字幕(口播 1-2s 落在第一段里)
        r3 = await vt.auto_caption({"project": "proj1"}, ctx)
        assert "字幕" in r3

        # ④ 出片：立即拿到任务号(不再硬等)，轮询后台任务到 done
        r4 = await vt.render_video({"project": "proj1", "output_name": "探店成片"}, ctx)
        assert "后台" in r4 and "任务号" in r4
        got = await _poll_job_done(sid, _extract_job_id(r4))
        assert got is not None and got.status == "done", (got and got.status, got and got.error)
        assert got.result["urls"] == ["/uploads/edits/proj1/探店成片.mp4"]

        out = vt._project_dir("proj1") / "探店成片.mp4"
        assert out.exists() and out.stat().st_size > 1000

    asyncio.run(main())


def test_render_video_job_completion_appends_transcript_and_notifies(setup, monkeypatch, tmp_path):
    """render_video 完成后要把结果回灌进该会话的对话轨迹 + 弹通知(F-10)。用 fake render_timeline
    顶掉真 ffmpeg(这条只验证 job/transcript/notify 三件事的接线，渲染本身已被 test_full_pipeline 验过)。"""
    import services.agent.transcript as Tr

    src = setup

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path / "uploads"))

        notified = {}
        monkeypatch.setattr(
            "services.notify_service.push",
            lambda title, body, kind="info", **m: notified.update(kind=kind, title=title),
        )

        def fake_render(doc, out_path, edit_dir):
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_bytes(b"FAKE-MP4")

        monkeypatch.setattr("services.video_edit.assemble.render_timeline", fake_render)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed_store(db, sid)
        cid = "44444444-4444-4444-4444-444444444444"
        ctx = AgentContext(store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid), conversation_id=cid)

        await vt.inventory_footage({"video_paths": [str(src)], "project": "proj4"}, ctx)
        await vt.edit_timeline({"project": "proj4", "operations": [
            {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
        ]}, ctx)

        r = await vt.render_video({"project": "proj4", "output_name": "成片4"}, ctx)
        got = await _poll_job_done(sid, _extract_job_id(r))
        assert got is not None and got.status == "done"

        out = Tr.load_transcript(cid)
        assert out is not None and len(out) == 1
        assert "/uploads/edits/proj4/成片4.mp4" in out[0]["content"]
        assert notified["kind"] == "media_job_done"

    asyncio.run(main())


def test_render_video_job_failure_appends_transcript_and_notifies(setup, monkeypatch, tmp_path):
    """渲染半路炸了(如 ffmpeg 崩)→ 也要落一条"没剪成、原因 X" + 弹失败通知，别让老板干等。"""
    import services.agent.transcript as Tr

    src = setup

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path / "uploads"))

        notified = {}
        monkeypatch.setattr(
            "services.notify_service.push",
            lambda title, body, kind="info", **m: notified.update(kind=kind, body=body),
        )

        def boom_render(doc, out_path, edit_dir):
            raise RuntimeError("ffmpeg 崩了")

        monkeypatch.setattr("services.video_edit.assemble.render_timeline", boom_render)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed_store(db, sid)
        cid = "55555555-5555-5555-5555-555555555555"
        ctx = AgentContext(store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid), conversation_id=cid)

        await vt.inventory_footage({"video_paths": [str(src)], "project": "proj5"}, ctx)
        await vt.edit_timeline({"project": "proj5", "operations": [
            {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
        ]}, ctx)

        r = await vt.render_video({"project": "proj5", "output_name": "成片5"}, ctx)
        got = await _poll_job_done(sid, _extract_job_id(r))
        assert got is not None and got.status == "error"
        assert "ffmpeg 崩了" in (got.error or "")

        out = Tr.load_transcript(cid)
        assert out is not None and "没剪成" in out[0]["content"] and "ffmpeg 崩了" in out[0]["content"]
        assert notified["kind"] == "media_job_failed"

    asyncio.run(main())


def test_render_video_job_completion_visible_via_get_agent_conversation(setup, monkeypatch, tmp_path):
    """F-10 审查 Important 修复：render_video 完成后也要能被『打开历史会话』(get_agent_conversation)
    真实查到——它只读 Generation 表,不读 transcript JSONL。"""
    import services.agent.transcript as Tr

    src = setup

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        monkeypatch.setattr(runner, "async_session", Session)
        monkeypatch.setattr("db.session.async_session", Session)
        monkeypatch.setattr(Tr.settings, "upload_dir", str(tmp_path / "uploads"))
        monkeypatch.setattr("services.notify_service.push", lambda *a, **k: None)

        def fake_render(doc, out_path, edit_dir):
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_bytes(b"FAKE-MP4")

        monkeypatch.setattr("services.video_edit.assemble.render_timeline", fake_render)

        sid = uuid.uuid4()
        async with Session() as db:
            uid = await _seed_store(db, sid)
        cid = "66666666-6666-6666-6666-666666666666"
        ctx = AgentContext(store=SimpleNamespace(id=sid), user=SimpleNamespace(id=uid), conversation_id=cid)

        await vt.inventory_footage({"video_paths": [str(src)], "project": "proj6b"}, ctx)
        await vt.edit_timeline({"project": "proj6b", "operations": [
            {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
        ]}, ctx)

        r = await vt.render_video({"project": "proj6b", "output_name": "成片6b"}, ctx)
        got = await _poll_job_done(sid, _extract_job_id(r))
        assert got is not None and got.status == "done"

        from api.v1.agent import get_agent_conversation

        async with Session() as db:
            res = await get_agent_conversation(cid, user=None, store=SimpleNamespace(id=sid), db=db)
        assistant_texts = [m["content"] for m in res["messages"] if m["role"] == "assistant"]
        assert any("视频剪好了" in t and "/uploads/edits/proj6b/成片6b.mp4" in t for t in assistant_texts), assistant_texts

    asyncio.run(main())


def test_render_video_without_store_context_returns_friendly_message(setup):
    """理论上不该发生(真实调用 ctx.store 恒为真)，但 ctx.store 缺失时也不能崩、要给人话。"""
    src = setup
    ctx = AgentContext()  # store=None(默认)
    asyncio.run(vt.inventory_footage({"video_paths": [str(src)], "project": "proj6"}, ctx))
    asyncio.run(vt.edit_timeline({"project": "proj6", "operations": [
        {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
    ]}, ctx))
    r = asyncio.run(vt.render_video({"project": "proj6"}, ctx))
    assert "门店上下文" in r


def test_edit_rollback_on_bad_op(setup):
    src = setup
    ctx = AgentContext()
    asyncio.run(vt.inventory_footage({"video_paths": [str(src)], "project": "proj2"}, ctx))
    asyncio.run(vt.edit_timeline({"project": "proj2", "operations": [
        {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
    ]}, ctx))
    # 裁到超出源素材 → 回滚
    r = asyncio.run(vt.edit_timeline({"project": "proj2", "operations": [
        {"op": "trim_clip", "id": "c1", "src_out": 999.0},
    ]}, ctx))
    assert "回滚" in r or "没生效" in r


def test_render_empty_timeline_refuses(setup):
    src = setup
    ctx = AgentContext()
    asyncio.run(vt.inventory_footage({"video_paths": [str(src)], "project": "proj3"}, ctx))
    r = asyncio.run(vt.render_video({"project": "proj3"}, ctx))
    assert "还没有视频片段" in r
