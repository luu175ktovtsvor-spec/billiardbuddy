"""生图 Provider 的国内 BYOK 兼容（OpenAI 兼容端点，如硅基流动 Kwai-Kolors/Kolors）：

- 配置的模型被真正传给 API（不再写死 gpt-image-2）
- quality 是 gpt-image 专有参数：非 gpt 模型不传（国内端点多不接受）
- 响应兼容两种：gpt-image 回 b64_json；国内端点多回图片 url → 下载成 bytes

注：真机端到端（硅基流动真实出图）需老板的 key + 在盒子上测，这里只用 mock 钉住逻辑、不联网不烧钱。
"""
import asyncio
import base64
import types

from services.ai.providers.openai_image import OpenAIImageProvider


class _FakeImages:
    def __init__(self, calls):
        self.calls = calls

    async def generate(self, **kwargs):
        self.calls["generate"] = kwargs
        return types.SimpleNamespace(data=[types.SimpleNamespace(
            b64_json=base64.b64encode(b"PNGDATA").decode(), url=None)])

    async def edit(self, **kwargs):
        self.calls["edit"] = kwargs
        return types.SimpleNamespace(data=[types.SimpleNamespace(
            b64_json=base64.b64encode(b"EDITDATA").decode(), url=None)])


class _FakeClient:
    def __init__(self, calls):
        self.images = _FakeImages(calls)


def _provider(calls):
    p = OpenAIImageProvider(api_key="k", base_url="https://api.siliconflow.cn/v1")
    p._client = _FakeClient(calls)
    return p


def test_domestic_model_passed_and_quality_omitted():
    calls = {}
    out = asyncio.run(_provider(calls).generate_image(
        prompt="一张暖色温馨的台球房海报背景", model="Kwai-Kolors/Kolors", size="1152*2048", quality="medium"))
    assert out == b"PNGDATA"
    assert calls["generate"]["model"] == "Kwai-Kolors/Kolors"  # 用配置的国内模型，不再写死 gpt-image-2
    assert "quality" not in calls["generate"]                  # 国内端点不附 gpt 专有的 quality


def test_gpt_image_keeps_quality():
    calls = {}
    asyncio.run(_provider(calls).generate_image(prompt="x", model="gpt-image-2", quality="high"))
    assert calls["generate"]["model"] == "gpt-image-2"
    assert calls["generate"]["quality"] == "high"               # gpt-image 系列仍传 quality


def test_default_model_is_gpt_image():
    calls = {}
    asyncio.run(_provider(calls).generate_image(prompt="x"))     # 不传 model → 回退 gpt-image-2（web 不受影响）
    assert calls["generate"]["model"] == "gpt-image-2"


def test_extract_handles_url_response(monkeypatch):
    import httpx

    class _Resp:
        content = b"URLDATA"
        def raise_for_status(self):
            pass

    class _AC:
        def __init__(self, *a, **k):
            pass
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def get(self, url):
            return _Resp()

    monkeypatch.setattr(httpx, "AsyncClient", _AC)
    resp = types.SimpleNamespace(data=[types.SimpleNamespace(b64_json=None, url="http://x/y.png")])
    out = asyncio.run(OpenAIImageProvider(api_key="k")._extract_image_bytes(resp))
    assert out == b"URLDATA"   # 国内端点回 url → 下载成 bytes


def test_desktop_box_uses_bundled_key_zero_config(monkeypatch):
    """专题D（owner 2026-06-24 拍板·反转旧"纯 BYOK"铁律）：桌面盒子=全内置 key、用户零配置——
    内置生图 key 已注入时直接用它（哪怕没配门店 BYOK）；没内置 key 才返回空（逼填 BYOK）。
    云端 web 版：无 BYOK 回退平台默认（行为不变）。"""
    from config import settings
    from services.ai.factory import ProviderFactory
    monkeypatch.setattr(settings, "openai_api_key", "BUNDLED_KEY", raising=False)

    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    key_desktop, _, _ = ProviderFactory.get_image_config_for_store(None)
    assert key_desktop == "BUNDLED_KEY"   # 盒子：内置 key 已注入 → 零配置直用

    monkeypatch.setattr(settings, "openai_api_key", "", raising=False)
    key_empty, _, _ = ProviderFactory.get_image_config_for_store(None)
    assert key_empty == ""                # 盒子：没内置 key → 空（不动平台 key、逼填 BYOK）

    monkeypatch.setattr(settings, "openai_api_key", "PLATFORM_KEY", raising=False)
    monkeypatch.delenv("DESKTOP_LOCAL", raising=False)
    key_web, _, _ = ProviderFactory.get_image_config_for_store(None)
    assert key_web == "PLATFORM_KEY"      # web：行为不变，回退平台默认
