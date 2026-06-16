import io
import os
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import AppException
from core.rbac import Permission, require_permission
from models.store import Store
from models.user import User
from schemas.poster import (
    ImageGenerateRequest,
    ImageGenerateResponse,
    PromptExpandRequest,
    PromptExpandResponse,
)
from services import poster_service, poster_prompt_engine
from core.security_guard import check_input_injection
from config import settings

router = APIRouter()

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_REFERENCE_SIZE = 5 * 1024 * 1024  # 5MB

# 每个用户同一时刻只允许一张生图在跑（防并发刷量 + 护住 OpenAI 每分钟出图限额）。
# 注：进程内集合，单 worker 有效；将来多 worker 部署需换共享存储（DB/Redis）。
_GENERATING_USERS: set[str] = set()


class ReferenceTooLargeError(AppException):
    def __init__(self):
        super().__init__("参考图大小不能超过 5MB", status_code=413)


class InvalidReferenceTypeError(AppException):
    def __init__(self):
        super().__init__("只允许上传 jpg、jpeg、png、webp 格式的图片", status_code=415)


@router.post("/generate", response_model=ImageGenerateResponse)
async def generate_image(
    request: ImageGenerateRequest,
    current_user: User = Depends(get_current_user),
    current_store: Store = Depends(get_current_store),
    db: AsyncSession = Depends(get_db),
    _perm: None = Depends(require_permission(Permission.POSTER_CREATE)),
):
    """AI 生图：每个用户同一时刻只能出 1 张、且一次只出 1 张（禁批量，护住 OpenAI 限额）。"""
    uid = str(current_user.id)
    if uid in _GENERATING_USERS:
        raise AppException("你上一张图还在生成中，等它出完再发下一张哦～", status_code=429)
    _GENERATING_USERS.add(uid)
    try:
        ref_paths = request.images or request.reference_image_paths
        result = await poster_service.generate_images(
            db=db,
            store=current_store,
            user_id=current_user.id,
            prompt=request.prompt,
            image_model=request.image_model,
            ratio=request.ratio,
            reference_image_paths=ref_paths,
            count=1,  # 一次只出 1 张：禁用批量生成，护住 OpenAI 每分钟出图限额
            refine_from=request.refine_from,
            add_store_info=request.add_store_info,
            no_text=request.no_text,
            conversation_id=request.conversation_id,
            quality=request.quality,
            image_prompt=request.image_prompt,
            poster_text=request.poster_text,
            background_mode=request.background_mode,
            store_photo_path=request.store_photo_path,
            logo_path=request.logo_path,
            qr_path=request.qr_path,
        )
        return ImageGenerateResponse(**result)
    finally:
        _GENERATING_USERS.discard(uid)


def _store_context(store: Store) -> str:
    """给扩写引擎的门店背景（简短）。

    刻意只给店名+城市：海报是创意内容，GPT Image v2 能直接读懂上传门店照的风格，
    多塞"门店特色/调性"反而给强模型上枷锁、限制发挥（2026-06-16 用户裁定）。
    """
    bits = []
    if store.name:
        bits.append(f"门店名：{store.name}")
    if getattr(store, "city", None):
        bits.append(f"城市：{store.city}")
    return "；".join(bits)


@router.post("/expand", response_model=PromptExpandResponse)
async def expand_prompt(
    request: PromptExpandRequest,
    current_user: User = Depends(get_current_user),
    current_store: Store = Depends(get_current_store),
    _perm: None = Depends(require_permission(Permission.POSTER_CREATE)),
):
    """把大白话描述扩写成结构化生图提示词（内部步骤，不计配额）。"""
    injection = check_input_injection(request.description)
    if injection:
        raise AppException(injection, status_code=400)
    result = await poster_prompt_engine.expand_poster_prompt(
        description=request.description,
        poster_text=request.poster_text,
        background_mode=request.background_mode,
        has_logo=request.has_logo,
        has_qr=request.has_qr,
        ratio=request.ratio,
        store_context=_store_context(current_store),
    )
    return PromptExpandResponse(**result)


@router.post("/reference")
async def upload_reference(
    file: Annotated[UploadFile, File(...)],
    current_user: Annotated[User, Depends(get_current_user)],
    current_store: Annotated[Store, Depends(get_current_store)],
):
    """上传参考图，返回路径供 generate 时引用。"""
    content = await file.read()

    if len(content) > MAX_REFERENCE_SIZE:
        raise ReferenceTooLargeError()

    original_filename = file.filename or "unknown.jpg"
    ext = os.path.splitext(original_filename)[1].lower()
    if ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise InvalidReferenceTypeError()

    try:
        from PIL import Image
        img = Image.open(io.BytesIO(content))
        img.verify()
    except Exception:
        raise InvalidReferenceTypeError()

    safe_filename = f"ref_{current_store.id}_{uuid.uuid4().hex}{ext}"
    upload_dir = os.path.join(settings.upload_dir, "references")
    os.makedirs(upload_dir, exist_ok=True)

    file_path = os.path.join(upload_dir, safe_filename)
    with open(file_path, "wb") as f:
        f.write(content)

    rel_path = f"/uploads/references/{safe_filename}"
    return {"path": rel_path, "url": rel_path}


@router.get("/conversations")
async def list_conversations(
    current_user: User = Depends(get_current_user),
    current_store: Store = Depends(get_current_store),
    db: AsyncSession = Depends(get_db),
    _perm: None = Depends(require_permission(Permission.POSTER_LIST)),
):
    """获取海报对话列表。"""
    conversations = await poster_service.get_conversations(db, current_store.id)
    return {"conversations": conversations}


@router.get("/conversations/{conversation_id}")
async def get_conversation(
    conversation_id: str,
    current_user: User = Depends(get_current_user),
    current_store: Store = Depends(get_current_store),
    db: AsyncSession = Depends(get_db),
    _perm: None = Depends(require_permission(Permission.POSTER_LIST)),
):
    """获取对话详情。"""
    detail = await poster_service.get_conversation_detail(db, current_store.id, conversation_id)
    if not detail:
        return JSONResponse({"error": "对话不存在"}, status_code=404)
    return detail


@router.get("/image-models")
async def list_image_models(_user: User = Depends(get_current_user)):
    """返回可用的 AI 生图模型列表。"""
    return {"models": [{"id": "gpt-image-2", "name": "GPT Image 2"}]}


@router.get("/size-options")
async def list_size_options(_user: User = Depends(get_current_user)):
    """返回可选的图片比例列表。"""
    return {"sizes": poster_service.get_size_options()}


