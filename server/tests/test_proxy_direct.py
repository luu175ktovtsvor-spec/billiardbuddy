"""P0-2 代理直连：国产模型/国产站直连(绕开系统代理 Clash)，境外仍走代理。"""


def test_bypass_proxy_domestic_model_endpoints(monkeypatch):
    from services.ai.providers.deepseek import _bypass_proxy_for
    monkeypatch.delenv("DESKTOP_MODEL_USE_PROXY", raising=False)
    assert _bypass_proxy_for("https://api.xiaomimimo.com/v1") is True   # MiMo 直连
    assert _bypass_proxy_for("https://ark.cn-beijing.volces.com/api/v3") is True  # 火山直连
    assert _bypass_proxy_for("https://api.deepseek.com") is True
    assert _bypass_proxy_for("https://api.openai.com/v1") is False       # 境外 → 走代理


def test_bypass_proxy_escape_hatch(monkeypatch):
    from services.ai.providers.deepseek import _bypass_proxy_for
    monkeypatch.setenv("DESKTOP_MODEL_USE_PROXY", "1")
    assert _bypass_proxy_for("https://api.xiaomimimo.com/v1") is False    # 逃生开关：全部走代理


def test_domestic_web_host():
    from services.agent.web_tools import _domestic_web_host
    assert _domestic_web_host("https://www.tianqi.com/beijing/") is True
    assert _domestic_web_host("http://www.weather.com.cn/x") is True
    assert _domestic_web_host("https://www.baidu.com/") is True
    assert _domestic_web_host("https://example.com/") is False
    assert _domestic_web_host("https://api.openai.com/") is False
