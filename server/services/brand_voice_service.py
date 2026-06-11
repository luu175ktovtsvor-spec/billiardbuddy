import logging
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.generation import Generation

logger = logging.getLogger(__name__)


async def get_brand_voice_context(db: AsyncSession, store_id, limit: int = 5) -> str:
    """查询标记为"效果好"的历史内容，提取风格特征作为 prompt 上下文。

    排除海报（result 是图片 URL，会以"示例N：/uploads/xx.png"污染 prompt）
    和已删除记录；同时把"效果差"的反馈原因拼成避免清单——让点踩真正改变行为。
    """
    stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.effect_rating == "good",
            Generation.is_deleted == False,
            Generation.type != "poster",
        )
        .order_by(Generation.rated_at.desc())
        .limit(limit)
    )
    result = await db.execute(stmt)
    good_gens = result.scalars().all()

    examples = []
    for i, gen in enumerate(good_gens, 1):
        content = gen.result or ""
        if content:
            examples.append(f"示例{i}：\n{content[:500]}")

    parts = []
    if examples:
        parts.append(
            "以下是该门店效果好的历史内容，请参考其风格、语气和表达方式：\n\n"
            + "\n\n".join(examples)
            + "\n\n请保持类似的风格生成新内容。"
        )

    # 负面反馈避免清单：用户点踩时填写的原因
    bad_stmt = (
        select(Generation)
        .where(
            Generation.store_id == store_id,
            Generation.effect_rating == "bad",
            Generation.effect_note.isnot(None),
            Generation.effect_note != "",
            Generation.is_deleted == False,
        )
        .order_by(Generation.rated_at.desc())
        .limit(3)
    )
    bad_result = await db.execute(bad_stmt)
    avoid_notes = [g.effect_note for g in bad_result.scalars().all() if g.effect_note]
    if avoid_notes:
        parts.append(
            "该门店此前对生成内容反馈过以下问题，请避免再犯：\n- "
            + "\n- ".join(avoid_notes)
        )

    return "\n\n".join(parts)
