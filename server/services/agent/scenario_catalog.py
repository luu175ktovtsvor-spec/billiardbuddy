"""场景模板目录（P2 卡片融合·清单法，非向量 RAG）。

把岗位工作台那 60+ 个"精修场景模板"做成一张【清单】给 Agent：老板说一句话 →
Agent 调 find_scenario 查清单 → 挑最贴切的一个 prompt_key → 用 write_operation_content
带着这个 prompt_key 写，输出 = 直接点那张卡片同款的校准内容。

为什么是清单法不是 RAG：这些模板是结构化、有明确中文名/场景标签的策展内容，
让模型从一张带名字的清单里挑（它擅长语义匹配）就够了，不值得为它上嵌入/向量检索。
真正的向量 RAG 留给"老板本机越攒越多的数据"那个场景。

匹配只做轻量【二元组(bigram)重叠】排序辅助——把最可能相关的排前面，但仍把整张清单给模型挑，
不靠脆弱的关键词命中下死手。
"""
from services.ai.prompt_engine import get_prompt_engine

# 可被 prompt_key 直接调起的"内容场景"模板类别（rules/knowledge/fewshots 不算）
_CONTENT_CATEGORIES = {"operation", "copywriting", "activity"}


def get_catalog() -> list[dict]:
    """[{key, name}] —— 所有可调起的精修场景模板。每次按当前已加载模板构建（约几十条，开销可忽略）。"""
    eng = get_prompt_engine()
    items: list[dict] = []
    for t in eng.list_templates():
        if t.get("category") in _CONTENT_CATEGORIES and t.get("name"):
            items.append({"key": t["key"], "name": t["name"]})
    items.sort(key=lambda x: x["key"])
    return items


def _bigrams(s: str) -> set[str]:
    """中文二元组（去空白）。'强一比赛' → {'强一','一比','比赛'}。"""
    s = "".join(ch for ch in (s or "") if not ch.isspace())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def rank_scenarios(need: str, catalog: list[dict] | None = None, top: int | None = None) -> list[dict]:
    """按与 need 的二元组重叠度给场景排序（相关的排前面）。need 空则按原序返回。
    top 限制条数（None=全返回）。每条附带 _score，便于调用方判断有没有强相关。"""
    cat = catalog if catalog is not None else get_catalog()
    nb = _bigrams(need)
    scored = []
    for e in cat:
        score = len(nb & _bigrams(e["name"])) if nb else 0
        scored.append({**e, "_score": score})
    scored.sort(key=lambda x: x["_score"], reverse=True)
    return scored[:top] if top else scored


def format_catalog_for_model(need: str = "") -> str:
    """给 find_scenario 工具返回的文本：按相关度排好的清单，让模型挑一个 prompt_key。"""
    ranked = rank_scenarios(need)
    if not ranked:
        return "（暂无可用的精修场景模板，直接用 write_operation_content 写即可。）"
    lines = [f"- {e['key']} — {e['name']}" for e in ranked]
    head = "可用的精修场景模板（已按和你的需求的相关度排序，挑【最贴切的一个】，" \
           "把它的 key 作为 write_operation_content 的 prompt_key 参数；都不贴切就别用 prompt_key、直接写）："
    return head + "\n" + "\n".join(lines)
