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
        """调用 OpenAI API 生成图片。支持多图输入（最多16张）。"""
        client = self._get_client()
        openai_size = size.replace("*", "x")

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
                model="gpt-image-2",
                prompt=prompt,
                image=image_file,
                size=openai_size,
                quality=quality,
            )
        else:
            response = await client.images.generate(
                model="gpt-image-2",
                prompt=prompt,
                n=1,
                size=openai_size,
                quality=quality,
            )

        image_b64 = response.data[0].b64_json
        return base64.b64decode(image_b64)
