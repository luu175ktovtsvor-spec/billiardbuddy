"""report_service 纯逻辑单测（预填/环比/累计/排名），SimpleNamespace 造假 Store。"""
from datetime import datetime
from types import SimpleNamespace

from services.report_service import (
    build_prefill,
    compute_cumulative,
    compute_deltas,
    narrative_payload,
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


def test_narrative_payload_personal_includes_cumulative():
    p = narrative_payload("personal", {"add_wechat": 5}, {}, cumulative={"add_wechat": 379})
    assert p["本月累计"] == {"add_wechat": 379}   # 累计真进了喂 AI 的 JSON
    assert p["add_wechat"] == 5


def test_narrative_payload_roster_includes_ranked_rows():
    rows = [{"name": "B", "hours": 5, "rank": 1}]
    p = narrative_payload("roster", {}, {}, ranked_rows=rows)
    assert p["rows"] == rows                       # 显式传排名,不靠共享引用


def test_narrative_payload_flat_just_deltas():
    p = narrative_payload("flat", {"revenue": 100}, {"revenue": {"pct": 20.0}})
    assert p["环比"]["revenue"]["pct"] == 20.0
    assert "本月累计" not in p and "rows" not in p
