# -*- coding: utf-8 -*-
"""方向盘 · 跑动中插话纠偏（steering，对标 Claude Code）+ 取消不丢记忆。

锁住三层行为：
1. loop 层：工具批次执行完 / 即将收尾时 drain ctx.steer_inbox → 插话按序【尾部追加】成 user 消息
   （带 [用户补充/纠偏] 标记、不动前面历史），下一轮模型真能看到；流式入口吐 {"type":"steering"} 事件；
   插话给轮次上限小幅续命（max_turns 用尽前提下还能接着收新指令）。
2. 路由层：POST /agent/tasks/{id}/message 的 404（任务不存在）/ 409（已结束、未就绪）/
   400（空话）/ 429（队列封顶 10 条）/ 200（排队成功）。
3. 取消层：任务被 cancel（CancelledError）时用 ctx.live_messages 照样落轨迹——停掉的活不失忆；
   新会话（无 conversation_id）不落孤儿文件。
"""
import asyncio

import pytest
from fastapi import HTTPException

from services.agent.context import AgentContext
from services.agent.loop import _STEER_MARK, run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, arguments="{}", call_id="c1"):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": arguments}}


def _registry_with(handler, name="get_today"):
    reg = ToolRegistry()
    reg.register(Tool(name=name, description="测试工具",
                      parameters={"type": "object", "properties": {}}, handler=handler))
    return reg


class _RecordingProvider(MockTextProvider):
    """按脚本回复，同时记录每次调用时收到的 messages 快照——断言"第二轮模型真看到插话"用。"""

    def __init__(self, scripted):
        super().__init__(scripted)
        self.seen: list[list[dict]] = []

    async def generate(self, request):
        self.seen.append([dict(m) for m in request.messages])
        return await super().generate(request)

    async def generate_stream(self, request, **sinks):
        self.seen.append([dict(m) for m in request.messages])
        async for tok in super().generate_stream(request, **sinks):
            yield tok


async def _collect(agen):
    return [ev async for ev in agen]


# ────────────────────────── 1. loop 层 ──────────────────────────

def test_stream_loop_injects_steering_after_tool_batch():
    """第一轮工具执行期间用户捎话（塞进 ctx.steer_inbox）→ 工具批次做完即注入，
    第二轮模型的 messages 里必须看到带标记的插话（且在尾部、不动前面历史）；流里吐 steering 事件。"""
    ctx = AgentContext()

    async def handler(args, _ctx):
        # 模拟"工具跑着的时候用户在输入框补了两句"
        _ctx.steer_inbox.append("改成横版")
        _ctx.steer_inbox.append("配色用蓝色")
        return "今天是周六"

    reg = _registry_with(handler)
    provider = _RecordingProvider([
        TextResponse(content="", model="mock", tool_calls=[_tc("get_today")], finish_reason="tool_calls"),
        TextResponse(content="好，按横版蓝色来", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="做张海报", registry=reg, ctx=ctx, provider=provider)))

    # 流里吐了 steering 事件（有回应感），顺序在 tool_result 之后、final 之前
    steers = [e for e in events if e["type"] == "steering"]
    assert [e["content"] for e in steers] == ["改成横版", "配色用蓝色"]
    types = [e["type"] for e in events]
    assert types.index("tool_result") < types.index("steering") < types.index("final")

    # 第二轮模型 messages：插话按序追加在【尾部】（保前缀缓存），带标记
    second = provider.seen[1]
    assert second[-2]["role"] == "user" and second[-2]["content"] == f"{_STEER_MARK} 改成横版"
    assert second[-1]["role"] == "user" and second[-1]["content"] == f"{_STEER_MARK} 配色用蓝色"
    # 前面历史原样：tool 结果仍在插话之前
    assert second[-3]["role"] == "tool"
    # 队列取空、不残留串到下一轮
    assert ctx.steer_inbox == []
    assert events[-1]["type"] == "done" and events[-1]["stopped_reason"] == "final"


