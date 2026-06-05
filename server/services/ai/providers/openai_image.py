"""OpenAI ImageProvider -- gpt-image 系列 / DALL-E 系列"""

import base64
import logging

from services.ai.base import ImageProvider

logger = logging.getLogger(__name__)

OPENAI_IMAGE_MODELS: dict[str, dict[str, str]] = {
    "gpt-image-2": {
        "name": "GPT Image 2",
        "desc": "最新旗舰，任意分辨率",
        "price": "$0.006-0.211/张",
        "best_for": "人像/助教照片、写实风格、高质量海报、创意设计",
    },
    "gpt-image-1": {
        "name": "GPT Image 1",
        "desc": "初代 GPT Image",
        "price": "$0.011-0.167/张",
        "best_for": "通用海报、活动宣传、赛事海报",
    },
    "gpt-image-1-mini": {
        "name": "GPT Image 1 Mini",
        "desc": "低成本快速版",
        "price": "$0.005-0.036/张",
        "best_for": "快速预览、批量生成、日常配图",
    },
    "dall-e-3": {
        "name": "DALL-E 3",
        "desc": "经典模型",
        "price": "$0.04-0.12/张",
        "best_for": "创意海报、艺术风格、节日主题",
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

    async def generate_image(
        self,
        prompt: str,
        model: str = "gpt-image-1",
        size: str = "1024*1024",
        **kwargs,
    ) -> bytes:
        """调用 OpenAI API 生成图片。"""
        from openai import AsyncOpenAI

        client = AsyncOpenAI(api_key=self._api_key)

        # 解析 size: "1024*1024" -> "1024x1024"
        openai_size = size.replace("*", "x")

        quality = kwargs.get("quality") or _DEFAULT_QUALITY.get(model, "medium")

        if model.startswith("dall-e"):
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
