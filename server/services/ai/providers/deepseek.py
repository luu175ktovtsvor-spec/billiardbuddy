import asyncio
import logging
import os
import random
from typing import AsyncIterator

import httpx
from openai import AsyncOpenAI, APIStatusError, APITimeoutError, APIConnectionError

from config import settings
from core.exceptions import AIProviderError
from services.ai.base import (
    TEXT_PROVIDER_TIMEOUT_SECONDS,
    TextProvider,
    TextRequest,
    TextResponse,
    ReasoningChunk,
)
from services.ai.providers._net import bypass_proxy_for as _bypass_proxy_for, _extract_host, _is_gateway_host

logger = logging.getLogger(__name__)

# ---------- Gap A 重试退避（对齐官方做法，见 docs/references/harness缺口审计-对照ClaudeCode-2026-06-26.md A）----------
# 可重试错误集合：请求超时(408)/限流(429)/服务器(500)/网关(502)/不可用(503)/网关超时(504)/过载(529)
# + 连接错误(APIConnectionError→视作 502) + 读超时(APITimeoutError→视作 504)。这些都是上游"抖一下"，
# 同一档退避重试几次往往就过去了。不可重试(400 参数 / 401 认证 / 402 余额)退了也没用 → 直接抛。
_RETRYABLE_STATUS = {408, 429, 500, 502, 503, 504, 529}
# 一般可重试错误最多退避重试几次（共 _MAX_RETRIES+1 次尝试）。上限取中(官方 10 次)——我们下游还有
# failover 切 BYOK 档兜底，本档不必试满 10 次，4~6 次足够吸收瞬时抖动、剩下的交给 failover。
_MAX_RETRIES = 5
# 529(他家过载)：只少试几次就把可重试错误抛出，让 FailoverTextProvider 切下一套配置档（他过载、等他不如换一家）。
_OVERLOAD_MAX_RETRIES = 2
_BACKOFF_BASE = 0.5      # 退避基数秒：0.5→1→2→4…
_BACKOFF_CAP = 30.0      # 单次退避封顶秒（指数涨到此为止）
_RETRY_AFTER_CAP = 60.0  # 尊重 Retry-After 头，但封顶——防服务端给个超大值把请求挂死
# full jitter 的随机源：用独立 Random 实例（非 time 播种的"真随机时钟"，每请求独立、可在测试里注入替换），
# 等待 = rand()*delay ∈ [0, delay)，打散重试时刻、避免大量客户端同一时刻齐步重试再次打爆上游。
_BACKOFF_RNG = random.Random()


def _retry_status(e: Exception) -> int | None:
    """该异常用于【重试决策】的状态码；None = 不可重试。

    用【原始】状态码判定（非分类后的）：超时→504、连接→502、状态错误看其原码是否在可重试集合；
    AIProviderError 分支只为接住流式 idle 看门狗抛出的可重试错误（status_code 已是 504 等）。"""
    if isinstance(e, APITimeoutError):
        return 504
    if isinstance(e, APIConnectionError):
        return 502
    if isinstance(e, APIStatusError):
        return e.status_code if e.status_code in _RETRYABLE_STATUS else None
    if isinstance(e, AIProviderError):
        sc = getattr(e, "status_code", None)
        return sc if sc in _RETRYABLE_STATUS else None
    return None


def _classify_call_error(e: Exception) -> AIProviderError:
    """把一次调用抛出的 SDK 异常统一分类成用户友好的 AIProviderError（带 status_code 供 failover 接力）。"""
    if isinstance(e, AIProviderError):
        return e
    if isinstance(e, APITimeoutError):
        return AIProviderError(message="AI 服务响应超时，请稍后重试", status_code=504, provider_error=e)
    if isinstance(e, APIConnectionError):
        return AIProviderError(message="AI 服务连接失败，请稍后重试", status_code=502, provider_error=e)
    if isinstance(e, APIStatusError):
        return _classify_api_error(e)
    return AIProviderError(message="AI 生成失败，请稍后重试", status_code=502, provider_error=e)


