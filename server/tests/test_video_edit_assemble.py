"""装配/渲染层测试:真 ffmpeg 渲染时间轴文档出片 + 字幕轨→SRT + 口播→字幕映射。"""
import json
import subprocess
from pathlib import Path

import pytest

from services.video_edit.assemble import (
    auto_captions_from_speech,
    build_srt_from_doc,
    inventory_footage,
    render_timeline,
    validate_captions_for_doc,
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


def _black_silent_clip(path: Path, *, dur: int = 3, size: str = "320x240") -> None:
    """合成一段全黑+全静音的废素材(E4①素材体检要能逮到这种)。"""
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"color=c=black:size={size}:duration={dur}:rate=15",
        "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _fake_transcribe_no_speech(video_path, edit_dir, **kw):
    return {"words": [], "has_speech": False, "language": "zh"}


def test_render_timeline_two_video_clips(tmp_path):
    """真 ffmpeg:文档(取 [0,2]+[4,6] 两段)渲成可播 mp4,时长≈两段之和(4s)。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=6)

    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=6.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=2.0, order=1)
    doc.clips["c2"] = Clip(track="v", media="m1", src_in=4.0, src_out=6.0, order=2)

    res = render_timeline(doc, str(tmp_path / "final.mp4"), edit_dir=str(tmp_path / "edit"))
    out = res["path"]
    assert Path(out).exists()
    assert res["rerendered"] is False           # 正常渲染不该触发重渲
    assert res["health"]["ok"] is True           # E4⑤渲染后体检:时长/黑段/静音/首帧全过
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

    res = render_timeline(doc, str(tmp_path / "final.mp4"), edit_dir=str(tmp_path / "edit"))
    out = res["path"]
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


def test_build_srt_from_doc_uses_override_cues_when_given(tmp_path):
    """render_timeline 门③校验后要用夹紧过的 cues 写 SRT,而不是重新从 doc 读原始(未夹紧)时间——
    通过一个可选 cues 参数覆盖默认读取路径,不改变默认行为(不传参照旧逻辑读 doc.caption_clips())。"""
    doc = new_doc()
    doc.tracks["sub"] = Track(kind="caption", order=0)
    doc.clips["s1"] = Clip(track="sub", text="原始文字", start=0.0, end=5.0)   # 会被 override 盖掉

    srt = build_srt_from_doc(doc, str(tmp_path / "c.srt"), cues=[(0.0, 1.5, "覆盖后的文字")])
    body = Path(srt).read_text()
    assert "覆盖后的文字" in body and "原始文字" not in body
    assert "00:00:00,000 --> 00:00:01,500" in body


def test_validate_captions_for_doc_flags_fast_rate(tmp_path):
    """字速超限只标记,不改字幕内容。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=3, size="320x240")
    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=3.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=3.0, order=1)
    # 10 个字挤 1 秒 = 10 字/秒,超过 5 字/秒上限
    doc.clips["s1"] = Clip(track="sub", text="一二三四五六七八九十", start=0.0, end=1.0)

    res = validate_captions_for_doc(doc)
    assert res["ok"] is False
    assert any("字速过快" in r for p in res["problems"] for r in p["reasons"])
    assert res["cues"][0][2] == "一二三四五六七八九十"    # 内容原样,没被拆/删


def test_validate_captions_for_doc_flags_silence_misalignment(tmp_path):
    """字幕落在源素材整段静音区间里(源没声,字幕却在)——复用 footage_qc.silence_intervals 判定。"""
    src = tmp_path / "silent_src.mp4"
    _black_silent_clip(src, dur=4)
    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=4.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=4.0, order=1)
    doc.clips["s1"] = Clip(track="sub", text="正常语速内容", start=1.0, end=3.0)   # 6字/2秒=3字/秒,字速没问题

    res = validate_captions_for_doc(doc)
    assert res["ok"] is False
    assert any("静音" in r for p in res["problems"] for r in p["reasons"])


def test_validate_captions_for_doc_clean_case_ok(tmp_path):
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=6, size="320x240")
    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=6.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=6.0, order=1)
    doc.clips["s1"] = Clip(track="sub", text="正常语速的一句话", start=0.0, end=3.0)   # 8字/3秒≈2.7字/秒

    res = validate_captions_for_doc(doc)
    assert res["ok"] is True
    assert res["problems"] == []


def test_render_timeline_reports_caption_health_and_clamps_overlap(tmp_path):
    """render_timeline 返回带 caption_health;重叠的字幕时间戳应被夹紧后写进最终 SRT。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=6, size="320x240")
    doc = new_doc()
    doc.media["m1"] = MediaRef(src=str(src), duration=6.0)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="v", media="m1", src_in=0.0, src_out=6.0, order=1)
    doc.clips["s1"] = Clip(track="sub", text="你好", start=0.0, end=3.0)
    doc.clips["s2"] = Clip(track="sub", text="再见", start=2.0, end=4.0)   # 跟 s1 重叠 1 秒

    res = render_timeline(doc, str(tmp_path / "final.mp4"), edit_dir=str(tmp_path / "edit"))
    assert "caption_health" in res
    ch = res["caption_health"]
    assert ch["ok"] is False
    assert any("重叠" in r for p in ch["problems"] for r in p["reasons"])

    srt_body = Path(tmp_path / "edit" / "captions.srt").read_text()
    assert "00:00:00,000 --> 00:00:02,000" in srt_body    # s1 结束时间被夹紧到 s2 的开始(2.0s)
    assert "你好" in srt_body and "再见" in srt_body        # 文字都还在,没被删


def test_inventory_footage_raises_when_all_footage_bad(tmp_path, monkeypatch):
    """E4①素材全废兜底:全部素材都黑屏,别硬剪、直接抛清楚的大白话错误。"""
    monkeypatch.setattr("services.video_edit.transcribe.transcribe", _fake_transcribe_no_speech)
    bad1 = tmp_path / "废素材1.mp4"
    bad2 = tmp_path / "废素材2.mp4"
    _black_silent_clip(bad1, dur=3)
    _black_silent_clip(bad2, dur=3)

    with pytest.raises(RuntimeError) as exc:
        inventory_footage([str(bad1), str(bad2)], str(tmp_path / "edit"))
    msg = str(exc.value)
    assert "废素材1.mp4" in msg and "废素材2.mp4" in msg
    assert "黑屏" in msg


def test_inventory_footage_marks_bad_footage_without_dropping_it(tmp_path, monkeypatch):
    """混了一段好一段废:不抛错(还有能用的),废的那段在候选里标记 health.is_bad + packed 文案有警示,
    但两段都还在候选池里(降权不硬删)。"""
    monkeypatch.setattr("services.video_edit.transcribe.transcribe", _fake_transcribe_no_speech)
    good = tmp_path / "good.mp4"
    bad = tmp_path / "bad.mp4"
    _synth_clip(good, dur=3, size="320x240")
    _black_silent_clip(bad, dur=3)

    res = inventory_footage([str(bad), str(good)], str(tmp_path / "edit"))
    assert len(res["candidates"]) == 2          # 两段都还在,没被剔除
    bad_cand, good_cand = res["candidates"]
    assert bad_cand["health"]["is_bad"] is True
    assert good_cand["health"]["is_bad"] is False
    assert "⚠️" in res["packed"] and "质量差" in res["packed"]
