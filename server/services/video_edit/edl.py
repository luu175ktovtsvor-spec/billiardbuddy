"""EDL(Edit Decision List·剪辑决策表)—— 大脑(LLM)与双手(ffmpeg)之间的唯一契约。

LLM 负责产出 EDL(选哪段·怎么排·什么调性);render.py 按 EDL 确定性执行。
"""
from __future__ import annotations

from pydantic import BaseModel, Field


class EdlRange(BaseModel):
    """一个保留片段。start/end 必须落在源视频的有效时间内;有口播时卡词边界。"""

    source: str
    start: float
    end: float
    beat: str = ""        # HOOK / 环境 / 人物 / CTA 等镜头作用
    quote: str = ""
    reason: str = ""      # 为什么选这段(LLM 解释)


class EdlOverlay(BaseModel):
    file: str
    start_in_output: float
    duration: float


class Edl(BaseModel):
    version: int = 1
    sources: dict[str, str]                       # {"C0103": "/abs/path.mp4"}
    ranges: list[EdlRange]
    grade: str | None = None                      # 预设名 / 原始 ffmpeg 滤镜 / "auto" / None
    audio_mode: str = "keep"                      # keep=保留原声 / music=换背景乐(music_file) / mute
                                                   # / voice_over_music=口播原声+BGM同时混音(E4④新增,
                                                   #   见 render.py+mix.py;additive,不影响前三档)
    music_file: str | None = None                 # audio_mode="music"/"voice_over_music" 时的背景乐路径
    title: str | None = None                      # 可选:开头烧一行标题(drawtext)
    overlays: list[EdlOverlay] = Field(default_factory=list)
    subtitles: str | None = None                  # master.srt 路径,最后烧
    subtitle_font: str = "PingFang SC"            # 字幕字体家族名(可换:得意黑/思源黑体/楷体…)
    subtitle_fontsdir: str | None = None          # 字体文件所在目录(None=系统字体目录)
    subtitle_fontsize: int = 15
    target_w: int = 1080                          # 成片尺寸(竖屏默认 1080x1920)
    target_h: int = 1920
    total_duration_s: float | None = None
