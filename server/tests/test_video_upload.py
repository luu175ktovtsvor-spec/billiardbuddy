"""大视频上传（借 Kimi Code：>内联上限的视频先上传 provider 换 ms:// 文件引用，原生送、不抽帧）。

锁住：
- video_content_item：ms:// / http(s) 引用直通（不读盘）；is_video 认 ms://
- needs_video_upload / resolve_media_for_upload：只对【超上限本地视频】上传；图片/小视频/已是引用/无 uploader → 原样；上传失败 → 保留原路径走降级
- DeepSeekProvider.upload_video：仅 Moonshot/Kimi 端点走 files.create(purpose="video")→ms://<id>；其它端点/失败 → None
"""
import asyncio

from services.agent import multimodal as mm
from services.ai.providers.deepseek import DeepSeekProvider


def _make_video(path, nbytes=2048):
    path.write_bytes(b"\x00\x01\x02" * (nbytes // 3 + 1))
    return str(path)


# ──────────────── URL 引用直通 ────────────────

def test_video_content_item_url_ref_passthrough():
    assert mm.video_content_item("ms://file-abc") == {
        "type": "video_url", "video_url": {"url": "ms://file-abc"}}
    assert mm.is_video("ms://file-abc") is True


def test_stepfun_ref_passthrough():
    # 阶跃星辰 stepfile:// 引用同样直通、且被识别为视频
    assert mm.video_content_item("stepfile://file-step1") == {
        "type": "video_url", "video_url": {"url": "stepfile://file-step1"}}
    assert mm.is_video("stepfile://file-step1") is True


def test_build_user_content_routes_ms_ref():
    content = mm.build_user_content("看这段", ["ms://file-xyz"])
    assert any(c.get("type") == "video_url" and c["video_url"]["url"] == "ms://file-xyz" for c in content)


# ──────────────── needs_video_upload ────────────────

def test_needs_video_upload(tmp_path, monkeypatch):
    monkeypatch.setattr(mm, "_MAX_VIDEO_SRC_BYTES", 8)   # 内联上限调到 8 字节 → 真视频都算超
    big = _make_video(tmp_path / "big.mp4", nbytes=1024)
    assert mm.needs_video_upload([big]) is True
    assert mm.needs_video_upload(["/x/a.png"]) is False
    assert mm.needs_video_upload(["ms://file-abc"]) is False   # 已是引用 → 不需上传


def test_needs_video_upload_small_video_false(tmp_path):
    small = _make_video(tmp_path / "small.mp4", nbytes=2048)   # 2K < 20M 默认上限
    assert mm.needs_video_upload([small]) is False


def test_oversized_local_video_gives_note_not_silent_drop(tmp_path, monkeypatch):
    """MiMo 等不支持视频上传的端点上的超大本地视频：别静默丢，给模型一句说明让它转告老板。"""
    monkeypatch.setattr(mm, "_MAX_VIDEO_SRC_BYTES", 8)        # 内联上限调到 8 字节 → 真视频都算超
    big = _make_video(tmp_path / "huge.mp4", nbytes=1024)
    content = mm.build_user_content("看这个", [big])
    assert isinstance(content, list)
    texts = [c["text"] for c in content if c.get("type") == "text"]
    assert any("无法读取" in t and "huge.mp4" in t for t in texts)   # 给了说明
    assert not any(c.get("type") == "video_url" for c in content)    # 确实没塞进 video（读不了）


# ──────────────── resolve_media_for_upload ────────────────

def test_resolve_uploads_large_video(tmp_path, monkeypatch):
    monkeypatch.setattr(mm, "_MAX_VIDEO_SRC_BYTES", 8)
    big = _make_video(tmp_path / "big.mp4", nbytes=1024)

    async def _uploader(p):
        return "ms://uploaded-123"

    out = asyncio.run(mm.resolve_media_for_upload([big], _uploader))
    assert out == ["ms://uploaded-123"]


def test_resolve_keeps_path_when_upload_fails(tmp_path, monkeypatch):
    monkeypatch.setattr(mm, "_MAX_VIDEO_SRC_BYTES", 8)
    big = _make_video(tmp_path / "big.mp4", nbytes=1024)

    async def _uploader(p):   # 上传失败/不支持
        return None

    out = asyncio.run(mm.resolve_media_for_upload([big], _uploader))
    assert out == [big]       # 保留原路径（下游会跳过超限视频、走纯文字降级）


def test_resolve_leaves_image_and_small_video(tmp_path):
    img = "/x/a.png"
    small = _make_video(tmp_path / "small.mp4", nbytes=2048)

    async def _uploader(p):
        raise AssertionError("不该上传图片/小视频")

    out = asyncio.run(mm.resolve_media_for_upload([img, small], _uploader))
    assert out == [img, small]


def test_resolve_no_uploader(tmp_path, monkeypatch):
    monkeypatch.setattr(mm, "_MAX_VIDEO_SRC_BYTES", 8)
    big = _make_video(tmp_path / "big.mp4", nbytes=1024)
    out = asyncio.run(mm.resolve_media_for_upload([big], None))
    assert out == [big]       # 无 uploader → 原样


# ──────────────── DeepSeekProvider.upload_video ────────────────

class _FakeFiles:
    def __init__(self, fid):
        self._fid = fid
        self.calls = []

    async def create(self, file, purpose):
        self.calls.append({"file": file, "purpose": purpose})
        return type("O", (), {"id": self._fid})()


def test_upload_video_non_moonshot_returns_none(tmp_path):
    vid = _make_video(tmp_path / "v.mp4")
    p = DeepSeekProvider(api_key="k", base_url="https://api.xiaomimimo.com/v1")
    assert asyncio.run(p.upload_video(vid)) is None   # 非 Moonshot 端点 → None，不碰 client


def test_upload_video_moonshot_calls_files_create(tmp_path, monkeypatch):
    vid = _make_video(tmp_path / "v.mp4")
    p = DeepSeekProvider(api_key="k", base_url="https://api.moonshot.cn/v1")
    fake = type("C", (), {"files": _FakeFiles("file-xyz")})()
    monkeypatch.setattr(p, "_get_client", lambda: fake)
    ref = asyncio.run(p.upload_video(vid))
    assert ref == "ms://file-xyz"
    assert fake.files.calls and fake.files.calls[0]["purpose"] == "video"


def test_upload_video_stepfun(tmp_path, monkeypatch):
    # 阶跃星辰：purpose=storage → stepfile://<id>
    vid = _make_video(tmp_path / "v.mp4")
    p = DeepSeekProvider(api_key="k", base_url="https://api.stepfun.com/v1")
    fake = type("C", (), {"files": _FakeFiles("file-step1")})()
    monkeypatch.setattr(p, "_get_client", lambda: fake)
    ref = asyncio.run(p.upload_video(vid))
    assert ref == "stepfile://file-step1"
    assert fake.files.calls and fake.files.calls[0]["purpose"] == "storage"


def test_upload_video_failure_returns_none(tmp_path, monkeypatch):
    vid = _make_video(tmp_path / "v.mp4")
    p = DeepSeekProvider(api_key="k", base_url="https://api.moonshot.ai/v1")

    class _BoomFiles:
        async def create(self, file, purpose):
            raise RuntimeError("boom")

    monkeypatch.setattr(p, "_get_client", lambda: type("C", (), {"files": _BoomFiles()})())
    assert asyncio.run(p.upload_video(vid)) is None
