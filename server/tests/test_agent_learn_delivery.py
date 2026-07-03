# -*- coding: utf-8 -*-
"""F-3b：把"本轮 AI 交付了什么"喂进对话后台学习——治"AI 记不住上次给你做了什么"体感 bug。

覆盖：
1. `_learn_in_background` 本身：交付容器(dict，流式路径专用)/交付字符串(str，任务路径专用)/
   交付为空 三种输入下，合成给 remember() 的 interaction_text 对不对（含标记、截断、故障安全回退）。
2. 两个真实接线点端到端（真 DB + 真 loop + 真端点 + MockProvider，不打桩 _stream_agent_events）：
   - /chat 流式路径（agent_chat）：BackgroundTask 绑定时 persist_text 还没算出来，
     靠 delivery_box 容器在流内回填、响应发完后台任务读到。
   - /tasks 后台任务路径（start_agent_task）：_runner() 收尾时 persist_text 已算好，
     直接读 task.delivery_text。
3. _EXTRACT_SYS 新增的路由措辞：带【本轮助手交付】的内容只许记 episodic「做过什么」，
   不许把交付物文字内容本身当 semantic/preference/operational 门店事实抽取。

只 monkeypatch【外部/花钱/门店画像/remember】这类副作用依赖；_stream_agent_events 本身、
BackgroundTask 接线走真代码——这正是本单要证明的东西。
"""
import asyncio
import json
import uuid

import pytest
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from db.base import Base
from models.user import User
from models.store import Store

import api.v1.agent as agent_mod
import services.memory_service as ms
from api.v1.agent import AgentChatRequest
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider
from services.agent.registry import ToolRegistry


# ── 1. _learn_in_background 本身：合成文本对不对 ──────────────────────


def _capture_remember(monkeypatch):
    """monkeypatch agent_mod.remember 为 spy，捕获实际喂给店脑抽取器的 interaction_text；
    async_session 换成不落地的假 session（remember 已被替身、bg_db 不会被真的用到）。"""
    captured = {}

    async def fake_remember(db, store_id, interaction_text):
        captured["store_id"] = store_id
        captured["interaction_text"] = interaction_text
        return []

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

    monkeypatch.setattr(agent_mod, "remember", fake_remember)
    monkeypatch.setattr(agent_mod, "async_session", lambda: _Session())
    return captured


def test_learn_in_background_merges_dict_delivery_box(monkeypatch):
    """流式路径：delivery 传可变容器 {"text": ...}（BackgroundTask 绑定时还没算出来，
    靠流内回填），_learn_in_background 执行时（响应发完后）读到的是回填后的值。"""
    async def main():
        captured = _capture_remember(monkeypatch)
        await agent_mod._learn_in_background(
            "store1", "帮我写个国庆活动文案", {"text": "已经写好啦：国庆巨惠"})
        text = captured["interaction_text"]
        assert text.startswith("【用户说】帮我写个国庆活动文案")
        assert "【本轮助手交付】已经写好啦：国庆巨惠" in text

    asyncio.run(main())


def test_learn_in_background_merges_string_delivery(monkeypatch):
    """任务路径：delivery 直接传已经算好的 persist_text 字符串（不是容器）。"""
    async def main():
        captured = _capture_remember(monkeypatch)
        await agent_mod._learn_in_background("store1", "查一下上月营收", "上月营收8万")
        text = captured["interaction_text"]
        assert "【用户说】查一下上月营收" in text
        assert "【本轮助手交付】上月营收8万" in text

    asyncio.run(main())


@pytest.mark.parametrize("delivery", [None, "", "   ", {"text": ""}, {"text": "   "}])
def test_learn_in_background_empty_delivery_falls_back_to_plain_text(monkeypatch, delivery):
    """故障安全：容器为空/交付为空 → 回退到只喂用户消息（老行为），不出现标记、不报错、不阻断。"""
    async def main():
        captured = _capture_remember(monkeypatch)
        await agent_mod._learn_in_background("store1", "帮我写个文案", delivery)
        assert captured["interaction_text"] == "帮我写个文案"

    asyncio.run(main())


def test_learn_in_background_truncates_long_delivery(monkeypatch):
    """截断：别把整篇长文案/长表格塞进抽取器——交付摘要要截到 _DELIVERY_LEARN_MAX_CHARS 内。"""
    assert 1200 <= agent_mod._DELIVERY_LEARN_MAX_CHARS <= 2000

    async def main():
        captured = _capture_remember(monkeypatch)
        long_delivery = "A" * 5000
        await agent_mod._learn_in_background("store1", "写个长文案", long_delivery)
        text = captured["interaction_text"]
        ai_part = text.split("【本轮助手交付】", 1)[1]
        assert len(ai_part) <= agent_mod._DELIVERY_LEARN_MAX_CHARS

    asyncio.run(main())


def test_learn_in_background_still_skips_when_user_text_empty(monkeypatch):
    """行为不变：用户消息本身是空的，不管交付有没有，都不学（老逻辑，防回归）。"""
    async def main():
        captured = _capture_remember(monkeypatch)
        await agent_mod._learn_in_background("store1", "   ", {"text": "交付了点啥"})
        assert captured == {}

    asyncio.run(main())


