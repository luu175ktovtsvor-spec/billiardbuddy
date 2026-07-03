"""高德地图 Web 服务 API 内置工具（D-Task-2 / D8）。

通用 Agent 能力：查天气 / 找周边地点(含竞对球房/商圈) / 地址与坐标互转 / 路线规划——
用户零配置零感知，问"今天天气""附近哪有台球室""到XX怎么走"就自动能答。**不做 MCP UI**，
就是普普通通的内置工具，跟 web_search/web_fetch 同一层。

⚠️ 真高德 key 绝不进客户端/装机包/代码——走 owner 网关代持（同生图/VLM 那套网关思路，
照抄 `services/video_edit/vlm.py` 的 `_resolve_endpoint` 双模式）：
- **生产**：`QF_GATEWAY_URL`+`QF_GATEWAY_TOKEN` 走网关 `/v1/amap/{path}`，真 key 全在服务器 gw.env。
- **dev-only 后门**（仅本机联调用）：`AMAP_API_KEY` 直连 `restapi.amap.com`（生产/客户盒子别这么配）。
- **两者都没配**：友好中文提示"地图功能暂未配置"，不崩、不抛异常。

⚠️ 天气接口的 `city` 参数是 **adcode**（行政区划编码），不是中文名——"上海"直接查会失败。
`amap_weather` 兼容两种输入：传纯数字当 adcode 直接查；传中文名先打一跳 `geocode/geo`
（返回里带 adcode）拿到编码再查天气，模型传"上海天气"也能 work。

四个工具 = 通用能力，**不进 `BILLIARDS_TOOL_NAMES`**（放 default_registry，general/billiards
两个模式都天然带上）；都是纯只读查询，打固定受信任的官方端点，无 SSRF 风险、不改任何状态——
`read_only=True` + `concurrent_safe=True`，且不设 `requires_approval`（免审批闸）。

故障安全铁律：httpx 超时/非200/高德业务失败（`status != "1"`）都只返回一段友好中文提示，
绝不抛异常拖垮 Agent 主循环。
"""
import logging
import os

import httpx

from services.agent.registry import Tool, default_registry

logger = logging.getLogger(__name__)

_HTTP_TIMEOUT = 10.0

# ── 客户端走网关的双模式（照 vlm.py `_resolve_endpoint`）──────────────────────
# 生产：网关地址/令牌，真高德 key 全在服务器 gw.env，客户端只带可吊销的 app 令牌。
_GATEWAY_URL = os.environ.get("QF_GATEWAY_URL", "").rstrip("/")   # 如 http://<网关IP>/gw/v1
_GATEWAY_TOKEN = os.environ.get("QF_GATEWAY_TOKEN", "")
_GATEWAY_PATH_PREFIX = "/amap"   # gateway/app.py 的 /v1/amap/{path:path} 通用转发路由

# dev-only 后门：仅本机联调用，直连高德官方端点。生产/客户盒子绝不能这么配。
_DEV_KEY_ENV = "AMAP_API_KEY"
_AMAP_BASE = "https://restapi.amap.com"

_NO_CONFIG_MSG = "地图功能暂未配置，等管理员开通后就能用了。"


def _resolve_endpoint() -> tuple[str, dict, dict] | None:
    """算这次请求打哪个 base_url、带哪些额外 query 参数 / headers；两者都没配 → None（调用方降级）。

    返回 (base_url, extra_params, extra_headers)：
    - 网关模式：extra_params 为空（key 由网关服务器端注入），extra_headers 带 Authorization。
    - dev-only 直连：extra_params 带 key（直接查询参数），extra_headers 为空。
    网关优先于 dev-only 后门（两者都配了时，走生产口径的网关，不悄悄绕去直连）。
    """
    if _GATEWAY_URL and _GATEWAY_TOKEN:
        return _GATEWAY_URL + _GATEWAY_PATH_PREFIX, {}, {"Authorization": f"Bearer {_GATEWAY_TOKEN}"}
    dev_key = os.environ.get(_DEV_KEY_ENV)
    if dev_key:
        return _AMAP_BASE, {"key": dev_key}, {}
    return None


