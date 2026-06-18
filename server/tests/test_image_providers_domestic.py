"""国内生图多供应商"口子"：按 base_url 路由 + 硅基流动 / 通义万相适配器（均查证官方文档实现）。

用 mock httpx 钉住请求形态与响应解析，不连网、不烧钱。真机出图需老板自己的 key 在盒子上验。
"""
import asyncio

import pytest


class _FakeResp:
    def __init__(self, json_data=None, content=b""):
        self._json = json_data
        self.content = content

    def raise_for_status(self):
        pass

    def json(self):
        return self._json


class _FakeAC:
    """假 httpx.AsyncClient：按 (method, url) 路由到测试设定的 router。"""
    router = None

    def __init__(self, *a, **k):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def post(self, url, **k):
        return _FakeAC.router("POST", url, k)

    async def get(self, url, **k):
        return _FakeAC.router("GET", url, k)


def test_resolve_kind():
    from services.ai.providers.image_catalog import resolve_image_kind
    assert resolve_image_kind("https://api.siliconflow.cn/v1") == "siliconflow"
    assert resolve_image_kind("https://dashscope.aliyuncs.com/api/v1") == "dashscope"
    assert resolve_image_kind("https://ark.cn-beijing.volces.com/api/v3") == "openai_compatible"
    assert resolve_image_kind("https://api.minimaxi.com/v1") == "minimax"
    assert resolve_image_kind("") == "openai_compatible"  # 兜底最通用


def test_build_image_provider_routing():
    from services.ai.factory import ProviderFactory
    from services.ai.providers.siliconflow_image import SiliconFlowImageProvider
    from services.ai.providers.dashscope_image import DashScopeImageProvider
    from services.ai.providers.openai_image import OpenAIImageProvider
    assert isinstance(ProviderFactory.build_image_provider("k", "https://api.siliconflow.cn/v1", None), SiliconFlowImageProvider)
    assert isinstance(ProviderFactory.build_image_provider("k", "https://dashscope.aliyuncs.com/api/v1", None), DashScopeImageProvider)
    assert isinstance(ProviderFactory.build_image_provider("k", "https://ark.cn-beijing.volces.com/api/v3", None), OpenAIImageProvider)
    assert isinstance(ProviderFactory.build_image_provider("k", "https://api.openai.com/v1", None), OpenAIImageProvider)
    with pytest.raises(ValueError):  # 原生适配器待写 → 清晰报错引导
        ProviderFactory.build_image_provider("k", "https://api.minimaxi.com/v1", None)


def test_siliconflow_provider(monkeypatch):
    import httpx
    cap = {}

    def router(method, url, k):
        if method == "POST":
            cap["body"] = k.get("json")
            cap["url"] = url
            cap["auth"] = (k.get("headers") or {}).get("Authorization")
            return _FakeResp(json_data={"images": [{"url": "http://img/sf.png"}]})
        return _FakeResp(content=b"SFDATA")  # GET 下载图片 url

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.siliconflow_image import SiliconFlowImageProvider
    out = asyncio.run(SiliconFlowImageProvider("sk-x").generate_image(
        prompt="暖色台球房海报背景", model="Kwai-Kolors/Kolors", size="1152*2048"))
    assert out == b"SFDATA"
    assert cap["body"]["image_size"] == "1152x2048"   # 映射成 image_size、x 格式（非 OpenAI 的 size）
    assert cap["body"]["batch_size"] == 1
    assert cap["body"]["model"] == "Kwai-Kolors/Kolors"
    assert "images/generations" in cap["url"]
    assert cap["auth"] == "Bearer sk-x"


def test_dashscope_provider_async_submit_poll(monkeypatch):
    import httpx
    seen = {}

    def router(method, url, k):
        if method == "POST":
            seen["submit_body"] = k.get("json")
            seen["submit_headers"] = k.get("headers")
            return _FakeResp(json_data={"output": {"task_id": "t1", "task_status": "PENDING"}})
        if "/tasks/" in url:  # 轮询：首次即成功（不触发 sleep）
            return _FakeResp(json_data={"output": {"task_status": "SUCCEEDED", "results": [{"url": "http://img/wanx.png"}]}})
        return _FakeResp(content=b"WANXDATA")  # GET 下载图片 url

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.dashscope_image import DashScopeImageProvider
    out = asyncio.run(DashScopeImageProvider("sk-w").generate_image(
        prompt="台球房周末活动海报", model="wanx2.1-t2i-turbo", size="1024x1024"))
    assert out == b"WANXDATA"
    assert seen["submit_body"]["parameters"]["size"] == "1024*1024"     # 转成星号 *
    assert seen["submit_body"]["input"]["prompt"] == "台球房周末活动海报"
    assert seen["submit_headers"].get("X-DashScope-Async") == "enable"  # 文生图必须异步提交


def test_dashscope_failed_task_raises(monkeypatch):
    import httpx

    def router(method, url, k):
        if method == "POST":
            return _FakeResp(json_data={"output": {"task_id": "t2", "task_status": "PENDING"}})
        return _FakeResp(json_data={"output": {"task_status": "FAILED", "message": "敏感词"}})

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.dashscope_image import DashScopeImageProvider
    with pytest.raises(RuntimeError):
        asyncio.run(DashScopeImageProvider("sk-w").generate_image(prompt="x"))
