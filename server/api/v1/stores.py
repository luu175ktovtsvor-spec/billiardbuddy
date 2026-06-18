from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from pydantic import BaseModel
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


def _store_to_response(store: Store, my_role: str | None = None) -> StoreResponse:
    # 显式排除 BYOK 字段：敏感配置只走专用 GET /me/byok（脱敏），绝不混进通用门店响应
    data = {k: v for k, v in store.__dict__.items() if not k.startswith("_") and not k.startswith("byok_")}
    return StoreResponse(
        **data,
        operation_profile_completeness=calculate_operation_profile_completeness(store.operation_profile),
        completeness=calculate_completeness(store),
        my_role=my_role,
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
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
):
    # 带上当前用户在本店的角色:前端工作台默认选中用户自己的岗位 tab
    result = await db.execute(
        select(StoreMember.role).where(
            StoreMember.store_id == store.id,
            StoreMember.user_id == current_user.id,
        )
    )
    my_role = result.scalar_one_or_none()
    return _store_to_response(store, my_role=my_role)


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


# ── BYOK：门店自带大模型 Key（自担 API 成本与并发，解决共用平台单 key 的并发瓶颈）──────
class BYOKConfigIn(BaseModel):
    enabled: bool = False
    base_url: str | None = None
    api_key: str | None = None   # 明文，仅写入/验证时传；加密后存，GET 绝不回显
    model: str | None = None


class BYOKConfigOut(BaseModel):
    enabled: bool
    base_url: str | None = None
    model: str | None = None
    key_configured: bool = False
    key_mask: str = ""


def _ensure_store_owner(store: Store, user: User) -> None:
    """BYOK Key 敏感（影响计费），仅门店所有者或平台管理员可管理。"""
    if not (getattr(user, "is_admin", False) or str(store.owner_id) == str(user.id)):
        raise HTTPException(status_code=403, detail="仅门店所有者可管理 AI Key")


def _byok_out(store: Store) -> BYOKConfigOut:
    from core.crypto import mask, try_decrypt
    plain = try_decrypt(store.byok_api_key_enc) if store.byok_api_key_enc else None
    return BYOKConfigOut(
        enabled=bool(store.byok_enabled), base_url=store.byok_base_url, model=store.byok_model,
        key_configured=bool(plain), key_mask=mask(plain) if plain else "",
    )


