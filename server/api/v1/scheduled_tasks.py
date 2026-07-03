"""定时任务 REST API —— 给下一单(D-Task-4)前端「定时任务」面板用：建/列/改(开关等)/删。

免登录单用户：`get_current_store` 返本地 seed 的唯一店；`scheduled_tasks` 表不在
`core/tenant.py` 的自动租户过滤覆盖范围内(那套只兜 generations/usage_quotas)，
所以这里全部手写 `.where(store_id==)` —— 漏写就是跨店泄露(CLAUDE.md 铁律)。

执行/调度逻辑在 `services/agent/scheduled_tasks.py`；这里只是给它管理数据的 CRUD 壳子，
不在这里跑 agent。
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func as sa_func
from sqlalchemy import select

from api.deps import get_current_store, get_db
from models.scheduled_task import ScheduledTask
from services.agent.scheduled_tasks import _MAX_TASKS_PER_STORE, _as_aware_utc, _compute_next_run

router = APIRouter()

_VALID_KINDS = {"daily", "weekly", "interval"}


class ScheduledTaskCreate(BaseModel):
    name: str
    instruction: str
    schedule_kind: str  # daily / weekly / interval
    schedule_spec: dict
    billiards_mode: bool = False


class ScheduledTaskUpdate(BaseModel):
    name: str | None = None
    instruction: str | None = None
    schedule_kind: str | None = None
    schedule_spec: dict | None = None
    billiards_mode: bool | None = None
    enabled: bool | None = None


class ScheduledTaskItem(BaseModel):
    id: str
    name: str
    instruction: str
    billiards_mode: bool
    schedule_kind: str
    schedule_spec: dict
    next_run_at: str | None
    last_run_at: str | None
    last_run_status: str | None
    last_result_summary: str | None
    enabled: bool


def _item(t: ScheduledTask) -> ScheduledTaskItem:
    # ⚠️ SQLite 读出的 DateTime(timezone=True) 列会丢 tzinfo（M12 老坑）——裸 isoformat()
    # 会吐出无时区后缀的串，前端 `new Date(iso)` 会当本地时间误解析，北京用户看到的时间会
    # 错 8 小时。这里统一经 `_as_aware_utc()` 兜底成 UTC-aware 再序列化，ISO 串带 `+00:00`
    # 后缀，前端才能按 UTC 正确解析再转本地显示。
    return ScheduledTaskItem(
        id=str(t.id),
        name=t.name,
        instruction=t.instruction,
        billiards_mode=bool(t.billiards_mode),
        schedule_kind=t.schedule_kind,
        schedule_spec=t.schedule_spec or {},
        next_run_at=_as_aware_utc(t.next_run_at).isoformat() if t.next_run_at else None,
        last_run_at=_as_aware_utc(t.last_run_at).isoformat() if t.last_run_at else None,
        last_run_status=t.last_run_status,
        last_result_summary=t.last_result_summary,
        enabled=bool(t.enabled),
    )


async def _get_task(task_id: str, store, db) -> ScheduledTask:
    task = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.id == task_id, ScheduledTask.store_id == store.id)
    )).scalars().first()
    if task is None:
        raise HTTPException(status_code=404, detail="没找到这个定时任务")
    return task


@router.get("", response_model=list[ScheduledTaskItem])
async def list_scheduled_tasks_route(store=Depends(get_current_store), db=Depends(get_db)):
    rows = (await db.execute(
        select(ScheduledTask).where(ScheduledTask.store_id == store.id).order_by(ScheduledTask.created_at)
    )).scalars().all()
    return [_item(t) for t in rows]


@router.post("", response_model=ScheduledTaskItem)
async def create_scheduled_task_route(
    body: ScheduledTaskCreate, store=Depends(get_current_store), db=Depends(get_db),
):
    name = body.name.strip()
    instruction = body.instruction.strip()
    if not name or not instruction:
        raise HTTPException(status_code=400, detail="name 和 instruction 不能为空")
    if body.schedule_kind not in _VALID_KINDS:
        raise HTTPException(status_code=400, detail="schedule_kind 需要是 daily/weekly/interval 之一")
    if not isinstance(body.schedule_spec, dict):
        raise HTTPException(status_code=400, detail="schedule_spec 需要是一个对象")

    count = (await db.execute(
        select(sa_func.count()).select_from(ScheduledTask).where(
            ScheduledTask.store_id == store.id, ScheduledTask.enabled.is_(True)
        )
    )).scalar_one()
    if count >= _MAX_TASKS_PER_STORE:
        raise HTTPException(status_code=400, detail=f"每店最多同时开 {_MAX_TASKS_PER_STORE} 条定时任务，先关掉几条旧的再加")

    try:
        next_run = _compute_next_run(body.schedule_kind, body.schedule_spec)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    task = ScheduledTask(
        store_id=store.id, name=name, instruction=instruction, billiards_mode=body.billiards_mode,
        schedule_kind=body.schedule_kind, schedule_spec=body.schedule_spec, next_run_at=next_run, enabled=True,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return _item(task)


@router.patch("/{task_id}", response_model=ScheduledTaskItem)
async def update_scheduled_task_route(
    task_id: str, body: ScheduledTaskUpdate, store=Depends(get_current_store), db=Depends(get_db),
):
    task = await _get_task(task_id, store, db)
    schedule_changed = False

    if body.name is not None:
        name = body.name.strip()
        if not name:
            raise HTTPException(status_code=400, detail="name 不能为空")
        task.name = name
    if body.instruction is not None:
        instruction = body.instruction.strip()
        if not instruction:
            raise HTTPException(status_code=400, detail="instruction 不能为空")
        task.instruction = instruction
    if body.billiards_mode is not None:
        task.billiards_mode = body.billiards_mode
    if body.schedule_kind is not None:
        if body.schedule_kind not in _VALID_KINDS:
            raise HTTPException(status_code=400, detail="schedule_kind 需要是 daily/weekly/interval 之一")
        task.schedule_kind = body.schedule_kind
        schedule_changed = True
    if body.schedule_spec is not None:
        if not isinstance(body.schedule_spec, dict):
            raise HTTPException(status_code=400, detail="schedule_spec 需要是一个对象")
        task.schedule_spec = body.schedule_spec
        schedule_changed = True
    if body.enabled is not None:
        # 重新启用一个暂停过的任务不算"新建"，但"停用->启用"这次切换仍要重查上限，
        # 否则"建满10条→停几条→再新建几条→把停掉的重新启用"能绕过硬限，让启用中总数超过10条。
        if body.enabled and not task.enabled:
            count = (await db.execute(
                select(sa_func.count()).select_from(ScheduledTask).where(
                    ScheduledTask.store_id == store.id,
                    ScheduledTask.enabled.is_(True),
                    ScheduledTask.id != task.id,
                )
            )).scalar_one()
            if count >= _MAX_TASKS_PER_STORE:
                raise HTTPException(
                    status_code=400,
                    detail=f"每店最多同时开 {_MAX_TASKS_PER_STORE} 条定时任务，先关掉几条旧的再加",
                )
        task.enabled = body.enabled

    if schedule_changed:
        try:
            task.next_run_at = _compute_next_run(task.schedule_kind, task.schedule_spec)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    await db.commit()
    await db.refresh(task)
    return _item(task)


@router.delete("/{task_id}")
async def delete_scheduled_task_route(task_id: str, store=Depends(get_current_store), db=Depends(get_db)):
    task = await _get_task(task_id, store, db)
    await db.delete(task)
    await db.commit()
    return {"status": "ok"}
