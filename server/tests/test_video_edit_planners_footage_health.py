"""E4①素材体检接入 ambient/speech 两条 Planner 的集成测试:

- 全废兜底:所有素材都判废(黑屏/冻结)→ 不硬剪,直接抛清楚的大白话错误。
- 降权不硬删:混了好/坏素材,不抛错;坏素材排到挑选队列/贪心排序的后面,只有好素材不够用时
  才会被当兜底选中——两条 Planner 的"现有挑选逻辑"(ambient 按分贪心 / speech 顺序取)本身不改。

不联网不花钱:全程删掉 VLM/LLM key,ambient 走确定性启发式打分,speech 用 monkeypatch 顶掉真 whisper。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from services.video_edit.ffbin import ffmpeg_bin
from services.video_edit.planners.ambient import plan_ambient
from services.video_edit.planners.speech import plan_speech

_KEY_ENVS = ("ARK_API_KEY", "VIDEO_LLM_API_KEY", "VLM_API_KEY", "ZHIPU_API_KEY")


@pytest.fixture(autouse=True)
def _no_llm_keys(monkeypatch):
    """全文件默认无 key:ambient 走确定性启发式打分分支,不联网不花钱。"""
    for env in _KEY_ENVS:
        monkeypatch.delenv(env, raising=False)


def _good_clip(path: Path, dur: float = 3.0) -> None:
    """画面运动+有声音的正常素材(带一点温和噪点,防止被误判冻结——参见 test_video_v2_orchestration.py 同款注释)。"""
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc=size=320x568:duration={dur}:rate=15",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _bad_clip(path: Path, dur: float = 3.0) -> None:
    """全黑+全静音的废素材。"""
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"color=c=black:size=320x568:duration={dur}:rate=15",
        "-f", "lavfi", "-i", f"anullsrc=r=48000:cl=stereo:d={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _fake_transcribe_factory(speech_by_stem: dict[str, list[dict]]):
    def fn(video_path, edit_dir, **kw):
        words = speech_by_stem.get(Path(video_path).stem, [])
        return {"words": words, "has_speech": bool(words), "language": "zh"}
    return fn


# ── ambient ──────────────────────────────────────────────────────────

def test_plan_ambient_raises_when_all_footage_bad(tmp_path):
    bad1 = tmp_path / "废素材1.mp4"
    bad2 = tmp_path / "废素材2.mp4"
    _bad_clip(bad1)
    _bad_clip(bad2)

    with pytest.raises(RuntimeError) as exc:
        plan_ambient([str(bad1), str(bad2)], str(tmp_path / "edit"), target_duration=4.0)
    msg = str(exc.value)
    assert "废素材1.mp4" in msg and "废素材2.mp4" in msg


def test_plan_ambient_prefers_good_footage_over_bad(tmp_path):
    """好/坏素材各出 1 个候选窗(3s clip @ win=2.5 → 恰好切一窗),启发式打分对两窗完全相同——
    唯一的差别来自素材体检降权。target_duration 只够用一个窗时,该选好的、别选废的。"""
    bad = tmp_path / "bad.mp4"
    good = tmp_path / "good.mp4"
    _bad_clip(bad)
    _good_clip(good)

    res = plan_ambient([str(bad), str(good)], str(tmp_path / "edit"), target_duration=2.0, win=2.5)
    picked = res["report"]["picked"]
    assert len(picked) == 1
    assert picked[0]["footage_ok"] is True                    # 选中的是好素材那一窗
    assert picked[0]["media"] == "m2"                          # good 是第二个传入的(m2)

    fh = res["report"]["footage_health"]
    assert fh["m1"]["is_bad"] is True and fh["m2"]["is_bad"] is False


def test_plan_ambient_falls_back_to_bad_footage_when_not_enough_good_material(tmp_path):
    """好素材不够用(只有 1 窗 2.5s),target_duration 要求更多 → 废素材兜底被选中(不是硬删)。"""
    bad = tmp_path / "bad.mp4"
    good = tmp_path / "good.mp4"
    _bad_clip(bad)
    _good_clip(good)

    res = plan_ambient([str(bad), str(good)], str(tmp_path / "edit"), target_duration=4.0, win=2.5)
    picked = res["report"]["picked"]
    footage_flags = {p["footage_ok"] for p in picked}
    assert footage_flags == {True, False}, "好素材不够用时,废素材应该被兜底选中(降权不等于硬删)"


# ── E5② 氛围线叙事分组接入 plan_ambient ──────────────────────────────────

def test_plan_ambient_reorders_merged_via_group_narrative(tmp_path, monkeypatch):
    """mock group_narrative 重排:report.picked 顺序 + narrative_role 应该反映新叙事顺序,
    不再是"纯原时序"(证明分组结果真的接进了 ambient 的落盘/落文档流程)。"""
    clips = [tmp_path / f"c{i}.mp4" for i in range(3)]
    for c in clips:
        _good_clip(c, dur=3.0)

    def fake_group_narrative(shots):
        n = len(shots)
        assert n == 3
        return {"order": [2, 0, 1], "roles": ["hook", "core", "end"]}

    monkeypatch.setattr("services.video_edit.director.group_narrative", fake_group_narrative)

    res = plan_ambient([str(c) for c in clips], str(tmp_path / "edit"), target_duration=10.0, win=2.5)
    picked = res["report"]["picked"]
    assert len(picked) == 3
    assert [p["media"] for p in picked] == ["m3", "m1", "m2"]           # 按 mock 的新顺序重排
    assert [p["narrative_role"] for p in picked] == ["hook", "core", "end"]


def test_plan_ambient_keeps_chronological_order_when_group_narrative_fails(tmp_path, monkeypatch):
    """group_narrative 失败(网关挂了/回复不合法)返回 None → merged 保持原时序,narrative_role 为 None,
    不能因为分组失败就让氛围线出不了片或顺序错乱(确定性兜底)。"""
    clips = [tmp_path / f"c{i}.mp4" for i in range(3)]
    for c in clips:
        _good_clip(c, dur=3.0)

    monkeypatch.setattr("services.video_edit.director.group_narrative", lambda shots: None)

    res = plan_ambient([str(c) for c in clips], str(tmp_path / "edit"), target_duration=10.0, win=2.5)
    picked = res["report"]["picked"]
    assert len(picked) == 3
    assert [p["media"] for p in picked] == ["m1", "m2", "m3"]           # 原时序不变
    assert all(p["narrative_role"] is None for p in picked)


# ── speech ───────────────────────────────────────────────────────────

def test_plan_speech_raises_when_all_footage_bad(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "services.video_edit.transcribe.transcribe",
        _fake_transcribe_factory({}),   # 无所谓有没有识别到话,体检门在转写前就该拦下
    )
    bad1 = tmp_path / "废素材A.mp4"
    bad2 = tmp_path / "废素材B.mp4"
    _bad_clip(bad1)
    _bad_clip(bad2)

    with pytest.raises(RuntimeError) as exc:
        plan_speech([str(bad1), str(bad2)], str(tmp_path / "edit"))
    msg = str(exc.value)
    assert "废素材A.mp4" in msg and "废素材B.mp4" in msg


def test_plan_speech_reorders_healthy_footage_first(tmp_path, monkeypatch):
    """坏素材排前面传入、好素材排后面传入——但"按顺序取够时长就停"这一挑选逻辑本身不改,
    只是处理顺序改成"健康的先处理":最终 quotes 里好素材的话应该排在坏素材前面。"""
    bad = tmp_path / "bad.mp4"
    good = tmp_path / "good.mp4"
    _bad_clip(bad, dur=3.0)
    _good_clip(good, dur=3.0)

    monkeypatch.setattr(
        "services.video_edit.transcribe.transcribe",
        _fake_transcribe_factory({
            "bad": [{"text": "废片说的话", "start": 0.5, "end": 1.0}],
            "good": [{"text": "好片说的话", "start": 0.5, "end": 1.0}],
        }),
    )

    res = plan_speech([str(bad), str(good)], str(tmp_path / "edit"), target_duration=30.0)
    quotes = res["report"]["quotes"]
    assert quotes == ["好片说的话", "废片说的话"]     # 健康素材的话排前面,即便它是后传入的

    fh = res["report"]["footage_health"]
    assert fh["m1"]["is_bad"] is True and fh["m2"]["is_bad"] is False   # m1=bad(先传入),m2=good

    # E4③字幕门:出方案阶段就把字幕体检结果透明暴露(跟 footage_health 同款,渲染前就能看到)
    assert "caption_health" in res["report"]
    assert "ok" in res["report"]["caption_health"]


def test_plan_speech_mixed_not_all_bad_does_not_raise(tmp_path, monkeypatch):
    """只要还有一个能用的,不该被"全废兜底"误伤。"""
    bad = tmp_path / "bad.mp4"
    good = tmp_path / "good.mp4"
    _bad_clip(bad)
    _good_clip(good)
    monkeypatch.setattr(
        "services.video_edit.transcribe.transcribe",
        _fake_transcribe_factory({"good": [{"text": "还能用", "start": 0.2, "end": 0.8}]}),
    )
    res = plan_speech([str(bad), str(good)], str(tmp_path / "edit"))
    assert res["report"]["quotes"] == ["还能用"]


# ── E5④ 口播+BGM 可达性接线:plan_speech(bgm=...) ────────────────────────

def test_plan_speech_bgm_false_default_keeps_pure_keep_behavior(tmp_path, monkeypatch):
    """默认(bgm=False)一字不变:doc 不该带 music,升级前后行为完全一致。"""
    good = tmp_path / "good.mp4"
    _good_clip(good, dur=3.0)
    monkeypatch.setattr(
        "services.video_edit.transcribe.transcribe",
        _fake_transcribe_factory({"good": [{"text": "你好世界", "start": 0.2, "end": 0.8}]}),
    )
    res = plan_speech([str(good)], str(tmp_path / "edit"), target_duration=10.0)
    assert res["doc"]["music"] is None
    assert "bgm" not in res["doc"]["media"]


def test_plan_speech_bgm_true_attaches_music_media(tmp_path, monkeypatch):
    """bgm=True → doc 应该挂上一条 audio 媒体 + doc.music 指向它(可达性接线的产出端)。"""
    good = tmp_path / "good.mp4"
    _good_clip(good, dur=3.0)
    monkeypatch.setattr(
        "services.video_edit.transcribe.transcribe",
        _fake_transcribe_factory({"good": [{"text": "你好世界", "start": 0.2, "end": 0.8}]}),
    )
    res = plan_speech([str(good)], str(tmp_path / "edit"), target_duration=10.0, bgm=True)
    assert res["doc"]["music"] == "bgm"
    assert "bgm" in res["doc"]["media"]
    assert res["doc"]["media"]["bgm"]["kind"] == "audio"
    from pathlib import Path as _P
    assert _P(res["doc"]["media"]["bgm"]["src"]).exists()   # 真合成了一条 wav,不是空引用
