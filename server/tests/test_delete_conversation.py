"""P1-3b 删除会话：DELETE /agent/conversations/{id} 软删本店该会话、不碰别店（多租户隔离）。"""
import asyncio
import uuid
from pathlib import Path
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from core.tenant import set_tenant
from db.base import Base
from models.generation import Generation
from models.store_memory import StoreMemory
from models.store import Store
from models.user import User


def _gen(store_id, conv_id, msg):
    return Generation(id=uuid.uuid4(), store_id=store_id, type="agent",
                      conversation_id=conv_id, input_params={"message": msg},
                      result="answer", model_used="agent")


async def _seed_stores(db, store_id, other_store_id):
    u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="tester")
    db.add(u)
    await db.flush()
    db.add(Store(id=store_id, owner_id=u.id, name="本店"))
    db.add(Store(id=other_store_id, owner_id=u.id, name="别店"))
    await db.flush()


def test_delete_conversation_soft_deletes_only_this_store():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id, conv_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            db.add(_gen(store_id, conv_id, "hi1"))
            db.add(_gen(store_id, conv_id, "hi2"))
            db.add(_gen(other_store_id, conv_id, "other"))  # 同 conv_id 但别的店
            await db.commit()

            from api.v1.agent import delete_agent_conversation
            res = await delete_agent_conversation(str(conv_id), user=None,
                                                  store=SimpleNamespace(id=store_id), db=db)
            assert res["ok"] is True

        # 新会话读 DB 真值（避免 identity map 缓存）
        async with Session() as db2:
            rows = [g for g in (await db2.execute(select(Generation))).scalars().all()
                    if str(g.conversation_id) == str(conv_id)]
            assert rows and all(g.is_deleted is True for g in rows)
        set_tenant(None)

    asyncio.run(main())


def test_delete_conversation_bad_id_raises():
    async def main():
        from api.v1.agent import delete_agent_conversation
        from core.exceptions import AIServiceError
        try:
            await delete_agent_conversation("not-a-uuid", user=None,
                                            store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "应当对非法 id 抛错"
        except AIServiceError:
            pass

    asyncio.run(main())


def test_restore_and_purge_deleted_conversation():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id, conv_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            db.add(_gen(store_id, conv_id, "hi1"))
            db.add(_gen(store_id, conv_id, "hi2"))
            db.add(_gen(other_store_id, conv_id, "other"))
            await db.commit()

            from api.v1.agent import DeletedItemAction, delete_agent_conversation, restore_deleted_item, purge_deleted_item
            await delete_agent_conversation(str(conv_id), user=None, store=SimpleNamespace(id=store_id), db=db)
            await restore_deleted_item(DeletedItemAction(conversation_id=str(conv_id)), user=None,
                                       store=SimpleNamespace(id=store_id), db=db)

        async with Session() as db2:
            rows = [g for g in (await db2.execute(select(Generation))).scalars().all()
                    if str(g.conversation_id) == str(conv_id)]
            assert [g.is_deleted for g in rows] == [False, False]

            from api.v1.agent import DeletedItemAction, delete_agent_conversation, purge_deleted_item
            await delete_agent_conversation(str(conv_id), user=None, store=SimpleNamespace(id=store_id), db=db2)
            await purge_deleted_item(DeletedItemAction(conversation_id=str(conv_id)), user=None,
                                     store=SimpleNamespace(id=store_id), db=db2)

        async with Session() as db3:
            rows = [g for g in (await db3.execute(select(Generation))).scalars().all()
                    if str(g.conversation_id) == str(conv_id)]
            assert rows == []  # tenant 下本店已彻底删除
        set_tenant(None)

    asyncio.run(main())


def test_deleted_items_restore_and_purge_memory():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id = uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            mem = StoreMemory(store_id=store_id, type="semantic", content="我店 26 张台",
                              confidence="high", source="manual", is_deleted=True)
            db.add(mem)
            await db.commit()
            mid = str(mem.id)

            from api.v1.agent import DeletedItemAction, list_deleted_items, restore_deleted_item, purge_deleted_item
            listed = await list_deleted_items(user=None, store=SimpleNamespace(id=store_id), db=db)
            assert any(i["kind"] == "memory" and i["id"] == mid and "26 张台" in i["title"] for i in listed["items"])

            await restore_deleted_item(DeletedItemAction(id=mid, kind="memory"),
                                       user=None, store=SimpleNamespace(id=store_id), db=db)
            restored = await db.get(StoreMemory, uuid.UUID(mid))
            assert restored.is_deleted is False

            restored.is_deleted = True
            await db.commit()
            await purge_deleted_item(DeletedItemAction(id=mid, kind="memory"),
                                     user=None, store=SimpleNamespace(id=store_id), db=db)

        async with Session() as db2:
            assert await db2.get(StoreMemory, uuid.UUID(mid)) is None
        set_tenant(None)

    asyncio.run(main())


def test_recent_and_deleted_items_include_file_backups(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)

    f = tmp_path / "work" / "plan.txt"
    f.parent.mkdir()
    f.write_text("旧计划", encoding="utf-8")
    backup = lt._backup(f)
    f.write_text("新计划", encoding="utf-8")

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id = uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)
        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            from api.v1.agent import DeletedItemAction, list_deleted_items, list_recent_artifacts, restore_deleted_item
            recent = await list_recent_artifacts(user=None, store=SimpleNamespace(id=store_id), db=db)
            item = next(i for i in recent["items"] if i["kind"] == "file_change")
            assert item["id"] == backup
            assert item["path"] == str(f.resolve())

            f.unlink()
            deleted = await list_deleted_items(user=None, store=SimpleNamespace(id=store_id), db=db)
            item = next(i for i in deleted["items"] if i["kind"] == "file_change")
            assert item["subtitle"] == "已删除文件备份"

            restored = await restore_deleted_item(DeletedItemAction(id=item["id"], conversation_id=item["path"], kind="file_change"),
                                                  user=None, store=SimpleNamespace(id=store_id), db=db)
            assert restored["ok"] is True
            assert f.read_text(encoding="utf-8") == "旧计划"
        set_tenant(None)

    asyncio.run(main())


