import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_store, get_current_user, get_db
from core.exceptions import NotFoundException
from core.rbac import Permission, require_permission
from models.generation import Generation
from models.store import Store
from models.user import User
from schemas.generation import (
    GenerationDetailResponse,
    GenerationListItem,
    GenerationListResponse,
)
from services.generation_service import get_generation_detail, list_generations

router = APIRouter()


@router.get("", response_model=GenerationListResponse)
async def list_generation_history(
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1)] = 20,
    generation_type: Annotated[str | None, Query(alias="type")] = None,
    sub_type: Annotated[str | None, Query()] = None,
    is_favorite: Annotated[bool | None, Query()] = None,
    effect_rating: Annotated[str | None, Query()] = None,
    search: Annotated[str | None, Query(max_length=50)] = None,
):
    page = max(1, page)
    page_size = max(1, min(page_size, 50))

    items, total = await list_generations(
        db=db,
        store_id=current_store.id,
        page=page,
        page_size=page_size,
        generation_type=generation_type,
        sub_type=sub_type,
        is_favorite=is_favorite,
        effect_rating=effect_rating,
        search=search,
    )

    return GenerationListResponse(
        items=[
            GenerationListItem(
                id=item.id,
                type=item.type,
                sub_type=item.sub_type,
                input_params=item.input_params,
                content=item.result,
                result=item.result if item.type == "poster" else None,
                model_used=item.model_used,
                tokens_used=item.tokens_used,
                is_favorite=item.is_favorite,
                effect_rating=item.effect_rating,
                created_at=item.created_at,
            )
            for item in items
        ],
        total=total,
        page=page,
        page_size=page_size,
    )


@router.get("/export")
async def export_generations(
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    generation_type: Annotated[str | None, Query(alias="type")] = None,
):
    """导出生成历史为 CSV。

    必须注册在 /{generation_id} 之前——否则 "export" 会被 UUID 路径参数
    截获返回 422（该按钮此前因此从未生效过）。
    """
    from fastapi.responses import StreamingResponse
    import csv
    import io

    from sqlalchemy import select

    # 导出走专用查询：list_generations 会把 page_size 钳到 50，导出必须全量（上限 5000 防内存失控）
    stmt = (
        select(Generation)
        .where(Generation.store_id == current_store.id, Generation.is_deleted == False)
        .order_by(Generation.created_at.desc())
        .limit(5000)
    )
    if generation_type:
        stmt = stmt.where(Generation.type == generation_type)
    items = (await db.execute(stmt)).scalars().all()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["ID", "类型", "子类型", "内容", "模型", "Token数", "收藏", "效果评分", "创建时间"])

    for item in items:
        writer.writerow([
            str(item.id),
            item.type,
            item.sub_type or "",
            item.result or "",
            item.model_used or "",
            item.tokens_used or 0,
            "是" if item.is_favorite else "否",
            item.effect_rating or "",
            item.created_at.strftime("%Y-%m-%d %H:%M"),
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=generations.csv"},
    )


@router.get("/{generation_id}", response_model=GenerationDetailResponse)
async def get_generation_history_detail(
    generation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
):
    generation = await get_generation_detail(
        db=db,
        store_id=current_store.id,
        generation_id=generation_id,
    )

    if generation is None:
        raise NotFoundException("生成记录不存在")

    return GenerationDetailResponse(
        id=generation.id,
        type=generation.type,
        sub_type=generation.sub_type,
        input_params=generation.input_params,
        content=generation.result,
        result=generation.result if generation.type == "poster" else None,
        model_used=generation.model_used,
        tokens_used=generation.tokens_used,
        is_favorite=generation.is_favorite,
        effect_rating=generation.effect_rating,
        created_at=generation.created_at,
    )


@router.patch("/{generation_id}/favorite")
async def toggle_generation_favorite(
    generation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
):
    """切换生成记录的收藏状态"""
    generation = await get_generation_detail(
        db=db,
        store_id=current_store.id,
        generation_id=generation_id,
    )
    if generation is None:
        raise NotFoundException("生成记录不存在")

    new_status = not generation.is_favorite
    await db.execute(
        update(Generation)
        .where(Generation.id == generation_id)
        .values(is_favorite=new_status)
    )
    await db.commit()
    return {"is_favorite": new_status}


class UpdateContentRequest(BaseModel):
    content: str


@router.patch("/{generation_id}/content")
async def update_generation_content(
    generation_id: uuid.UUID,
    body: UpdateContentRequest,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_LIST)),
):
    """保存用户手动编辑后的内容：历史里存的就是实际发出去的版本。"""
    generation = await get_generation_detail(
        db=db,
        store_id=current_store.id,
        generation_id=generation_id,
    )
    if generation is None:
        raise NotFoundException("生成记录不存在")
    if generation.type == "poster":
        raise NotFoundException("海报记录不支持编辑内容")

    content = body.content.strip()
    if not content:
        raise NotFoundException("内容不能为空")

    generation.result = content[:20000]
    await db.commit()
    return {"status": "ok"}


@router.delete("/{generation_id}")
async def delete_generation(
    generation_id: uuid.UUID,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_DELETE)),
):
    """软删除生成记录。"""
    generation = await get_generation_detail(
        db=db,
        store_id=current_store.id,
        generation_id=generation_id,
    )
    if generation is None:
        raise NotFoundException("生成记录不存在")

    generation.is_deleted = True
    await db.commit()
    return {"status": "ok"}


@router.delete("/conversations/{conversation_id}")
async def delete_conversation(
    conversation_id: str,
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.GENERATION_DELETE)),
):
    """软删除整个对话的所有记录。"""
    await db.execute(
        update(Generation)
        .where(
            Generation.conversation_id == uuid.UUID(conversation_id),
            Generation.store_id == current_store.id,
        )
        .values(is_deleted=True)
    )
    await db.commit()
    return {"status": "ok"}
