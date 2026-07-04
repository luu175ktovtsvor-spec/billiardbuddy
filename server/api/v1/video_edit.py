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

import asyncio
import mimetypes
import re
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, Request
from fastapi.responses import FileResponse, StreamingResponse
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


class AutoPlanIn(BaseModel):
    video_paths: list[str]
    project: str | None = None
    mode: str = "ambient"                 # ambient(氛围) / speech(口播,后续)
    ratio: str = "9:16"                   # 9:16 / 1:1 / 16:9 / original
    target_duration: float = 16.0
    conversation_id: str | None = None


class RenderIn(BaseModel):
    output_name: str = "成片"
    conversation_id: str | None = None


class RecaptionIn(BaseModel):
    tonality: str                          # 店主大白话改文案指令,如"改成美女助教氛围风,别用竞技词"


class EditFeedbackIn(BaseModel):
    feedback: str                          # 店主任意大白话反馈,如"第2段换掉""配乐慢些""整体短点""文案甜一点"


_VIDEO_EXT = {".mp4", ".mov", ".m4v", ".webm", ".avi", ".mkv"}


@router.get("/localfile")
async def video_localfile(path: str, request: Request, user: User = Depends(get_current_user)):
    """客户端预览用:把本机源视频以 http 流出(带 Range,支持拖动)。

    修 P0-3:前端页在 http://localhost 里加载 file:// 会被 Chromium 拒载(黑屏)。改走同源 http 流。
    仅桌面本地单用户;守栏:必须是存在的视频文件。
    """
    p = Path(path)
    if not p.is_file() or p.suffix.lower() not in _VIDEO_EXT:
        raise AIServiceError("找不到该视频或格式不支持")
    size = p.stat().st_size
    ctype = mimetypes.guess_type(str(p))[0] or "video/mp4"
    rng = request.headers.get("range")
    if rng:
        m = re.match(r"bytes=(\d+)-(\d*)", rng)
        start = int(m.group(1)) if m else 0
        end = int(m.group(2)) if (m and m.group(2)) else size - 1
        end = min(end, size - 1)
        length = max(0, end - start + 1)

        def _iter():
            with open(p, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    remaining -= len(chunk)
                    yield chunk

        headers = {"Content-Range": f"bytes {start}-{end}/{size}", "Accept-Ranges": "bytes",
                   "Content-Length": str(length), "Content-Type": ctype}
        return StreamingResponse(_iter(), status_code=206, headers=headers)
    return FileResponse(str(p), media_type=ctype, headers={"Accept-Ranges": "bytes"})


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
            res = await asyncio.to_thread(inventory_footage, paths, edit_dir)
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


@router.post("/auto_plan")
async def video_auto_plan(
    body: AutoPlanIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """一键智能出方案(两条业务线,按 mode 分):
    - ambient(氛围):切窗+VLM挑高光+卡点拼片 → 出片走 V2 模板(/render_v2)或朴素(/render)。
    - speech(口播):whisper转录+按说的话挑段+自动字幕 → 出片走 /render(保原声+烧字幕)。

    慢 → 异步返回 {job_id};前端轮询拿 {project, report}。
    """
    paths = [str(p) for p in (body.video_paths or []) if str(p).strip()]
    if not paths:
        raise AIServiceError("没给视频:请选要剪的本地视频。")
    for p in paths:
        if not Path(p).is_file():
            raise AIServiceError(f"找不到视频文件:{p}")
    if body.mode not in ("ambient", "speech"):
        raise AIServiceError(f"mode 只支持 ambient(氛围)/speech(口播);收到 {body.mode}")

    project = Path(str(body.project or "")).name or uuid.uuid4().hex[:10]
    store_id, conv, mode = store.id, body.conversation_id, body.mode
    ratio, target = body.ratio, body.target_duration

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            from services.video_edit.projects import project_dir, save_doc
            from services.video_edit.timeline import TimelineDoc

            edit_dir = str(project_dir(project))
            if mode == "speech":
                await progress(10, "在听你视频里讲了啥、挑出讲得好的段落…")
                from services.video_edit.planners import plan_speech
                res = await asyncio.to_thread(plan_speech, paths, edit_dir, ratio=ratio, target_duration=max(target, 20.0))
                save_doc(project, TimelineDoc.model_validate(res["doc"]))
                return {"project": project, "report": res["report"], "mode": "speech"}
            await progress(10, "在看每段视频哪一刻最出彩、把废镜头挑出去…")
            from services.video_edit.planners import plan_ambient
            res = await asyncio.to_thread(plan_ambient, paths, edit_dir, ratio=ratio, target_duration=target)
            save_doc(project, TimelineDoc.model_validate(res["doc"]))
            return {"project": project, "report": res["report"], "used_vlm": res["used_vlm"], "mode": "ambient"}
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "video_auto_plan", work_fn,
        params={"project": project, "n": len(paths), "mode": body.mode}, conversation_id=conv,
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
            from services.video_edit.footage_qc import qc_caveat_message
            from services.video_edit.projects import load_doc as _ld, project_dir

            d = _ld(project)
            out = project_dir(project) / name
            res = await asyncio.to_thread(render_timeline, d, str(out), edit_dir=str(project_dir(project)))
            # E4①⑤渲染后体检结果别丢:一并带回 job.result,供前端(follow-up)展示"但有点问题"。
            health, caption_health = res.get("health"), res.get("caption_health")
            return {"urls": [f"/uploads/edits/{project}/{name}"],
                    "is_video": True, "duration": d.duration(),
                    "health": health, "caption_health": caption_health,
                    "caveat": qc_caveat_message(health, caption_health)}
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "video_render", work_fn,
        params={"project": project, "name": name}, conversation_id=conv,
    )
    return {"job_id": job_id}


# ══════════════════ V2 自研模板渲染器(氛围·有包装·可对话改文案)══════════════════

@router.post("/auto_plan_v2")
async def video_auto_plan_v2(
    body: AutoPlanIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
    db=Depends(get_db),
):
    """V2 一键出方案 + 配文案(不渲染):挑高光(VLM) → 豆包导演配文案。

    慢(抽帧+VLM)→ 异步返回 {job_id};前端轮询拿 {project, report, brand, captions}。
    前端据此做客户端预览;导出成片走 /render_v2;改文案走 /recaption。
    """
    paths = [str(p) for p in (body.video_paths or []) if str(p).strip()]
    if not paths:
        raise AIServiceError("没给视频:请选要剪的本地视频。")
    for p in paths:
        if not Path(p).is_file():
            raise AIServiceError(f"找不到视频文件:{p}")
    if body.mode != "ambient":
        raise AIServiceError(f"暂只支持氛围模式(ambient),口播模式后续接;收到 mode={body.mode}")

    project = Path(str(body.project or "")).name or uuid.uuid4().hex[:10]
    store_id, conv = store.id, body.conversation_id
    ratio, target = body.ratio, body.target_duration

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(10, "在看每段视频哪一刻最出彩、把废镜头挑出去…")
            from services.video_edit.assemble import auto_plan_v2 as _apv2
            from services.video_edit.projects import project_dir, save_doc
            from services.video_edit.timeline import TimelineDoc

            edit_dir = str(project_dir(project))
            res = await asyncio.to_thread(_apv2, paths, edit_dir, ratio=ratio, target_duration=target)
            await progress(80, "在配文案…")
            save_doc(project, TimelineDoc.model_validate(res["doc"]))
            return {"project": project, "report": res["report"], "brand": res["brand"],
                    "captions": res["captions"], "used_vlm": res["used_vlm"]}
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "video_auto_plan", work_fn,
        params={"project": project, "n": len(paths), "mode": body.mode}, conversation_id=conv,
    )
    return {"job_id": job_id, "project": project}