# 高德失败提示码 → 更友好的中文兜底文案（常见几种；未命中的原样带上 info 文本）。
_STATUS_HINT = {
    "503": "地图功能暂未配置或额度用完了，稍后再试或联系管理员。",
}


async def _amap_get(path: str, params: dict) -> dict | str:
    """打一个高德只读 GET 端点。成功返回解析后的 dict；任何失败（没配置/超时/网络/非200/
    高德业务失败）都返回一句友好中文提示（str）——调用方用 `isinstance(result, str)` 判断
    走哪条分支，绝不抛异常拖垮 Agent 主循环。"""
    resolved = _resolve_endpoint()
    if not resolved:
        return _NO_CONFIG_MSG
    base_url, extra_params, extra_headers = resolved
    full_params = {**params, **extra_params}
    url = f"{base_url}/{path}"
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(url, params=full_params, headers=extra_headers)
    except httpx.TimeoutException:
        return f"查询地图服务超时了（超过 {int(_HTTP_TIMEOUT)} 秒），稍后再试。"
    except httpx.HTTPError as e:
        return f"查询地图服务失败（网络错误：{type(e).__name__}），稍后再试。"
    except Exception as e:  # noqa: BLE001 — 故障安全：任何失败都别抛出去
        return f"查询地图服务出错了（{type(e).__name__}），稍后再试。"
    if resp.status_code == 503:
        return _NO_CONFIG_MSG
    if resp.status_code != 200:
        return f"地图服务返回了异常状态码 {resp.status_code}，稍后再试。"
    try:
        data = resp.json()
    except Exception:
        return "地图服务返回的内容解析不了，稍后再试。"
    if not isinstance(data, dict):
        return "地图服务返回的内容格式不对，稍后再试。"
    if str(data.get("status")) != "1":
        info = data.get("info") or "未知错误"
        infocode = data.get("infocode") or "?"
        return f"地图查询失败：{info}（高德返回码 {infocode}）。检查下参数是否正确。"
    return data


def _to_km(meters) -> str:
    try:
        return f"{float(meters) / 1000:.1f}"
    except (TypeError, ValueError):
        return "?"


def _to_min(seconds) -> str:
    try:
        return f"{float(seconds) / 60:.0f}"
    except (TypeError, ValueError):
        return "?"


# ────────────────────────────── amap_weather：查天气 ──────────────────────────────

async def amap_weather(args: dict, ctx) -> str:
    """查一个城市/地区的天气（实况或预报）。
    args: city（必填，城市名如"上海"或行政区划编码 adcode）、extensions（可选，base实况/all预报，默认 base）。
    city 传中文名时会先自动查一次地理编码拿到 adcode（天气接口本身只认 adcode，不认中文名），无需调用方操心。"""
    city_raw = (args.get("city") or "").strip()
    if not city_raw:
        return "没给城市/地区，没法查天气。请提供城市名（比如“上海”）或行政区划编码（adcode）。"
    extensions = (args.get("extensions") or "base").strip().lower()
    if extensions not in ("base", "all"):
        extensions = "base"

    adcode = city_raw
    if not city_raw.isdigit():
        # 天气接口的 city 参数必须是 adcode，中文名会查不到——先走一跳地理编码拿 adcode。
        geo = await _amap_get("v3/geocode/geo", {"address": city_raw})
        if isinstance(geo, str):
            return geo
        geocodes = geo.get("geocodes") or []
        if not geocodes:
            return f"没查到「{city_raw}」对应的行政区划，确认下地名对不对（比如写“上海市”“杭州市西湖区”）。"
        adcode = geocodes[0].get("adcode") or ""
        if not adcode:
            return f"「{city_raw}」查到了地址但没拿到区划编码，换个更明确的地名再试试。"

    data = await _amap_get("v3/weather/weatherInfo", {"city": adcode, "extensions": extensions})
    if isinstance(data, str):
        return data

    if extensions == "all":
        forecasts = data.get("forecasts") or []
        casts = forecasts[0].get("casts") if forecasts else []
        if not forecasts or not casts:
            return f"没查到「{city_raw}」的天气预报数据。"
        city_name = forecasts[0].get("city") or city_raw
        lines = [f"{city_name} 未来 {len(casts)} 天天气预报："]
        for c in casts:
            lines.append(
                f"- {c.get('date', '?')}（周{c.get('week', '?')}）：白天{c.get('dayweather', '?')} "
                f"{c.get('daytemp', '?')}℃ / 夜间{c.get('nightweather', '?')} {c.get('nighttemp', '?')}℃"
            )
        return "\n".join(lines)

    lives = data.get("lives") or []
    if not lives:
        return f"没查到「{city_raw}」的实时天气数据。"
    w = lives[0]
    return (
        f"{w.get('province', '')}{w.get('city', city_raw)} 实时天气：{w.get('weather', '?')}，"
        f"气温 {w.get('temperature', '?')}℃，{w.get('winddirection', '?')}风{w.get('windpower', '?')}级，"
        f"湿度 {w.get('humidity', '?')}%（发布时间 {w.get('reporttime', '?')}）"
    )


