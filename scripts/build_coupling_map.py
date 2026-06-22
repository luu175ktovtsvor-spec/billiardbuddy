#!/usr/bin/env python3
"""机械层：确定性抽取「前端 api.ts 方法 → HTTP 端点 → 后端路由 → service」接线。

不靠 AI、不联网；同一份代码跑出字节一致的结果，供 coupling-map skill 嵌入地图、
供 test_coupling_map_fresh.py 守栏比对（代码改了没重跑 skill → 接线表对不上 → 测试红）。

用法：
    python3 scripts/build_coupling_map.py            # 打印 markdown 接线块
    python3 scripts/build_coupling_map.py --write    # 把块写回耦合地图的 AUTO-GENERATED 区
"""
from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
API_TS = ROOT / "web" / "src" / "lib" / "api.ts"
ROUTER_PY = ROOT / "server" / "api" / "v1" / "router.py"
ROUTE_DIR = ROOT / "server" / "api" / "v1"
DOC = ROOT / "docs" / "耦合地图与改动检查清单.md"

API_PREFIX = "/api/v1"
AUTO_BEGIN = "<!-- AUTO-GENERATED:coupling-wiring BEGIN -->"
AUTO_END = "<!-- AUTO-GENERATED:coupling-wiring END -->"


@dataclass(frozen=True)
class FrontCall:
    method: str          # api.ts 方法名
    verb: str            # GET/POST/...
    endpoint: str        # 规范化后的端点（${..}/{..} → {}）


@dataclass(frozen=True)
class BackRoute:
    endpoint: str        # 规范化后的全路径
    verb: str
    func: str            # 路由处理函数名
    file: str            # 路由文件名
    services: tuple[str, ...]  # 该文件 import 的 service 模块（粗粒度）


def normalize_endpoint(path: str) -> str:
    """把路径参数统一成 {}，便于前后端匹配。

    `/api/v1/members/${userId}/role` → `/api/v1/members/{}/role`
    `/me/byok/profiles/{name}/activate` → `/me/byok/profiles/{}/activate`
    """
    path = path.split("?", 1)[0]                      # 去查询串
    path = re.sub(r"\$\{[^}]*\}", "{}", path)          # JS 模板参数
    path = re.sub(r"\{[^}]*\}", "{}", path)            # FastAPI 路径参数
    path = re.sub(r"//+", "/", path)
    if len(path) > 1 and path.endswith("/"):
        path = path[:-1]
    return path


# ── 前端：api.ts ───────────────────────────────────────────────
_METHOD_DEF = re.compile(r"^\s*(?:private\s+|public\s+)?(?:async\s+)?(?:get\s+)?([A-Za-z_]\w*)\s*[<(]")
# request("VERB", "<path>" | `<path>`) ；裸 fetch(`${this.baseUrl}<path>`, { method: "VERB" ...})
_REQUEST_CALL = re.compile(
    r"""request<[^>]*>\(\s*["'](?P<verb1>GET|POST|PUT|DELETE|PATCH)["']\s*,\s*[`"'](?P<p1>/[^`"']*)"""
    r"""|request\(\s*["'](?P<verb2>GET|POST|PUT|DELETE|PATCH)["']\s*,\s*[`"'](?P<p2>/[^`"']*)""",
    re.VERBOSE,
)
_FETCH_PATH = re.compile(r"fetch\(\s*`\$\{this\.baseUrl\}(?P<p>/[^`]*)`")
_FETCH_METHOD = re.compile(r'method:\s*["\'](?P<verb>GET|POST|PUT|DELETE|PATCH)["\']')


def extract_frontend_calls(api_ts: Path = API_TS) -> list[FrontCall]:
    text = api_ts.read_text(encoding="utf-8")
    lines = text.splitlines()
    calls: list[FrontCall] = []
    current_method = "?"
    for i, line in enumerate(lines):
        mdef = _METHOD_DEF.match(line)
        if mdef and mdef.group(1) not in ("if", "for", "while", "switch", "catch", "return"):
            current_method = mdef.group(1)
        for m in _REQUEST_CALL.finditer(line):
            verb = m.group("verb1") or m.group("verb2")
            path = m.group("p1") or m.group("p2")
            calls.append(FrontCall(current_method, verb, normalize_endpoint(path)))
        fm = _FETCH_PATH.search(line)
        if fm:
            verb = "GET"
            # method 可能在同行或附近几行
            for j in range(i, min(i + 6, len(lines))):
                vm = _FETCH_METHOD.search(lines[j])
                if vm:
                    verb = vm.group("verb")
                    break
            calls.append(FrontCall(current_method, verb, normalize_endpoint(fm.group("p"))))
    # 去重，稳定排序
    return sorted(set(calls), key=lambda c: (c.endpoint, c.verb, c.method))


# ── 后端：router.py + 各路由文件 ───────────────────────────────
_INCLUDE = re.compile(r'include_router\(\s*(\w+)\s*,\s*prefix\s*=\s*["\'](?P<prefix>/[^"\']*)["\']')
_IMPORT_ROUTER = re.compile(r"from\s+api\.v1\.(\w+)\s+import\s+router\s+as\s+(\w+)")
_ROUTE_DECO = re.compile(r'@router\.(?P<verb>get|post|put|delete|patch)\(\s*["\'](?P<path>[^"\']*)["\']')
_DEF = re.compile(r"^\s*async\s+def\s+(\w+)|^\s*def\s+(\w+)")
_SERVICE_IMPORT = re.compile(r"from\s+services[.\w]*\s+import|import\s+services")


