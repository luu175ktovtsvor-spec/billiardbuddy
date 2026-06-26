"""★1 运行时路由探针：验证文字请求真打到网关 host，不跑境外。
不花钱、不联网。
"""
import os
import re
from pathlib import Path
from unittest.mock import patch

import pytest

from services.ai.providers.deepseek import _bypass_proxy_for, DeepSeekProvider


GATEWAY_URL = "http://39.106.214.21/gw/v1"


@pytest.mark.asyncio
async def test_text_request_targets_gateway_host():
    """文字请求的 httpx client base_url 应指向 settings 配的网关地址。"""
    provider = DeepSeekProvider(
        api_key="test-app-token",
        base_url=GATEWAY_URL,
    )
    client = provider._get_client()
    base = str(client.base_url)
    assert "39.106.214.21" in base, f"期望指向网关 39.106.214.21，实际 base_url={base}"
    assert "api.deepseek.com" not in base


@patch("services.ai.providers._net.settings")
def test_gateway_url_bypasses_proxy(mock_settings):
    """网关 URL (裸 IP) 应触发直连。"""
    mock_settings.deepseek_base_url = GATEWAY_URL
    mock_settings.openai_base_url = GATEWAY_URL
    assert _bypass_proxy_for(GATEWAY_URL) is True


@patch("services.ai.providers._net.settings")
def test_foreign_endpoint_uses_proxy(mock_settings):
    """境外端点应走代理。"""
    mock_settings.deepseek_base_url = GATEWAY_URL
    mock_settings.openai_base_url = GATEWAY_URL
    assert _bypass_proxy_for("https://api.openai.com/v1") is False


def test_bundled_env_example_has_no_real_key():
    """源码核对：bundled.env.example 不包含真实 API key。"""
    example = Path(__file__).parent.parent.parent / "desktop" / "bundled.env.example"
    if not example.exists():
        pytest.skip("bundled.env.example 不存在")
    content = example.read_text()
    real_key_pattern = re.compile(r"(sk-[a-zA-Z0-9]{20,}|ak-[a-zA-Z0-9]{20,})")
    matches = real_key_pattern.findall(content)
    assert not matches, f"bundled.env.example 包含疑似真实 key: {matches}"
