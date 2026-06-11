import uuid as uuid_mod
from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import NotFoundException
from core.rbac import Permission, require_permission
from models.generation import Generation
from models.user import User
from models.store import Store
from services.content_service import run_generation

router = APIRouter()


class RepurposeRequest(BaseModel):
    generation_id: str
    target_platform: str  # "douyin" / "xiaohongshu" / "group_notice" / "wechat_moments"
    model: str | None = None


PLATFORM_PROMPTS = {
    "douyin": "将以下内容改写为抖音文案，要求：更短、带话题标签、口语化、有 hook",
    "xiaohongshu": "将以下内容改写为小红书文案，要求：带表情、口语化、有标题党感觉",
    "group_notice": "将以下内容改写为微信群公告，要求：更正式、带时间地点、有行动号召",
    "wechat_moments": "将以下内容改写为朋友圈文案，要求：简洁、有 emoji、适合朋友圈阅读",
}


@router.post("/repurpose")
async def repurpose_content(
    body: RepurposeRequest,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """将一条内容变体为其他平台格式。"""
    # 非法 UUID 直接 404，而非 DBAPI 异常 500
    try:
        source_id = uuid_mod.UUID(body.generation_id)
    except ValueError:
        raise NotFoundException("生成记录不存在")

    generation = await db.get(Generation, source_id)
    if not generation or generation.store_id != store.id or generation.is_deleted:
        raise NotFoundException("生成记录不存在")

    platform_prompt = PLATFORM_PROMPTS.get(body.target_platform, PLATFORM_PROMPTS["wechat_moments"])
    full_prompt = f"{platform_prompt}\n\n原始内容：\n{generation.result}"

    # 统一管道：配额 + 过滤 + 落库（此前不落库，无历史可查）+ 计费
    result = await run_generation(
        db, store, user,
        prompt=full_prompt,
        gen_type="repurpose",
        sub_type=body.target_platform,
        input_params={
            "source_generation_id": str(source_id),
            "target_platform": body.target_platform,
        },
        max_tokens=1000,
        use_fallback=True,
    )

    return {
        "content": result.result,
        "platform": body.target_platform,
        "generation_id": str(result.id),
    }
