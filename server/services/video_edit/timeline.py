"""时间轴文档(编排层 · 唯一真相源)。

三段解耦的中间层:① 编辑视图(前端) ←→ ② 时间轴文档(本模块) ←→ ③ 渲染器(render.py)。
AI 不重写整份文档,只发原子操作(operations.py)改它;渲染器消费它出片;前端编辑它。

设计要点(经 deep-research 多源证实):
- **稳定 ID 映射,不用数组下标**——防 AI 改下标错位(JSON Whisperer / RFC6902 教训)。
- **轨道分类型**(video/caption/audio):video 顺序排布(order 字段),caption/audio 绝对定位(start/end)。
- 片段只存 src_in/src_out(截源素材的哪一段 = source_range);源全长由 MediaRef.duration 派生。
- 时间用**浮点秒**(只对接 FFmpeg、不跨帧率帧对齐,够用)。
"""
from __future__ import annotations

from pydantic import BaseModel, Field

from .edl import Edl, EdlRange


class MediaRef(BaseModel):
    """媒体引用:稳定 ID → 本机源文件 + 源全长。"""

    src: str                    # 源文件绝对路径(本地,不走 HTTP)
    duration: float             # 源素材全长(秒)= OTIO 的 available_range
    kind: str = "video"         # video / audio / image


class Track(BaseModel):
    """轨道:分类型 + 叠放顺序(渲染图层)。"""

    kind: str                   # video / caption / audio
    order: int = 0


class Clip(BaseModel):
    """片段(三种角色共用一个结构,按所属轨道 kind 解释字段):
    - video 片段:media + src_in/src_out(截源的哪段) + order(同轨顺序排布)
    - caption 片段:text + start/end(成片时间轴上的绝对位置) + style
    - audio  片段:media + start(铺到成片哪) + gain(增益 dB)
    """

    track: str                              # 所属轨道 ID
    order: int = 0                          # 同轨内排序(video 顺序排布)
    media: str | None = None                # 视频/音频:媒体 ID
    src_in: float = 0.0                     # 截源素材入点(source_range)
    src_out: float = 0.0                    # 截源素材出点
    text: str | None = None                 # 字幕文字
    start: float | None = None              # 覆盖类(字幕/音频)在成片时间轴的绝对起点
    end: float | None = None
    style: str | None = None                # 字幕风格名 / 调色预设
    gain: float | None = None               # 音频增益 dB
    effects: list[str] = Field(default_factory=list)


class TimelineDoc(BaseModel):
    """时间轴文档 = 整条片子怎么拼的唯一真相源。"""

    version: int = 1
    fps: int = 30
    width: int = 1080                       # 竖屏默认 1080x1920
    height: int = 1920
    media: dict[str, MediaRef] = Field(default_factory=dict)
    tracks: dict[str, Track] = Field(default_factory=dict)
    clips: dict[str, Clip] = Field(default_factory=dict)
    grade: str | None = None                # 全局调色预设
    music: str | None = None                # 背景乐媒体 ID(便捷;也可走 audio 轨)

    # ── 派生 ──────────────────────────────────────────────
    def _track_kind(self, track_id: str) -> str | None:
        t = self.tracks.get(track_id)
        return t.kind if t else None

    def video_clips_ordered(self) -> list[tuple[str, Clip]]:
        """视频轨片段,按 order 升序(顺序排布:前一段结束接后一段)。"""
        vids = [
            (cid, c) for cid, c in self.clips.items()
            if self._track_kind(c.track) == "video"
        ]
        vids.sort(key=lambda kv: (kv[1].order, kv[0]))
        return vids

    def caption_clips(self) -> list[tuple[str, Clip]]:
        caps = [
            (cid, c) for cid, c in self.clips.items()
            if self._track_kind(c.track) == "caption"
        ]
        caps.sort(key=lambda kv: (kv[1].start or 0.0, kv[0]))
        return caps

    def audio_clips(self) -> list[tuple[str, Clip]]:
        return [
            (cid, c) for cid, c in self.clips.items()
            if self._track_kind(c.track) == "audio"
        ]

    def duration(self) -> float:
        """成片时长 = 视频轨各片段时长之和(顺序排布)。"""
        return round(sum(c.src_out - c.src_in for _, c in self.video_clips_ordered()), 3)

    # ── 校验(挡非法状态,operations 施加后必跑) ──────────────
    def validate_doc(self) -> list[str]:
        """返回错误列表;空列表 = 合法。AI 改完文档先校验,不合法则回滚 + 把错误回灌给模型自救。"""
        errs: list[str] = []
        for cid, c in self.clips.items():
            tk = self.tracks.get(c.track)
            if tk is None:
                errs.append(f"片段 {cid} 指向不存在的轨道 {c.track}")
                continue
            if tk.kind in ("video", "audio"):
                if c.media is None:
                    errs.append(f"片段 {cid}({tk.kind})缺 media")
                    continue
                m = self.media.get(c.media)
                if m is None:
                    errs.append(f"片段 {cid} 指向不存在的媒体 {c.media}")
                    continue
                if c.src_out <= c.src_in:
                    errs.append(f"片段 {cid} 区间非法:src_in({c.src_in}) >= src_out({c.src_out})")
                if c.src_in < 0 or c.src_out > m.duration + 0.05:
                    errs.append(
                        f"片段 {cid} 超出源素材范围 [0,{m.duration}]:{c.src_in}-{c.src_out}"
                    )
            elif tk.kind == "caption":
                if not (c.text or "").strip():
                    errs.append(f"字幕 {cid} 缺文字")
                if c.start is None or c.end is None or c.end <= c.start:
                    errs.append(f"字幕 {cid} 时间非法:start={c.start} end={c.end}")
        return errs

    # ── 渲染桥:时间轴文档 → 既有 Edl(复用 render.py 的 ffmpeg 管线) ──
    def to_edl(self, *, subtitles_srt: str | None = None) -> Edl:
        """把文档编译成既有 Edl 给 render_edl 消费。

        视频轨 → ranges(顺序);音频/背景乐 → audio_mode;字幕轨由 subtitles.build_srt 单独产 SRT 后传入。
        """
        sources: dict[str, str] = {mid: m.src for mid, m in self.media.items()}
        ranges = [
            EdlRange(source=c.media, start=c.src_in, end=c.src_out)
            for _, c in self.video_clips_ordered()
            if c.media
        ]
        audio_mode = "keep"
        music_file = None
        if self.music and self.music in self.media:
            audio_mode, music_file = "music", self.media[self.music].src

        return Edl(
            version=self.version,
            sources=sources,
            ranges=ranges,
            grade=self.grade,
            audio_mode=audio_mode,
            music_file=music_file,
            subtitles=subtitles_srt,
            target_w=self.width,
            target_h=self.height,
            total_duration_s=self.duration(),
        )


def new_doc(*, width: int = 1080, height: int = 1920, fps: int = 30) -> TimelineDoc:
    """新建空文档(竖屏默认)。"""
    return TimelineDoc(width=width, height=height, fps=fps)
