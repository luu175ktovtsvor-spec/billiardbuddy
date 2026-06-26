# -*- coding: utf-8 -*-
"""M11 知识库 / RAG 召回 三处修复的回归测试。

锁住：
- #3 知识嵌入缓存键带上 embedder 名+维度：换 embedder 后不再取到旧维度向量（否则 cosine 返 0、知识被静默判不相关）。
- #2(a) recall 已索引的生成记录被编辑后，再 backfill 会重嵌、召回拿到新内容（不再永远返回旧向量）。
- #2(b) index_store.search 有 top-k 上限、按分数降序、尊重 min_score（不全量算完再排）。
"""
import asyncio
import uuid

import pytest

from services.rag.embedder import DeterministicEmbedder


@pytest.fixture(autouse=True)
def _isolated_index(tmp_path, monkeypatch):
    """向量库指向 tmp、用确定性词面后端、清各层缓存，隔离真实环境与跨测试污染。"""
    monkeypatch.setenv("DESKTOP_RAG_DIR", str(tmp_path / "rag"))
    monkeypatch.delenv("RAG_EMBEDDER", raising=False)
    from services.rag import index_store
    index_store.reset_for_test()
    import services.rag.embedder as emb
    emb._embedder = DeterministicEmbedder()
    import services.content_service as cs
    cs._KNOWLEDGE_EMB_CACHE.clear()
    yield
    index_store.reset_for_test()
    emb._embedder = DeterministicEmbedder()
    cs._KNOWLEDGE_EMB_CACHE.clear()


class _FakeEmbedder:
    """可控名/维度/向量的假嵌入器，用来模拟"换后端"。"""
    def __init__(self, name: str, dim: int, vec: list[float]):
        self.name = name
        self.dim = dim
        self._vec = list(vec)

    def embed(self, text: str) -> list[float]:
        return list(self._vec)


# ────────── #3 知识嵌入缓存键带 embedder 名+维度 ──────────

def test_knowledge_emb_recomputes_after_embedder_dim_changes():
    """换了维度不同的 embedder 后，_knowledge_emb 应重算（返回新维度），不能返回旧缓存向量。"""
    import services.content_service as cs
    import services.rag.embedder as emb

    emb._embedder = _FakeEmbedder("backend_a", 4, [1.0, 0.0, 0.0, 0.0])
    v1 = cs._knowledge_emb("knowledge.__m11_probe__")
    assert len(v1) == 4

    # 切到维度不同的后端（模拟重载/换后端）
    emb._embedder = _FakeEmbedder("backend_b", 2, [1.0, 0.0])
    v2 = cs._knowledge_emb("knowledge.__m11_probe__")
    assert len(v2) == 2, "换 embedder 维度后必须重嵌，否则旧 4 维向量与新查询 cosine 返 0、知识被静默判不相关"


def test_knowledge_emb_recomputes_after_embedder_name_changes():
    """名不同但维度相同的两个后端也要各自缓存（否则跨后端串用同维但不同语义的向量）。"""
    import services.content_service as cs
    import services.rag.embedder as emb

    emb._embedder = _FakeEmbedder("backend_a", 3, [1.0, 0.0, 0.0])
    v1 = cs._knowledge_emb("knowledge.__m11_probe__")

    emb._embedder = _FakeEmbedder("backend_b", 3, [0.0, 1.0, 0.0])
    v2 = cs._knowledge_emb("knowledge.__m11_probe__")
    assert v2 == [0.0, 1.0, 0.0], "换了同维度的不同后端，应取新后端向量、不取旧缓存"


def test_knowledge_emb_cache_hit_same_embedder():
    """同一 embedder 下重复取应命中缓存（同一对象、不重复 embed）。"""
    import services.content_service as cs
    import services.rag.embedder as emb

    calls = {"n": 0}

    class _Counting(_FakeEmbedder):
        def embed(self, text):
            calls["n"] += 1
            return list(self._vec)

    emb._embedder = _Counting("backend_a", 2, [1.0, 0.0])
    cs._knowledge_emb("knowledge.__m11_probe__")
    cs._knowledge_emb("knowledge.__m11_probe__")
    assert calls["n"] == 1, "同 embedder + 同 key 应命中缓存，只 embed 一次"


