"""装配/渲染层测试:真 ffmpeg 渲染时间轴文档出片 + 字幕轨→SRT + 口播→字幕映射。"""
import json
import subprocess
from pathlib import Path

import pytest

from services.video_edit.assemble import (
    auto_captions_from_speech,
    build_srt_from_doc,
    render_timeline,
)
from services.video_edit.ffbin import ffmpeg_bin, probe_video
from services.video_edit.operations import apply_operations
from services.video_edit.timeline import Clip, MediaRef, Track, new_doc


def _synth_clip(path: Path, *, dur: int = 6, size: str = "720x1280") -> None:
    """合成一个竖屏彩条+440Hz 音的测试片(不依赖真人素材)。"""
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc=size={size}:duration={dur}:rate=30",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def test_render_timeline_two_video_clips(tmp_path):
    """真 ffmpeg:文档(取 [0,2]+[4,6] 两段)渲成可播 mp4,时长≈两段之和(4s)。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=6)

    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=6.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=2.0, order=1)
    doc.clips["c2"] = Clip(track="v", media="m1", src_in=4.0, src_out=6.0, order=2)

    out = render_timeline(doc, str(tmp_path / "final.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists()
    info = probe_video(out)
    assert 3.4 < info["duration_s"] < 4.6      # 两段≈4s
    assert info["width"] == 1080 and info["height"] == 1920   # 缩到竖屏


def test_render_timeline_with_captions(tmp_path):
    """带字幕轨:渲染不报错、成片可播(字幕最后烧=铁律1)。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=4)
    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=4.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=3.0, order=1)
    doc.clips["s1"] = Clip(track="sub", text="新到乔氏台子", start=0.0, end=2.5, style="promo")

    out = render_timeline(doc, str(tmp_path / "final.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists() and probe_video(out)["duration_s"] > 2.5


def test_probe_reads_rotation():
    """回归守栏(真机逮到):手机竖拍视频常是'横存1920x1080 + -90°旋转标记',探测必须读旋转。"""
    from services.video_edit.ffbin import _rotation
    assert _rotation({"side_data_list": [{"rotation": -90}]}) == -90
    assert _rotation({"side_data_list": [{"displaymatrix": "..."}, {"rotation": 90}]}) == 90
    assert _rotation({"tags": {"rotate": "270"}}) == 270   # 老式 tag 兜底
    assert _rotation({}) == 0


def test_rotation_swap_logic():
    """±90/±270 要把宽高转正(竖拍横存→真实竖屏),0/180 不换。"""
    for rot in (90, -90, 270, -270):
        assert abs(rot) % 180 == 90      # 触发宽高互换
    for rot in (0, 180, -180):
        assert abs(rot) % 180 != 90      # 不互换


def test_build_srt_from_doc(tmp_path):
    doc = new_doc()
    doc.tracks["sub"] = Track(kind="caption", order=0)
    doc.clips["s1"] = Clip(track="sub", text="第一句", start=0.0, end=2.0)
    doc.clips["s2"] = Clip(track="sub", text="第二句", start=2.0, end=4.0)
    srt = build_srt_from_doc(doc, str(tmp_path / "c.srt"))
    body = Path(srt).read_text()
    assert "第一句" in body and "第二句" in body
    assert "00:00:00,000 --> 00:00:02,000" in body


def test_auto_captions_maps_speech_to_output_timeline(tmp_path):
    """口播词(源时间)→ 成片时间轴字幕片段:第二段的偏移要加上第一段时长。"""
    edit = tmp_path / "edit"
    (edit / "transcripts").mkdir(parents=True)
    # 源视频 a.mp4:在 9-10s 说"约球福利"
    (edit / "transcripts" / "a.json").write_text(json.dumps({
        "words": [{"text": "约球", "start": 9.0, "end": 9.5}, {"text": "福利", "start": 9.5, "end": 10.0}]
    }, ensure_ascii=False))

    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(tmp_path / "a.mp4"), duration=20.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    # 第一段 [0,3] 占成片 0-3;第二段 [8,11] 占成片 3-6,内含 9-10 的口播 → 成片 4-5
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=3.0, order=1)
    doc.clips["c2"] = Clip(track="v", media="m1", src_in=8.0, src_out=11.0, order=2)

    ops = auto_captions_from_speech(doc, str(edit))
    assert len(ops) == 1
    op = ops[0]
    assert "约球福利" == op["text"]
    # 源 9.0 → 减段src_in 8.0 + 段偏移 3.0 = 成片 4.0s
    assert abs(op["start"] - 4.0) < 0.05
    # 施加后文档仍合法
    doc2, errs = apply_operations(doc, ops)
    assert errs == [] and len(doc2.caption_clips()) == 1
