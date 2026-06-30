"""AI 剪辑台 /video-edit 路由(面板直连):文档视图 + 原子操作 + 回滚 + 自动字幕。

inventory/render 的核心逻辑已由 video_edit core + 工具测覆盖;本测聚焦面板的同步交互端点(纯文件操作,无需 DB)。
"""
import asyncio
import json
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

import api.v1.video_edit as ve
from core.exceptions import AIServiceError
from services.video_edit.projects import save_doc
from services.video_edit.timeline import Clip, MediaRef, Track, new_doc

_USER = SimpleNamespace(id=uuid.uuid4())
_STORE = SimpleNamespace(id=uuid.uuid4())


def _seed_project(project: str, *, with_transcript: bool = False):
    doc = new_doc()
    doc.media["m1"] = MediaRef(src="/abs/探店.mp4", duration=20.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    save_doc(project, doc)
    if with_transcript:
        from services.video_edit.projects import project_dir
        tdir = project_dir(project) / "transcripts"
        tdir.mkdir(parents=True, exist_ok=True)
        (tdir / "探店.json").write_text(json.dumps({
            "words": [{"text": "约球", "start": 1.0, "end": 1.5},
                      {"text": "福利", "start": 1.5, "end": 2.0}]
        }, ensure_ascii=False))


@pytest.fixture(autouse=True)
def _uploads(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))


def test_media_job_kinds_registered():
    """回归守栏(真机逮到):剪辑台的异步任务类型必须在 media_jobs 白名单里,否则 inventory/render 500。"""
    from services.media_jobs_service import VALID_KINDS
    assert "video_inventory" in VALID_KINDS
    assert "video_render" in VALID_KINDS


def test_uploads_middleware_allows_video():
    """回归守栏(真机逮到):/uploads 静态守卫必须放行视频扩展名,否则成片 .mp4 被 403、预览播不了。"""
    import inspect
    import main
    src = inspect.getsource(main.UploadSecurityMiddleware)
    assert ".mp4" in src  # 视频放行


def test_doc_view_shape():
    doc = new_doc()
    doc.media["m1"] = MediaRef(src="/a.mp4", duration=10.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=1.0, src_out=4.0, order=1)
    view = ve._doc_view(doc)
    assert view["clips"][0]["id"] == "c1" and view["clips"][0]["src_in"] == 1.0
    assert view["width"] == 1080 and view["duration"] == 3.0


def test_apply_ops_add_clip():
    _seed_project("p1")
    body = ve.OpsIn(operations=[
        {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 3.0},
    ])
    res = asyncio.run(ve.video_apply_ops("p1", body, user=_USER, store=_STORE))
    assert res["ok"] is True
    assert len(res["doc"]["clips"]) == 1


def test_apply_ops_rollback_on_invalid():
    _seed_project("p2")
    asyncio.run(ve.video_apply_ops("p2", ve.OpsIn(operations=[
        {"op": "add_clip", "id": "c1", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 3.0},
    ]), user=_USER, store=_STORE))
    res = asyncio.run(ve.video_apply_ops("p2", ve.OpsIn(operations=[
        {"op": "trim_clip", "id": "c1", "src_out": 999.0},  # 超 20s
    ]), user=_USER, store=_STORE))
    assert res["ok"] is False and res["errors"]
    assert res["doc"]["clips"][0]["src_out"] == 3.0  # 回滚


def test_get_project():
    _seed_project("p3")
    res = asyncio.run(ve.video_get_project("p3", user=_USER, store=_STORE))
    assert res["project"] == "p3" and "doc" in res


def test_get_missing_project_raises():
    with pytest.raises(AIServiceError):
        asyncio.run(ve.video_get_project("ghost", user=_USER, store=_STORE))


def test_auto_caption_from_transcript():
    _seed_project("p4", with_transcript=True)
    asyncio.run(ve.video_apply_ops("p4", ve.OpsIn(operations=[
        {"op": "add_clip", "track": "v", "media": "m1", "src_in": 0.0, "src_out": 3.0},
    ]), user=_USER, store=_STORE))
    res = asyncio.run(ve.video_auto_caption("p4", ve.AutoCaptionIn(), user=_USER, store=_STORE))
    assert res["ok"] is True and res["added"] == 1
    assert res["doc"]["captions"][0]["text"] == "约球福利"
