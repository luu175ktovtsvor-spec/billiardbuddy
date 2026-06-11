"""协作任务 API"""

from typing import Annotated, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store
from services.quota_service import check_quota, increment_usage
from services.orchestrator import (
    start_task,
    get_task,
    cancel_task,
    COLLABORATION_SCENARIOS,
)

router = APIRouter(tags=["orchestrate"])


class OrchestrateRequest(BaseModel):
    task_type: str
    description: str
    roles: Optional[list[str]] = None
    auto_orchestrate: bool = True


@router.post("")
async def create_orchestration(
    req: OrchestrateRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """发起协作任务"""
    if req.task_type not in COLLABORATION_SCENARIOS and req.task_type != "custom":
        raise HTTPException(status_code=400, detail=f"未知任务类型: {req.task_type}")

    # 协作任务一次触发多个 Agent 生成，按一次生成计入配额（先检查后计费，防无限刷）
    await check_quota(db, str(current_store.id))

    task = await start_task(
        task_type=req.task_type,
        description=req.description,
        store=current_store,
        roles=req.roles,
        auto_orchestrate=req.auto_orchestrate,
    )
    await increment_usage(db, str(current_store.id))
    return task


@router.get("/{task_id}")
async def get_orchestration(
    task_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
):
    """查询协作任务状态"""
    task = get_task(task_id, str(current_store.id))
    if not task:
        raise HTTPException(status_code=404, detail="任务不存在")
    return task


@router.post("/{task_id}/cancel")
async def cancel_orchestration(
    task_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
):
    """取消协作任务"""
    success = cancel_task(task_id, str(current_store.id))
    if not success:
        raise HTTPException(status_code=404, detail="任务不存在")
    return {"status": "cancelled"}
