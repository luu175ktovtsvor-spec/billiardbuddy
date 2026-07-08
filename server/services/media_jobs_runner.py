"""media_jobs 后台 runner:提交即返 job_id → 后台 asyncio 任务跑 work_fn → 边跑边写进度 →
完成/失败落库。单用户本地 in-process(对标 background_tools,但有可查询的持久状态)。

work_fn 约定:
    async def work_fn(progress) -> dict | None
    progress 是 async 回调: await progress(pct: int | None = None, stage: str | None = None)

每次进度/完成/失败各开一个短 session 写库(别长事务占着 SQLite 写锁);后台任务自带 session,
不复用请求 session(请求早返回了)。

F-10：submit()/`_run()` 可选带 `on_done` 完成回调，job 落库(done/error 皆算"完成")后调用一次：
    async def on_done(job_id: str, status: str, result: dict | None, error: str | None) -> None
不传就是原样行为(studio.py/video_edit.py 现有调用点都不传，零影响)。这是给"挂在聊天里的慢工具"
    render_video 用的——它提交完就立即返回，真正做完时得靠这个钩子把结果回灌进
对话轨迹 + 弹通知，见 `services/agent/media_job_notify.py`。钩子异常只记日志、绝不影响任务
本身已经落库的终态(runner 是 fire-and-forget 后台任务，没人等它抛错)。
"""
import asyncio
import logging
from typing import Awaitable, Callable

from db.session import async_session
from services import media_jobs_service as mj

logger = logging.getLogger(__name__)

# 持有后台任务引用,防被 GC(asyncio 不持引用会随时回收)。
_tasks: "set[asyncio.Task]" = set()

OnDone = Callable[[str, str, "dict | None", "str | None"], Awaitable[None]]


async def submit(store_id, kind, work_fn, params=None, conversation_id=None, on_done: OnDone | None = None) -> str:
    """建 queued 任务 → 后台跑 work_fn → 立刻返回 job_id(不等跑完)。"""
    async with async_session() as db:
        job = await mj.create_job(db, store_id, kind, params=params, conversation_id=conversation_id)
        job_id = str(job.id)
    task = asyncio.create_task(_run(job_id, store_id, work_fn, on_done=on_done))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return job_id


async def _run(job_id, store_id, work_fn, on_done: OnDone | None = None) -> None:
    async def progress(pct=None, stage=None):
        try:
            async with async_session() as db:
                await mj.update_progress(db, job_id, store_id, progress=pct, stage=stage)
        except Exception:
            logger.warning("media_job %s 进度写入失败(不致命,继续跑)", job_id, exc_info=True)

    status, result, error = "done", None, None
    try:
        raw = await work_fn(progress)
        result = raw if isinstance(raw, dict) else None
        async with async_session() as db:
            await mj.complete_job(db, job_id, store_id, result=result)
    except Exception as e:  # noqa: BLE001  后台任务出啥错都要落 error,别静默吞掉
        logger.exception("media_job %s 跑挂了", job_id)
        status = "error"
        error = str(e) or e.__class__.__name__
        try:
            async with async_session() as db:
                await mj.fail_job(db, job_id, store_id, error)
        except Exception:
            logger.error("media_job %s 连失败状态都没写进去", job_id, exc_info=True)

    if on_done is not None:
        try:
            await on_done(job_id, status, result, error)
        except Exception:
            logger.warning("media_job %s 完成回调(on_done)出错，不影响任务本身已落库的终态", job_id, exc_info=True)
