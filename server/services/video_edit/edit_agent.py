"""对话编辑智能层 —— 听懂店主的大白话反馈,翻译成对方案(plan)的剪辑操作。

设计(对齐创作引擎 v2「对话当加速层」):LLM 只负责【听懂反馈 → 分类成结构化操作】,
真正的改动由确定性代码执行(改 plan.shots / plan 参数),稳、可回滚、不让 LLM 瞎发原子指令。

覆盖:改文案、删段、换段(从候选池挑替代)、调顺序、整体短/长、调色、背景乐情绪、画面比例。
换段/加段从 auto_plan_v2 落在 plan["pool"] 的完整候选池里挑(按分数),数据现成。
"""
from __future__ import annotations

import logging

from .director import caption_shots, chat_json

logger = logging.getLogger(__name__)

_GRADES = {"warm_cinematic", "neutral_punch", "none"}
_MOODS = {"chill", "auto", "hype", "none"}
_RATIOS = {"9:16": (1080, 1920), "1:1": (1080, 1080), "16:9": (1920, 1080)}


def _interpret(feedback: str, shots: list[dict]) -> dict:
    """把大白话反馈 → {actions:[...], reply:str}。"""
    lines = [
        f"第{i + 1}段: 画面={s.get('subject', '') or '未知'} 文案='{s.get('caption', '')}' 时长{round(s['end'] - s['start'], 1)}s"
        for i, s in enumerate(shots)
    ]
    prompt = (
        "你是视频剪辑助手,把用户的大白话反馈翻译成剪辑操作。\n"
        "当前这条竖屏短视频的镜头(从1开始编号):\n" + "\n".join(lines) + "\n\n"
        f"店主反馈:「{feedback}」\n\n"
        "从下面选合适的操作(可多条,按顺序),index/order 用上面的镜头号(第几段就填几,从1开始):\n"
        '- {"action":"recaption","tonality":"文案调性指令"} —— 改文字/风格(如改成美女助教风)\n'
        '- {"action":"remove_shot","index":n} —— 删掉某段\n'
        '- {"action":"replace_shot","index":n} —— 把某段换成别的候选画面\n'
        '- {"action":"reorder","order":[镜头号新顺序]} —— 调整顺序\n'
        '- {"action":"shorten"} 整体短一点 / {"action":"lengthen"} 整体长一点\n'
        '- {"action":"set_grade","grade":"warm_cinematic|neutral_punch|none"} —— 调色(暖色电影感/中性/原色)\n'
        '- {"action":"set_music","mood":"chill|hype|auto"} —— 背景乐(慢柔/嗨快/默认)\n'
        '- {"action":"set_ratio","ratio":"9:16|1:1|16:9"} —— 画面比例\n'
        '- {"action":"restyle","mood":"想要的视觉风格/情绪,如 炫酷快切/文艺慢/科技冷调"} —— 整体重新编排特效转场字幕风格\n'
        '- {"action":"set_caption_pos","pos":"top|center|bottom"} —— 字幕整体放上/中/下\n'
        '- {"action":"set_accent","color":"#十六进制"} —— 主题强调色\n\n'
        "只回 JSON,不要解释、不要```包裹:\n"
        '{"actions":[...],"reply":"用一句大白话告诉店主你改了啥"}'
    )
    return chat_json(prompt) or {"actions": [], "reply": "没太听懂,能说具体点吗?(比如\"第2段换掉\"\"文案甜一点\"\"配乐慢些\")"}


def _used_keys(shots: list[dict]) -> set:
    return {(s["src"], round(s["start"], 2)) for s in shots}


def _pick_replacement(plan: dict, used: set) -> dict | None:
    """从候选池挑一个没用过的、分最高的可用窗口。"""
    cand = [c for c in plan.get("pool", [])
            if c.get("usable", True) and (c["src"], round(c["start"], 2)) not in used]
    cand.sort(key=lambda c: c.get("score", 0), reverse=True)
    return cand[0] if cand else None


def _new_shot(rep: dict, caption: str = "") -> dict:
    return {"src": rep["src"], "start": rep["start"], "end": rep["end"],
            "subject": rep.get("subject", ""), "score": rep.get("score", 5), "caption": caption}


def _domain_ctx(plan: dict, kind: str) -> str | None:
    """台球片则返回场景领域指引(kind: caption/style),通用返回 None。"""
    if plan.get("domain") != "billiards":
        return None
    from .billiards_video_kb import caption_guidance, style_guidance
    return (caption_guidance if kind == "caption" else style_guidance)(plan.get("scene", ""))


