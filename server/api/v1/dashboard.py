from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
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
):
    return await get_today_dashboard(db=db, store=store)


@router.get("/card-signals", response_model=CardSignalsResponse)
async def dashboard_card_signals(
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    return await get_card_signals(db=db, store=store)


class AdoptRecRequest(BaseModel):
    rec_id: str  # 被点的今日推荐 id（rec.id）


@router.post("/adopt-rec")
async def dashboard_adopt_rec(
    body: AdoptRecRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """隐式反馈·采纳上浮：老板点某条今日推荐去做时调一下，记一次"采纳"弱正反馈。
    轻量、不建表——落成 usage 事件（喂分析）；真正影响排序的是随后那条对话生成上带的 source_rec_id
    （见 agent.py），二者互补。故障安全：记录失败不影响前端跳转。"""
    rec_id = (body.rec_id or "").strip()[:50]
    if rec_id:
        try:
            from services.usage_event_service import log_event
            await log_event("rec_adopted", store_id=str(store.id),
                            user_id=(str(current_user.id) if current_user else None),
                            props={"rec_id": rec_id})
        except Exception:
            pass
    return {"status": "ok", "rec_id": rec_id}


class DismissRecRequest(BaseModel):
    rec_id: str  # 被踩的今日推荐 id（rec.id）


@router.post("/dismiss-rec")
async def dashboard_dismiss_rec(
    body: DismissRecRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """隐式反馈·今天先收起：老板点某条今日推荐的「踩/不感兴趣」时调一下，记一次「今日不看」。
    落成 usage 事件(rec_dismissed)，当天的今日工作台会把这条过滤掉；次日照常出现（dismiss-for-today）。
    故障安全：记录失败不影响前端。"""
    rec_id = (body.rec_id or "").strip()[:50]
    if rec_id:
        try:
            from services.usage_event_service import log_event
            from core.timezone import BUSINESS_TZ
            from datetime import datetime
            await log_event("rec_dismissed", store_id=str(store.id),
                            user_id=(str(current_user.id) if current_user else None),
                            props={"rec_id": rec_id, "date": datetime.now(BUSINESS_TZ).strftime("%Y-%m-%d")})
        except Exception:
            pass
    return {"status": "ok", "rec_id": rec_id}
