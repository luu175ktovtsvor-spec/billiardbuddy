"""火山方舟 Seedance 文生视频/图生视频 Provider + video_service 首帧图沙箱解析。

用 mock httpx 钉住提交/轮询形态与响应解析，不连网、不烧钱。真机出片需老板自己的 ARK key 在盒子上验。
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


def test_ark_video_submit_poll_text2video(monkeypatch):
    """文生视频：提交拿 id → 轮询 succeeded → 取 content.video_url；提交 body 形态正确。"""
    import httpx
    seen = {}

    def router(method, url, k):
        if method == "POST":
            seen["submit_body"] = k.get("json")
            seen["submit_headers"] = k.get("headers")
            seen["submit_url"] = url
            return _FakeResp(json_data={"id": "cgt-1"})
        # 轮询：首次即成功（不触发 sleep）
        seen["poll_url"] = url
        return _FakeResp(json_data={"status": "succeeded", "content": {"video_url": "http://v/out.mp4"}})

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    out = asyncio.run(ArkVideoProvider("ark-x").generate_video(
        prompt="台球房开业宣传，镜头缓缓推进", model="doubao-seedance-1-5-pro-251215",
        ratio="9:16", resolution="720p", duration=5))
    assert out == "http://v/out.mp4"
    b = seen["submit_body"]
    assert b["model"] == "doubao-seedance-1-5-pro-251215"
    assert b["ratio"] == "9:16" and b["resolution"] == "720p" and b["duration"] == 5  # 独立字段，非 prompt 后缀
    assert b["content"][0] == {"type": "text", "text": "台球房开业宣传，镜头缓缓推进"}
    assert len(b["content"]) == 1                               # 纯文生视频：无首帧图
    assert seen["submit_headers"].get("Authorization") == "Bearer ark-x"
    assert seen["submit_url"].endswith("/contents/generations/tasks")
    assert "/contents/generations/tasks/cgt-1" in seen["poll_url"]


def test_ark_video_image2video_first_frame(monkeypatch):
    """图生视频：first_frame_url 进 content[1]，role=first_frame。"""
    import httpx

    def router(method, url, k):
        if method == "POST":
            router.body = k.get("json")
            return _FakeResp(json_data={"id": "cgt-2"})
        return _FakeResp(json_data={"status": "succeeded", "content": {"video_url": "http://v/i2v.mp4"}})

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    out = asyncio.run(ArkVideoProvider("ark-x").generate_video(
        prompt="让海报动起来", model="m", first_frame_url="https://img/x.jpg"))
    assert out == "http://v/i2v.mp4"
    c = router.body["content"]
    assert len(c) == 2
    assert c[1]["type"] == "image_url" and c[1]["image_url"]["url"] == "https://img/x.jpg"
    assert c[1]["role"] == "first_frame"


def test_ark_video_audio_lastframe_and_refs(monkeypatch):
    """阶段4:音画同生 + 首尾帧 + 多图参考(锁人物)都进 body/content。"""
    import httpx

    def router(method, url, k):
        if method == "POST":
            router.body = k.get("json")
            return _FakeResp(json_data={"id": "cgt-multi"})
        return _FakeResp(json_data={"status": "succeeded", "content": {"video_url": "http://v/m.mp4"}})

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    out = asyncio.run(ArkVideoProvider("ark-x").generate_video(
        prompt="助教出镜，主体不变", model="m",
        first_frame_url="https://img/first.jpg", last_frame_url="https://img/last.jpg",
        image_refs=[{"url": "https://img/p1.jpg", "role": "reference"}, {"url": "https://img/p2.jpg"}],
        generate_audio=True))
    assert out == "http://v/m.mp4"
    b = router.body
    assert b["generate_audio"] is True
    imgs = [x for x in b["content"] if x["type"] == "image_url"]
    roles = [x.get("role") for x in imgs]
    assert "first_frame" in roles and "last_frame" in roles
    assert roles.count("reference") == 2                       # 两张参考图都进了(无 role 默认 reference)
    urls = [x["image_url"]["url"] for x in imgs]
    assert "https://img/p1.jpg" in urls and "https://img/p2.jpg" in urls


def test_ark_video_failed_task_raises(monkeypatch):
    import httpx

    def router(method, url, k):
        if method == "POST":
            return _FakeResp(json_data={"id": "cgt-3"})
        return _FakeResp(json_data={"status": "failed", "error": {"message": "敏感内容"}})

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    with pytest.raises(RuntimeError):
        asyncio.run(ArkVideoProvider("ark-x").generate_video(prompt="x", model="m"))


def test_resolve_first_frame_http_passthrough():
    from services import video_service
    assert video_service._resolve_first_frame("https://img/a.jpg") == "https://img/a.jpg"
    assert video_service._resolve_first_frame(None) is None
    assert video_service._resolve_first_frame("  ") is None


def test_resolve_first_frame_uploads_to_datauri(monkeypatch, tmp_path):
    """uploads 沙箱内的本机图 → 转 base64 data-uri（火山方舟拉不到本机 url，必须内联）。"""
    from services import video_service
    monkeypatch.setattr(video_service, "UPLOADS_DIR", tmp_path)
    (tmp_path / "posters").mkdir()
    f = tmp_path / "posters" / "p.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\nFAKE")
    out = video_service._resolve_first_frame("/uploads/posters/p.png")
    assert out.startswith("data:image/png;base64,")


def test_resolve_first_frame_blocks_outside_sandbox(monkeypatch, tmp_path):
    """挡住"借首帧把任意本地文件 base64 后塞给外部 API"：沙箱外、又不在老板选定清单里 → 报错。"""
    from services import video_service
    from core.exceptions import AIServiceError
    monkeypatch.setattr(video_service, "UPLOADS_DIR", tmp_path)
    outside = tmp_path.parent / "secret.txt"
    outside.write_bytes(b"secret")
    with pytest.raises(AIServiceError):
        video_service._resolve_first_frame(str(outside))
    # 但若老板当场显式选定了它（allow_paths）→ 放行
    out = video_service._resolve_first_frame(str(outside), allow_paths={str(outside)})
    assert out.startswith("data:")


# ---- #1 bypass_proxy_for：国内 volces.com 端点绕开系统代理直连 ----

def test_ark_video_bypass_proxy_for_volces():
    """volces.com（火山方舟）命中国内域名列表 → bypass=True → trust_env=False。"""
    from services.ai.providers._net import bypass_proxy_for
    assert bypass_proxy_for("https://ark.cn-beijing.volces.com/api/v3") is True

def test_ark_video_bypass_proxy_for_foreign():
    """非国内端点 → 走代理。"""
    from services.ai.providers._net import bypass_proxy_for
    assert bypass_proxy_for("https://api.openai.com/v1") is False

def test_ark_video_httpx_gets_trust_env_false(monkeypatch):
    """提交/轮询创建的 httpx.AsyncClient 传 trust_env=False（国内端点时）。"""
    import httpx
    captured = []
    _OrigAC = httpx.AsyncClient

    class _SpyAC:
        def __init__(self, *a, **k):
            captured.append(k)
        async def __aenter__(self):
            return self
        async def __aexit__(self, *a):
            return False
        async def post(self, url, **k):
            return _FakeResp(json_data={"id": "spy-1"})
        async def get(self, url, **k):
            return _FakeResp(json_data={"status": "succeeded", "content": {"video_url": "http://v/s.mp4"}})

    monkeypatch.setattr(httpx, "AsyncClient", _SpyAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    asyncio.run(ArkVideoProvider("k", "https://ark.cn-beijing.volces.com/api/v3").generate_video(prompt="x", model="m"))
    assert len(captured) >= 2
    for kw in captured:
        assert kw.get("trust_env") is False, f"国内端点应 trust_env=False, got {kw}"


# ---- #2 早查 key：未配 ARK key 时审批前就友好提示 ----

def test_generate_video_early_key_check_no_key(monkeypatch):
    """未配 ARK key → generate_video 工具直接返回友好提示，不走到审批/轮询。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "services.ai.factory.ProviderFactory.get_video_config_for_store",
        classmethod(lambda cls, store: ("", "https://ark.cn-beijing.volces.com/api/v3", None)),
    )
    from services.agent.tools import generate_video
    ctx = SimpleNamespace(
        store=SimpleNamespace(id="s1"),
        user=SimpleNamespace(id="u1"),
        db=None, allowed_paths=[], _video_generated_this_run=False,
    )
    result = asyncio.run(generate_video({"description": "测试视频"}, ctx))
    assert "配" in result and ("Key" in result or "key" in result.lower())


