"""AI 原子操作层测试:增删改时间轴文档 + 校验 + 失败原子回滚。

核心保证(Q3·deep-research):AI 只发原子操作,确定性代码施加;任一步非法/校验不过 → 整批回滚,文档不被改坏。
"""
from services.video_edit.timeline import Clip, MediaRef, TimelineDoc, Track, new_doc
from services.video_edit.operations import apply_operations


def _seed() -> TimelineDoc:
    doc = new_doc()
    doc.media["m1"] = MediaRef(src="/abs/a.mp4", duration=20.0)
    doc.tracks["tv"] = Track(kind="video", order=0)
    doc.tracks["tsub"] = Track(kind="caption", order=1)
    doc.clips["c1"] = Clip(track="tv", media="m1", src_in=2.0, src_out=5.0, order=1)
    return doc


def test_add_clip_appends_and_autoassigns_id():
    doc, errs = apply_operations(_seed(), [
        {"op": "add_clip", "track": "tv", "media": "m1", "src_in": 9.0, "src_out": 13.0},
    ])
    assert errs == []
    vids = doc.video_clips_ordered()
    assert len(vids) == 2
    # 新片段 order 自动接在最后
    assert vids[-1][1].src_in == 9.0


def test_remove_clip():
    doc, errs = apply_operations(_seed(), [{"op": "remove_clip", "id": "c1"}])
    assert errs == []
    assert "c1" not in doc.clips


def test_trim_clip_changes_source_range():
    doc, errs = apply_operations(_seed(), [
        {"op": "trim_clip", "id": "c1", "src_in": 3.0, "src_out": 4.5},
    ])
    assert errs == []
    assert doc.clips["c1"].src_in == 3.0 and doc.clips["c1"].src_out == 4.5


def test_reorder_clip():
    doc, _ = apply_operations(_seed(), [
        {"op": "add_clip", "id": "c2", "track": "tv", "media": "m1", "src_in": 9, "src_out": 12, "order": 2},
        {"op": "reorder_clip", "id": "c2", "order": 0},
    ])
    assert doc.video_clips_ordered()[0][0] == "c2"


def test_add_caption():
    doc, errs = apply_operations(_seed(), [
        {"op": "add_caption", "track": "tsub", "text": "新到乔氏台子", "start": 0.0, "end": 3.0, "style": "promo"},
    ])
    assert errs == []
    assert len(doc.caption_clips()) == 1


def test_set_music_and_grade():
    doc, errs = apply_operations(_seed(), [
        {"op": "add_media", "id": "bgm", "src": "/abs/bgm.mp3", "duration": 60, "kind": "audio"},
        {"op": "set_music", "media": "bgm"},
        {"op": "set_grade", "grade": "warm_cinematic"},
    ])
    assert errs == [] and doc.music == "bgm" and doc.grade == "warm_cinematic"


def test_invalid_trim_rolls_back_whole_batch():
    """trim 到超出源范围 → 校验不过 → 整批回滚,文档保持原样(c1 不变,新加的也不留)。"""
    seed = _seed()
    doc, errs = apply_operations(seed, [
        {"op": "add_clip", "track": "tv", "media": "m1", "src_in": 9, "src_out": 12},
        {"op": "trim_clip", "id": "c1", "src_out": 999.0},  # 超 20s
    ])
    assert errs != []
    # 回滚:c1 区间没变、没多出新片段
    assert doc.clips["c1"].src_out == 5.0
    assert len(doc.video_clips_ordered()) == 1


def test_unknown_op_errors_and_rolls_back():
    doc, errs = apply_operations(_seed(), [{"op": "explode_everything"}])
    assert errs != []
    assert "c1" in doc.clips  # 没被动


def test_op_on_missing_target_errors():
    doc, errs = apply_operations(_seed(), [{"op": "remove_clip", "id": "ghost"}])
    assert errs != []
    assert "c1" in doc.clips


def test_original_doc_not_mutated_on_success():
    """施加成功也只改副本——原文档对象不被原地改(前端/审批要拿旧版对比)。"""
    seed = _seed()
    apply_operations(seed, [{"op": "remove_clip", "id": "c1"}])
    assert "c1" in seed.clips  # 原对象未变
