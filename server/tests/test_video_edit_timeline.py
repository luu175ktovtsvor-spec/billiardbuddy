"""时间轴文档(编排层)数据模型 + 校验 测试。

验证:稳定ID映射、轨道分类型、片段 source_range、校验挡非法状态、视频顺序排布与时长、to_edl 渲染桥。
"""
import pytest

from services.video_edit.timeline import (
    Clip,
    MediaRef,
    TimelineDoc,
    Track,
    new_doc,
)


def _doc_two_video_clips() -> TimelineDoc:
    doc = new_doc()
    doc.media["m1"] = MediaRef(src="/abs/a.mp4", duration=14.8)
    doc.tracks["tv"] = Track(kind="video", order=0)
    doc.tracks["tsub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="tv", media="m1", src_in=2.0, src_out=5.0, order=1)
    doc.clips["c2"] = Clip(track="tv", media="m1", src_in=9.0, src_out=13.0, order=2)
    doc.clips["s1"] = Clip(track="tsub", text="新到乔氏台子", start=0.0, end=3.0, style="promo")
    return doc


def test_doc_uses_stable_id_maps():
    """片段/轨道/媒体都是 dict(稳定ID),不是数组——防 AI 改下标错位。"""
    doc = _doc_two_video_clips()
    assert isinstance(doc.clips, dict)
    assert isinstance(doc.tracks, dict)
    assert isinstance(doc.media, dict)
    assert set(doc.clips) == {"c1", "c2", "s1"}


def test_validate_passes_for_good_doc():
    assert _doc_two_video_clips().validate_doc() == []


def test_validate_catches_clip_pointing_to_missing_track():
    doc = _doc_two_video_clips()
    doc.clips["bad"] = Clip(track="nope", media="m1", src_in=0, src_out=1, order=3)
    errs = doc.validate_doc()
    assert any("nope" in e for e in errs)


def test_validate_catches_clip_pointing_to_missing_media():
    doc = _doc_two_video_clips()
    doc.clips["bad"] = Clip(track="tv", media="ghost", src_in=0, src_out=1, order=3)
    errs = doc.validate_doc()
    assert any("ghost" in e for e in errs)


def test_validate_catches_out_of_range_source():
    doc = _doc_two_video_clips()
    doc.clips["c1"].src_out = 99.0  # 超出源素材 14.8s
    errs = doc.validate_doc()
    assert any("c1" in e for e in errs)


def test_validate_catches_inverted_range():
    doc = _doc_two_video_clips()
    doc.clips["c1"].src_in, doc.clips["c1"].src_out = 5.0, 2.0
    assert doc.validate_doc() != []


def test_video_clips_ordered_by_order_field():
    doc = _doc_two_video_clips()
    doc.clips["c0"] = Clip(track="tv", media="m1", src_in=0, src_out=1, order=0)
    ordered = [cid for cid, _ in doc.video_clips_ordered()]
    assert ordered == ["c0", "c1", "c2"]  # 按 order,不按插入序


def test_duration_is_sum_of_video_clip_lengths():
    doc = _doc_two_video_clips()
    # (5-2) + (13-9) = 7
    assert abs(doc.duration() - 7.0) < 1e-6


def test_to_edl_bridges_to_renderer():
    """时间轴文档 → 既有 Edl(给 render_edl 消费)。视频轨成 ranges、尺寸带过去。"""
    doc = _doc_two_video_clips()
    edl = doc.to_edl()
    assert len(edl.ranges) == 2
    assert edl.ranges[0].start == 2.0 and edl.ranges[0].end == 5.0
    assert edl.sources["m1"] == "/abs/a.mp4"
    assert edl.target_w == 1080 and edl.target_h == 1920


def test_roundtrip_json_serialization():
    """文档能序列化成 JSON 再读回(前端/落盘真相源要可序列化)。"""
    doc = _doc_two_video_clips()
    data = doc.model_dump_json()
    back = TimelineDoc.model_validate_json(data)
    assert back.clips["c1"].src_in == 2.0
    assert back.validate_doc() == []
