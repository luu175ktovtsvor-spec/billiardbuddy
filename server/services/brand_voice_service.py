import logging
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.generation import Generation

logger = logging.getLogger(__name__)


async def get_brand_voice_context(db: AsyncSession, store_id, limit: int = 5) -> str:
    """查询标记为"效果好"的历史内容，提取风格特征作为 prompt 上下文。"""
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.effect_rating == "good",
        )
        .order_by(Generation.rated_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    good_gens = result.scalars().all()

    if not good_gens:
        return ""

    examples = []
    for i, gen in enumerate(good_gens, 1):
        content = gen.result or ""
        if content:
            examples.append(f"示例{i}（{gen.type}）：\n{content[:500]}")

    if not examples:
        return ""

    return (
        "以下是该门店效果好的历史内容，请参考其风格、语气和表达方式：\n\n"
        + "\n\n".join(examples)
        + "\n\n请保持类似的风格生成新内容。"
    )
