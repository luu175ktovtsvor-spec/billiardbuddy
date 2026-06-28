"""media_jobs 后台 runner:提交即返 job_id → 后台 asyncio 任务跑 work_fn → 边跑边写进度 →
完成/失败落库。单用户本地 in-process(对标 background_tools,但有可查询的持久状态)。

work_fn 约定:
    async def work_fn(progress) -> dict | None
    progress 是 async 回调: await progress(pct: int | None = None, stage: str | None = None)

每次进度/完成/失败各开一个短 session 写库(别长事务占着 SQLite 写锁);后台任务自带 session,
不复用请求 session(请求早返回了)。
"""
import asyncio
import logging

from db.session import async_session
from services import media_jobs_service as mj

logger = logging.getLogger(__name__)

# 持有后台任务引用,防被 GC(asyncio 不持引用会随时回收)。
_tasks: "set[asyncio.Task]" = set()


async def submit(store_id, kind, work_fn, params=None, conversation_id=None) -> str:
    """建 queued 任务 → 后台跑 work_fn → 立刻返回 job_id(不等跑完)。"""
    async with async_session() as db:
        job = await mj.create_job(db, store_id, kind, params=params, conversation_id=conversation_id)
        job_id = str(job.id)
    task = asyncio.create_task(_run(job_id, store_id, work_fn))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return job_id


async def _run(job_id, store_id, work_fn) -> None:
    async def progress(pct=None, stage=None):
        try:
            async with async_session() as db:
                await mj.update_progress(db, job_id, store_id, progress=pct, stage=stage)
        except Exception:
            logger.warning("media_job %s 进度写入失败(不致命,继续跑)", job_id, exc_info=True)

    try:
        result = await work_fn(progress)
        async with async_session() as db:
            await mj.complete_job(db, job_id, store_id, result=result if isinstance(result, dict) else None)
    except Exception as e:  # noqa: BLE001  后台任务出啥错都要落 error,别静默吞掉
        logger.exception("media_job %s 跑挂了", job_id)
        try:
            async with async_session() as db:
                await mj.fail_job(db, job_id, store_id, str(e) or e.__class__.__name__)
        except Exception:
            logger.error("media_job %s 连失败状态都没写进去", job_id, exc_info=True)
