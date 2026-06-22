"""Agent 壳子的【多模态 I/O】通用能力（模型无关）。

核心认知：能不能「看图」是【模型】自己的本事（Opus 4.8 / GLM-4V / Qwen-VL / 豆包… 自带识图）。
壳子只负责把图片按 OpenAI 兼容的 `content` 数组（{type:image_url, image_url:{url}}）塞进 messages——
模型若是多模态就能看，纯文字模型就忽略。壳子不该有「识图模型」这种概念，也不替模型操心。

为控 token：用 Pillow 把长边缩到 <=1568（Anthropic/OpenAI 推荐），再 base64 成 data URL。
"""
import base64
import io
from pathlib import Path

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".tiff", ".tif"}
_MAX_DIM = 1568          # 长边上限（缩图控 token）
_MAX_OUT_BYTES = 4 * 1024 * 1024   # 缩完编码后上限（防单条请求过大）
_MAX_SRC_BYTES = 40 * 1024 * 1024  # 原图>40M 直接跳过（防读爆内存）


def is_image(path) -> bool:
    return Path(str(path)).suffix.lower() in _IMAGE_EXTS


def image_to_data_url(path) -> str | None:
    """图片 → 缩到长边<=1568 → JPEG/PNG → base64 data URL。失败/过大返回 None（安全降级，绝不抛）。"""
    p = Path(str(path))
    try:
        if not p.is_file() or p.stat().st_size > _MAX_SRC_BYTES:
            return None
        from PIL import Image
        img = Image.open(p)
        img.load()
        has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
        if max(img.size) > _MAX_DIM:
            img.thumbnail((_MAX_DIM, _MAX_DIM))
        buf = io.BytesIO()
        if has_alpha:
            img.convert("RGBA").save(buf, format="PNG", optimize=True)
            mime = "image/png"
        else:
            img.convert("RGB").save(buf, format="JPEG", quality=85, optimize=True)
            mime = "image/jpeg"
        data = buf.getvalue()
        if len(data) > _MAX_OUT_BYTES:
            return None
        return f"data:{mime};base64,{base64.b64encode(data).decode()}"
    except Exception:
        return None


def image_content_item(path) -> dict | None:
    """单张图 → OpenAI 兼容的 image_url content 项；失败返回 None。"""
    url = image_to_data_url(path)
    return {"type": "image_url", "image_url": {"url": url}} if url else None


def build_user_content(text: str, image_paths: list[str] | None):
    """组装 user 消息 content：有图 → 数组（text + 各图 image_url）；无图 → 原字符串（行为零变化）。"""
    items: list[dict] = []
    for p in (image_paths or []):
        if p and is_image(p):
            it = image_content_item(p)
            if it:
                items.append(it)
    if not items:
        return text
    content: list[dict] = []
    if text:
        content.append({"type": "text", "text": text})
    content.extend(items)
    return content
