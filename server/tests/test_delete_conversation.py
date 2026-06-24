"""P1-3b 删除会话：DELETE /agent/conversations/{id} 软删本店该会话、不碰别店（多租户隔离）。"""
import asyncio
import uuid
from types import SimpleNamespace

from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from db.base import Base
from models.generation import Generation


def _gen(store_id, conv_id, msg):
    return Generation(id=uuid.uuid4(), store_id=store_id, type="agent",
                      conversation_id=conv_id, input_params={"message": msg},
                      result="answer", model_used="agent")


def test_delete_conversation_soft_deletes_only_this_store():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id, conv_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()

        async with Session() as db:
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
            rows = (await db2.execute(
                select(Generation).where(Generation.conversation_id == conv_id))).scalars().all()
            for g in rows:
                if g.store_id == store_id:
                    assert g.is_deleted is True       # 本店该会话被软删
                else:
                    assert g.is_deleted is False      # 别店同名会话没被误删（多租户隔离）

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
