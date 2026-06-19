import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import AppException, NotFoundException
from core.rbac import Permission, require_permission
from core.security_guard import check_input_injection
from models.generation import Generation
from models.user import User
from models.store import Store
from schemas.feedback import FeedbackRequest
from services.memory_service import learn_in_background

router = APIRouter()


@router.post("/generations/{generation_id}/feedback")
async def submit_feedback(
    generation_id: uuid.UUID,
    body: FeedbackRequest,
    background_tasks: BackgroundTasks,
    user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),  # 反馈会异步喂店脑、影响后续生成，按写操作
):
    generation = await db.get(Generation, generation_id)
    if not generation or generation.store_id != store.id or generation.is_deleted:
        raise NotFoundException("生成记录不存在")

    # 点踩备注会持久注入该店后续所有生成的"避免清单"——必须过注入检查
    if body.note:
        injection_check = check_input_injection(body.note)
        if injection_check:
            raise AppException(injection_check, status_code=400)

    generation.effect_rating = body.rating  # "good" / "bad"
    generation.effect_note = body.note
    generation.rated_at = datetime.now(timezone.utc)

    await db.commit()

    # 店脑：标"效果好"时，从【用户的原始需求/命名】学一条偏好——用 user_intent/title(用户自述、安全)，
    # 不用 sub_type(free_intent 时是 role 码=噪声)，更不碰 AI 产出正文(怕把 AI 编的当门店事实)。无有意义场景就不学。
    if body.rating == "good":
        params = generation.input_params if isinstance(generation.input_params, dict) else {}
        scenario = (generation.title or (params.get("user_intent") or "")).strip()
        if scenario:
            learn_text = f"老板把这条内容标记为效果好：「{scenario[:60]}」，说明这家店认可这个方向和风格。"
            background_tasks.add_task(learn_in_background, str(store.id), learn_text)

    return {"status": "ok"}
