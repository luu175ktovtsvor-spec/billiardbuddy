"""OpenAI ImageProvider -- gpt-image-2"""

import base64
import io
import logging

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
        model: str = "gpt-image-2",
        size: str = "1024*1024",
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        """调用 OpenAI API 生成图片。支持图生图。"""
        client = self._get_client()
        openai_size = size.replace("*", "x")

        if image:
            images = [image] if isinstance(image, bytes) else image
            image_file = io.BytesIO(images[0])
            response = await client.images.edit(
                model="gpt-image-2",
                prompt=prompt,
                image=image_file,
                size=openai_size,
            )
        else:
            response = await client.images.generate(
                model="gpt-image-2",
                prompt=prompt,
                n=1,
                size=openai_size,
            )

        image_b64 = response.data[0].b64_json
        return base64.b64decode(image_b64)
