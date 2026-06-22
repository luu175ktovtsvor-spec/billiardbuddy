"""/goal 目标驱动 Stop hook：设了目标→收尾前回灌自检；没设→no-op。"""
import asyncio

from services.agent.goal_hook import _goal_stop_hook
from services.agent.context import AgentContext


def test_goal_hook_nudges_when_set():
    r = asyncio.run(_goal_stop_hook([], AgentContext(goal="跑绿全部测试")))
    assert r is not None
    assert "跑绿全部测试" in r["continue"]


def test_goal_hook_noop_when_unset():
    assert asyncio.run(_goal_stop_hook([], AgentContext())) is None
    assert asyncio.run(_goal_stop_hook([], AgentContext(goal="   "))) is None
