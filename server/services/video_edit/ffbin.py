"""解析 ffmpeg/ffprobe 二进制路径 + 探视频规格。

铁律1/2:系统不一定装命令行 ffmpeg,产品打包也只能用内置二进制。
解析顺序:env(打包时由 electron 注入) > 项目内置(ffmpeg-static/ffprobe-static) > python 包自带(imageio_ffmpeg)。
ffmpeg-static 不含 ffprobe,所以 ffprobe 走 ffprobe-static(desktop 侧 npm 包)。
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
from functools import lru_cache
from pathlib import Path

# 仓库根 = server/services/video_edit/ffbin.py 往上 4 层
_REPO_ROOT = Path(__file__).resolve().parents[3]


def _plat_arch() -> tuple[str, str]:
    """返回 (platform, arch),对齐 ffprobe-static 的目录命名(darwin/win32/linux + x64/arm64)。"""
    sysname = {"Darwin": "darwin", "Windows": "win32", "Linux": "linux"}.get(
        platform.system(), platform.system().lower()
    )
    machine = platform.machine().lower()
    arch = "arm64" if machine in ("arm64", "aarch64") else "x64"
    return sysname, arch


@lru_cache(maxsize=1)
def ffmpeg_bin() -> str:
    """可用的 ffmpeg 路径。env FFMPEG_BIN > 内置 ffmpeg-static > imageio_ffmpeg 自带。"""
    env = os.environ.get("FFMPEG_BIN")
    if env and Path(env).exists():
        return env
    # 项目内置 ffmpeg-static(desktop 侧)
    static = _REPO_ROOT / "desktop" / "node_modules" / "ffmpeg-static" / "ffmpeg"
    if static.exists():
        return str(static)
    # 兜底:imageio_ffmpeg 自带的二进制(随 PyInstaller 一起打包)
    import imageio_ffmpeg

    return imageio_ffmpeg.get_ffmpeg_exe()


@lru_cache(maxsize=1)
def ffprobe_bin() -> str:
    """可用的 ffprobe 路径。env FFPROBE_BIN > 内置 ffprobe-static > PATH。"""
    env = os.environ.get("FFPROBE_BIN")
    if env and Path(env).exists():
        return env
    sysname, arch = _plat_arch()
    static = (
        _REPO_ROOT
        / "desktop"
        / "node_modules"
        / "ffprobe-static"
        / "bin"
        / sysname
        / arch
        / ("ffprobe.exe" if sysname == "win32" else "ffprobe")
    )
    if static.exists():
        return str(static)
    from shutil import which

    found = which("ffprobe")
    if found:
        return found
    raise FileNotFoundError(
        "找不到 ffprobe:设 env FFPROBE_BIN,或在 desktop 装 ffprobe-static(npm i ffprobe-static)"
    )


_HDR_TRANSFERS = {"smpte2084", "arib-std-b67"}  # PQ(HDR10) 和 HLG


def probe_video(path: str) -> dict:
    """ffprobe 探规格,返回 {width,height,duration_s,fps,codec,color_transfer,is_hdr,is_portrait}。"""
    out = subprocess.run(
        [
            ffprobe_bin(),
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,r_frame_rate,codec_name,color_transfer",
            "-show_entries", "format=duration",
            "-of", "json",
            path,
        ],
        capture_output=True, text=True, check=True,
    )
    data = json.loads(out.stdout)
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format") or {}
    w = int(stream.get("width") or 0)
    h = int(stream.get("height") or 0)
    # r_frame_rate 形如 "30000/1001"
    rate = stream.get("r_frame_rate") or "0/1"
    try:
        num, den = rate.split("/")
        fps = round(float(num) / float(den), 3) if float(den) else 0.0
    except Exception:
        fps = 0.0
    ct = stream.get("color_transfer") or ""
    return {
        "width": w,
        "height": h,
        "duration_s": round(float(fmt.get("duration") or 0.0), 3),
        "fps": fps,
        "codec": stream.get("codec_name") or "",
        "color_transfer": ct,
        "is_hdr": ct in _HDR_TRANSFERS,
        "is_portrait": h > w,
    }
