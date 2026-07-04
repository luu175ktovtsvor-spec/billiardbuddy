"""氛围 Planner —— 无口播/摆拍素材(如助教颜值、店面空镜)的"卡点集锦"出方案。

流程(全本地 + 云VLM挑高光):
  素材 → 切候选窗(PySceneDetect 有内切用它,单镜头则定长切窗)
       → 每窗抽 1 帧 → VLM(智谱 GLM-4.6V-Flash)判"这一刻好不好看/值不值得用"
       → 按分挑高光、按原时序排布、相邻窗合并 → add_clip 原子操作 → 时间轴文档(草稿)
  没配 VLM key 时优雅降级:启发式打分(避开头尾、偏中段),整条管线照跑。

产出的是【时间轴文档 + 一份挑选报告】,喂给预览/渲染(共享下游),不直接出黑箱片。
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from ..ffbin import ffmpeg_bin, probe_video
from ..footage_qc import footage_all_bad_message, probe_footage_health
from ..operations import apply_operations
from ..scene_detect import detect_scenes
from ..timeline import Track, new_doc
from ..vlm import score_frames_grid, vlm_available

_GRID_BATCH = 6  # 每张网格图塞几帧:豆包(付费不限流)宜小网格多请求——大网格图慢易超时;智谱(限流)才要塞满

# E4①素材体检降权:废素材(黑屏/冻结)不剔除,只把分打得很低——挑高光时自然排到后面,
# 只有"没别的素材可选"时才会兜底被选中(仍走同一套按分贪心逻辑,不改选择算法本身)。
_FOOTAGE_BAD_PENALTY = 0.15

logger = logging.getLogger(__name__)

# 成片目标比例 → 尺寸
_RATIOS = {
    "9:16": (1080, 1920),
    "1:1": (1080, 1080),
    "16:9": (1920, 1080),
}


def _target_size(ratio: str, first_video: str) -> tuple[int, int]:
    if ratio == "original":
        info = probe_video(first_video)
        return int(info["width"]) or 1080, int(info["height"]) or 1920
    return _RATIOS.get(ratio, _RATIOS["9:16"])


def _candidate_windows(video: str, *, win: float = 2.5, min_win: float = 1.2) -> list[tuple[float, float]]:
    """把一个视频切成候选窗:优先用镜头切点(>1 段);单镜头则按定长切窗。"""
    scenes = detect_scenes(video)
    if len(scenes) > 1:
        # 有真实镜头切:每个镜头本身当一个候选(过长的再切)
        out: list[tuple[float, float]] = []
        for s, e in scenes:
            t = s
            while e - t > win * 1.6:
                out.append((t, t + win))
                t += win
            if e - t >= min_win:
                out.append((t, e))
        return out
    # 单镜头摆拍:定长切窗
    dur = scenes[0][1]
    out = []
    t = 0.0
    while dur - t >= min_win:
        out.append((round(t, 2), round(min(t + win, dur), 2)))
        t += win
    return out


def _extract_frame(video: str, at: float, out_path: str) -> bool:
    """抽某时刻一帧存 jpg。成功返回 True。"""
    try:
        subprocess.run(
            [ffmpeg_bin(), "-y", "-ss", f"{at:.3f}", "-i", video,
             "-frames:v", "1", "-q:v", "3", "-vf", "scale=480:-1", out_path],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        return Path(out_path).exists()
    except subprocess.CalledProcessError:
        return False


def _heuristic_score(idx: int, total: int) -> dict:
    """没 VLM 时的兜底打分:偏中段(头尾常是举起放下手机/愣神),给个确定性分。"""
    mid = (total - 1) / 2 if total > 1 else 0
    closeness = 1 - (abs(idx - mid) / (mid + 1)) if mid else 1
    return {"subject": "未知(启发式)", "quality": round(5 + 3 * closeness, 2),
            "usable": True, "reason": "无VLM,按位置启发式(偏中段)"}


def plan_ambient(
    video_paths: list[str],
    edit_dir: str,
    *,
    ratio: str = "9:16",
    target_duration: float = 16.0,
    grade: str = "warm_cinematic",
    win: float = 2.5,
) -> dict:
    """氛围模式出方案。返回 {doc(JSON), report(挑选明细), used_vlm, project_size}。

    doc 已是可直接渲染/预览的草稿时间轴文档(视频段已挑好排好 + 全局调色)。
    """
    work = Path(edit_dir)
    frames_dir = work / "frames"
    frames_dir.mkdir(parents=True, exist_ok=True)

    used_vlm = vlm_available()
    w, h = _target_size(ratio, video_paths[0])

    # ── E4①素材体检先行(便宜):全废就别继续切窗/抽帧/问VLM了,直接讲清楚"哪些废、为啥" ──
    health_by_vp = {vp: probe_footage_health(vp) for vp in video_paths}
    all_bad_msg = footage_all_bad_message(health_by_vp)
    if all_bad_msg:
        raise RuntimeError(all_bad_msg)

    doc = new_doc(width=w, height=h)
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)

    # ── ① 切候选窗 + 抽帧(所有视频一起,便于网格批量打分) ──
    from ..timeline import MediaRef
    items: list[dict] = []   # 每个候选窗 {clip_idx, media, start, end, win_idx, n_wins, fpath, cache, footage_ok}
    for ci, vp in enumerate(video_paths):
        info = probe_video(vp)
        mid = f"m{ci + 1}"
        doc.media[mid] = MediaRef(src=vp, duration=info["duration_s"], kind="video")
        footage_ok = not health_by_vp[vp]["is_bad"]
        wins = _candidate_windows(vp, win=win)
        for wi, (s, e) in enumerate(wins):
            fpath = str(frames_dir / f"{mid}_w{wi}.jpg")
            _extract_frame(vp, (s + e) / 2, fpath)
            items.append({"clip_idx": ci, "media": mid, "start": s, "end": e,
                          "win_idx": wi, "n_wins": len(wins), "fpath": fpath,
                          "cache": frames_dir / f"{mid}_w{wi}.score.json", "footage_ok": footage_ok})
        logger.info("氛围Planner: %s 切了 %d 个候选窗", Path(vp).name, len(wins))

    # ── ② 打分:缓存命中先取;未命中的按网格批量问 VLM(省限流),失败降级启发式 ──
    todo = [it for it in items if not it["cache"].exists()]
    for b in range(0, len(todo), _GRID_BATCH):
        batch = todo[b:b + _GRID_BATCH]
        grid_scores = score_frames_grid([it["fpath"] for it in batch]) if used_vlm else None
        for k, it in enumerate(batch):
            sc = grid_scores[k] if grid_scores else None
            if sc is not None:
                it["cache"].write_text(json.dumps(sc, ensure_ascii=False))  # 只缓存真VLM

    scored: list[dict] = []
    for it in items:
        if it["cache"].exists():
            sc = json.loads(it["cache"].read_text())
        else:
            sc = _heuristic_score(it["win_idx"], it["n_wins"])  # 降级不缓存,下次重试
        # E4①废素材降权(不剔除):黑屏/冻结的源视频,分打个大折扣——挑高光时自然排到后面,
        # 只有压根没别的素材可选时才会被贪心循环兜底选中(usable 语义仍归 VLM,互不影响)。
        score = sc["quality"] if it["footage_ok"] else sc["quality"] * _FOOTAGE_BAD_PENALTY
        scored.append({
            "clip_idx": it["clip_idx"], "media": it["media"],
            "start": it["start"], "end": it["end"],
            "score": score, "usable": sc["usable"],
            "subject": sc["subject"], "reason": sc["reason"], "win_idx": it["win_idx"],
            "footage_ok": it["footage_ok"],
        })

    # ── ② 挑高光:先毙掉 usable=False,按分数降序贪心选到目标时长,每片设配额防独占 ──
    usable = [x for x in scored if x["usable"]] or scored  # 全被毙则放宽
    per_clip_cap = max(1, int((target_duration / max(1, len(video_paths))) / win) + 1)
    picked: list[dict] = []
    used_secs = 0.0
    clip_count: dict[int, int] = {}
    for x in sorted(usable, key=lambda k: k["score"], reverse=True):
        if used_secs >= target_duration:
            break
        if clip_count.get(x["clip_idx"], 0) >= per_clip_cap:
            continue
        picked.append(x)
        used_secs += x["end"] - x["start"]
        clip_count[x["clip_idx"]] = clip_count.get(x["clip_idx"], 0) + 1

    # ── ③ 按原时序排布(片序→片内时间),相邻同片窗合并成一段(避免无意义硬切) ──
    picked.sort(key=lambda k: (k["clip_idx"], k["start"]))
    merged: list[dict] = []
    for x in picked:
        if merged and merged[-1]["media"] == x["media"] and abs(merged[-1]["end"] - x["start"]) < 0.05:
            merged[-1]["end"] = x["end"]
        else:
            merged.append(dict(x))

    # ── ④ 落成时间轴文档:add_clip + 全局调色 ──
    ops = [{"op": "add_clip", "track": "v", "media": x["media"],
            "src_in": x["start"], "src_out": x["end"]} for x in merged]
    ops.append({"op": "set_grade", "grade": grade})
    new_d, errs = apply_operations(doc, ops)
    if errs:
        logger.error("氛围Planner 落文档失败:%s", errs)
        raise RuntimeError("氛围出方案失败:" + "；".join(errs))

    report = {
        "used_vlm": used_vlm,
        "total_windows": len(scored),
        "picked": [
            {"media": x["media"], "start": x["start"], "end": x["end"],
             "score": x["score"], "subject": x["subject"], "reason": x["reason"],
             "footage_ok": x["footage_ok"]}
            for x in merged
        ],
        "duration": new_d.duration(),
        "ratio": ratio, "size": f"{w}x{h}",
        # E4①②:素材体检结果透明暴露(mid→health)——确认/渲染前让用户能看到"哪些素材有问题"。
        "footage_health": {mid: health_by_vp[m.src] for mid, m in doc.media.items()},
    }
    # 完整候选池(所有打过分的窗口·带源路径)——供"对话换段/加段"从中挑替代。
    pool = [
        {"media": x["media"], "src": doc.media[x["media"]].src,
         "start": x["start"], "end": x["end"], "score": x["score"],
         "subject": x["subject"], "usable": x["usable"], "footage_ok": x["footage_ok"]}
        for x in scored
    ]
    return {"doc": new_d.model_dump(), "report": report,
            "used_vlm": used_vlm, "size": (w, h), "pool": pool, "grade": grade}
