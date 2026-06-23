"""多模态摄入增强（借 Kimi Code）：视频原生送 + 图片原始尺寸坐标接地 + degrade 扩到视频。

锁住：
- is_video / is_media 识别
- video_content_item：小视频 → video_url(data:video/...)；超大 → None（不抽帧，安全降级）
- build_user_content：图片附 <image original_size> 标签 + image_url；视频附 <video> + video_url；无媒体 → 原字符串
- vision_degrade：video_url 也算"带媒体"、去媒时一并拍平（非视频模型撞视频也能反应式降级）
"""
from services.agent import multimodal as mm
from services.agent import vision_degrade as vd


def _make_png(path, size=(40, 30)):
    from PIL import Image
    Image.new("RGB", size, (200, 30, 30)).save(path, format="PNG")
    return str(path)


def _make_video(path, nbytes=2048):
    path.write_bytes(b"\x00\x01\x02" * (nbytes // 3 + 1))
    return str(path)


# ──────────────── 识别 ────────────────

def test_is_video_and_is_media():
    assert mm.is_video("/x/a.mp4") is True
    assert mm.is_video("/x/a.mov") is True
    assert mm.is_video("/x/a.png") is False
    assert mm.is_media("/x/a.png") is True   # 图也是媒体
    assert mm.is_media("/x/a.mp4") is True   # 视频也是媒体
    assert mm.is_media("/x/a.txt") is False


# ──────────────── 视频原生送 ────────────────

def test_video_content_item_small(tmp_path):
    vid = _make_video(tmp_path / "clip.mp4")
    item = mm.video_content_item(vid)
    assert item is not None
    assert item["type"] == "video_url"
    assert item["video_url"]["url"].startswith("data:video/mp4;base64,")


def test_video_content_item_oversized_skips(tmp_path, monkeypatch):
    monkeypatch.setattr(mm, "_MAX_VIDEO_SRC_BYTES", 8)  # 把上限调到 8 字节 → 任何真视频都超
    vid = _make_video(tmp_path / "big.mp4", nbytes=1024)
    assert mm.video_content_item(vid) is None     # 超大 → None（不抛、不抽帧）


def test_video_content_item_missing_file():
    assert mm.video_content_item("/no/such/file.mp4") is None


# ──────────────── 图片坐标接地 ────────────────

def test_build_user_content_image_has_original_size_tag(tmp_path):
    png = _make_png(tmp_path / "p.png", size=(40, 30))
    content = mm.build_user_content("看这张图", [png])
    assert isinstance(content, list)
    texts = [c["text"] for c in content if c.get("type") == "text"]
    assert "看这张图" in texts                                  # 用户原文在
    assert any('<image' in t and 'original_size="40x30"' in t for t in texts)  # 带原始像素尺寸
    assert any(c.get("type") == "image_url" for c in content)   # 图本体在


def test_build_user_content_video(tmp_path):
    vid = _make_video(tmp_path / "v.mp4")
    content = mm.build_user_content("看这段录屏", [vid])
    assert isinstance(content, list)
    assert any(c.get("type") == "video_url" for c in content)
    texts = [c["text"] for c in content if c.get("type") == "text"]
    assert any("<video" in t for t in texts)


def test_build_user_content_mixed_image_and_video(tmp_path):
    png = _make_png(tmp_path / "p2.png")
    vid = _make_video(tmp_path / "v2.mp4")
    content = mm.build_user_content("一起看", [png, vid])
    assert any(c.get("type") == "image_url" for c in content)
    assert any(c.get("type") == "video_url" for c in content)


def test_build_user_content_no_media_returns_string():
    assert mm.build_user_content("纯文字", []) == "纯文字"
    assert mm.build_user_content("纯文字", ["/no/such.txt"]) == "纯文字"  # 非图非视频静默跳过


# ──────────────── degrade 扩到视频 ────────────────

def _vid_msgs():
    return [{"role": "user", "content": [
        {"type": "text", "text": "看这段视频是什么"},
        {"type": "video_url", "video_url": {"url": "data:video/mp4;base64,AAAA"}},
    ]}]


def test_messages_have_images_detects_video():
    assert vd.messages_have_images(_vid_msgs()) is True


def test_strip_flattens_video_to_text():
    msgs = _vid_msgs()
    changed = vd.strip_images_from_messages(msgs)
    assert changed is True
    assert msgs[0]["content"] == "看这段视频是什么"        # 留 text、去 video_url
    assert vd.strip_images_from_messages(msgs) is False    # 已无媒体 → 不再改


def test_looks_like_vision_error_on_video_keyword():
    e = ValueError("unknown variant 'video_url', expected 'text'")
    assert vd.looks_like_vision_error(e) is True