def apply_feedback(edit_dir: str, feedback: str) -> dict:
    """理解反馈 → 改 plan → 存回。返回 {reply, brand, shots, grade, ratio, music_mood, changed}。"""
    from .assemble import load_v2_plan, save_v2_plan

    plan = load_v2_plan(edit_dir)
    shots = plan.get("shots", [])
    if not shots:
        return {"reply": "还没出方案,先点\"生成方案\"。", "brand": plan.get("brand", ""),
                "shots": [], "changed": False}

    intent = _interpret(feedback, shots)
    changed = False
    recap_tonality: str | None = None

    for a in intent.get("actions", []):
        act = a.get("action")
        try:
            if act == "recaption":
                recap_tonality = a.get("tonality") or feedback
                changed = True
            elif act == "remove_shot":
                i = int(a["index"]) - 1                 # 反馈是 1-based(第N段)
                if 0 <= i < len(shots) and len(shots) > 1:
                    shots.pop(i); changed = True
            elif act == "replace_shot":
                i = int(a["index"]) - 1
                if 0 <= i < len(shots):
                    rep = _pick_replacement(plan, _used_keys(shots))
                    if rep:
                        keep_cap = shots[i].get("caption", "")
                        shots[i] = _new_shot(rep, keep_cap)
                        c = caption_shots([shots[i]], domain_ctx=_domain_ctx(plan, "caption"))  # 换画面→重配文案
                        if c["captions"]:
                            shots[i]["caption"] = c["captions"][0]
                        changed = True
            elif act == "reorder":
                order = [int(x) - 1 for x in a.get("order", [])]      # 1-based → 0-based
                if sorted(order) == list(range(len(shots))):
                    shots[:] = [shots[i] for i in order]; changed = True
            elif act == "shorten":
                if len(shots) > 1:
                    j = min(range(len(shots)), key=lambda i: shots[i].get("score", 5))
                    shots.pop(j); changed = True
            elif act == "lengthen":
                rep = _pick_replacement(plan, _used_keys(shots))
                if rep:
                    ns = _new_shot(rep)
                    c = caption_shots([ns], domain_ctx=_domain_ctx(plan, "caption"))
                    ns["caption"] = c["captions"][0] if c["captions"] else ""
                    shots.append(ns); changed = True
            elif act == "set_grade" and a.get("grade") in _GRADES:
                plan["grade"] = a["grade"]; changed = True
            elif act == "set_music" and a.get("mood") in _MOODS:
                plan.setdefault("music", {})["mood"] = a["mood"]; changed = True
            elif act == "set_ratio" and a.get("ratio") in _RATIOS:
                plan["width"], plan["height"] = _RATIOS[a["ratio"]]
                plan["ratio"] = a["ratio"]; changed = True
            elif act == "restyle":
                from .director import plan_style
                sty = plan_style(shots, mood=a.get("mood"), domain_ctx=_domain_ctx(plan, "style"),
                                 prev={"theme": plan.get("theme"), "customCss": plan.get("customCss")})
                for s, st in zip(shots, sty["shots_style"]):
                    s["style"] = st
                plan["theme"] = sty["theme"]
                plan["customCss"] = sty.get("customCss", "")
                if isinstance(sty.get("music"), dict):
                    plan["music"] = sty["music"]
                changed = True
            elif act == "set_caption_pos" and a.get("pos") in ("top", "center", "bottom"):
                for s in shots:
                    st = s.setdefault("style", {})
                    st.setdefault("caption", {})["pos"] = a["pos"]
                changed = True
            elif act == "set_accent" and isinstance(a.get("color"), str) and a["color"].startswith("#"):
                plan.setdefault("theme", {})["accent"] = a["color"]; changed = True
        except (KeyError, ValueError, TypeError) as e:
            logger.warning("跳过一个非法操作 %s:%s", a, e)

    plan["shots"] = shots
    if recap_tonality:
        c = caption_shots(shots, tonality=recap_tonality,
                          prev_captions=[s.get("caption", "") for s in shots])
        for s, cap in zip(shots, c["captions"]):
            s["caption"] = cap
        plan["brand"] = c["brand"]

    save_v2_plan(edit_dir, plan)
    return {"reply": intent.get("reply", "改好了"), "brand": plan.get("brand", ""),
            "shots": shots, "grade": plan.get("grade"), "ratio": plan.get("ratio"),
            "music_mood": (plan.get("music") or {}).get("mood"), "changed": changed}
