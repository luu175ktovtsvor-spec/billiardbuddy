"""从转录词 + EDL 生成成片时间轴的 SRT(铁律5:输出时间 = 词start - 段start + 段累计偏移)。

中文按"间隔>0.5s 或累计字数>=上限"断行。
"""
from __future__ import annotations

import json
from pathlib import Path

from .edl import Edl


def _ts(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def _load_words(edit_dir: Path, src_path: str) -> list[dict]:
    cache = edit_dir / "transcripts" / f"{Path(src_path).stem}.json"
    if not cache.exists():
        return []
    return json.loads(cache.read_text()).get("words", [])


def build_srt(edl: Edl, edit_dir: str, out_path: str, *, max_chars: int = 12, gap: float = 0.5) -> str:
    """生成成片时间轴 SRT,返回路径。"""
    edit = Path(edit_dir)
    cues: list[tuple[float, float, str]] = []
    seg_offset = 0.0

    for r in edl.ranges:
        words = [w for w in _load_words(edit, edl.sources[r.source]) if r.start <= w["start"] < r.end]
        line: list[dict] = []

        def flush():
            nonlocal line
            if not line:
                return
            text = "".join(w["text"] for w in line).strip()
            if text:
                a = max(r.start, line[0]["start"]) - r.start + seg_offset
                b = min(r.end, line[-1]["end"]) - r.start + seg_offset
                if b <= a:
                    b = a + 0.4
                cues.append((a, b, text))
            line = []

        prev_end = None
        for w in words:
            if line and (w["start"] - (prev_end or w["start"]) > gap or
                         len("".join(x["text"] for x in line)) >= max_chars):
                flush()
            line.append(w)
            prev_end = w["end"]
        flush()
        seg_offset += r.end - r.start

    cues.sort(key=lambda c: c[0])
    out_lines: list[str] = []
    for i, (a, b, t) in enumerate(cues, 1):
        out_lines += [str(i), f"{_ts(a)} --> {_ts(b)}", t, ""]
    Path(out_path).write_text("\n".join(out_lines), encoding="utf-8")
    return out_path
