import asyncio
import logging
import os
from typing import AsyncIterator

import httpx
from openai import AsyncOpenAI, APIStatusError, APITimeoutError, APIConnectionError

from config import settings
from core.exceptions import AIProviderError
from services.ai.base import TextProvider, TextRequest, TextResponse, ReasoningChunk
from services.ai.providers._net import bypass_proxy_for as _bypass_proxy_for, _extract_host, _is_gateway_host

logger = logging.getLogger(__name__)

# ---------- 客户端并发信号量（避免一瞬间打爆上游限流） ----------
_gateway_sem_limit = int(os.environ.get("GATEWAY_MAX_CONCURRENCY", "5"))
_gateway_semaphore: asyncio.Semaphore | None = None


def _get_semaphore() -> asyncio.Semaphore:
    """惰性初始化：asyncio.Semaphore 需要事件循环，不能在模块加载时创建。"""
    global _gateway_semaphore
    if _gateway_semaphore is None:
        _gateway_semaphore = asyncio.Semaphore(_gateway_sem_limit)
    return _gateway_semaphore

# 各家"上传大本地视频文件换引用"方案（均据官方文档核实；引用可直接用于 Chat Completions 的 video_url）：
#   (base_url 关键词元组, files.create 的 purpose, 引用前缀)
# ⚠️ 前缀需与 multimodal._VIDEO_REF_SCHEMES 保持同步（那边据此识别"已是视频引用、直通不读盘"）。
# 豆包/火山方舟也支持(上限 512MB/2GB)但其 file-id 引用走 Responses API + 需轮询，与本项目 Chat Completions
# 架构不同，暂未纳入(其 base64≤50MB / URL 仍走通用 video_url 路径)。MiMo/Qwen/GLM/文心/混元只支持 URL/base64。
_VIDEO_UPLOAD_PROVIDERS = (
    (("moonshot", "kimi"), "video", "ms://"),       # Moonshot/Kimi：purpose=video → ms://<id>
    (("stepfun",), "storage", "stepfile://"),       # 阶跃星辰 StepFun：purpose=storage → stepfile://<id>
)


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
            # P0-2：国产模型端点直连、绕开系统代理(Clash)；境外端点仍走代理。
            http_client = None
            if _bypass_proxy_for(base_url):
                http_client = httpx.AsyncClient(trust_env=False,
                                                timeout=httpx.Timeout(self._timeout, connect=10.0))
            self._client = AsyncOpenAI(
                base_url=base_url,
                api_key=api_key,
                timeout=httpx.Timeout(self._timeout, connect=10.0),
                http_client=http_client,
            )
        return self._client

    async def upload_video(self, path: str) -> str | None:
        """把本地视频上传到 provider 的 OpenAI 兼容 Files API，返回可在 video_url 里引用的文件引用。

        命中 `_VIDEO_UPLOAD_PROVIDERS`（按 base_url 关键词）才上传：Moonshot/Kimi → `purpose=video`/`ms://<id>`；
        阶跃星辰 StepFun → `purpose=storage`/`stepfile://<id>`。这俩的引用都能直接进 Chat Completions 的 video_url。
        未命中（MiMo/Qwen/GLM/文心/混元只支持 URL/base64；豆包 file-id 需 Responses API）→ 返回 None，
        交由上层跳过该视频、走纯文字降级。故障安全：任何失败返回 None，绝不阻断对话。"""
        import asyncio
        import os
        base = (self._base_url or settings.deepseek_base_url or "").lower()
        purpose = scheme = None
        for keys, p, prefix in _VIDEO_UPLOAD_PROVIDERS:
            if any(k in base for k in keys):
                purpose, scheme = p, prefix
                break
        if scheme is None:
            return None
        try:
            data = await asyncio.to_thread(lambda: open(path, "rb").read())
            client = self._get_client()
            uploaded = await client.files.create(file=(os.path.basename(path), data), purpose=purpose)
            fid = getattr(uploaded, "id", None)
            return f"{scheme}{fid}" if fid else None
        except Exception:
            logger.warning("视频上传失败(provider Files API)，跳过该视频走纯文字降级", exc_info=True)
            return None

    @staticmethod
    async def _call_with_retry(client: AsyncOpenAI, kwargs: dict):
        """调用 chat.completions.create，遇 429 + Retry-After 头自动等一次再重试。

        只重试一次；没有 Retry-After 头或重试仍 429 则直接抛错。
        """
        try:
            return await client.chat.completions.create(**kwargs)
        except APIStatusError as e:
            if e.status_code == 429:
                retry_after = (e.response.headers.get("Retry-After")
                               or e.response.headers.get("retry-after"))
                if retry_after is not None:
                    try:
                        wait = float(retry_after)
                    except (ValueError, TypeError):
                        raise _classify_api_error(e) from e
                    logger.info("429 Retry-After=%.1fs，等待后重试一次", wait)
                    await asyncio.sleep(wait)
                    try:
                        return await client.chat.completions.create(**kwargs)
                    except APIStatusError as e2:
                        raise _classify_api_error(e2) from e2
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

        async with _get_semaphore():
            response = await self._call_with_retry(client, kwargs)

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
        finish_sink: dict | None = None,
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

        async with _get_semaphore():
            stream = await self._call_with_retry(client, kwargs)

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
                    choice0 = chunk.choices[0]
                    # SH-4：截断恢复需要 finish_reason。流式里它在末片随 choice 返回（content 片为 None），
                    # 累计最后一个非空值写进 finish_sink，供 Agent 循环判断 ="length" 续写。
                    fr = getattr(choice0, "finish_reason", None)
                    if fr and finish_sink is not None:
                        finish_sink["finish_reason"] = fr
                    delta = choice0.delta
                    # F.1 思考过程：reasoning_content 是 DeepSeek/通义/智谱/Kimi/硅基/火山/MiMo 通用约定（非 SDK 声明字段，
                    # 用 getattr + model_extra 兜底，绝不裸点否则 AttributeError）。yield ReasoningChunk 与正文区分、只供展示。
                    reasoning = (getattr(delta, "reasoning_content", None)
                                 or (getattr(delta, "model_extra", None) or {}).get("reasoning_content"))
                    if reasoning:
                        yield ReasoningChunk(reasoning)
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
