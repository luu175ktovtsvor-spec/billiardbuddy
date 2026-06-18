"""真 RAG 核心测试（嵌入 + 本地向量库 + 召回）。

锁住（用确定性词面嵌入，可重复）：
- 同文本相似度≈1；相关文本(共享词)比无关的高；空文本→零向量
- 索引后召回把最相关的排前面；空查询→空
- 主键去重(同一条重复索引不重复)
"""
import pytest

from services.rag.embedder import DeterministicEmbedder, cosine


@pytest.fixture(autouse=True)
def _isolated_index(tmp_path, monkeypatch):
    """把向量库指向 tmp，隔离真实 ~/.billiards-desktop；每例清连接缓存。"""
    monkeypatch.setenv("DESKTOP_RAG_DIR", str(tmp_path / "rag"))
    monkeypatch.delenv("RAG_EMBEDDER", raising=False)  # 用确定性后端
    from services.rag import index_store
    index_store.reset_for_test()
    # 嵌入器单例可能被别的测试设过，强制回到确定性
    import services.rag.embedder as emb
    emb._embedder = DeterministicEmbedder()
    yield
    index_store.reset_for_test()


def test_embedder_similarity():
    e = DeterministicEmbedder()
    v1 = e.embed("双十一活动朋友圈")
    v2 = e.embed("双十一活动朋友圈")
    v_related = e.embed("双十一活动群公告")
    v_unrelated = e.embed("助教薪资结构说明")
    assert cosine(v1, v2) == pytest.approx(1.0, abs=1e-6)      # 同文≈1
    assert cosine(v1, v_related) > cosine(v1, v_unrelated)      # 相关>无关
    assert all(x == 0.0 for x in e.embed(""))                  # 空→零向量


def test_index_and_recall_ranks_relevant_first():
    from services.rag.recall import index_text, recall

    sid = "store-1"
    index_text(sid, "generation", "g1", "双十一全场五折活动朋友圈文案")
    index_text(sid, "generation", "g2", "周末双人台球优惠群公告")
    index_text(sid, "generation", "g3", "助教晋升等级体系说明")

    hits = recall(sid, "双十一活动", top=3)
    assert hits, "应召回到相关内容"
    assert hits[0]["source_id"] == "g1"        # 双十一那条最相关、排第一
    assert "助教" not in (hits[0]["text"] or "")


def test_recall_empty_query():
    from services.rag.recall import recall
    assert recall("store-1", "") == []


def test_upsert_dedup():
    from services.rag import index_store
    from services.rag.recall import index_text

    sid = "store-2"
    index_text(sid, "generation", "g1", "第一版文案")
    index_text(sid, "generation", "g1", "改过的第二版文案")  # 同主键 → 覆盖
    ids = index_store.existing_ids(sid, "generation")
    assert ids == {"g1"}                        # 只有一条，没重复
    hits = index_store.search(sid, DeterministicEmbedder().embed("第二版"), top=5)
    assert any("第二版" in h["text"] for h in hits)  # 存的是覆盖后的新版


def test_store_isolation():
    from services.rag.recall import index_text, recall
    index_text("A", "generation", "g1", "甲店的活动文案")
    index_text("B", "generation", "g1", "乙店的活动文案")
    hits = recall("A", "活动文案", top=5)
    assert all(h["source_id"] == "g1" for h in hits)
    assert all("甲店" in h["text"] for h in hits)  # 只召回本店的，不串店
