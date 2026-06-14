"""报表编排服务。

纯逻辑（预填 / 环比 / 累计 / 排名）+ DB 编排（generate_report，见文件下方）。
纯逻辑部分不碰 DB，便于单测（对齐 test_dashboard_recommendations 风格）。
"""
from datetime import datetime

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def build_prefill(schema: dict, store, now: datetime) -> dict:
    """按 schema.prefill 自动带出固定信息（门店名 / 日期 / 星期）。"""
    out: dict = {}
    for key in schema.get("prefill", []):
        if key == "store_name":
            out["store_name"] = getattr(store, "name", "") or ""
        elif key == "date":
            out["date"] = now.strftime("%Y-%m-%d")
        elif key == "weekday":
            out["weekday"] = _WEEKDAYS[now.weekday()]
    return out


def compute_deltas(current: dict, last: dict | None, fields: list[str]) -> dict:
    """对 fields 算环比（相对上次提交）。无上次或不可比则跳过。"""
    if not last:
        return {}
    out: dict = {}
    for f in fields:
        cur, prev = current.get(f), last.get(f)
        if isinstance(cur, (int, float)) and isinstance(prev, (int, float)) and prev:
            pct = round((cur - prev) / prev * 100, 1)
            out[f] = {"pct": pct, "dir": "up" if pct >= 0 else "down", "prev": prev}
    return out


def compute_cumulative(submissions: list[dict], fields: list[str]) -> dict:
    """把多份提交在 fields 上求和（教练个人日报的"本月累计"）。"""
    out = {f: 0 for f in fields}
    for s in submissions:
        for f in fields:
            v = s.get(f)
            if isinstance(v, (int, float)):
                out[f] += v
    return out


def rank_roster(rows: list[dict], by: str) -> list[dict]:
    """按 by 字段降序排名，原地写入 rank（助教管理花名册排名页）。"""
    ranked = sorted(rows, key=lambda r: r.get(by) or 0, reverse=True)
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    return ranked
