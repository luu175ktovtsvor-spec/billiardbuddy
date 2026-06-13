from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store
from schemas.dashboard import DashboardTodayResponse, CardSignalsResponse
from services.dashboard_service import get_today_dashboard, get_card_signals

router = APIRouter(tags=["今日工作台"])


@router.get("/today", response_model=DashboardTodayResponse)
async def dashboard_today(
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.DASHBOARD_VIEW)),
):
    return await get_today_dashboard(db=db, store=store)


@router.get("/card-signals", response_model=CardSignalsResponse)
async def dashboard_card_signals(
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.DASHBOARD_VIEW)),
):
    return await get_card_signals(db=db, store=store)