# ────────── #2(b) search 有 top-k 上限、降序、尊重 min_score ──────────

def test_search_returns_bounded_topk_ranked():
    """search 只返最相关的 top 条、按分数降序；新增更多条不改变 top。"""
    from services.rag import index_store
    e = DeterministicEmbedder()
    sid = "store-bound"
    # 造 8 条，与查询相关度递减
    docs = {
        "g1": "双十一全场五折活动朋友圈文案",
        "g2": "双十一活动群公告",
        "g3": "双十一优惠",
        "g4": "周末双人台球套餐",
        "g5": "助教晋升体系",
        "g6": "成本控制与耗材",
        "g7": "店长考核赛马",
        "g8": "会员充值规则",
    }
    for k, v in docs.items():
        index_store.upsert(sid, "generation", k, v, e.embed(v))

    hits = index_store.search(sid, e.embed("双十一活动"), top=3)
    assert len(hits) == 3, "必须只返 top=3 条（不返全店）"
    scores = [h["score"] for h in hits]
    assert scores == sorted(scores, reverse=True), "必须按分数降序"
    # top-3 应是"双十一"那组（g1/g2/g3），不相关的 g4..g8 被挤出
    assert set(h["source_id"] for h in hits) <= {"g1", "g2", "g3"}


def test_search_respects_min_score():
    """低于 min_score 的不返回。"""
    from services.rag import index_store
    e = DeterministicEmbedder()
    sid = "store-minscore"
    index_store.upsert(sid, "generation", "g1", "双十一活动", e.embed("双十一活动"))
    index_store.upsert(sid, "generation", "g2", "完全无关的助教薪资", e.embed("完全无关的助教薪资"))
    hits = index_store.search(sid, e.embed("双十一活动"), top=5, min_score=0.99)
    assert all(h["score"] >= 0.99 for h in hits)
    assert any(h["source_id"] == "g1" for h in hits)


# ────────── #2(a) 编辑后再 backfill 重嵌、召回拿到新内容 ──────────

async def _fresh_db_store():
    """在【当前事件循环】里造真 aiosqlite 内存库 + 一个店 + 一个 owner。
    注意：:memory: 库与连接同生命周期，必须整测在一个 asyncio.run 内、勿跨事件循环。"""
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    from sqlalchemy.pool import StaticPool
    import models  # noqa: F401 触发全模型注册
    from db.base import Base
    from models.user import User
    from models.store import Store

    # StaticPool：所有会话共享同一条 :memory: 连接，跨 session 数据可见（否则每连接各自独立内存库）
    eng = create_async_engine("sqlite+aiosqlite:///:memory:", poolclass=StaticPool)
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    async with Session() as db:
        u = User(id=uuid.uuid4(), phone="138", password_hash="x", name="t")
        db.add(u)
        await db.flush()
        s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
        db.add(s)
        await db.commit()
    return Session, s.id, u.id


