"""AI 剪辑台直连接口(/video-edit):面板直接操作【时间轴文档】,绕开 ReAct 对话循环。

架构(三段式):面板/AI 都只改同一份时间轴文档(UPLOAD_DIR/edits/<project>/timeline.json 真相源),
渲染器消费它出片。本路由 = 面板这条手:
  POST /inventory                理解素材(转写+切镜头)→ 候选片段菜单 + 草稿文档     (慢·走 media-job 异步)
  GET  /projects/{project}       读当前时间轴文档
  POST /projects/{project}/ops   对文档发原子操作(挑段/裁剪/排序/字幕/配乐)→ 校验+回滚 (同步·快)
  POST /projects/{project}/auto_caption  口播自动配字幕                              (同步)
  POST /projects/{project}/render        文档 → 成片 mp4                            (慢·走 media-job)
"""
from __future__ import annotations

import uuid
from pathlib import Path

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import AIServiceError
from models.store import Store
from models.user import User
from services import media_jobs_runner

router = APIRouter()


class InventoryIn(BaseModel):
    video_paths: list[str]
    project: str | None = None
    conversation_id: str | None = None


class OpsIn(BaseModel):
    operations: list[dict]


class AutoCaptionIn(BaseModel):
    track: str = "sub"


class RenderIn(BaseModel):
    output_name: str = "成片"
    conversation_id: str | None = None


def _doc_view(doc) -> dict:
    """给前端的紧凑视图:视频段卡片 + 字幕 + 概况。"""
    return {
        "width": doc.width, "height": doc.height, "fps": doc.fps,
        "duration": doc.duration(),
        "media": {mid: {"src": m.src, "duration": m.duration} for mid, m in doc.media.items()},
        "clips": [
            {"id": cid, "media": c.media, "src_in": c.src_in, "src_out": c.src_out, "order": c.order}
            for cid, c in doc.video_clips_ordered()
        ],
        "captions": [
            {"id": cid, "text": c.text, "start": c.start, "end": c.end, "style": c.style}
            for cid, c in doc.caption_clips()
        ],
        "music": doc.music, "grade": doc.grade,
    }


@router.post("/inventory")
async def video_inventory(
    body: InventoryIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """理解本机视频素材:转写口播 + 切镜头 → 候选片段菜单 + 草稿文档。慢(whisper)→ 异步返回 {job_id}。"""
    paths = [str(p) for p in (body.video_paths or []) if str(p).strip()]
    if not paths:
        raise AIServiceError("没给视频:请选要剪的本地视频。")
    for p in paths:
        if not Path(p).is_file():
            raise AIServiceError(f"找不到视频文件:{p}")

    project = Path(str(body.project or "")).name or uuid.uuid4().hex[:10]
    store_id, conv = store.id, body.conversation_id

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(10, "正在听你视频里讲了啥、看有哪些镜头…")
            from services.video_edit.assemble import inventory_footage
            from services.video_edit.projects import project_dir, save_doc
            from services.video_edit.timeline import TimelineDoc

            edit_dir = str(project_dir(project))
            res = inventory_footage(paths, edit_dir)
            save_doc(project, TimelineDoc.model_validate(res["doc"]))
            return {
                "project": project,
                "candidates": res["candidates"],
                "has_speech": res["has_speech"],
            }
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "video_inventory", work_fn,
        params={"project": project, "n": len(paths)}, conversation_id=conv,
    )
    return {"job_id": job_id, "project": project}


@router.get("/projects/{project}")
async def video_get_project(
    project: str,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """读当前时间轴文档(面板渲染卡片用)。"""
    from services.video_edit.projects import load_doc

    doc = load_doc(project)
    if doc is None:
        raise AIServiceError("没找到这个剪辑项目")
    return {"project": project, "doc": _doc_view(doc)}


@router.post("/projects/{project}/ops")
async def video_apply_ops(
    project: str,
    body: OpsIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """对文档发原子操作(挑段/裁剪/排序/加删字幕/配乐)。校验不过整批回滚。"""
    from services.video_edit.operations import apply_operations
    from services.video_edit.projects import load_doc, save_doc

    doc = load_doc(project)
    if doc is None:
        raise AIServiceError("没找到这个剪辑项目(先 inventory)")
    new_doc, errs = apply_operations(doc, body.operations or [])
    if errs:
        return {"ok": False, "errors": errs, "doc": _doc_view(doc)}
    save_doc(project, new_doc)
    return {"ok": True, "errors": [], "doc": _doc_view(new_doc)}


@router.post("/projects/{project}/auto_caption")
async def video_auto_caption(
    project: str,
    body: AutoCaptionIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """把已挑片段里的口播,自动配成跟成片对齐的字幕。"""
    from services.video_edit.assemble import auto_captions_from_speech
    from services.video_edit.operations import apply_operations
    from services.video_edit.projects import load_doc, project_dir, save_doc

    doc = load_doc(project)
    if doc is None:
        raise AIServiceError("没找到这个剪辑项目")
    if not doc.video_clips_ordered():
        raise AIServiceError("还没挑视频片段")
    ops = auto_captions_from_speech(doc, str(project_dir(project)), track=body.track)
    if not ops:
        return {"ok": True, "added": 0, "doc": _doc_view(doc)}
    new_doc, errs = apply_operations(doc, ops)
    if errs:
        return {"ok": False, "errors": errs, "doc": _doc_view(doc)}
    save_doc(project, new_doc)
    return {"ok": True, "added": len(ops), "doc": _doc_view(new_doc)}


@router.post("/projects/{project}/render")
async def video_render(
    project: str,
    body: RenderIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """时间轴文档 → 成片 mp4。慢 → 异步返回 {job_id};前端轮询拿 video_url。"""
    from services.video_edit.projects import load_doc

    doc = load_doc(project)
    if doc is None:
        raise AIServiceError("没找到这个剪辑项目")
    if not doc.video_clips_ordered():
        raise AIServiceError("时间轴里还没视频片段,先挑几段再出片")
    errs = doc.validate_doc()
    if errs:
        raise AIServiceError("时间轴有问题:" + "；".join(errs))

    store_id, conv = store.id, body.conversation_id
    name = Path(str(body.output_name or "成片")).name
    if not name.endswith(".mp4"):
        name += ".mp4"

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(15, "在出片了,好了叫你…")
            from services.video_edit.assemble import render_timeline
            from services.video_edit.projects import load_doc as _ld, project_dir

            d = _ld(project)
            out = project_dir(project) / name
            render_timeline(d, str(out), edit_dir=str(project_dir(project)))
            return {"urls": [f"/uploads/edits/{project}/{name}"],
                    "is_video": True, "duration": d.duration()}
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "video_render", work_fn,
        params={"project": project, "name": name}, conversation_id=conv,
    )
    return {"job_id": job_id}
