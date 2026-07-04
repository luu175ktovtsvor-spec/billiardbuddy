"""口播 Planner —— 有人对镜说话的片子(获客型/产品卖点)的独立业务线。

与氛围线"干净分裂"(只在出方案这层分,下面文档/预览共享):
  素材 → whisper 转录(已有,带幻觉过滤) → 按说的话挑段(合并成 3-6s 讲话片段)
       → 排进时间轴 → 口播自动配字幕(说的话烧成字幕) → add_clip 文档(草稿)
口播出片走【现有 render_timeline】(保留原声 + 烧字幕),不走 V2 花哨模板——口播要清楚、别抢话。

E5①内容化挑段:不再是"按转写顺序取够时长就停"的零内容判断,改成把全部讲话片段喂 LLM
(复用 director.chat_json,同一条网关通道),按钩子(hook)/价值(value)/完整性(completeness)
打分挑段——只挑整段(不切句子边界)、开头优先放最强钩子段、控制在目标时长附近。
chat_json 失败/无网关配置 → 回退成"顺序取够时长就停"(与升级前完全一致的确定性行为),
保证 VLM/LLM 全挂时口播管线依然能出片,不崩不返空。
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)

Segment = tuple[str, float, float, str]   # (media_id, start, end, text)


def _score_segments_llm(segments: list[Segment]) -> dict[int, dict] | None:
    """把全部讲话片段喂 LLM,按钩子/价值/完整性各打 0-10 分。复用 director.chat_json(已网关化)。

    返回 {原始下标: {"hook","value","completeness"}};chat_json 失败/回复不合法/一条都解析不出
    → None,调用方(_pick_speech_segments)据此回退到确定性的"顺序取够时长"。
    """
    if not segments:
        return None
    from ..director import chat_json   # 延迟导入:与 auto_plan_v2 里同款写法,方便测试 monkeypatch

    lines = [f"{i}. [{b - a:.1f}s] {t}" for i, (_m, a, b, t) in enumerate(segments)]
    prompt = (
        "你在帮口播短视频(获客/带货口播)从转写里挑最值得保留的讲话片段。下面每条已经是一句完整的话,"
        "按出现顺序编号,不能再拆分、不能改字:\n" + "\n".join(lines) + "\n\n"
        "给每一段打三个分(0到10整数):\n"
        "hook=开场吸引力(让人想继续看下去,片头尤其看重);\n"
        "value=信息量/卖点价值(实用干货、优惠、亮点越多越高);\n"
        "completeness=是不是一句完整表达(掐头去尾/说一半的给低分)。\n"
        f"只回一个 JSON,不要解释、不要```包裹:\n"
        '{"scores":[{"index":0,"hook":0,"value":0,"completeness":0}, ...]}'
        f"(scores 长度正好 {len(segments)},顺序不限但 index 要对应上面的编号)"
    )
    data = chat_json(prompt, timeout=60)
    if not isinstance(data, dict) or not isinstance(data.get("scores"), list):
        return None

    def _clip10(v: object) -> float:
        try:
            return max(0.0, min(10.0, float(v)))  # type: ignore[arg-type]
        except (TypeError, ValueError):
            return 0.0

    out: dict[int, dict] = {}
    for item in data["scores"]:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        if not (0 <= idx < len(segments)):
            continue
        out[idx] = {"hook": _clip10(item.get("hook")), "value": _clip10(item.get("value")),
                    "completeness": _clip10(item.get("completeness"))}
    return out or None


def _pick_by_order(segments: list[Segment], target_duration: float) -> list[Segment]:
    """确定性兜底:按转写出现的原始顺序取,凑够 target_duration 就停(升级前的原行为,一字不变)。"""
    picked: list[Segment] = []
    used = 0.0
    for seg in segments:
        if used >= target_duration:
            break
        picked.append(seg)
        used += seg[2] - seg[1]
    return picked


def _pick_speech_segments(segments: list[Segment], target_duration: float) -> list[Segment]:
    """E5①内容化挑段:LLM 按钩子/价值/完整性打分 → 按总分挑到目标时长附近(整句不切)→
    开头优先放钩子分最高的一段,其余保持原时序。LLM 不可用/回复不合法 → 回退顺序取。
    """
    scores = _score_segments_llm(segments)
    if scores is None:
        return _pick_by_order(segments, target_duration)

    enriched = [
        {"idx": i, "seg": seg, **scores.get(i, {"hook": 0.0, "value": 0.0, "completeness": 0.0})}
        for i, seg in enumerate(segments)
    ]
    for e in enriched:
        e["total"] = e["hook"] + e["value"] + e["completeness"]

    picked: list[dict] = []
    used = 0.0
    for item in sorted(enriched, key=lambda x: x["total"], reverse=True):
        if used >= target_duration:
            break
        picked.append(item)
        used += item["seg"][2] - item["seg"][1]

    if not picked:   # 打分全 0/挑空了——保底留一段,别让口播线出空片
        picked = [enriched[0]]

    leader = max(picked, key=lambda x: x["hook"])         # 开头优先强钩子段
    rest = sorted((p for p in picked if p is not leader), key=lambda x: x["idx"])  # 其余保持原时序
    return [p["seg"] for p in ([leader] + rest)]


def plan_speech(
    video_paths: list[str],
    edit_dir: str,
    *,
    ratio: str = "9:16",
    target_duration: float = 30.0,
    language: str = "zh",
    max_seg: float = 6.0,
    bgm: bool = False,
) -> dict:
    """口播模式出方案:转录 → 内容化挑讲话片段(E5①) → 排布 → 自动配字幕。返回 {doc, report, has_speech}。

    出片走 render_timeline(保留原声 + 烧字幕)。没识别到口播则抛错(引导改用氛围模式)。
    bgm(E5④,默认 False):True 时给成片额外挂一条程序化配乐,配合 render_timeline 的
    voice_over_music 接线——保留口播原声的同时垫 BGM;默认 False 时行为与升级前完全一致(纯 keep)。
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

    # ── E5①内容化挑段(钩子/价值/完整性打分;LLM 失败回退顺序取,见函数内说明) ──
    picked = _pick_speech_segments(segments, target_duration)

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

    # ── E5④口播+BGM 可达性接线(default-off,不碰 timeline.py):bgm=True 才给 doc 挂配乐媒体 +
    # set_music——doc 同时有口播字幕 + music 时,render_timeline 会把 audio_mode 覆写成
    # voice_over_music(E4-U2 已建好的混音引擎),口播原声不会被这条配乐整段替换掉。
    # bgm=False(默认)完全不碰 doc.music,行为与升级前一字不变(纯 keep)。
    if bgm:
        from ..bgm import synth_beat_bgm

        bgm_path = str(Path(edit_dir) / "speech_bgm.wav")
        dur = max(doc.duration(), 1.0)
        synth_beat_bgm(dur, bgm_path, mood="chill")   # 口播垫底配乐用柔和拍子,别抢话
        music_ops = [
            {"op": "add_media", "id": "bgm", "src": bgm_path, "duration": dur, "kind": "audio"},
            {"op": "set_music", "media": "bgm"},
        ]
        doc, merr = apply_operations(doc, music_ops)
        if merr:
            logger.warning("口播BGM挂载失败,回退纯口播(keep):%s", merr)

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
