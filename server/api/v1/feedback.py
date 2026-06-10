import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import NotFoundException
from models.generation import Generation
from models.user import User
from models.store import Store
from schemas.feedback import FeedbackRequest

router = APIRouter()


@router.post("/generations/{generation_id}/feedback")
async def submit_feedback(
    generation_id: uuid.UUID,
    body: FeedbackRequest,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    generation = await db.get(Generation, generation_id)
    if not generation or generation.store_id != store.id:
        raise NotFoundException("生成记录不存在")

    generation.effect_rating = body.rating  # "good" / "bad"
    generation.effect_note = body.note
    generation.rated_at = datetime.now(timezone.utc)

    await db.commit()
    return {"status": "ok"}
