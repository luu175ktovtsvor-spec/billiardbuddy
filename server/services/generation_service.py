import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.generation import Generation


async def list_generations(
    db: AsyncSession,
    store_id: uuid.UUID,
    page: int = 1,
    page_size: int = 20,
    generation_type: str | None = None,
    sub_type: str | None = None,
    is_favorite: bool | None = None,
) -> tuple[list[Generation], int]:
    page = max(1, page)
    page_size = max(1, min(page_size, 50))

    conditions = [Generation.store_id == store_id, Generation.is_deleted == False]
    if generation_type:
        conditions.append(Generation.type == generation_type)
    if sub_type:
        conditions.append(Generation.sub_type == sub_type)
    if is_favorite is not None:
        conditions.append(Generation.is_favorite == is_favorite)

    count_query = select(func.count()).select_from(Generation).where(*conditions)
    total_result = await db.execute(count_query)
    total = total_result.scalar()

    items_query = (
        select(Generation)
        .where(*conditions)
        .order_by(Generation.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    items_result = await db.execute(items_query)
    items = list(items_result.scalars().all())

    return items, total


async def get_generation_detail(
    db: AsyncSession,
    store_id: uuid.UUID,
    generation_id: uuid.UUID,
) -> Generation | None:
    result = await db.execute(
        select(Generation).where(
            Generation.id == generation_id,
            Generation.store_id == store_id,
        )
    )
    return result.scalar_one_or_none()
