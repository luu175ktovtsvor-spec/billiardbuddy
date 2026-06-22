"""守栏：耦合地图的「机械接线块」必须和真实代码一致。

谁改了前端 api.ts 的端点 / 后端路由，却没重跑 `/coupling-map`（或
`python3 scripts/build_coupling_map.py --write`）刷新地图 → 接线块对不上 → 这里红。
根治"耦合地图悄悄过期变误导"。

机械层脚本在仓库根 `scripts/build_coupling_map.py`，与后端解耦，这里按路径导入。
"""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "build_coupling_map.py"

spec = importlib.util.spec_from_file_location("build_coupling_map", SCRIPT)
bcm = importlib.util.module_from_spec(spec)
sys.modules["build_coupling_map"] = bcm  # dataclass 注解解析需模块在 sys.modules
spec.loader.exec_module(bcm)


def test_normalize_endpoint_collapses_params():
    assert bcm.normalize_endpoint("/api/v1/members/${userId}/role") == "/api/v1/members/{}/role"
    assert bcm.normalize_endpoint("/me/byok/profiles/{name}/activate") == "/me/byok/profiles/{}/activate"
    assert bcm.normalize_endpoint("/api/v1/generations?x=1") == "/api/v1/generations"
    assert bcm.normalize_endpoint("/api/v1/store-memory/") == "/api/v1/store-memory"


def test_extracts_known_live_wiring():
    calls = bcm.extract_frontend_calls()
    routes = bcm.extract_backend_routes()
    wired, _dead, _orphan = bcm.match(calls, routes)
    wired_pairs = {(c.method, c.endpoint) for c, _ in wired}
    # 单窗口产品的真实活接线（任一断 = 接线脚本坏了或产品大改）
    assert ("login", "/api/v1/auth/login") in wired_pairs
    assert ("getMyStore", "/api/v1/stores/me") in wired_pairs
    assert ("listSkills", "/api/v1/agent/skills") in wired_pairs
    assert ("getTodayDashboard", "/api/v1/dashboard/today") in wired_pairs


def test_backend_routes_resolve_to_real_funcs():
    routes = bcm.extract_backend_routes()
    assert routes, "一个后端路由都没抽到，router.py 解析坏了"
    # 健康检查 health 不在子路由里；至少 agent/chat、stores/me 这些要在
    eps = {r.endpoint for r in routes}
    assert "/api/v1/agent/chat" in eps
    assert "/api/v1/canvas/edit" in eps


def test_doc_auto_block_is_fresh():
    """地图里嵌的自动块 == 现在重新抽取的结果。漂移即红。"""
    doc = bcm.DOC
    assert doc.exists(), f"耦合地图不存在：{doc}"
    text = doc.read_text(encoding="utf-8")
    if bcm.AUTO_BEGIN not in text:
        pytest.fail(
            "耦合地图里没有机械接线块。跑 `python3 scripts/build_coupling_map.py --write` 生成。"
        )
    start = text.index(bcm.AUTO_BEGIN)
    end = text.index(bcm.AUTO_END) + len(bcm.AUTO_END)
    doc_block = text[start:end].strip()

    fresh = bcm.render(bcm.extract_frontend_calls(), bcm.extract_backend_routes()).strip()
    assert doc_block == fresh, (
        "耦合地图的机械接线块已过期（前端/后端接口变了没重跑 skill）。\n"
        "跑 `python3 scripts/build_coupling_map.py --write` 刷新后再提交。"
    )