def test_backfill_reindexes_edited_generation():
    """已索引的生成记录被改了 result，再 backfill 应重嵌；召回拿到新内容、旧内容不再留在索引里。

    注：直接改持久对象 g（expire_on_commit=False 保活），不重新 select —— 因 core/tenant.py 的
    全局租户过滤会把无租户上下文的实体查询过滤成 0 行（backfill 走的是列查询、显式带 store_id，不受影响）。
    """
    from services.rag.recall import backfill_from_generations, recall
    from services.rag import index_store
    from models.generation import Generation

    async def _run():
        Session, store_id, user_id = await _fresh_db_store()
        async with Session() as db:
            g = Generation(
                id=uuid.uuid4(), store_id=store_id, user_id=user_id,
                type="batch", sub_type="朋友圈", title="原标题",
                result="第一版关于乒乓球拍的内容",
            )
            db.add(g)
            await db.commit()
            gid = str(g.id)

            n1 = await backfill_from_generations(db, store_id)
            assert n1 == 1
            rows = index_store._conn().execute(
                "SELECT text FROM vectors WHERE store_id=? AND source_id=?", (str(store_id), gid)
            ).fetchall()
            assert "第一版" in rows[0][0]

            # 编辑这条记录（直接改持久对象，commit 触发 UPDATE + updated_at 刷新）
            g.result = "完全不同的第二版关于羽毛球场地的内容"
            g.title = "改后的标题"
            await db.commit()

            # 再 backfill：应重嵌这条
            n2 = await backfill_from_generations(db, store_id)
            assert n2 == 1, "编辑过的记录应被重新索引"
            rows2 = index_store._conn().execute(
                "SELECT text FROM vectors WHERE store_id=? AND source_id=?", (str(store_id), gid)
            ).fetchall()
            assert "第二版" in rows2[0][0], "索引里应是编辑后的新内容"
            assert "第一版" not in rows2[0][0], "旧内容不应再留在索引里"

            # 召回能命中新内容
            hits = recall(str(store_id), "羽毛球场地", top=3)
            assert any("第二版" in (h["text"] or "") for h in hits)

    asyncio.run(_run())


def test_old_index_db_migrates_to_add_fp_column(tmp_path, monkeypatch):
    """装机版升级：老库（无 fp 列）首次连接应自动补列、读写正常、老行指纹为空（→下次补建会重嵌一次）。"""
    import sqlite3
    from services.rag import index_store

    rag_dir = tmp_path / "rag_old"
    rag_dir.mkdir(parents=True)
    db_file = rag_dir / "index.db"
    # 手造【老 schema】（没有 fp 列）+ 一行旧向量
    raw = sqlite3.connect(str(db_file))
    raw.execute(
        "CREATE TABLE vectors (store_id TEXT, source_type TEXT, source_id TEXT, "
        "text TEXT, dim INTEGER, emb BLOB, ts TEXT, PRIMARY KEY (store_id, source_type, source_id))"
    )
    import struct
    raw.execute(
        "INSERT INTO vectors VALUES (?,?,?,?,?,?,?)",
        ("s", "generation", "g_old", "老向量", 2, struct.pack("2f", 1.0, 0.0), ""),
    )
    raw.commit()
    raw.close()

    monkeypatch.setenv("DESKTOP_RAG_DIR", str(rag_dir))
    index_store.reset_for_test()

    # 连接即触发迁移：fp 列应已补上
    cols = {r[1] for r in index_store._conn().execute("PRAGMA table_info(vectors)").fetchall()}
    assert "fp" in cols, "老库连接后应自动补出 fp 列"

    # 老行 fp 读出来是空串（指纹不匹配 → 下次 backfill 会重嵌一次）
    fps = index_store.existing_fingerprints("s", "generation")
    assert fps == {"g_old": ""}

    # 带 fp 的新 upsert + search 都正常
    index_store.upsert("s", "generation", "g_new", "新向量", [1.0, 0.0], fp="fp123")
    assert index_store.existing_fingerprints("s", "generation")["g_new"] == "fp123"
    hits = index_store.search("s", [1.0, 0.0], top=5)
    assert {h["source_id"] for h in hits} == {"g_old", "g_new"}


def test_backfill_skips_unchanged_generation():
    """没改过的记录第二次 backfill 不应重嵌（增量、不浪费）。"""
    from services.rag.recall import backfill_from_generations
    from models.generation import Generation

    async def _run():
        Session, store_id, user_id = await _fresh_db_store()
        async with Session() as db:
            g = Generation(
                id=uuid.uuid4(), store_id=store_id, user_id=user_id,
                type="batch", sub_type="朋友圈", title="标题", result="一条内容",
            )
            db.add(g)
            await db.commit()
            n1 = await backfill_from_generations(db, store_id)
            assert n1 == 1
            n2 = await backfill_from_generations(db, store_id)
            assert n2 == 0, "没改过的记录不应被重复索引"

    asyncio.run(_run())
