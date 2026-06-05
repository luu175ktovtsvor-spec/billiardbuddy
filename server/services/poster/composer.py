import logging
from pathlib import Path

from PIL import Image

logger = logging.getLogger(__name__)


def _safe_load_image(file_path: Path, upload_dir: Path) -> Image.Image | None:
    """安全加载图片，解析路径确保在 uploads 目录内。"""
    try:
        resolved = file_path.resolve()
        if not str(resolved).startswith(str(upload_dir.resolve())):
            logger.warning("图片路径越界: %s", file_path)
            return None
        if not resolved.is_file():
            return None
        img = Image.open(resolved)
        img = img.convert("RGBA")
        return img
    except Exception:
        logger.warning("无法加载图片: %s", file_path, exc_info=True)
        return None


def _paste_image_element(
    base: Image.Image,
    img: Image.Image,
    x: int,
    y: int,
    max_width: int,
    max_height: int,
) -> None:
    img_copy = img.copy()
    img_copy.thumbnail((max_width, max_height), Image.LANCZOS)
    base.paste(img_copy, (x, y), img_copy)


def overlay_images(
    base_image: Image.Image,
    logo_path: str | None,
    qrcode_path: str | None,
    upload_dir: Path,
) -> Image.Image:
    """在 AI 生成的底图上叠加 Logo 和二维码。

    Parameters
    ----------
    base_image : Image.Image
        AI 生图模型生成的底图。
    logo_path : str | None
        门店 logo_url 数据库值。None 表示无 Logo。
    qrcode_path : str | None
        门店 qrcode_url 数据库值。None 表示无二维码。
    upload_dir : Path
        上传目录根路径，用于路径安全检查。

    Returns
    -------
    Image.Image
        叠加后的图片。
    """
    result = base_image.convert("RGBA")
    img_w, img_h = result.size

    # 根据实际图片尺寸计算位置和大小（比例适配）
    logo_margin = int(img_w * 0.05)
    logo_max = int(img_w * 0.12)
    logo_position = (logo_margin, logo_margin)
    logo_size = (logo_max, logo_max)

    qr_margin = int(img_w * 0.05)
    qr_max = int(img_w * 0.12)
    qrcode_position = (img_w - qr_max - qr_margin, img_h - qr_max - qr_margin)
    qrcode_size = (qr_max, qr_max)

    # 叠加 Logo
    if logo_path:
        cleaned = logo_path.lstrip("/")
        if cleaned.startswith("uploads/"):
            cleaned = cleaned[len("uploads/"):]
        logo_file = upload_dir / cleaned
        logo_img = _safe_load_image(logo_file, upload_dir)
        if logo_img:
            x, y = logo_position
            max_w, max_h = logo_size
            _paste_image_element(result, logo_img, x, y, max_w, max_h)

    # 叠加二维码
    if qrcode_path:
        cleaned = qrcode_path.lstrip("/")
        if cleaned.startswith("uploads/"):
            cleaned = cleaned[len("uploads/"):]
        qr_file = upload_dir / cleaned
        qr_img = _safe_load_image(qr_file, upload_dir)
        if qr_img:
            x, y = qrcode_position
            max_w, max_h = qrcode_size
            _paste_image_element(result, qr_img, x, y, max_w, max_h)

    return result