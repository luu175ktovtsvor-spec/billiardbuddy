"""OpenAI Responses API ImageProvider -- 支持多轮对话的图片生成"""

import base64
import io
import logging

logger = logging.getLogger(__name__)


class OpenAIResponseImageProvider:
    """基于 Responses API 的图片生成，支持多轮对话。

    使用 gpt-4o 作为主模型，通过 image_generation tool 调度图片生成。
    支持 previous_response_id 实现真正的多轮对话上下文。
    """

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
                timeout=httpx.Timeout(300.0, connect=30.0),
            )
        return self._client

    async def generate(
        self,
        prompt: str,
        previous_response_id: str | None = None,
        input_images: list[bytes] | None = None,
    ) -> tuple[bytes, str]:
        """生成图片，返回 (图片bytes, response_id)。

        Parameters
        ----------
        prompt : str
            用户描述。
        previous_response_id : str | None
            上一轮的 response ID，用于多轮对话上下文。
        input_images : list[bytes] | None
            参考图片 bytes 列表（如 Logo），作为上下文传入。

        Returns
        -------
        tuple[bytes, str]
            (PNG bytes, response_id)
        """
        client = self._get_client()

        # 构建 input
        input_content = []

        # 如果有参考图片（如 Logo），作为 input_image 传入
        if input_images:
            for img_bytes in input_images:
                b64 = base64.b64encode(img_bytes).decode()
                input_content.append({
                    "type": "input_image",
                    "image_url": f"data:image/png;base64,{b64}",
                })

        input_content.append({"type": "input_text", "text": prompt})

        params = {
            "model": "gpt-4o",
            "input": input_content,
            "tools": [{"type": "image_generation"}],
        }

        if previous_response_id:
            params["previous_response_id"] = previous_response_id

        response = await client.responses.create(**params)

        # 提取图片
        for output in response.output:
            if output.type == "image_generation_call" and output.status == "completed":
                image_bytes = base64.b64decode(output.result)
                return image_bytes, response.id

        raise RuntimeError("图片生成失败：无 image_generation_call 输出")