def test_generate_video_early_key_check_has_key(monkeypatch):
    """已配 ARK key → generate_video 不因 key 检查挡住（会继续走到 video_service 调用）。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "services.ai.factory.ProviderFactory.get_video_config_for_store",
        classmethod(lambda cls, store: ("ark-real-key", "https://ark.cn-beijing.volces.com/api/v3", "m")),
    )

    async def _fake_gen(**kw):
        return {"video_url": "/uploads/videos/fake.mp4", "generation_id": "g1", "conversation_id": "c1"}

    monkeypatch.setattr("services.video_service.generate_video", _fake_gen)
    from services.agent.tools import generate_video
    ctx = SimpleNamespace(
        store=SimpleNamespace(id="s1"),
        user=SimpleNamespace(id="u1"),
        db=None, allowed_paths=[], _video_generated_this_run=False,
    )
    result = asyncio.run(generate_video({"description": "台球开业视频"}, ctx))
    assert "fake.mp4" in result or "做好" in result


# ---- #3 content list 健壮：API 返 content 为 list 时不 AttributeError ----

def test_ark_video_content_as_list(monkeypatch):
    """轮询返回 content=[{video_url:...}]（list 而非 dict）→ 正确取到 url。"""
    import httpx

    def router(method, url, k):
        if method == "POST":
            return _FakeResp(json_data={"id": "cgt-list"})
        return _FakeResp(json_data={
            "status": "succeeded",
            "content": [{"video_url": "http://v/list.mp4"}],
        })

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    out = asyncio.run(ArkVideoProvider("ark-x").generate_video(prompt="x", model="m"))
    assert out == "http://v/list.mp4"


def test_ark_video_content_as_empty_list_fallback(monkeypatch):
    """content=[] → 回退到顶层 video_url。"""
    import httpx

    def router(method, url, k):
        if method == "POST":
            return _FakeResp(json_data={"id": "cgt-el"})
        return _FakeResp(json_data={
            "status": "succeeded",
            "content": [],
            "video_url": "http://v/top.mp4",
        })

    _FakeAC.router = staticmethod(router)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAC)
    from services.ai.providers.ark_video import ArkVideoProvider
    out = asyncio.run(ArkVideoProvider("ark-x").generate_video(prompt="x", model="m"))
    assert out == "http://v/top.mp4"
