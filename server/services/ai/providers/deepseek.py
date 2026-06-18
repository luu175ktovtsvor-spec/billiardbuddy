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

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 default_model: str | None = None, timeout: float = 60.0):
        # 默认全 None → fallback settings（平台默认行为 100% 不变）。
        # BYOK 时由 ProviderFactory 传入门店自带的 key/base_url/model（可接任意 OpenAI 兼容模型）。
        self._client: AsyncOpenAI | None = None
        self._api_key = api_key
        self._base_url = base_url
        self._default_model = default_model
        self._timeout = timeout

    def _get_client(self) -> AsyncOpenAI:
        if self._client is None:
            api_key = self._api_key or settings.deepseek_api_key
            base_url = self._base_url or settings.deepseek_base_url
            if not api_key:
                raise AIProviderError(
                    message="AI 服务未配置，请联系管理员设置 API Key",
                    status_code=503,
                )
            self._client = AsyncOpenAI(
                base_url=base_url,
                api_key=api_key,
                timeout=httpx.Timeout(self._timeout, connect=10.0),
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
        # default_model 优先：BYOK 实例的 default_model=门店模型名，门店 key 只认它，
        # 不能被调用方传入的平台模型名(如 loop 默认的 deepseek-v4-flash)覆盖否则第三方平台 400。
        # 非 BYOK(default_model=None)时退回 request.model(编排 per-call 覆盖)→ settings 默认。
        model_name = self._default_model or request.model or settings.text_model_name
        try:
            kwargs = {
                "model": model_name,
                "messages": messages,
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
            }
            if request.thinking:
                kwargs["extra_body"] = {"thinking": request.thinking}
            if request.tools:
                kwargs["tools"] = request.tools
                if request.tool_choice is not None:
                    kwargs["tool_choice"] = request.tool_choice
            response = await client.chat.completions.create(**kwargs)
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

        tokens = response.usage.total_tokens if response.usage else 0
        if not response.choices:
            logger.warning("DeepSeek returned empty choices")
            return TextResponse(content="", model=model_name, tokens_used=tokens)

        choice = response.choices[0]
        content = choice.message.content or ""
        tool_calls = _serialize_tool_calls(getattr(choice.message, "tool_calls", None))
        finish_reason = getattr(choice, "finish_reason", None)

        # ⚠️ 关键：模型决定调工具时 content 为空、tool_calls 才有值；
        # 二者皆空才算真的空响应（旧逻辑只看 content，会把工具调用整个丢掉）。
        if not content and not tool_calls:
            logger.warning("DeepSeek returned empty content and no tool_calls")

        return TextResponse(
            content=content,
            model=model_name,
            tokens_used=tokens,
            tool_calls=tool_calls,
            finish_reason=finish_reason,
        )

    async def generate_stream(
        self, request: TextRequest, usage_sink: dict | None = None,
        tool_calls_sink: list[dict] | None = None,
    ) -> AsyncIterator[str]:
        if request.messages:
            messages = request.messages
        else:
            messages = []
            if request.system_prompt:
                messages.append({"role": "system", "content": request.system_prompt})
            messages.append({"role": "user", "content": request.prompt})

        client = self._get_client()
        # default_model 优先：BYOK 实例的 default_model=门店模型名，门店 key 只认它，
        # 不能被调用方传入的平台模型名(如 loop 默认的 deepseek-v4-flash)覆盖否则第三方平台 400。
        # 非 BYOK(default_model=None)时退回 request.model(编排 per-call 覆盖)→ settings 默认。
        model_name = self._default_model or request.model or settings.text_model_name
        try:
            kwargs = {
                "model": model_name,
                "messages": messages,
                "max_tokens": request.max_tokens,
                "temperature": request.temperature,
                "stream": True,
                "stream_options": {"include_usage": True},
            }
            if request.thinking:
                kwargs["extra_body"] = {"thinking": request.thinking}
            if request.tools:
                kwargs["tools"] = request.tools
                if request.tool_choice is not None:
                    kwargs["tool_choice"] = request.tool_choice
            stream = await client.chat.completions.create(**kwargs)
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

        tool_acc: dict[int, dict] = {}
        try:
            async for chunk in stream:
                # 收集 usage 统计，写入调用方传入的 usage_sink（按请求独立，避免并发串号）
                if chunk.usage and usage_sink is not None:
                    usage_sink.update({
                        "prompt_tokens": chunk.usage.prompt_tokens,
                        "completion_tokens": chunk.usage.completion_tokens,
                        "total_tokens": chunk.usage.total_tokens,
                        "cache_hit_tokens": getattr(chunk.usage, 'prompt_cache_hit_tokens', 0),
                    })
                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta
                # 累积流式工具调用增量（id/name 在首片，arguments 分片拼接）
                if getattr(delta, "tool_calls", None):
                    _accumulate_tool_call_deltas(tool_acc, delta.tool_calls)
                if getattr(delta, "content", None):
                    yield delta.content
        except APIStatusError as e:
            raise _classify_api_error(e) from e
        except Exception as e:
            logger.exception("DeepSeek stream chunk error")
            raise AIProviderError(
                message="AI 流式生成中断，请重试",
                provider_error=e,
            ) from e

        # 流正常结束后回填累积的工具调用（供 Agent 循环消费）
        if tool_acc and tool_calls_sink is not None:
            tool_calls_sink.extend(tool_acc[i] for i in sorted(tool_acc))


def _serialize_tool_calls(raw) -> list[dict] | None:
    """把 SDK 的 tool_call 对象序列化成 provider 无关的标准 dict。

    返回结构与 OpenAI 兼容，可直接作为 assistant 消息的 tool_calls 回灌进下一轮 messages。
    """
    if not raw:
        return None
    out: list[dict] = []
    for tc in raw:
        fn = getattr(tc, "function", None)
        out.append({
            "id": getattr(tc, "id", None),
            "type": getattr(tc, "type", "function") or "function",
            "function": {
                "name": getattr(fn, "name", None) if fn else None,
                "arguments": getattr(fn, "arguments", "") if fn else "",
            },
        })
    return out


def _accumulate_tool_call_deltas(acc: dict, deltas) -> None:
    """把流式 delta.tool_calls 按 index 累积进 acc。

    OpenAI/DeepSeek 兼容流：同一工具调用的 arguments 会分多片到达，需按 index 拼接；
    id/type/name 通常只在该 index 的首片出现。
    """
    for d in deltas:
        idx = getattr(d, "index", 0) or 0
        slot = acc.setdefault(idx, {"id": None, "type": "function", "function": {"name": None, "arguments": ""}})
        if getattr(d, "id", None):
            slot["id"] = d.id
        if getattr(d, "type", None):
            slot["type"] = d.type
        fn = getattr(d, "function", None)
        if fn is not None:
            if getattr(fn, "name", None):
                slot["function"]["name"] = fn.name
            if getattr(fn, "arguments", None):
                slot["function"]["arguments"] += fn.arguments


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
