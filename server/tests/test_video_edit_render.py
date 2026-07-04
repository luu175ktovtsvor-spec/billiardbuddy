"""render_edl 音频模式回归 + E4④新增 audio_mode="voice_over_music"(口播原声+BGM同时混音)。

keep/music/mute 三档原行为必须保持不变(additive,不改判断结构);loudnorm 从单遍近似升级成
两遍法(render.py 里的 _loudnorm),用真短样本(几秒)验证不炸、成片仍可播,ducking 混音链路
构造走 mock(别真跑长渲染),分派逻辑另有一个真机短样本兜底验证。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from services.video_edit import render
from services.video_edit.edl import Edl, EdlRange
from services.video_edit.ffbin import ffmpeg_bin, probe_video
from services.video_edit.footage_qc import _has_audio_stream


def _synth_clip(path: Path, *, dur: float = 4.0, freq: int = 440, size: str = "320x240") -> None:
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"testsrc=size={size}:duration={dur}:rate=15",
        "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _music_wav(path: Path, *, dur: float = 6.0, freq: int = 220) -> None:
    subprocess.run([
        ffmpeg_bin(), "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={dur}",
        "-acodec", "pcm_s16le", "-ar", "48000", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def test_lufs_target_upgraded_to_neg1_5():
    assert render._LUFS_TP == -1.5
    assert render._LUFS_I == -14.0


def test_render_edl_keep_mode_still_works_two_pass(tmp_path):
    """回归:默认 keep 模式(保留原声)升级到两遍法 loudnorm 后,行为不变(仍出可播成片)。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=4.0)
    edl = Edl(sources={"m1": str(src)}, ranges=[EdlRange(source="m1", start=0.0, end=3.0)],
              audio_mode="keep")
    out = render.render_edl(edl, str(tmp_path / "out.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists()
    info = probe_video(out)
    assert 2.5 < info["duration_s"] < 3.5
    assert _has_audio_stream(out) is True


def test_render_edl_music_mode_still_works(tmp_path):
    """回归:music 模式(替换成 BGM,原声丢弃)不受两遍法升级影响。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=4.0)
    music = tmp_path / "bgm.wav"
    _music_wav(music, dur=5.0)
    edl = Edl(sources={"m1": str(src)}, ranges=[EdlRange(source="m1", start=0.0, end=3.0)],
              audio_mode="music", music_file=str(music))
    out = render.render_edl(edl, str(tmp_path / "out.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists()
    assert _has_audio_stream(out) is True


def test_render_edl_mute_mode_still_works(tmp_path):
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=3.0)
    edl = Edl(sources={"m1": str(src)}, ranges=[EdlRange(source="m1", start=0.0, end=3.0)],
              audio_mode="mute")
    out = render.render_edl(edl, str(tmp_path / "out.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists()
    assert _has_audio_stream(out) is False


def test_render_edl_voice_over_music_mode_dispatches_to_mix_module(tmp_path, monkeypatch):
    """门④新档:audio_mode="voice_over_music" 应该调 mix.mix_voice_over_with_bgm,不是走 keep/music
    原来的任何一条分支(additive,不改旧分支判断结构)。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=3.0)
    music = tmp_path / "bgm.wav"
    _music_wav(music, dur=5.0)

    calls = []

    def fake_mix(video_path, music_path, out_path, **kw):
        calls.append((video_path, music_path, out_path))
        # 假装混好了:直接把 base copy 一份当"混音结果"(不用真跑 mix 内部逻辑,这里只验证分派)
        Path(out_path).parent.mkdir(parents=True, exist_ok=True)
        subprocess.run([ffmpeg_bin(), "-y", "-i", video_path, "-c", "copy", out_path],
                        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        return out_path

    monkeypatch.setattr(render.mix, "mix_voice_over_with_bgm", fake_mix)

    edl = Edl(sources={"m1": str(src)}, ranges=[EdlRange(source="m1", start=0.0, end=3.0)],
              audio_mode="voice_over_music", music_file=str(music))
    out = render.render_edl(edl, str(tmp_path / "out.mp4"), edit_dir=str(tmp_path / "edit"))

    assert len(calls) == 1
    assert calls[0][1] == str(music)
    assert Path(out).exists()


def test_render_edl_voice_over_music_mode_real_small_clip(tmp_path):
    """几秒真实小样本端到端跑通(不 mock):新档真的能出可播成片、真的有声音。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=3.0)
    music = tmp_path / "bgm.wav"
    _music_wav(music, dur=6.0)

    edl = Edl(sources={"m1": str(src)}, ranges=[EdlRange(source="m1", start=0.0, end=3.0)],
              audio_mode="voice_over_music", music_file=str(music))
    out = render.render_edl(edl, str(tmp_path / "out.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists()
    info = probe_video(out)
    assert 2.5 < info["duration_s"] < 3.5
    assert _has_audio_stream(out) is True


def test_render_edl_voice_over_music_without_music_file_falls_back_to_keep(tmp_path):
    """没给 music_file 却标了 voice_over_music——兜底当 keep 处理,别崩(跟 music 模式的兜底一个逻辑)。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=3.0)
    edl = Edl(sources={"m1": str(src)}, ranges=[EdlRange(source="m1", start=0.0, end=3.0)],
              audio_mode="voice_over_music", music_file=None)
    out = render.render_edl(edl, str(tmp_path / "out.mp4"), edit_dir=str(tmp_path / "edit"))
    assert Path(out).exists()
    assert _has_audio_stream(out) is True
