"""程序化卡点 BGM 合成 —— 纯 numpy 生成,免费、无版权、离线。

给氛围/燃剪片配一段"电子鼓点 + 贝斯 + 随进度增强"的背景乐,节拍固定(默认 0.5s/拍),
成片挑段时按这个拍点卡更带感。不依赖任何外部音乐库/素材(避 CC-BY-NC 授权坑)。
"""
from __future__ import annotations

import struct
import wave
from pathlib import Path

import numpy as np

SR = 44100          # 采样率
BEAT = 0.5          # 每拍秒数(120 BPM)
_SCALE = [220.0, 261.63, 329.63, 392.0, 440.0]  # A小调五音,点缀用


# 情绪 → (拍长, 能量系数)。慢=拍长能量低;嗨=拍快能量高。对话"换个慢的/嗨的"就是切这个。
_MOODS = {
    "chill": (0.62, 0.75),
    "auto": (0.50, 1.0),
    "none": (0.50, 1.0),
    "hype": (0.42, 1.25),
}


def beat_for_mood(mood: str) -> float:
    """该情绪下的拍长(秒)。给"卡点"用——把镜头切点吸附到这个网格,切点就落在鼓点上。"""
    return _MOODS.get(mood, _MOODS["auto"])[0]


def synth_beat_bgm(total_s: float, out_path: str, *, sr: int = SR, beat: float = BEAT,
                   mood: str = "auto", key: int = 0) -> str:
    """合成 total_s 秒的卡点 BGM,写成 16bit 单声道 wav,返回路径。

    mood: chill(慢·柔) / auto / hype(快·嗨) —— 对话"换个慢的/嗨点"切这个。
    key: 0-11 半音移调 —— 不同片子给不同 key,音乐不重样(导演按内容定)。
    结构(随进度 pr=0→1 逐渐加料,前松后紧):
      每拍 = 底鼓(下滑正弦)+ 贝斯 + 和弦垫;中后段加 hi-hat 噪声、上行点缀、反拍军鼓。
    """
    beat, energy = _MOODS.get(mood, _MOODS["auto"])
    kmul = 2.0 ** ((int(key) % 12) / 12.0)   # 移调系数
    n = int(sr * (total_s + 0.3))
    a = np.zeros(n, dtype=np.float64)

    def put(i: int, x: np.ndarray, g: float) -> None:
        e = min(len(a), i + len(x))
        if e > i:
            a[i:e] += x[: e - i] * g

    def env(length: float, decay: float) -> np.ndarray:
        return np.exp(-np.linspace(0, decay, int(length * sr)))

    for k, bt in enumerate(np.arange(0, total_s, beat)):
        pr = bt / max(total_s, 1e-6)
        i0 = int(bt * sr)
        # 底鼓:120→50Hz 下滑
        x = np.linspace(0, 0.16, int(0.16 * sr))
        put(i0, np.sin(2 * np.pi * np.linspace(120, 50, len(x)) * x) * env(0.16, 7), 0.85)
        # 贝斯:55Hz(按 key 移调)
        x2 = np.linspace(0, beat * 0.9, int(beat * 0.9 * sr))
        put(i0, np.sin(2 * np.pi * 55 * kmul * x2) * env(beat * 0.9, 2.5), 0.3)
        # 和弦垫(随进度渐强·按 key 移调)
        xp = np.linspace(0, beat, int(beat * sr))
        put(i0, sum(np.sin(2 * np.pi * f * kmul * xp) for f in (110, 164.8, 220)) * np.hanning(len(xp)), 0.05 + 0.05 * pr)
        # hi-hat(能量越高越早进)
        if pr > 0.3 / energy:
            put(int((bt + beat / 2) * sr), (np.random.rand(int(0.045 * sr)) * 2 - 1) * env(0.045, 35), 0.2 * pr)
        # 上行点缀(后段)
        if pr > 0.5 / energy:
            xa = np.linspace(0, beat * 0.45, int(beat * 0.45 * sr))
            put(int((bt + beat / 2) * sr), np.sin(2 * np.pi * _SCALE[k % 5] * kmul * xa) * env(beat * 0.45, 6), 0.15)
        # 反拍军鼓(高潮)
        if pr > 0.55 / energy and k % 2 == 1:
            put(i0, (np.random.rand(int(0.11 * sr)) * 2 - 1) * env(0.11, 10), 0.35)

    a = a / (np.max(np.abs(a)) + 1e-6) * 0.95   # 归一化防削波
    Path(out_path).parent.mkdir(parents=True, exist_ok=True)
    with wave.open(out_path, "w") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b"".join(struct.pack("<h", int(v * 32767)) for v in a))
    return out_path
