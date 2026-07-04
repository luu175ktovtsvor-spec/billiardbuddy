"""结构化方案 JSON ⇄ 渲染 manifest 的纯逻辑拼装（无 I/O，单测直接跑）。

流程：LLM 原始输出(字符串) → parse_plan_json → 结构化 dict → build_manifest → 喂给
`services.scene_plan.render` 的图片版/网页版消费。plan_type 统一收敛成三选一：
opening(开业) / recharge(会员卡) / tournament(比赛)。
"""
from __future__ import annotations

import json
import re
from datetime import datetime

from core.timezone import BUSINESS_TZ

# ── 方案类型：中文/别名 → 内部 key ───────────────────────────────────────────
PLAN_TYPE_LABELS: dict[str, str] = {
    "opening": "开业方案",
    "recharge": "会员卡方案",
    "tournament": "比赛方案",
}

PLAN_TYPE_ALIAS: dict[str, str] = {
    "开业": "opening", "开业方案": "opening", "新店开业": "opening", "opening": "opening",
    "会员卡": "recharge", "会员卡方案": "recharge", "充值": "recharge", "一卡通": "recharge",
    "recharge": "recharge", "membership": "recharge",
    "比赛": "tournament", "比赛方案": "tournament", "赛事": "tournament", "赛事方案": "tournament",
    "tournament": "tournament",
}

# 每种方案类型的"文字底料"（PPT 在册的行业真实运营逻辑 YAML，见 server/prompts/），
# 拼进 LLM prompt 当参考——让模型"结合真实打法"生成，而不是凭空编（铁律#8）。
PLAN_TYPE_TEMPLATE_KEYS: dict[str, list[str]] = {
    "opening": ["operation.opening_ground_blitz", "copywriting.new_store_opening"],
    "recharge": ["operation.recharge_design"],
    "tournament": [
        "operation.tournament", "operation.tournament_rules",
        "operation.tournament_signup", "operation.tournament_report",
    ],
}


def normalize_plan_type(raw: str) -> str | None:
    """把老板/模型给的方案类型原话（中文/别名/英文）收敛成内部 key；识别不出返回 None。"""
    key = (raw or "").strip()
    if key in PLAN_TYPE_LABELS:
        return key
    return PLAN_TYPE_ALIAS.get(key)


# ── LLM 原始输出 → 结构化方案 dict（容错 markdown 代码块/前后多余文字） ──────────────

_REQUIRED_LIST_FIELDS = ("materials", "notes", "missing_info")


def parse_plan_json(raw: str) -> dict:
    """从 LLM 原始输出里稳健解析方案 JSON。

    容错策略（依次尝试）：原文直接 loads → 提取```json 代码块 → 截取首个 { 到末个 } 的子串。
    都解析不出合法 JSON 对象时抛 ValueError，调用方兜底成人话提示，不带崩。

    解析出的 dict 会做字段收敛（缺的补空/补默认类型），保证下游 build_manifest 不用防御性判空。
    """
    text = (raw or "").strip()
    candidates: list[str] = []
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        candidates.append(fence.group(1))
    candidates.append(text)
    first, last = text.find("{"), text.rfind("}")
    if first != -1 and last != -1 and last > first:
        candidates.append(text[first:last + 1])

    data = None
    for cand in candidates:
        try:
            parsed = json.loads(cand)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            data = parsed
            break

    if data is None:
        raise ValueError("AI 没能给出合法的结构化方案 JSON")

    plan: dict = {
        "title": str(data.get("title") or "").strip(),
        "goal": str(data.get("goal") or "").strip(),
        "budget": str(data.get("budget") or "").strip(),
    }

    timeline_items: list[dict] = []
    raw_timeline = data.get("timeline")
    if isinstance(raw_timeline, list):
        for item in raw_timeline:
            if isinstance(item, dict):
                time_s = str(item.get("time") or "").strip()
                action_s = str(item.get("action") or "").strip()
                if time_s or action_s:
                    timeline_items.append({"time": time_s, "action": action_s})
            elif isinstance(item, str) and item.strip():
                timeline_items.append({"time": "", "action": item.strip()})
    plan["timeline"] = timeline_items

    for field in _REQUIRED_LIST_FIELDS:
        raw_val = data.get(field)
        if isinstance(raw_val, list):
            plan[field] = [str(x).strip() for x in raw_val if str(x or "").strip()]
        else:
            plan[field] = []

    return plan


# ── 会员卡/充值方案硬规则兜底（recharge_design.yaml：不做大额赠送/赠送只抵台费） ──────
# Prompt 里已把这条红线交代给模型，这里是 code 侧最后一道防线——万一模型没听、编出违规
# 数字/说法，拦下来，别把违规方案原样交给老板。

