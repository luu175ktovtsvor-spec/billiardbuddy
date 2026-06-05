from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from models.user import User
from models.store import Store
from schemas.sop import SOPRequest, SOPResponse
from services.sop_service import query_sop

router = APIRouter(tags=["前厅SOP"])


@router.post("/query", response_model=SOPResponse)
async def query_sop_api(
    body: SOPRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    generation = await query_sop(
        db=db,
        store=current_store,
        user=current_user,
        role=body.role,
        scenario=body.scenario,
        customer_type=body.customer_type,
    )
    return SOPResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )
