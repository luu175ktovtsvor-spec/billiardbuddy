"""report_service 纯逻辑单测（预填/环比/累计/排名），SimpleNamespace 造假 Store。"""
from datetime import datetime
from types import SimpleNamespace

from services.report_service import (
    build_prefill,
    compute_cumulative,
    compute_deltas,
    rank_roster,
)


def _store(name="示例球房"):
    return SimpleNamespace(name=name, operation_profile={"basic": {}})


def test_prefill_fills_name_and_date():
    pre = build_prefill(
        {"prefill": ["store_name", "date", "weekday"]},
        _store(), datetime(2026, 6, 14, 23, 0),
    )
    assert pre["store_name"] == "示例球房"
    assert pre["date"] == "2026-06-14"
    assert pre["weekday"] == "周日"


def test_deltas_percent_vs_last():
    d = compute_deltas({"revenue": 120}, {"revenue": 100}, ["revenue"])
    assert d["revenue"]["pct"] == 20.0 and d["revenue"]["dir"] == "up"


def test_deltas_none_when_no_last():
    assert compute_deltas({"revenue": 120}, None, ["revenue"]) == {}


def test_cumulative_sums_month():
    assert compute_cumulative(
        [{"add_wechat": 5}, {"add_wechat": 3}], ["add_wechat"]
    ) == {"add_wechat": 8}


def test_rank_roster_desc():
    rows = [{"name": "A", "hours": 3.0}, {"name": "B", "hours": 5.0}]
    ranked = rank_roster(rows, "hours")
    assert [r["name"] for r in ranked] == ["B", "A"]
    assert ranked[0]["rank"] == 1
