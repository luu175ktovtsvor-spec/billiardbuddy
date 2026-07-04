"""E4①⑤ 视频素材/成片质量体检测试(全 ffmpeg 确定性检查,零 token)。

真跑 ffmpeg(lavfi 合成几秒小样本,秒级,不依赖真人素材/不真跑几分钟渲染)验 blackdetect/
freezedetect/silencedetect 的解析 + 判废阈值;guarded_render 的重渲逻辑用 monkeypatch 纯逻辑验证
(不依赖真渲染耗时)。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from services.video_edit import footage_qc
from services.video_edit.ffbin import ffmpeg_bin


def _synth(path: Path, *, video: str, audio: str | None, dur: float = 3.0) -> None:
    """按 lavfi source 合成一段测试片(不依赖真人素材)。"""
    cmd = [ffmpeg_bin(), "-y", "-f", "lavfi", "-i", video]
    if audio:
        cmd += ["-f", "lavfi", "-i", audio]
    cmd += ["-pix_fmt", "yuv420p", "-c:v", "libx264", "-r", "15"]
    if audio:
        cmd += ["-c:a", "aac", "-shortest"]
    else:
        cmd += ["-an"]
    cmd += [str(path)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _black_silent_clip(path: Path, dur: float = 3.0) -> None:
    _synth(path, video=f"color=c=black:size=320x240:duration={dur}:rate=15",
           audio=f"anullsrc=r=48000:cl=stereo:d={dur}", dur=dur)


def _normal_clip(path: Path, dur: float = 3.0) -> None:
    _synth(path, video=f"testsrc=size=320x240:duration={dur}:rate=15",
           audio=f"sine=frequency=440:duration={dur}", dur=dur)


def _frozen_toned_clip(path: Path, dur: float = 3.0) -> None:
    """画面静止(纯色不变)但有声音——单独测"冻结"这一个信号,别跟"黑屏"混在一起。"""
    _synth(path, video=f"color=c=red:size=320x240:duration={dur}:rate=15",
           audio=f"sine=frequency=440:duration={dur}", dur=dur)


def _silent_only_clip(path: Path, dur: float = 3.0) -> None:
    """画面正常运动,但音频整段静音——单独测"静音"这一个信号。"""
    _synth(path, video=f"testsrc=size=320x240:duration={dur}:rate=15",
           audio=f"anullsrc=r=48000:cl=stereo:d={dur}", dur=dur)


def _concat(parts: list[Path], out: Path) -> None:
    lst = out.with_suffix(".txt")
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in parts))
    subprocess.run(
        [ffmpeg_bin(), "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
         "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an", str(out)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    lst.unlink(missing_ok=True)


# ── probe_footage_health:门① 素材入库前体检 ──

def test_footage_health_flags_mostly_black(tmp_path):
    p = tmp_path / "black.mp4"
    _black_silent_clip(p, dur=3.0)
    h = footage_qc.probe_footage_health(str(p))
    assert h["is_bad"] is True
    assert h["mostly_black"] is True
    assert h["black_ratio"] > 0.85
    assert any("黑屏" in r for r in h["reasons"])


def test_footage_health_flags_mostly_frozen(tmp_path):
    p = tmp_path / "frozen.mp4"
    _frozen_toned_clip(p, dur=3.0)
    h = footage_qc.probe_footage_health(str(p))
    assert h["is_bad"] is True
    assert h["mostly_frozen"] is True
    assert h["freeze_ratio"] > 0.85
    assert any("冻结" in r for r in h["reasons"])


def test_footage_health_normal_clip_is_ok(tmp_path):
    p = tmp_path / "normal.mp4"
    _normal_clip(p, dur=3.0)
    h = footage_qc.probe_footage_health(str(p))
    assert h["is_bad"] is False
    assert h["mostly_black"] is False
    assert h["mostly_frozen"] is False


def test_footage_health_silence_alone_does_not_mark_bad(tmp_path):
    """静音只报告不判废(氛围素材本就常年没有效人声,渲染时原声会整段被BGM顶替)。"""
    p = tmp_path / "silent.mp4"
    _silent_only_clip(p, dur=3.0)
    h = footage_qc.probe_footage_health(str(p))
    assert h["has_audio"] is True
    assert h["silence_ratio"] > 0.95
    assert h["mostly_silent"] is True
    assert h["is_bad"] is False                    # 关键:纯静音不判废
    assert any("没声音" in r for r in h["reasons"])  # 但仍透明报告


def test_footage_health_partial_black_below_threshold_not_bad(tmp_path):
    """只有一小段黑场(如转场/开场几帧),占比远低于阈值——不该被判废(别误杀正常素材)。"""
    black = tmp_path / "b.mp4"
    normal = tmp_path / "n.mp4"
    mixed = tmp_path / "mixed.mp4"
    _black_silent_clip(black, dur=0.3)
    _normal_clip(normal, dur=4.0)
    _concat([black, normal], mixed)
    h = footage_qc.probe_footage_health(str(mixed))
    assert h["black_ratio"] < 0.85
    assert h["is_bad"] is False


def test_silence_intervals_detects_fully_silent_clip(tmp_path):
    """E4③字幕门要复用这个函数判"字幕是否落在静音区间里"——这里先验证区间本身探测正确。"""
    p = tmp_path / "silent.mp4"
    _silent_only_clip(p, dur=3.0)
    intervals = footage_qc.silence_intervals(str(p))
    assert len(intervals) == 1
    s, e = intervals[0]
    assert s < 0.1                      # 从头就静音
    assert e > 2.8                      # 一路静到接近片尾(兜底补齐逻辑,同 probe_footage_health)


def test_silence_intervals_empty_for_normal_clip(tmp_path):
    p = tmp_path / "normal.mp4"
    _normal_clip(p, dur=3.0)
    assert footage_qc.silence_intervals(str(p)) == []


def test_silence_intervals_no_audio_stream_returns_empty(tmp_path):
    p = tmp_path / "noaudio.mp4"
    _synth(p, video="testsrc=size=320x240:duration=1.0:rate=15", audio=None, dur=1.0)
    assert footage_qc.silence_intervals(str(p)) == []


def test_silence_intervals_reuses_same_filter_as_footage_health(tmp_path):
    """区间总时长应该跟 probe_footage_health 算出来的 silence_ratio*duration 对得上——
    证明两者用的是同一套 silencedetect 探测(没有另起一套判定标准)。"""
    p = tmp_path / "silent.mp4"
    _silent_only_clip(p, dur=3.0)
    health = footage_qc.probe_footage_health(str(p))
    intervals = footage_qc.silence_intervals(str(p))
    total = sum(e - s for s, e in intervals)
    expected = health["silence_ratio"] * health["duration_s"]
    assert abs(total - expected) < 0.05


def test_footage_all_bad_message_none_when_one_ok(tmp_path):
    bad = {"is_bad": True, "reasons": ["大面积黑屏(占比92%)"]}
    ok = {"is_bad": False, "reasons": []}
    assert footage_qc.footage_all_bad_message({"a.mp4": bad, "b.mp4": ok}) is None


def test_footage_all_bad_message_when_all_bad():
    bad1 = {"is_bad": True, "reasons": ["大面积黑屏(占比92%)"]}
    bad2 = {"is_bad": True, "reasons": ["画面基本冻结(占比90%)"]}
    msg = footage_qc.footage_all_bad_message({"/x/a.mp4": bad1, "/x/b.mp4": bad2})
    assert msg is not None
    assert "a.mp4" in msg and "b.mp4" in msg
    assert "黑屏" in msg and "冻结" in msg


# ── probe_render_health:门⑤ 渲染后成片体检 ──

def test_render_health_flags_duration_mismatch(tmp_path):
    p = tmp_path / "normal.mp4"
    _normal_clip(p, dur=3.0)
    h = footage_qc.probe_render_health(str(p), expected_duration=10.0)
    assert h["duration_ok"] is False
    assert h["ok"] is False
    assert any("时长" in r for r in h["reasons"])


def test_render_health_ok_within_tolerance(tmp_path):
    p = tmp_path / "normal.mp4"
    _normal_clip(p, dur=3.0)
    h = footage_qc.probe_render_health(str(p), expected_duration=3.0)
    assert h["duration_ok"] is True
    assert h["ok"] is True
    assert h["reasons"] == []


def test_render_health_flags_black_and_silent(tmp_path):
    p = tmp_path / "black.mp4"
    _black_silent_clip(p, dur=3.0)
    h = footage_qc.probe_render_health(str(p), expected_duration=3.0)
    assert h["ok"] is False
    assert h["black_ratio"] > 0.03
    assert h["first_frame_black"] is True
    assert any("黑" in r for r in h["reasons"])
    assert any("没声音" in r for r in h["reasons"])


def test_render_health_first_frame_black_flags_even_if_ratio_low(tmp_path):
    """首帧纯黑(封面不可用)——哪怕整体黑屏占比很低,也要单独判红。"""
    black = tmp_path / "b.mp4"
    normal = tmp_path / "n.mp4"
    mixed = tmp_path / "mixed.mp4"
    _black_silent_clip(black, dur=0.2)
    _normal_clip(normal, dur=10.0)
    _concat([black, normal], mixed)
    h = footage_qc.probe_render_health(str(mixed), expected_duration=10.2)
    assert h["black_ratio"] < 0.03          # 整体占比不高,不该被"大段黑"判红
    assert h["first_frame_black"] is True
    assert h["ok"] is False
    assert any("首帧" in r for r in h["reasons"])


# ── guarded_render:红→重渲一次→仍红也不再重渲(纯逻辑,monkeypatch 隔离真渲染耗时) ──

def test_guarded_render_retries_once_then_recovers(monkeypatch):
    calls = {"render": 0}
    healths = [{"ok": False, "reasons": ["坏"]}, {"ok": True, "reasons": []}]

    def fake_render_fn():
        calls["render"] += 1
        return f"/tmp/out{calls['render']}.mp4"

    def fake_probe(path, **kw):
        return healths[calls["render"] - 1]

    monkeypatch.setattr(footage_qc, "probe_render_health", fake_probe)
    res = footage_qc.guarded_render(fake_render_fn, expected_duration=10.0)
    assert calls["render"] == 2
    assert res["rerendered"] is True
    assert res["health"]["ok"] is True
    assert res["path"] == "/tmp/out2.mp4"


def test_guarded_render_gives_up_after_one_retry(monkeypatch):
    calls = {"render": 0}

    def fake_render_fn():
        calls["render"] += 1
        return "/tmp/still-bad.mp4"

    def fake_probe(path, **kw):
        return {"ok": False, "reasons": ["还是坏"]}

    monkeypatch.setattr(footage_qc, "probe_render_health", fake_probe)
    res = footage_qc.guarded_render(fake_render_fn, expected_duration=10.0)
    assert calls["render"] == 2               # 只重渲一次,不无限重渲
    assert res["rerendered"] is True
    assert res["health"]["ok"] is False
    assert res["health"]["reasons"] == ["还是坏"]


def test_guarded_render_no_retry_when_healthy_first_try(monkeypatch):
    calls = {"render": 0}

    def fake_render_fn():
        calls["render"] += 1
        return "/tmp/good.mp4"

    def fake_probe(path, **kw):
        return {"ok": True, "reasons": []}

    monkeypatch.setattr(footage_qc, "probe_render_health", fake_probe)
    res = footage_qc.guarded_render(fake_render_fn, expected_duration=10.0)
    assert calls["render"] == 1
    assert res["rerendered"] is False
