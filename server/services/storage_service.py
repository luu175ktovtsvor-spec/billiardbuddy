import uuid
from io import BytesIO
from pathlib import Path

from fastapi import UploadFile
from PIL import Image

from config import settings
from core.exceptions import AppException


ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
MAX_FILE_SIZE = 2 * 1024 * 1024  # 2MB


class FileTooLargeError(AppException):
    def __init__(self):
        super().__init__("文件大小不能超过 2MB", status_code=413)


class InvalidFileTypeError(AppException):
    def __init__(self):
        super().__init__("只允许上传 jpg、jpeg、png 格式的图片", status_code=415)


class InvalidImageContentError(AppException):
    def __init__(self):
        super().__init__("上传的文件不是有效的图片", status_code=415)


async def upload_logo(store_id: uuid.UUID, file: UploadFile) -> tuple[str, Path, str]:
    """上传 Logo，返回 (url, temp_path, final_filename)。

    文件先写入临时路径，调用方需在数据库提交成功后调用 commit_upload，
    或在失败时调用 rollback_upload。
    """
    return await _upload_file(file, store_id, "logos")


async def upload_qrcode(store_id: uuid.UUID, file: UploadFile) -> tuple[str, Path, str]:
    """上传二维码，返回 (url, temp_path, final_filename)。

    文件先写入临时路径，调用方需在数据库提交成功后调用 commit_upload，
    或在失败时调用 rollback_upload。
    """
    return await _upload_file(file, store_id, "qrcodes")


async def _upload_file(
    file: UploadFile, store_id: uuid.UUID, subdir: str
) -> tuple[str, Path, str]:
    """上传文件到临时路径。

    Returns
    -------
    tuple[str, Path, str]
        (url, temp_path, final_filename) — url 是最终访问路径，
        temp_path 是临时文件路径，final_filename 是最终文件名。
    """
    content = await file.read()

    if len(content) > MAX_FILE_SIZE:
        raise FileTooLargeError()

    ext = Path(file.filename or ".jpg").suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise InvalidFileTypeError()

    # 用 Pillow 验证文件确实是图片，同时去除 EXIF
    try:
        img = Image.open(BytesIO(content))
        img.verify()
    except Exception:
        raise InvalidImageContentError()

    # 重新打开（verify 后需重新打开才能操作）
    img = Image.open(BytesIO(content))

    # 统一转成 RGB（去除 alpha 通道便于 JPEG 输出）
    if img.mode in ("RGBA", "P", "LA"):
        img = img.convert("RGB")

    # 去除 EXIF 隐私信息
    img = _strip_exif(img)

    upload_dir = Path(settings.upload_dir) / subdir
    upload_dir.mkdir(parents=True, exist_ok=True)

    filename = f"{store_id}_{uuid.uuid4().hex}.jpg"
    final_path = upload_dir / filename
    temp_path = upload_dir / f"{filename}.tmp"

    img.save(temp_path, "JPEG", quality=85)

    url = f"/uploads/{subdir}/{filename}"
    return url, temp_path, str(final_path)


def commit_upload(temp_path: Path, final_path: str) -> None:
    """数据库提交成功后，将临时文件 rename 到最终路径。"""
    src = Path(temp_path)
    dst = Path(final_path)
    if src.exists():
        src.rename(dst)


def rollback_upload(temp_path: Path) -> None:
    """数据库提交失败时，删除临时文件。"""
    src = Path(temp_path)
    if src.exists():
        src.unlink(missing_ok=True)


def _strip_exif(img: Image.Image) -> Image.Image:
    """去除 EXIF 隐私信息，保留方向信息（旋转）。"""
    try:
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
    except Exception:
        pass

    # 移除 info 中的 exif 数据，避免 save 时写入
    img.info.pop("exif", None)
    # 清除 ICC profile 等可能含隐私的元数据
    for key in list(img.info.keys()):
        if key != "dpi":
            img.info.pop(key, None)
    return img