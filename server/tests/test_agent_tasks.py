import asyncio
import re
from types import SimpleNamespace

from starlette.responses import StreamingResponse


async def _collect_response(resp: StreamingResponse) -> str:
    chunks = []
    async for chunk in resp.body_iterator:
        chunks.append(chunk.decode() if isinstance(chunk, bytes) else chunk)
    return "".join(chunks)


def test_agent_task_replays_cached_events(monkeypatch):
    async def main():
        import api.v1.agent as agent

        agent._AGENT_TASKS.clear()

        async def fake_stream(body, user, store, db):
            yield {"type": "token", "content": "你好"}
            yield {"type": "final", "content": "完成"}
            yield {"type": "done", "turns": 1, "stopped_reason": "stop", "conversation_id": "c1", "generation_id": "g1"}

        class _Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc, tb):
                return False
            async def get(self, model, id):
                return None

        monkeypatch.setattr(agent, "_stream_agent_events", fake_stream)
        monkeypatch.setattr(agent, "async_session", lambda: _Session())
        monkeypatch.setattr(agent, "_learn_in_background", lambda store_id, text: asyncio.sleep(0))

        body = agent.AgentChatRequest(message="测试后台任务")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        task_id = res["task_id"]
        await asyncio.sleep(0.05)

        resp = await agent.subscribe_agent_task_events(task_id, after=-1)
        text = await _collect_response(resp)
        assert '"task_id"' in text
        assert '"offset": 0' in text
        assert '"offset": 2' in text
        assert '"conversation_id": "c1"' in text

        replay = await agent.subscribe_agent_task_events(task_id, after=0)
        replay_text = await _collect_response(replay)
        assert '"offset": 0' not in replay_text
        assert '"offset": 1' in replay_text

    asyncio.run(main())


def test_agent_task_cancel_emits_cancelled_done(monkeypatch):
    async def main():
        import api.v1.agent as agent

        agent._AGENT_TASKS.clear()

        async def fake_stream(body, user, store, db):
            yield {"type": "token", "content": "开始"}
            await asyncio.sleep(10)

        class _Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc, tb):
                return False
            async def get(self, model, id):
                return None

        monkeypatch.setattr(agent, "_stream_agent_events", fake_stream)
        monkeypatch.setattr(agent, "async_session", lambda: _Session())
        monkeypatch.setattr(agent, "_learn_in_background", lambda store_id, text: asyncio.sleep(0))

        body = agent.AgentChatRequest(message="测试取消")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        task_id = res["task_id"]
        await asyncio.sleep(0.05)
        cancel = await agent.cancel_agent_task(task_id)
        assert cancel["status"] == "cancelled"
        await asyncio.sleep(0.05)

        resp = await agent.subscribe_agent_task_events(task_id, after=-1)
        text = await _collect_response(resp)
        assert '"stopped_reason": "cancelled"' in text

    asyncio.run(main())


def test_agent_task_subscription_disconnect_does_not_cancel_runner(monkeypatch):
    async def main():
        import api.v1.agent as agent

        agent._AGENT_TASKS.clear()
        emitted_second = asyncio.Event()

        async def fake_stream(body, user, store, db):
            yield {"type": "token", "content": "第一段"}
            await asyncio.sleep(0.05)
            yield {"type": "token", "content": "第二段"}
            emitted_second.set()
            yield {"type": "final", "content": "完成"}
            yield {"type": "done", "turns": 1, "stopped_reason": "stop"}

        class _Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc, tb):
                return False
            async def get(self, model, id):
                return None

        monkeypatch.setattr(agent, "_stream_agent_events", fake_stream)
        monkeypatch.setattr(agent, "async_session", lambda: _Session())
        monkeypatch.setattr(agent, "_learn_in_background", lambda store_id, text: asyncio.sleep(0))

        body = agent.AgentChatRequest(message="测试断开订阅")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        task_id = res["task_id"]

        resp = await agent.subscribe_agent_task_events(task_id, after=-1)
        agen = resp.body_iterator.__aiter__()
        first = await agen.__anext__()
        assert "第一段" in (first.decode() if isinstance(first, bytes) else first)
        await agen.aclose()

        await asyncio.wait_for(emitted_second.wait(), timeout=1)
        task = agent._AGENT_TASKS[task_id]
        assert task.status == "done"
        assert task.runner is not None
        await asyncio.wait_for(task.runner, timeout=1)
        assert task.runner.done()

        replay = await agent.subscribe_agent_task_events(task_id, after=-1)
        text = await _collect_response(replay)
        assert "第一段" in text
        assert "第二段" in text
        assert '"stopped_reason": "stop"' in text
        assert '"stopped_reason": "cancelled"' not in text

    asyncio.run(main())


