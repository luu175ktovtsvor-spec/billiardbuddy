import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import NotFoundException
from models.generation import Generation
from models.store import Store
from models.user import User
from schemas.generation import (
    GenerationDetailResponse,
    GenerationListItem,
    GenerationListResponse,
)
from services.generation_service import get_generation_detail, list_generations

router = APIRouter()


@router.get("", response_model=GenerationListResponse)
async def list_generation_history(
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1)] = 20,
    generation_type: Annotated[str | None, Query(alias="type")] = None,
    sub_type: Annotated[str | None, Query()] = None,
    is_favorite: Annotated[bool | None, Query()] = None,
):
    page = max(1, page)
    page_size = max(1, min(page_size, 50))

    items, total = await list_generations(
        db=db,
        store_id=current_store.id,
        page=page,
        page_size=page_size,
        generation_type=generation_type,
        sub_type=sub_type,
        is_favorite=is_favorite,
    )

    return GenerationListResponse(
        items=[
            GenerationListItem(
                id=item.id,
                type=item.type,
                sub_type=item.sub_type,
                input_params=item.input_params,
                content=item.result,
                model_used=item.model_used,
                tokens_used=item.tokens_used,
                is_favorite=item.is_favorite,
                created_at=item.created_at,
            )
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/{generation_id}", response_model=GenerationDetailResponse)
async def get_generation_history_detail(
    generation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    generation = await get_generation_detail(
        db=db,
        store_id=current_store.id,
        generation_id=generation_id,
    )

    if generation is None:
        raise NotFoundException("生成记录不存在")

    return GenerationDetailResponse(
        id=generation.id,
        type=generation.type,
        sub_type=generation.sub_type,
        input_params=generation.input_params,
        content=generation.result,
        model_used=generation.model_used,
        tokens_used=generation.tokens_used,
        is_favorite=generation.is_favorite,
        created_at=generation.created_at,
    )


@router.patch("/{generation_id}/favorite")
async def toggle_generation_favorite(
    generation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """切换生成记录的收藏状态"""
    generation = await get_generation_detail(
        db=db,
        store_id=current_store.id,
        generation_id=generation_id,
    )
    if generation is None:
        raise NotFoundException("生成记录不存在")

    new_status = not generation.is_favorite
    await db.execute(
        update(Generation)
        .where(Generation.id == generation_id)
        .values(is_favorite=new_status)
    )
    await db.commit()
    return {"is_favorite": new_status}
