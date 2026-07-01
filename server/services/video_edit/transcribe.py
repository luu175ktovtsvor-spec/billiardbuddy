"""faster-whisper 词级转录(本地·离线·带缓存)。

铁律8/9:词级逐字 + 按源文件缓存。
★vad_filter=True:无语音片段(纯音乐/摆拍)会让 whisper 幻觉出"请点赞订阅"之类字幕垃圾,
  开 VAD 先滤掉非语音,既防幻觉又省时。无口播的片子转出来就是空 words(正确行为)。
"""
from __future__ import annotations

import json
import os
import sys
from functools import lru_cache
from pathlib import Path

# 默认模型:打包预置的 medium(离线加载)。env 可覆盖(如换 large-v3 或开发机用 small)。
# 装机包(PyInstaller frozen)从 sys._MEIPASS/faster-whisper-medium 取(见审查 P0-2)。
if getattr(sys, "frozen", False):
    _DEV_WHISPER = str(Path(sys._MEIPASS) / "faster-whisper-medium")  # type: ignore[attr-defined]
else:
    _DEV_WHISPER = str(Path(__file__).resolve().parents[2] / "ml_models" / "faster-whisper-medium")
_DEFAULT_MODEL = os.environ.get("WHISPER_MODEL_DIR", _DEV_WHISPER)


@lru_cache(maxsize=2)
def _get_model(model_dir: str, device: str, compute_type: str):
    from faster_whisper import WhisperModel

    # 预置目录存在则离线加载;否则按名联网下(仅开发机,打包后必走预置目录)
    local_only = Path(model_dir).exists()
    name = model_dir if local_only else "medium"
    return WhisperModel(name, device=device, compute_type=compute_type, local_files_only=local_only)


def transcribe(
    video_path: str,
    edit_dir: str,
    *,
    language: str = "zh",
    model_dir: str | None = None,
    device: str = "cpu",
    compute_type: str = "int8",
) -> dict:
    """返回 {"words":[{"text","start","end"}], "language", "has_speech"}。

    落盘缓存 edit_dir/transcripts/<name>.json,源文件(mtime+size)没变则直接读缓存。
    """
    src = Path(video_path)
    cache_dir = Path(edit_dir) / "transcripts"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache = cache_dir / f"{src.stem}.json"

    sig = f"{src.stat().st_mtime_ns}:{src.stat().st_size}"
    if cache.exists():
        try:
            cached = json.loads(cache.read_text())
            if cached.get("_sig") == sig:
                return cached
        except Exception:
            pass

    model = _get_model(model_dir or _DEFAULT_MODEL, device, compute_type)
    segments, info = model.transcribe(
        video_path,
        language=language,
        word_timestamps=True,
        vad_filter=True,  # ★防无语音幻觉(第一道)
    )
    words: list[dict] = []
    for seg in segments:
        # ★第二道防幻觉:VAD 偶尔漏网,摆拍片对着背景音乐会幻听出"啊啊啊/by bwd6"之类垃圾。
        #   用 whisper 自带的置信度挡:no_speech_prob 高(像没人说话)或 avg_logprob 低(模型自己没把握)→ 整段丢。
        if getattr(seg, "no_speech_prob", 0.0) > 0.6 or getattr(seg, "avg_logprob", 0.0) < -1.0:
            continue
        for w in seg.words or []:
            words.append({"text": w.word, "start": round(w.start, 3), "end": round(w.end, 3)})

    result = {
        "_sig": sig,
        "language": getattr(info, "language", language),
        "words": words,
        "has_speech": len(words) > 0,
    }
    cache.write_text(json.dumps(result, ensure_ascii=False))
    return result
