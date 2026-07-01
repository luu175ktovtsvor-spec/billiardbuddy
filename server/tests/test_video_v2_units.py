"""V2 视频新模块纯函数单测(不联网/不花钱)——补审查点 17"0 测试"缺口。

无 ARK key 时 caption_shots/plan_style/classify_content 走降级分支,正好可测其确定性行为。
"""
from __future__ import annotations

import wave

import pytest

from services.video_edit import bgm, billiards_video_kb
from services.video_edit.director import _fallback, caption_shots, plan_style
from services.video_edit.edit_agent import _domain_ctx, _pick_replacement
from services.video_edit.vlm import classify_content


def test_bgm_synth_writes_valid_wav(tmp_path):
    out = str(tmp_path / "b.wav")
    bgm.synth_beat_bgm(2.0, out, mood="hype", key=5)
    with wave.open(out) as w:
        assert w.getframerate() == bgm.SR
        assert w.getnframes() > 0


def test_beat_for_mood():
    assert bgm.beat_for_mood("chill") > bgm.beat_for_mood("hype")   # 慢拍长 > 快拍长
    assert bgm.beat_for_mood("不存在") == bgm.beat_for_mood("auto")   # 未知回退 auto


def test_bgm_key_out_of_range_ok(tmp_path):
    # key 会 %12,越界不崩
    bgm.synth_beat_bgm(0.5, str(tmp_path / "k.wav"), key=99)


def test_director_fallback_no_key():
    shots = [{"subject": "人物特写"}, {"subject": "未知"}]
    r = _fallback(shots, 2)
    assert len(r["captions"]) == 2 and r["brand"]


def test_caption_shots_no_key_uses_fallback(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_LLM_API_KEY", raising=False)
    monkeypatch.delenv("VLM_API_KEY", raising=False)
    r = caption_shots([{"subject": "美食"}, {"subject": "风景"}])
    assert len(r["captions"]) == 2


def test_plan_style_no_key_defaults(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_LLM_API_KEY", raising=False)
    monkeypatch.delenv("VLM_API_KEY", raising=False)
    r = plan_style([{"subject": "x"}, {"subject": "y"}])
    assert len(r["shots_style"]) == 2
    assert r["shots_style"][0]["transition"] == "none"     # 第一段不入场转场
    assert r["theme"]["accent"].startswith("#")
    assert r["music"]["mood"] in ("chill", "hype", "auto", "none")


def test_classify_content_no_key(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("VLM_API_KEY", raising=False)
    monkeypatch.delenv("ZHIPU_API_KEY", raising=False)
    r = classify_content(["/nonexistent.jpg"])
    assert r == {"is_billiards": False, "scene": "通用"}


def test_billiards_kb_guidance():
    for scene in ("门店环境", "助教展示", "人气氛围", "口播讲解"):
        assert "台球" in billiards_video_kb.caption_guidance(scene) or "球房" in billiards_video_kb.caption_guidance(scene)
        assert billiards_video_kb.style_guidance(scene)
        assert billiards_video_kb.music_hint(scene)["mood"] in ("chill", "hype", "auto", "none")
    # 无来源名铁律:不出现机构/来源名
    for scene in billiards_video_kb.scene_list():
        blob = billiards_video_kb.caption_guidance(scene) + billiards_video_kb.style_guidance(scene)
        assert "付能" not in blob and "学球" not in blob


def test_edit_agent_pick_replacement():
    plan = {"pool": [
        {"src": "/a.mp4", "start": 0.0, "end": 2.0, "score": 9, "usable": True},
        {"src": "/a.mp4", "start": 5.0, "end": 7.0, "score": 3, "usable": True},
    ]}
    used = {("/a.mp4", 0.0)}
    rep = _pick_replacement(plan, used)
    assert rep["start"] == 5.0                              # 已用的0.0排除,挑没用过的


def test_edit_agent_domain_ctx():
    assert _domain_ctx({"domain": "general"}, "caption") is None
    ctx = _domain_ctx({"domain": "billiards", "scene": "助教展示"}, "caption")
    assert ctx and ("助教" in ctx or "台球" in ctx)


@pytest.mark.parametrize("mood", ["chill", "hype", "auto"])
def test_bgm_all_moods(tmp_path, mood):
    bgm.synth_beat_bgm(1.0, str(tmp_path / f"{mood}.wav"), mood=mood)
