from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from models.user import User
from models.store import Store
from schemas.performance import PerformanceRequest, PerformanceResponse
from services.performance_service import generate_performance_template

router = APIRouter(tags=["绩效考核"])


@router.post("/template", response_model=PerformanceResponse)
async def generate_performance_template_api(
    body: PerformanceRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    generation = await generate_performance_template(
        db=db,
        store=current_store,
        user=current_user,
        role=body.role,
        period=body.period,
    )
    return PerformanceResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )
