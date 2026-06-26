"""OpenAI ImageProvider -- gpt-image-2"""

import asyncio
import base64
import io
import logging

from config import settings
from services.ai.base import ImageProvider

logger = logging.getLogger(__name__)

# 429 限流退避重试次数（并发治理）：多用户共用一把内置 key 走同一中转，瞬时并发超 IPM 会 429。
# 429 = 服务端"还没干活就挡回来了、没扣费" → 重试安全（与超时不同：超时可能图已生成会重复扣费，故那条绝不重试）。
_IMG_429_RETRIES = int(__import__("os").environ.get("DESKTOP_IMAGE_429_RETRIES", "") or 3)


async def _image_call_with_429_retry(coro_factory, max_retries: int = _IMG_429_RETRIES):
    """对 429 做指数退避重试（优先 Retry-After），其它异常立刻抛、绝不重试（防超时重复扣费）。
    coro_factory：无参可调用，每次都【新建】一个请求 coroutine（重试要重置上传流，故由调用方重建）。"""
    try:
        from openai import RateLimitError
    except Exception:  # SDK 结构异常时退化为不重试，至少不崩
        return await coro_factory()
    delay = 2.0
    for attempt in range(max_retries + 1):
        try:
            return await coro_factory()
        except RateLimitError as e:
            if attempt >= max_retries:
                raise
            ra = None
            try:
                ra = float((getattr(e, "response", None).headers or {}).get("retry-after", "") or 0)
            except Exception:
                ra = None
            wait = ra if (ra and ra > 0) else min(delay, 30.0)
            logger.info("生图 429 限流，第 %d/%d 次退避 %.1fs 后重试", attempt + 1, max_retries, wait)
            await asyncio.sleep(wait)
            delay *= 2

OPENAI_IMAGE_MODELS: dict[str, dict[str, str]] = {
    "gpt-image-2": {
        "name": "GPT Image 2",
        "desc": "最新一代，写实人像和创意设计都很强",
        "price": "$0.006-0.211/张",
        "best_for": "海报、配图、创意设计",
    },
}

# gpt-image-1 只接受这三种尺寸。poster_service 按比例算出的 2048x1152(16:9)、1152x1536(3:4) 等会被 400 拒。
_GPT_IMAGE1_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}
# GPT Image-2 约束宽很多（官方）：宽高均 16 整除、比例 1:3~3:1、总像素 655360~8294400、最大边 3840（D.4-附）。
_GPT2_MIN_PIXELS = 655360
_GPT2_MAX_PIXELS = 8294400
_GPT2_MAX_EDGE = 3840


