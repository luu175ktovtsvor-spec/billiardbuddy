"""混音门(E4④)—— 两遍法 loudnorm + ducking + "口播原声+BGM 同时混音",零 token 纯 ffmpeg。

现状(本单之前):Edl.audio_mode 只有 keep(保留原声、无BGM)/ music(整段替换成BGM,原声丢弃)/
mute。"口播原声 + BGM 垫底同时混音"这个动作代码里完全不存在——不是"有混音但没ducking",是这个
动作本身没有。

本模块新增:
  - measure_loudness() / loudnorm_two_pass()  两遍法响度归一(ffmpeg 官方推荐流程:第一遍
    `print_format=json` 测真实积分响度/真峰值/响度范围,第二遍 `linear=true` 按测量值精确校正),
    比 render.py/template_render.py 原来的单遍近似准得多。render.py/template_render.py 现有的
    单遍 loudnorm 已改成调这两个函数(见各自文件),这里只放通用实现,不重复。
  - mix_voice_over_with_bgm()  Edl.audio_mode="voice_over_music" 这个新档的落地实现:
    口播轨(取自视频自身音轨)+ BGM 轨(循环裁到等长)各自两遍法归一 → sidechaincompress
    ducking(BGM 见人声自动压低,人声保持清楚)→ amix 合成 → 跟原视频重新封装(视频流 copy,
    不重新编码)。additive,不影响 keep/music/mute 原行为。
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

from .ffbin import ffmpeg_bin, probe_video

# 抖音/视频号通行响度标准(比 render.py 原来的单遍近似 TP=-1 更保守,防真机限幅器二次削峰)。
TARGET_I = -14.0
TARGET_TP = -1.5
TARGET_LRA = 11.0

# ffmpeg loudnorm filter 在 print_format=json 时,把测量结果打印成一段扁平(无嵌套花括号)JSON
# 到 stderr——用非贪婪的"花括号内无花括号"匹配,不用管前后还有多少行别的 ffmpeg 日志。
_LOUDNORM_JSON_RE = re.compile(r"\{[^{}]*\"input_i\"[^{}]*\}", re.DOTALL)


def measure_loudness(src: str, *, target_i: float = TARGET_I, target_tp: float = TARGET_TP,
                      target_lra: float = TARGET_LRA) -> dict:
    """两遍法第一遍:量出这条音轨真实的积分响度/真峰值/响度范围(不产出文件,只读 stderr 里的 JSON)。"""
    f = f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:print_format=json"
    cmd = [ffmpeg_bin(), "-y", "-i", str(src), "-af", f, "-f", "null", "-"]
    r = subprocess.run(cmd, capture_output=True, text=True)
    stderr = r.stderr or ""
    m = _LOUDNORM_JSON_RE.search(stderr)
    if not m:
        raise RuntimeError(f"loudnorm 第一遍测量失败,ffmpeg 没吐出响度 JSON(src={src}):{stderr[-500:]}")
    return json.loads(m.group(0))


def loudnorm_two_pass(src: Path | str, out: Path | str, *, target_i: float = TARGET_I,
                       target_tp: float = TARGET_TP, target_lra: float = TARGET_LRA,
                       copy_video: bool = True) -> None:
    """两遍法响度归一:第一遍测量,第二遍(linear=true)按测量值精确校正。

    copy_video=True:src 是带视频流的文件(如成片 mp4),视频流原样 copy;
    copy_video=False:src 是纯音频文件(如中间提取出的人声/BGM wav),没有视频流可 copy。
    """
    measured = measure_loudness(str(src), target_i=target_i, target_tp=target_tp, target_lra=target_lra)
    f = (
        f"loudnorm=I={target_i}:TP={target_tp}:LRA={target_lra}:"
        f"measured_I={measured['input_i']}:measured_TP={measured['input_tp']}:"
        f"measured_LRA={measured['input_lra']}:measured_thresh={measured['input_thresh']}:"
        f"offset={measured.get('target_offset', 0)}:linear=true:print_format=summary"
    )
    cmd = [ffmpeg_bin(), "-y", "-i", str(src)]
    if copy_video:
        cmd += ["-c:v", "copy"]
    cmd += ["-af", f, "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
            "-movflags", "+faststart", str(out)]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def mix_voice_over_with_bgm(
    video_path: str,
    music_path: str,
    out_path: str,
    *,
    target_i: float = TARGET_I,
    target_tp: float = TARGET_TP,
    target_lra: float = TARGET_LRA,
    duck_threshold: float = 0.05,
    duck_ratio: float = 8.0,
    work_dir: str | Path | None = None,
) -> str:
    """口播原声 + BGM 同时混音(Edl.audio_mode="voice_over_music" 落地实现)。

    ① 抽人声轨(取自 video_path 自身音轨)+ BGM 轨(循环裁到跟视频等长)
    ② 各自两遍法 loudnorm 归一(口播/BGM 分开测、分开校,别混在一起测)
    ③ sidechaincompress ducking(BGM 见人声自动压低)+ amix 合成
    ④ 混好的音频跟原视频重新封装(视频流 copy,不重新编码)
    中间产物用完即删,不留一地临时文件。
    """
    video = Path(video_path)
    out = Path(out_path)
    work = Path(work_dir) if work_dir else out.parent
    work.mkdir(parents=True, exist_ok=True)

    dur = probe_video(str(video))["duration_s"]

    voice_raw = work / "_mix_voice_raw.wav"
    bgm_raw = work / "_mix_bgm_raw.wav"
    # loudnorm_two_pass 编码用 aac——容器后缀必须配 aac(m4a),别用 .wav(WAV 容器塞 AAC 码流,
    # ffmpeg 写得出来但读回来解码会炸,踩过坑:sidechaincompress 读取阶段整段 "Invalid data")。
    voice_norm = work / "_mix_voice_norm.m4a"
    bgm_norm = work / "_mix_bgm_norm.m4a"
    mixed_audio = work / "_mix_out.wav"

    # ① 人声轨(取自视频自身音轨)
    subprocess.run(
        [ffmpeg_bin(), "-y", "-i", str(video), "-vn", "-acodec", "pcm_s16le", "-ar", "48000", str(voice_raw)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )
    # BGM 循环裁到跟视频等长
    subprocess.run(
        [ffmpeg_bin(), "-y", "-stream_loop", "-1", "-i", str(music_path), "-t", f"{dur:.3f}",
         "-acodec", "pcm_s16le", "-ar", "48000", str(bgm_raw)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    # ② 各自两遍法 loudnorm(音频轨,没有视频流,copy_video=False)
    loudnorm_two_pass(voice_raw, voice_norm, target_i=target_i, target_tp=target_tp,
                       target_lra=target_lra, copy_video=False)
    loudnorm_two_pass(bgm_raw, bgm_norm, target_i=target_i, target_tp=target_tp,
                       target_lra=target_lra, copy_video=False)

    # ③ ducking + 合成:sidechaincompress 的第一个输入是"要被压的"(BGM),第二个是"触发压缩的
    # 侧链信号"(人声)——人声一响 BGM 就自动降;normalize=0 防止 amix 默认按输入数均分音量把人声
    # 也顺带压小(BGM 已经被 ducking 单独压过,不需要 amix 再来一次全局均分)。
    filter_complex = (
        f"[1:a][0:a]sidechaincompress=threshold={duck_threshold}:ratio={duck_ratio}:"
        f"attack=5:release=250[bgmduck];"
        f"[0:a][bgmduck]amix=inputs=2:duration=first:dropout_transition=0:weights=1 1:normalize=0[aout]"
    )
    subprocess.run(
        [ffmpeg_bin(), "-y", "-i", str(voice_norm), "-i", str(bgm_norm),
         "-filter_complex", filter_complex, "-map", "[aout]",
         "-acodec", "pcm_s16le", "-ar", "48000", str(mixed_audio)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    # ④ 混好的音频跟原视频重新封装(视频流原样 copy)
    out.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [ffmpeg_bin(), "-y", "-i", str(video), "-i", str(mixed_audio),
         "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
         "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
         "-shortest", "-movflags", "+faststart", str(out)],
        check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
    )

    for tmp in (voice_raw, bgm_raw, voice_norm, bgm_norm, mixed_audio):
        tmp.unlink(missing_ok=True)

    return str(out)
