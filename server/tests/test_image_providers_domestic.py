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


def test_validate_image_model():
    """生图 model↔供应商温和校验：属于该家=ok；不属于=温和提示；未知端点不拦。"""
    from services.ai.providers.image_catalog import validate_image_model
    # 模型属于硅基流动 → match
    r = validate_image_model("https://api.siliconflow.cn/v1", "Kwai-Kolors/Kolors")
    assert r["ok"] is True and r["level"] == "match"
    # 把通义万相的模型填到硅基流动 → mismatch + 温和提示
    r = validate_image_model("https://api.siliconflow.cn/v1", "wanx2.1-t2i-turbo")
    assert r["ok"] is False and r["level"] == "mismatch"
    assert "对不上" in r["message"] and r["provider"] == "硅基流动 SiliconFlow"
    # 自定义端点（不在目录里）→ 不认得很正常、不拦
    r = validate_image_model("https://my-own-endpoint.example.com/v1", "anything")
    assert r["ok"] is True and r["level"] == "unknown"
    # 空 model（还没填）→ 不拦
    assert validate_image_model("https://api.siliconflow.cn/v1", "")["ok"] is True


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
    assert "image" not in cap["body"]                 # 纯文生图：未传参考图
    assert "images/generations" in cap["url"]
    assert cap["auth"] == "Bearer sk-x"


def test_siliconflow_single_image_edit(monkeypatch):
    """单张参考图（Kolors 图生图）：走 body['image']，仍带 image_size。"""
    import httpx
    cap = {}

    def router(method, url, k):
        if method == "POST":
            cap["body"] = k.get("json")
            return _FakeResp(json_data={"images": [{"url": "http://img/sf.png"}]})
        return _FakeResp(content=b"SFDATA")

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.siliconflow_image import SiliconFlowImageProvider
    out = asyncio.run(SiliconFlowImageProvider("sk-x").generate_image(
        prompt="叠个 Logo", model="Kwai-Kolors/Kolors", size="1024*1024", image=b"\x89PNGLOGO"))
    assert out == b"SFDATA"
    assert cap["body"]["image"].startswith("data:image/png;base64,")  # 单张 → image
    assert "image2" not in cap["body"] and "image3" not in cap["body"]
    assert cap["body"]["image_size"] == "1024x1024"  # 非 Qwen-Image-Edit 仍带 image_size


def test_siliconflow_multi_image_qwen_edit(monkeypatch):
    """多张参考图（Qwen-Image-Edit-2509，最多 3 张）：分别落 image/image2/image3；该模型不带 image_size。
    钉死『多图不再只用第一张』这条行为，防回归。"""
    import httpx
    cap = {}

    def router(method, url, k):
        if method == "POST":
            cap["body"] = k.get("json")
            return _FakeResp(json_data={"images": [{"url": "http://img/sf.png"}]})
        return _FakeResp(content=b"SFDATA")

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.siliconflow_image import SiliconFlowImageProvider
    out = asyncio.run(SiliconFlowImageProvider("sk-x").generate_image(
        prompt="底图叠 Logo 和二维码", model="Qwen/Qwen-Image-Edit-2509", size="1024*1024",
        image=[b"\x89PNGbase", b"\x89PNGlogo", b"\x89PNGqr"]))
    assert out == b"SFDATA"
    body = cap["body"]
    # 三张参考图分别落 image / image2 / image3（不再丢弃第 2、3 张）
    assert body["image"].startswith("data:image/png;base64,")
    assert body["image2"].startswith("data:image/png;base64,")
    assert body["image3"].startswith("data:image/png;base64,")
    # 三张内容互不相同（确实各自带了，不是同一张复制）
    assert len({body["image"], body["image2"], body["image3"]}) == 3
    assert "image_size" not in body  # Qwen-Image-Edit-2509 不收 image_size


def test_siliconflow_multi_image_over_three_drops_extras(monkeypatch):
    """超过 3 张：只取前 3 张落 image/image2/image3，第 4 张起丢弃（不静默假装带上）。"""
    import httpx
    cap = {}

    def router(method, url, k):
        if method == "POST":
            cap["body"] = k.get("json")
            return _FakeResp(json_data={"images": [{"url": "http://img/sf.png"}]})
        return _FakeResp(content=b"SFDATA")

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.siliconflow_image import SiliconFlowImageProvider
    asyncio.run(SiliconFlowImageProvider("sk-x").generate_image(
        prompt="x", model="Qwen/Qwen-Image-Edit-2509",
        image=[b"\x89PNG1", b"\x89PNG2", b"\x89PNG3", b"\x89PNG4"]))
    body = cap["body"]
    assert "image" in body and "image2" in body and "image3" in body
    assert "image4" not in body  # 只支持 3 张，第 4 张不会进 body


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


def test_catalog_is_curated_with_edit_flags():
    """精选目录：硅基默认推荐、阶跃/百度已移除、每个 model 标 supports_edit、能叠图的家有可叠图模型。"""
    from services.ai.providers.image_catalog import IMAGE_PROVIDER_CATALOG
    base_urls = {p["base_url"] for p in IMAGE_PROVIDER_CATALOG}
    # 阶跃星辰 / 百度千帆已从主选移除
    assert "https://api.stepfun.com/v1" not in base_urls
    assert "https://qianfan.baidubce.com/v2" not in base_urls
    # 混元 / MiniMax 不进主选（保留为代码 TODO 注释，不在目录里）
    assert "https://api.minimaxi.com/v1" not in base_urls
    by_url = {p["base_url"]: p for p in IMAGE_PROVIDER_CATALOG}
    sf = by_url["https://api.siliconflow.cn/v1"]
    assert sf["recommended"] is True and sf["kind"] == "siliconflow"
    # 每个供应商每个 model 都标了 supports_edit（前后端据此提示能否叠 Logo/二维码）
    for p in IMAGE_PROVIDER_CATALOG:
        for m in p["models"]:
            assert "id" in m and "supports_edit" in m
    # 硅基 Qwen-Image-Edit-2509 / 火山 Seedream 能叠图
    sf_edit = {m["id"]: m["supports_edit"] for m in sf["models"]}
    assert sf_edit["Qwen/Qwen-Image-Edit-2509"] is True
    seedream = by_url["https://ark.cn-beijing.volces.com/api/v3"]
    assert any(m["supports_edit"] for m in seedream["models"])
    # 通义万相本 provider 不接参考图 → supports_edit=False
    wanx = by_url["https://dashscope.aliyuncs.com/api/v1"]
    assert all(m["supports_edit"] is False for m in wanx["models"])


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