def test_task_event_offset_survives_truncation():
    """回归历史 bug：事件数 > 800（长回复每 token 一条）触发队首截断后，
    旧实现用列表绝对下标取事件→订阅者静默卡死/越界。改逻辑 offset 后必须：
    尾巴完整可取、offset 单调不重复、续订与读到尾都不报错。"""
    async def main():
        import api.v1.agent as agent

        cap = agent._TASK_EVENT_CAP  # 800
        task = agent._AgentTask(id="t-trunc")
        total = cap + 200  # 1000，超额 200 触发截断
        for i in range(total):
            await agent._task_append(task, {"type": "token", "content": f"x{i}"})

        # 逻辑高水位不回退；列表只留最近 cap 条；丢弃数 = total - cap
        assert task.total == total
        assert len(task.events) == cap
        assert task.dropped == total - cap  # 200

        # 1) 从头订阅(after=-1 → cursor=0)：前 200 条已丢弃取不到，但当前 800 条尾巴完整、不报错
        batch, cursor = agent._drain_events(task, 0)
        assert len(batch) == cap
        assert cursor == total
        offsets = [int(re.search(r'"offset": (\d+)', b).group(1)) for b in batch]
        assert offsets[0] == total - cap          # 最早可用 = 200（旧 bug 会卡在 800/重复）
        assert offsets[-1] == total - 1           # 999
        assert offsets == sorted(offsets)         # 单调
        assert len(set(offsets)) == len(offsets)  # 无重复

        # 2) 续订：after=900 → cursor=901，只拿 901..999 共 99 条
        batch2, _ = agent._drain_events(task, 901)
        offs2 = [int(re.search(r'"offset": (\d+)', b).group(1)) for b in batch2]
        assert offs2 == list(range(901, total))

        # 3) 已读到尾(after=999 → cursor=1000)：无新事件、不越界
        batch3, cursor3 = agent._drain_events(task, total)
        assert batch3 == []
        assert cursor3 == total

    asyncio.run(main())


def test_agent_task_long_stream_endpoint_delivers_tail(monkeypatch):
    """端到端：后台任务吐 > 800 条事件，订阅端点能完整收尾(含 done)不卡死/不抛错。"""
    async def main():
        import api.v1.agent as agent

        agent._AGENT_TASKS.clear()
        n_tokens = agent._TASK_EVENT_CAP + 150  # 触发截断

        async def fake_stream(body, user, store, db):
            for i in range(n_tokens):
                yield {"type": "token", "content": f"t{i}"}
            yield {"type": "final", "content": "完成"}
            yield {"type": "done", "turns": 1, "stopped_reason": "stop", "conversation_id": "c1"}

        class _Session:
            async def __aenter__(self):
                return self
            async def __aexit__(self, exc_type, exc, tb):
                return False
            async def get(self, model, id):
                return None

        monkeypatch.setattr(agent, "_stream_agent_events", fake_stream)
        monkeypatch.setattr(agent, "async_session", lambda: _Session())
        monkeypatch.setattr(agent, "_learn_in_background", lambda store_id, text: asyncio.sleep(0))

        body = agent.AgentChatRequest(message="超长回复")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        task_id = res["task_id"]
        await asyncio.sleep(0.05)

        resp = await agent.subscribe_agent_task_events(task_id, after=-1)
        text = await _collect_response(resp)
        # 收尾的 final/done 必须送达（旧 bug 截断后这些尾部事件会丢）
        assert "完成" in text
        assert '"stopped_reason": "stop"' in text
        assert '"conversation_id": "c1"' in text

    asyncio.run(main())


def test_agent_task_empty_message_events_include_task_id():
    async def main():
        import api.v1.agent as agent

        agent._AGENT_TASKS.clear()

        body = agent.AgentChatRequest(message="   ")
        res = await agent.start_agent_task(body, user=SimpleNamespace(id="u1"), store=SimpleNamespace(id="s1"))
        task_id = res["task_id"]

        resp = await agent.subscribe_agent_task_events(task_id, after=-1)
        text = await _collect_response(resp)
        assert f'"task_id": "{task_id}"' in text
        assert '"offset": 0' in text
        assert '"offset": 1' in text
        assert '"stopped_reason": "stop"' in text

    asyncio.run(main())