def _parse_retry_after(e: Exception) -> float | None:
    """从 429/503 响应头解析 Retry-After（秒）；缺失/非法/负值 → None（改用退避兜底）。封顶 _RETRY_AFTER_CAP。"""
    if not isinstance(e, APIStatusError):
        return None
    ra = e.response.headers.get("Retry-After") or e.response.headers.get("retry-after")
    if ra is None:
        return None
    try:
        val = float(ra)
    except (ValueError, TypeError):
        return None
    if val < 0:
        return None
    return min(val, _RETRY_AFTER_CAP)


def _backoff_wait(e: Exception, attempt: int, rand) -> float:
    """本次失败应等待的秒数：有合法 Retry-After 头就尊重它（已封顶，不再叠 jitter）；
    否则【指数退避 + full jitter】：delay=min(base*2**attempt, cap)，wait=rand()*delay ∈ [0, delay)。"""
    ra = _parse_retry_after(e)
    if ra is not None:
        return ra
    delay = min(_BACKOFF_BASE * (2 ** attempt), _BACKOFF_CAP)
    return rand() * delay


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


# ---------- Gap K 流式 idle 看门狗（配合 Gap A，见审计 K）----------
# 逐块取 chunk 加 idle 计时（asyncio.wait_for 包每次 __anext__）：上游建流后"卡住不吐 token"不再干等
# httpx 读超时（生产 factory 给 300s = 转圈到天荒地老），超时即中断、按可重试错误(504)抛 → 被 A/failover 接住。
# 首块预算更长（MiMo 这种带 reasoning 的模型首字慢），之后每块从严。可用环境变量覆盖。
_STREAM_FIRST_CHUNK_TIMEOUT = _env_float("DESKTOP_STREAM_FIRST_CHUNK_TIMEOUT", 120.0)
_STREAM_IDLE_TIMEOUT = _env_float("DESKTOP_STREAM_IDLE_TIMEOUT", 90.0)
# 建流/首块前失败（yielded=False）可整流退避重试几次；一旦吐过 token 就不再重试（重复执行已展示内容不安全）。
# 1~2 即可——剩下交给 FailoverTextProvider 切下一套 BYOK 档，两层不各自狂试。
_STREAM_MAX_RETRIES = 2

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


def _thinking_disabled(thinking: dict | None) -> bool:
    """本次请求是否【显式关闭】了思考。MiMo v2.5 默认开思考——thinking=None（没传）也算"开"。"""
    return bool(thinking) and thinking.get("type") == "disabled"


def _should_send_temperature(model_name: str, thinking: dict | None) -> bool:
    """温度分叉只对 MiMo 生效：MiMo 思考模式(默认开)下自定义 temperature 会被官方强制改回 1.0，
    发了是假旋钮 → 不发。但本 provider 也是 BYOK 任意 OpenAI 兼容端点的通用实现——
    非 MiMo 模型(GPT/Kimi/DeepSeek…)thinking=None 就是没思考,温度是真旋钮,必须照发,
    否则编排 0.3 防跑题这类调校会被静默吞掉(复扫发现的误伤面)。"""
    return _thinking_disabled(thinking) or "mimo" not in (model_name or "").lower()


def _cached_prompt_tokens(usage) -> int:
    """从 usage 里读【prompt cache 命中 token 数】，兼容两种字段形态（1-7 缓存可观测）：
    ① OpenAI 风格 usage.prompt_tokens_details.cached_tokens——MiMo 走这个，优先；
    ② DeepSeek 风格 usage.prompt_cache_hit_tokens——兜底兼容。
    防御取值：字段缺失/类型异常(如测试里的 MagicMock)一律按 0，绝不抛错污染主流程。"""
    if usage is None:
        return 0
    details = getattr(usage, "prompt_tokens_details", None)
    if isinstance(details, dict):
        cached = details.get("cached_tokens")
    else:
        cached = getattr(details, "cached_tokens", None) if details is not None else None
    if isinstance(cached, int):
        return cached
    hit = getattr(usage, "prompt_cache_hit_tokens", None)
    return hit if isinstance(hit, int) else 0


