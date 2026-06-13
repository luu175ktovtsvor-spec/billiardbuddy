from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store
from schemas.generate import (
    CopywritingRequest,
    ActivityRequest,
    OperationRequest,
    WorkbenchRequest,
    GenerationResponse,
)
from services.content_service import generate_copywriting, generate_activity, generate_operation, generate_workbench
from services.store_profile_service import detect_profile_suggestions

router = APIRouter(tags=["内容生成"])


@router.post("/copywriting", response_model=GenerationResponse)
async def generate_copywriting_api(
    body: CopywritingRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    generation = await generate_copywriting(
        db=db,
        store=current_store,
        user=current_user,
        sub_type=body.sub_type.value,
        tone=body.tone.value,
        scenario=body.scenario,  # scenario 是 str 字段，不是枚举，不能 .value（修复 500）
        extra_note=body.extra_note,
    )
    return GenerationResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )


@router.post("/activity", response_model=GenerationResponse)
async def generate_activity_api(
    body: ActivityRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    generation = await generate_activity(
        db=db,
        store=current_store,
        user=current_user,
        activity_goal=body.activity_goal.value,
        target_customer=body.target_customer,
        budget_level=body.budget_level.value if body.budget_level else None,
        duration=body.duration,
        extra_note=body.extra_note,
    )
    return GenerationResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )


@router.post("/operation", response_model=GenerationResponse)
async def generate_operation_api(
    body: OperationRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    generation = await generate_operation(
        db=db,
        store=current_store,
        user=current_user,
        scenario=body.scenario.value,
        tone=body.tone.value,
        target=body.target,
        extra_note=body.extra_note,
    )
    return GenerationResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
    )


@router.post("/workbench", response_model=GenerationResponse)
async def generate_workbench_api(
    body: WorkbenchRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_CREATE)),
):
    generation = await generate_workbench(
        db=db,
        store=current_store,
        user=current_user,
        user_intent=body.user_intent,
        role=body.role.value,
        target_customer_type=body.target_customer_type.value if body.target_customer_type else None,
        output_package=[item.value for item in body.output_package] if body.output_package else None,
        extra_note=body.extra_note,
        prompt_key=body.prompt_key,
        concise=body.concise,
    )
    suggestions = detect_profile_suggestions(
        profile=current_store.operation_profile,
        role=body.role.value,
        target_customer_type=body.target_customer_type.value if body.target_customer_type else None,
        output_package=[item.value for item in body.output_package] if body.output_package else None,
        user_intent=body.user_intent,
        extra_note=body.extra_note,
    )
    return GenerationResponse(
        generation_id=str(generation.id),
        type=generation.type,
        sub_type=generation.sub_type or "",
        content=generation.result or "",
        created_at=generation.created_at,
        profile_suggestions=suggestions if suggestions else None,
    )
