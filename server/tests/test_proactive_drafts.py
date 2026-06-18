"""主动出击（P2.3）每日草稿测试。

锁住：
- 只对"能出文字"的推荐生成草稿；海报/生图类、没 user_intent 的跳过
- max_drafts 上限生效
- prompt_key 透传给 generate_workbench
- 单条生成失败不影响其余（跳过该条、继续）
"""
from types import SimpleNamespace

import pytest

from services.agent import proactive


def _rec(rid, title, intent=None, prompt_key=None, action_url="/dashboard/workbench", category="focus"):
    payload = {}
    if intent:
        payload["user_intent"] = intent
    if prompt_key:
        payload["prompt_key"] = prompt_key
    return SimpleNamespace(
        id=rid, title=title, description="", action_label="去做", action_url=action_url,
        action_type="navigate", priority="medium", category=category,
        suggested_payload=payload or None,
    )


def _patch(monkeypatch, recs, gen_calls):
    async def fake_dash(db, store):
        return SimpleNamespace(recommendations=recs)

    async def fake_gen(db, store, user, **kw):
        gen_calls.append(kw)
        return SimpleNamespace(result=f"草稿:{kw.get('user_intent')}")

    monkeypatch.setattr(proactive, "get_today_dashboard", fake_dash)
    monkeypatch.setattr(proactive, "generate_workbench", fake_gen)


@pytest.mark.asyncio
async def test_only_text_recs_become_drafts(monkeypatch):
    recs = [
        _rec("1", "写周末活动朋友圈", intent="写周末活动朋友圈", prompt_key="copywriting.moments"),
        _rec("2", "做一张中秋海报", intent="出图", action_url="/dashboard/posters/new"),  # 海报→跳过
        _rec("3", "完善门店资料", category="setup"),  # 无 user_intent→跳过
        _rec("4", "约 3 个老客", intent="给老客写约客消息", prompt_key="operation.old_customer_recall"),
    ]
    calls = []
    _patch(monkeypatch, recs, calls)
    drafts = await proactive.generate_daily_drafts(db=None, store=None, user=None, max_drafts=5)
    titles = [d["title"] for d in drafts]
    assert titles == ["写周末活动朋友圈", "约 3 个老客"]   # 海报/无意图都被过滤
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_max_drafts_respected(monkeypatch):
    recs = [_rec(str(i), f"文案{i}", intent=f"写文案{i}") for i in range(6)]
    calls = []
    _patch(monkeypatch, recs, calls)
    drafts = await proactive.generate_daily_drafts(db=None, store=None, user=None, max_drafts=3)
    assert len(drafts) == 3
    assert len(calls) == 3  # 到 3 条就停，不多烧


@pytest.mark.asyncio
async def test_prompt_key_passed_through(monkeypatch):
    recs = [_rec("1", "强一比赛", intent="搞个强一比赛主持", prompt_key="operation.qiangyi_battle")]
    calls = []
    _patch(monkeypatch, recs, calls)
    drafts = await proactive.generate_daily_drafts(db=None, store=None, user=None)
    assert drafts[0]["prompt_key"] == "operation.qiangyi_battle"
    assert calls[0]["prompt_key"] == "operation.qiangyi_battle"  # 透传到生成管道


@pytest.mark.asyncio
async def test_one_failure_skipped(monkeypatch):
    recs = [
        _rec("1", "好文案", intent="写好文案"),
        _rec("2", "坏文案", intent="写坏文案"),
    ]
    calls = []

    async def fake_dash(db, store):
        return SimpleNamespace(recommendations=recs)

    async def fake_gen(db, store, user, **kw):
        if kw.get("user_intent") == "写坏文案":
            raise RuntimeError("模板炸了")
        calls.append(kw)
        return SimpleNamespace(result="ok")

    monkeypatch.setattr(proactive, "get_today_dashboard", fake_dash)
    monkeypatch.setattr(proactive, "generate_workbench", fake_gen)

    drafts = await proactive.generate_daily_drafts(db=None, store=None, user=None)
    assert [d["title"] for d in drafts] == ["好文案"]  # 坏的被跳过，好的照出
