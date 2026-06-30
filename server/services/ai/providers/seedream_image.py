"""Seedream ImageProvider — 火山方舟·即梦 Seedream(doubao-seedream-*)。

⚠️ 与 OpenAIImageProvider 的关键区别(火山方舟官方文档核实 2026-06-30,scrapling 抓首方原文):
- 文生图与图生图【同一个端点】 POST {base_url}/images/generations(JSON body),**不是** OpenAI 的
  multipart /images/edits。所以 Seedream 不能复用 OpenAIImageProvider 的 images.edit 路径,单列本 provider。
- 图生图把参考图/底图放进 body 的 `image` 字段:单图=字符串,多图=数组;支持 base64 data-uri
  (官方原文:`data:image/<小写格式>;base64,<...>`)或 http url。本机字节 → data-uri 直接喂。
- 编辑/多图融合带 `sequential_image_generation:"disabled"`(否则可能当"组图"多输出)。
- Seedream **无 mask/局部重绘**能力 → mask 入参忽略(按整图编辑)。
- `size` 走 WxH(如 1024x1024,编码宽高比)或预设(1K/2K/4K);`watermark` 默认可能加水印 → 显式 False。
- 限流 500 IPM/模型版本/账号;返回 url 有效约 24h,取回即落盘。

⚠️ 本 provider 按官方文档写,但【未真机验证】——火山账号开通 Seedream 图像权限后须真跑一次校准
(尤其 size 的 WxH 取值范围、base64 大图是否被端点接受)。文生图链路结构与 OpenAIImageProvider 同构。
"""

import asyncio
import base64
import logging
import os

import httpx

from config import settings
from services.ai.base import ImageProvider

logger = logging.getLogger(__name__)

# 429 限流退避(同 openai_image 的治理):429=没干活就挡回、未扣费 → 重试安全;其它异常立刻抛,绝不重试(防超时重复扣费)。
_SEEDREAM_429_RETRIES = int(os.environ.get("DESKTOP_IMAGE_429_RETRIES", "") or 3)
_DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3"
_DEFAULT_MODEL = "doubao-seedream-4-5-251128"
# 火山方舟真机实测(2026-06-30):size 至少 3,686,400 像素(≈1920²),小于此报 InvalidParameter「image size must be
# at least 3686400 pixels」。gpt-image-2 那套小尺寸(如 1024x1024)直接喂过来会被拒 → 按比例放大到下限。
_SEEDREAM_MIN_PIXELS = 3_686_400


def _normalize_seedream_size(size: str) -> str:
    """把传入 WxH 放大到 Seedream 像素下限以上，保持宽高比，各边取 16 的倍数（ceil 保证不低于下限）。"""
    import math
    s = (size or "").lower().replace("*", "x")
    try:
        w, h = (int(x) for x in s.split("x")[:2])
    except (ValueError, TypeError):
        return "2048x2048"
    if w <= 0 or h <= 0:
        return "2048x2048"
    px = w * h
    if px < _SEEDREAM_MIN_PIXELS:
        scale = math.sqrt(_SEEDREAM_MIN_PIXELS / px)
        w = math.ceil(w * scale / 16) * 16
        h = math.ceil(h * scale / 16) * 16
    return f"{w}x{h}"


def _to_data_uri(img: bytes) -> str:
    """本机图片 bytes → Seedream 接受的 base64 data-uri(格式名小写,官方要求)。"""
    if img[:2] == b"\xff\xd8":
        fmt = "jpeg"
    elif img[:4] == b"\x89PNG":
        fmt = "png"
    elif img[:4] == b"RIFF":
        fmt = "webp"
    else:
        fmt = "png"
    return f"data:image/{fmt};base64,{base64.b64encode(img).decode()}"


class SeedreamImageProvider(ImageProvider):
    name = "seedream"
    supported_models = [
        "doubao-seedream-4-5-251128", "doubao-seedream-5-0-260128", "doubao-seedream-4-0-250828",
    ]

    def __init__(self, api_key: str, base_url: str = _DEFAULT_BASE):
        self._api_key = api_key
        self._base_url = (base_url or _DEFAULT_BASE).rstrip("/")

    async def generate_image(
        self,
        prompt: str,
        model: str = _DEFAULT_MODEL,
        size: str = "1024*1024",
        quality: str = "auto",          # Seedream 无 quality 参数,接受但忽略
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        body: dict = {
            "model": model or _DEFAULT_MODEL,
            "prompt": prompt,
            "size": _normalize_seedream_size(size),   # WxH 编码宽高比;放大到火山像素下限(≥3,686,400)
            "watermark": False,
            "response_format": "url",
        }
        if image:
            imgs = [image] if isinstance(image, bytes) else list(image)
            uris = [_to_data_uri(b) for b in imgs[:14]]   # 参考图+输出≤15,留余量
            body["image"] = uris[0] if len(uris) == 1 else uris
            body["sequential_image_generation"] = "disabled"   # 编辑/融合=单图输出,不走组图
            if kwargs.get("mask") is not None:
                logger.info("Seedream 不支持 mask 局部重绘,按整图编辑处理(mask 忽略)")
        return await self._post_with_429_retry(body)

    async def _post_with_429_retry(self, body: dict, max_retries: int = _SEEDREAM_429_RETRIES) -> bytes:
        from services.ai.providers._net import bypass_proxy_for
        url = f"{self._base_url}/images/generations"
        headers = {"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"}
        timeout = httpx.Timeout(settings.openai_image_timeout, connect=30.0)
        delay = 2.0
        for attempt in range(max_retries + 1):
            async with httpx.AsyncClient(timeout=timeout, trust_env=not bypass_proxy_for(url)) as hc:
                resp = await hc.post(url, json=body, headers=headers)
                if resp.status_code == 429 and attempt < max_retries:
                    ra = resp.headers.get("retry-after")
                    wait = float(ra) if (ra and ra.replace(".", "", 1).isdigit()) else min(delay, 30.0)
                    logger.info("Seedream 429 限流,第 %d/%d 次退避 %.1fs 后重试", attempt + 1, max_retries, wait)
                    await asyncio.sleep(wait)
                    delay *= 2
                    continue
                resp.raise_for_status()
                return await self._extract_bytes(resp.json(), timeout)
        raise RuntimeError("Seedream 429 重试用尽")   # 理论到不了(末次 429 已 raise_for_status),兜底防静默

    async def _extract_bytes(self, data: dict, timeout) -> bytes:
        """Seedream 响应取回图片字节:b64_json 直接解码;url 即时下载(有效约 24h,必须立刻落盘)。"""
        from services.ai.providers._net import bypass_proxy_for
        items = data.get("data") or []
        if not items:
            raise RuntimeError(f"Seedream 生图响应无 data:{str(data)[:200]}")
        first = items[0]
        b64 = first.get("b64_json")
        if b64:
            return base64.b64decode(b64)
        url = first.get("url")
        if url:
            async with httpx.AsyncClient(timeout=timeout, trust_env=not bypass_proxy_for(url)) as hc:
                r = await hc.get(url)
                r.raise_for_status()
                return r.content
        raise RuntimeError("Seedream 响应里既无 url 也无 b64_json,无法取回图片")
