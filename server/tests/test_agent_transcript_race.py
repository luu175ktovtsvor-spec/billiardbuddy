# -*- coding: utf-8 -*-
"""F-10 复审 Critical 修复：跨单元竞态——异步媒体任务完成回灌 × 主循环整轮覆盖写 transcript。

背景（复审逮到的真实 bug）：
- `media_job_notify.py` 的 `append_transcript`（读现状→追加→整份重写）在"聊天进行中途"（视频/剪辑
  任务跑完那一刻，跟对话轮次完全脱钩）往磁盘轨迹追加一条"做好了"。
- 主循环（`_stream_agent_events`）轮收尾用【轮开始时加载的历史 + 本轮产出】整体覆盖写 transcript
  ——不管文件此刻是否已被外部改过，把刚追加的"做好了"原样冲掉。
- 取消路径（用户中途点停止）落的是 `ctx.live_messages`（同样是轮开始时的旧快照+跑到一半的部分），
  是同一个 bug class，这里也一并验证覆盖到。

修法：轮开始时先记一份磁盘轨迹行数基准（`ctx.transcript_baseline_len`，见 context.py），轮收尾整份
覆盖写前用 `save_transcript_preserving_external_tail` 把磁盘上超出基准的尾部（= 外部追加）拼回本轮
产出后面再写（见 transcript.py）。对 autocompact 鲁棒——不比较内容，只看磁盘现存文件的行数。

本文件在 `_stream_agent_events` / `start_agent_task` 这一层复现，验证 agent.py 里两处调用点的真实
接线（不是只测 transcript.py 的纯函数）。
"""
import asyncio
import uuid
from types import SimpleNamespace

import services.agent.transcript as T


def _use_tmp(monkeypatch, tmp_path):
    monkeypatch.setattr(T.settings, "upload_dir", str(tmp_path))


async def _noop(*args, **kwargs):
    return None


def _wire_common_mocks(monkeypatch, agent_mod):
    async def fake_load_memory(db, store_id, working_dir=None):
        return []

    monkeypatch.setattr(agent_mod, "check_quota", _noop)
    monkeypatch.setattr(agent_mod, "load_scoped_store_memory", fake_load_memory)
    monkeypatch.setattr(agent_mod, "render_operation_profile_context", lambda store: "")
    monkeypatch.setattr(agent_mod, "_persist_agent_chat", _noop)
    # "done" 分支里会 `from services.usage_event_service import log_event` 打点埋点——真实实现会经
    # 模块级默认 async_session() 连真 DB；这里没配测试 DB，不挡住会在 CI/本机跑出连接失败的噪音日志
    # (被 log_event 自己 try/except 吞掉、不影响断言，但会污染多测试同跑时的事件循环)。跟本文件要
    # 验证的 transcript 竞态无关，屏蔽掉更干净。
    import services.usage_event_service as usage_event_service
    monkeypatch.setattr(usage_event_service, "log_event", _noop)
    monkeypatch.setattr(agent_mod.denial_tracker, "load_into_ctx", lambda ctx, cid: None)
    monkeypatch.setattr(agent_mod, "build_resilient_text_provider", lambda store: object())


