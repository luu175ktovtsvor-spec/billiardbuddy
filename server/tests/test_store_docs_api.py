"""D-Task-5 店铺资料库 REST API 测试：GET/PUT/reindex/DELETE + 跨店隔离 + 后台索引立即返回/完整生命周期。

同 test_scheduled_tasks_api.py / test_media_jobs_runner.py 的约定：
- 不用 TestClient，直接 import 端点模块当普通异步函数调用（传 store=/db= 绕开 Depends），配 in-memory SQLite。
- 后台索引任务(asyncio.create_task)的"跑完之后状态怎么变"，直接 await 内部的
  services.rag.store_docs.run_folder_reindex_job(...)（monkeypatch 它的 async_session 指向内存库），
  不经 asyncio.create_task 的调度时序，测试确定性、不 flaky（同 test_media_jobs_runner.py 对 runner._run 的做法）。
- "PUT/reindex 立即返回 status=indexing" 这条本身，monkeypatch 掉 api.v1.store_docs._spawn_reindex
  （只验证路由本身的响应内容，不让真索引任务在这条测试里跑）。

store_doc_libraries 表不在 core/tenant 自动过滤范围，隔离全靠服务里显式 store_id 过滤，这里钉死它。
"""
import asyncio
import uuid

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import api.v1.store_docs as api_sd
import models  # noqa: F401
import services.rag.store_docs as store_docs_svc
from db.base import Base
from models.store import Store
from models.store_doc_library import StoreDocLibrary
from models.user import User
from services.rag import index_store


