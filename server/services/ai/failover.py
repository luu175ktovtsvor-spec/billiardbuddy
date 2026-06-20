"""BYOK 供应商自动容灾（借鉴 learn-claude-code s11「连续失败切 fallback」）。

老板存了好几套大模型配置档（byok_profiles，CC-Switch 式）。本模块把门店当前 provider 包一层：
模型调用因【限流/网关/过载/超时】失败时，自动切到下一套【有 key、没试过】的配置档、重试本次调用——
老板的请求不会因为某家供应商挂了/限流就整个崩掉。

设计取舍（刻意保守、低风险）：
- 只在【本次 agent 运行内】切换并重试，**不写主库**——避免在流式响应期写 store 触发会话生命周期问题。
  set_active 写的是【独立的 profiles.db（同步 sqlite）】，安全；UI 的「当前激活」随之反映。
  下次请求若那家仍挂，会再次自动容灾（每次请求自愈），代价仅是每次先白试一下那家。
- loop.py 一行不动：把 provider 包成本类即可，循环照常 `provider.generate / generate_stream`。
- 防抖：一次调用最多切 _MAX_SWITCHES 套；试过的不再回头；切一圈都挂 → 抛最后的错（上层正常报错）。
- 流式：仅在【尚未吐出任何 token】时才容灾——已经开始流就不能干净重来（不能把已展示的半段吞回去）。
- 只有 BYOK + 至少两套有 key 的配置档时才包这层；否则原样返回 provider（对现有行为零影响）。
"""
import logging
import os

from core.exceptions import AIProviderError
from services.ai.base import TextProvider, TextRequest, TextResponse
from services.ai.factory import ProviderFactory

logger = logging.getLogger(__name__)

# 一次模型调用内最多自动切几套备用档（防抖：切一圈就够，避免无限切）。
_MAX_SWITCHES = 2
# 可容灾的状态码：限流(429) / 网关·连接(502) / 服务不可用·缺 key(503) / 超时(504) / 服务器·过载(500/529)。
# 切到另一套配置档能解决这些；400(请求本身有问题)等不在内——切了也没用。
_RETRYABLE_STATUS = {429, 500, 502, 503, 504, 529}


def _is_retryable(e: Exception) -> bool:
    return isinstance(e, AIProviderError) and getattr(e, "status_code", None) in _RETRYABLE_STATUS


def _make_switch(store):
    """返回一个 switch()：切到门店下一套【有 key、本次没试过、非当前激活】的配置档，
    把它的值拷进内存 store.byok_*（让 factory 用新 key 重建）+ 更新 profiles.db 激活指针，
    返回新 provider；没有可切的返回 None。试过的档记在闭包里，绝不回头切到刚挂的那套。"""
    tried: set[str] = set()

    def switch():
        from services import byok_profiles
        sid = str(store.id)
        profs = byok_profiles.list_profiles(sid)
        active = next((p["name"] for p in profs if p["is_active"]), None)
        if active:
            tried.add(active)  # 当前激活的（刚挂的）记为试过，别再切回去
        for p in profs:
            if not p["has_key"] or p["name"] in tried:
                continue
            prof = byok_profiles.get_profile(sid, p["name"])
            if not prof or not prof.get("api_key_enc"):
                continue
            # 切：拷进内存 store.byok_*（密文同一把主密钥加密，可直接拷）+ 更新激活指针（独立 sqlite，不碰主库）
            store.byok_enabled = True
            store.byok_base_url = prof["base_url"]
            store.byok_model = prof["model"]
            store.byok_api_key_enc = prof["api_key_enc"]
            byok_profiles.set_active(sid, p["name"])
            tried.add(p["name"])
            logger.warning("BYOK 供应商失败，自动切到备用配置档「%s」 store_id=%s", p["name"], sid)
            return ProviderFactory.get_text_provider_for_store(store)
        return None

    return switch


class FailoverTextProvider(TextProvider):
    """把门店 provider 包一层：可容灾错误 → 自动切下一套配置档重试本次调用。详见模块 docstring。"""

    def __init__(self, provider: TextProvider, switch_fn, max_switches: int = _MAX_SWITCHES):
        self._provider = provider
        self._switch_fn = switch_fn          # () -> TextProvider | None
        self._max = max_switches

    async def generate(self, request: TextRequest) -> TextResponse:
        attempt = 0
        while True:
            try:
                return await self._provider.generate(request)
            except Exception as e:
                if attempt >= self._max or not _is_retryable(e):
                    raise
                nxt = self._switch_fn()
                if nxt is None:
                    raise
                self._provider = nxt
                attempt += 1

    async def generate_stream(self, request: TextRequest, usage_sink: dict | None = None,
                              tool_calls_sink: list[dict] | None = None,
                              finish_sink: dict | None = None):
        attempt = 0
        while True:
            yielded = False
            try:
                async for tok in self._provider.generate_stream(
                        request, usage_sink=usage_sink, tool_calls_sink=tool_calls_sink, finish_sink=finish_sink):
                    yielded = True
                    yield tok
                return
            except Exception as e:
                # 已经吐过 token / 超过切换上限 / 不可容灾 → 不容灾，原样抛（已展示的半段不能吞回去）
                if yielded or attempt >= self._max or not _is_retryable(e):
                    raise
                nxt = self._switch_fn()
                if nxt is None:
                    raise
                self._provider = nxt
                attempt += 1


def build_resilient_text_provider(store) -> TextProvider:
    """按门店建文本 provider：BYOK + 至少两套有 key 的配置档 → 包一层自动容灾；否则原样返回（零行为变化）。"""
    base = ProviderFactory.get_text_provider_for_store(store)
    if store is None or not getattr(store, "byok_enabled", False):
        return base
    # 桌面纯 BYOK 才有多档容灾的意义；云端 web 不走这套
    if os.environ.get("DESKTOP_LOCAL") != "1":
        return base
    try:
        from services import byok_profiles
        keyed = [p for p in byok_profiles.list_profiles(str(store.id)) if p["has_key"]]
    except Exception:
        return base
    if len(keyed) < 2:
        return base  # 只有一套（或没用多档系统）→ 没得切，不包
    return FailoverTextProvider(base, _make_switch(store))
