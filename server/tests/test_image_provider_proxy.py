"""生图 provider 代理绕过测试：网关/国内 base_url → 直连(trust_env=False)；境外 → 走代理。"""
import os
from unittest.mock import patch, MagicMock

import pytest

GATEWAY_URL = "http://39.106.214.21/gw/v1"
FOREIGN_URL = "https://api.openai.com/v1"
SILICONFLOW_URL = "https://api.siliconflow.cn/v1"
DASHSCOPE_URL = "https://dashscope.aliyuncs.com/api/v1"


# ── OpenAIImageProvider ────────────────────────────────────────────────

class TestOpenAIImageProviderProxy:
    @patch("services.ai.providers._net.settings")
    def test_gateway_base_url_bypasses_proxy(self, mock_settings):
        """网关 base_url → AsyncOpenAI 拿到 trust_env=False 的 http_client。"""
        mock_settings.deepseek_base_url = GATEWAY_URL
        mock_settings.openai_base_url = GATEWAY_URL
        mock_settings.openai_image_timeout = 900.0

        from services.ai.providers.openai_image import OpenAIImageProvider
        provider = OpenAIImageProvider(api_key="test", base_url=GATEWAY_URL)
        client = provider._get_client()
        # 有 http_client 且 trust_env=False
        hc = client._client  # httpx.AsyncClient
        assert hc is not None
        assert hc._trust_env is False

    @patch("services.ai.providers._net.settings")
    def test_foreign_base_url_uses_proxy(self, mock_settings):
        """境外 base_url → 不传 http_client（SDK 默认 trust_env=True）。"""
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = FOREIGN_URL
        mock_settings.openai_image_timeout = 900.0

        from services.ai.providers.openai_image import OpenAIImageProvider
        provider = OpenAIImageProvider(api_key="test", base_url=FOREIGN_URL)
        client = provider._get_client()
        # 没有自定义 http_client → SDK 默认（trust_env=True）
        hc = client._client
        assert hc is None or getattr(hc, "_trust_env", True) is True


# ── bypass_proxy_for 共享模块直接测 ────────────────────────────────────

class TestBypassProxyForImageUrls:
    @patch("services.ai.providers._net.settings")
    def test_siliconflow_domestic_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = FOREIGN_URL
        from services.ai.providers._net import bypass_proxy_for
        assert bypass_proxy_for(SILICONFLOW_URL) is True

    @patch("services.ai.providers._net.settings")
    def test_dashscope_domestic_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = FOREIGN_URL
        from services.ai.providers._net import bypass_proxy_for
        assert bypass_proxy_for(DASHSCOPE_URL) is True

    @patch("services.ai.providers._net.settings")
    def test_gateway_ip_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = GATEWAY_URL
        mock_settings.openai_base_url = GATEWAY_URL
        from services.ai.providers._net import bypass_proxy_for
        assert bypass_proxy_for(GATEWAY_URL) is True

    @patch("services.ai.providers._net.settings")
    def test_foreign_not_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = FOREIGN_URL
        from services.ai.providers._net import bypass_proxy_for
        assert bypass_proxy_for(FOREIGN_URL) is False
