"""视频剪辑 Agent 工具端到端:inventory → edit_timeline → render_video 全链(真 ffmpeg,打桩 whisper)。"""
import asyncio
import json
import subprocess
from pathlib import Path

import pytest

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


def test_tools_registered():
    reg = ToolRegistry()
    n = vt.register_video_edit_tools(reg)
    assert n == 4
    assert reg.get("inventory_footage").read_only is True
    assert reg.get("render_video").deliverable is True
    assert reg.get("render_video").requires_approval is False  # 出成品不弹安全审批


def test_full_pipeline(setup):
    src = setup
    ctx = AgentContext()

    # ① 理解素材
    r1 = asyncio.run(vt.inventory_footage({"video_paths": [str(src)], "project": "proj1"}, ctx))
    assert "项目号" in r1 and "proj1" in r1
    assert vt._doc_path("proj1").exists()

    # ② 挑两段进视频轨
    r2 = asyncio.run(vt.edit_timeline({"project": "proj1", "operations": [
        {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 2.0},
        {"op": "add_clip", "track": "v", "media": "m1", "src_in": 3.0, "src_out": 5.0},
    ]}, ctx))
    assert "改好了" in r2

    # ③ 自动配字幕(口播 1-2s 落在第一段里)
    r3 = asyncio.run(vt.auto_caption({"project": "proj1"}, ctx))
    assert "字幕" in r3

    # ④ 出片
    r4 = asyncio.run(vt.render_video({"project": "proj1", "output_name": "探店成片"}, ctx))
    assert "/uploads/edits/proj1/探店成片.mp4" in r4
    out = vt._project_dir("proj1") / "探店成片.mp4"
    assert out.exists() and out.stat().st_size > 1000


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