async def test_media_job_append_mid_turn_survives_turn_end_overwrite(monkeypatch, tmp_path):
    """主线复现：轮 2 进行中，视频任务做完、媒体任务完成回调往磁盘追加一条——轮 2 收尾的整份覆盖写
    不能把它冲掉。"""
    import api.v1.agent as agent_mod
    from services.agent.transcript import append_transcript

    _use_tmp(monkeypatch, tmp_path)
    _wire_common_mocks(monkeypatch, agent_mod)

    cid = str(uuid.uuid4())
    # 轮 1 已完成落盘的历史（轮 2 开始时，主循环会读到这份当 history）
    T.save_transcript(cid, [
        {"role": "user", "content": "帮我做条视频"},
        {"role": "assistant", "content": "好的，正在后台做，做好了告诉你"},
    ])

    async def fake_loop(**kwargs):
        ctx = kwargs["ctx"]
        history = kwargs["history"] or []
        # 模拟"轮 2 进行中"——视频任务在这轮聊天期间做完了，媒体任务完成回调把结果追加进磁盘轨迹，
        # 这跟主循环内部的 messages 是完全独立的另一路写入，主循环对此一无所知。
        append_transcript(cid, [{"role": "assistant", "content": "视频做好了!"}])
        # 轮收尾算出的 final_messages：只是"轮开始时的 history + 这轮的新对话"，不知道外部发生了什么
        # （这正是 bug 的根源——ctx.final_messages 就是这么算出来的，不是我们瞎编的测试假设）。
        ctx.final_messages = list(history) + [
            {"role": "user", "content": "还在吗"},
            {"role": "assistant", "content": "还有什么要帮忙的吗"},
        ]
        yield {"type": "final", "content": "还有什么要帮忙的吗"}
        yield {"type": "done", "turns": 1, "stopped_reason": "stop", "tokens_used": 0}

    monkeypatch.setattr(agent_mod, "run_agent_loop_stream", fake_loop)

    body = agent_mod.AgentChatRequest(message="还在吗", conversation_id=cid)
    events = [
        e async for e in agent_mod._stream_agent_events(
            body, SimpleNamespace(id="u1"),
            SimpleNamespace(id="s1", agent_auto_spend_limit=None), SimpleNamespace(),
        )
    ]
    assert any(e["type"] == "done" for e in events)

    out = T.load_transcript(cid)
    contents = [m.get("content") for m in (out or [])]
    assert "视频做好了!" in contents, f"媒体任务完成消息被轮收尾覆盖写冲掉了：{contents}"
    # 本轮自己的新对话也要在（不能为了保外部追加反而丢了本轮）
    assert "还有什么要帮忙的吗" in contents
    # 外部追加是"较新事件"，拼在末尾，不打乱顺序
    assert contents[-1] == "视频做好了!"


async def test_no_external_append_normal_save_unchanged(monkeypatch, tmp_path):
    """回归：没有外部追加时，行为跟修复前完全一样——落盘内容就是 final_messages 本身，不多不少。"""
    import api.v1.agent as agent_mod

    _use_tmp(monkeypatch, tmp_path)
    _wire_common_mocks(monkeypatch, agent_mod)

    cid = str(uuid.uuid4())
    T.save_transcript(cid, [
        {"role": "user", "content": "帮我写条文案"},
        {"role": "assistant", "content": "好的，稍等"},
    ])

    async def fake_loop(**kwargs):
        ctx = kwargs["ctx"]
        history = kwargs["history"] or []
        ctx.final_messages = list(history) + [
            {"role": "user", "content": "再来一条"},
            {"role": "assistant", "content": "这是第二条文案"},
        ]
        yield {"type": "final", "content": "这是第二条文案"}
        yield {"type": "done", "turns": 1, "stopped_reason": "stop", "tokens_used": 0}

    monkeypatch.setattr(agent_mod, "run_agent_loop_stream", fake_loop)

    body = agent_mod.AgentChatRequest(message="再来一条", conversation_id=cid)
    events = [
        e async for e in agent_mod._stream_agent_events(
            body, SimpleNamespace(id="u1"),
            SimpleNamespace(id="s1", agent_auto_spend_limit=None), SimpleNamespace(),
        )
    ]
    assert any(e["type"] == "done" for e in events)

    out = T.load_transcript(cid)
    assert [m["content"] for m in out] == ["帮我写条文案", "好的，稍等", "再来一条", "这是第二条文案"]


