"""Canvas（画布）定向改写路由——成品右侧展开后"指着某处说改这里"。"""
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.rbac import Permission, require_permission
from models.store import Store
from models.user import User
from services.canvas_service import canvas_edit

router = APIRouter()


class CanvasEditRequest(BaseModel):
    content: str                          # 当前成品全文（前端持有的最新版）
    instruction: str                      # 怎么改（老板的话）
    selection: str | None = None          # 老板圈中要改的那一段；空=整篇修订
    deliverable_type: str | None = None   # 成品类型(文案/活动方案/话术…)，只影响提示语气


@router.post("/edit")
async def canvas_edit_endpoint(
    body: CanvasEditRequest,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """圈了段只改那段（改这里不动别处），没圈则整篇修订。复用统一管道(配额/合规/落库/BYOK)。"""
    return await canvas_edit(
        db, store, user,
        content=body.content,
        instruction=body.instruction,
        selection=body.selection,
        deliverable_type=body.deliverable_type or "内容",
    )
