from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import AIServiceError
from core.security_guard import check_input_injection, filter_output_leak
from models.user import User
from models.store import Store
from services.ai.base import TextRequest
from services.ai.factory import ProviderFactory
from services.brand_voice_service import get_brand_voice_context
from services.content_service import _strip_ai_prefixes, _validate_provider_for_production
from services.quota_service import check_quota, increment_usage

router = APIRouter()


class BatchGenerateRequest(BaseModel):
    content_type: Literal["moments", "group_notice", "activity"]  # 内容类型
    count: int = 5  # 生成数量（1-10）
    extra_note: str | None = None  # 补充说明
    model: str | None = None


@router.post("/batch")
async def batch_generate(
    body: BatchGenerateRequest,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """批量生成多条内容。"""
    # 输入安全检查 + 配额检查（此前缺失，导致批量生成绕过付费限额）
    injection_check = check_input_injection(body.extra_note or "")
    if injection_check:
        raise AIServiceError(injection_check)
    await check_quota(db, str(store.id))
    _validate_provider_for_production()

    count = min(max(body.count, 1), 10)

    # 获取品牌声音
    brand_voice = await get_brand_voice_context(db, store.id)

    # 构建 prompt
    type_prompts = {
        "moments": f"写{count}条不同角度的朋友圈文案",
        "group_notice": f"写{count}条不同角度的微信群公告",
        "activity": f"策划{count}个不同类型的活动方案",
    }
    base_prompt = type_prompts.get(body.content_type, type_prompts["moments"])

    extra_parts = [base_prompt]
    if body.extra_note:
        extra_parts.append(body.extra_note)
    if brand_voice:
        extra_parts.append(brand_voice)

    extra_parts.append(f"门店名称：{store.name}")
    extra_parts.append("请用数字编号区分每条内容，每条之间用空行分隔。")

    full_prompt = "\n\n".join(extra_parts)

    request = TextRequest(prompt=full_prompt, max_tokens=3000)
    response = await ProviderFactory.generate_with_fallback(request)

    content = _strip_ai_prefixes(response[0].content)
    content = filter_output_leak(content)

    # 按编号拆分
    items = []
    current = ""
    for line in content.split("\n"):
        if line.strip() and line.strip()[0].isdigit() and "." in line[:3]:
            if current.strip():
                items.append(current.strip())
            current = line
        else:
            current += "\n" + line
    if current.strip():
        items.append(current.strip())

    await increment_usage(db, str(store.id), tokens=response[0].tokens_used or 0)

    return {
        "items": items[:count],
        "model_used": response[0].model,
        "tokens_used": response[0].tokens_used,
    }
