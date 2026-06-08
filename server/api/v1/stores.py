from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_db, get_current_user, get_current_store
from core.rbac import Permission, require_permission
from models.user import User
from models.store import Store, StoreMember
from schemas.store import (
    StoreCreate,
    StoreUpdate,
    StoreResponse,
    StoreListItem,
    UploadResponse,
)
from services.store_service import (
    create_store,
    update_store,
    calculate_completeness,
)
from services.store_profile_service import calculate_operation_profile_completeness
from services.storage_service import upload_logo, upload_qrcode, commit_upload, rollback_upload

router = APIRouter(tags=["门店"])


def _store_to_response(store: Store) -> StoreResponse:
    data = {k: v for k, v in store.__dict__.items() if not k.startswith("_")}
    return StoreResponse(
        **data,
        operation_profile_completeness=calculate_operation_profile_completeness(store.operation_profile),
        completeness=calculate_completeness(store),
    )


@router.get("/list", response_model=list[StoreListItem])
async def list_my_stores(
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    """返回当前用户关联的所有门店列表（id + name）"""
    result = await db.execute(
        select(Store.id, Store.name)
        .join(StoreMember, StoreMember.store_id == Store.id)
        .where(StoreMember.user_id == current_user.id)
    )
    rows = result.all()
    return [StoreListItem(id=row.id, name=row.name) for row in rows]


@router.post("", response_model=StoreResponse, status_code=201)
async def create_my_store(
    body: StoreCreate,
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    store = await create_store(db, current_user.id, body.model_dump(exclude_unset=True))
    return _store_to_response(store)


@router.get("/me", response_model=StoreResponse)
async def get_my_store(
    store: Annotated[Store, Depends(get_current_store)],
):
    return _store_to_response(store)


@router.put("/me", response_model=StoreResponse)
async def update_my_store(
    body: StoreUpdate,
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    store = await update_store(db, store, body.model_dump(exclude_unset=True))
    return _store_to_response(store)


@router.post("/me/logo", response_model=UploadResponse)
async def upload_store_logo(
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    url, temp_path, final_path = await upload_logo(store.id, file)
    try:
        store.logo_url = url
        await db.commit()
    except Exception:
        await db.rollback()
        rollback_upload(temp_path)
        raise
    commit_upload(temp_path, final_path)
    return UploadResponse(url=url)


@router.post("/me/qrcode", response_model=UploadResponse)
async def upload_store_qrcode(
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    store: Annotated[Store, Depends(get_current_store)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    url, temp_path, final_path = await upload_qrcode(store.id, file)
    try:
        store.qrcode_url = url
        await db.commit()
    except Exception:
        await db.rollback()
        rollback_upload(temp_path)
        raise
    commit_upload(temp_path, final_path)
    return UploadResponse(url=url)
