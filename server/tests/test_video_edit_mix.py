"""E4④ 混音门:两遍法 loudnorm + ducking + 口播原声/BGM 同时混音(server/services/video_edit/mix.py)。

两遍法/纯音频处理用真 ffmpeg 跑(tmp_path 里几秒 lavfi 合成源,秒级,不依赖真素材);
"口播+BGM 混音"的 ducking 链构造用 mock 断言(别真跑分钟级渲染,构造正确性靠断言 filter_complex
字符串 + loudnorm_two_pass 调用参数),另加一个几秒钟量级的真实小样本端到端跑通做兜底(真验证
sidechaincompress/amix 语法没写错,纯 mock 测不出 ffmpeg 语法错误)。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from services.video_edit import mix
from services.video_edit.ffbin import ffmpeg_bin, probe_video
from services.video_edit.footage_qc import _has_audio_stream


def _tone_wav(path: Path, *, freq: int = 440, dur: float = 2.0) -> None:
    subprocess.run(
        [ffmpeg_bin(), "-y", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={dur}",
         "-acodec", "pcm_s16le", "-ar", "48000", str(path)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )


def _tone_video(path: Path, *, freq: int = 440, dur: float = 3.0, size: str = "320x240") -> None:
    subprocess.run(
        [ffmpeg_bin(), "-y", "-f", "lavfi", "-i", f"testsrc=size={size}:duration={dur}:rate=15",
         "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={dur}",
         "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )


# ── 常量:抖音/视频号通行标准(比原来的单遍近似 TP=-1 更保守) ──

def test_target_constants_are_dou_yin_standard():
    assert mix.TARGET_I == -14.0
    assert mix.TARGET_TP == -1.5
    assert mix.TARGET_LRA == 11.0


# ── measure_loudness:两遍法第一遍(真 ffmpeg,验证 JSON 解析对) ──

def test_measure_loudness_parses_json_fields(tmp_path):
    wav = tmp_path / "tone.wav"
    _tone_wav(wav, dur=2.0)
    m = mix.measure_loudness(str(wav))
    assert set(("input_i", "input_tp", "input_lra", "input_thresh")) <= set(m.keys())
    assert float(m["input_i"]) < 0    # LUFS 都是负数


def test_measure_loudness_raises_clear_error_on_bad_input(tmp_path):
    with pytest.raises(Exception):
        mix.measure_loudness(str(tmp_path / "not-a-real-file.wav"))


# ── loudnorm_two_pass:两遍法第二遍(真 ffmpeg,验证真的把响度校到目标附近) ──

def test_loudnorm_two_pass_audio_only_hits_target(tmp_path):
    wav = tmp_path / "tone.wav"
    _tone_wav(wav, dur=2.0)
    out = tmp_path / "normed.m4a"
    mix.loudnorm_two_pass(wav, out, copy_video=False)
    assert out.exists()
    remeasured = mix.measure_loudness(str(out))
    # 两遍法应该比单遍近似准得多:落在目标 -14 LUFS 附近(±1LUFS 容差,纯音正弦波应该很准)
    assert abs(float(remeasured["input_i"]) - mix.TARGET_I) < 1.0


def test_loudnorm_two_pass_preserves_video_stream_when_copy_video(tmp_path):
    src = tmp_path / "clip.mp4"
    _tone_video(src, dur=3.0)
    out = tmp_path / "out.mp4"
    mix.loudnorm_two_pass(src, out, copy_video=True)
    assert out.exists()
    info = probe_video(str(out))
    assert info["width"] == 320 and info["height"] == 240   # 视频流 copy,尺寸没变
    assert _has_audio_stream(str(out)) is True


# ── mix_voice_over_with_bgm:门④新能力——构造正确性用 mock,别真跑长渲染 ──

def test_mix_voice_over_with_bgm_two_pass_each_track_then_ducks(tmp_path, monkeypatch):
    calls: list[list[str]] = []

    def fake_run(cmd, **kw):
        calls.append(list(cmd))
        class _R:
            returncode = 0
        return _R()

    monkeypatch.setattr(mix.subprocess, "run", fake_run)
    monkeypatch.setattr(mix, "probe_video", lambda p: {"duration_s": 5.0})

    two_pass_calls: list[tuple] = []

    def fake_two_pass(src, out, **kw):
        two_pass_calls.append((str(src), str(out), kw.get("target_i"), kw.get("target_tp"), kw.get("copy_video")))

    monkeypatch.setattr(mix, "loudnorm_two_pass", fake_two_pass)

    out_path = str(tmp_path / "out.mp4")
    result = mix.mix_voice_over_with_bgm(
        str(tmp_path / "video.mp4"), str(tmp_path / "music.mp3"), out_path, work_dir=str(tmp_path),
    )
    assert result == out_path

    # 口播轨 + BGM 轨各自两遍法归一(各调用一次,共两次)
    assert len(two_pass_calls) == 2
    assert all(c[2] == mix.TARGET_I for c in two_pass_calls)
    assert all(c[3] == mix.TARGET_TP for c in two_pass_calls)
    assert all(c[4] is False for c in two_pass_calls)   # 音频轨(wav),没有视频流,不能 -c:v copy

    # ducking:filter_complex 里要有 sidechaincompress(BGM 见人声自动压低)+ amix(合成)
    ducking_cmds = [c for c in calls if "-filter_complex" in c]
    assert len(ducking_cmds) == 1
    fc = ducking_cmds[0][ducking_cmds[0].index("-filter_complex") + 1]
    assert "sidechaincompress" in fc
    assert "amix" in fc

    # 混好的音频要跟原视频重新封装(视频流 copy,不重新编码)
    final_mux_cmds = [c for c in calls if "-shortest" in c and "-filter_complex" not in c]
    assert len(final_mux_cmds) == 1
    assert "copy" in final_mux_cmds[0]


def test_mix_voice_over_with_bgm_real_small_clip_end_to_end(tmp_path):
    """几秒真实小样本端到端跑通(不是分钟级),兜底验证 filter_complex 语法没写错——
    mock 测试测不出 sidechaincompress/amix 的真实 ffmpeg 语法错误。"""
    video = tmp_path / "voice.mp4"
    _tone_video(video, freq=440, dur=3.0)
    bgm = tmp_path / "bgm.wav"
    _tone_wav(bgm, freq=220, dur=5.0)   # bgm 比视频长,函数要自己裁到视频时长

    out = tmp_path / "mixed.mp4"
    result = mix.mix_voice_over_with_bgm(str(video), str(bgm), str(out), work_dir=str(tmp_path))
    assert Path(result).exists()
    info = probe_video(result)
    assert 2.5 < info["duration_s"] < 3.5
    assert _has_audio_stream(result) is True
    # 中间产物(voice/bgm raw+norm、混音 wav)应该被清理掉,不留一地垃圾
    leftovers = list(tmp_path.glob("_mix_*"))
    assert leftovers == []
