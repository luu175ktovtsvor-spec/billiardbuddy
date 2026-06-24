"""专题D 全内置 key：桌面盒子拿到【内置 bundle key】时零配置直用；没内置 key 时维持旧守卫（不静默用平台 key）。

加性反转——只在内置 key 真存在时才用它，故所有"纯 BYOK 空 key → 503/空"的旧测试不受影响。
"""
import pytest

from services.ai.factory import ProviderFactory
from config import settings
from core.exceptions import AIProviderError


def test_text_bundled_key_used_when_present(monkeypatch):
    """DESKTOP_LOCAL + 无门店 BYOK + 内置文字 key 已注入 → 直接用内置(MiMo)，不再 503。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    monkeypatch.setattr(settings, "text_model_provider", "deepseek", raising=False)
    monkeypatch.setattr(settings, "deepseek_api_key", "sk-bundled-mimo-xxx", raising=False)
    prov = ProviderFactory.get_text_provider_for_store(None)
    assert prov is not None


def test_text_no_bundled_key_still_503(monkeypatch):
    """没内置 key、也没 BYOK → 维持友好 503，绝不静默落到无关平台 key。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    monkeypatch.setattr(settings, "deepseek_api_key", "", raising=False)
    with pytest.raises(AIProviderError):
        ProviderFactory.get_text_provider_for_store(None)


def test_image_bundled_key_used_when_present(monkeypatch):
    """DESKTOP_LOCAL + 内置生图 key 已注入 → 返回内置 key/base_url/model（默认走 Seedream/火山方舟）。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    monkeypatch.setattr(settings, "openai_api_key", "sk-img-bundled", raising=False)
    monkeypatch.setattr(settings, "openai_base_url", "https://ark.cn-beijing.volces.com/api/v3", raising=False)
    monkeypatch.setattr(settings, "image_model_name", "doubao-seedream-4-0", raising=False)
    key, base, model = ProviderFactory.get_image_config_for_store(None)
    assert key == "sk-img-bundled"
    assert "volces.com" in base
    assert model == "doubao-seedream-4-0"


def test_image_no_bundled_key_returns_empty(monkeypatch):
    """没内置生图 key → 维持空 key（不动平台 key，逼填 BYOK）。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    monkeypatch.setattr(settings, "openai_api_key", "", raising=False)
    key, base, model = ProviderFactory.get_image_config_for_store(None)
    assert key == ""
