"""template_render.py(V2 渲染器)E4④升级点:原来的"编码+映射+单遍loudnorm 一把梭"拆成
"先无损混流,再两遍法响度归一"。render_v2 整体依赖 Electron/Playwright 离屏渲染,不在单测范围
(见 desktop e2e);这里只单独真机短样本验证被抽出来的混流+两遍法归一这一段。
"""
from __future__ import annotations

import subprocess
from pathlib import Path

from services.video_edit import mix, template_render as tr
from services.video_edit.ffbin import ffmpeg_bin, probe_video
from services.video_edit.footage_qc import _has_audio_stream


def test_mux_bgm_and_loudnorm_produces_two_pass_normalized_output(tmp_path):
    base = tmp_path / "base.mp4"
    subprocess.run(
        [ffmpeg_bin(), "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=3:rate=15",
         "-pix_fmt", "yuv420p", "-c:v", "libx264", "-an", str(base)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    bgm = tmp_path / "bgm.wav"
    subprocess.run(
        [ffmpeg_bin(), "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=3",
         str(bgm)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    out = tmp_path / "final.mp4"

    result = tr._mux_bgm_and_loudnorm(base, str(bgm), str(out), work=tmp_path)

    assert Path(result).exists()
    info = probe_video(result)
    assert 2.5 < info["duration_s"] < 3.5
    assert _has_audio_stream(result) is True
    remeasured = mix.measure_loudness(result)
    assert abs(float(remeasured["input_i"]) - mix.TARGET_I) < 1.5   # 两遍法应该落在目标响度附近

    # 中间产物(premix)不留下
    assert not (tmp_path / "v2_premix.mp4").exists()
