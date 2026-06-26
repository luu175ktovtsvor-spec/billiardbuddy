# -*- coding: utf-8 -*-
"""M12 #1：PUT /me/byok 部分更新不得静默冲掉「启用」开关。

锁住：只传部分字段（如只改 base_url）时，没传的 byok_enabled / byok_image_enabled
必须保持原值，不被 BYOKConfigIn 的默认 False 冲掉——照隔壁 agent_auto_spend_limit
已有的 model_fields_set 守法（只更新请求里真传了的字段）。
"""
import uuid
from types import SimpleNamespace

import pytest

from api.v1.stores import update_byok_config, BYOKConfigIn


def _store_and_user(**kw):
    uid = uuid.uuid4()
    base = dict(
        id=uuid.uuid4(), owner_id=uid,
        byok_api_key_enc=None, byok_image_api_key_enc=None,
        byok_enabled=True, byok_base_url="https://old", byok_model="m",
        byok_image_enabled=True, byok_image_base_url=None, byok_image_model=None,
        agent_auto_spend_limit=None,
    )
    base.update(kw)
    return SimpleNamespace(**base), SimpleNamespace(id=base["owner_id"])


class _FakeDB:
    async def commit(self):
        return None

    async def refresh(self, obj):
        return None


async def test_partial_update_keeps_enabled_switches():
    pytest.importorskip("cryptography")  # _byok_out 经 core.crypto；无 cryptography 跳过（生产桌面装了）
    store, user = _store_and_user(byok_enabled=True, byok_image_enabled=True)
    # 只传 base_url，不传 enabled / image_enabled
    body = BYOKConfigIn(base_url="https://new")
    out = await update_byok_config(body, store, user, _FakeDB())
    assert store.byok_enabled is True          # 没传 → 不被冲成 False
    assert store.byok_image_enabled is True     # 没传 → 不被冲成 False
    assert store.byok_base_url == "https://new"  # 传了的字段照常更新
    assert out.enabled is True


async def test_explicit_disable_still_works():
    pytest.importorskip("cryptography")
    store, user = _store_and_user(byok_enabled=True, byok_image_enabled=True)
    # 显式传 enabled=False / image_enabled=False → 该关就关
    body = BYOKConfigIn(enabled=False, image_enabled=False)
    out = await update_byok_config(body, store, user, _FakeDB())
    assert store.byok_enabled is False
    assert store.byok_image_enabled is False
    assert out.enabled is False
    assert out.image_enabled is False


async def test_explicit_enable_still_works():
    pytest.importorskip("cryptography")
    store, user = _store_and_user(byok_enabled=False, byok_image_enabled=False)
    body = BYOKConfigIn(enabled=True, image_enabled=True)
    out = await update_byok_config(body, store, user, _FakeDB())
    assert store.byok_enabled is True
    assert store.byok_image_enabled is True