@router.get("/me/byok", response_model=BYOKConfigOut)
async def get_byok_config(
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    """读门店 BYOK 配置（不回显明文 Key，只给是否已配 + 脱敏展示）。"""
    _ensure_store_owner(store, current_user)
    return _byok_out(store)


@router.put("/me/byok", response_model=BYOKConfigOut)
async def update_byok_config(
    body: BYOKConfigIn,
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """写门店 BYOK 配置。api_key 加密存；不传 api_key 保留原 key，传空串显式清除。"""
    from core.crypto import encrypt, CryptoNotConfigured
    _ensure_store_owner(store, current_user)
    store.byok_enabled = bool(body.enabled)
    if body.base_url is not None:
        store.byok_base_url = body.base_url.strip() or None
    if body.model is not None:
        store.byok_model = body.model.strip() or None
    if body.api_key is not None:
        if body.api_key.strip():
            try:
                store.byok_api_key_enc = encrypt(body.api_key.strip())
            except CryptoNotConfigured:
                raise HTTPException(status_code=503, detail="服务端未配置 BYOK 主密钥（BYOK_ENCRYPT_KEY），请联系管理员配置后再试")
        else:
            store.byok_api_key_enc = None
    await db.commit()
    await db.refresh(store)
    return _byok_out(store)


@router.post("/me/byok/validate")
async def validate_byok_config(
    body: BYOKConfigIn,
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    """用传入配置（或已存配置）发一个最小测试请求，验证 Key/base_url/model 是否可用。"""
    from core.crypto import decrypt, CryptoNotConfigured
    from core.exceptions import AIProviderError
    from services.ai.providers.deepseek import DeepSeekProvider
    from services.ai.base import TextRequest
    _ensure_store_owner(store, current_user)
    key = (body.api_key or "").strip()
    if not key and store.byok_api_key_enc:
        try:
            key = decrypt(store.byok_api_key_enc)
        except CryptoNotConfigured:
            return {"ok": False, "error": "服务端未配置 BYOK 主密钥，请联系管理员"}
        except Exception:
            return {"ok": False, "error": "已存的 Key 无法解密，请重新填写"}
    if not key:
        return {"ok": False, "error": "未提供 API Key"}
    base = (body.base_url or store.byok_base_url or "").strip() or None
    model = (body.model or store.byok_model or "").strip() or None
    try:
        p = DeepSeekProvider(api_key=key, base_url=base, default_model=model, timeout=120)
        r = await p.generate(TextRequest(prompt="回复'连接正常'四个字", max_tokens=512))
        # reasoning 模型 content 可能被 max_tokens 截空——请求成功返回即视为连通
        return {"ok": True, "model": r.model, "sample": (r.content or "")[:40]}
    except AIProviderError as e:
        return {"ok": False, "error": e.message}  # 友好提示，不回传原始异常(防调试信息泄露)
    except Exception:
        return {"ok": False, "error": "连接测试失败，请检查 Key、base_url、模型名是否正确"}


# ── 多供应商配置档（CC Switch 式：存好几套、一键切换） ──
class BYOKProfileIn(BaseModel):
    name: str
    base_url: str | None = None
    api_key: str | None = None   # 明文，仅保存时传；加密后存本地配置档库
    model: str | None = None


@router.get("/me/byok/profiles")
async def list_byok_profiles(
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
):
    """列出本店存的所有大模型配置档（不含密文，标出当前激活的那套）。"""
    _ensure_store_owner(store, current_user)
    from services import byok_profiles
    return {"profiles": byok_profiles.list_profiles(str(store.id))}


@router.post("/me/byok/profiles")
async def save_byok_profile(
    body: BYOKProfileIn,
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """新增/更新一套配置档。传 api_key 则加密更新 key，不传则只改 base_url/model。"""
    _ensure_store_owner(store, current_user)
    if not body.name.strip():
        raise HTTPException(status_code=400, detail="请给这套配置起个名（如 DeepSeek、备用号）")
    from core.crypto import encrypt, CryptoNotConfigured
    from services import byok_profiles
    key_enc = None
    if body.api_key is not None and body.api_key.strip():
        try:
            key_enc = encrypt(body.api_key.strip())
        except CryptoNotConfigured:
            raise HTTPException(status_code=503, detail="服务端未配置 BYOK 主密钥（BYOK_ENCRYPT_KEY），请联系管理员配置后再试")
    byok_profiles.save_profile(
        str(store.id), body.name.strip(),
        (body.base_url or "").strip() or None, (body.model or "").strip() or None, key_enc,
    )
    return {"profiles": byok_profiles.list_profiles(str(store.id))}


@router.post("/me/byok/profiles/{name}/activate")
async def activate_byok_profile(
    name: str,
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
    db: Annotated[AsyncSession, Depends(get_db)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    """激活某套配置档：把它的值写进门店真正生效的 BYOK 配置（factory 照读 store.byok_*）。"""
    _ensure_store_owner(store, current_user)
    from services import byok_profiles
    prof = byok_profiles.get_profile(str(store.id), name)
    if not prof:
        raise HTTPException(status_code=404, detail="没有这套配置")
    if not prof["api_key_enc"]:
        raise HTTPException(status_code=400, detail="这套配置还没填 Key，没法激活")
    # 同一把 BYOK_ENCRYPT_KEY 加密 → 密文可直接拷进 store，无需重新加密
    store.byok_enabled = True
    store.byok_base_url = prof["base_url"]
    store.byok_model = prof["model"]
    store.byok_api_key_enc = prof["api_key_enc"]
    await db.commit()
    byok_profiles.set_active(str(store.id), name)
    return {"active": name, "profiles": byok_profiles.list_profiles(str(store.id))}


@router.delete("/me/byok/profiles/{name}")
async def delete_byok_profile(
    name: str,
    store: Annotated[Store, Depends(get_current_store)],
    current_user: Annotated[User, Depends(get_current_user)],
    _perm: None = Depends(require_permission(Permission.STORE_UPDATE)),
):
    _ensure_store_owner(store, current_user)
    from services import byok_profiles
    byok_profiles.delete_profile(str(store.id), name)
    return {"profiles": byok_profiles.list_profiles(str(store.id))}
