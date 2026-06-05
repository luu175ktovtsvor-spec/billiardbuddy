from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from models.user import User
from models.store import Store
from schemas.games import GamesRequest, GamesResponse
from services.games_service import recommend_games

router = APIRouter(tags=["玩法推荐"])


@router.post("/recommend", response_model=GamesResponse)
async def recommend_games_api(
    body: GamesRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    generation = await recommend_games(
        db=db,
        store=current_store,
        user=current_user,
        customer_count=body.customer_count,
        skill_level=body.skill_level,
        time_available=body.time_available,
    )
    return GamesResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )
