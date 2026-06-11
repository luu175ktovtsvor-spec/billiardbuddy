from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store
from services.brand_voice_service import get_brand_voice_context
from services.content_service import run_generation

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
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    """批量生成多条内容。"""
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

    # 统一管道：注入检查 + 配额 + 过滤 + 落库（此前不落库，无历史可查）+ 计费
    generation = await run_generation(
        db, store, user,
        prompt=full_prompt,
        gen_type="batch",
        sub_type=body.content_type,
        input_params={"content_type": body.content_type, "count": count, "extra_note": body.extra_note},
        user_input=body.extra_note or "",
        use_fallback=True,
    )

    content = generation.result or ""

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

    return {
        "items": items[:count],
        "model_used": generation.model_used,
        "tokens_used": generation.tokens_used,
        "generation_id": str(generation.id),
    }
