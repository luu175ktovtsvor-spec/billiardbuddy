# -*- coding: utf-8 -*-
"""会员到期日推进的纯逻辑单测（不依赖 DB）。

重点防回归：月付用户在 29-31 号签约时，续费到期日不应因"月末钳制"永久前移。
"""
from datetime import datetime, timezone

from api.v1.admin import _add_months


def _d(y, m, d):
    return datetime(y, m, d, tzinfo=timezone.utc)


def test_basic_natural_month():
    assert _add_months(_d(2026, 3, 5), 2) == _d(2026, 5, 5)


def test_clamps_to_short_month():
    # 1月31 + 1月 = 2月28（自然月，月末钳制）
    assert _add_months(_d(2026, 1, 31), 1) == _d(2026, 2, 28)


def test_default_anchor_is_start_day_backward_compatible():
    # 不传 anchor_day 时行为不变
    assert _add_months(_d(2026, 4, 15), 1) == _d(2026, 5, 15)


def test_renewal_anchor_does_not_drift():
    """1月31签约的月付，逐月续费应回到每月月末(31/30)，而不是永远停在 28。"""
    anchor = 31  # 签约日（current_period_start.day），续费时不变
    feb = _add_months(_d(2026, 1, 31), 1)            # 首期：2-28
    assert feb == _d(2026, 2, 28)
    mar = _add_months(feb, 1, anchor_day=anchor)     # 应回到 3-31（旧实现会得 3-28）
    assert mar == _d(2026, 3, 31)
    apr = _add_months(mar, 1, anchor_day=anchor)     # 4-30
    assert apr == _d(2026, 4, 30)
    may = _add_months(apr, 1, anchor_day=anchor)     # 5-31（锚点把天数拉回来了）
    assert may == _d(2026, 5, 31)
