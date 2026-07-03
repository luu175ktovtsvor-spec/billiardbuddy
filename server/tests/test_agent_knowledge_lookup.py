"""A-6 编排脑感知知识 + A-5/C-3 operation 兜底 + F11 黑话冒烟评测 / RRF 融合。

锁住：
A-6 look_up_knowledge：
- 工具已注册，标 read_only=True、非 deliverable
- 对全部 knowledge.* 按 topic 排序，返回 name + description（不返回整篇正文）
- rank_knowledge_for_topic 确定性回退（没装语义模型）能把相关知识排前面

A-5/C-3 write_operation_content 兜底：
- pick_best_prompt_key 对贴切需求确定性挑模板、对泛化需求返回 None
- 模型没传 prompt_key 时，贴切需求会兜底挑一个精修模板再渲染
- 模型传了无效（不存在）prompt_key 时，当没传、走兜底
- 模型主动传了【有效】prompt_key 的正常路径不被破坏
- 泛化需求（无贴切模板）退回 free_intent（prompt_key=None）

F11 检索冒烟评测 + RRF 融合（真机实测否决 FTS5，见 content_service.py 顶部注释）：
- 台球黑话/别名换说法/模糊问法 20 题，召回预期 key 进 top-5（测试环境 embedder=deterministic，
  跑的是关键词-bigram 确定性路径，见下方 _rank_topic_hits fixture 说明）
- _rrf_fuse 是纯函数（可独立单测数学正确性）
- 语义模式（monkeypatch _semantic_available=True）下，RRF 融合仍让黑话精确词命中的关键词-bigram
  信号贡献召回，不被语义单路径挤掉
"""
import asyncio
from types import SimpleNamespace

import pytest

import services.agent.tools as agent_tools
import services.content_service as content_service
from services.agent.registry import default_registry
from services.agent.scenario_catalog import pick_best_prompt_key
from services.content_service import rank_knowledge_for_topic, _rrf_fuse


def _ctx(role="manager"):
    return SimpleNamespace(db=object(), store=SimpleNamespace(id="s1"), user=SimpleNamespace(my_role=role))


# ---- A-6 look_up_knowledge ----

def test_look_up_knowledge_registered_readonly_not_deliverable():
    t = default_registry.get("look_up_knowledge")
    assert t is not None
    assert t.read_only is True
    assert t.deliverable is False
    assert t.requires_approval is False
    assert "topic" in t.parameters["properties"]


def test_rank_knowledge_returns_name_and_description_not_full_body():
    hits = rank_knowledge_for_topic("助教推广获客", top=5)
    assert 1 <= len(hits) <= 5
    for h in hits:
        assert h.get("key", "").startswith("knowledge.")
        assert h.get("name")
        assert "description" in h
        # 只返回索引：description 是短句，不该是整篇正文（行业知识正文动辄上千字）
        assert len(h["description"]) < 600


def test_rank_knowledge_relevance_orders_assistant_topic():
    # "助教"相关 topic 应把助教类知识排进前几条（确定性回退：关键词命中 + bigram）
    hits = rank_knowledge_for_topic("助教薪资提成怎么定", top=5)
    keys = {h["key"] for h in hits}
    assert any("assistant" in k for k in keys)


def test_rank_knowledge_empty_topic_deterministic():
    a = rank_knowledge_for_topic("", top=3)
    b = rank_knowledge_for_topic("", top=3)
    assert [h["key"] for h in a] == [h["key"] for h in b]  # 确定性
    assert len(a) == 3


def test_look_up_knowledge_tool_returns_reference_text():
    out = asyncio.run(agent_tools.look_up_knowledge({"topic": "能不能涨价"}, ctx=None))
    assert "行业知识【目录】" in out
    assert "【" in out and "】" in out          # 每条带【name】
    assert "key:" in out and "read_knowledge" in out  # C.2：目录带 key + 指引用 read_knowledge 读整篇


# ---- A-5/C-3 write_operation_content 兜底 ----