def test_stream_loop_steering_defers_finalize_and_extends_turns():
    """即将收尾时攒着插话 → 不收尾、继续循环；且 max_turns=1 也能靠插话小幅续命再跑一轮。"""
    ctx = AgentContext()
    ctx.steer_inbox.append("等等，改成晚上八点开场")

    async def handler(args, _ctx):
        return "unused"

    reg = _registry_with(handler)
    provider = _RecordingProvider([
        TextResponse(content="方案好了", model="mock", finish_reason="stop"),
        TextResponse(content="好，改成晚上八点开场的版本", model="mock", finish_reason="stop"),
    ])
    events = asyncio.run(_collect(run_agent_loop_stream(
        user_message="排个活动", registry=reg, ctx=ctx, provider=provider, max_turns=1)))

    finals = [e for e in events if e["type"] == "final"]
    assert len(finals) == 1 and finals[0]["content"] == "好，改成晚上八点开场的版本"
    done = events[-1]
    assert done["type"] == "done" and done["stopped_reason"] == "final"
    assert done["turns"] == 2  # max_turns=1 被插话续命到第 2 轮才收尾（不是 max_turns 强制收尾）

    # 第二轮 messages：本轮 assistant 答复先回灌、插话追加在其后（顺序对，模型知道自己刚说了啥）
    second = provider.seen[1]
    assert second[-2] == {"role": "assistant", "content": "方案好了"}
    assert second[-1]["role"] == "user" and "晚上八点" in second[-1]["content"]
    assert second[-1]["content"].startswith(_STEER_MARK)


def test_sync_loop_drains_steering_too():
    """同步入口 run_agent_loop 同样 drain（结构上不写死只流式可用）：工具轮插话，第二轮 generate 看得到。"""
    ctx = AgentContext()

    async def handler(args, _ctx):
        _ctx.steer_inbox.append("顺便把预算控制在五百内")
        return "查好了"

    reg = _registry_with(handler)
    provider = _RecordingProvider([
        TextResponse(content="", model="mock", tool_calls=[_tc("get_today")], finish_reason="tool_calls"),
        TextResponse(content="收到，预算五百内", model="mock", finish_reason="stop"),
    ])
    result = asyncio.run(run_agent_loop(
        user_message="安排一下", registry=reg, ctx=ctx, provider=provider))

    assert result.final_text == "收到，预算五百内"
    second = provider.seen[1]
    assert second[-1]["role"] == "user" and second[-1]["content"] == f"{_STEER_MARK} 顺便把预算控制在五百内"


def test_loop_exposes_live_messages_on_ctx():
    """取消不丢记忆的地基：loop 一开跑就把活的 messages 引用挂上 ctx（流式/同步都挂）。"""
    ctx = AgentContext()

    async def handler(args, _ctx):
        return "ok"

    reg = _registry_with(handler)
    provider = MockTextProvider(scripted=[TextResponse(content="答", model="mock", finish_reason="stop")])
    asyncio.run(_collect(run_agent_loop_stream(
        user_message="你好", registry=reg, ctx=ctx, provider=provider)))
    assert isinstance(ctx.live_messages, list)
    assert any(m.get("role") == "user" for m in ctx.live_messages)

    ctx2 = AgentContext()
    provider2 = MockTextProvider(scripted=[TextResponse(content="答", model="mock", finish_reason="stop")])
    asyncio.run(run_agent_loop(user_message="你好", registry=reg, ctx=ctx2, provider=provider2))
    assert isinstance(ctx2.live_messages, list)


# ────────────────────────── 2. 路由层 ──────────────────────────

def _make_running_task(agent, task_id="t-steer", with_ctx=True):
    task = agent._AgentTask(id=task_id)
    if with_ctx:
        task.ctx = AgentContext()
    agent._AGENT_TASKS[task_id] = task
    return task


def test_task_message_route_404_unknown_task():
    async def main():
        import api.v1.agent as agent
        agent._AGENT_TASKS.clear()
        with pytest.raises(HTTPException) as ei:
            await agent.send_agent_task_message("no-such", agent.AgentTaskMessageRequest(message="你好"))
        assert ei.value.status_code == 404

    asyncio.run(main())


def test_task_message_route_409_when_finished():
    async def main():
        import api.v1.agent as agent
        agent._AGENT_TASKS.clear()
        task = _make_running_task(agent)
        task.status = "done"
        with pytest.raises(HTTPException) as ei:
            await agent.send_agent_task_message(task.id, agent.AgentTaskMessageRequest(message="补一句"))
        assert ei.value.status_code == 409

    asyncio.run(main())


def test_task_message_route_409_when_ctx_not_ready():
    async def main():
        import api.v1.agent as agent
        agent._AGENT_TASKS.clear()
        task = _make_running_task(agent, with_ctx=False)  # 刚创建、loop 还没挂 ctx
        with pytest.raises(HTTPException) as ei:
            await agent.send_agent_task_message(task.id, agent.AgentTaskMessageRequest(message="补一句"))
        assert ei.value.status_code == 409

    asyncio.run(main())


def test_task_message_route_400_empty_message():
    async def main():
        import api.v1.agent as agent
        agent._AGENT_TASKS.clear()
        task = _make_running_task(agent)
        with pytest.raises(HTTPException) as ei:
            await agent.send_agent_task_message(task.id, agent.AgentTaskMessageRequest(message="   "))
        assert ei.value.status_code == 400

    asyncio.run(main())


