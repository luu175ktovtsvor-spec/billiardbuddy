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
