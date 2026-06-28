"""阶段0 P1-4 效果反馈写入:POST /agent/recent-artifacts/{id}/rating 写 effect_rating + rated_at。

好评成品下游(RAG 召回 / brand voice / dashboard 好评墙)早已只读消费 effect_rating=="good",
全仓却没有写入口(effect_rating 只读无写)。本测试钉死这个写入口:本店生效、别店不动(多租户)、
非法入参抛错、不存在的成品抛错。
"""
import asyncio
import uuid
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from core.tenant import set_tenant
from db.base import Base
from models.generation import Generation
from models.store import Store
from models.user import User


def _gen(store_id):
    return Generation(id=uuid.uuid4(), store_id=store_id, type="poster",
                      input_params={"message": "做海报"}, result="/uploads/x.png",
                      model_used="gpt-image-2")


async def _seed_stores(db, store_id, other_store_id):
    u = User(id=uuid.uuid4(), phone="13800000000", password_hash="x", name="tester")
    db.add(u)
    await db.flush()
    db.add(Store(id=store_id, owner_id=u.id, name="本店"))
    db.add(Store(id=other_store_id, owner_id=u.id, name="别店"))
    await db.flush()


def test_rate_artifact_good_writes_rating_only_this_store():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, other_store_id = uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)

        mine, theirs = _gen(store_id), _gen(other_store_id)
        async with Session() as db:
            await _seed_stores(db, store_id, other_store_id)
            db.add(mine); db.add(theirs)
            await db.commit()
            mid, oid = mine.id, theirs.id

            from api.v1.agent import ArtifactRating, rate_recent_artifact
            res = await rate_recent_artifact(str(mid), ArtifactRating(rating="good"),
                                             user=None, store=SimpleNamespace(id=store_id), db=db)
            assert res["ok"] is True and res["rating"] == "good"

        # 新会话读 DB 真值(本店 tenant 下能读到本店成品)
        async with Session() as db2:
            g = await db2.get(Generation, mid)
            assert g.effect_rating == "good" and g.rated_at is not None
        # 切到别店 tenant 才能读别店成品(generations 走 tenant 自动过滤)→ 证明没被改
        set_tenant(other_store_id)
        async with Session() as db3:
            o = await db3.get(Generation, oid)
            assert o is not None and o.effect_rating is None  # 别店成品不受影响(多租户隔离)
        set_tenant(None)

    asyncio.run(main())


def test_rate_artifact_bad_id_raises():
    async def main():
        from api.v1.agent import ArtifactRating, rate_recent_artifact
        from core.exceptions import AIServiceError
        try:
            await rate_recent_artifact("not-a-uuid", ArtifactRating(rating="good"),
                                       user=None, store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "非法 id 应抛错"
        except AIServiceError:
            pass

    asyncio.run(main())


def test_rate_artifact_invalid_rating_raises():
    async def main():
        from api.v1.agent import ArtifactRating, rate_recent_artifact
        from core.exceptions import AIServiceError
        try:
            await rate_recent_artifact(str(uuid.uuid4()), ArtifactRating(rating="meh"),
                                       user=None, store=SimpleNamespace(id=uuid.uuid4()), db=None)
            assert False, "非法 rating 应抛错"
        except AIServiceError:
            pass

    asyncio.run(main())


def test_rate_artifact_missing_generation_raises():
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id = uuid.uuid4()
        set_tenant(store_id)
        async with Session() as db:
            from api.v1.agent import ArtifactRating, rate_recent_artifact
            from core.exceptions import AIServiceError
            try:
                await rate_recent_artifact(str(uuid.uuid4()), ArtifactRating(rating="good"),
                                           user=None, store=SimpleNamespace(id=store_id), db=db)
                assert False, "不存在的成品应抛错"
            except AIServiceError:
                pass
        set_tenant(None)

    asyncio.run(main())
