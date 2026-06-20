# -*- coding: utf-8 -*-
"""真 DB 回归：run_generation 走【真 aiosqlite 会话】必须正常返回，且返回的 Generation 属性可访问、不崩。

补的洞：之前 commit 后 db.refresh 在 SQLite 上失败 → 对象 expired → 访问 created_at 触发异步惰性加载、
在同步上下文崩，把写文案/诊断/活动/团购等核心工具整条搞废。而所有旧单测都用 _FakeDB 把 refresh 空转、
从没盖到这条真路径，真机才暴露。本测试用真引擎钉死，防回归。
"""
import asyncio
import uuid
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from db.base import Base
from models.user import User
from models.store import Store
import services.content_service as cs
import services.usage_event_service as ues


def test_run_generation_on_real_sqlite_returns_and_attrs_accessible(monkeypatch):
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)

        async def _noop(*a, **k):
            return None

        class _P:
            async def generate(self, req):
                return SimpleNamespace(content="生成正文", model="mock", tokens_used=3)

        monkeypatch.setattr(cs, "check_quota", _noop)
        monkeypatch.setattr(cs, "increment_usage", _noop)
        monkeypatch.setattr(cs, "_validate_provider_for_production", lambda: None)
        monkeypatch.setattr(cs, "load_store_memory", _noop)
        monkeypatch.setattr(cs, "with_store_brain", lambda p, m, intent="": p)
        monkeypatch.setattr(cs, "_safe_log_generation", _noop)
        monkeypatch.setattr(ues, "observe_compliance", _noop)
        monkeypatch.setattr(cs.ProviderFactory, "get_text_provider_for_store", staticmethod(lambda s: _P()))

        async with Session() as db:
            u = User(id=uuid.uuid4(), phone="138", password_hash="x", name="t")
            db.add(u)
            await db.flush()
            s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
            db.add(s)
            await db.commit()

            gen = await cs.run_generation(db=db, store=s, user=u, prompt="写点啥", gen_type="batch", sub_type="x")
            assert gen.result == "生成正文"
            assert gen.id is not None
            # ↓↓↓ 旧 bug 正是在这里崩（对象 expired → created_at 惰性加载）。现在 Python default 已落值，能直接读。
            assert gen.created_at is not None
            assert gen.updated_at is not None
            # 连续第二次也不崩（session 未被毒）
            gen2 = await cs.run_generation(db=db, store=s, user=u, prompt="再来一条", gen_type="batch", sub_type="x")
            assert gen2.result == "生成正文" and gen2.created_at is not None

    asyncio.run(main())
