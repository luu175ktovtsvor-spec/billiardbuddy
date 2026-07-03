"""结构性"上下文/token 超限"错误判定（F8甲 · 反应式安全网,模型无关）。

即便每轮请求前已跑三级压缩流水线（loop.py 的 `_compact_pipeline`），估算仍可能有误差——比如某一步骤
新增的单个超大 tool_result 恰好落在"最近 N 轮保留原文"的窗口内，不会被 autocompact 的"较早段摘要"覆盖到；
或 BYOK 门店接的第三方模型窗口比预期小。这类情况下，单轮请求仍可能被 provider 拒绝（结构性 400：上下文/
token 超限）——这里只提供【纯判定】：这个异常是否"像"这类错误（区别于普通网络错/超时/限流/认证错，
避免误吞真实问题、掩盖别的 bug）。真正的"强制压一次+重试一次"留在 loop.py（与既有的非识图降级包一起，
复用同一次模型调用包装点，见 `_generate_with_vision_degrade` / `_vision_degrade_stream`），这里只判定。

判定两层（宁可稍宽——误判代价仅是多花一次强制压缩+重试；漏判则安全网形同虚设、超限错误直接原样抛给用户）：
① 结构化信号（更可靠）：openai SDK 的 `APIStatusError.code`（从响应 body.code 解析而来）等于
   "context_length_exceeded"——这是 OpenAI 官方文档确认的标准错误码，DeepSeek/Kimi 等 OpenAI 兼容
   端点的错误体也遵循同一格式（本项目 `services/ai/providers/deepseek.py` 走的正是这条 SDK）；
② 关键词兜底：结构化信号缺失（第三方端点错误体不标准）时，退回错误文本关键词子串匹配。关键词均已核实来源：
   - OpenAI 官方文档："This model's maximum context length is X tokens. ... Please reduce the length
     of the messages or completion."（type=invalid_request_error, code=context_length_exceeded）；
   - DeepSeek（OpenAI 兼容端点，实测同款措辞）："This model's maximum context length is X tokens.
     However, you requested Y tokens ... Please reduce the length of the messages or completion."；
   - Moonshot/Kimi 实测报错（GitHub issue 原文）："Invalid request: Your request exceeded model
     token limit: N (requested: M)"；
   - 智谱 GLM 官方错误码文档（错误码 1261/HTTP 400）："Prompt 超长"。
"""

# 已核实的结构化错误码（OpenAI 标准错误体 body.code；多数 OpenAI 兼容端点沿用同一格式）。
_CONTEXT_OVERFLOW_CODES = {"context_length_exceeded"}

# "上下文/token 超限"报错特征词（大小写不敏感子串匹配）——见上方模块说明的逐条来源核实。
# 只作【结构化 code 缺失时】的兜底；关键词选取偏保守（要求"length/limit/超长"等限定语，不用裸"token"/
# "context"这类会命中认证错/限流错的宽泛词），避免误伤把普通错误也当成超限重试一次。
_CONTEXT_OVERFLOW_KEYWORDS = (
    "context_length_exceeded",
    "context length",
    "maximum context",
    "context window",
    "reduce the length",
    "too many tokens",
    "exceeded model token limit",
    "token limit",
    "prompt is too long",
    "prompt 超长",
    "超出最大长度",
    "超过最大长度",
    "上下文长度",
    "长度超限",
)


def _error_haystack(exc: Exception) -> str:
    """把异常里【可能含原始报错文本】的各处拼成一个大字符串，供关键词匹配（小写）。

    与 `vision_degrade._error_haystack` 同一思路（provider 把第三方端点的 400 包成 AIProviderError，
    真正的原始报错串藏在 `.provider_error`）——两处判定关注点不同（图片 vs 上下文超限），刻意各自独立
    成一份小函数、不做跨模块耦合，避免为了复用一个十几行的工具函数而牵连另一个已稳定测试的模块。"""
    parts: list[str] = []
    try:
        parts.append(str(exc))
    except Exception:
        pass
    msg = getattr(exc, "message", None)
    if isinstance(msg, str):
        parts.append(msg)
    pe = getattr(exc, "provider_error", None)
    if pe is not None:
        try:
            parts.append(str(pe))
        except Exception:
            pass
        pe_msg = getattr(pe, "message", None)
        if isinstance(pe_msg, str):
            parts.append(pe_msg)
        pe_body = getattr(pe, "body", None)
        if pe_body is not None:
            try:
                parts.append(str(pe_body))
            except Exception:
                pass
    for chained in (getattr(exc, "__cause__", None), getattr(exc, "__context__", None)):
        if chained is not None and chained is not exc:
            try:
                parts.append(str(chained))
            except Exception:
                pass
    return " ".join(parts).lower()


def _structured_code(exc: Exception) -> str | None:
    """深挖 openai SDK 异常的 `.code`（从响应 body.code 解析而来），含 provider_error 包裹层一并看。"""
    code = getattr(exc, "code", None)
    if isinstance(code, str) and code:
        return code
    pe = getattr(exc, "provider_error", None)
    if pe is not None:
        code = getattr(pe, "code", None)
        if isinstance(code, str) and code:
            return code
    return None


def looks_like_context_overflow_error(exc: Exception) -> bool:
    """这个异常是否"像"结构性上下文/token 超限错误——命中则 loop 触发 F8甲 安全网（强制压缩+重试一次）。

    只用作反应式信号，不保证 100% 准确；宁宽勿漏（见模块说明）。"""
    if exc is None:
        return False
    code = _structured_code(exc)
    if code and code.lower() in _CONTEXT_OVERFLOW_CODES:
        return True
    hay = _error_haystack(exc)
    if not hay:
        return False
    return any(kw in hay for kw in _CONTEXT_OVERFLOW_KEYWORDS)
