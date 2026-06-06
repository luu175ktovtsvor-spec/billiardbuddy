"""阿里云百炼 -- 通义万相 ImageProvider"""

import base64
import logging

import httpx

from services.ai.base import ImageProvider

logger = logging.getLogger(__name__)

# 模型列表：model_id -> 显示信息
ALIYUN_IMAGE_MODELS: dict[str, dict[str, str]] = {
    "wanx2.1-t2i-turbo": {
        "name": "万相 · 快速",
        "desc": "出图快，适合日常配图和快速预览",
        "price": "0.04元/张",
        "best_for": "朋友圈配图、日常发文、快速试效果",
    },
    "wanx2.1-t2i-plus": {
        "name": "万相 · 精细",
        "desc": "画质更细腻，适合正式场合使用",
        "price": "0.08元/张",
        "best_for": "活动海报、赛事宣传、群公告配图",
    },
    "wan2.7-image-pro": {
        "name": "万相 · 旗舰",
        "desc": "最新一代，4K 高清，色彩还原度最高",
        "price": "0.04-0.06元/张",
        "best_for": "品牌海报、赛事主视觉、高品质宣传图",
    },
    "z-image-turbo": {
        "name": "Z-Image · 极速",
        "desc": "写实风格，速度极快，适合批量出图",
        "price": "0.01元/张",
        "best_for": "批量生成、快速测试、素材生产",
    },
}


class AliyunImageProvider(ImageProvider):
    name = "aliyun"
    supported_models = list(ALIYUN_IMAGE_MODELS.keys())

    def __init__(self, api_key: str):
        self._api_key = api_key

    async def generate_image(
        self,
        prompt: str,
        model: str = "wanx2.1-t2i-turbo",
        size: str = "1024*1024",
        image: bytes | list[bytes] | None = None,
        **kwargs,
    ) -> bytes:
        """调用阿里云百炼 API 生成图片。支持图生图。"""
        import dashscope
        from dashscope import ImageSynthesis, MultiModalConversation

        dashscope.api_key = self._api_key

        # wan2.7-image-pro 用 MultiModalConversation 接口（天然支持图片输入）
        if model == "wan2.7-image-pro":
            content = [{"text": prompt}]
            if image:
                images = [image] if isinstance(image, bytes) else image
                for img_bytes in images:
                    img_b64 = base64.b64encode(img_bytes).decode("utf-8")
                    content.append({"image": f"data:image/png;base64,{img_b64}"})
            messages = [{"role": "user", "content": content}]
            resp = MultiModalConversation.call(
                model=model,
                messages=messages,
                result_format="message",
            )
            if resp.status_code != 200:
                raise RuntimeError(
                    f"阿里云生图失败: {resp.code} {resp.message}"
                )
            out = resp.output.choices[0].message.content
            url = (
                out[0]["image"]
                if isinstance(out[0], dict)
                else out[0].image
            )
        else:
            # 其他模型用 ImageSynthesis，支持 ref_img 参考图
            call_kwargs = {
                "model": model,
                "prompt": prompt,
                "n": 1,
                "size": size,
            }
            if image:
                images = [image] if isinstance(image, bytes) else image
                img_b64 = base64.b64encode(images[0]).decode("utf-8")
                call_kwargs["ref_img"] = f"data:image/png;base64,{img_b64}"
            resp = ImageSynthesis.call(**call_kwargs)
            if resp.status_code != 200:
                raise RuntimeError(
                    f"阿里云生图失败: {resp.code} {resp.message}"
                )
            url = resp.output.results[0].url

        # 下载图片
        async with httpx.AsyncClient(timeout=60) as client:
            img_resp = await client.get(url)
            img_resp.raise_for_status()
            return img_resp.content
