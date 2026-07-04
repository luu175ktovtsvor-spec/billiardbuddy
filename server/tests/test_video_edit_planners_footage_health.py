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