@pytest.fixture(autouse=True)
def _isolated_index(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_RAG_DIR", str(tmp_path / "rag"))
    monkeypatch.delenv("RAG_EMBEDDER", raising=False)
    index_store.reset_for_test()
    from services.rag.embedder import DeterministicEmbedder
    import services.rag.embedder as emb
    emb._embedder = DeterministicEmbedder()
    yield
    index_store.reset_for_test()
    emb._embedder = DeterministicEmbedder()


async def _make_db():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    return eng, Session


async def _seed_store(db, sid=None) -> Store:
    u = User(id=uuid.uuid4(), phone=f"1390000{uuid.uuid4().hex[:4]}", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    store = Store(id=sid or uuid.uuid4(), owner_id=u.id, name="店")
    db.add(store)
    await db.flush()
    return store


# ══════════════════════════════ CRUD 基本行为 ══════════════════════════════

def test_get_defaults_when_unset():
    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            item = await api_sd.get_store_docs_route(store=store, db=db)
            assert item.status == "idle"
            assert item.folder_path is None
            assert item.indexed_file_count == 0
        await eng.dispose()

    asyncio.run(main())


def test_put_rejects_empty_and_nonexistent_folder():
    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            with pytest.raises(HTTPException):
                await api_sd.set_store_docs_folder_route(
                    api_sd.SetFolderBody(folder_path=""), store=store, db=db,
                )
            with pytest.raises(HTTPException):
                await api_sd.set_store_docs_folder_route(
                    api_sd.SetFolderBody(folder_path="/definitely/not/exists/xyz-abc"),
                    store=store, db=db,
                )
        await eng.dispose()

    asyncio.run(main())


def test_put_sets_folder_and_returns_indexing_immediately(tmp_path, monkeypatch):
    """PUT 应立即返回 status=indexing（不等后台索引跑完才返回）。"""
    calls = []
    monkeypatch.setattr(api_sd, "_spawn_reindex", lambda sid, fp: calls.append((sid, fp)))

    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            folder = tmp_path / "资料"
            folder.mkdir()
            item = await api_sd.set_store_docs_folder_route(
                api_sd.SetFolderBody(folder_path=str(folder)), store=store, db=db,
            )
            assert item.status == "indexing"
            assert item.folder_path == str(folder)
            assert calls == [(store.id, str(folder))], "PUT 应该立即触发一次后台索引(自动索引目标)"
        await eng.dispose()

    asyncio.run(main())


def test_reindex_requires_folder_first():
    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            with pytest.raises(HTTPException):
                await api_sd.reindex_store_docs_route(store=store, db=db)
        await eng.dispose()

    asyncio.run(main())


def test_reindex_returns_indexing_immediately(tmp_path, monkeypatch):
    calls = []
    monkeypatch.setattr(api_sd, "_spawn_reindex", lambda sid, fp: calls.append((sid, fp)))

    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            folder = tmp_path / "资料"
            folder.mkdir()
            row = StoreDocLibrary(store_id=store.id, folder_path=str(folder), status="ready")
            db.add(row)
            await db.commit()

            item = await api_sd.reindex_store_docs_route(store=store, db=db)
            assert item.status == "indexing"
            assert calls == [(store.id, str(folder))]
        await eng.dispose()

    asyncio.run(main())


# ══════════════════════════════ 后台索引：完整生命周期(直接 await 内部 job，不经 create_task) ══════════════════════════════

def test_full_reindex_lifecycle_updates_status_and_counts(tmp_path, monkeypatch):
    async def main():
        eng, Session = await _make_db()
        monkeypatch.setattr(store_docs_svc, "async_session", Session)
        async with Session() as db:
            store = await _seed_store(db)
            folder = tmp_path / "资料"
            folder.mkdir()
            (folder / "价目表.txt").write_text("单人 30 元一小时", encoding="utf-8")
            row = StoreDocLibrary(store_id=store.id, folder_path=str(folder), status="indexing")
            db.add(row)
            await db.commit()
            store_id = store.id

        await store_docs_svc.run_folder_reindex_job(store_id, str(folder))

        async with Session() as db:
            row2 = (await db.execute(
                select(StoreDocLibrary).where(StoreDocLibrary.store_id == store_id)
            )).scalars().first()
            assert row2.status == "ready"
            assert row2.indexed_file_count == 1
            assert row2.indexed_chunk_count >= 1
            assert row2.last_indexed_at is not None
            assert row2.last_error is None
        await eng.dispose()

    asyncio.run(main())


def test_full_reindex_lifecycle_marks_error_on_missing_folder(tmp_path, monkeypatch):
    async def main():
        eng, Session = await _make_db()
        monkeypatch.setattr(store_docs_svc, "async_session", Session)
        async with Session() as db:
            store = await _seed_store(db)
            missing = str(tmp_path / "不存在的文件夹")
            row = StoreDocLibrary(store_id=store.id, folder_path=missing, status="indexing")
            db.add(row)
            await db.commit()
            store_id = store.id

        await store_docs_svc.run_folder_reindex_job(store_id, missing)

        async with Session() as db:
            row2 = (await db.execute(
                select(StoreDocLibrary).where(StoreDocLibrary.store_id == store_id)
            )).scalars().first()
            assert row2.status == "error"
            assert row2.last_error
        await eng.dispose()

    asyncio.run(main())


def test_full_reindex_lifecycle_soft_errors_keep_status_ready(tmp_path, monkeypatch):
    """单个文件解析失败是"软"错误——批次里其它文件照样索引成功，状态该是 ready 不是 error，
    last_error 只是提示信息。"""
    async def main():
        eng, Session = await _make_db()
        monkeypatch.setattr(store_docs_svc, "async_session", Session)
        async with Session() as db:
            store = await _seed_store(db)
            folder = tmp_path / "资料"
            folder.mkdir()
            (folder / "好的.txt").write_text("正常内容", encoding="utf-8")
            (folder / "坏的.pdf").write_bytes(b"not a real pdf")
            row = StoreDocLibrary(store_id=store.id, folder_path=str(folder), status="indexing")
            db.add(row)
            await db.commit()
            store_id = store.id

        await store_docs_svc.run_folder_reindex_job(store_id, str(folder))

        async with Session() as db:
            row2 = (await db.execute(
                select(StoreDocLibrary).where(StoreDocLibrary.store_id == store_id)
            )).scalars().first()
            assert row2.status == "ready"
            assert row2.indexed_file_count == 1
            assert row2.last_error and "坏的.pdf" in row2.last_error
        await eng.dispose()

    asyncio.run(main())


# ══════════════════════════════ DELETE：清配置 + 清向量 ══════════════════════════════

def test_delete_clears_config_and_vectors(tmp_path):
    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            folder = tmp_path / "资料"
            folder.mkdir()
            (folder / "文档.txt").write_text("店铺资料内容", encoding="utf-8")
            row = StoreDocLibrary(store_id=store.id, folder_path=str(folder), status="ready",
                                   indexed_file_count=1, indexed_chunk_count=1)
            db.add(row)
            await db.commit()

            from services.rag.store_docs import index_store_docs_folder
            index_store_docs_folder(str(store.id), str(folder))
            assert index_store.existing_fingerprints(str(store.id), "store_doc")

            await api_sd.clear_store_docs_route(store=store, db=db)
            store_id = store.id

        async with Session() as db:
            row2 = (await db.execute(
                select(StoreDocLibrary).where(StoreDocLibrary.store_id == store_id)
            )).scalars().first()
            assert row2.folder_path is None
            assert row2.status == "idle"
            assert row2.indexed_file_count == 0
            assert not index_store.existing_fingerprints(str(store_id), "store_doc")
        await eng.dispose()

    asyncio.run(main())


# ══════════════════════════════ 跨店隔离 ══════════════════════════════

def test_cross_store_isolation_in_api():
    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store_a = await _seed_store(db)
            store_b = await _seed_store(db)
            row_a = StoreDocLibrary(store_id=store_a.id, folder_path="/some/a", status="ready",
                                     indexed_file_count=3)
            db.add(row_a)
            await db.commit()

            item_b = await api_sd.get_store_docs_route(store=store_b, db=db)
            assert item_b.status == "idle"
            assert item_b.folder_path is None

            item_a = await api_sd.get_store_docs_route(store=store_a, db=db)
            assert item_a.folder_path == "/some/a"
            assert item_a.indexed_file_count == 3
        await eng.dispose()

    asyncio.run(main())
