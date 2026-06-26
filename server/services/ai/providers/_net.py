"""网络直连/代理判断 —— 所有 AI provider 共用（文字 + 生图 + 视频）。

单一真相源：网关裸 IP / 国内域名 → 绕开系统代理直连；境外 → 走代理出海。
"""
import os
from urllib.parse import urlparse

from config import settings

_DOMESTIC_API_HINTS = (
    "xiaomimimo.com", "volces.com", "dashscope", "aliyuncs", "siliconflow",
    "deepseek.com", "bigmodel.cn", "zhipu", "moonshot.cn", "baichuan", "qianfan", "baidubce", ".cn/",
)


def _extract_host(url: str | None) -> str:
    if not url:
        return ""
    parsed = urlparse(url)
    return (parsed.hostname or "").lower()


def _is_gateway_host(base_url: str | None) -> bool:
    """base_url 的 host 与 settings 里的网关 host 一致 → True（我们自己的服务器，直连）。
    排除已知境外上游原始端点（避免 settings 直接指向 openai.com 时误判）。"""
    target_host = _extract_host(base_url)
    if not target_host:
        return False
    gateway_urls = (
        getattr(settings, "deepseek_base_url", None),
        getattr(settings, "openai_base_url", None),
    )
    for gw in gateway_urls:
        gw_host = _extract_host(gw)
        if not gw_host or gw_host != target_host:
            continue
        gw_lower = (gw or "").lower()
        is_known_foreign = any(kw in gw_lower for kw in (
            "openai.com", "anthropic.com", "googleapis.com", "azure.com",
        ))
        if not is_known_foreign:
            return True
    return False


def bypass_proxy_for(base_url: str | None) -> bool:
    """该端点是否应直连（绕开系统代理 Clash 等）。
    判定顺序：
      1. DESKTOP_MODEL_USE_PROXY=1 → 全局强制走代理（逃生开关）
      2. host 与 settings 网关一致 → 直连（覆盖裸 IP 网关）
      3. 匹配国产域名关键词 → 直连
      4. 以上都不命中 → 走代理（境外）
    """
    if os.environ.get("DESKTOP_MODEL_USE_PROXY") == "1":
        return False
    if _is_gateway_host(base_url):
        return True
    host = (base_url or "").lower()
    return any(h in host for h in _DOMESTIC_API_HINTS)
