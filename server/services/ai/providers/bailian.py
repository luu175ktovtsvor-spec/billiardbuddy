"""阿里云百炼模型网关 — OpenAI 兼容接口"""

import logging
from typing import AsyncIterator

from openai import AsyncOpenAI, APIStatusError, APITimeoutError, APIConnectionError

from config import settings
from core.exceptions import AIProviderError
from services.ai.base import TextProvider, TextRequest, TextResponse

logger = logging.getLogger(__name__)

BAILIAN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1"


class BailianProvider(TextProvider):
    """通过阿里云百炼 OpenAI 兼容接口调用大模型。"""

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self._api_key = api_key or settings.bailian_api_key
        self._model = model or settings.bailian_default_model
        self._client: AsyncOpenAI | None = None

    def _get_client(self) -> AsyncOpenAI:
        if self._client is None:
            if not self._api_key:
                raise AIProviderError(
                    message="百炼 API Key 未配置，请联系管理员",
                    status_code=503,
                )
            self._client = AsyncOpenAI(
                api_key=self._api_key,
                base_url=BAILIAN_BASE_URL,
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
            if e.status_code == 401:
                raise AIProviderError(message="百炼 API Key 无效", status_code=401, provider_error=e) from e
            elif e.status_code == 429:
                raise AIProviderError(message="百炼 API 请求频率超限，请稍后重试", status_code=429, provider_error=e) from e
            else:
                raise AIProviderError(message=f"百炼 API 错误 ({e.status_code})", status_code=e.status_code, provider_error=e) from e
        except APITimeoutError as e:
            raise AIProviderError(message="百炼 API 响应超时，请稍后重试", status_code=504, provider_error=e) from e
        except APIConnectionError as e:
            raise AIProviderError(message="百炼 API 连接失败，请稍后重试", status_code=502, provider_error=e) from e
        except Exception as e:
            logger.exception("Bailian unexpected error")
            raise AIProviderError(message="AI 生成失败，请稍后重试", provider_error=e) from e

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

        stream = await self._get_client().chat.completions.create(
            model=self._model,
            messages=messages,
            max_tokens=request.max_tokens,
            temperature=request.temperature,
            stream=True,
        )

        async for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                yield chunk.choices[0].delta.content
