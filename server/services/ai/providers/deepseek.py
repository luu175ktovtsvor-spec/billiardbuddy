import logging
from typing import AsyncIterator

import httpx
from openai import AsyncOpenAI, APIStatusError, APITimeoutError, APIConnectionError

from config import settings
from core.exceptions import AIProviderError
from services.ai.base import TextProvider, TextRequest, TextResponse

logger = logging.getLogger(__name__)


class DeepSeekProvider(TextProvider):
    """DeepSeek 文本模型 Provider（兼容 OpenAI SDK）"""

    def __init__(self):
        self._client: AsyncOpenAI | None = None
        self._last_usage: dict | None = None

    def _get_client(self) -> AsyncOpenAI:
        if self._client is None:
            if not settings.deepseek_api_key:
                raise AIProviderError(
                    message="AI 服务未配置，请联系管理员设置 API Key",
                    status_code=503,
                )
            self._client = AsyncOpenAI(
                base_url=settings.deepseek_base_url,
                api_key=settings.deepseek_api_key,
                timeout=httpx.Timeout(60.0, connect=10.0),
            )
        return self._client

    async def generate(self, request: TextRequest) -> TextResponse:
        if request.messages:
            messages = request.messages
        else:
            messages = []
            if request.system_prompt:
                messages.append({"role": "system", "content": request.system_prompt})
            messages.append({"role": "user", "content": request.prompt})

        client = self._get_client()
        try:
            response = await client.chat.completions.create(
                model=settings.text_model_name,
                messages=messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
            )
        except APIStatusError as e:
            raise _classify_api_error(e) from e
        except APITimeoutError as e:
            raise AIProviderError(
                message="AI 服务响应超时，请稍后重试",
                status_code=504,
                provider_error=e,
            ) from e
        except APIConnectionError as e:
            raise AIProviderError(
                message="AI 服务连接失败，请稍后重试",
                status_code=502,
                provider_error=e,
            ) from e
        except Exception as e:
            logger.exception("DeepSeek unexpected error")
            raise AIProviderError(
                message="AI 生成失败，请稍后重试",
                provider_error=e,
            ) from e

        if not response.choices or not response.choices[0].message.content:
            logger.warning("DeepSeek returned empty choices")
            return TextResponse(
                content="",
                model=settings.text_model_name,
                tokens_used=response.usage.total_tokens if response.usage else 0,
            )

        return TextResponse(
            content=response.choices[0].message.content,
            model=settings.text_model_name,
            tokens_used=response.usage.total_tokens if response.usage else 0,
        )

    async def generate_stream(self, request: TextRequest) -> AsyncIterator[str]:
        if request.messages:
            messages = request.messages
        else:
            messages = []
            if request.system_prompt:
                messages.append({"role": "system", "content": request.system_prompt})
            messages.append({"role": "user", "content": request.prompt})

        client = self._get_client()
        try:
            stream = await client.chat.completions.create(
                model=settings.text_model_name,
                messages=messages,
                max_tokens=request.max_tokens,
                temperature=request.temperature,
                stream=True,
                stream_options={"include_usage": True},
            )
        except APIStatusError as e:
            raise _classify_api_error(e) from e
        except APITimeoutError as e:
            raise AIProviderError(
                message="AI 服务响应超时，请稍后重试",
                status_code=504,
                provider_error=e,
            ) from e
        except APIConnectionError as e:
            raise AIProviderError(
                message="AI 服务连接失败，请稍后重试",
                status_code=502,
                provider_error=e,
            ) from e
        except Exception as e:
            logger.exception("DeepSeek stream unexpected error")
            raise AIProviderError(
                message="AI 生成失败，请稍后重试",
                provider_error=e,
            ) from e

        try:
            async for chunk in stream:
                # 收集 usage 统计
                if chunk.usage:
                    self._last_usage = {
                        "prompt_tokens": chunk.usage.prompt_tokens,
                        "completion_tokens": chunk.usage.completion_tokens,
                        "total_tokens": chunk.usage.total_tokens,
                        "cache_hit_tokens": getattr(chunk.usage, 'prompt_cache_hit_tokens', 0),
                    }
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
        except APIStatusError as e:
            raise _classify_api_error(e) from e
        except Exception as e:
            logger.exception("DeepSeek stream chunk error")
            raise AIProviderError(
                message="AI 流式生成中断，请重试",
                provider_error=e,
            ) from e


def _classify_api_error(e: APIStatusError) -> AIProviderError:
    """将 OpenAI SDK 的 APIStatusError 分类为用户友好的中文提示。"""
    status = e.status_code

    if status == 401:
        return AIProviderError(
            message="AI 服务认证失败，请联系管理员检查 API Key",
            status_code=503,
            provider_error=e,
        )
    if status == 402:
        return AIProviderError(
            message="AI 服务余额不足，请联系管理员充值",
            status_code=503,
            provider_error=e,
        )
    if status == 429:
        return AIProviderError(
            message="AI 服务请求过快，请稍等再试",
            status_code=429,
            provider_error=e,
        )
    if status == 400:
        return AIProviderError(
            message="AI 请求参数有误，请简化输入内容后重试",
            status_code=400,
            provider_error=e,
        )
    if status >= 500:
        return AIProviderError(
            message="AI 服务暂时不可用，请稍后重试",
            status_code=502,
            provider_error=e,
        )

    return AIProviderError(
        message="AI 生成失败，请稍后重试",
        status_code=502,
        provider_error=e,
    )
