"""A-2：知识召回「语义为主路径」。

锁住改造后的 _select_knowledge_keys：
- 装了语义模型时，语义相关但【零关键词命中】的知识也能被选中（旧逻辑做不到——旧逻辑语义只填空位）；
- 关键词命中降为加分项（影响排序），不再是必须先命中的门槛；
- 核心知识始终注入、原始顺序保留、上限 _MAX_SCENE_KNOWLEDGE 不破；
- 没装语义模型时回退关键词+bigram（原行为不变）。

语义打分用 monkeypatch 注入（测试环境通常没装 fastembed），不依赖真实向量模型。
"""
from services import content_service as cs


def _patch_semantic(monkeypatch, scores: dict, keywords: dict, core=()):
    monkeypatch.setattr(cs, "_semantic_available", lambda: True)
    monkeypatch.setattr(cs, "_semantic_scores", lambda intent, cands: scores)
    monkeypatch.setattr(cs, "KNOWLEDGE_KEYWORDS", keywords)
    monkeypatch.setattr(cs, "_is_core_knowledge", lambda k: k in core)


def test_semantic_relevant_without_keyword_gets_selected(monkeypatch):
    """语义相关、零关键词命中 → 进（语义为主，旧逻辑做不到）。"""
    _patch_semantic(
        monkeypatch,
        scores={"knowledge.k_sem": 0.72, "knowledge.k_kw": 0.10, "knowledge.k_none": 0.0},
        keywords={"knowledge.k_kw": ["拉新"]},
    )
    out = cs._select_knowledge_keys(
        ["knowledge.k_sem", "knowledge.k_kw", "knowledge.k_none"], "搞个拉新活动"
    )
    assert "knowledge.k_sem" in out      # 语义够相关、零关键词 → 进
    assert "knowledge.k_kw" in out       # 关键词命中 → 进
    assert "knowledge.k_none" not in out  # 既不相关也没命中 → 不进


def test_cap_and_ranking(monkeypatch):
    """超上限时按统一分排序取前 N，高分进、低分不进；上限可经 DESKTOP_KNOWLEDGE_MAX_SCENE 配（A-3 动态化）。"""
    monkeypatch.setenv("DESKTOP_KNOWLEDGE_MAX_SCENE", "3")
    scores = {f"knowledge.k{i}": 0.9 - i * 0.1 for i in range(6)}
    _patch_semantic(monkeypatch, scores=scores, keywords={})
    out = cs._select_knowledge_keys(list(scores), "随便问问")
    assert len([k for k in out if k.startswith("knowledge.k")]) == 3
    assert "knowledge.k0" in out and "knowledge.k5" not in out


def test_dynamic_cap_default_no_silent_drop(monkeypatch):
    """A-3/C-2：默认上限提到 8，6 条相关知识不再被旧死 4 静默挤掉。"""
    monkeypatch.delenv("DESKTOP_KNOWLEDGE_MAX_SCENE", raising=False)
    scores = {f"knowledge.k{i}": 0.9 - i * 0.05 for i in range(6)}  # 6 条都 ≥ 阈值
    _patch_semantic(monkeypatch, scores=scores, keywords={})
    out = cs._select_knowledge_keys(list(scores), "复杂多意图的需求")
    assert len([k for k in out if k.startswith("knowledge.k")]) == 6  # 默认 8 → 6 条全进、不被挤掉


def test_keyword_is_bonus_not_gate(monkeypatch):
    """关键词命中是加分项：能把两条语义同分的排到关键词命中的那条前面。"""
    _patch_semantic(
        monkeypatch,
        scores={"knowledge.a": 0.5, "knowledge.b": 0.5},
        keywords={"knowledge.b": ["团购", "拉新"]},  # b 命中2个关键词 → 加分排前
    )
    out = cs._select_knowledge_keys(["knowledge.a", "knowledge.b"], "团购拉新")
    assert out == ["knowledge.a", "knowledge.b"]  # 都进(保留原序)，但 b 的分更高(命中加分)


def test_core_always_injected(monkeypatch):
    """核心知识始终注入；不相关的场景知识不进。"""
    _patch_semantic(
        monkeypatch,
        scores={"knowledge.scene": 0.0},  # 场景不相关
        keywords={},
        core=("knowledge.compliance_rules",),
    )
    out = cs._select_knowledge_keys(["knowledge.compliance_rules", "knowledge.scene"], "随便")
    assert out == ["knowledge.compliance_rules"]


def test_fallback_when_no_semantic(monkeypatch):
    """没装语义模型 → 回退关键词为主（原行为）。"""
    monkeypatch.setattr(cs, "_semantic_available", lambda: False)
    monkeypatch.setattr(cs, "KNOWLEDGE_KEYWORDS", {"knowledge.k_kw": ["拉新"]})
    monkeypatch.setattr(cs, "_is_core_knowledge", lambda k: False)
    monkeypatch.setattr(cs, "_bigram_fill", lambda intent, cands: [])
    out = cs._select_knowledge_keys(["knowledge.k_kw", "knowledge.k_other"], "搞个拉新活动")
    assert "knowledge.k_kw" in out
    assert "knowledge.k_other" not in out