def _router_prefix_map(router_py: Path = ROUTER_PY) -> dict[str, str]:
    text = router_py.read_text(encoding="utf-8")
    alias_to_file = {alias: file for file, alias in _IMPORT_ROUTER.findall(text)}
    out: dict[str, str] = {}
    for m in _INCLUDE.finditer(text):
        alias, prefix = m.group(1), m.group("prefix")
        file = alias_to_file.get(alias)
        if file:
            out[file] = prefix
    return out


def _services_in(route_file: Path) -> tuple[str, ...]:
    found = set()
    for line in route_file.read_text(encoding="utf-8").splitlines():
        m = re.search(r"from\s+services\.?(\w+)?", line)
        if m and m.group(1):
            found.add(m.group(1))
        m2 = re.search(r"from\s+services\.ai\.(\w+)", line)
        if m2:
            found.add(f"ai.{m2.group(1)}")
    return tuple(sorted(found))


def extract_backend_routes(router_py: Path = ROUTER_PY, route_dir: Path = ROUTE_DIR) -> list[BackRoute]:
    prefix_map = _router_prefix_map(router_py)
    routes: list[BackRoute] = []
    for file, prefix in prefix_map.items():
        path_py = route_dir / f"{file}.py"
        if not path_py.exists():
            continue
        services = _services_in(path_py)
        lines = path_py.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            deco = _ROUTE_DECO.search(line)
            if not deco:
                continue
            verb = deco.group("verb").upper()
            subpath = deco.group("path")
            func = "?"
            for j in range(i + 1, min(i + 6, len(lines))):
                dm = _DEF.match(lines[j])
                if dm:
                    func = dm.group(1) or dm.group(2)
                    break
            full = normalize_endpoint(f"{API_PREFIX}{prefix}{subpath}")
            routes.append(BackRoute(full, verb, func, file, services))
    return sorted(set(routes), key=lambda r: (r.endpoint, r.verb))


# ── 比对 ───────────────────────────────────────────────────────
def match(calls: list[FrontCall], routes: list[BackRoute]):
    route_idx = {(r.endpoint, r.verb): r for r in routes}
    wired, dead = [], []
    for c in calls:
        r = route_idx.get((c.endpoint, c.verb))
        (wired if r else dead).append((c, r))
    called = {(c.endpoint, c.verb) for c in calls}
    orphan = [r for r in routes if (r.endpoint, r.verb) not in called]
    return wired, dead, orphan


def render(calls: list[FrontCall], routes: list[BackRoute]) -> str:
    wired, dead, orphan = match(calls, routes)
    out = [AUTO_BEGIN, "", "> 本块由 `scripts/build_coupling_map.py` 自动生成，勿手改；改了接口跑 `/coupling-map` 重生。",
           f"> 前端调用 {len(calls)} 处 · 后端路由 {len(routes)} 个 · 已接通 {len(wired)} · 死方法 {len(dead)} · 无前端调用的路由 {len(orphan)}", ""]
    out.append("### 接线表（前端 api.ts → 后端路由 → service）")
    out.append("")
    out.append("| 前端方法 | HTTP | 端点 | 后端函数 | service |")
    out.append("|---|---|---|---|---|")
    for c, r in wired:
        svc = ", ".join(r.services) or "—"
        out.append(f"| `{c.method}` | {c.verb} | `{c.endpoint}` | `{r.func}`({r.file}) | {svc} |")
    out.append("")
    if dead:
        out.append("### ⚠️ 死方法（前端在调，后端无此路由 → 调用必失败）")
        out.append("")
        for c, _ in dead:
            out.append(f"- `{c.method}` → {c.verb} `{c.endpoint}`")
        out.append("")
    if orphan:
        out.append("### 无前端调用的后端路由（agent/内部/SSE 直连可能正常，仅供核对）")
        out.append("")
        for r in orphan:
            out.append(f"- {r.verb} `{r.endpoint}` ← `{r.func}`({r.file})")
        out.append("")
    out.append(AUTO_END)
    return "\n".join(out)


def write_into_doc(block: str, doc: Path = DOC) -> bool:
    text = doc.read_text(encoding="utf-8")
    if AUTO_BEGIN in text and AUTO_END in text:
        new = re.sub(
            re.escape(AUTO_BEGIN) + r".*?" + re.escape(AUTO_END),
            block,
            text,
            flags=re.DOTALL,
        )
    else:
        new = text.rstrip() + "\n\n## 接线表（机械层自动生成）\n\n" + block + "\n"
    if new != text:
        doc.write_text(new, encoding="utf-8")
        return True
    return False


def main() -> None:
    calls = extract_frontend_calls()
    routes = extract_backend_routes()
    block = render(calls, routes)
    if "--write" in sys.argv:
        changed = write_into_doc(block)
        print(f"{'已更新' if changed else '无变化'}：{DOC}")
    else:
        print(block)


if __name__ == "__main__":
    main()
