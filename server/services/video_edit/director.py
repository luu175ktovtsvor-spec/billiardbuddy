"""AI 导演 —— 给挑好的高光镜头配"6 字内动感文案 + 品牌开场词"。

- 首次出片:氛围 Planner 挑好段 → 本模块按每段画面内容(subject/reason)配文案。
- 对话改文案(recaption):带上「店主指令 + 上一版文案」再调一次,LLM 带上下文重写。
- 文案与素材解耦:本模块只产出文字,不碰帧;换文案 = 重跑本模块 + 重渲文案层。

模型走豆包(ARK key 已内置,与 VLM/Seedance 同一把)。env VIDEO_LLM_* 可覆盖。失败优雅降级到规则文案。
"""
from __future__ import annotations

import json
import logging
import os
import re

import httpx

logger = logging.getLogger(__name__)

_ENDPOINT = os.environ.get("VIDEO_LLM_ENDPOINT", "https://ark.cn-beijing.volces.com/api/v3/chat/completions")
_MODEL = os.environ.get("VIDEO_LLM_MODEL", "doubao-seed-1-6-250615")
_KEY_ENVS = ("ARK_API_KEY", "VIDEO_LLM_API_KEY", "VLM_API_KEY")


def _api_key() -> str | None:
    for env in _KEY_ENVS:
        v = os.environ.get(env)
        if v:
            return v
    return None


def _parse_obj_loose(text: str) -> dict | None:
    if not text:
        return None
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def chat_json(prompt: str, *, timeout: float = 90.0, retries: int = 3) -> dict | None:
    """通用:发一段 prompt 给豆包,抠出 JSON 对象返回。带重试(网络/SSL 抖动常见)。失败/无 key → None。"""
    import time as _time
    key = _api_key()
    if not key:
        return None
    payload = {"model": _MODEL, "messages": [{"role": "user", "content": prompt}],
               "temperature": 0.4, "max_tokens": 1800}
    for attempt in range(retries):
        try:
            r = httpx.post(_ENDPOINT, headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=timeout)
            r.raise_for_status()
            return _parse_obj_loose(r.json()["choices"][0]["message"]["content"])
        except Exception as e:  # noqa: BLE001
            logger.warning("chat_json 第%d次失败:%s", attempt + 1, e)
            if attempt < retries - 1:
                _time.sleep(1.5 * (attempt + 1))
    return None


# 视觉风格词汇表(引擎支持的)。大模型从中选,给每段编排;也可写 customCss 随意发挥。
_TRANSITIONS = ["fade", "wipe", "slide-left", "slide-up", "zoom", "glitch", "flash", "none"]
_MOTIONS = ["kenburns-in", "kenburns-out", "pan-left", "pan-right", "pan-up", "none"]
_CAP_POS = ["top", "center", "bottom"]
_CAP_ANIM = ["slide-up", "fade", "pop", "typewriter"]


def _default_style() -> dict:
    return {"transition": "wipe", "motion": "kenburns-in",
            "caption": {"pos": "bottom", "anim": "slide-up", "color": "#fff"}}


def plan_style(shots: list[dict], *, mood: str | None = None, prev: dict | None = None,
               domain_ctx: str | None = None) -> dict:
    """让 LLM 按画面内容/情绪,给整条片编排视觉风格(随意发挥)+ 音乐规格。

    返回 {"theme":{"accent":"#RRGGBB"}, "shots_style":[{transition,motion,caption}...],
          "customCss":"...", "music":{"mood":"chill|hype|auto","key":0-11}}。失败/无 key → 稳妥默认。
    domain_ctx: 识别到台球时注入的场景风格打法;通用则 None(自由发挥)。
    """
    n = len(shots)
    _styles = [_default_style() for _ in range(n)]
    if _styles:
        _styles[0]["transition"] = "none"   # 首段不入场转场(默认也保持,与 LLM 路径一致)
    _def = {"theme": {"accent": "#12E0C8"}, "shots_style": _styles,
            "customCss": "", "music": {"mood": "auto", "key": 0}}
    if n == 0 or not _api_key():
        return _def

    lines = [f"第{i + 1}段: 画面={s.get('subject', '') or '未知'} 文案='{s.get('caption', '')}'" for i, s in enumerate(shots)]
    moodline = f"\n用户想要的调性/情绪:{mood}" if mood else ""
    prevline = f"\n上一版风格(按反馈微调,别推倒重来):{json.dumps(prev, ensure_ascii=False)}" if prev else ""
    prefix = (domain_ctx + "\n\n") if domain_ctx else ""
    prompt = (
        prefix + "你是短视频视觉导演,给这条竖屏片编排特效风格 + 配乐调性。要贴合画面内容和情绪,不同段落可以不同、有节奏变化,别千篇一律。\n"
        "镜头:\n" + "\n".join(lines) + moodline + prevline + "\n\n"
        f"每段可选:\n- transition(入场转场,第1段用none):{_TRANSITIONS}\n"
        f"- motion(镜头运动):{_MOTIONS}\n- caption.pos(字幕位置):{_CAP_POS}\n- caption.anim(字幕动画):{_CAP_ANIM}\n"
        "- caption.color 十六进制色\n全局:theme.accent(主题强调色,配画面情绪的十六进制)。\n"
        "music:{mood: chill(慢柔)|hype(嗨快)|auto, key: 0到11的整数(不同片子给不同 key,让音乐不重样)}。\n"
        "想要词汇表覆盖不了的特效,可另给 customCss(一段 CSS,作用于 #stage 内的 #clip/#cap/#tag,别改布局别用外链)。\n\n"
        f"只回 JSON,shots_style 正好 {n} 段,顺序对应,不要解释、不要```:\n"
        '{"theme":{"accent":"#12E0C8"},"shots_style":[{"transition":"fade","motion":"kenburns-in","caption":{"pos":"bottom","anim":"slide-up","color":"#ffffff"}}],"music":{"mood":"hype","key":5},"customCss":""}'
    )
    data = chat_json(prompt, timeout=60)
    if not isinstance(data, dict) or not isinstance(data.get("shots_style"), list):
        logger.warning("plan_style 回复不对,用默认")
        return _def

    styles: list[dict] = []
    for i in range(n):
        raw = data["shots_style"][i] if i < len(data["shots_style"]) and isinstance(data["shots_style"][i], dict) else {}
        cap = raw.get("caption") if isinstance(raw.get("caption"), dict) else {}
        styles.append({
            "transition": raw.get("transition") if raw.get("transition") in _TRANSITIONS else "wipe",
            "motion": raw.get("motion") if raw.get("motion") in _MOTIONS else "kenburns-in",
            "caption": {
                "pos": cap.get("pos") if cap.get("pos") in _CAP_POS else "bottom",
                "anim": cap.get("anim") if cap.get("anim") in _CAP_ANIM else "slide-up",
                "color": cap.get("color") or "#fff",
            },
        })
    styles[0]["transition"] = "none"  # 第一段不入场转场
    theme = data.get("theme") if isinstance(data.get("theme"), dict) else {}
    accent = theme.get("accent") if isinstance(theme.get("accent"), str) and theme.get("accent", "").startswith("#") else "#12E0C8"
    custom = data.get("customCss") if isinstance(data.get("customCss"), str) else ""
    m = data.get("music") if isinstance(data.get("music"), dict) else {}
    mood_v = m.get("mood") if m.get("mood") in ("chill", "hype", "auto", "none") else "auto"
    try:
        key_v = int(m.get("key", 0)) % 12
    except (TypeError, ValueError):
        key_v = 0
    return {"theme": {"accent": accent}, "shots_style": styles, "customCss": custom[:2000],
            "music": {"mood": mood_v, "key": key_v}}


