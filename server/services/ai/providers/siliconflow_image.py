"""硅基流动 SiliconFlow 文生图 Provider。

查证(2026-06-19，官方 docs.siliconflow.cn)：`POST {base_url}/images/generations`，Bearer 鉴权，
请求体用 **`image_size`("1024x1024") + `batch_size`(1-4)**，不是 OpenAI 的 `size`/`n`；
响应 `{"images":[{"url":...}]}`，url 约 **1 小时**有效 → 即时下载成 bytes。
聚合平台：一个 key 切 `model` 即可调 Kolors/Qwen-Image/SD 等多家开源模型。
"""
import base64
import logging

import httpx

from config import settings
from services.ai.base import ImageProvider
from services.ai.providers.image_catalog import fetch_image_bytes

logger = logging.getLogger(__name__)

_DEFAULT_BASE = "https://api.siliconflow.cn/v1"


class SiliconFlowImageProvider(ImageProvider):
    name = "siliconflow"
    supported_models = ["Kwai-Kolors/Kolors", "Qwen/Qwen-Image"]

    def __init__(self, api_key: str, base_url: str = _DEFAULT_BASE):
        self._api_key = api_key
        self._base_url = (base_url or _DEFAULT_BASE).rstrip("/")

    async def generate_image(
        self,
        prompt: str,
        model: str = "Kwai-Kolors/Kolors",
        size: str = "1024*1024",
        quality: str = "medium",   # 硅基流动不收 quality，忽略（保持 ImageProvider 统一签名）
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        body: dict = {
            "model": model or "Kwai-Kolors/Kolors",
            "prompt": prompt,
            "image_size": size.replace("*", "x"),  # 硅基流动用 image_size、x 格式（非 OpenAI 的 size）
            "batch_size": 1,
        }
        if image:  # 以图生图：收 base64 data-uri（仅单图，多图只用第一张）
            imgs = image if isinstance(image, list) else [image]
            if len(imgs) > 1:  # 别让多余的 Logo/二维码"以为带了其实没带"，明确记一笔
                logger.warning("硅基流动以图生图只收 1 张参考图：本次 %d 张只用第一张（多余的不会进图）", len(imgs))
            img = imgs[0]
            if isinstance(img, (bytes, bytearray)):
                body["image"] = "data:image/png;base64," + base64.b64encode(img).decode()

        timeout = httpx.Timeout(settings.openai_image_timeout, connect=30.0)
        async with httpx.AsyncClient(timeout=timeout) as hc:
            r = await hc.post(
                f"{self._base_url}/images/generations",
                headers={"Authorization": f"Bearer {self._api_key}", "Content-Type": "application/json"},
                json=body,
            )
            r.raise_for_status()
            data = r.json()

        url = _first_url(data)
        if not url:
            raise RuntimeError(f"硅基流动生图响应无图片 url：{str(data)[:200]}")
        return await fetch_image_bytes(url)


def _first_url(data: dict) -> str | None:
    """硅基流动回 {"images":[{"url":...}]}；个别模型/网关可能回 OpenAI 式 {"data":[{"url"|"b64_json"}]}，都兜一下。"""
    for key in ("images", "data"):
        arr = data.get(key)
        if isinstance(arr, list) and arr:
            item = arr[0]
            if isinstance(item, dict) and item.get("url"):
                return item["url"]
    return None