async def test_autocompact_rebuilt_final_messages_still_preserves_external_tail(monkeypatch, tmp_path):
    """对 autocompact 鲁棒：final_messages 被压缩重建成摘要+少数几条，跟磁盘上轮开始时的历史
    长度/内容完全对不上——外部追加的尾部依然要能正确接回去（不能因为压缩就失效）。"""
    import api.v1.agent as agent_mod
    from services.agent.transcript import append_transcript

    _use_tmp(monkeypatch, tmp_path)
    _wire_common_mocks(monkeypatch, agent_mod)

    cid = str(uuid.uuid4())
    # 轮 2 开始时磁盘上历史比较长（模拟已经聊了不少轮）
    T.save_transcript(cid, [
        {"role": "user", "content": f"第{i}轮问题"} for i in range(10)
    ])

    async def fake_loop(**kwargs):
        ctx = kwargs["ctx"]
        append_transcript(cid, [{"role": "assistant", "content": "剪辑做好了!"}])
        # 模拟 autocompact 已经把前缀压成一条摘要——不再是"轮开始历史原样 + 本轮新增"
        ctx.final_messages = [
            {"role": "user", "content": "[之前对话摘要] 省略前 10 轮"},
            {"role": "assistant", "content": "好的，已了解前情"},
            {"role": "user", "content": "视频剪辑弄完了吗"},
            {"role": "assistant", "content": "还在剪，好了叫你"},
        ]
        yield {"type": "final", "content": "还在剪，好了叫你"}
        yield {"type": "done", "turns": 1, "stopped_reason": "stop", "tokens_used": 0}

    monkeypatch.setattr(agent_mod, "run_agent_loop_stream", fake_loop)

    body = agent_mod.AgentChatRequest(message="视频剪辑弄完了吗", conversation_id=cid)
    events = [
        e async for e in agent_mod._stream_agent_events(
            body, SimpleNamespace(id="u1"),
            SimpleNamespace(id="s1", agent_auto_spend_limit=None), SimpleNamespace(),
        )
    ]
    assert any(e["type"] == "done" for e in events)

    out = T.load_transcript(cid)
    contents = [m.get("content") for m in out]
    assert "剪辑做好了!" in contents
    assert contents[-1] == "剪辑做好了!"  # 外部追加拼在末尾，不管压缩重建成什么样
    assert contents[-2] == "还在剪，好了叫你"  # 压缩后的本轮新增内容原样保留


async def test_media_job_append_during_cancelled_turn_survives_cancel_path_save(monkeypatch, tmp_path):
    """取消路径（用户中途点停止）落的是 ctx.live_messages（轮开始时旧快照 + 跑到一半的部分），
    跟"done"路径是同一个 bug class——同样不能把进行中被外部追加的行冲掉。"""
    import api.v1.agent as agent_mod

    agent_mod._AGENT_TASKS.clear()
    _use_tmp(monkeypatch, tmp_path)
    _wire_common_mocks(monkeypatch, agent_mod)

    cid = str(uuid.uuid4())
    T.save_transcript(cid, [
        {"role": "user", "content": "开始剪视频"},
        {"role": "assistant", "content": "在剪了"},
    ])

    async def fake_loop(**kwargs):
        ctx = kwargs["ctx"]
        history = kwargs["history"] or []
        ctx.live_messages = list(history) + [{"role": "user", "content": "还没好吗"}]
        yield {"type": "token", "content": "..."}
        await asyncio.sleep(10)  # 卡住等取消
        yield {"type": "done", "turns": 1, "stopped_reason": "stop", "tokens_used": 0}  # 不会跑到

    monkeypatch.setattr(agent_mod, "run_agent_loop_stream", fake_loop)

    class _Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, model, id):
            return None

    monkeypatch.setattr(agent_mod, "async_session", lambda: _Session())
    monkeypatch.setattr(agent_mod, "_learn_in_background", lambda *a, **k: asyncio.sleep(0))

    body = agent_mod.AgentChatRequest(message="还没好吗", conversation_id=cid)
    res = await agent_mod.start_agent_task(
        body, user=SimpleNamespace(id="u1"),
        store=SimpleNamespace(id="s1", agent_auto_spend_limit=None),
    )
    task_id = res["task_id"]
    await asyncio.sleep(0.05)  # 让 fake_loop 跑到卡住那一步、ctx.live_messages 已经设好

    # 模拟：卡在这一轮期间，媒体任务完成回调往磁盘追加一条("视频做好了")
    T.append_transcript(cid, [{"role": "assistant", "content": "视频做好了!"}])

    cancel = await agent_mod.cancel_agent_task(task_id)
    assert cancel["status"] == "cancelled"
    await asyncio.sleep(0.05)

    out = T.load_transcript(cid)
    contents = [m.get("content") for m in (out or [])]
    assert "视频做好了!" in contents, f"取消路径落轨迹把外部追加冲掉了：{contents}"
