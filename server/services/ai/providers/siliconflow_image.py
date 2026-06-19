"""硅基流动 SiliconFlow 文生图 Provider。

查证(2026-06-19，官方 docs.siliconflow.cn)：`POST {base_url}/images/generations`，Bearer 鉴权，
请求体用 **`image_size`("1024x1024") + `batch_size`(1-4)**，不是 OpenAI 的 `size`/`n`；
响应 `{"images":[{"url":...}]}`，url 约 **1 小时**有效 → 即时下载成 bytes。
聚合平台：一个 key 切 `model` 即可调 Kolors/Qwen-Image-Edit/Qwen-Image/SD 等多家开源模型。

图生图（叠 Logo/二维码）：body 加 base64 data-uri 的 `image`。**Qwen-Image-Edit-2509 支持多参考图**
——第1张=`image`、第2张=`image2`、第3张=`image3`（最多 3 张），且该模型不收 `image_size`（输出尺寸由参考图定）；
Kolors 走单张 `image`+`image_size`。
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
    # Qwen-Image-Edit-2509：图像编辑，支持多参考图（image/image2/image3，最多 3 张），叠 Logo/二维码用它；
    # Kolors：综合强文生图，单张参考图走 image+image_size。
    supported_models = ["Qwen/Qwen-Image-Edit-2509", "Kwai-Kolors/Kolors", "Qwen/Qwen-Image"]

    # 硅基流动多参考图字段（Qwen-Image-Edit-2509 最多 3 张）：第1张=image、第2张=image2、第3张=image3
    _MULTI_IMAGE_KEYS = ("image", "image2", "image3")

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
        if image:  # 以图生图：收 base64 data-uri。单张走 image；多张（Qwen-Image-Edit-2509 支持最多 3 张）走 image/image2/image3。
            imgs = [i for i in (image if isinstance(image, list) else [image]) if isinstance(i, (bytes, bytearray))]
            if len(imgs) > len(self._MULTI_IMAGE_KEYS):  # 别让第 4 张起的图"以为带了其实没带"，明确记一笔
                logger.warning(
                    "硅基流动 Qwen-Image-Edit 最多收 %d 张参考图：本次 %d 张，超出的 %d 张不会进图",
                    len(self._MULTI_IMAGE_KEYS), len(imgs), len(imgs) - len(self._MULTI_IMAGE_KEYS),
                )
            for key, img in zip(self._MULTI_IMAGE_KEYS, imgs):
                body[key] = "data:image/png;base64," + base64.b64encode(img).decode()
            # Qwen-Image-Edit-2509 不收 image_size（由参考图决定输出尺寸）；带了参考图就别再硬塞 image_size
            if "image" in body and (model or "").startswith("Qwen/Qwen-Image-Edit"):
                body.pop("image_size", None)

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
