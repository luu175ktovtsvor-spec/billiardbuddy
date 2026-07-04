"""素材/成片质量体检 —— 纯 ffmpeg filter 探测(blackdetect/freezedetect/silencedetect),零 token(E4①⑤)。

两道门共用同一套探测原语(黑/冻/静音各自"命中时长占比"的解析器),ffmpeg 二进制照样只经 ffbin 拿:

  - probe_footage_health()  素材入库前体检(inventory_footage / plan_ambient / plan_speech 用候选前调)。
    只按【视觉】黑/冻的占比判"是否废"——静音只报占比,不参与判废:氛围素材本就常年没有效人声、
    渲染时原声整段会被 BGM 顶替(template_render.render_v2 只 `-map 1:a`),拿"没声音"惩罚会误伤
    好画面;口播线本身靠 whisper 的 has_speech 判断有没有话可用,这里的 silence_ratio 只做透明展示。
  - probe_render_health()   渲染后成片体检(render_timeline / render_v2_project 渲染返回后调)。
    这时是最终成片:时长要跟 plan/EDL 预期对得上、不该有意外黑段、不该整片静音、首帧不能纯黑(封面)。
  - guarded_render()        渲染 → 体检 → 红就用同一份渲染函数重渲一次 → 仍红也不再重渲(带问题清单交回)。
  - footage_all_bad_message() 一批素材如果全部判废,给一句大白话汇总(调用方据此别硬剪、抛错交给用户)。
"""
from __future__ import annotations

import logging
import re
import subprocess
from pathlib import Path
from typing import Callable

from .ffbin import ffmpeg_bin, ffprobe_bin, probe_video

logger = logging.getLogger(__name__)

# ── 体检阈值(全 ffmpeg 确定性检查,数值凭经验定;发现不合适可调,别改判断结构) ──
# 素材入库门(门①):整段黑/冻占比够高才判废——阈值定高一点(0.85),只抓"这段基本没法用"的真废料,
# 别把"有几秒黑场转场/短暂停顿"的正常素材也误杀。
BLACK_RATIO_BAD = 0.85
FREEZE_RATIO_BAD = 0.85
SILENCE_RATIO_FLAG = 0.95   # 仅报告用,不参与 is_bad(见模块说明)

# 渲染后体检门(门⑤):成片是"最终交付物",标准比原始素材严得多。
RENDER_BLACK_RATIO_BAD = 0.03    # 成片≥3%时长黑屏就算红(转场几帧黑场不算,真正大段黑场才算)
RENDER_SILENCE_RATIO_BAD = 0.95  # 成片≥95%时长静音算红(基本等于整片哑巴)
DURATION_TOL_ABS = 0.5           # 时长容差:绝对 ±0.5s
DURATION_TOL_RATIO = 0.05        # 或 ±5%,取二者较大值


# ── ffmpeg filter 事件解析(blackdetect/freezedetect/silencedetect 打印在 stderr) ──

_BLACK_START_RE = re.compile(r"black_start:\s*(-?[\d.]+)")
_BLACK_DUR_RE = re.compile(r"black_duration:\s*([\d.]+)")
_FREEZE_START_RE = re.compile(r"freeze_start:\s*(-?[\d.]+)")
_FREEZE_DUR_RE = re.compile(r"freeze_duration:\s*([\d.]+)")
_SILENCE_START_RE = re.compile(r"silence_start:\s*(-?[\d.]+)")
_SILENCE_DUR_RE = re.compile(r"silence_duration:\s*([\d.]+)")


def _parse_interval_seconds(stderr: str, *, start_re: re.Pattern, dur_re: re.Pattern,
                            total_duration: float) -> float:
    """解析"xxx_start/xxx_duration"事件行,返回命中区间总时长(秒)。

    ffmpeg 的这几个 filter 通常在区间结束时才打印(如 blackdetect/silencedetect 连结尾都会补发);
    但 freezedetect 实测(ffmpeg 6.0)如果冻结/黑/静音一路到片尾,不一定补发结束事件——只有 start
    没有配对的 duration。这种"最后一个 start 没等到 end"的情况,按 total_duration 兜底补齐这一段,
    不然会漏判"整段都黑/冻/静音"这种最该抓的场景。
    """
    starts = [float(s) for s in start_re.findall(stderr)]
    durs = [float(d) for d in dur_re.findall(stderr)]
    total = sum(durs)
    if len(starts) > len(durs):
        total += max(0.0, total_duration - starts[-1])
    return round(total, 3)