# ── 2. 端到端：两个真实接线点 ──────────────────────────────────────


def _test_registry():
    return ToolRegistry()


async def _consume(resp):
    events = []
    async for chunk in resp.body_iterator:
        if isinstance(chunk, bytes):
            chunk = chunk.decode("utf-8")
        for line in chunk.splitlines():
            line = line.strip()
            if line.startswith("data: "):
                try:
                    events.append(json.loads(line[6:]))
                except ValueError:
                    pass
    return events


async def _seed(Session):
    async with Session() as db:
        u = User(id=uuid.uuid4(), phone="138", password_hash="x", name="t")
        db.add(u)
        await db.flush()
        s = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
        db.add(s)
        await db.commit()
    return u, s


def _engine():
    return create_async_engine("sqlite+aiosqlite:///:memory:")


def test_sse_chat_background_learns_with_delivery_summary(monkeypatch, tmp_path):
    """/chat 流式路径端到端：done 事件把 persist_text 回填进 delivery_box，
    响应发完后 Starlette 才会跑的 BackgroundTask 读到它，喂进 remember()。"""
    import services.agent.transcript as T

    p = MockTextProvider(scripted=[
        TextResponse(content="已经帮你写好啦：国庆巨惠不停歇，进店台费立减20！",
                     model="mock", finish_reason="stop"),
    ])

    async def _noop_quota(*a, **k):
        return None

    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))
    monkeypatch.setattr(agent_mod, "check_quota", _noop_quota)
    monkeypatch.setattr(agent_mod, "render_operation_profile_context", lambda store: "")
    monkeypatch.setattr(agent_mod, "_build_agent_registry", lambda billiards: _test_registry())
    monkeypatch.setattr(agent_mod, "build_resilient_text_provider", lambda store: p)

    async def main():
        captured = _capture_remember(monkeypatch)
        eng = _engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        u, s = await _seed(Session)

        async with Session() as db:
            resp = await agent_mod.agent_chat(
                body=AgentChatRequest(message="帮我写个国庆活动文案"), user=u, store=s, db=db)
            events = await _consume(resp)
            assert any(e.get("type") == "final" for e in events)

            # 此刻 BackgroundTask 还没跑（Starlette 会等响应体发完才调用），手动模拟这个时机。
            assert captured == {}, "背景学习任务应等响应发完才跑，不该提前学"
            await resp.background()

        assert captured.get("store_id") == str(s.id)
        text = captured["interaction_text"]
        assert "【用户说】帮我写个国庆活动文案" in text
        assert "【本轮助手交付】" in text
        assert "国庆巨惠不停歇" in text

    asyncio.run(main())


def test_task_runner_background_learns_with_delivery_summary(monkeypatch, tmp_path):
    """/tasks 后台任务路径端到端：_runner() 收尾时 persist_text 已经算好，
    直接从 task.delivery_text 读、喂进 _learn_in_background（不靠可变容器）。"""
    import services.agent.transcript as T

    p = MockTextProvider(scripted=[
        TextResponse(content="上月营收8万，环比涨了一成", model="mock", finish_reason="stop"),
    ])

    async def _noop_quota(*a, **k):
        return None

    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))
    monkeypatch.setattr(agent_mod, "check_quota", _noop_quota)
    monkeypatch.setattr(agent_mod, "render_operation_profile_context", lambda store: "")
    monkeypatch.setattr(agent_mod, "_build_agent_registry", lambda billiards: _test_registry())
    monkeypatch.setattr(agent_mod, "build_resilient_text_provider", lambda store: p)

    async def main():
        agent_mod._AGENT_TASKS.clear()
        captured = _capture_remember(monkeypatch)
        eng = _engine()
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        u, s = await _seed(Session)
        # _capture_remember 先把 async_session 换成"不落地"的假 session；_runner() 内部
        # 还要用它真查 User/Store（bg_db.get），这里改指回真引擎的 sessionmaker
        # （remember 本身仍是上面装的 spy，不会真落库）。
        monkeypatch.setattr(agent_mod, "async_session", Session)

        res = await agent_mod.start_agent_task(
            AgentChatRequest(message="上个月营收咋样"), user=u, store=s)
        task_id = res["task_id"]
        task = agent_mod._AGENT_TASKS[task_id]
        await asyncio.wait_for(task.runner, timeout=5)

        assert captured.get("store_id") == str(s.id)
        text = captured["interaction_text"]
        assert "【用户说】上个月营收咋样" in text
        assert "【本轮助手交付】上月营收8万" in text

    asyncio.run(main())


# ── 3. _EXTRACT_SYS：识别交付标记，只记情景不当事实 ───────────────────


def test_extract_sys_routes_delivery_marker_to_episodic_only():
    """F-3b 乙：抽取器 system prompt 要能区分"用户说的"和"AI 交付的"——
    交付内容最多记一条 episodic「做过什么」，不许把交付物文字本身抽成门店事实。"""
    assert "【本轮助手交付】" in ms._EXTRACT_SYS
    tail = ms._EXTRACT_SYS.split("【本轮助手交付】", 1)[1][:400]
    assert "episodic" in tail  # 允许记的落点
    assert "semantic" in tail and "preference" in tail and "operational" in tail  # 明确禁止落点
