from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from models.user import User
from models.store import Store
from schemas.outreach import OutreachRequest, OutreachResponse
from services.outreach_service import generate_outreach

router = APIRouter(tags=["助教约客"])


@router.post("/generate", response_model=OutreachResponse)
async def generate_outreach_api(
    body: OutreachRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    generation = await generate_outreach(
        db=db,
        store=current_store,
        user=current_user,
        customer_name=body.customer_name,
        customer_type=body.customer_type,
        relationship=body.relationship,
        style=body.style,
        extra_note=body.extra_note,
    )
    return OutreachResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )
