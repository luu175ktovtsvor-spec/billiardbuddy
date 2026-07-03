"""高德地图内置工具（D-Task-2 / D8）。

锁住：
- 4 个工具（amap_weather/amap_search_nearby/amap_geocode/amap_route）都注册进 default_registry，
  元信息都是 read_only=True、requires_approval=False、concurrent_safe=True；且都不在
  BILLIARDS_TOOL_NAMES 里（通用能力，通用模式也能用——general_registry() 里也拿得到）。
- 客户端走网关双模式（照 vlm.py 的 `_resolve_endpoint` 写法）：网关/dev-only 后门都没配 → 友好中文
  提示、不抛异常；配了其中之一 → 走 httpx 请求（这里全部 monkeypatch，不真联网）。
- 天气 city 传中文名（非纯数字）时，内部先调 geocode/geo 拿 adcode 再查天气（两跳链路）。
- httpx 超时 / 非 200 / 高德 status!="1" 业务失败，都要故障安全，返回人话提示不崩。

全程 monkeypatch `amap_tools.httpx.AsyncClient` 和 `amap_tools._resolve_endpoint`，绝不真联网。
"""
import asyncio
from types import SimpleNamespace

import httpx

import services.agent.amap_tools as amap_tools
from services.agent.registry import BILLIARDS_TOOL_NAMES, default_registry, general_registry

_TOOL_NAMES = ["amap_weather", "amap_search_nearby", "amap_geocode", "amap_route"]


def _ctx():
    return SimpleNamespace(db=object(), store=SimpleNamespace(id="s1"), user=SimpleNamespace(id="u1"),
                           allowed_paths=[], permission_mode="ask", full_disk_access=False,
                           auto_spend_limit=None, provider=None, model=None, todos=[])


# ────────────────────────────── 注册 + 元信息 ──────────────────────────────

def test_amap_tools_registered():
    names = set(default_registry.names())
    for n in _TOOL_NAMES:
        assert n in names, f"工具 {n} 未注册"


def test_amap_tools_export_openai_schema():
    schemas = {t["function"]["name"] for t in default_registry.to_openai_tools()}
    for n in _TOOL_NAMES:
        assert n in schemas


def test_amap_tools_metadata():
    for n in _TOOL_NAMES:
        t = default_registry.get(n)
        assert t.read_only is True, f"{n} 应为 read_only"
        assert t.requires_approval is False, f"{n} 不该走审批闸"
        assert t.concurrent_safe is True, f"{n} 应标 concurrent_safe（纯 httpx 网络请求不碰 ctx.db）"


def test_amap_tools_not_in_billiards_names():
    # 高德是通用能力：不能出现在台球专属白名单里，否则通用模式（general_registry）会拿不到
    assert not (set(_TOOL_NAMES) & BILLIARDS_TOOL_NAMES), "amap 工具不该进 BILLIARDS_TOOL_NAMES"


def test_amap_tools_present_in_general_registry():
    gen_names = set(general_registry().names())
    for n in _TOOL_NAMES:
        assert n in gen_names, f"{n} 应在通用模式 general_registry() 里可用"


def test_register_amap_tools_idempotent():
    before = len(default_registry.names())
    amap_tools.register_amap_tools()
    assert len(default_registry.names()) == before


# ────────────────────────────── 没配网关/后门 → 优雅降级 ──────────────────────────────

def _clear_endpoint(monkeypatch):
    monkeypatch.setattr(amap_tools, "_GATEWAY_URL", "")
    monkeypatch.setattr(amap_tools, "_GATEWAY_TOKEN", "")
    monkeypatch.delenv(amap_tools._DEV_KEY_ENV, raising=False)


def test_amap_weather_no_config_friendly(monkeypatch):
    _clear_endpoint(monkeypatch)
    out = asyncio.run(amap_tools.amap_weather({"city": "310000"}, _ctx()))
    assert "未配置" in out or "暂未配置" in out


def test_amap_search_nearby_no_config_friendly(monkeypatch):
    _clear_endpoint(monkeypatch)
    out = asyncio.run(amap_tools.amap_search_nearby({"keywords": "台球", "city": "上海"}, _ctx()))
    assert "未配置" in out or "暂未配置" in out


def test_amap_geocode_no_config_friendly(monkeypatch):
    _clear_endpoint(monkeypatch)
    out = asyncio.run(amap_tools.amap_geocode({"address": "人民广场"}, _ctx()))
    assert "未配置" in out or "暂未配置" in out


def test_amap_route_no_config_friendly(monkeypatch):
    _clear_endpoint(monkeypatch)
    out = asyncio.run(amap_tools.amap_route({"origin": "121.4,31.2", "destination": "121.5,31.3"}, _ctx()))
    assert "未配置" in out or "暂未配置" in out


# ────────────────────────────── 假 httpx 客户端 ──────────────────────────────

class _FakeResp:
    def __init__(self, status=200, json_data=None, text=""):
        self.status_code = status
        self._json = json_data if json_data is not None else {}
        self.text = text or str(self._json)
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._json


class _FakeClient:
    """单一预置响应/异常。"""
    def __init__(self, resp=None, exc=None):
        self._resp, self._exc = resp, exc

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **kw):
        if self._exc:
            raise self._exc
        return self._resp


class _RoutedClient:
    """按 url 里含的关键字返回不同预置响应——模拟"先 geo 后 weather"这类两跳链路。"""
    def __init__(self, routes: dict):
        self._routes = routes

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False

    async def get(self, url, **kw):
        for key, resp in self._routes.items():
            if key in url:
                return resp
        raise AssertionError(f"未预置的请求 URL：{url}")


def _configure_dev_backdoor(monkeypatch):
    """模拟"配了 dev-only 直连后门"（AMAP_API_KEY），走 restapi.amap.com。"""
    monkeypatch.setattr(amap_tools, "_GATEWAY_URL", "")
    monkeypatch.setattr(amap_tools, "_GATEWAY_TOKEN", "")
    monkeypatch.setenv(amap_tools._DEV_KEY_ENV, "test-amap-key")


# ────────────────────────────── amap_weather ──────────────────────────────

def test_amap_weather_success_by_adcode(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1", "count": "1", "info": "OK", "infocode": "10000",
        "lives": [{"province": "上海", "city": "上海市", "adcode": "310000",
                   "weather": "晴", "temperature": "28", "winddirection": "东",
                   "windpower": "3", "humidity": "60", "reporttime": "2026-07-04 12:00:00"}],
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_weather({"city": "310000"}, _ctx()))
    assert "晴" in out and "28" in out and "上海" in out


def test_amap_weather_chinese_name_resolves_adcode_first(monkeypatch):
    """city 传中文名 → 先打 geocode/geo 拿 adcode，再打 weatherInfo（两跳）。"""
    _configure_dev_backdoor(monkeypatch)
    geo_resp = _FakeResp(json_data={
        "status": "1", "geocodes": [{"formatted_address": "上海市", "adcode": "310000",
                                      "location": "121.4737,31.2304"}],
    })
    weather_resp = _FakeResp(json_data={
        "status": "1",
        "lives": [{"province": "上海", "city": "上海市", "adcode": "310000",
                   "weather": "多云", "temperature": "26", "winddirection": "南",
                   "windpower": "2", "humidity": "55", "reporttime": "2026-07-04 12:00:00"}],
    })
    monkeypatch.setattr(
        amap_tools.httpx, "AsyncClient",
        lambda *a, **k: _RoutedClient({"geocode/geo": geo_resp, "weather/weatherInfo": weather_resp}),
    )
    out = asyncio.run(amap_tools.amap_weather({"city": "上海"}, _ctx()))
    assert "多云" in out and "26" in out


def test_amap_weather_forecast_extensions_all(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1",
        "forecasts": [{"city": "上海市", "adcode": "310000", "casts": [
            {"date": "2026-07-05", "week": "7", "dayweather": "晴", "nightweather": "多云",
             "daytemp": "30", "nighttemp": "24"},
        ]}],
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_weather({"city": "310000", "extensions": "all"}, _ctx()))
    assert "2026-07-05" in out and "30" in out and "24" in out


def test_amap_weather_empty_city():
    out = asyncio.run(amap_tools.amap_weather({"city": "  "}, _ctx()))
    assert "城市" in out or "地区" in out


def test_amap_weather_geo_not_found_friendly(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    geo_resp = _FakeResp(json_data={"status": "1", "geocodes": []})
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=geo_resp))
    out = asyncio.run(amap_tools.amap_weather({"city": "不存在的地方XYZ"}, _ctx()))
    assert "没查到" in out or "没找到" in out


# ────────────────────────────── amap_search_nearby ──────────────────────────────

def test_amap_search_nearby_with_location(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1", "count": "1",
        "pois": [{"id": "1", "name": "老王台球室", "type": "体育休闲服务",
                  "address": "长宁路100号", "location": "121.4,31.2", "distance": "350",
                  "tel": "021-12345678"}],
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_search_nearby(
        {"keywords": "台球", "location": "121.4,31.2"}, _ctx()))
    assert "老王台球室" in out and "350" in out and "长宁路100号" in out


def test_amap_search_nearby_by_city_text(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1", "count": "1",
        "pois": [{"id": "2", "name": "星牌台球俱乐部", "address": "南京路1号",
                  "location": "121.48,31.23"}],
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_search_nearby({"keywords": "台球", "city": "上海"}, _ctx()))
    assert "星牌台球俱乐部" in out


def test_amap_search_nearby_empty_keywords():
    out = asyncio.run(amap_tools.amap_search_nearby({"keywords": ""}, _ctx()))
    assert "关键词" in out


def test_amap_search_nearby_no_location_or_city():
    out = asyncio.run(amap_tools.amap_search_nearby({"keywords": "台球"}, _ctx()))
    assert "位置" in out or "城市" in out


def test_amap_search_nearby_empty_results_friendly(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={"status": "1", "count": "0", "pois": []})
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_search_nearby({"keywords": "冷门玩意", "city": "上海"}, _ctx()))
    assert "没搜到" in out


