"""B-5 做海报自动出图上限：BYOK 配置带 agent_auto_spend_limit 的读出 + 写入语义。

锁住：
- _byok_out 把 store.agent_auto_spend_limit 读进 BYOKConfigOut；没设=None(用默认)。
- BYOKConfigIn 只有"显式传了"才进 model_fields_set —— 更新端点据此判断该不该动它，
  避免首启向导那种只传文字配置的 PUT 把老板设的上限清掉。
- 关闭闸用 -1，要能正常传进来。
"""
from types import SimpleNamespace

import pytest

from api.v1.stores import _byok_out, BYOKConfigIn


def _fake_store(**kw):
    base = dict(
        byok_api_key_enc=None, byok_image_api_key_enc=None, byok_enabled=False,
        byok_base_url=None, byok_model=None, byok_image_enabled=False,
        byok_image_base_url=None, byok_image_model=None, agent_auto_spend_limit=None,
    )
    base.update(kw)
    return SimpleNamespace(**base)


def test_byok_out_includes_spend_limit():
    pytest.importorskip("cryptography")  # _byok_out 经 core.crypto；测试环境无 cryptography 则跳过(生产桌面装了)
    assert _byok_out(_fake_store(agent_auto_spend_limit=3)).agent_auto_spend_limit == 3
    assert _byok_out(_fake_store(agent_auto_spend_limit=-1)).agent_auto_spend_limit == -1  # 关闭闸
    assert _byok_out(_fake_store()).agent_auto_spend_limit is None                          # 没设=用默认


def test_spend_limit_only_in_fields_set_when_provided():
    # 没传 → 不在 model_fields_set（更新端点据此不动它，防被 PUT 清掉）
    assert "agent_auto_spend_limit" not in BYOKConfigIn(enabled=True).model_fields_set
    # 传了（含 0 / -1）→ 在 fields_set，能被显式更新
    assert "agent_auto_spend_limit" in BYOKConfigIn(enabled=True, agent_auto_spend_limit=0).model_fields_set
    assert "agent_auto_spend_limit" in BYOKConfigIn(enabled=True, agent_auto_spend_limit=-1).model_fields_set
    assert BYOKConfigIn(enabled=True, agent_auto_spend_limit=8).agent_auto_spend_limit == 8
