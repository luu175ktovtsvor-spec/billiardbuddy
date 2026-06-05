"""
Workbench 轻量 Few-shot 选择器 (10F-2)

职责：
1. 加载结构化优质样例库 YAML
2. 过滤 suitable_for_fewshot=true
3. 根据 role / customer_type / output_package / user_intent 打分
4. 返回最多 2 条最相关样例
5. 格式化为 Prompt 注入用的短文本
6. 任何异常时静默降级，返回空字符串
"""

import os
import logging
from pathlib import Path

import yaml

logger = logging.getLogger(__name__)

# 项目根目录（server/ 的父目录）
_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# 样例库路径
_EXAMPLES_YAML_PATH = _PROJECT_ROOT / "docs" / "product-brain" / "workbench-结构化优质样例库.yaml"

# 模块级缓存
_examples_cache: list[dict] | None = None
_examples_mtime: float = 0.0

# 助教服务体验型关键词 → 优先匹配的 scene_tags
ASSISTANT_EXPERIENCE_KEYWORDS = [
    "美女助教", "好看的助教", "漂亮助教", "点助教",
    "陪玩", "陪打", "新助教", "今日助教可约", "助教服务",
    "情绪价值", "服务体验", "氛围", "轻松", "到店可约",
    "一个人来", "助教到了", "助教在店", "想约助教",
]

ASSISTANT_EXPERIENCE_TAGS = [
    "assistant_service_experience",
    "assistant_booking",
    "assistant_service",
    "new_assistant",
    "assistant_arrival",
]

# 技术陪练型关键词 → 优先匹配的 scene_tags
TECHNICAL_ASSISTANT_KEYWORDS = [
    "练球", "提升", "技术", "指导", "纠正动作",
    "陪练", "动作", "球技", "水平", "训练",
]

TECHNICAL_ASSISTANT_TAGS = [
    "technical_assistant",
    "assistant_service",
]

# user_intent 关键词 → scene_tags 映射
INTENT_KEYWORD_TO_TAGS = {
    # 老客户
    "老客户": ["old_customer_recall"],
    "好久没": ["old_customer_recall"],
    "几个月没来": ["old_customer_recall"],
    "回访": ["old_customer_recall"],
    # 团购
    "团购": ["groupbuy_conversion", "groupbuy_checkin"],
    "核销": ["groupbuy_checkin"],
    # 加微信
    "加微信": ["wechat_add", "private_domain"],
    # 新客户
    "第一次来": ["new_customer_reception"],
    "新客": ["new_customer_reception"],
    # 大客户
    "大客户": ["vip_maintenance"],
    "VIP": ["vip_maintenance"],
    # 赛事
    "周赛": ["weekly_match", "tournament"],
    "月赛": ["tournament"],
    "比赛": ["tournament"],
    "战报": ["post_match_report"],
    "赛后": ["post_match_report"],
    # 轻竞技
    "台费局": ["light_competition"],
    "熟人": ["light_competition"],
    "饮料局": ["light_competition"],
    # 搭子
    "搭子": ["competition_customer"],
    "一起打": ["competition_customer"],
    # 朋友圈
    "朋友圈": ["wechat_moments"],
    "发圈": ["wechat_moments"],
    # 群公告
    "群公告": ["group_notice"],
    "群里说": ["group_notice"],
    # 模糊需求
    "冷清": ["ambiguous_intent"],
    "想想": ["ambiguous_intent"],
    # 前厅
    "开店": ["sop_checklist", "frontdesk_reception"],
    "检查表": ["sop_checklist"],
    # 内容规划
    "规划": ["content_planning"],
    "内容": ["content_planning"],
    # 短视频
    "短视频": ["assistant_short_video"],
    "抖音": ["assistant_short_video"],
    # 招聘
    "招聘": ["assistant_recruitment"],
    "招助教": ["assistant_recruitment"],
    # 会员
    "会员": ["member_question"],
    "办卡": ["member_question"],
    # 投诉
    "投诉": ["complaint_handling"],
    # 日报
    "日报": ["daily_report"],
    "汇报": ["daily_report"],
    # PK
    "PK": ["assistant_pk", "pk_plan_design"],
    # 课程推广
    "教学": ["competition_customer"],
    "课程": ["competition_customer"],
    # 助教服务
    "助教": ["assistant_service", "assistant_booking"],
    "点助教": ["assistant_booking", "assistant_service"],
    "约助教": ["assistant_booking", "assistant_service"],
    # 约球
    "约球": ["competition_customer", "light_competition"],
    "找人打球": ["competition_customer", "light_competition"],
    "球友": ["competition_customer"],
    # 充值
    "充值": ["member_question", "recharge_promo"],
    "储值": ["member_question", "recharge_promo"],
    "续费": ["member_question"],
}


def _load_examples() -> list[dict]:
    """加载样例库，只返回 suitable_for_fewshot=true 且 injection_style=short_snippet 的样例。

    使用模块级缓存，第一次加载后缓存结果。
    如果 YAML 文件的修改时间变了，重新加载。
    """
    global _examples_cache, _examples_mtime

    if not _EXAMPLES_YAML_PATH.exists():
        logger.warning(f"Few-shot examples file not found: {_EXAMPLES_YAML_PATH}")
        return []

    # 检查文件修改时间
    current_mtime = _EXAMPLES_YAML_PATH.stat().st_mtime
    if _examples_cache is not None and current_mtime == _examples_mtime:
        return _examples_cache

    try:
        with open(_EXAMPLES_YAML_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f)
    except Exception as e:
        logger.warning(f"Failed to load few-shot examples YAML: {e}")
        return []

    if not data or "examples" not in data:
        return []

    candidates = []
    for ex in data["examples"]:
        if not ex.get("suitable_for_fewshot", False):
            continue
        if ex.get("injection_style", "") != "short_snippet":
            continue
        candidates.append(ex)

    _examples_cache = candidates
    _examples_mtime = current_mtime
    return candidates