def test_task_message_route_200_queues_and_429_when_full():
    async def main():
        import api.v1.agent as agent
        agent._AGENT_TASKS.clear()
        task = _make_running_task(agent)

        res = await agent.send_agent_task_message(task.id, agent.AgentTaskMessageRequest(message="改成横版"))
        assert res["ok"] is True and res["queued"] == 1
        assert task.ctx.steer_inbox == ["改成横版"]

        # 灌到封顶（10 条）后再发 → 429，队列不再增长
        for i in range(agent._STEER_INBOX_CAP - 1):
            await agent.send_agent_task_message(task.id, agent.AgentTaskMessageRequest(message=f"第{i}句"))
        assert len(task.ctx.steer_inbox) == agent._STEER_INBOX_CAP
        with pytest.raises(HTTPException) as ei:
            await agent.send_agent_task_message(task.id, agent.AgentTaskMessageRequest(message="再来一句"))
        assert ei.value.status_code == 429
        assert len(task.ctx.steer_inbox) == agent._STEER_INBOX_CAP

    asyncio.run(main())


def test_task_message_route_registered():
    """端点回归：/agent/tasks/{task_id}/message 必须挂上（且 router 能干净 import）。"""
    from api.v1.router import router as v1_router
    paths = {r.path for r in v1_router.routes}
    assert "/agent/tasks/{task_id}/message" in paths


# ────────────────────────── 3. 取消不丢记忆 ──────────────────────────

def test_cancel_saves_transcript_from_live_messages(monkeypatch):
    """任务被取消 → runner 的 CancelledError 路径用 ctx.live_messages 落轨迹（有 conversation_id 才落）。"""
    async def main():
        import api.v1.agent as agent
        import services.agent.transcript as transcript_mod

        agent._AGENT_TASKS.clear()
        saved = {}
        monkeypatch.setattr(transcript_mod, "save_transcript",
                            lambda cid, msgs: saved.update({"cid": cid, "msgs": msgs}))

        live = [{"role": "system", "content": "s"},
                {"role": "user", "content": "做个方案"},
                {"role": "assistant", "content": "跑到一半"}]

        async def fake_stream(body, user, store, db, task=None):
            if task is not None:
                task.ctx = AgentContext(conversation_id="conv-cancel-1", live_messages=live)
            yield {"type": "token", "content": "开始"}
            await asyncio.sleep(10)

        class _Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc, tb):
                return False
            async def get(self, model, id):
                return None

        from types import SimpleNamespace
        monkeypatch.setattr(agent, "_stream_agent_events", fake_stream)
        monkeypatch.setattr(agent, "async_session", lambda: _Session())
        monkeypatch.setattr(agent, "_learn_in_background", lambda store_id, text, delivery=None: asyncio.sleep(0))

        body = agent.AgentChatRequest(message="测试取消落轨迹")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        await asyncio.sleep(0.05)
        await agent.cancel_agent_task(res["task_id"])
        await asyncio.sleep(0.05)

        assert saved.get("cid") == "conv-cancel-1"
        assert saved.get("msgs") is live  # 用的就是那份活引用
        assert agent._AGENT_TASKS[res["task_id"]].status == "cancelled"

    asyncio.run(main())


def test_cancel_without_conversation_id_skips_transcript(monkeypatch):
    """新会话首轮（没 conversation_id）被取消：不落孤儿轨迹文件。"""
    async def main():
        import api.v1.agent as agent
        import services.agent.transcript as transcript_mod

        agent._AGENT_TASKS.clear()
        called = []
        monkeypatch.setattr(transcript_mod, "save_transcript", lambda cid, msgs: called.append(cid))

        async def fake_stream(body, user, store, db, task=None):
            if task is not None:
                task.ctx = AgentContext(conversation_id=None,
                                        live_messages=[{"role": "user", "content": "x"}])
            yield {"type": "token", "content": "开始"}
            await asyncio.sleep(10)

        class _Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc, tb):
                return False
            async def get(self, model, id):
                return None

        from types import SimpleNamespace
        monkeypatch.setattr(agent, "_stream_agent_events", fake_stream)
        monkeypatch.setattr(agent, "async_session", lambda: _Session())
        monkeypatch.setattr(agent, "_learn_in_background", lambda store_id, text, delivery=None: asyncio.sleep(0))

        body = agent.AgentChatRequest(message="测试新会话取消")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        await asyncio.sleep(0.05)
        await agent.cancel_agent_task(res["task_id"])
        await asyncio.sleep(0.05)

        assert called == []
        assert agent._AGENT_TASKS[res["task_id"]].status == "cancelled"

    asyncio.run(main())
