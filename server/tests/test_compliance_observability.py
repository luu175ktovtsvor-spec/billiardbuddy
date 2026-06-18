"""铁律违反可观测性测试（地基：让"模型 slip 率"可量化）。"""
import pytest

from services import usage_event_service as ues


@pytest.mark.asyncio
async def test_observe_logs_on_violation(monkeypatch):
    calls = []

    async def fake_log(event, *, store_id=None, user_id=None, props=None):
        calls.append((event, props))

    monkeypatch.setattr(ues, "log_event", fake_log)
    await ues.observe_compliance("本店全城最低价，速来", store_id="s1", sub_type="moments")
    assert len(calls) == 1
    assert calls[0][0] == "compliance_hit"
    assert "全城最低价" in calls[0][1]["terms"]
    assert calls[0][1]["sub_type"] == "moments"


@pytest.mark.asyncio
async def test_observe_silent_on_clean(monkeypatch):
    calls = []

    async def fake_log(event, **kw):
        calls.append(event)

    monkeypatch.setattr(ues, "log_event", fake_log)
    await ues.observe_compliance("正常的周末双人优惠场文案，无违规词", store_id="s1")
    assert calls == []  # 没违反不记，不污染数据


@pytest.mark.asyncio
async def test_observe_failsafe(monkeypatch):
    # log_event 抛异常也绝不冒泡（生成不能被观测拖垮）
    async def boom(*a, **k):
        raise RuntimeError("DB 挂了")

    monkeypatch.setattr(ues, "log_event", boom)
    await ues.observe_compliance("全城最低价", store_id="s1")  # 不应抛