# ────────────────────────────── amap_search_nearby：周边/关键字地点 ──────────────────────────────

async def amap_search_nearby(args: dict, ctx) -> str:
    """查周边或某个城市里的地点（找竞对球房/商圈/任意 POI）。
    给经纬度 location 就查"周边"（按距离由近到远）；只给城市 city 就在全城按关键字搜。
    args: keywords（必填，如"台球室"）、location（可选，"经度,纬度"）、city（可选，城市名）、
    radius（可选，周边搜索半径米，默认 3000，最大 50000）。"""
    keywords = (args.get("keywords") or "").strip()
    if not keywords:
        return "没给搜索关键词，没法查地点。请提供想找的地点/类型（比如“台球室”“星巴克”）。"
    location = (args.get("location") or "").strip()
    city = (args.get("city") or "").strip()
    try:
        radius = int(args.get("radius") or 3000)
    except (TypeError, ValueError):
        radius = 3000
    radius = max(1, min(radius, 50000))

    if location:
        params = {"keywords": keywords, "location": location, "radius": radius}
        if city:
            params["city"] = city
        data = await _amap_get("v3/place/around", params)
        scope_label = "附近"
    elif city:
        data = await _amap_get("v3/place/text", {"keywords": keywords, "city": city})
        scope_label = city
    else:
        return "没给位置（经纬度）或城市，没法查地点。给个“经度,纬度”坐标或城市名（比如“上海”）。"

    if isinstance(data, str):
        return data
    pois = data.get("pois") or []
    if not pois:
        return f"在{scope_label}没搜到「{keywords}」相关的地点。换个关键词或扩大范围再试试。"
    shown = pois[:10]
    lines = [f"搜到 {len(pois)} 个「{keywords}」相关地点（仅显示前 {len(shown)} 条）："]
    for p in shown:
        seg = f"- {p.get('name', '?')}"
        if p.get("distance"):
            seg += f"（距 {p.get('distance')} 米）"
        addr = p.get("address") or ""
        if addr:
            seg += f"，{addr}"
        tel = p.get("tel") or ""
        if tel:
            seg += f"，电话 {tel}"
        lines.append(seg)
    return "\n".join(lines)


# ────────────────────────────── amap_geocode：地址↔坐标 ──────────────────────────────

async def amap_geocode(args: dict, ctx) -> str:
    """地址与经纬度坐标互转。给地址（如"人民广场"）转坐标+区划编码；给坐标（"经度,纬度"）转地址。
    args: address（可选，地址/地名）、location（可选，"经度,纬度"）——二选一，同时给了优先用 address。"""
    address = (args.get("address") or "").strip()
    location = (args.get("location") or "").strip()
    if not address and not location:
        return "没给地址或经纬度，没法转换。给个地址（如“人民广场”）或“经度,纬度”坐标。"
    if address:
        data = await _amap_get("v3/geocode/geo", {"address": address})
        if isinstance(data, str):
            return data
        geocodes = data.get("geocodes") or []
        if not geocodes:
            return f"没查到「{address}」对应的坐标，换个更完整/准确的地址再试试。"
        g = geocodes[0]
        return (
            f"「{address}」→ {g.get('formatted_address', address)}\n"
            f"坐标（经度,纬度）：{g.get('location', '?')}，行政区划编码 adcode：{g.get('adcode', '?')}"
        )
    data = await _amap_get("v3/geocode/regeo", {"location": location})
    if isinstance(data, str):
        return data
    regeocode = data.get("regeocode") or {}
    formatted = regeocode.get("formatted_address")
    if not formatted:
        return f"没查到坐标「{location}」对应的地址，确认下格式是不是“经度,纬度”。"
    return f"坐标 {location} → {formatted}"


