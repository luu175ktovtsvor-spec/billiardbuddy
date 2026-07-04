"""E4③ 字幕门:字速/静音错位/时间戳重叠 三条确定性规则校验(纯 python,零 ffmpeg,零 token)。"""
from __future__ import annotations

from services.video_edit import subtitle_qc


def test_normal_cues_pass_clean():
    cues = [(0.0, 2.0, "你好世界"), (2.0, 4.0, "欢迎光临")]
    res = subtitle_qc.validate_cues(cues)
    assert res["ok"] is True
    assert res["problems"] == []
    assert res["cues"] == [(0.0, 2.0, "你好世界"), (2.0, 4.0, "欢迎光临")]


def test_flags_rate_too_fast_without_changing_text():
    # 10 个字挤在 1 秒里 = 10 字/秒,远超 5 字/秒
    cues = [(0.0, 1.0, "一二三四五六七八九十")]
    res = subtitle_qc.validate_cues(cues)
    assert res["ok"] is False
    assert len(res["problems"]) == 1
    p = res["problems"][0]
    assert "字速过快" in p["reasons"][0]
    # 铁律:标红不自动改内容,文字必须原样
    assert res["cues"][0][2] == "一二三四五六七八九十"
    assert res["cues"][0][1] - res["cues"][0][0] == 1.0    # 时长也没被拆动


def test_rate_within_limit_not_flagged():
    # 5 个字 / 1 秒 = 5 字/秒,刚好等于上限,不该标红
    cues = [(0.0, 1.0, "一二三四五")]
    res = subtitle_qc.validate_cues(cues)
    assert res["ok"] is True


def test_flags_cue_fully_inside_silence():
    cues = [(1.0, 2.0, "这句没声音却有字幕")]
    silence = [(0.5, 3.0)]   # cue [1,2] 整段落在静音 [0.5,3.0] 里
    res = subtitle_qc.validate_cues(cues, silence_intervals=silence)
    assert res["ok"] is False
    assert any("静音" in r for r in res["problems"][0]["reasons"])


def test_partial_overlap_with_silence_not_flagged():
    """只是"搭边"(部分重叠,不是整段落在静音里)——正常的收尾,不该误杀。"""
    cues = [(0.0, 2.0, "正常说话中")]
    silence = [(1.8, 5.0)]   # 只有末尾 0.2s 搭边,不是整段
    res = subtitle_qc.validate_cues(cues, silence_intervals=silence)
    assert res["ok"] is True


def test_no_silence_intervals_skips_that_rule():
    cues = [(0.0, 2.0, "没有静音信息可比对")]
    res = subtitle_qc.validate_cues(cues, silence_intervals=None)
    assert res["ok"] is True
    res2 = subtitle_qc.validate_cues(cues, silence_intervals=[])
    assert res2["ok"] is True


def test_overlapping_timestamps_get_clamped_and_flagged():
    # 第一条 [0,3] 跟第二条 [2,4] 重叠 1 秒
    cues = [(0.0, 3.0, "第一句"), (2.0, 4.0, "第二句")]
    res = subtitle_qc.validate_cues(cues)
    assert res["ok"] is False
    a, b, t = res["cues"][0]
    assert t == "第一句"                 # 文字没变
    assert b == 2.0                      # 结束时间被夹紧到下一条的开始
    assert res["cues"][1] == (2.0, 4.0, "第二句")
    reasons = res["problems"][0]["reasons"]
    assert any("重叠" in r and "夹紧" in r for r in reasons)


def test_out_of_order_input_gets_sorted_before_clamping():
    # 传入乱序,函数内部应先按 start 排序再处理
    cues = [(5.0, 7.0, "后说的"), (0.0, 2.0, "先说的")]
    res = subtitle_qc.validate_cues(cues)
    assert res["ok"] is True
    assert res["cues"] == [(0.0, 2.0, "先说的"), (5.0, 7.0, "后说的")]


def test_duplicate_start_overlap_does_not_go_negative_length():
    # 极端情况:两条 start 完全相同,夹紧不能夹出负/零长度
    cues = [(0.0, 5.0, "重复起点甲"), (0.0, 2.0, "重复起点乙")]
    res = subtitle_qc.validate_cues(cues)
    a0, b0, _ = res["cues"][0]
    assert b0 > a0   # 夹紧后仍是正长度

def test_combined_problems_reported_per_cue_with_index():
    cues = [(0.0, 1.0, "一二三四五六七八九十"), (0.5, 2.0, "正常一句话内容")]
    res = subtitle_qc.validate_cues(cues)
    assert res["ok"] is False
    assert len(res["problems"]) >= 1
    first = res["problems"][0]
    assert first["index"] == 0
    assert "字速过快" in "".join(first["reasons"])
