"""知识库模块化重构·路由/召回回归（施工图第6步可自动化部分）。

确定性、零成本、不联网、不烧 BYOK——把 L0→L1→L3 渐进披露链钉成永久护栏：
- 路由准：代表性【域级问题】，look_up_knowledge 的排序(rank_knowledge_for_topic)把【该域内容】
  (L1 索引页 or 该域细则)召回进 top-5（= 工具实际返回条数）→ 问营销得营销、问人事得人事。
- 索引页可发现：每个 L1 索引页对其域代表问题出现在 top-8（细则直接命中时索引页可被细则挤后，
  但必须仍在可发现范围内）。
- 链路完整（防回归）：5 个 L1 索引页的指针全指向真实 key（零死指针）；L0 模块地图列全五域、
  且指示用 look_up_knowledge 往下查。

为什么强制【字面兜底】(monkeypatch _semantic_available→False)：装了 bge-zh 的语义召回结果依环境而变、
无法跨环境断言；字面兜底是确定性的【地板】——地板过，桌面端语义召回只会更准。
"""
import re

import pytest

import services.content_service as content_service
from services.content_service import rank_knowledge_for_topic
from services.ai.prompt_engine import get_prompt_engine

# 五域代表性问题（覆盖每域多个子方向）。期望：top-5 召回该域内容、top-8 含该域索引页。
ROUTING_CASES = [
    ("strategy", "怎么给店做定位和定价"),
    ("strategy", "这门生意怎么样要不要涨价"),
    ("strategy", "选址开业筹备要注意啥"),
    ("strategy", "盈利模型怎么算成本怎么控"),
    ("marketing", "怎么把客人引进来获客拉新"),
    ("marketing", "美团抖音小红书怎么做评分和内容"),
    ("marketing", "团购套餐怎么搭"),
    ("marketing", "助教怎么推广引流"),
    ("customer-ops", "老客怎么留住搞活动复购裂变"),
    ("customer-ops", "搞个赛事玩法活动怎么策划"),
    ("customer-ops", "私域社群群怎么运营"),
    ("customer-ops", "女性客户和追分客怎么差异化对待"),
    ("talent-mgmt", "助教怎么管招聘薪资PK"),
    ("talent-mgmt", "店长各岗日报怎么写"),
    ("talent-mgmt", "排班巡检采购卫生怎么安排"),
    ("talent-mgmt", "绩效考核怎么定一票否决"),
    ("data-analysis", "报表数据怎么看诊断复盘"),
    ("data-analysis", "核心指标公式怎么算"),
    ("data-analysis", "日报月报怎么写"),
    ("data-analysis", "推广效果好不好怎么分析"),
]

_INDEX_KEYS = {
    "strategy": "knowledge.strategy_index",
    "marketing": "knowledge.marketing_index",
    "customer-ops": "knowledge.customer_ops_index",
    "talent-mgmt": "knowledge.talent_mgmt_index",
    "data-analysis": "knowledge.data_analysis_index",
}


@pytest.fixture(autouse=True)
def _force_literal_fallback(monkeypatch):
    """强制走字面兜底（确定性地板），不依赖是否装了语义模型。"""
    monkeypatch.setattr(content_service, "_semantic_available", lambda: False)


def _domain_of() -> dict[str, str]:
    eng = get_prompt_engine()
    return {k: (v.get("domain", "") or "") for k, v in eng._templates.items() if k.startswith("knowledge.")}


@pytest.mark.parametrize("domain,query", ROUTING_CASES)
def test_domain_query_recalls_same_domain(domain, query):
    """域级问题 → look_up_knowledge 的 top-5 至少召回 1 条【该域】内容（索引页 or 细则）。"""
    dom_of = _domain_of()
    top5 = [h["key"] for h in rank_knowledge_for_topic(query, top=5)]
    same = [k for k in top5 if dom_of.get(k) == domain]
    assert same, f"「{query}」期望召回 {domain} 域内容，但 top-5 都不是：{top5}"


