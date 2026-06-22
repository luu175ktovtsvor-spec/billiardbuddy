"""OpenAI ImageProvider -- gpt-image-2"""

import base64
import io
import logging

from config import settings
from services.ai.base import ImageProvider

logger = logging.getLogger(__name__)

OPENAI_IMAGE_MODELS: dict[str, dict[str, str]] = {
    "gpt-image-2": {
        "name": "GPT Image 2",
        "desc": "最新一代，写实人像和创意设计都很强",
        "price": "$0.006-0.211/张",
        "best_for": "海报、配图、创意设计",
    },
}

# gpt-image 系列（gpt-image-1/2）只接受这几种尺寸。poster_service 按比例算出的 2048x1152(16:9)、
# 1152x1536(3:4) 等会被 OpenAI 400 拒（Invalid size）→ 整条生图链失败。按宽高比吸附到最接近的受支持尺寸。
_GPT_IMAGE_SIZES = {"1024x1024", "1024x1536", "1536x1024", "auto"}


def _snap_gpt_image_size(size: str) -> str:
    """把任意尺寸吸附到 gpt-image 支持的尺寸：方→1024x1024，横→1536x1024，竖→1024x1536。"""
    if size in _GPT_IMAGE_SIZES:
        return size
    try:
        w, h = (int(x) for x in size.lower().split("x"))
    except Exception:
        return "1024x1024"
    if w == h:
        return "1024x1024"
    return "1536x1024" if w > h else "1024x1536"


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
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=self._base_url,
                # 读超时必须覆盖真实生图耗时（gpt-image-2 单张可能 5-10 分钟）。设太短(如旧的300s)会把
                # "还在生成"误判为超时失败，但服务端其实已生成并扣费——钱花了图没拿到。详见 CLAUDE.md「AI 并发与限流」
                timeout=httpx.Timeout(settings.openai_image_timeout, connect=30.0),
                max_retries=0,  # 生图慢且贵：SDK 默认会在连接/超时失败时自动重试，但生图"已生成完才断"会被重复扣费——关掉自动重试防烧钱
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
            openai_size = _snap_gpt_image_size(openai_size)  # 防 16:9/3:4 等尺寸被 gpt-image 400 拒
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

            # OpenAI images.edit 支持单张或多张图片
            if len(images) == 1:
                image_file = _make_file(images[0], 0)
            else:
                image_file = [_make_file(img, i) for i, img in enumerate(images[:16])]

            response = await client.images.edit(
                model=use_model,
                prompt=prompt,
                image=image_file,
                size=openai_size,
                **extra,
            )
        else:
            response = await client.images.generate(
                model=use_model,
                prompt=prompt,
                n=1,
                size=openai_size,
                **extra,
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
            async with httpx.AsyncClient(timeout=httpx.Timeout(settings.openai_image_timeout, connect=30.0)) as hc:
                r = await hc.get(url)
                r.raise_for_status()
                return r.content
        raise RuntimeError("生图响应里既无 b64_json 也无 url，无法取回图片")
