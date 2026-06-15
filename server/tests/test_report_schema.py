"""报表 schema 加载器纯逻辑单测（不依赖 DB）。"""
import pytest

from core.exceptions import NotFoundException
from services.report_schema import get_report_schema


def test_loads_manager_daily_as_flat():
    schema = get_report_schema("manager_daily")
    assert schema["shape"] == "flat"
    assert schema["role"] == "manager"


def test_field_source_tags_present():
    schema = get_report_schema("manager_daily")
    fields = {f["key"]: f for g in schema["groups"] for f in g["fields"]}
    assert fields["revenue"]["source"] == "pos_glance"   # 收银系统有
    assert fields["add_wechat"]["source"] == "manual"     # 我们的主战场


def test_unknown_report_raises():
    # 未知 report_type 必须抛 NotFoundException(404)，而非 KeyError → 500。
    # 日报 4 个端点共用 get_report_schema，URL 手滑/前端拼错 key 不能炸成 500。
    with pytest.raises(NotFoundException) as exc:
        get_report_schema("does_not_exist")
    assert exc.value.status_code == 404
