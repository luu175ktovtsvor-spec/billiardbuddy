"""EDL → ffmpeg 渲染(移植自 browser-use/video-use 的 render.py,适配竖屏蒙太奇)。

严格按顺序(16 铁律里的渲染部分,顺序错=静默废片):
  ① 逐段抽取:scale-cover 到目标竖屏尺寸 + 30ms 音频淡入淡出 + 可选调色 + HDR→SDR tonemap
  ② 无损 -c copy 拼接成 base
  ③ 音频:keep(原声) / music(换背景乐) / mute / voice_over_music(口播原声+BGM同时混音,E4④新增)
  ④ 响度归一化 -14 LUFS / -1.5 dBTP / LRA 11(社媒标准,两遍法——见 mix.loudnorm_two_pass)
所有 ffmpeg 调用走 ffbin,不用裸 "ffmpeg"(产品打包只能用内置二进制)。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from . import mix
from .edl import Edl
from .ffbin import ffmpeg_bin, probe_video

# HDR(HLG/PQ)→SDR tonemap 链(铁律13):否则上传社媒过曝惨白
_TONEMAP = (
    "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,"
    "tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
)
# 社媒响度标准(铁律14;E4④把 TP 从 -1 收紧到 -1.5,防真机限幅器二次削峰,且改两遍法测量校正)
_LUFS_I, _LUFS_TP, _LUFS_LRA = -14.0, -1.5, 11.0

# CJK 字体目录：macOS 用系统字体目录(有 PingFang SC)；Windows/Linux 及装机包用打包自带的
# 得意黑——"PingFang SC"+"/System/Library/Fonts" 是 macOS 专属,别的平台指过去=字幕烧不出中文。
# 装机包资产名 assets_fonts 与 build_backend.js 的 --add-data 对齐(同 template_render._asset)。
def _bundled_fonts_dir() -> str:
    if getattr(sys, "frozen", False):
        return str(Path(sys._MEIPASS) / "assets_fonts")  # type: ignore[attr-defined]
    return str(Path(__file__).resolve().parents[3] / "server" / "assets" / "fonts")


_IS_MAC = sys.platform == "darwin"
_FONTS_DIR = "/System/Library/Fonts" if _IS_MAC else _bundled_fonts_dir()
_FALLBACK_CJK_FONT = "Smiley Sans Oblique"  # 打包自带的得意黑(SmileySans-Oblique.ttf)的英文家族名


def _sub_style(font: str, fontsize: int) -> str:
    """字幕样式(铁律16:MarginV≈90 避开抖音/Reels 底部 UI 安全区;白字黑边)。字体可换。"""
    return (
        f"FontName={font},FontSize={fontsize},Bold=1,"
        "PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,"
        "BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=90"
    )

_GRADE_PRESETS = {
    "warm_cinematic": "eq=contrast=1.06:saturation=1.05:gamma=0.98,colorbalance=rs=.04:bs=-.03",
    "neutral_punch": "eq=contrast=1.05:saturation=1.02",
    "none": "",
}


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _grade_filter(grade: str | None) -> str:
    if not grade or grade == "none":
        return ""
    return _GRADE_PRESETS.get(grade, grade)  # 不在预设里则当原始 ffmpeg 滤镜


def _extract_segment(src: str, start: float, dur: float, edl: Edl, out: Path, *, with_audio: bool) -> None:
    """抽一段:scale-cover 到 target 竖屏 + 30ms 淡入淡出 + grade + HDR tonemap。"""
    out.parent.mkdir(parents=True, exist_ok=True)
    info = probe_video(src)
    tw, th = edl.target_w, edl.target_h

    vf_parts: list[str] = []
    if info["is_hdr"]:
        vf_parts.append(_TONEMAP)
    # scale-cover 后中心裁切到精确尺寸(9:16 源→正好填满,无黑边)
    vf_parts.append(f"scale={tw}:{th}:force_original_aspect_ratio=increase")
    vf_parts.append(f"crop={tw}:{th}")
    g = _grade_filter(edl.grade)
    if g:
        vf_parts.append(g)
    vf = ",".join(vf_parts)

    cmd = [
        ffmpeg_bin(), "-y",
        "-ss", f"{start:.3f}", "-i", src, "-t", f"{dur:.3f}",
        "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "20",
        "-pix_fmt", "yuv420p", "-r", "30",
    ]
    if with_audio:
        # 30ms 音频淡入淡出(铁律3)防爆音
        fade_out = max(0.0, dur - 0.03)
        af = f"afade=t=in:st=0:d=0.03,afade=t=out:st={fade_out:.3f}:d=0.03"
        cmd += ["-af", af, "-c:a", "aac", "-b:a", "192k", "-ar", "48000"]
    else:
        cmd += ["-an"]
    cmd += ["-movflags", "+faststart", str(out)]
    _run(cmd)


def _concat(segs: list[Path], out: Path, edit_dir: Path) -> None:
    """无损 -c copy 拼接(铁律2)。"""
    lst = edit_dir / "_concat.txt"
    lst.write_text("".join(f"file '{p.resolve()}'\n" for p in segs))
    _run([
        ffmpeg_bin(), "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
        "-c", "copy", "-movflags", "+faststart", str(out),
    ])
    lst.unlink(missing_ok=True)


def _add_music(base: Path, music: str, out: Path) -> None:
    """把背景乐铺到 base(视频)上,音乐循环/裁到视频时长,视频无损 copy。"""
    dur = probe_video(str(base))["duration_s"]
    _run([
        ffmpeg_bin(), "-y",
        "-i", str(base),
        "-stream_loop", "-1", "-i", music,
        "-map", "0:v:0", "-map", "1:a:0",
        "-t", f"{dur:.3f}",
        "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
        "-shortest", "-movflags", "+faststart", str(out),
    ])


def _burn_subtitles(src: Path, srt: str, out: Path, *, font: str, fontsdir: str, fontsize: int) -> None:
    """烧字幕(铁律1:最后一步;铁律16:安全区 MarginV)。字体可换:FontName + fontsdir。"""
    esc = str(Path(srt).resolve()).replace("\\", "/").replace(":", r"\:").replace("'", r"\'")
    vf = f"subtitles='{esc}':fontsdir='{fontsdir}':force_style='{_sub_style(font, fontsize)}'"
    _run([
        ffmpeg_bin(), "-y", "-i", str(src), "-vf", vf,
        "-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart", str(out),
    ])


def _loudnorm(src: Path, out: Path) -> None:
    """响度归一化到社媒标准(铁律14)。两遍法(先测真实积分响度,再按测量值精确校正,比单遍近似准)。"""
    mix.loudnorm_two_pass(src, out, target_i=_LUFS_I, target_tp=_LUFS_TP, target_lra=_LUFS_LRA,
                           copy_video=True)


def render_edl(edl: Edl, out_path: str, *, edit_dir: str | None = None) -> str:
    """按 EDL 渲染成片,返回成片路径。"""
    out = Path(out_path).resolve()
    work = Path(edit_dir).resolve() if edit_dir else out.parent
    clips_dir = work / "clips"
    clips_dir.mkdir(parents=True, exist_ok=True)

    # voice_over_music 也要保留原声(混音要靠它)——没给 music_file 时兜底当 keep 处理(同 music
    # 模式没给 music_file 的兜底逻辑:不崩,退化成保留原声)。
    keep_audio = edl.audio_mode in ("keep", "voice_over_music")

    # ① 逐段抽取
    seg_paths: list[Path] = []
    for i, r in enumerate(edl.ranges):
        src = edl.sources[r.source]
        seg = clips_dir / f"seg_{i:02d}.mp4"
        _extract_segment(src, r.start, r.end - r.start, edl, seg, with_audio=keep_audio)
        seg_paths.append(seg)

    # ② 无损拼接
    base = work / "base.mp4"
    _concat(seg_paths, base, work)

    # ③ 音频模式
    if edl.audio_mode == "music" and edl.music_file:
        withaudio = work / "with_music.mp4"
        _add_music(base, edl.music_file, withaudio)
        pre = withaudio
    elif edl.audio_mode == "voice_over_music" and edl.music_file:
        # E4④新增:口播原声 + BGM 同时混音(两遍法归一 + ducking,见 mix.py),不动 music/keep/mute
        # 原来三条分支的判断结构(additive)。
        mixed = work / "voice_over_music.mp4"
        mix.mix_voice_over_with_bgm(str(base), edl.music_file, str(mixed), work_dir=str(work))
        pre = mixed
    elif edl.audio_mode == "mute":
        pre = base  # 段是 -an 抽的,base 本就无声
    else:  # keep(以及 voice_over_music 没给 music_file 的兜底)
        pre = base

    # ④ 烧字幕(铁律1:在响度归一化前完成视频侧合成;无 overlay 时直接烧在拼接视频上)
    if edl.subtitles:
        subbed = work / "subbed.mp4"
        _burn_subtitles(
            pre, edl.subtitles, subbed,
            # 非 macOS 且没显式指定字体目录时,默认的 "PingFang SC" 不存在 → 换打包自带的得意黑
            font=edl.subtitle_font if (_IS_MAC or edl.subtitle_fontsdir) else _FALLBACK_CJK_FONT,
            fontsdir=edl.subtitle_fontsdir or _FONTS_DIR,
            fontsize=edl.subtitle_fontsize,
        )
        pre = subbed

    # ⑤ 响度归一化(有声才做;视频 -c copy 保留已烧的字幕)
    # voice_over_music(给了 music_file 的正常路径)在 mix_voice_over_with_bgm 内部已经对口播轨/
    # BGM 轨各自两遍法归一过了,这里再整体 loudnorm 一遍等于重复处理、白白压一次动态范围——跟
    # mute 一样直接原样拷贝落地就好。
    if edl.audio_mode == "mute" or (edl.audio_mode == "voice_over_music" and edl.music_file):
        _run([ffmpeg_bin(), "-y", "-i", str(pre), "-c", "copy", str(out)])
    else:
        _loudnorm(pre, out)

    return str(out)