class DeepSeekProvider(TextProvider):
    """DeepSeek 文本模型 Provider（兼容 OpenAI SDK）"""

    def __init__(self, api_key: str | None = None, base_url: str | None = None,
                 default_model: str | None = None, timeout: float = TEXT_PROVIDER_TIMEOUT_SECONDS):
        # 默认全 None → fallback settings（平台默认行为 100% 不变）。
        # BYOK 时由 ProviderFactory 传入门店自带的 key/base_url/model（可接任意 OpenAI 兼容模型）。
        # timeout 默认 300s（TEXT_PROVIDER_TIMEOUT_SECONDS）：内置 key 主路径不传 timeout 走这里，
        # 与 BYOK 路径同档，且 > 流式 idle 看门狗首块预算(120s)——保证看门狗先于 httpx 起作用（1-6 超时对齐）。
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
                    message="AI 服务还没准备好，请联系管理员处理",
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
    async def _call_with_retry(client: AsyncOpenAI, kwargs: dict, *,
                               max_retries: int = _MAX_RETRIES, sleep=None, rand=None):
        """调用 chat.completions.create，对可重试错误做【指数退避 + full jitter】重试（Gap A）。

        可重试集合见 `_RETRYABLE_STATUS` + 连接错误 + 读超时；不可重试(400/401/402…)直接抛。
        529(过载)只试 `_OVERLOAD_MAX_RETRIES` 次就抛、交给 FailoverTextProvider 切下一档。
        有合法 Retry-After 头则尊重它（封顶 `_RETRY_AFTER_CAP`），否则指数退避。

        与 failover 分层：本函数只在【同一档】退避重试，仍抛可重试 AIProviderError 才由上层切档——
        两层不各自狂试。sleep/rand 可注入（测试用，不真睡、确定性）。
        """
        _sleep = sleep or asyncio.sleep
        _rand = rand or _BACKOFF_RNG.random
        attempt = 0
        while True:
            try:
                return await client.chat.completions.create(**kwargs)
            except (APIStatusError, APITimeoutError, APIConnectionError) as e:
                status = _retry_status(e)  # 原始码判定；None=不可重试
                cap = _OVERLOAD_MAX_RETRIES if status == 529 else max_retries
                if status is None or attempt >= cap:
                    raise _classify_call_error(e) from e
                wait = _backoff_wait(e, attempt, _rand)
                logger.info("可重试错误 status=%s，第 %d/%d 次退避 %.2fs 后重试",
                            status, attempt + 1, cap, wait)
                await _sleep(wait)
                attempt += 1
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
        }
        # 1-3 温度分叉（MiMo 官方）：MiMo 思考模式(默认开)下自定义 temperature 无效(官方强制改回 1.0)，
        # 不发假旋钮；显式关思考才发。非 MiMo 模型(BYOK 通用端点)温度是真旋钮，照发不误伤。top_p 我们本就不发。
        if _should_send_temperature(model_name, request.thinking):
            kwargs["temperature"] = request.temperature
        if request.thinking:
            kwargs["extra_body"] = {"thinking": request.thinking}
        if request.tools:
            kwargs["tools"] = request.tools
            if request.tool_choice is not None:
                kwargs["tool_choice"] = request.tool_choice

        async with _get_semaphore():
            response = await self._call_with_retry(client, kwargs)

        tokens = response.usage.total_tokens if response.usage else 0
        # Gap C：透出输入 token 数(prompt_tokens)给 autocompact 触发判据当真值。防御取值：
        # 端点没返回/类型异常(如测试里的 MagicMock)一律按 0，绝不让它污染估算。
        prompt_tokens = 0
        if response.usage is not None:
            _raw_pt = getattr(response.usage, "prompt_tokens", 0)
            if isinstance(_raw_pt, int):
                prompt_tokens = _raw_pt
        # 1-7 缓存可观测：兼容读两种字段（OpenAI 风格优先），透出给调用方记账/打日志。
        cached_tokens = _cached_prompt_tokens(response.usage)
        if not response.choices:
            logger.warning("DeepSeek returned empty choices")
            return TextResponse(content="", model=model_name, tokens_used=tokens,
                                prompt_tokens=prompt_tokens, cached_tokens=cached_tokens)

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
            prompt_tokens=prompt_tokens,
            cached_tokens=cached_tokens,
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
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        # 1-3 温度分叉：与 generate() 同款——只对 MiMo 在思考模式下不发温度；非 MiMo 模型照发（真旋钮）。
        if _should_send_temperature(model_name, request.thinking):
            kwargs["temperature"] = request.temperature
        if request.thinking:
            kwargs["extra_body"] = {"thinking": request.thinking}
        if request.tools:
            kwargs["tools"] = request.tools
            if request.tool_choice is not None:
                kwargs["tool_choice"] = request.tool_choice

        # Gap A/K：建流 + 逐块 idle 看门狗包成一个可整流重试的循环。
        # 只在【还没吐出任何 token（含 reasoning）】时才整流重试（建流即错 / 首块前卡住）——
        # 一旦吐过 token，重试会重复执行已展示内容、不安全，只能把可重试错误抛给上层（failover 据 yielded 决定切不切）。
        _rand = _BACKOFF_RNG.random
        async with _get_semaphore():
            attempt = 0
            while True:
                yielded = False
                tool_acc: dict[int, dict] = {}
                try:
                    stream = await client.chat.completions.create(**kwargs)
                    aiter = stream.__aiter__()
                    first = True
                    while True:
                        budget = _STREAM_FIRST_CHUNK_TIMEOUT if first else _STREAM_IDLE_TIMEOUT
                        try:
                            # idle 看门狗：budget 内没等到下一个 chunk 即中断（上游卡住不吐）
                            chunk = await asyncio.wait_for(aiter.__anext__(), timeout=budget)
                        except StopAsyncIteration:
                            break
                        except TimeoutError as te:  # asyncio.TimeoutError 即 TimeoutError(3.11+)
                            raise AIProviderError(
                                message="AI 流式响应卡住（长时间无新内容），请重试",
                                status_code=504, provider_error=te) from te
                        first = False
                        # 收集 usage 统计，写入调用方传入的 usage_sink（按请求独立，避免并发串号）
                        if chunk.usage and usage_sink is not None:
                            usage_sink.update({
                                "prompt_tokens": chunk.usage.prompt_tokens,
                                "completion_tokens": chunk.usage.completion_tokens,
                                "total_tokens": chunk.usage.total_tokens,
                                # 1-7：旧代码只读 DeepSeek 字段名 prompt_cache_hit_tokens，MiMo 走 OpenAI 风格
                                # prompt_tokens_details.cached_tokens → 命中率恒 0 不可见。改兼容读两种（OpenAI 优先）。
                                "cache_hit_tokens": _cached_prompt_tokens(chunk.usage),
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
                            yielded = True  # 吐过 reasoning 也算"已展示"→ 之后不再整流重试（不重复展示）
                            yield ReasoningChunk(reasoning)
                        # 累积流式工具调用增量（id/name 在首片，arguments 分片拼接）
                        if getattr(delta, "tool_calls", None):
                            _accumulate_tool_call_deltas(tool_acc, delta.tool_calls)
                        if getattr(delta, "content", None):
                            yielded = True
                            yield delta.content
                    # 流正常结束后回填累积的工具调用（供 Agent 循环消费）
                    if tool_acc and tool_calls_sink is not None:
                        tool_calls_sink.extend(tool_acc[i] for i in sorted(tool_acc))
                    return
                except (APIStatusError, APITimeoutError, APIConnectionError, AIProviderError) as e:
                    status = _retry_status(e)  # None=不可重试
                    # 已吐 token / 不可重试 / 超过整流重试上限 → 抛（交给上层 failover 按 yielded 决定切不切）
                    if yielded or status is None or attempt >= _STREAM_MAX_RETRIES:
                        if isinstance(e, AIProviderError):
                            raise
                        raise _classify_call_error(e) from e
                    wait = _backoff_wait(e, attempt, _rand)
                    logger.info("流式建流/首响应失败 status=%s，第 %d/%d 次退避 %.2fs 整流重试",
                                status, attempt + 1, _STREAM_MAX_RETRIES, wait)
                    await asyncio.sleep(wait)
                    attempt += 1
                except Exception as e:
                    logger.exception("DeepSeek stream chunk error")
                    raise AIProviderError(
                        message="AI 流式生成中断，请重试",
                        provider_error=e,
                    ) from e


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
            message="AI 服务认证失败，请联系管理员处理",
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