@pytest.mark.parametrize("domain,query", ROUTING_CASES)
def test_domain_index_discoverable(domain, query):
    """每个 L1 索引页对其域代表问题在 top-8 内可被发现（被细则挤后也仍可达）。"""
    idx = _INDEX_KEYS[domain]
    top8 = [h["key"] for h in rank_knowledge_for_topic(query, top=8)]
    assert idx in top8, f"「{query}」期望 {idx} 在 top-8，实际：{top8}"


def test_index_pages_have_no_dead_pointers():
    """5 个 L1 索引页正文/描述里引用的 knowledge./operation./core. key 必须都真实存在（零死指针回归）。"""
    eng = get_prompt_engine()
    valid = set(eng._templates.keys()) | {
        "core.safety_redlines", "core.module_map", "core.operating_principles",
    }
    dead = []
    for idx in _INDEX_KEYS.values():
        data = eng._templates.get(idx) or {}
        body = str(data.get("template", "")) + str(data.get("description", ""))
        for ref in set(re.findall(r"\b((?:knowledge|operation|core)\.[a-z0-9_]+)", body)):
            if ref not in valid and ref != idx:
                dead.append((idx, ref))
    assert not dead, f"L1 索引页有死指针（指向不存在的 key）：{dead}"


def test_module_map_lists_all_domains_and_routes_to_lookup():
    """L0 模块地图（系统提示常驻）必须列全五域中文名，并指示用 look_up_knowledge 往下查（链路指令完整）。"""
    eng = get_prompt_engine()
    mm = (eng._templates.get("core.module_map") or {}).get("template", "")
    assert mm, "core.module_map 缺 template"
    for dom_cn in ("战略认知", "营销获客", "客户运营", "人才管理", "数据诊断"):
        assert dom_cn in mm, f"模块地图缺域：{dom_cn}"
    assert "look_up_knowledge" in mm, "模块地图未指示用 look_up_knowledge 往下查（断了 L0→L1 链）"


# 硬数字单一可信源文件：必须带 key_facts，且 look_up_knowledge 能把准数带回（修 A08：模型查得到准数、不上网瞎搜）
_HARD_NUMBER_FILES = [
    "knowledge.platform_operations", "knowledge.recharge_strategy", "knowledge.profit_model",
    "knowledge.scale_guide", "knowledge.assistant_salary", "knowledge.pk_incentive",
    "knowledge.tournament_rules", "knowledge.industry_data", "knowledge.core_metrics",
]


def test_hard_number_files_have_key_facts():
    """硬数字单一源文件必须带非空 key_facts（否则 look_up_knowledge 答硬数字题又得上网瞎搜）。"""
    eng = get_prompt_engine()
    missing = [k for k in _HARD_NUMBER_FILES
               if not (eng._templates.get(k) or {}).get("key_facts")]
    assert not missing, f"这些硬数字文件缺 key_facts（修 A08 的关键字段）：{missing}"


# 代表性硬数字查询 → look_up_knowledge 的 key_facts 必须带回对应准数（PPT 硬规则对照表口径）
_HARD_NUMBER_RECALL = [
    ("美团金牌店铺达成条件评分要求", "knowledge.platform_operations", ["80", "4", "3.5"]),
    ("助教薪资月业绩奖励多少", "knowledge.assistant_salary", ["170", "200", "230"]),
    ("充值活动档位怎么设", "knowledge.recharge_strategy", ["1000", "99"]),
    ("抢一大战报名费奖金", "knowledge.tournament_rules", ["10", "200"]),
    ("助教PK系数怎么定", "knowledge.pk_incentive", ["0.2", "0.3", "0.5"]),
]


@pytest.mark.parametrize("topic,expect_key,nums", _HARD_NUMBER_RECALL)
def test_look_up_surfaces_hard_numbers(topic, expect_key, nums):
    """硬数字查询 → 期望文件进 top-6 且其 key_facts 含对应准数（钉死 A08 类回归）。"""
    hits = rank_knowledge_for_topic(topic, top=6)
    hit = next((h for h in hits if h["key"] == expect_key), None)
    assert hit is not None, f"「{topic}」期望召回 {expect_key}，top6={[h['key'] for h in hits]}"
    facts_text = " ".join(hit.get("key_facts") or [])
    miss = [n for n in nums if n not in facts_text]
    assert not miss, f"「{topic}」的 {expect_key}.key_facts 缺准数 {miss}；实际={facts_text}"
