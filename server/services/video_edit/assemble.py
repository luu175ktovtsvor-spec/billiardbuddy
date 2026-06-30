"""装配层 —— 把感知(转写/切镜头)接成"候选菜单 + 草稿时间轴文档",并把文档渲染成片。

数据流(三段式的"喂 AI"和"出片"两端):
  素材 → inventory_footage(转写+切镜头) → 候选菜单 + 草稿文档(已登记 media/轨道)
       → AI 发原子操作(operations)挑段/排布/配字幕 → 时间轴文档
       → render_timeline(文档 → SRT + Edl → render_edl) → 成片 mp4
"""
from __future__ import annotations

import json
from pathlib import Path

from .ffbin import probe_video
from .render import render_edl
from .scene_detect import detect_scenes
from .subtitles import _ts
from .timeline import MediaRef, Track, new_doc, TimelineDoc


def inventory_footage(video_paths: list[str], edit_dir: str, *, language: str = "zh") -> dict:
    """理解素材(只读):每个视频转写 + 切镜头,产出给 AI 读的候选菜单 + 已登记媒体的草稿文档。

    返回 {"packed": <给模型读的文本>, "doc": TimelineDoc(JSON), "media": {...}, "has_speech": bool, "edit_dir": str}。
    AI 据 packed 里的"可选片段(时间戳)"发 add_clip 操作建片。**只读,不弹审批。**
    """
    from .transcribe import transcribe  # 延迟导入(whisper 重)

    work = Path(edit_dir)
    work.mkdir(parents=True, exist_ok=True)
    doc = new_doc()
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    doc.tracks["aud"] = Track(kind="audio", order=2)

    lines: list[str] = []
    candidates: list[dict] = []   # 结构化候选(前端渲染选段卡片用)
    any_speech = False
    for i, vp in enumerate(video_paths):
        info = probe_video(vp)
        mid = f"m{i + 1}"
        doc.media[mid] = MediaRef(src=vp, duration=info["duration_s"], kind="video")
        scenes = detect_scenes(vp)
        tr = transcribe(vp, edit_dir, language=language)
        has_speech = tr.get("has_speech")
        any_speech = any_speech or has_speech
        phrases = _phrase_cues(tr.get("words", [])) if has_speech else []

        lines.append(f"## 素材 {mid}（{Path(vp).name}） 时长 {info['duration_s']}s "
                     f"{'竖屏' if info['is_portrait'] else '横屏'} {'有口播' if has_speech else '无口播/空镜'}")
        lines.append(f"镜头切点({len(scenes)}段): " +
                     " ".join(f"[{s:.1f}-{e:.1f}]" for s, e in scenes[:20]))
        if has_speech:
            lines.append("口播内容(可按这些话挑段):")
            for cue in phrases:
                lines.append(f"  [{cue[0]:.1f}-{cue[1]:.1f}] {cue[2]}")
        lines.append("")

        candidates.append({
            "media": mid,
            "name": Path(vp).name,
            "duration": info["duration_s"],
            "is_portrait": info["is_portrait"],
            "has_speech": has_speech,
            "scenes": [[round(s, 2), round(e, 2)] for s, e in scenes],
            "phrases": [{"start": round(a, 2), "end": round(b, 2), "text": t} for a, b, t in phrases],
        })

    return {
        "packed": "\n".join(lines).strip(),
        "doc": doc.model_dump(),
        "candidates": candidates,
        "has_speech": any_speech,
        "edit_dir": str(work),
    }


def _phrase_cues(words: list[dict], *, gap: float = 0.5, max_chars: int = 14) -> list[tuple[float, float, str]]:
    """词级 → 短语级(间隔>gap 或满 max_chars 断句)。给 AI 当"可选口播片段"。"""
    cues: list[tuple[float, float, str]] = []
    line: list[dict] = []

    def flush():
        nonlocal line
        if line:
            text = "".join(w["text"] for w in line).strip()
            if text:
                cues.append((line[0]["start"], line[-1]["end"], text))
        line = []

    prev_end = None
    for w in words:
        if line and (w["start"] - (prev_end or w["start"]) > gap or
                     len("".join(x["text"] for x in line)) >= max_chars):
            flush()
        line.append(w)
        prev_end = w["end"]
    flush()
    return cues


def build_srt_from_doc(doc: TimelineDoc, out_path: str) -> str:
    """字幕轨(显式 caption 片段,带成片时间轴 start/end)→ SRT。"""
    cues = [(c.start or 0.0, c.end or 0.0, c.text or "") for _, c in doc.caption_clips()]
    out_lines: list[str] = []
    for i, (a, b, t) in enumerate(cues, 1):
        if b <= a:
            b = a + 0.4
        out_lines += [str(i), f"{_ts(a)} --> {_ts(b)}", t.strip(), ""]
    Path(out_path).write_text("\n".join(out_lines), encoding="utf-8")
    return out_path


def auto_captions_from_speech(doc: TimelineDoc, edit_dir: str, *, track: str = "sub",
                              max_chars: int = 12, gap: float = 0.5) -> list[dict]:
    """把已选视频片段里的口播,映射成成片时间轴上的字幕片段(add_caption 操作列表)。

    铁律5:字幕输出时间 = 词start - 段src_in + 段累计偏移。返回 ops 给 operations.apply_operations 施加。
    """
    work = Path(edit_dir)
    ops: list[dict] = []
    seg_offset = 0.0
    for cid, c in doc.video_clips_ordered():
        if not c.media:
            continue
        src = doc.media[c.media].src
        cache = work / "transcripts" / f"{Path(src).stem}.json"
        words = json.loads(cache.read_text()).get("words", []) if cache.exists() else []
        words = [w for w in words if c.src_in <= w["start"] < c.src_out]

        line: list[dict] = []

        def flush():
            nonlocal line
            if line:
                text = "".join(w["text"] for w in line).strip()
                if text:
                    a = max(c.src_in, line[0]["start"]) - c.src_in + seg_offset
                    b = min(c.src_out, line[-1]["end"]) - c.src_in + seg_offset
                    ops.append({"op": "add_caption", "track": track, "text": text,
                                "start": round(a, 3), "end": round(max(b, a + 0.4), 3)})
            line = []

        prev_end = None
        for w in words:
            if line and (w["start"] - (prev_end or w["start"]) > gap or
                         len("".join(x["text"] for x in line)) >= max_chars):
                flush()
            line.append(w)
            prev_end = w["end"]
        flush()
        seg_offset += c.src_out - c.src_in
    return ops


def render_timeline(doc: TimelineDoc, out_path: str, *, edit_dir: str) -> str:
    """时间轴文档 → 成片 mp4。字幕轨→SRT,文档→Edl,复用 render_edl 的确定性 ffmpeg 管线。"""
    work = Path(edit_dir)
    work.mkdir(parents=True, exist_ok=True)
    srt = None
    if doc.caption_clips():
        srt = str(work / "captions.srt")
        build_srt_from_doc(doc, srt)
    edl = doc.to_edl(subtitles_srt=srt)
    return render_edl(edl, out_path, edit_dir=str(work))