# ────────────────────────────── amap_route：路线规划 ──────────────────────────────

_ROUTE_MODES = {
    "driving": "v3/direction/driving",
    "walking": "v3/direction/walking",
    "transit": "v3/direction/transit/integrated",
}
_ROUTE_MODE_LABEL = {"driving": "驾车", "walking": "步行", "transit": "公交"}


async def amap_route(args: dict, ctx) -> str:
    """规划两点间的路线（驾车/步行/公交），给出全程距离、预计耗时和关键步骤。
    args: origin（必填，"经度,纬度"）、destination（必填，"经度,纬度"）、
    mode（可选，driving默认/walking/transit）、city（transit 模式必填，出发点所在城市）。"""
    origin = (args.get("origin") or "").strip()
    destination = (args.get("destination") or "").strip()
    if not origin or not destination:
        return "没给出发点或目的地，没法规划路线。请给“经度,纬度”格式的出发点(origin)和目的地(destination)。"
    mode = (args.get("mode") or "driving").strip().lower()
    if mode not in _ROUTE_MODES:
        mode = "driving"
    mode_label = _ROUTE_MODE_LABEL[mode]

    params = {"origin": origin, "destination": destination}
    if mode == "transit":
        city = (args.get("city") or "").strip()
        if not city:
            return "公交路线规划需要给出出发点所在城市（city），比如“上海”。"
        params["city"] = city

    data = await _amap_get(_ROUTE_MODES[mode], params)
    if isinstance(data, str):
        return data
    route = data.get("route") or {}

    if mode == "transit":
        transits = route.get("transits") or []
        if not transits:
            return f"没规划出{mode_label}路线，确认下起点/终点/城市对不对。"
        t = transits[0]
        summary = _summarize_transit_segments(t.get("segments") or [])
        return (f"{mode_label}路线：全程约 {_to_km(t.get('distance'))} 公里，"
                f"预计 {_to_min(t.get('duration'))} 分钟。路线：{summary}")

    paths = route.get("paths") or []
    if not paths:
        return f"没规划出{mode_label}路线，确认下起点/终点坐标对不对。"
    p = paths[0]
    steps = p.get("steps") or []
    lines = [f"{mode_label}路线：全程约 {_to_km(p.get('distance'))} 公里，预计 {_to_min(p.get('duration'))} 分钟。"]
    for i, s in enumerate(steps[:8], 1):
        instr = (s.get("instruction") or "").strip()
        if instr:
            lines.append(f"{i}. {instr}")
    if len(steps) > 8:
        lines.append(f"…（共 {len(steps)} 步，仅显示前 8 步）")
    return "\n".join(lines)


def _summarize_transit_segments(segments: list) -> str:
    """把公交路线的分段（步行/公交/地铁/打车）粗汇成一句人话链路，解析不出就给个兜底说明。"""
    parts: list[str] = []
    for s in segments:
        if not isinstance(s, dict):
            continue
        bus = s.get("bus") or {}
        buslines = bus.get("buslines") or []
        if buslines:
            name = (buslines[0] or {}).get("name") or "公交"
            parts.append(f"乘坐{name}")
            continue
        if s.get("railway"):
            parts.append("乘坐地铁/铁路")
            continue
        walking = s.get("walking") or {}
        if walking.get("steps"):
            parts.append("步行一段")
            continue
        if s.get("taxi"):
            parts.append("打车一段")
    return " → ".join(parts) if parts else "详见分段（步行+公交换乘）"


