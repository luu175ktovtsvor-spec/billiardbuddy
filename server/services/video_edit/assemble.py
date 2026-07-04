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
from .footage_qc import footage_all_bad_message, guarded_render, probe_footage_health
from .operations import apply_operations
from .render import render_edl
from .scene_detect import detect_scenes
from .subtitles import _ts
from .timeline import MediaRef, Track, new_doc, TimelineDoc


def inventory_footage(video_paths: list[str], edit_dir: str, *, language: str = "zh") -> dict:
    """理解素材(只读):每个视频转写 + 切镜头,产出给 AI 读的候选菜单 + 已登记媒体的草稿文档。

    返回 {"packed": <给模型读的文本>, "doc": TimelineDoc(JSON), "media": {...}, "has_speech": bool, "edit_dir": str}。
    AI 据 packed 里的"可选片段(时间戳)"发 add_clip 操作建片。**只读,不弹审批。**

    E4①素材体检(零token·纯ffmpeg):先给每个素材跑黑屏/冻结体检(probe_footage_health)——全废
    则直接抛错(别再花时间转写,让上层把"哪些素材废、为啥"大白话告诉用户);没全废的话,废素材只在
    候选菜单里标"⚠️质量差"降权提示,不剔除(AI/前端自己决定要不要用,不硬塞也不硬删)。
    """
    from .transcribe import transcribe  # 延迟导入(whisper 重)

    # ── 素材体检先行(便宜):全废就别浪费时间转写了 ──
    health_by_path = {vp: probe_footage_health(vp) for vp in video_paths}
    all_bad_msg = footage_all_bad_message(health_by_path)
    if all_bad_msg:
        raise RuntimeError(all_bad_msg)

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
        health = health_by_path[vp]
        scenes = detect_scenes(vp)
        tr = transcribe(vp, edit_dir, language=language)
        has_speech = tr.get("has_speech")
        any_speech = any_speech or has_speech
        phrases = _phrase_cues(tr.get("words", [])) if has_speech else []

        lines.append(f"## 素材 {mid}（{Path(vp).name}） 时长 {info['duration_s']}s "
                     f"{'竖屏' if info['is_portrait'] else '横屏'} {'有口播' if has_speech else '无口播/空镜'}")
        if health["is_bad"]:
            lines.append(f"⚠️ 这段素材质量差({'、'.join(health['reasons'])}),建议少用或别用。")
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
            "health": health,
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


def render_timeline(doc: TimelineDoc, out_path: str, *, edit_dir: str) -> dict:
    """时间轴文档 → 成片 mp4。字幕轨→SRT,文档→Edl,复用 render_edl 的确定性 ffmpeg 管线。

    E4⑤渲染后体检(零token·纯ffmpeg):渲完用 guarded_render 体检(时长/黑段/静音/首帧);
    红→用同一份 EDL 重渲一次;仍红也不再重渲,把问题清单一并带回去(不静默塞给用户一个烂片)。
    返回 {"path": str, "health": {...}, "rerendered": bool}(渲染管线本身 render_edl 一行不改)。
    """
    work = Path(edit_dir)
    work.mkdir(parents=True, exist_ok=True)
    srt = None
    if doc.caption_clips():
        srt = str(work / "captions.srt")
        build_srt_from_doc(doc, srt)
    edl = doc.to_edl(subtitles_srt=srt)
    return guarded_render(lambda: render_edl(edl, out_path, edit_dir=str(work)),
                          expected_duration=doc.duration())


# ── V2 方案 = 一份可编辑的 plan(shots 是真相源)。对话改任何东西 = 改这份 plan。──

def _plan_path(edit_dir: str) -> Path:
    return Path(edit_dir) / "v2_plan.json"


def load_v2_plan(edit_dir: str) -> dict:
    f = _plan_path(edit_dir)
    return json.loads(f.read_text()) if f.exists() else {}


def save_v2_plan(edit_dir: str, plan: dict) -> None:
    import os
    p = _plan_path(edit_dir)
    tmp = p.with_name(p.name + ".tmp")
    tmp.write_text(json.dumps(plan, ensure_ascii=False))
    os.replace(tmp, p)   # 原子替换,防写一半崩坏


def plan_to_doc(plan: dict) -> TimelineDoc:
    """把 plan.shots 建成可预览/渲染的时间轴文档(每 shot = add_clip;去重登记 media)。"""
    doc = new_doc(width=int(plan.get("width", 1080)), height=int(plan.get("height", 1920)))
    doc.tracks["v"] = Track(kind="video", order=0)
    doc.tracks["sub"] = Track(kind="caption", order=1)
    src_to_mid: dict[str, str] = {}
    ops: list[dict] = []
    for s in plan.get("shots", []):
        src = s["src"]
        mid = src_to_mid.get(src)
        if mid is None:
            mid = f"m{len(src_to_mid) + 1}"
            src_to_mid[src] = mid
            doc.media[mid] = MediaRef(src=src, duration=probe_video(src)["duration_s"], kind="video")
        ops.append({"op": "add_clip", "track": "v", "media": mid, "src_in": s["start"], "src_out": s["end"]})
    if plan.get("grade"):
        ops.append({"op": "set_grade", "grade": plan["grade"]})
    doc, errs = apply_operations(doc, ops)
    if errs:
        raise RuntimeError("plan→doc 失败:" + "；".join(errs))
    return doc


