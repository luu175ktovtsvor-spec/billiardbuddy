"""口播 Planner —— 有人对镜说话的片子(获客型/产品卖点)的独立业务线。

与氛围线"干净分裂"(只在出方案这层分,下面文档/预览共享):
  素材 → whisper 转录(已有,带幻觉过滤) → 按说的话挑段(合并成 3-6s 讲话片段)
       → 排进时间轴 → 口播自动配字幕(说的话烧成字幕) → add_clip 文档(草稿)
口播出片走【现有 render_timeline】(保留原声 + 烧字幕),不走 V2 花哨模板——口播要清楚、别抢话。
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def plan_speech(
    video_paths: list[str],
    edit_dir: str,
    *,
    ratio: str = "9:16",
    target_duration: float = 30.0,
    language: str = "zh",
    max_seg: float = 6.0,
) -> dict:
    """口播模式出方案:转录 → 按说的话挑讲话片段 → 排布 → 自动配字幕。返回 {doc, report, has_speech}。

    出片走 render_timeline(保留原声 + 烧字幕)。没识别到口播则抛错(引导改用氛围模式)。
    """
    from ..assemble import _phrase_cues, auto_captions_from_speech, validate_captions_for_doc
    from ..ffbin import probe_video
    from ..footage_qc import footage_all_bad_message, probe_footage_health
    from ..operations import apply_operations
    from ..timeline import MediaRef, Track, new_doc
    from ..transcribe import transcribe
    from .ambient import _target_size

    w, h = _target_size(ratio, video_paths[0])
    doc = new_doc(width=w, height=h)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)

    # ── E4①素材体检:全废(黑屏/冻结)就别再折腾了,直接讲清楚"哪些废、为啥"。
    # 没全废的话,废素材不剔除——只把它们排到"按顺序取够时长就停"这个队列的后面,让健康的素材
    # 优先被用上(仍是同一套顺序取算法,只改了处理顺序,不改算法本身——挑段智能化是 E5①的事)。
    health_by_ci = {ci: probe_footage_health(vp) for ci, vp in enumerate(video_paths)}
    all_bad_msg = footage_all_bad_message({video_paths[ci]: h for ci, h in health_by_ci.items()})
    if all_bad_msg:
        raise RuntimeError(all_bad_msg)
    order = sorted(range(len(video_paths)), key=lambda i: health_by_ci[i]["is_bad"])  # 稳定排序,健康的排前面

    # ── 转录 + 把词级 → 讲话片段(相邻短语间隔<1s、单段≤max_seg 合并)──
    segments: list[tuple[str, float, float, str]] = []   # (mid, start, end, text)
    for ci in order:
        vp = video_paths[ci]
        info = probe_video(vp)
        mid = f"m{ci + 1}"
        doc.media[mid] = MediaRef(src=vp, duration=info["duration_s"], kind="video")
        tr = transcribe(vp, edit_dir, language=language)
        if not tr.get("has_speech"):
            continue
        for a, b, text in _phrase_cues(tr.get("words", [])):
            if (segments and segments[-1][0] == mid
                    and a - segments[-1][2] < 1.0 and (b - segments[-1][1]) <= max_seg):
                m0, s0, _e0, t0 = segments[-1]
                segments[-1] = (m0, s0, b, t0 + text)
            else:
                segments.append((mid, a, b, text))

    if not segments:
        raise RuntimeError("这些片子没识别到口播(可能没人说话)。口播模式需要有人对镜讲话,试试氛围模式。")

    # ── 按原顺序挑到目标时长 ──
    picked: list[tuple[str, float, float, str]] = []
    used = 0.0
    for seg in segments:
        if used >= target_duration:
            break
        picked.append(seg)
        used += seg[2] - seg[1]

    ops = [{"op": "add_clip", "track": "v", "media": m, "src_in": a, "src_out": b} for (m, a, b, _t) in picked]
    doc, errs = apply_operations(doc, ops)
    if errs:
        raise RuntimeError("口播出方案失败:" + "；".join(errs))

    # ── 口播自动配字幕(说的话对齐成片时间轴)──
    cap_ops = auto_captions_from_speech(doc, edit_dir, track="sub")
    if cap_ops:
        doc, cerr = apply_operations(doc, cap_ops)
        if cerr:
            logger.warning("口播配字幕部分失败:%s", cerr)

    # ── E4③字幕门:出方案阶段就体检(字速/静音错位/时间戳重叠),让用户在渲染前就能看到问题 ──
    caption_health = validate_captions_for_doc(doc) if doc.caption_clips() else {"cues": [], "problems": [], "ok": True}

    report = {
        "mode": "speech",
        "segments": len(picked),
        "duration": round(doc.duration(), 1),
        "ratio": ratio, "size": f"{w}x{h}",
        "quotes": [t.strip()[:24] for (_m, _a, _b, t) in picked],
        # E4①②:素材体检结果透明暴露(mid→health)——确认/渲染前让用户能看到"哪些素材有问题"。
        "footage_health": {f"m{ci + 1}": health_by_ci[ci] for ci in range(len(video_paths))},
        # E4③:字幕体检结果透明暴露(字速/静音错位/时间戳重叠,红的只标记不改字)。
        "caption_health": caption_health,
    }
    return {"doc": doc.model_dump(), "report": report, "has_speech": True}