_RECHARGE_RATIO_RE = re.compile(r"充\s*([\d,]+(?:\.\d+)?)\s*送\s*([\d,]+(?:\.\d+)?)")
_RECHARGE_MAX_RATIO = 0.2  # 参考口径约 10%；20% 起判定"大额赠送"（覆盖 40%/50%/100% 这类明显违规，留出微调空间）
_RECHARGE_SCOPE_BAD_PHRASES = (
    "送现金", "赠送可提现", "赠送可变现", "赠送变现", "赠送不限用途", "赠送全场通用",
    "赠送抵助教费", "赠送抵商品", "赠送抵器材", "无上限赠送", "买一送一无限", "充多少送多少",
)


def _violates_recharge_rule(text: str) -> bool:
    if not text:
        return False
    for m in _RECHARGE_RATIO_RE.finditer(text):
        try:
            paid = float(m.group(1).replace(",", ""))
            given = float(m.group(2).replace(",", ""))
        except ValueError:
            continue
        if paid > 0 and (given / paid) > _RECHARGE_MAX_RATIO:
            return True
    return any(p in text for p in _RECHARGE_SCOPE_BAD_PHRASES)


def sanitize_recharge_plan(plan: dict) -> dict:
    """会员卡/充值方案红线兜底：赠送比例别做大(参考10%左右)、赠送别越界到台费外。
    命中就整份方案脱敏（别把具体违规数字/说法交给老板），并在 notes/missing_info 里提示人工确认。
    未命中原样返回（新 dict，不改调用方持有的原对象）。"""
    flat = " ".join([
        plan.get("title", ""), plan.get("goal", ""), plan.get("budget", ""),
        *[t.get("action", "") for t in (plan.get("timeline") or [])],
        *(plan.get("materials") or []),
        *(plan.get("notes") or []),
    ])
    if not _violates_recharge_rule(flat):
        return plan

    out = dict(plan)
    out["budget"] = (
        "系统检测到 AI 给出的充值赠送说法可能超出红线（大额赠送 / 赠送超出台费范围），"
        "已移除具体数字。请按「赠送比例参考 10% 左右、赠送金额只能抵台费」重新确认充值档位金额。"
    )
    out["timeline"] = [t for t in (plan.get("timeline") or []) if not _violates_recharge_rule(t.get("action", ""))]
    out["materials"] = [m for m in (plan.get("materials") or []) if not _violates_recharge_rule(m)]
    notes = [n for n in (plan.get("notes") or []) if not _violates_recharge_rule(n)]
    notes.append("充值/一卡通红线：赠送比例别做大（参考 10% 左右），赠送金额只能抵台费，不含助教费/商品费。")
    out["notes"] = notes
    missing = list(plan.get("missing_info") or [])
    hint = "充值档位金额需人工确认（系统已拦截疑似违规的赠送数字/说法）"
    if hint not in missing:
        missing.append(hint)
    out["missing_info"] = missing
    return out


# ── 结构化方案 → 渲染 manifest（width/height/totalFrames=1/template + plan 数据） ────

_BASE_HEIGHT = 560       # 头部(店名/方案类型/生成时间) + 标题 + 目标卡 + 底部留白的固定占用
_TIMELINE_ROW_H = 90
_MATERIAL_ROW_H = 50
_NOTE_ROW_H = 56
_MIN_HEIGHT = 1000
_MAX_HEIGHT = 2800


def estimate_height(plan: dict, *, width: int = 1000) -> int:
    """按方案内容量粗估画布高度——render-worker.js 不做二次布局/滚动截取（离屏窗口一次性
    按给定尺寸截图），只能靠这层"按内容量给够高度"，不是精确排版量测，留了安全边界。"""
    timeline_n = len(plan.get("timeline") or [])
    materials_n = len(plan.get("materials") or [])
    notes_n = len(plan.get("notes") or [])
    height = (
        _BASE_HEIGHT
        + timeline_n * _TIMELINE_ROW_H
        + materials_n * _MATERIAL_ROW_H
        + notes_n * _NOTE_ROW_H
    )
    return max(_MIN_HEIGHT, min(height, _MAX_HEIGHT))


def build_manifest(
    plan: dict,
    *,
    plan_type: str,
    store_name: str,
    template_path: str,
    width: int = 1000,
    height: int | None = None,
) -> dict:
    """结构化方案 dict → render-worker.js 认得的 manifest（width/height/totalFrames=1/template
    是渲染器的契约字段；plan 是我们自己 template.html 消费的数据，渲染器本身不关心其内部结构）。"""
    if plan_type not in PLAN_TYPE_LABELS:
        raise ValueError(f"未知方案类型: {plan_type}")
    h = height if height is not None else estimate_height(plan, width=width)
    return {
        "width": width,
        "height": h,
        "totalFrames": 1,
        "template": str(template_path),
        "plan": {
            **plan,
            "plan_type": plan_type,
            "plan_type_label": PLAN_TYPE_LABELS[plan_type],
            "store_name": store_name or "",
            "generated_at": datetime.now(BUSINESS_TZ).strftime("%Y-%m-%d %H:%M"),
        },
        "theme": {"accent": "#10a37f"},  # 与产品定稿配色一致（当前绿 UI，见 CLAUDE.md 配色决策）
    }