def _snap16(v: int) -> int:
    """吸附到最接近的 16 倍数，至少 16。"""
    return max(16, ((v + 8) // 16) * 16)


def _snap_gpt_image2_size(size: str) -> str:
    """GPT Image-2 尺寸吸附：尽量保住请求比例（不再一律压成 1024 三档），只把它钳进官方约束
    （比例 1:3~3:1、总像素区间、最大边 3840、宽高 16 整除）。非法回退 1024x1024。"""
    if size == "auto":
        return "auto"
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except Exception:
        return "1024x1024"
    if w <= 0 or h <= 0:
        return "1024x1024"
    import math
    r = w / h                                   # 比例钳到 [1/3, 3]
    if r > 3.0:
        w = int(h * 3)
    elif r < 1 / 3:
        h = int(w * 3)
    px = w * h                                  # 总像素等比缩放进 [min, max]
    if px > _GPT2_MAX_PIXELS:
        s = math.sqrt(_GPT2_MAX_PIXELS / px); w, h = int(w * s), int(h * s)
    elif px < _GPT2_MIN_PIXELS:
        s = math.sqrt(_GPT2_MIN_PIXELS / px); w, h = int(w * s), int(h * s)
    if w > _GPT2_MAX_EDGE:                       # 最大边 3840
        h = int(h * _GPT2_MAX_EDGE / w); w = _GPT2_MAX_EDGE
    if h > _GPT2_MAX_EDGE:
        w = int(w * _GPT2_MAX_EDGE / h); h = _GPT2_MAX_EDGE
    return f"{_snap16(w)}x{_snap16(h)}"


def _snap_gpt_image1_size(size: str) -> str:
    """gpt-image-1：只有方/横/竖三档，把任意尺寸吸附过去。"""
    if size in _GPT_IMAGE1_SIZES:
        return size
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except Exception:
        return "1024x1024"
    if w == h:
        return "1024x1024"
    return "1536x1024" if w > h else "1024x1536"


def _snap_gpt_image_size(size: str, model: str = "gpt-image-2") -> str:
    """按模型吸附尺寸：gpt-image-1 走三档；gpt-image-2（及未指定）走宽约束、尽量保比例。"""
    return _snap_gpt_image1_size(size) if (model or "").startswith("gpt-image-1") else _snap_gpt_image2_size(size)


class OpenAIImageProvider(ImageProvider):
    name = "openai"
    supported_models = list(OPENAI_IMAGE_MODELS.keys())

    def __init__(self, api_key: str, base_url: str = "https://api.openai.com/v1"):
        self._api_key = api_key
        self._base_url = base_url
        self._client = None

    def _get_client(self):
        if self._client is None:
            import httpx
            from openai import AsyncOpenAI
            from services.ai.providers._net import bypass_proxy_for
            _timeout = httpx.Timeout(settings.openai_image_timeout, connect=30.0)
            http_client = None
            if bypass_proxy_for(self._base_url):
                http_client = httpx.AsyncClient(trust_env=False, timeout=_timeout)
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
                timeout=_timeout,
                max_retries=0,
                http_client=http_client,
            )
        return self._client

    async def generate_image(
        self,
        prompt: str,
        model: str = "gpt-image-2",
        size: str = "1024*1024",
        quality: str = "medium",
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        """调用 OpenAI 兼容的生图 API 生成图片。支持多图输入（最多16张）。

        - **model 用传入值**：BYOK 门店配了国内模型（如硅基流动的 `Kwai-Kolors/Kolors`，走 OpenAI 兼容端点）
          时即用其模型名，不再写死 gpt-image-2（平台/未配 → 仍默认 gpt-image-2）。
        - **quality 是 gpt-image 系列专有参数**：国内 OpenAI 兼容端点多不接受，故仅 gpt-image 系列才附加。
        - 响应兼容两种：gpt-image 回 b64_json；国内端点（硅基流动等）多回图片 url——见 `_extract_image_bytes`。
        """
        client = self._get_client()
        openai_size = size.replace("*", "x")
        use_model = model or "gpt-image-2"
        if use_model.startswith("gpt-image"):
            openai_size = _snap_gpt_image_size(openai_size, use_model)  # 按模型吸附（gpt-image-2 更宽、保比例）
        extra = {"quality": quality} if use_model.startswith("gpt-image") else {}

        if image:
            images = [image] if isinstance(image, bytes) else image

            # 用 BytesIO 包装，必须设置 .name 属性
            def _make_file(img_bytes: bytes, idx: int = 0):
                if img_bytes[:2] == b'\xff\xd8':
                    ext = "jpg"
                elif img_bytes[:4] == b'\x89PNG':
                    ext = "png"
                elif img_bytes[:4] == b'RIFF':
                    ext = "webp"
                else:
                    ext = "png"
                f = io.BytesIO(img_bytes)
                f.name = f"image_{idx}.{ext}"
                return f

            # OpenAI images.edit 支持单张或多张图片。每次（含 429 重试）都重建上传流——BytesIO 读过一次会到 EOF。
            def _build_edit():
                image_file = (_make_file(images[0], 0) if len(images) == 1
                              else [_make_file(img, i) for i, img in enumerate(images[:16])])
                return client.images.edit(
                    model=use_model, prompt=prompt, image=image_file, size=openai_size, **extra,
                )

            response = await _image_call_with_429_retry(_build_edit)
        else:
            response = await _image_call_with_429_retry(
                lambda: client.images.generate(
                    model=use_model, prompt=prompt, n=1, size=openai_size, **extra,
                )
            )

        return await self._extract_image_bytes(response)

    async def _extract_image_bytes(self, response) -> bytes:
        """兼容两种生图响应取回图片字节：
        - gpt-image 系列回 base64（`b64_json`）；
        - 国内 OpenAI 兼容端点（硅基流动等）多回图片 `url`（有效期约 1 小时）——这里即时下载成 bytes。"""
        data0 = response.data[0]
        b64 = getattr(data0, "b64_json", None)
        if b64:
            return base64.b64decode(b64)
        url = getattr(data0, "url", None)
        if url:
            import httpx
            from services.ai.providers._net import bypass_proxy_for
            _t = httpx.Timeout(settings.openai_image_timeout, connect=30.0)
            async with httpx.AsyncClient(timeout=_t, trust_env=not bypass_proxy_for(self._base_url)) as hc:
                r = await hc.get(url)
                r.raise_for_status()
                return r.content
        raise RuntimeError("生图响应里既无 b64_json 也无 url，无法取回图片")
