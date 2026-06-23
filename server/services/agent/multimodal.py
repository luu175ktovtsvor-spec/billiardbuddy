"""Agent 壳子的【多模态 I/O】通用能力（模型无关）。

核心认知：能不能「看图/看视频」是【模型】自己的本事（Opus 4.8 / GLM-4V / Qwen-VL / Kimi-VL / 豆包… 自带）。
壳子只负责把图/视频按 OpenAI 兼容的 `content` 数组（{type:image_url|video_url, ...:{url}}）塞进 messages——
模型若是多模态就能看，纯文字模型就忽略（撞错由 vision_degrade 反应式去媒重试）。壳子不该有「识图模型」这种概念。

为控 token：图片用 Pillow 把长边缩到 <=1568（Anthropic/OpenAI 推荐），再 base64 成 data URL。
视频【整段原生送】（借 Kimi Code 的做法：当 video_url 直接给模型，服务端自己抽帧——壳子不抽帧、不转码）；
为防单请求过大，超过 _MAX_VIDEO_SRC_BYTES 的视频直接跳过（真要支持大视频需走 provider 文件上传，后续按需加）。
图片回灌时附【原始像素尺寸】标签（壳子缩过图，模型看的不是原分辨率）——让它指认坐标/点击时能按原图换算。
"""
import base64
import io
from pathlib import Path

_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".heic", ".tiff", ".tif"}
_MAX_DIM = 1568          # 长边上限（缩图控 token）
_MAX_OUT_BYTES = 4 * 1024 * 1024   # 缩完编码后上限（防单条请求过大）
_MAX_SRC_BYTES = 40 * 1024 * 1024  # 原图>40M 直接跳过（防读爆内存）

# 视频：原生送（不抽帧/不转码），仅做大小护栏。base64 内联 <=20M（约够一段短录屏/演示片）。
_VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv", ".avi", ".m4v"}
_VIDEO_MIME = {
    ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".m4v": "video/x-m4v",
}
_MAX_VIDEO_SRC_BYTES = 20 * 1024 * 1024  # 视频原文件 >20M 直接跳过（内联 base64 会撑爆请求）


def is_image(path) -> bool:
    return Path(str(path)).suffix.lower() in _IMAGE_EXTS


# provider 上传视频后返回的文件引用 scheme（resolve_media_for_upload 产出，直接当 video_url）：
# ms://（Moonshot/Kimi）、stepfile://（阶跃星辰 StepFun）。⚠️ 需与 deepseek._VIDEO_UPLOAD_PROVIDERS 的前缀同步。
_VIDEO_REF_SCHEMES = ("ms://", "stepfile://")


def _is_url_ref(s) -> bool:
    """已是 URL / 文件引用（无需读盘、直接塞进 video_url/image_url）：provider 文件引用（ms:// / stepfile://）/ http(s) / data:。"""
    return str(s).startswith(_VIDEO_REF_SCHEMES + ("http://", "https://", "data:"))


def is_video(path) -> bool:
    s = str(path)
    if s.startswith(_VIDEO_REF_SCHEMES):  # 已上传到 provider 的视频文件引用（resolve_media_for_upload 产出）
        return True
    return Path(s).suffix.lower() in _VIDEO_EXTS


def is_media(path) -> bool:
    """图片或视频——壳子能塞进多模态 content 的本地媒体。"""
    return is_image(path) or is_video(path)


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


def _image_original_size(path) -> tuple[int, int] | None:
    """读图片【原始像素尺寸】(w,h)，只读 header 不解码全图。失败返回 None。"""
    try:
        from PIL import Image
        with Image.open(Path(str(path))) as im:
            return int(im.size[0]), int(im.size[1])
    except Exception:
        return None


def image_content_items(path) -> list[dict]:
    """单张图 → [来源/原始尺寸标签(text), image_url]。失败返回 []（安全降级）。

    标签给模型【原始像素尺寸】——壳子已把图等比缩到 <=1568、模型看的不是原分辨率；
    指认坐标/点击（computer use）时模型据此按原图尺寸换算（借 Kimi Code read-media 的坐标接地）。"""
    item = image_content_item(path)
    if not item:
        return []
    size = _image_original_size(path)
    if size:
        tag = f'<image path="{path}" original_size="{size[0]}x{size[1]}" />'
    else:
        tag = f'<image path="{path}" />'
    return [{"type": "text", "text": tag}, item]