def test_pick_best_prompt_key_relevant_hits_template():
    # 用假目录确定性验证（强一比赛名字命中）
    fake = [
        {"key": "operation.qiangyi_battle", "name": "强一比赛主持词"},
        {"key": "operation.assistant_promo", "name": "助教推广文案"},
    ]
    assert pick_best_prompt_key("帮我搞个强一比赛主持", catalog=fake) == "operation.qiangyi_battle"


def test_pick_best_prompt_key_generic_returns_none():
    fake = [{"key": "operation.qiangyi_battle", "name": "强一比赛主持词"}]
    # 完全不沾边的泛化需求 → 分太低 → None（退回 free_intent）
    assert pick_best_prompt_key("今天天气真好", catalog=fake) is None
    assert pick_best_prompt_key("", catalog=fake) is None


def test_write_operation_content_fallback_picks_template(monkeypatch):
    """模型没传 prompt_key，但需求贴切某精修场景 → 兜底挑一个 prompt_key 再渲染（不漏精修）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="精修输出", input_params={"knowledge_used": []})

    # 用确定性兜底（真实目录里有 copywriting.holiday_promo「节日促销文案」）
    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content({"need": "来个节日促销文案"}, _ctx()))
    assert captured["prompt_key"] is not None  # 兜底挑到了精修模板
    assert captured["prompt_key"] == "copywriting.holiday_promo"


def test_write_operation_content_invalid_key_falls_back(monkeypatch):
    """模型编了个不存在的 prompt_key → 当没传，走兜底（不会把无效 key 塞进渲染）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="x", input_params={"knowledge_used": []})

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content(
        {"need": "来个节日促销文案", "prompt_key": "operation.this_does_not_exist"}, _ctx()))
    assert captured["prompt_key"] != "operation.this_does_not_exist"  # 无效 key 没被透传
    assert captured["prompt_key"] == "copywriting.holiday_promo"  # 改走兜底