def test_recent_file_changes_dedup_by_file(tmp_path, monkeypatch):
    """同一文件改了多次，『最近作品』里只算一条(最近的)，别让一个文件的多份备份刷屏、挤掉别的成品。"""
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)

    f = tmp_path / "work" / "plan.txt"
    f.parent.mkdir()
    f.write_text("v1", encoding="utf-8")
    lt._backup(f)
    f.write_text("v2", encoding="utf-8")
    lt._backup(f)  # 同一文件第二次备份（微秒戳防撞名→两个 .bak）
    g = tmp_path / "work" / "note.md"
    g.write_text("x", encoding="utf-8")
    lt._backup(g)
    assert len(list((tmp_path / ".backups").glob("*.bak"))) >= 3  # 底层确有 3 份备份

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id = uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)
        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            from api.v1.agent import list_recent_artifacts
            recent = await list_recent_artifacts(user=None, store=SimpleNamespace(id=store_id), db=db)
            paths = [i["path"] for i in recent["items"] if i["kind"] == "file_change"]
            assert paths.count(str(f.resolve())) == 1   # plan.txt 两份备份 → 只 1 条
            assert str(g.resolve()) in paths            # note.md 没被同名文件刷掉

            # 文件被删 → 从"最近作品"消失(归"最近删除")，指向已删文件的僵尸备份不刷屏
            g.unlink()
            recent2 = await list_recent_artifacts(user=None, store=SimpleNamespace(id=store_id), db=db)
            paths2 = [i["path"] for i in recent2["items"] if i["kind"] == "file_change"]
            assert str(g.resolve()) not in paths2
            assert str(f.resolve()) in paths2           # 还在的文件仍在
        set_tenant(None)

    asyncio.run(main())


def test_save_agent_artifact_enters_recent_items():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id, conv_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            from api.v1.agent import SavedArtifactIn, list_recent_artifacts, save_agent_artifact
            saved = await save_agent_artifact(
                SavedArtifactIn(
                    title="今晚拉客清单",
                    content="前厅 19:00 发客户群；店长 20:00 检查到店数。",
                    conversation_id=str(conv_id),
                    kind="task_list",
                ),
                user=SimpleNamespace(id=uuid.uuid4()),
                store=SimpleNamespace(id=store_id),
                db=db,
            )
            assert saved["kind"] == "content"
            assert saved["title"] == "今晚拉客清单"
            assert saved["conversation_id"] == str(conv_id)

            recent = await list_recent_artifacts(user=None, store=SimpleNamespace(id=store_id), db=db)
            item = next(i for i in recent["items"] if i["id"] == saved["id"])
            assert item["subtitle"] == "文案作品"
            assert "前厅 19:00" in item["content"]
        set_tenant(None)

    asyncio.run(main())


