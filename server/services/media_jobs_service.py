"""生成工作室异步任务(media_jobs)服务:DB 状态机 —— create / get / list + 进度/完成/失败更新。

单用户本地 in-process,不上 Celery/Redis。这里只管纯异步 DB 操作(好测);真正"后台跑任务"
的 runner(asyncio.create_task + 自带 session 写进度)在后续 media_jobs_runner 里,用本模块更新状态。
全部 store 作用域(多租户),id 非法/越店一律取不到、不报错(get/list)或抛错(update)。
"""
import uuid

from sqlalchemy import select, update as sa_update

from core.exceptions import AIServiceError
from models.media_job import MediaJob

VALID_KINDS = {"generate", "edit", "variations", "i2v", "compose", "video_inventory", "video_render", "video_auto_plan"}
_ACTIVE = ("queued", "running")


def _as_uuid(v):
    if v is None:
        return None
    if isinstance(v, uuid.UUID):
        return v
    try:
        return uuid.UUID(str(v))
    except (ValueError, TypeError):
        return None


async def create_job(db, store_id, kind, params=None, conversation_id=None) -> MediaJob:
    """建一条 queued 任务,返回 MediaJob(调用方用 .id)。"""
    if kind not in VALID_KINDS:
        raise AIServiceError(f"未知任务类型:{kind}")
    job = MediaJob(
        id=uuid.uuid4(), store_id=store_id, kind=kind, status="queued", progress=0,
        params=params, conversation_id=_as_uuid(conversation_id),
    )
    db.add(job)
    await db.flush()
    await db.commit()
    return job


async def get_job(db, job_id, store_id) -> MediaJob | None:
    gid = _as_uuid(job_id)
    if gid is None:
        return None
    res = await db.execute(select(MediaJob).where(MediaJob.id == gid, MediaJob.store_id == store_id))
    return res.scalar_one_or_none()


async def list_jobs(db, store_id, conversation_id=None, active_only=False) -> list[MediaJob]:
    q = select(MediaJob).where(MediaJob.store_id == store_id)
    cid = _as_uuid(conversation_id)
    if cid is not None:
        q = q.where(MediaJob.conversation_id == cid)
    if active_only:
        q = q.where(MediaJob.status.in_(_ACTIVE))
    res = await db.execute(q.order_by(MediaJob.created_at.desc()))
    return list(res.scalars().all())


async def update_progress(db, job_id, store_id, progress=None, stage=None) -> None:
    """报进度:置为 running,可带 0-100 进度和大白话阶段文案。"""
    values: dict = {"status": "running"}
    if progress is not None:
        values["progress"] = max(0, min(100, int(progress)))
    if stage is not None:
        values["stage"] = str(stage)[:120]
    await _apply(db, job_id, store_id, values)


async def complete_job(db, job_id, store_id, result=None) -> None:
    await _apply(db, job_id, store_id, {"status": "done", "progress": 100, "result": result})


async def fail_job(db, job_id, store_id, error: str) -> None:
    await _apply(db, job_id, store_id, {"status": "error", "error": (error or "")[:2000]})


async def _apply(db, job_id, store_id, values: dict) -> None:
    gid = _as_uuid(job_id)
    if gid is None:
        raise AIServiceError("任务 id 不对")
    await db.execute(
        sa_update(MediaJob).where(MediaJob.id == gid, MediaJob.store_id == store_id).values(**values)
    )
    await db.commit()
