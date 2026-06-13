# -*- coding: utf-8 -*-
"""海报额度纯谓词的边界（无 DB，进主套件）。"""
from models.quota import UsageQuota
from services.quota_service import poster_quota_exceeded


def _q(used: int, limit: int) -> UsageQuota:
    return UsageQuota(monthly_posters_used=used, monthly_poster_limit=limit)


def test_under_limit_not_exceeded():
    assert poster_quota_exceeded(_q(2, 3)) is False


def test_at_limit_is_exceeded():
    # 用满即拦（第 limit+1 张不让出），不是用超才拦
    assert poster_quota_exceeded(_q(3, 3)) is True


def test_over_limit_is_exceeded():
    assert poster_quota_exceeded(_q(5, 3)) is True


def test_zero_limit_blocks_immediately():
    assert poster_quota_exceeded(_q(0, 0)) is True