def auto_plan_v2(
    video_paths: list[str],
    edit_dir: str,
    *,
    ratio: str = "9:16",
    target_duration: float = 16.0,
    grade: str = "warm_cinematic",
) -> dict:
    """氛围模式【出方案 + 配文案】(不渲染,快):挑高光(VLM) → 导演配文案 → 落可编辑 plan。

    v2_plan.json = {width,height,grade,ratio,brand,music_mood,shots[],pool[]};shots 是后续对话编辑的真相源。
    返回 {doc, report, brand, captions, used_vlm}。渲染走 render_v2_project(慢·导出时才跑)。
    """
    import glob as _glob

    from .director import caption_shots, plan_style
    from .planners.ambient import plan_ambient
    from .vlm import classify_content

    res = plan_ambient(video_paths, edit_dir, ratio=ratio, target_duration=target_duration, grade=grade)
    picked = res["report"]["picked"]                       # {media,start,end,subject,score,...}
    media_src = {mid: m["src"] for mid, m in res["doc"]["media"].items()}

    # ── ★内容检测:是不是台球 + 哪类场景(通用兜底 + 台球加持的开关)──
    sample = sorted(_glob.glob(str(Path(edit_dir) / "frames" / "*.jpg")))[:8]
    cls = classify_content(sample)
    is_bil, scene = cls["is_billiards"], cls["scene"]
    cap_ctx = sty_ctx = None
    mhint = None
    if is_bil:
        from .billiards_video_kb import caption_guidance, music_hint, style_guidance
        cap_ctx, sty_ctx, mhint = caption_guidance(scene), style_guidance(scene), music_hint(scene)

    cap = caption_shots(picked, domain_ctx=cap_ctx)
    shots = [{
        "src": media_src.get(p["media"], ""), "start": p["start"], "end": p["end"],
        "subject": p.get("subject", ""), "score": p.get("score", 5),
        "caption": cap["captions"][i] if i < len(cap["captions"]) else "",
    } for i, p in enumerate(picked)]
    sty = plan_style(shots, domain_ctx=sty_ctx, mood=(mhint["mood"] if mhint else None))
    for s, st in zip(shots, sty["shots_style"]):
        s["style"] = st

    # 音乐:导演给的 mood+key;台球场景则用场景建议的 mood。
    music = sty.get("music", {"mood": "auto", "key": 0})
    if mhint and mhint.get("mood") not in (None, "auto"):
        music = {"mood": mhint["mood"], "key": music.get("key", 0)}
    # ★内容派生 key:不同素材(片段/时长指纹)必得不同调,保证音乐不千篇一律(不靠 LLM 变)。
    import hashlib

    from .bgm import beat_for_mood

    sig = "|".join(f"{s['src']}:{s['start']}:{s['end']}" for s in shots)
    content_key = int(hashlib.md5(sig.encode()).hexdigest(), 16) % 12
    music["key"] = (int(music.get("key", 0)) + content_key) % 12

    # ★卡点:把每段时长吸附到整数拍,切点就落在鼓点上(超出源片则往下取整,至少 2 拍)。
    beat = beat_for_mood(music["mood"])
    for s in shots:
        srcdur = probe_video(s["src"])["duration_s"]
        beats = max(2, round((s["end"] - s["start"]) / beat))
        end = s["start"] + beats * beat
        if end > srcdur:                       # 超界 → 往下取整到能放下的拍数
            beats = max(1, int((srcdur - s["start"]) / beat))
            end = s["start"] + beats * beat
        s["end"] = round(end, 3)

    w, h = res["size"]
    plan = {"width": w, "height": h, "grade": grade, "ratio": ratio, "brand": cap["brand"],
            "domain": "billiards" if is_bil else "general", "scene": scene,
            "music": music, "theme": sty["theme"], "customCss": sty.get("customCss", ""),
            "shots": shots, "pool": res.get("pool", [])}
    save_v2_plan(edit_dir, plan)
    return {"doc": plan_to_doc(plan).model_dump(), "report": res["report"], "brand": cap["brand"],
            "captions": [s["caption"] for s in shots], "used_vlm": res["used_vlm"]}


def recaption_v2(edit_dir: str, tonality: str) -> dict:
    """对话改文案(不渲染,快):读 plan.shots + 店主指令 → LLM 带上下文重写 → 存回。返回 {brand, captions}。"""
    from .director import caption_shots

    plan = load_v2_plan(edit_dir)
    shots = plan.get("shots", [])
    dctx = None
    if plan.get("domain") == "billiards":
        from .billiards_video_kb import caption_guidance
        dctx = caption_guidance(plan.get("scene", ""))
    cap = caption_shots(shots, tonality=tonality, prev_captions=[s.get("caption", "") for s in shots], domain_ctx=dctx)
    for s, c in zip(shots, cap["captions"]):
        s["caption"] = c
    plan["brand"] = cap["brand"]
    save_v2_plan(edit_dir, plan)
    return {"brand": cap["brand"], "captions": [s["caption"] for s in shots]}


def render_v2_project(edit_dir: str, out_path: str) -> dict:
    """按当前 plan 把方案渲成 V2 包装成片(慢·导出时跑)。

    E4⑤渲染后体检:同 render_timeline,渲完体检、红→用同一份 plan 重渲一次(template_render.render_v2
    一行不改)。返回 {"path": str, "health": {...}, "rerendered": bool}。
    """
    from .template_render import render_v2

    plan = load_v2_plan(edit_dir)
    doc = plan_to_doc(plan)
    shots = plan.get("shots", [])
    music = plan.get("music", {}) if isinstance(plan.get("music"), dict) else {}

    def _do() -> str:
        return render_v2(doc, out_path, edit_dir=edit_dir, brand=plan.get("brand", "精彩瞬间"),
                         captions=[s.get("caption", "") for s in shots],
                         styles=[s.get("style") for s in shots],
                         theme=plan.get("theme"), custom_css=plan.get("customCss", ""),
                         grade=plan.get("grade", "warm_cinematic"),
                         music_mood=music.get("mood", "auto"), music_key=int(music.get("key", 0)))

    return guarded_render(_do, expected_duration=doc.duration())