def _has_keyword(text: str, keywords: list[str]) -> bool:
    """检查 text 是否包含任意关键词。"""
    if not text:
        return False
    text_lower = text.lower()
    for kw in keywords:
        if kw.lower() in text_lower:
            return True
    return False


def _score_example(
    ex: dict,
    role: str,
    target_customer_type: str,
    output_package: list[str],
    user_intent: str,
    is_assistant_experience: bool,
    is_technical_assistant: bool,
) -> int:
    """为一条样例打分。"""
    score = 0

    # role 匹配
    if ex.get("role") == role:
        score += 3

    # customer_type 匹配
    if ex.get("target_customer_type") == target_customer_type:
        score += 3
    elif ex.get("target_customer_type") == "all":
        score += 1

    # output_package 命中
    ex_outputs = set(ex.get("output_package", []))
    user_outputs = set(output_package or [])
    intersection = ex_outputs & user_outputs
    score += min(len(intersection), 3)

    # user_intent keyword → scene_tag 匹配
    ex_tags = set(ex.get("scene_tags", []))
    matched_user_tags = set()
    for kw, tags in INTENT_KEYWORD_TO_TAGS.items():
        if kw.lower() in user_intent.lower():
            matched_user_tags.update(tags)
    tag_hits = ex_tags & matched_user_tags
    if tag_hits:
        score += 2

    # 助教服务体验型优先
    if is_assistant_experience:
        if ex_tags & set(ASSISTANT_EXPERIENCE_TAGS):
            score += 2

    # 技术陪练型优先
    if is_technical_assistant:
        if ex_tags & set(TECHNICAL_ASSISTANT_TAGS):
            score += 2

    # risk_tags 相关加分
    if ex.get("risk_tags"):
        score += 1

    # priority P0/P1 加分
    if ex.get("priority") in ("P0", "P1"):
        score += 1

    return score


def _format_examples(selected: list[dict]) -> str:
    """将选中的样例格式化为 Prompt 注入文本。"""
    if not selected:
        return ""

    lines = [
        "## 可参考的优质写法（仅供参考，以下铁规优先）",
        "以下样例只用于参考台球房运营内容的表达方式和行业语气。",
        "不要照抄样例中的具体事实、金额、姓名、门店活动信息。",
        "",
    ]

    for i, ex in enumerate(selected, 1):
        snippet = ex.get("good_output_snippet", "")
        max_chars = ex.get("max_injection_chars", 350)
        if len(snippet) > max_chars:
            snippet = snippet[:max_chars]

        rules = ex.get("reusable_rules", [])
        rules_text = ""
        if rules:
            rules_text = "\n".join(f"  - {r}" for r in rules[:2])

        lines.append(f"**参考样例{i}**（场景：{'、'.join(ex.get('scene_tags', [])[:3])}）")
        lines.append(f"用户需求：{ex.get('user_intent', '')}")
        lines.append(f"参考写法：{snippet.strip()}")
        if rules_text:
            lines.append(f"可复用原则：\n{rules_text}")
        lines.append("")

    lines.append("**注意**：以上样例仅供风格参考。本次生成仍需严格遵守所有基线规则和场景约束。")
    return "\n".join(lines)


def select_workbench_fewshots(
    role: str,
    target_customer_type: str,
    output_package: list[str],
    user_intent: str,
    extra_note: str | None = None,
    max_examples: int = 2,
) -> str:
    """
    选择最多 max_examples 条 few-shot 正例，返回格式化后的 Prompt 注入文本。

    如果加载失败或没有匹配样例，返回空字符串。
    """
    try:
        candidates = _load_examples()
    except Exception as e:
        logger.warning(f"Few-shot selector load failed: {e}")
        return ""

    if not candidates:
        return ""

    # 判断助教场景类型
    combined_text = f"{user_intent} {extra_note or ''}"
    is_assistant_experience = _has_keyword(combined_text, ASSISTANT_EXPERIENCE_KEYWORDS)
    is_technical_assistant = _has_keyword(combined_text, TECHNICAL_ASSISTANT_KEYWORDS)

    # 打分
    scored = []
    for ex in candidates:
        s = _score_example(
            ex, role, target_customer_type, output_package, user_intent,
            is_assistant_experience, is_technical_assistant,
        )
        scored.append((s, ex))

    # 按分数降序排列
    scored.sort(key=lambda x: x[0], reverse=True)

    # 取前 max_examples 条（分数 > 0 的）
    selected = [ex for s, ex in scored if s > 0][:max_examples]

    if not selected:
        logger.info("Few-shot selector: no matching examples found (all scores = 0)")
        return ""

    logger.info(
        "Few-shot selected %d examples: %s",
        len(selected),
        [(ex["id"], s) for s, ex in scored[:max_examples] if s > 0],
    )

    return _format_examples(selected)
