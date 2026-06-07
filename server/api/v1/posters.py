import io
import os
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from sqlalchemy.ext.asyncio import AsyncSession

from api.deps import get_current_user, get_current_store, get_db
from core.exceptions import AppException
from models.store import Store
from models.user import User
from schemas.poster import ImageGenerateRequest, ImageGenerateResponse
from services import poster_service
from config import settings

router = APIRouter()

ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_REFERENCE_SIZE = 5 * 1024 * 1024  # 5MB


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
):
    """AI 生图：用户描述 → AI 生成 → 叠加 Logo/二维码 → 返回多张结果。"""
    # images 和 reference_image_paths 兼容合并
    ref_paths = request.images or request.reference_image_paths

    # 兼容：add_overlay=False 时两个都不叠加
    add_logo = request.add_logo_overlay if request.add_overlay else False
    add_qr = request.add_qrcode_overlay if request.add_overlay else False

    result = await poster_service.generate_images(
        db=db,
        store=current_store,
        user_id=current_user.id,
        prompt=request.prompt,
        image_model=request.image_model,
        ratio=request.ratio,
        reference_image_paths=ref_paths,
        count=request.count or 1,
        refine_from=request.refine_from,
        add_store_info=request.add_store_info,
        no_text=request.no_text,
        add_logo_overlay=add_logo,
        add_qrcode_overlay=add_qr,
    )
    return ImageGenerateResponse(**result)


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

    # Pillow 验证
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


@router.get("/image-models")
async def list_image_models(_user: User = Depends(get_current_user)):
    """返回可用的 AI 生图模型列表。"""
    from services.ai.providers.openai_image import OPENAI_IMAGE_MODELS

    models = []
    for model_id, info in OPENAI_IMAGE_MODELS.items():
        models.append({
            "id": model_id,
            "name": info["name"],
            "desc": info["desc"],
            "price": info["price"],
            "best_for": info.get("best_for", ""),
            "provider": "openai",
            "provider_name": "OpenAI",
        })
    return {"models": models}


@router.get("/inspiration-tags")
async def list_inspiration_tags(_user: User = Depends(get_current_user)):
    """返回场景灵感标签列表。"""
    return {"tags": poster_service.get_inspiration_tags()}


@router.get("/size-options")
async def list_size_options(_user: User = Depends(get_current_user)):
    """返回可选的图片比例列表。"""
    return {"sizes": poster_service.get_size_options()}