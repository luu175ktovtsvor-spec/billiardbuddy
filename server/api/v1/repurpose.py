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
    "douyin": (
        "把下面这条内容改写成一条**抖音短视频脚本/文案**：开头 3 秒一个强钩子(悬念/揭秘/反常识)；"
        "正文短句口播、有节奏、5 秒内有信息增量；突出 1 个核心卖点 + 结尾行动号召；"
        "末尾 3-5 个话题标签、必含 1 个同城标签(如 #本地台球 #同城探店)；口语有网感，不擦边、不浮夸、不喊'全城最低'。"
    ),
    "xiaohongshu": (
        "把下面这条内容改写成一条**小红书笔记**：标题 ≤20 字、带数字或人群痛点/场景钩子；"
        "正文用 emoji 分段(清单 1️⃣2️⃣3️⃣ / 对比 ✅❌)、像真人真诚分享不硬广；"
        "角度往 环境出片 / 女生友好 / 约球搭子 / 新手不踩雷 上靠；结尾引导互动 + 5-8 个标签(品类 + 同城 + 场景)。"
    ),
    "group_notice": (
        "把下面这条内容改写成一条**微信群公告**：开头一句点明这是啥事；写清时间、地点、怎么参加；"
        "要短、清楚、有行动号召；适合接龙的给出接龙格式(如：昵称 + 人数 + 时段)；像店里人发的、不像广告推送。"
    ),
    "wechat_moments": (
        "把下面这条内容改写成一条**朋友圈**：像真人随手发的、不像硬广；"
        "开头一句就抓人(场景共鸣 / 福利 / 有点意思的钩子)；3-5 行短，最多 1-2 个 emoji 别堆；"
        "结尾给个轻钩子(想来私我 / 帮你留台 / 群里说一声)；真诚不夸张、不刷屏、不喊'全城最低'这类。"
    ),
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
        max_tokens=1500,
        use_fallback=True,
    )

    return {
        "content": result.result,
        "platform": body.target_platform,
        "generation_id": str(result.id),
    }
