# -*- coding: utf-8 -*-
"""BYOK 端到端验证（临时）：门店自带 key → 加密入库 → 路由 → 接第三方模型生成。
不连 DB（in-memory Store），验证加密往返 + BYOK路由 + 非byok回退 + 坏key安全回退。
"""
import os
import sys
import uuid
import asyncio
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from cryptography.fernet import Fernet
os.environ.setdefault("BYOK_ENCRYPT_KEY", Fernet.generate_key().decode())  # 测试用临时主密钥

from core.crypto import encrypt, decrypt, mask  # noqa: E402
from models.store import Store  # noqa: E402
from services.ai.factory import ProviderFactory  # noqa: E402
from services.ai.base import TextRequest  # noqa: E402


def _store(**kw):
    return Store(id=uuid.uuid4(), owner_id=uuid.uuid4(), name=kw.pop("name", "店"), **kw)


async def main():
    mimo_key = os.environ["MIMO_KEY"]

    # 1) 加密往返
    enc = encrypt(mimo_key)
    assert enc != mimo_key, "key 必须加密存储"
    assert decrypt(enc) == mimo_key, "加解密往返必须一致"
    print(f"[加密] 密文≠明文✓ 往返一致✓ 展示脱敏={mask(mimo_key)}")

    # 2) BYOK 门店 → 接 MiMo 真实生成
    byok = _store(name="测试BYOK店", byok_enabled=True,
                  byok_base_url="https://api.xiaomimimo.com/v1",
                  byok_api_key_enc=enc, byok_model="mimo-v2.5")
    p = ProviderFactory.get_text_provider_for_store(byok)
    print(f"[BYOK路由] provider={type(p).__name__} base={p._base_url} model={p._default_model}")
    r = await p.generate(TextRequest(prompt="用一句话口语说台球房周末怎么聚人气", max_tokens=5000))
    ok_gen = bool(r.content and r.content.strip())
    print(f"[BYOK生成] model返回={r.model} ok={ok_gen} content={r.content[:100]!r}")
    assert ok_gen, "BYOK 生成应有内容"

    # 3) 非 BYOK 门店 → 回退平台默认
    plain = ProviderFactory.get_text_provider_for_store(_store(name="普通店", byok_enabled=False))
    print(f"[非BYOK] base={plain._base_url or 'settings默认'} model={plain._default_model or 'settings默认'}（应回退平台）")
    assert plain._base_url is None, "非BYOK应走平台默认(不带门店base)"

    # 4) 坏密文 → 安全回退不崩
    bad = ProviderFactory.get_text_provider_for_store(_store(name="坏key店", byok_enabled=True, byok_api_key_enc="garbage"))
    print(f"[坏密文] base={bad._base_url or 'settings默认(安全回退)'}")
    assert bad._base_url is None, "坏密文应安全回退平台默认"

    print("\n✅ BYOK 端到端全过：加密往返 + 门店自带MiMo生成 + 非byok回退 + 坏key安全回退")


if __name__ == "__main__":
    asyncio.run(main())
