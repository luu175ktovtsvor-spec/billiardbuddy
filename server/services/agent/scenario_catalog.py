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

# 五业务域中文名（知识库模块化重构）：给 find_scenario 输出标注每个场景属哪个运营域，
# 让编排脑按 L0 模块地图的同一套域心智来路由（任务属哪域 → 挑该域的精修场景）。
_DOMAIN_CN = {
    "strategy": "战略认知",
    "marketing": "营销获客",
    "customer-ops": "客户运营",
    "talent-mgmt": "人才管理",
    "data-analysis": "数据诊断",
}


def get_catalog() -> list[dict]:
    """[{key, name, domain, tags}] —— 所有可调起的精修场景模板。每次按当前已加载模板构建（约几十条，开销可忽略）。

    domain/tags 取自 Phase 1 打的模块化元数据（operation 全有；copywriting/activity 多为空，留空即可），
    供 rank_scenarios 的 facet 辅助排序 + format 的域标注用。"""
    eng = get_prompt_engine()
    items: list[dict] = []
    for t in eng.list_templates():
        if t.get("category") in _CONTENT_CATEGORIES and t.get("name"):
            data = eng._templates.get(t["key"]) or {}
            items.append({
                "key": t["key"],
                "name": t["name"],
                "domain": data.get("domain", "") or "",
                "tags": list(data.get("tags") or []),
            })
    items.sort(key=lambda x: x["key"])
    return items


def _facet_text(tags) -> str:
    """把 facet 标签（如 ['scene:约客','role:助教','channel:私域']）的【值】部分拼成可做 bigram 匹配的文本
    （去掉 'scene:'/'role:' 这类前缀）。空标签返回空串。"""
    out: list[str] = []
    for t in tags or []:
        s = str(t)
        out.append(s.split(":", 1)[1] if ":" in s else s)
    return "".join(out)


def _bigrams(s: str) -> set[str]:
    """中文二元组（去空白）。'强一比赛' → {'强一','一比','比赛'}。"""
    s = "".join(ch for ch in (s or "") if not ch.isspace())
    if len(s) < 2:
        return {s} if s else set()
    return {s[i:i + 2] for i in range(len(s) - 1)}


def rank_scenarios(need: str, catalog: list[dict] | None = None, top: int | None = None,
                   use_facets: bool = False) -> list[dict]:
    """按与 need 的二元组重叠度给场景排序（相关的排前面）。need 空则按原序返回。
    top 限制条数（None=全返回）。每条附带 _score，便于调用方判断有没有强相关。

    use_facets=False（默认）：纯【名字】bigram 分——pick_best_prompt_key 的兜底门槛（_MIN_FALLBACK_SCORE）
    走这条，保持"只有名字够贴切才自动套精修模板"的保守语义不变。
    use_facets=True：名字分 + facet 标签命中【每个 +0.5】的辅助加分——给"名字没写全、但标签贴切"的场景往前排，
    仅用于 format_catalog_for_model 给模型浏览挑选；加分上不封顶但每个标签只 0.5，不参与（也不会放松）兜底门槛判定。"""
    cat = catalog if catalog is not None else get_catalog()
    nb = _bigrams(need)
    scored = []
    for e in cat:
        if nb:
            score: float = len(nb & _bigrams(e.get("name", "")))
            if use_facets:
                score += 0.5 * len(nb & _bigrams(_facet_text(e.get("tags"))))
        else:
            score = 0
        scored.append({**e, "_score": score})
    scored.sort(key=lambda x: x["_score"], reverse=True)
    return scored[:top] if top else scored


# 兜底匹配门槛：bigram 重叠分≥此值才认为"够贴切、值得用精修模板"。
# 太低会乱套不相关模板，太高则白白漏掉精修。need 与场景名通常共享 2-3 个 bigram 才算相关。
_MIN_FALLBACK_SCORE = 2


def pick_best_prompt_key(need: str, catalog: list[dict] | None = None) -> str | None:
    """【确定性兜底】对 need 选一个最相关的精修场景 prompt_key；够不到门槛就返回 None。

    用于 write_operation_content：模型没主动传 prompt_key 时，别直接走泛化 free_intent
    漏掉精修模板——这里按场景名的 bigram 重叠确定性挑一个最贴切的。找不到贴切的（分太低）
    才返回 None、退回泛化写法。need 为空返回 None（不强塞模板）。
    """
    if not (need or "").strip():
        return None
    ranked = rank_scenarios(need, catalog=catalog, top=1)
    if ranked and ranked[0].get("_score", 0) >= _MIN_FALLBACK_SCORE:
        return ranked[0]["key"]
    return None


def format_catalog_for_model(need: str = "") -> str:
    """给 find_scenario 工具返回的文本：按相关度排好的清单（含 facet 辅助排序 + 运营域标注），
    让模型按 L0 模块地图的同一套域心智挑一个 prompt_key。"""
    ranked = rank_scenarios(need, use_facets=True)
    if not ranked:
        return "（暂无可用的精修场景模板，直接用 write_operation_content 写即可。）"
    lines = []
    for e in ranked:
        dom_cn = _DOMAIN_CN.get(e.get("domain", ""), "")
        tail = f"（{dom_cn}）" if dom_cn else ""
        lines.append(f"- {e['key']} — {e['name']}{tail}")
    head = "可用的精修场景模板（已按和你的需求的相关度排序，括号内是它所属的运营域；先判断这件事属哪个域、" \
           "再挑该域里【最贴切的一个】，把它的 key 作为 write_operation_content 的 prompt_key 参数；" \
           "都不贴切就别用 prompt_key、直接写）："
    return head + "\n" + "\n".join(lines)
