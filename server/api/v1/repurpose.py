from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import NotFoundException
from core.rbac import Permission, require_permission
from core.security_guard import filter_output_leak
from models.generation import Generation
from models.user import User
from models.store import Store
from services.ai.base import TextRequest
from services.ai.factory import ProviderFactory
from services.content_service import _validate_provider_for_production
from services.quota_service import check_quota, increment_usage

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
    # 1. 获取原始内容
    generation = await db.get(Generation, body.generation_id)
    if not generation or generation.store_id != store.id or generation.is_deleted:
        raise NotFoundException("生成记录不存在")

    # 配额检查（此前缺失，导致内容变体绕过付费限额）
    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    # 2. 构建变体 prompt
    platform_prompt = PLATFORM_PROMPTS.get(body.target_platform, PLATFORM_PROMPTS["wechat_moments"])
    full_prompt = f"{platform_prompt}\n\n原始内容：\n{generation.result}"

    # 3. 调用 AI 生成
    request = TextRequest(prompt=full_prompt, max_tokens=1000)
    response = await ProviderFactory.generate_with_fallback(request)

    content = filter_output_leak(response[0].content)
    await increment_usage(db, str(store.id), tokens=response[0].tokens_used or 0)

    return {"content": content, "platform": body.target_platform}
