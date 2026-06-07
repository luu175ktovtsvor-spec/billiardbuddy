"""Mimo V2.5 文本模型 Provider（小米 Mimo 平台，OpenAI 兼容接口）"""

import logging
from typing import AsyncIterator

import httpx
from openai import AsyncOpenAI, APIStatusError, APITimeoutError, APIConnectionError

from core.exceptions import AIProviderError
from services.ai.base import TextProvider, TextRequest, TextResponse

logger = logging.getLogger(__name__)

MIMO_BASE_URL = "https://api.xiaomimimo.com/v1"


class MimoProvider(TextProvider):
    """小米 Mimo V2.5 文本模型 Provider。"""

    def __init__(self, api_key: str, model: str = "mimo-v2.5"):
        self._api_key = api_key
        self._model = model
        self._client: AsyncOpenAI | None = None

    def _get_client(self) -> AsyncOpenAI:
        if self._client is None:
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=MIMO_BASE_URL,
                timeout=httpx.Timeout(120.0, connect=10.0),
            )
        return self._client

    async def generate(self, request: TextRequest) -> TextResponse:
        messages = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        messages.append({"role": "user", "content": request.prompt})

        client = self._get_client()
        try:
            response = await client.chat.completions.create(
                model=self._model,
                messages=messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
            )
        except APIStatusError as e:
            raise AIProviderError(
                message=f"Mimo API 错误 ({e.status_code})",
                status_code=e.status_code,
                provider_error=e,
            ) from e
        except APITimeoutError as e:
            raise AIProviderError(
                message="Mimo 服务响应超时，请稍后重试",
                status_code=504,
                provider_error=e,
            ) from e
        except APIConnectionError as e:
            raise AIProviderError(
                message="Mimo 服务连接失败，请稍后重试",
                status_code=502,
                provider_error=e,
            ) from e
        except Exception as e:
            logger.exception("Mimo unexpected error")
            raise AIProviderError(
                message="AI 生成失败，请稍后重试",
                provider_error=e,
            ) from e

        content = response.choices[0].message.content or ""
        tokens = response.usage.total_tokens if response.usage else 0

        return TextResponse(
            content=content,
            model=self._model,
            tokens_used=tokens,
        )

    async def generate_stream(self, request: TextRequest) -> AsyncIterator[str]:
        messages = []
        if request.system_prompt:
            messages.append({"role": "system", "content": request.system_prompt})
        messages.append({"role": "user", "content": request.prompt})

        client = self._get_client()
        try:
            stream = await client.chat.completions.create(
                model=self._model,
                messages=messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                stream=True,
            )
        except Exception as e:
            logger.exception("Mimo stream error")
            raise AIProviderError(
                message="AI 生成失败，请稍后重试",
                provider_error=e,
            ) from e

        try:
            async for chunk in stream:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except Exception as e:
            logger.exception("Mimo stream chunk error")
            raise AIProviderError(
                message="AI 流式生成中断，请重试",
                provider_error=e,
            ) from e