def test_write_operation_content_valid_model_key_preserved(monkeypatch):
    """模型主动传了【有效】prompt_key → 正常路径不被破坏（原样透传，不被兜底覆盖）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="x", input_params={"knowledge_used": []})

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content(
        {"need": "随便写点啥", "prompt_key": "operation.qiangyi_battle"}, _ctx()))
    assert captured["prompt_key"] == "operation.qiangyi_battle"


def test_write_operation_content_generic_need_uses_free_intent(monkeypatch):
    """泛化需求、无贴切模板 → prompt_key=None，退回 free_intent（不强塞模板）。"""
    captured = {}

    async def fake_gw(db, store, user, **kwargs):
        captured.update(kwargs)
        return SimpleNamespace(result="x", input_params={"knowledge_used": []})

    monkeypatch.setattr(agent_tools, "generate_workbench", fake_gw)
    asyncio.run(agent_tools.write_operation_content({"need": "今天天气真好啊随便聊聊"}, _ctx()))
    assert captured["prompt_key"] is None


# ═══════════════ F11 · 台球黑话检索冒烟评测 ═══════════════
# 测试环境 get_embedder().name == "deterministic"（没装真 fastembed），_semantic_available() 恒为
# False —— 以下评测走的是【关键词-bigram 确定性路径】(_keyword_bigram_ranking)，不是语义/RRF 路径。
# 这条路径是生产环境"没装语义模型"时的唯一路径、也是"装了语义模型"时 RRF 融合的第二路，
# 所以评测质量在两种环境下都有意义：黑话精确词必须能被稳定召回。
#
# 期望 key 的选取标准（对照 KNOWLEDGE_KEYWORDS 字典 + 各 knowledge YAML 逐条核实）：
# 只挑关键词/黑话在【唯一一条】knowledge key 下出现的问题（无歧义），模棱两可的一律不选
# （例如"刷评"同时出现在 platform_operations/review_generation_rules/traffic_priority 三条里，
# 排除）。
KNOWLEDGE_SMOKE_CASES = [
    # —— 黑话（台球行业黑话，2 字词为主，是 FTS5 trigram 分词器啃不动、本单要保的召回信号）——
    ("追分", "knowledge.gaming_customer_ops", "黑话：追分局"),
    ("上钟", "knowledge.assistant_service_sop", "黑话：助教上钟服务"),
    ("超休", "knowledge.assistant_overtime_service", "黑话：助教超休"),
    ("PK", "knowledge.pk_incentive", "黑话：PK 激励"),
    ("灌酒", "knowledge.assistant_difficult_situations", "黑话：客人灌酒"),
    ("彩头", "knowledge.gaming_customer_ops", "黑话：追分彩头"),
    ("赛马", "knowledge.store_manager_competency", "黑话：店长赛马机制"),
    ("赋能", "knowledge.assistant_tier_system", "黑话：助教赋能升级"),
    ("皮头", "knowledge.cost_control", "黑话：球杆皮头耗材"),
    ("巧粉", "knowledge.cost_control", "黑话：巧粉耗材"),
    # —— 别名 / 换说法（同一件事的另一种叫法，不是 KNOWLEDGE_KEYWORDS 里那个"标准词"本身）——
    ("陪出去", "knowledge.assistant_overtime_service", "别名：超休 = 陪出去"),
    ("追分客", "knowledge.gaming_customer_ops", "别名：追分 = 追分客"),
    ("陪打", "knowledge.assistant_service_sop", "别名：上钟 = 陪打"),
    ("保底", "knowledge.assistant_salary", "别名：助教保底薪资"),
    # "点钟"是真实黑话（客户预约/选定助教服务），且不在 KNOWLEDGE_KEYWORDS 任何列表里——
    # 纯靠内容/名称 bigram 重叠召回（growth_playbook.yaml 正文两处出现"点钟"），验证不靠手配
    # 关键词表也能召回真实存在的说法。
    ("点钟", "knowledge.growth_playbook", "别名：点钟（约助教消费习惯）"),
    # —— 模糊问法（完整自然语句，黑话词嵌在句子中间，验证长句噪声不冲淡关键词信号）——
    ("今天有个客人一直给助教灌酒,助教实在喝不下了该怎么委婉拒绝", "knowledge.assistant_difficult_situations", "模糊：灌酒场景整句"),
    ("店里想搞个店长之间比赛绩效的赛马机制,该怎么设计考核规则", "knowledge.store_manager_competency", "模糊：赛马机制整句"),
    ("台球桌用久了台呢该多久换一次,巧粉和皮头这些耗材怎么控成本", "knowledge.cost_control", "模糊：耗材成本整句"),
    ("追分氛围怎么带动起来", "knowledge.gaming_customer_ops", "模糊：追分氛围"),
    # 本题是 TDD 的 RED→GREEN 见证：原 KNOWLEDGE_KEYWORDS["knowledge.cost_control"] 只配了
    # "台呢更换"（4 字连续串），这句自然问法是"台呢多久换一次"，不含该 4 字连续子串、命中不了
    # 关键词、又没有其它 key 更强的 bigram 信号能救——改前召不回 top-5（RED）。
    # 修复：给该 key 补上更短的裸词"台呢"（cost_control.yaml 正文本就反复出现"台呢"，YAML 原文
    # 有据，非新造词）。改后 GREEN，且改动只加一个词、不影响其它任何知识的排序（全量测试已回验）。
    ("台呢多久换一次比较合适", "knowledge.cost_control", "换说法：台呢更换周期（TDD RED→GREEN 用例）"),
]


@pytest.mark.parametrize("topic,expected_key,label", KNOWLEDGE_SMOKE_CASES)
def test_knowledge_smoke_recalls_expected_key(topic, expected_key, label):
    hits = rank_knowledge_for_topic(topic, top=5)
    keys = [h["key"] for h in hits]
    assert expected_key in keys, (
        f"[{label}] 问「{topic}」期望召回 {expected_key} 进 top-5，实际 top-5={keys}"
    )


def test_knowledge_smoke_case_count_in_expected_range():
    """评测题量在施工单要求的 15-20 条区间内，防止后续被悄悄删到没意义。"""
    assert 15 <= len(KNOWLEDGE_SMOKE_CASES) <= 20


# ═══════════════ F11 · _rrf_fuse 纯函数单测 ═══════════════

def test_rrf_fuse_pure_math_two_lists():
    """两路排名手算验证 RRF 数学：a=[a,b,c] b=[b,c,a]，k=60。
    分数：a=1/61+1/63≈0.032266；b=1/62+1/61≈0.032522；c=1/63+1/62≈0.032002。
    降序应为 b > a > c。
    """
    fused = _rrf_fuse([["a", "b", "c"], ["b", "c", "a"]], k=60)
    assert fused == ["b", "a", "c"]


def test_rrf_fuse_item_only_in_one_ranking_still_counted():
    """只出现在一路里的 key 仍应拿到那一路的分、不因为没在另一路出现就被排除或清零。"""
    fused = _rrf_fuse([["x", "y"], ["z"]], k=60)
    assert set(fused) == {"x", "y", "z"}
    # x 在唯一一路里排第 0 名，分数最高 → 排最前
    assert fused[0] == "x"
    # z 是"另一路排第 0 名"（1/61），应排在同路排第 1 名的 y（1/62，分更低）前面
    assert fused.index("z") < fused.index("y")


def test_rrf_fuse_agreement_beats_single_top_rank():
    """两路都认可的 item（哪怕都不是各自第一名）应能超过只被一路捧到第一但另一路完全没有的 item——
    这正是 RRF「多路一致优于单路极端」的核心价值，用于本单"黑话精确词在语义模式下也该被拉进来"。
    """
    # d 是"关键词强命中但语义完全不识别"的极端项：语义路里不存在（=没有语义分/排最后由调用方决定），
    # 关键词路里排第 0 名。e/f 两路都出现、排名居中——验证两路共识跑赢单路极端置顶。
    ranking_a = ["d", "e", "f"]      # 关键词路：d 精确命中，排最前
    ranking_b = ["e", "f", "g"]      # 语义路：d 完全不在（模拟"语义对短黑话不敏感"到榜都上不了）
    fused = _rrf_fuse([ranking_a, ranking_b], k=60)
    # e 两路都在（0+61分之1, 62分之1量级）应该排到 d（只在一路且分数为 1/61）前面或紧邻，
    # 关键先验证两路都在的 e 排名不落后于只在单路的 d太多——即 e 一定进前二。
    assert fused.index("e") <= 1
    # 钉死核心结论：两路共识（e）确实跑赢了只在单路极端置顶的 d，不只是"进前二"这种松断言。
    assert fused.index("e") < fused.index("d")


def test_rrf_fuse_empty_rankings_returns_empty():
    assert _rrf_fuse([]) == []
    assert _rrf_fuse([[], []]) == []


def test_rrf_fuse_deterministic_tie_break_by_first_appearance():
    """同分时按首次出现顺序稳定排列（纯函数确定性，不依赖 dict 迭代顺序等偶然因素）。

    用 ["x"] 和 ["y"] 两路各自单元素：x、y 各在自己那一路排第 0 名，同拿 1/61 分——
    真正撞上同分、才会走到 order_index 这条 tie-break 分支（若像旧用例那样把 x/y 塞进
    同一路 ["p","q"]，两者排名 0/1 分数天然不同，tie-break 代码根本不会被执行到）。
    x 所在的 ranking 先传入、先被记入 order，故同分时排在 y 前面。
    """
    fused1 = _rrf_fuse([["x"], ["y"]], k=60)
    fused2 = _rrf_fuse([["x"], ["y"]], k=60)
    assert fused1 == fused2 == ["x", "y"]


# ═══════════════ F11 · 语义模式下 RRF 融合让黑话精确词不被语义挤掉 ═══════════════

def test_rank_knowledge_semantic_mode_fuses_keyword_signal_via_rrf(monkeypatch):
    """核心场景（本单主诉求）：装了语义模型时，若语义向量把某条知识打到全场垫底（模拟"语义对
    2 字黑话不敏感"），但该知识在关键词-bigram 路径上因黑话精确命中排第一——RRF 融合后仍应把
    它拉回 top-N，不能因为切到语义模式就把这条黑话精确信号弄丢。

    用完全受控的假 key（跟 test_knowledge_semantic_primary.py 的 _patch_semantic 同一手法），
    不用真实知识库的 60 条候选——避免真实内容的 bigram/语义分布带来跟本测试意图无关的噪声，
    只隔离验证"两路怎么被 _rrf_fuse 组合"这一条链路。
    """
    fake_keys = ["knowledge.k_target", "knowledge.k_a", "knowledge.k_b", "knowledge.k_c"]
    monkeypatch.setattr(content_service, "_all_knowledge_keys", lambda: fake_keys)
    monkeypatch.setattr(content_service, "_semantic_available", lambda: True)
    # 语义打分：target 垫底(0.0)，其余三条依次递减但都远高于 target——模拟"语义完全不识别这条黑话"。
    monkeypatch.setattr(
        content_service, "_semantic_scores",
        lambda topic, cands: {"knowledge.k_target": 0.0, "knowledge.k_a": 0.9,
                               "knowledge.k_b": 0.6, "knowledge.k_c": 0.3},
    )
    # 关键词-bigram 路径：只让 target 精确命中黑话词"超休"，其余三条零命中零重叠。
    monkeypatch.setattr(content_service, "KNOWLEDGE_KEYWORDS", {"knowledge.k_target": ["超休"]})
    monkeypatch.setattr(content_service, "_content_bigrams", lambda key: set())

    topic = "超休"

    # 先证明"融合有必要"：纯语义单路径会把 target 排到全场最后一名。
    sem_only_ranking = ["knowledge.k_a", "knowledge.k_b", "knowledge.k_c", "knowledge.k_target"]
    assert sem_only_ranking[-1] == "knowledge.k_target"

    # 融合后：target 关键词精确命中(kw_ranking 排第一)应把它从垫底拉进 top-2
    # （手算 RRF k=60：k_target 总分 1/64+1/61≈0.032018，超过 k_b/k_c，仅次于 k_a）。
    hits = rank_knowledge_for_topic(topic, top=2)
    keys_out = [h["key"] for h in hits]
    assert "knowledge.k_target" in keys_out, (
        f"语义模式 RRF 融合后黑话「{topic}」仍召不回 knowledge.k_target，实际={keys_out}"
    )


def test_rank_knowledge_semantic_mode_interface_unchanged(monkeypatch):
    """语义模式接口形状不变：仍返回 {key,name,description,key_facts} 且长度不超过 top（融合改动
    只动排序，不动 _shape/返回结构）。"""
    monkeypatch.setattr(content_service, "_semantic_available", lambda: True)
    monkeypatch.setattr(content_service, "_semantic_scores",
                         lambda topic, cands: {k: 0.5 for k in cands})
    hits = rank_knowledge_for_topic("助教推广获客", top=5)
    assert 1 <= len(hits) <= 5
    for h in hits:
        assert set(h.keys()) == {"key", "name", "description", "key_facts"}


def test_rank_knowledge_no_semantic_path_unchanged_single_path(monkeypatch):
    """没装语义模型时保持关键词-bigram 单路径行为，不因为加了 RRF 融合就退化
    （直接比对 _keyword_bigram_ranking 与 rank_knowledge_for_topic 的排序完全一致）。"""
    monkeypatch.setattr(content_service, "_semantic_available", lambda: False)
    topic = "助教薪资提成怎么定"
    keys = content_service._all_knowledge_keys()
    expected = content_service._keyword_bigram_ranking(topic, keys)[:5]
    hits = rank_knowledge_for_topic(topic, top=5)
    assert [h["key"] for h in hits] == expected
