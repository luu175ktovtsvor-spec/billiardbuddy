from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from models.user import User
from models.store import Store
from schemas.dashboard import DashboardTodayResponse
from services.dashboard_service import get_today_dashboard

router = APIRouter(tags=["今日工作台"])


@router.get("/today", response_model=DashboardTodayResponse)
async def dashboard_today(
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    return await get_today_dashboard(db=db, store=store)