def video_to_data_url(path) -> str | None:
    """视频 → base64 data URL（原生整段，不抽帧/不转码）。>上限或失败返回 None（安全降级，绝不抛）。"""
    p = Path(str(path))
    try:
        if not p.is_file():
            return None
        size = p.stat().st_size
        if size <= 0 or size > _MAX_VIDEO_SRC_BYTES:
            return None
        mime = _VIDEO_MIME.get(p.suffix.lower(), "video/mp4")
        return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode()}"
    except Exception:
        return None


def video_content_item(path) -> dict | None:
    """单段视频 → OpenAI 兼容的 video_url content 项；失败/过大返回 None。

    path 已是 URL/文件引用（ms:// / http(s) / data:，多为 provider 上传后产出）→ 直接包，不读盘；
    否则按本地文件 base64 内联（>内联上限 _MAX_VIDEO_SRC_BYTES 返回 None，应先经 resolve_media_for_upload 上传）。"""
    s = str(path)
    if _is_url_ref(s):
        return {"type": "video_url", "video_url": {"url": s}}
    url = video_to_data_url(path)
    return {"type": "video_url", "video_url": {"url": url}} if url else None


def _local_video_too_big(path) -> bool:
    """本地视频文件、且超过内联上限（需走 provider 上传换文件引用）。URL 引用/不存在/小文件 → False。"""
    if _is_url_ref(path):
        return False
    p = Path(str(path))
    try:
        return p.is_file() and p.stat().st_size > _MAX_VIDEO_SRC_BYTES
    except Exception:
        return False


def _video_too_big_note(path) -> str:
    """超大本地视频、当前模型/端点又不支持上传时，给模型的一句话——别静默丢视频，让它转告老板。"""
    p = Path(str(path))
    try:
        size_s = f"约 {p.stat().st_size / (1024 * 1024):.0f}MB"
    except Exception:
        size_s = "过大"
    return (f"[视频「{p.name}」{size_s}，超出可直接内联的大小，且当前模型/端点不支持视频文件上传，已无法读取该视频。"
            f"请：① 压到 20MB 内；② 换支持大视频上传的模型（Kimi / 阶跃星辰 StepFun）；③ 或提供该视频的公网 URL。]")


def needs_video_upload(paths) -> bool:
    """media 列表里是否有【超内联上限的本地视频】——有才值得去解析 provider、走上传（否则白拿 provider）。"""
    return any(is_video(p) and _local_video_too_big(p) for p in (paths or []))


async def resolve_media_for_upload(paths, uploader):
    """把【超过内联上限的本地视频】预上传成 provider 文件引用（ms://…），替换进路径列表；其余原样返回。

    uploader: async (local_path:str) -> ref_url|None。无 uploader / 上传失败 / 返回 None → 保留原路径
    （>上限的本地视频随后会在 build_user_content 阶段被安全跳过、走纯文字降级）。故障安全：绝不抛。
    小视频（<=上限）不上传、仍走 base64 内联（省一次上传往返）。"""
    if not paths:
        return paths
    out: list[str] = []
    for p in (paths or []):
        if uploader is not None and is_video(p) and _local_video_too_big(p):
            ref = None
            try:
                ref = await uploader(p)
            except Exception:
                ref = None
            out.append(ref or p)
        else:
            out.append(p)
    return out


def build_user_content(text: str, media_paths: list[str] | None):
    """组装 user 消息 content：有图/视频 → 数组（text + 各媒体项）；无媒体 → 原字符串（行为零变化）。

    media_paths：本地图片或视频路径。图片走 image_url（附原始尺寸标签），视频走 video_url（原生整段）。
    非图非视频/编码失败的路径静默跳过（不抛、不留空项）。"""
    items: list[dict] = []
    for p in (media_paths or []):
        if not p:
            continue
        if is_image(p):
            items.extend(image_content_items(p))
        elif is_video(p):
            v = video_content_item(p)
            if v:
                items.append({"type": "text", "text": f'<video path="{p}" />'})
                items.append(v)
            elif _local_video_too_big(p):
                # 超内联上限、又没能上传(当前模型/端点不支持视频文件上传) → 别静默丢，给模型一句说明转告老板
                items.append({"type": "text", "text": _video_too_big_note(p)})
    if not items:
        return text
    content: list[dict] = []
    if text:
        content.append({"type": "text", "text": text})
    content.extend(items)
    return content
