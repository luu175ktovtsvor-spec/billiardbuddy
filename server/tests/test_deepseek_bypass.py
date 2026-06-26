"""Tests for _bypass_proxy_for() gateway-aware proxy bypass logic.

Covers:
- Gateway bare IP base_url → bypass=True when settings point there
- Real foreign endpoint → bypass=False
- Domestic domain (existing keyword match) → bypass=True
- DESKTOP_MODEL_USE_PROXY=1 override → bypass=False always
"""

import os
from unittest.mock import patch

import pytest


# ---------------------------------------------------------------------------
# 为了能直接 import deepseek 模块里的私有函数，先把 server/ 加入 sys.path
# （与项目其它测试文件同样做法：conftest 已处理，但显式兜底更稳）
# ---------------------------------------------------------------------------
import sys
from pathlib import Path

_server_root = Path(__file__).resolve().parent.parent
if str(_server_root) not in sys.path:
    sys.path.insert(0, str(_server_root))

from services.ai.providers.deepseek import (
    _bypass_proxy_for,
    _extract_host,
    _is_gateway_host,
)

# ── 网关裸 IP 场景 ──────────────────────────────────────────────────────────

GATEWAY_IP = "http://39.106.214.21/gw/v1"
GATEWAY_IP_ALT_PATH = "http://39.106.214.21:8799/gw/v1"


class TestGatewayBareIP:
    """当 settings 里的 deepseek_base_url / openai_base_url 指向裸 IP 网关时，
    传入同 host 的 base_url 应走直连（bypass=True）。"""

    @patch("services.ai.providers._net.settings")
    def test_bypass_when_settings_point_to_same_ip(self, mock_settings):
        mock_settings.deepseek_base_url = GATEWAY_IP
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for(GATEWAY_IP) is True

    @patch("services.ai.providers._net.settings")
    def test_bypass_via_openai_base_url_match(self, mock_settings):
        """base_url 匹配 openai_base_url 的 host 也应直连。"""
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = GATEWAY_IP
        assert _bypass_proxy_for(GATEWAY_IP) is True

    @patch("services.ai.providers._net.settings")
    def test_bypass_different_path_same_host(self, mock_settings):
        """同一 IP 不同路径也应命中。"""
        mock_settings.deepseek_base_url = GATEWAY_IP
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        # 同 host (39.106.214.21)，不同路径
        assert _bypass_proxy_for("http://39.106.214.21/other/path") is True


# ── 境外端点场景 ─────────────────────────────────────────────────────────────

class TestForeignEndpoint:
    """真正的境外端点（如 api.openai.com）不应绕过代理。"""

    @patch("services.ai.providers._net.settings")
    def test_openai_com_not_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.openai.com/v1") is False

    @patch("services.ai.providers._net.settings")
    def test_anthropic_not_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.anthropic.com/v1") is False


# ── 国内域名关键词（已有逻辑）───────────────────────────────────────────────

class TestDomesticDomainHints:
    """已有的 _DOMESTIC_API_HINTS 关键词匹配仍然生效。"""

    @patch("services.ai.providers._net.settings")
    def test_xiaomimimo_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.xiaomimimo.com/v1") is True

    @patch("services.ai.providers._net.settings")
    def test_siliconflow_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.siliconflow.cn/v1") is True

    @patch("services.ai.providers._net.settings")
    def test_deepseek_bypassed(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.deepseek.com/v1") is True


# ── DESKTOP_MODEL_USE_PROXY=1 逃生开关 ──────────────────────────────────────

class TestProxyOverride:
    """DESKTOP_MODEL_USE_PROXY=1 时无论什么端点都走代理（bypass=False）。"""

    @patch("services.ai.providers._net.settings")
    @patch.dict(os.environ, {"DESKTOP_MODEL_USE_PROXY": "1"})
    def test_override_defeats_gateway_match(self, mock_settings):
        mock_settings.deepseek_base_url = GATEWAY_IP
        mock_settings.openai_base_url = GATEWAY_IP
        assert _bypass_proxy_for(GATEWAY_IP) is False

    @patch("services.ai.providers._net.settings")
    @patch.dict(os.environ, {"DESKTOP_MODEL_USE_PROXY": "1"})
    def test_override_defeats_domestic_hint(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.xiaomimimo.com/v1") is False

    @patch("services.ai.providers._net.settings")
    @patch.dict(os.environ, {"DESKTOP_MODEL_USE_PROXY": "0"})
    def test_non_one_value_does_not_override(self, mock_settings):
        """DESKTOP_MODEL_USE_PROXY=0 不触发逃生开关。"""
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _bypass_proxy_for("https://api.xiaomimimo.com/v1") is True


# ── _extract_host 单元测试 ──────────────────────────────────────────────────

class TestExtractHost:
    def test_normal_url(self):
        assert _extract_host("https://api.openai.com/v1") == "api.openai.com"

    def test_ip_url(self):
        assert _extract_host("http://39.106.214.21/gw/v1") == "39.106.214.21"

    def test_ip_with_port(self):
        assert _extract_host("http://39.106.214.21:8799/gw/v1") == "39.106.214.21"

    def test_none(self):
        assert _extract_host(None) == ""

    def test_empty(self):
        assert _extract_host("") == ""


# ── _is_gateway_host 单元测试 ───────────────────────────────────────────────

class TestIsGatewayHost:
    @patch("services.ai.providers._net.settings")
    def test_matches_deepseek_base_url(self, mock_settings):
        mock_settings.deepseek_base_url = "http://10.0.0.1:8799/v1"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _is_gateway_host("http://10.0.0.1:9999/other") is True

    @patch("services.ai.providers._net.settings")
    def test_no_match(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _is_gateway_host("http://192.168.1.1/v1") is False

    @patch("services.ai.providers._net.settings")
    def test_none_base_url(self, mock_settings):
        mock_settings.deepseek_base_url = "https://api.deepseek.com"
        mock_settings.openai_base_url = "https://api.openai.com/v1"
        assert _is_gateway_host(None) is False
