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


# ── A-7 Contextual Retrieval（确定性上下文前缀；不调 LLM、不花 BYOK 钱）──

def test_context_prefix_built_deterministically():
    """带元数据拼出的前缀：含场景、日期(+中文月)、意图/活动、效果好——纯元数据确定性拼。"""
    from services.rag.recall import build_context_prefix
    prefix = build_context_prefix({
        "sub_type": "朋友圈",
        "ts": "2026-03-08T10:00:00+08:00",
        "input_params": {"scenario": "双十一五折"},
        "effect_rating": "good",
    })
    assert prefix.startswith("【") and prefix.endswith("】")
    assert "朋友圈" in prefix          # 场景(sub_type)
    assert "2026-03-08" in prefix      # 日期
    assert "三月" in prefix            # 中文月（让"三月"类查询能命中）
    assert "双十一五折" in prefix       # 意图/活动(input_params)
    assert "效果好" in prefix          # 好评 → 效果好


def test_context_prefix_empty_when_no_meta():
    """没任何元数据 → 不硬塞前缀，返回空串。"""
    from services.rag.recall import build_context_prefix
    assert build_context_prefix(None) == ""
    assert build_context_prefix({}) == ""


def test_favorite_marks_effect_good():
    """收藏(is_favorite)也算效果好，能被前缀带上。"""
    from services.rag.recall import build_context_prefix
    prefix = build_context_prefix({"sub_type": "群公告", "is_favorite": True})
    assert "效果好" in prefix


def test_indexed_text_contains_context_prefix():
    """带元数据入库后，索引里存的文本【含确定性上下文前缀】（钉死 A-7 核心行为）。"""
    from services.rag import index_store
    from services.rag.recall import index_text

    sid = "store-ctx"
    index_text(
        sid, "generation", "g1", "双十一全场五折活动朋友圈文案",
        ts="2026-03-08T10:00:00+08:00",
        meta={"sub_type": "朋友圈", "input_params": {"scenario": "双十一五折"},
              "effect_rating": "good"},
    )
    rows = index_store._conn().execute(
        "SELECT text FROM vectors WHERE store_id=? AND source_id=?", (sid, "g1")
    ).fetchall()
    indexed = rows[0][0]
    assert indexed.startswith("【")                # 前缀在原文前面
    assert "2026-03-08" in indexed and "三月" in indexed
    assert "双十一五折" in indexed and "效果好" in indexed
    assert "双十一全场五折活动朋友圈文案" in indexed   # 原文也还在


def test_no_meta_keeps_plain_text_unchanged():
    """不带元数据/不带 ts 时，索引文本就是原文，不加前缀（保持现有行为不破）。"""
    from services.rag import index_store
    from services.rag.recall import index_text

    sid = "store-plain"
    index_text(sid, "generation", "g1", "纯文案没有元数据")
    rows = index_store._conn().execute(
        "SELECT text FROM vectors WHERE store_id=? AND source_id=?", (sid, "g1")
    ).fetchall()
    assert rows[0][0] == "纯文案没有元数据"          # 一字不差，无前缀


def test_recall_hits_via_context_prefix():
    """前缀进了索引文本 → 用前缀里的词(效果好/月份)查询也能命中（A-7 收益）。"""
    from services.rag.recall import index_text, recall

    sid = "store-ctx2"
    index_text(sid, "generation", "g1", "全场五折活动朋友圈文案",
               ts="2026-03-08T10:00:00+08:00",
               meta={"sub_type": "朋友圈", "effect_rating": "good"})
    # 无效果元数据的对照条（原文本身不含"效果好"/月份）
    index_text(sid, "generation", "g2", "周末双人优惠群公告")

    hits = recall(sid, "三月 效果好的", top=2)
    assert hits, "应能借前缀里的月份/效果命中"
    assert hits[0]["source_id"] == "g1"            # 带前缀那条命中在前
