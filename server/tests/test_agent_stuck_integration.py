"""F-8/F3 防打转第二层 —— loop.py 接线集成测试：命中打转真的会回灌大白话提示 / 流式真的会吐
context_note 事件 / 只问一次不刷屏 / 用户插话后能重新问一次。

场景选 A-B-A-B 交替（两个不同签名的工具来回切换）——它天然不会撞上第一层"连续 5 次同签名"
的硬拦截（A、B 签名不同，各自连续计数永远是 1），能干净地单独验证第二层的行为。
"""
import asyncio
import json

from services.agent.context import AgentContext
from services.agent.loop import _STUCK_HINT_MSG, run_agent_loop, run_agent_loop_stream
from services.agent.registry import Tool, ToolRegistry
from services.ai.base import TextResponse
from services.ai.providers.mock import MockTextProvider


def _tc(name, cid, args):
    return {"id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}


def _alternating_reg():
    async def handler_a(args, ctx):
        return "resultA"

    async def handler_b(args, ctx):
        return "resultB"

    reg = ToolRegistry()
    reg.register(Tool(name="gen_a", description="t", parameters={"type": "object", "properties": {"style": {"type": "string"}}}, handler=handler_a))
    reg.register(Tool(name="gen_b", description="t", parameters={"type": "object", "properties": {"style": {"type": "string"}}}, handler=handler_b))
    return reg


class _AlternatingProvider(MockTextProvider):
    """持续来回切换 gen_a/gen_b，永不收敛——用来驱动第二层"独立于第一层"的打转检测。"""

    def __init__(self, rounds: int):
        super().__init__()
        self.turn = 0
        self.rounds = rounds

    def _resp(self):
        self.turn += 1
        if self.turn > self.rounds:
            return TextResponse(content="好的，先停在这", model="mock", finish_reason="stop")
        name = "gen_a" if self.turn % 2 == 1 else "gen_b"
        args = {"style": "复古"} if name == "gen_a" else {"style": "清新"}
        return TextResponse(content="", model="mock", tool_calls=[_tc(name, f"c{self.turn}", args)], finish_reason="tool_calls")

    async def generate(self, request):
        return self._resp()

    async def generate_stream(self, request, usage_sink=None, tool_calls_sink=None, finish_sink=None):
        resp = self._resp()
        if resp.content:
            yield resp.content
        if resp.tool_calls and tool_calls_sink is not None:
            tool_calls_sink.extend(resp.tool_calls)
        if finish_sink is not None and resp.finish_reason is not None:
            finish_sink["finish_reason"] = resp.finish_reason
        if usage_sink is not None:
            usage_sink.update({"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})


async def _collect(agen):
    return [ev async for ev in agen]


def test_sync_loop_injects_stuck_hint_exactly_once_on_persistent_alternating():
    """持续 ABAB 交替跑够阈值以上很多轮——应该命中一次打转提示，但只问一次，不刷屏。"""
    reg = _alternating_reg()
    provider = _AlternatingProvider(rounds=16)
    res = asyncio.run(run_agent_loop(user_message="帮我出几张风格对比图", registry=reg, provider=provider, max_turns=20))

    hint_msgs = [m for m in res.messages if m.get("role") == "assistant" and m.get("content") == _STUCK_HINT_MSG]
    assert len(hint_msgs) == 1  # 命中且只问一次，没有刷屏


def test_stream_loop_yields_context_note_on_persistent_alternating():
    """流式路径命中打转应吐一个 context_note 事件（复用 F9 现成的"低调系统旁白"通道，不是新机制），
    且不会被误渲染成用户说的话（context_note 与 steering 事件语义不同，这里只需确认命中即吐、只吐一次）。"""
    reg = _alternating_reg()
    provider = _AlternatingProvider(rounds=16)
    events = asyncio.run(_collect(run_agent_loop_stream(user_message="帮我出几张风格对比图", registry=reg, provider=provider, max_turns=20)))

    stuck_notes = [ev for ev in events if ev.get("type") == "context_note" and ev.get("content") == _STUCK_HINT_MSG]
    assert len(stuck_notes) == 1
    # 循环最终应该正常收尾（不会因为打转检测本身卡死/异常退出）
    assert events[-1]["type"] == "done"


def test_short_alternating_below_threshold_not_flagged():
    """交替次数不够阈值（只有 2 轮）——不该被判定为打转，属于"正常比较几种方案"。"""
    reg = _alternating_reg()
    provider = _AlternatingProvider(rounds=3)  # 3 次工具调用后收敛，不到 alternating 阈值 6
    res = asyncio.run(run_agent_loop(user_message="帮我出两种风格对比一下", registry=reg, provider=provider, max_turns=10))

    hint_msgs = [m for m in res.messages if m.get("role") == "assistant" and m.get("content") == _STUCK_HINT_MSG]
    assert len(hint_msgs) == 0


def test_user_steer_allows_stuck_hint_to_fire_again():
    """用户插话清零：打转提示问过一次后，老板真插了句话（steer_inbox），若之后又持续交替卡住，
    应该能重新问一次——不会因为"这轮问过了"就永久闭嘴。"""
    reg = _alternating_reg()
    ctx = AgentContext()

    class _SteeringProvider(_AlternatingProvider):
        """跑到第 10 轮时模拟老板插了一句话（steer_inbox），验证插话后打转检测能重新触发。"""

        def _resp(self):
            resp = super()._resp()
            if self.turn == 10:
                ctx.steer_inbox.append("先别弄了，等一下")
            return resp

    provider = _SteeringProvider(rounds=20)
    res = asyncio.run(run_agent_loop(user_message="帮我出几张风格对比图", registry=reg, ctx=ctx, provider=provider, max_turns=25))

    hint_msgs = [m for m in res.messages if m.get("role") == "assistant" and m.get("content") == _STUCK_HINT_MSG]
    # 插话前命中一次、插话（窗口边界后移、老板重新给了新信号）后交替若继续卡住会再命中一次
    assert len(hint_msgs) == 2
    # 插话原文确实被注入了（方向盘机制本身没被破坏）
    assert any(m.get("role") == "user" and "先别弄了" in (m.get("content") or "") for m in res.messages)
