"""OpenAI ImageProvider -- gpt-image 系列 / DALL-E 系列"""

import base64
import io
import logging

from services.ai.base import ImageProvider

logger = logging.getLogger(__name__)

OPENAI_IMAGE_MODELS: dict[str, dict[str, str]] = {
    "gpt-image-2": {
        "name": "GPT · 旗舰",
        "desc": "最新一代，写实人像和创意设计都很强",
        "price": "$0.006-0.211/张",
        "best_for": "助教形象照、写实风格、品牌海报、创意设计",
    },
    "gpt-image-1": {
        "name": "GPT · 通用",
        "desc": "均衡型，画质稳定，适合大多数场景",
        "price": "$0.011-0.167/张",
        "best_for": "活动海报、赛事宣传、通用配图",
    },
    "gpt-image-1-mini": {
        "name": "GPT · 轻量",
        "desc": "速度快成本低，适合日常大量出图",
        "price": "$0.005-0.036/张",
        "best_for": "快速预览、批量生成、日常配图",
    },
    "dall-e-3": {
        "name": "DALL-E · 创意",
        "desc": "擅长艺术风格和创意表达",
        "price": "$0.04-0.12/张",
        "best_for": "节日主题、艺术海报、创意设计",
    },
}

# 默认质量设置
_DEFAULT_QUALITY: dict[str, str] = {
    "gpt-image-2": "low",
    "gpt-image-1": "medium",
    "gpt-image-1-mini": "low",
    "dall-e-3": "standard",
}


class OpenAIImageProvider(ImageProvider):
    name = "openai"
    supported_models = list(OPENAI_IMAGE_MODELS.keys())

    def __init__(self, api_key: str):
        self._api_key = api_key
        self._client = None

    def _get_client(self):
        if self._client is None:
            import httpx
            from openai import AsyncOpenAI
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                timeout=httpx.Timeout(300.0, connect=30.0),
            )
        return self._client

    async def generate_image(
        self,
        prompt: str,
        model: str = "gpt-image-1",
        size: str = "1024*1024",
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        """调用 OpenAI API 生成图片。支持图生图。"""
        client = self._get_client()

        # 解析 size: "1024*1024" -> "1024x1024"
        openai_size = size.replace("*", "x")

        quality = kwargs.get("quality") or _DEFAULT_QUALITY.get(model, "medium")

        if image:
            # 图生图：使用 images.edit() 接口
            images = [image] if isinstance(image, bytes) else image
            # images.edit 要求 file-like 对象
            image_files = []
            for img_bytes in images:
                image_files.append(("image", ("ref.png", io.BytesIO(img_bytes), "image/png")))

            response = await client.images.edit(
                model=model,
                prompt=prompt,
                image=image_files[0][1][1] if len(image_files) == 1 else [f[1][1] for f in image_files],
                size=openai_size,
                quality=quality,
            )
        elif model.startswith("dall-e"):
            # DALL-E 系列用 response_format
            response = await client.images.generate(
                model=model,
                prompt=prompt,
                n=1,
                size=openai_size,
                quality=quality,
                response_format="b64_json",
            )
        else:
            # gpt-image 系列
            response = await client.images.generate(
                model=model,
                prompt=prompt,
                n=1,
                size=openai_size,
                quality=quality,
            )

        image_b64 = response.data[0].b64_json
        return base64.b64decode(image_b64)