# ────────────────────────────── 工具定义 + 注册 ──────────────────────────────

_AMAP_TOOLS = [
    Tool(
        name="amap_weather",
        description="查一个城市/地区的天气（实时或未来几天预报）。想知道“今天/明天天气怎么样”“要不要提醒老板带伞”这类问题时用。"
                    "给城市名（如“上海”）或行政区划编码都行，内部会自动处理。",
        parameters={"type": "object", "properties": {
            "city": {"type": "string", "description": "城市/地区名（如“上海”“杭州市西湖区”）或行政区划编码 adcode"},
            "extensions": {"type": "string", "enum": ["base", "all"],
                           "description": "base=实时天气(默认)，all=未来几天预报"},
        }, "required": ["city"]},
        handler=amap_weather,
        read_only=True,
        concurrent_safe=True,
    ),
    Tool(
        name="amap_search_nearby",
        description="查周边或某个城市里的地点（找竞对球房、逛商圈、任意 POI）。"
                    "给经纬度就按距离查附近的；只给城市就在全城按关键字搜。"
                    "想看“附近有没有台球室”或“某个商圈里有哪些同行”都用它（keywords 直接填关键词，不用另拆工具）。",
        parameters={"type": "object", "properties": {
            "keywords": {"type": "string", "description": "要找的地点/类型，如“台球室”“星巴克”"},
            "location": {"type": "string", "description": "中心点坐标“经度,纬度”（按距离查附近时用）"},
            "city": {"type": "string", "description": "城市名（没有坐标、只想在某城市搜时用）"},
            "radius": {"type": "integer", "description": "周边搜索半径（米），默认 3000，最大 50000"},
        }, "required": ["keywords"]},
        handler=amap_search_nearby,
        read_only=True,
        concurrent_safe=True,
    ),
    Tool(
        name="amap_geocode",
        description="地址与经纬度坐标互转。给一个地址算出坐标（还能拿到行政区划编码），"
                    "或给一个坐标反查地址。规划路线前常需要先把地名转成坐标时用。",
        parameters={"type": "object", "properties": {
            "address": {"type": "string", "description": "地址/地名（如“人民广场”），要转坐标时给这个"},
            "location": {"type": "string", "description": "坐标“经度,纬度”，要反查地址时给这个"},
        }, "required": []},
        handler=amap_geocode,
        read_only=True,
        concurrent_safe=True,
    ),
    Tool(
        name="amap_route",
        description="规划两点间的路线（驾车/步行/公交），给出全程距离、预计耗时和关键步骤。"
                    "回答“到XX怎么走”“开车/坐地铁要多久”这类问题时用。origin/destination 都要“经度,纬度”坐标"
                    "（地址先用 amap_geocode 转一下）；公交模式(transit)必须再给 city。",
        parameters={"type": "object", "properties": {
            "origin": {"type": "string", "description": "出发点坐标“经度,纬度”"},
            "destination": {"type": "string", "description": "目的地坐标“经度,纬度”"},
            "mode": {"type": "string", "enum": ["driving", "walking", "transit"],
                     "description": "driving驾车(默认)/walking步行/transit公交"},
            "city": {"type": "string", "description": "出发点所在城市（mode=transit 时必填）"},
        }, "required": ["origin", "destination"]},
        handler=amap_route,
        read_only=True,
        concurrent_safe=True,
    ),
]


def register_amap_tools(registry=None) -> int:
    """把高德地图工具注册进注册表。返回登记数（已存在的跳过，可重复调用幂等）。"""
    reg = registry or default_registry
    for t in _AMAP_TOOLS:
        if reg.get(t.name) is None:
            reg.register(t)
    return len(_AMAP_TOOLS)


# 导入即注册进默认表（通用能力——查天气/找地点/查路线，谁都可能问，不门控 billiards_mode）。
register_amap_tools()
logger.info("已注册 %d 个高德地图工具（amap_weather/amap_search_nearby/amap_geocode/amap_route）", len(_AMAP_TOOLS))
