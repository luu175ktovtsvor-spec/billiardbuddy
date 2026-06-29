"""店脑召回:durable 店情始终注入;episodic 一次性情景只在【判得准相关性】时注入,否则不注入,防串台。

复现 owner 真机:每个新会话都冒出"小张/盘货"(episodic)串到不相关任务。
- 装机包实际跑词面回退嵌器(semantic=False)→ episodic 一律不注入(判不准,宁缺毋滥)。
- 装了真 bge(semantic=True)→ episodic 按相关性门控。
"""
import pytest

from services.memory_service import Memory, select_relevant_memories


def _contents(mems):
    return [m.content for m in mems]


def test_literal_embedder_excludes_episodic_keeps_durable():
    """装机包真实场景:词面回退嵌器 → episodic 不注入,durable 店情 + manual 店规矩照常。"""
    mems = [
        Memory("episodic", "老顾客小张大约半个月没来店消费了", "medium", "auto"),
        Memory("episodic", "今天安排上午盘货下午发抖音晚上散客赛", "medium", "auto"),
        Memory("semantic", "本店主打学生和年轻竞技客群", "high", "auto"),
        Memory("preference", "老板偏好简洁直接的文案", "medium", "auto"),
        Memory("operational", "周二会员日台费五折", "high", "manual"),
    ]
    out = _contents(select_relevant_memories(mems, "周末有个抢一大战帮我做个预热小视频发抖音"))
    assert "老顾客小张大约半个月没来店消费了" not in out   # episodic → 不串台
    assert "今天安排上午盘货下午发抖音晚上散客赛" not in out  # episodic → 不串台
    assert "本店主打学生和年轻竞技客群" in out             # durable 店情 → 始终在场
    assert "老板偏好简洁直接的文案" in out                 # durable → 在场
    assert "周二会员日台费五折" in out                     # manual 店规矩 → 始终在场


def test_no_intent_keeps_all_backward_compat():
    mems = [
        Memory("episodic", "老顾客小张没来", "medium", "auto"),
        Memory("semantic", "本店主打学生客群", "high", "auto"),
    ]
    assert len(select_relevant_memories(mems, None)) == 2  # 无意图全留


class _FakeSemanticEmbedder:
    """模拟真 bge:按关键词给语义方向,让相关对余弦高、不相关对余弦低。"""
    semantic = True

    def embed(self, text):
        if any(k in text for k in ("没来", "唤回", "叫他回来", "好久没")):
            return [1.0, 0.0]
        if any(k in text for k in ("视频", "抢一大战", "预热")):
            return [0.0, 1.0]
        return [0.6, 0.6]


def test_semantic_embedder_gates_episodic_by_relevance(monkeypatch):
    monkeypatch.setattr("services.rag.embedder.get_embedder", lambda: _FakeSemanticEmbedder())
    epi = Memory("episodic", "老顾客小张半个月没来店里消费", "medium", "auto")
    # 相关意图(唤回老顾客)→ 注入
    out_rel = _contents(select_relevant_memories([epi], "老顾客好久没来了帮我想句话叫他回来"))
    assert any("小张" in c for c in out_rel)
    # 不相关意图(做视频)→ 不注入
    out_irr = _contents(select_relevant_memories([epi], "周末抢一大战帮我做个预热视频"))
    assert not any("小张" in c for c in out_irr)