# ────────────────────────────── amap_geocode ──────────────────────────────

def test_amap_geocode_address_to_location(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1",
        "geocodes": [{"formatted_address": "上海市黄浦区人民广场", "adcode": "310101",
                      "location": "121.475,31.233"}],
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_geocode({"address": "人民广场"}, _ctx()))
    assert "121.475,31.233" in out and "310101" in out


def test_amap_geocode_location_to_address(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1",
        "regeocode": {"formatted_address": "上海市黄浦区南京东路街道人民广场"},
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_geocode({"location": "121.475,31.233"}, _ctx()))
    assert "人民广场" in out


def test_amap_geocode_empty_args():
    out = asyncio.run(amap_tools.amap_geocode({}, _ctx()))
    assert "地址" in out or "经纬度" in out or "坐标" in out


# ────────────────────────────── amap_route ──────────────────────────────

def test_amap_route_driving_success(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1",
        "route": {"paths": [{"distance": "12500", "duration": "1800",
                              "steps": [{"instruction": "沿人民大道行驶500米"}]}]},
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_route(
        {"origin": "121.4,31.2", "destination": "121.5,31.3"}, _ctx()))
    assert "驾车" in out and "12.5" in out and "人民大道" in out


def test_amap_route_walking_success(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={
        "status": "1",
        "route": {"paths": [{"distance": "800", "duration": "600", "steps": []}]},
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_route(
        {"origin": "121.4,31.2", "destination": "121.41,31.21", "mode": "walking"}, _ctx()))
    assert "步行" in out


def test_amap_route_transit_requires_city():
    # 公交模式没给 city → 应在打网络请求前就友好拒绝（不该真的发请求）
    out = asyncio.run(amap_tools.amap_route(
        {"origin": "121.4,31.2", "destination": "121.5,31.3", "mode": "transit"}, _ctx()))
    assert "城市" in out


def test_amap_route_missing_points():
    out = asyncio.run(amap_tools.amap_route({"origin": "121.4,31.2"}, _ctx()))
    assert "出发" in out or "目的地" in out


# ────────────────────────────── 故障安全：超时 / 非200 / 高德业务失败 ──────────────────────────────

def test_amap_timeout_friendly(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient",
                         lambda *a, **k: _FakeClient(exc=httpx.TimeoutException("slow")))
    out = asyncio.run(amap_tools.amap_weather({"city": "310000"}, _ctx()))
    assert "超时" in out


def test_amap_network_error_friendly(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient",
                         lambda *a, **k: _FakeClient(exc=httpx.ConnectError("boom")))
    out = asyncio.run(amap_tools.amap_geocode({"address": "人民广场"}, _ctx()))
    assert "失败" in out or "出错" in out


def test_amap_non_200_friendly(monkeypatch):
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(status=500, json_data={})
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_search_nearby({"keywords": "台球", "city": "上海"}, _ctx()))
    assert "500" in out or "异常" in out


def test_amap_status_fail_friendly(monkeypatch):
    # 高德标准失败标志：status != "1"（比如 key 无效/参数错），不抛异常，友好带上 info
    _configure_dev_backdoor(monkeypatch)
    resp = _FakeResp(json_data={"status": "0", "info": "INVALID_USER_KEY", "infocode": "10001"})
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _FakeClient(resp=resp))
    out = asyncio.run(amap_tools.amap_weather({"city": "310000"}, _ctx()))
    assert "INVALID_USER_KEY" in out or "失败" in out


def test_amap_gateway_configured_takes_priority_over_dev_backdoor(monkeypatch):
    """网关和 dev-only 后门都配了时，优先走网关（生产口径），不能因为顺手也读了 dev key 就绕过网关。"""
    monkeypatch.setattr(amap_tools, "_GATEWAY_URL", "http://gw.example/gw/v1")
    monkeypatch.setattr(amap_tools, "_GATEWAY_TOKEN", "app-token-xyz")
    monkeypatch.setenv(amap_tools._DEV_KEY_ENV, "should-not-be-used")

    captured = {}

    class _CaptureClient(_FakeClient):
        async def get(self, url, **kw):
            captured["url"] = url
            captured["headers"] = kw.get("headers")
            captured["params"] = kw.get("params")
            return self._resp

    resp = _FakeResp(json_data={
        "status": "1", "lives": [{"weather": "晴", "temperature": "20", "province": "上海",
                                   "city": "上海市", "winddirection": "北", "windpower": "1",
                                   "humidity": "40", "reporttime": "x"}],
    })
    monkeypatch.setattr(amap_tools.httpx, "AsyncClient", lambda *a, **k: _CaptureClient(resp=resp))
    asyncio.run(amap_tools.amap_weather({"city": "310000"}, _ctx()))
    assert "gw.example" in captured["url"]
    assert captured["headers"].get("Authorization") == "Bearer app-token-xyz"
    # 网关模式不该把 dev key 当 query 参数塞进去
    assert (captured["params"] or {}).get("key") != "should-not-be-used"
