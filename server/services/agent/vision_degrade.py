"""非识图模型【优雅降级】的通用判定/改写（模型无关，反应式）。

核心认知（与 multimodal.py 一脉相承）：能不能看图是【模型】自己的本事，壳子不该维护「识图/非识图模型清单」。
当老板自带的文字模型【不支持图片】时，OpenAI 兼容端点会把带 image_url 的请求直接判错（HTTP 400，
如 DeepSeek 的 `unknown variant 'image_url', expected 'text'`），而不是忽略图片——整个请求失败。

降级策略（loop 里用）：带图请求若【报错】且【错误像"不支持图片"】且【messages 里确实有图】→
把所有多模态 content 拍平成纯文字（去掉 image_url 项、留 text）→ 用纯文字【重试一次】。
因 messages 是 loop 内共享的同一个 list，去图后续轮也不会再带图（一次降级，全程纯文字）。

这里只放【纯判定/纯改写】函数（零网络、零副作用，去图是就地改 list），便于同步/流式两条 loop 路径共用、且可单测。
"""
import logging

logger = logging.getLogger(__name__)

# "模型看不了图"的报错特征词（大小写不敏感子串匹配）。覆盖各家 OpenAI 兼容端点对「带图却不支持」的常见措辞：
# - DeepSeek：unknown variant 'image_url', expected 'text'
# - 其它端点常见：does not support image / vision not supported / multimodal not supported / image input ...
# 只要命中任一即判为"疑似不支持图片"。宁可稍宽——误判的代价仅是"多花一次纯文字重试"，而漏判会让带图请求彻底失败。
_VISION_ERROR_KEYWORDS = (
    "image_url",
    "expected 'text'",
    "expected `text`",
    "expected text",
    "vision",
    "multimodal",
    "multi-modal",
    "image input",
    "image content",
    "does not support image",
    "not support image",
    "image is not supported",
    "unsupported content",
    "unknown variant",
)

# 降级发生时，加进最终答复的温和提示（开头一句）。措辞去钱味、面向不懂技术的老板，并给可操作的下一步。
VISION_DEGRADED_HINT = (
    "⚠️ 你的文字模型看不了图，这次我按你的文字来的；"
    "要让我能看图，请到设置换一个带视觉的模型（如 mimo-v2.5）。"
)


def _content_has_image(content) -> bool:
    """单条消息的 content 是否含 image_url 项（多模态 content 是 [{type:text}, {type:image_url}] 这样的数组）。"""
    if not isinstance(content, list):
        return False
    for item in content:
        if isinstance(item, dict) and item.get("type") == "image_url":
            return True
    return False


def messages_have_images(messages) -> bool:
    """messages 里是否有任意一条带图片内容（image_url）。无图则降级判定整段跳过（避免对"本就纯文字"的失败误降级）。"""
    if not messages:
        return False
    return any(_content_has_image(m.get("content")) for m in messages)


def _error_haystack(exc: Exception) -> str:
    """把异常里【可能含原始报错文本】的各处拼成一个大字符串，供关键词匹配（小写）。

    关键：provider 会把第三方端点的 400 包成 AIProviderError，友好中文放 .message、
    【真正的原始报错串】（含 image_url/expected text 等）藏在 .provider_error（OpenAI SDK 的 APIStatusError，
    其 str()/repr()/.body/.message 才有那串）。故这里既看顶层异常文本，也深挖 provider_error。"""
    parts: list[str] = []
    try:
        parts.append(str(exc))
    except Exception:
        pass
    # AppException/AIProviderError 的 .message
    msg = getattr(exc, "message", None)
    if isinstance(msg, str):
        parts.append(msg)
    # 被包裹的原始 provider 异常（真正含 image_url/expected text 的地方）
    pe = getattr(exc, "provider_error", None)
    if pe is not None:
        try:
            parts.append(str(pe))
        except Exception:
            pass
        try:
            parts.append(repr(pe))
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
    # __cause__/__context__ 链（以防别的 provider 直接抛原始异常、不走 AIProviderError 包装）
    for chained in (getattr(exc, "__cause__", None), getattr(exc, "__context__", None)):
        if chained is not None and chained is not exc:
            try:
                parts.append(str(chained))
            except Exception:
                pass
    return " ".join(parts).lower()


def looks_like_vision_error(exc: Exception) -> bool:
    """这个异常是否【像"模型不支持图片"】——按特征词子串匹配（大小写不敏感）。

    只用作"要不要去图重试"的反应式信号；判错的代价仅是多花一次纯文字重试，故宁宽勿漏。"""
    if exc is None:
        return False
    hay = _error_haystack(exc)
    if not hay:
        return False
    return any(kw in hay for kw in _VISION_ERROR_KEYWORDS)


def _flatten_content_to_text(content) -> str:
    """把一条多模态 content（[{type:text,...}, {type:image_url,...}]）拍平成纯文字：
    只取 type=text 的 text 串、按出现顺序拼接（丢掉所有 image_url 项）。非数组直接当原样返回。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content) if content is not None else ""
    texts: list[str] = []
    for item in content:
        if isinstance(item, dict) and item.get("type") == "text":
            t = item.get("text")
            if isinstance(t, str) and t:
                texts.append(t)
        elif isinstance(item, str) and item:
            texts.append(item)
    return "\n".join(texts)

# 降级后某条消息文字为空时的占位（如老板只发了图、没配文字）——别给端点一个空 content，
# 也让模型知道"这里本来有张图、但你看不了"，免得它以为老板啥也没说。
_EMPTY_AFTER_STRIP_PLACEHOLDER = "[这里原本有一张图片，但当前模型看不了图，已省略]"


def strip_images_from_messages(messages) -> bool:
    """就地把 messages 里所有【多模态 content】降级成纯文字（去 image_url、留 text 拼接）。
    某条降级后文字为空 → 给个占位符（不留空 content）。
    返回是否真的改了（有图被去掉 → True；本就没图 → False，调用方据此决定要不要重试）。"""
    if not messages:
        return False
    changed = False
    for m in messages:
        content = m.get("content")
        if _content_has_image(content):
            text = _flatten_content_to_text(content)
            m["content"] = text if text.strip() else _EMPTY_AFTER_STRIP_PLACEHOLDER
            changed = True
    return changed


def prepend_degrade_hint(text: str) -> str:
    """把降级提示加到最终答复开头（已含提示则不重复加）。空答复也至少给出这句提示，不让老板一脸懵。"""
    body = text or ""
    if VISION_DEGRADED_HINT in body:
        return body
    if not body.strip():
        return VISION_DEGRADED_HINT
    return f"{VISION_DEGRADED_HINT}\n\n{body}"