@router.post("/projects/{project}/recaption")
async def video_recaption(
    project: str,
    body: RecaptionIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """对话改文案(快·同步):店主大白话指令 → LLM 带上下文重写文案 → 返回新文案给前端即时刷新预览。"""
    from services.video_edit.assemble import recaption_v2
    from services.video_edit.projects import project_dir

    if not (project_dir(project) / "v2_plan.json").exists():
        raise AIServiceError("这个项目还没出过 V2 方案(先 /auto_plan_v2)")
    res = await asyncio.to_thread(recaption_v2, str(project_dir(project)), body.tonality)
    return {"ok": True, "brand": res["brand"], "captions": res["captions"]}


@router.post("/projects/{project}/edit_feedback")
async def video_edit_feedback(
    project: str,
    body: EditFeedbackIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """对话改任何东西(快·同步):店主大白话反馈 → LLM 理解 → 改方案(换段/删段/改序/短长/调色/配乐/文案)。

    返回 {reply, brand, shots, grade, ratio, music_mood}——shots 带 src/start/end/caption,前端据此重建预览。
    同步重建并保存时间轴文档,保持 getVideoProject/出片一致。
    """
    from services.video_edit.assemble import plan_to_doc, load_v2_plan
    from services.video_edit.edit_agent import apply_feedback
    from services.video_edit.projects import project_dir as _pd, save_doc

    if not (_pd(project) / "v2_plan.json").exists():
        raise AIServiceError("这个项目还没出过 V2 方案(先 /auto_plan_v2)")
    res = await asyncio.to_thread(apply_feedback, str(_pd(project)), body.feedback)
    try:
        await asyncio.to_thread(lambda: save_doc(project, plan_to_doc(load_v2_plan(str(_pd(project))))))
    except Exception:  # noqa: BLE001 —— 保存失败不影响返回(渲染读 plan 不读 doc)
        pass
    return {"ok": True, "reply": res["reply"], "brand": res["brand"], "shots": res["shots"],
            "grade": res.get("grade"), "ratio": res.get("ratio"), "music_mood": res.get("music_mood")}


@router.post("/projects/{project}/render_v2")
async def video_render_v2(
    project: str,
    body: RenderIn,
    user: User = Depends(get_current_user),
    store=Depends(get_current_store),
):
    """V2 出片:按当前文案渲染有包装的竖屏成片。慢(逐帧渲染)→ 异步返回 {job_id}。"""
    from services.video_edit.projects import load_doc

    doc = load_doc(project)
    if doc is None:
        raise AIServiceError("没找到这个剪辑项目")
    if not doc.video_clips_ordered():
        raise AIServiceError("时间轴里还没视频片段")

    store_id, conv = store.id, body.conversation_id
    name = Path(str(body.output_name or "成片")).name
    if not name.endswith(".mp4"):
        name += ".mp4"

    async def work_fn(progress):
        from core.tenant import set_tenant
        set_tenant(store_id)
        try:
            await progress(15, "在渲染成片(带包装),好了叫你…")
            from services.video_edit.assemble import render_v2_project
            from services.video_edit.footage_qc import qc_caveat_message
            from services.video_edit.projects import load_doc as _ld, project_dir

            d = _ld(project)
            out = project_dir(project) / name
            res = await asyncio.to_thread(render_v2_project, str(project_dir(project)), str(out))
            # E4⑤渲染后体检结果别丢:一并带回 job.result,供前端(follow-up)展示"但有点问题"。
            health, caption_health = res.get("health"), res.get("caption_health")
            return {"urls": [f"/uploads/edits/{project}/{name}"], "is_video": True, "duration": d.duration(),
                    "health": health, "caption_health": caption_health,
                    "caveat": qc_caveat_message(health, caption_health)}
        finally:
            set_tenant(None)

    job_id = await media_jobs_runner.submit(
        store_id, "video_render", work_fn,
        params={"project": project, "name": name}, conversation_id=conv,
    )
    return {"job_id": job_id}