def _fallback(shots: list[dict], n: int) -> dict:
    """没 key / LLM 失败时的规则文案:用 subject 兜底,别让出片崩。"""
    caps = []
    for s in shots:
        subj = (s.get("subject") or "").replace("(启发式)", "")
        caps.append(subj[:6] if subj and subj != "未知" else "精彩一刻")
    brand = (shots[0].get("subject") or "").replace("(启发式)", "")[:6] if shots else ""
    return {"brand": brand or "精彩瞬间", "captions": caps[:n] + ["精彩一刻"] * max(0, n - len(caps))}


def caption_shots(
    shots: list[dict],
    *,
    tonality: str | None = None,
    prev_captions: list[str] | None = None,
    domain_ctx: str | None = None,
    timeout: float = 60.0,
) -> dict:
    """给一串镜头配文案。返回 {"brand": str, "captions": [str, ...]}(captions 与 shots 等长)。

    shots: 每个 {subject, reason}(氛围 Planner 报告里的 picked 项)。
    tonality/prev_captions: 对话改文案时传——店主的调性指令 + 上一版文案,让 LLM 带上下文重写。
    domain_ctx: 识别到台球时注入的场景打法(billiards_video_kb);通用则 None。
    """
    n = len(shots)
    key = _api_key()
    if not key or n == 0:
        return _fallback(shots, n)

    lines = [f"{i}. 画面={s.get('subject', '未知')} 备注={s.get('reason', '')}" for i, s in enumerate(shots)]
    if tonality and prev_captions:
        task = (
            f"店主反馈要改文案:{tonality}\n"
            f"这是上一版文案(要按反馈改掉):{json.dumps(prev_captions, ensure_ascii=False)}\n"
            f"镜头内容:\n" + "\n".join(lines)
        )
    else:
        task = "给这条短视频每个镜头配文案(贴合画面真实内容,别套模板)。镜头内容:\n" + "\n".join(lines)

    prefix = (domain_ctx + "\n\n") if domain_ctx else ""
    prompt = (
        prefix + "你是抖音/小红书爆款文案。" + task + f"\n\n"
        f"给每个镜头写 1 条【6 字以内】动感短文案,共 {n} 条,顺序对应镜头。"
        f"第 0 条同时作开场品牌大字(给氛围/颜值品牌感)。只回 JSON,不要思考过程、不要```包裹:\n"
        f'{{"brand":"开场品牌词","captions":["文案0","文案1", ...]}}'
    )
    payload = {
        "model": _MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "max_tokens": 1500,
    }
    try:
        r = httpx.post(_ENDPOINT, headers={"Authorization": f"Bearer {key}"}, json=payload, timeout=timeout)
        r.raise_for_status()
        data = _parse_obj_loose(r.json()["choices"][0]["message"]["content"])
    except Exception as e:  # noqa: BLE001
        logger.warning("导演配文案失败,降级规则文案:%s", e)
        return _fallback(shots, n)

    if not isinstance(data, dict) or not isinstance(data.get("captions"), list):
        logger.warning("导演回复格式不对,降级:%r", data)
        return _fallback(shots, n)

    caps = [str(c)[:8] for c in data["captions"]][:n]
    while len(caps) < n:  # LLM 少给了补齐
        caps.append("精彩一刻")
    return {"brand": str(data.get("brand") or caps[0] or "精彩瞬间")[:8], "captions": caps}