def test_saved_artifact_can_move_to_deleted_restore_and_purge():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id, conv_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            from api.v1.agent import (
                DeletedItemAction,
                SavedArtifactIn,
                delete_recent_artifact,
                list_deleted_items,
                list_recent_artifacts,
                purge_deleted_item,
                restore_deleted_item,
                save_agent_artifact,
            )

            saved = await save_agent_artifact(
                SavedArtifactIn(
                    title="雨天拉客话术",
                    content="今晚下雨，先发客户群，再让助教逐个约熟客。",
                    conversation_id=str(conv_id),
                    kind="assistant_answer",
                ),
                user=SimpleNamespace(id=uuid.uuid4()),
                store=SimpleNamespace(id=store_id),
                db=db,
            )
            await delete_recent_artifact(saved["id"], user=None, store=SimpleNamespace(id=store_id), db=db)

            recent = await list_recent_artifacts(user=None, store=SimpleNamespace(id=store_id), db=db)
            assert saved["id"] not in {i["id"] for i in recent["items"]}
            deleted = await list_deleted_items(user=None, store=SimpleNamespace(id=store_id), db=db)
            item = next(i for i in deleted["items"] if i["id"] == saved["id"])
            assert item["kind"] == "content"
            assert item["title"] == "雨天拉客话术"
            assert "今晚下雨" in item["content"]

            await restore_deleted_item(DeletedItemAction(id=saved["id"]), user=None,
                                       store=SimpleNamespace(id=store_id), db=db)
            recent2 = await list_recent_artifacts(user=None, store=SimpleNamespace(id=store_id), db=db)
            assert saved["id"] in {i["id"] for i in recent2["items"]}

            await delete_recent_artifact(saved["id"], user=None, store=SimpleNamespace(id=store_id), db=db)
            await purge_deleted_item(DeletedItemAction(id=saved["id"]), user=None,
                                     store=SimpleNamespace(id=store_id), db=db)
            deleted2 = await list_deleted_items(user=None, store=SimpleNamespace(id=store_id), db=db)
            assert saved["id"] not in {i["id"] for i in deleted2["items"]}
        set_tenant(None)

    asyncio.run(main())


def test_clear_deleted_items_purges_deleted_records_and_missing_file_backups(tmp_path, monkeypatch):
    import services.agent.local_tools as lt
    monkeypatch.setattr(lt, "_library_root", lambda: tmp_path)

    missing = tmp_path / "work" / "missing.txt"
    existing = tmp_path / "work" / "existing.txt"
    missing.parent.mkdir()
    missing.write_text("会被删掉的文件", encoding="utf-8")
    existing.write_text("仍存在的文件", encoding="utf-8")
    missing_backup = lt._backup(missing)
    existing_backup = lt._backup(existing)
    missing.unlink()

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id, conv_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            deleted_gen = _gen(store_id, conv_id, "deleted")
            deleted_gen.is_deleted = True
            live_gen = _gen(store_id, uuid.uuid4(), "live")
            other_deleted = _gen(other_store_id, conv_id, "other")
            other_deleted.is_deleted = True
            db.add_all([deleted_gen, live_gen, other_deleted])
            deleted_mem = StoreMemory(store_id=store_id, type="semantic", content="已删资料",
                                      confidence="high", source="manual", is_deleted=True)
            live_mem = StoreMemory(store_id=store_id, type="semantic", content="保留资料",
                                   confidence="high", source="manual", is_deleted=False)
            other_mem = StoreMemory(store_id=other_store_id, type="semantic", content="别店已删",
                                    confidence="high", source="manual", is_deleted=True)
            db.add_all([deleted_mem, live_mem, other_mem])
            await db.commit()

            from api.v1.agent import clear_deleted_items
            result = await clear_deleted_items(user=None, store=SimpleNamespace(id=store_id), db=db)
            assert result["ok"] is True
            assert result["removed_file_backups"] == 1

        set_tenant(store_id)
        async with Session() as db2:
            gens = (await db2.execute(select(Generation))).scalars().all()
            assert deleted_gen.id not in {g.id for g in gens}
            assert live_gen.id in {g.id for g in gens}
            mems = (await db2.execute(select(StoreMemory))).scalars().all()
            assert deleted_mem.id not in {m.id for m in mems}
            assert live_mem.id in {m.id for m in mems}
            assert other_mem.id in {m.id for m in mems}
        set_tenant(other_store_id)
        async with Session() as db3:
            other_gens = (await db3.execute(select(Generation))).scalars().all()
            assert other_deleted.id in {g.id for g in other_gens}
        assert not (tmp_path / ".backups" / Path(missing_backup).name).exists()
        assert (tmp_path / ".backups" / Path(existing_backup).name).exists()
        set_tenant(None)

    asyncio.run(main())