def _ffmpeg_null_run(path: str, *, vf: str | None = None, af: str | None = None,
                      timeout: float = 120.0) -> str:
    """跑一遍 ffmpeg -f null(不产出文件,只要 filter 打在 stderr 的探测事件)。超时/探测失败→ 空字符串
    (调用方据此当作"没探到异常",不因为一个探测失败拖垮整条体检流水线)。"""
    cmd = [ffmpeg_bin(), "-y", "-i", path]
    if vf:
        cmd += ["-vf", vf, "-an"]
    if af:
        cmd += ["-af", af, "-vn"]
    cmd += ["-f", "null", "-"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.warning("ffmpeg 探测失败,该项质量体检降级为“未探测到异常”:path=%s vf=%s af=%s %s: %s",
                        path, vf, af, type(e).__name__, e)
        return ""
    return r.stderr or ""


def _has_audio_stream(path: str) -> bool:
    try:
        r = subprocess.run(
            [ffprobe_bin(), "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=index", "-of", "csv=p=0", path],
            capture_output=True, text=True, timeout=30.0,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.warning("ffprobe 探测音轨失败,降级判定为“无音轨”:path=%s %s: %s",
                        path, type(e).__name__, e)
        return False
    return bool((r.stdout or "").strip())


def _black_ratio(path: str, dur: float) -> float:
    """跑一遍 blackdetect,返回黑屏命中时长占全片时长的比例——门①②共用同一套探测+解析,别各写一遍。"""
    black_s = _parse_interval_seconds(
        _ffmpeg_null_run(path, vf="blackdetect=d=0.1:pic_th=0.98"),
        start_re=_BLACK_START_RE, dur_re=_BLACK_DUR_RE, total_duration=dur,
    )
    return round(black_s / dur, 4) if dur else 0.0


def _first_frame_black(path: str) -> bool:
    """首帧是否纯黑(blackframe:pblack>=98 才会打印这行;没打印=首帧不是纯黑)。"""
    try:
        r = subprocess.run(
            [ffmpeg_bin(), "-y", "-i", path, "-vf", r"select=eq(n\,0),blackframe=98",
             "-frames:v", "1", "-an", "-f", "null", "-"],
            capture_output=True, text=True, timeout=30.0,
        )
    except (subprocess.TimeoutExpired, OSError) as e:
        logger.warning("ffmpeg 探测首帧是否纯黑失败,降级判定为“首帧不黑”:path=%s %s: %s",
                        path, type(e).__name__, e)
        return False
    return "blackframe" in (r.stderr or "") and "pblack:" in (r.stderr or "")


# ── 门①:素材入库前体检 ──

def probe_footage_health(path: str, *, info: dict | None = None,
                          black_ratio_bad: float = BLACK_RATIO_BAD,
                          freeze_ratio_bad: float = FREEZE_RATIO_BAD) -> dict:
    """一个素材(源视频文件)整体体检:黑屏/冻结/静音各自占全片时长的比例 + 是否判废 + 大白话原因。

    只按视觉(黑/冻)判 is_bad;静音只报比例、不独立判废(理由见模块顶部说明)。

    info: 调用方若已探过 probe_video(path)(如 inventory_footage/plan_ambient/plan_speech 主循环
    里为取 duration/is_portrait 各建媒体登记而调),可把结果传进来复用,省一次 ffprobe(纯性能优化,
    不改判定逻辑)。不传则内部自己探一次(兼容旧调用)。
    """
    info = info if info is not None else probe_video(path)
    dur = float(info.get("duration_s") or 0.0)

    black_ratio = _black_ratio(path, dur)
    freeze_s = _parse_interval_seconds(
        _ffmpeg_null_run(path, vf="freezedetect=n=-60dB:d=0.5"),
        start_re=_FREEZE_START_RE, dur_re=_FREEZE_DUR_RE, total_duration=dur,
    )
    has_audio = _has_audio_stream(path)
    silence_s = 0.0
    if has_audio:
        silence_s = _parse_interval_seconds(
            _ffmpeg_null_run(path, af="silencedetect=n=-30dB:d=0.5"),
            start_re=_SILENCE_START_RE, dur_re=_SILENCE_DUR_RE, total_duration=dur,
        )

    freeze_ratio = round(freeze_s / dur, 4) if dur else 0.0
    silence_ratio = round(silence_s / dur, 4) if (dur and has_audio) else 0.0

    mostly_black = black_ratio >= black_ratio_bad
    mostly_frozen = freeze_ratio >= freeze_ratio_bad
    mostly_silent = has_audio and silence_ratio >= SILENCE_RATIO_FLAG

    reasons: list[str] = []
    if mostly_black:
        reasons.append(f"大面积黑屏(占比{black_ratio * 100:.0f}%)")
    if mostly_frozen:
        reasons.append(f"画面基本冻结/无运动(占比{freeze_ratio * 100:.0f}%)")
    is_bad = mostly_black or mostly_frozen
    if mostly_silent and not is_bad:
        reasons.append("整段基本没声音(仅供参考,不影响是否可用)")

    return {
        "duration_s": dur,
        "black_ratio": black_ratio, "freeze_ratio": freeze_ratio, "silence_ratio": silence_ratio,
        "has_audio": has_audio,
        "mostly_black": mostly_black, "mostly_frozen": mostly_frozen, "mostly_silent": mostly_silent,
        "is_bad": is_bad, "reasons": reasons,
    }


def silence_intervals(path: str, *, info: dict | None = None) -> list[tuple[float, float]]:
    """静音区间列表(源文件时间轴,秒)——给字幕门③"字幕是否落在静音区间里"用。

    跟 probe_footage_health() 里 silence_ratio 用**同一套**探测(同一个 af 参数
    `silencedetect=n=-30dB:d=0.5`、同一对正则),只是这里要精确区间而不是"占比数字"
    (判断"一条字幕是否整段落在静音里"必须有区间,光有比例不够)——别为这个另起一套 filter/阈值。
    """
    info = info if info is not None else probe_video(path)
    dur = float(info.get("duration_s") or 0.0)
    if not _has_audio_stream(path):
        return []
    stderr = _ffmpeg_null_run(path, af="silencedetect=n=-30dB:d=0.5")
    starts = [float(s) for s in _SILENCE_START_RE.findall(stderr)]
    durs = [float(d) for d in _SILENCE_DUR_RE.findall(stderr)]
    intervals: list[tuple[float, float]] = []
    for i, s in enumerate(starts):
        if i < len(durs):
            intervals.append((round(s, 3), round(s + durs[i], 3)))
        else:
            # 最后一段静音一路到片尾,ffmpeg 没补发结束事件——按总时长兜底(同 _parse_interval_seconds)。
            intervals.append((round(s, 3), round(dur, 3)))
    return intervals


def footage_all_bad_message(paths_health: dict[str, dict]) -> str | None:
    """一批素材(path→health)如果全部判废,给一句大白话汇总;否则 None(还有能用的,不阻断)。"""
    if not paths_health or not all(h["is_bad"] for h in paths_health.values()):
        return None
    parts = [f"{Path(p).name}({'、'.join(h['reasons']) or '质量不合格'})" for p, h in paths_health.items()]
    return ("这些素材看起来都有问题,没法出方案:" + "；".join(parts) +
            "。换几段能看清画面、没冻屏的素材再试。")


# ── 门⑤:渲染后成片体检 ──

def probe_render_health(path: str, *, expected_duration: float | None = None,
                         black_ratio_bad: float = RENDER_BLACK_RATIO_BAD,
                         silence_ratio_bad: float = RENDER_SILENCE_RATIO_BAD,
                         duration_tol_abs: float = DURATION_TOL_ABS,
                         duration_tol_ratio: float = DURATION_TOL_RATIO) -> dict:
    """成片体检:时长是否对得上预期、有没有异常黑段、是不是整片静音、首帧是否纯黑。"""
    info = probe_video(path)
    dur = float(info.get("duration_s") or 0.0)

    black_ratio = _black_ratio(path, dur)

    has_audio = _has_audio_stream(path)
    silence_ratio = 0.0
    if has_audio:
        silence_s = _parse_interval_seconds(
            _ffmpeg_null_run(path, af="silencedetect=n=-30dB:d=0.5"),
            start_re=_SILENCE_START_RE, dur_re=_SILENCE_DUR_RE, total_duration=dur,
        )
        silence_ratio = round(silence_s / dur, 4) if dur else 0.0

    first_black = _first_frame_black(path)

    reasons: list[str] = []
    duration_ok = True
    duration_diff = None
    if expected_duration is not None and expected_duration > 0:
        duration_diff = round(abs(dur - expected_duration), 3)
        tol = max(duration_tol_abs, duration_tol_ratio * expected_duration)
        duration_ok = duration_diff <= tol
        if not duration_ok:
            reasons.append(f"时长对不上:成片{dur:.1f}s,预期{expected_duration:.1f}s")

    black_bad = black_ratio >= black_ratio_bad
    if black_bad:
        reasons.append(f"成片有异常黑段(占比{black_ratio * 100:.0f}%)")

    silence_bad = has_audio and silence_ratio >= silence_ratio_bad
    if silence_bad:
        reasons.append("成片几乎全程没声音")

    if first_black:
        reasons.append("首帧是纯黑,封面不能用")

    ok = duration_ok and not black_bad and not silence_bad and not first_black
    return {
        "duration_s": dur, "expected_duration": expected_duration, "duration_diff": duration_diff,
        "duration_ok": duration_ok,
        "black_ratio": black_ratio, "silence_ratio": silence_ratio, "has_audio": has_audio,
        "first_frame_black": first_black,
        "ok": ok, "reasons": reasons,
    }


def guarded_render(render_fn: Callable[[], str], *, expected_duration: float | None = None) -> dict:
    """渲染一次 → 体检 → 红就用同一个 render_fn 重渲一次 → 仍红也不再重渲(避免无限重渲拖死出片)。

    返回 {path, health, rerendered}。render_fn 是零参数 callable,返回渲成的文件路径
    (调用方拿闭包捕获 EDL/doc/out_path 等,渲染管线本身(render_edl/render_v2)一行不改)。
    """
    path = render_fn()
    health = probe_render_health(path, expected_duration=expected_duration)
    rerendered = False
    if not health["ok"]:
        path = render_fn()
        health = probe_render_health(path, expected_duration=expected_duration)
        rerendered = True
    return {"path": path, "health": health, "rerendered": rerendered}
