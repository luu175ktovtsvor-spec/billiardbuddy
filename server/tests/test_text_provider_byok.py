"""文字 Provider 的纯 BYOK 守卫（与 test_image_provider_byok 的生图守卫成对）。

铁律：桌面盒子 DESKTOP_LOCAL=1 = 纯 BYOK，没配门店自带 key 时**绝不回退平台 key**，
而是友好 503 逼老板去「模型设置」填自己的。云端 web 版相反：无 BYOK 回退平台默认（垫付）。

这条之前只靠"盒子里碰巧没注入平台 key"这一部署约定撑着；现在 factory 里有显式守卫，
本测试把它钉成代码不变量——纵使 env/config 里误带了平台 key，盒子也不会静默用上。
"""
import services.ai.factory as _factory_mod
from core.exceptions import AIProviderError
from services.ai.factory import ProviderFactory


def test_desktop_box_text_provider_pure_byok_never_platform_key(monkeypatch):
    sentinel = object()
    # get_text_provider() = 平台默认 provider；用哨兵替身，断言桌面盒子绝不会拿到它。
    monkeypatch.setattr(ProviderFactory, "get_text_provider", classmethod(lambda cls: sentinel))
    # 本测试钉的是"既没 BYOK、也没内置 key → 503"这条不变量，故显式清空内置 key——
    # 否则本地 .env 里真带了内置 key 时(盒子会正确用内置 key、不抛 503)会误判失败。让测试 hermetic、不靠 .env 缺省为空。
    monkeypatch.setattr(_factory_mod.settings, "deepseek_api_key", "", raising=False)

    # 桌面盒子：store=None（没配 BYOK）→ 必须抛 503，绝不落到平台 provider。
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    try:
        ProviderFactory.get_text_provider_for_store(None)
        assert False, "桌面盒子无 BYOK 应抛 503、不该回退平台 provider"
    except AIProviderError as e:
        assert e.status_code == 503

    # 云端 web：行为不变，无 BYOK 回退平台默认 provider。
    monkeypatch.delenv("DESKTOP_LOCAL", raising=False)
    assert ProviderFactory.get_text_provider_for_store(None) is sentinel
