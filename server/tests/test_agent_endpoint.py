"""P1.3 agent 端点：system prompt 注入"懂这家店"。

锁住 compose_agent_system_prompt 的拼装规则（纯函数、不碰 DB）：
- 基底指令恒在
- 有门店画像则带上
- 有店脑记忆则带上
- 当天日期行恒在（让大脑懂"今天/这周末"，不必反射性查日期）
- 画像/店脑都为空时只剩基底 + 当天日期行（不产生空标题/空块）
"""
from api.v1.agent import (
    _AGENT_BASE_PROMPT,
    _WEB_AGENT_TOOLS_HINT,
    _today_line,
    compose_agent_system_prompt,
)


def test_compose_includes_profile_and_brain():
    out = compose_agent_system_prompt("门店定位：社区店，主打散客", "请记住：老板叫李伟，主推一卡通")
    assert _AGENT_BASE_PROMPT in out
    assert "社区店" in out
    assert "李伟" in out


def test_compose_empty_is_base_plus_today():
    # 都为空：基底 + 当天日期行 + 通用 web/agent 工具 hint，不掺空的画像/店脑块
    out = compose_agent_system_prompt("", "")
    assert out == _AGENT_BASE_PROMPT + "\n\n" + _today_line() + "\n\n" + _WEB_AGENT_TOOLS_HINT
    assert "【这家店的情况】" not in out
    assert compose_agent_system_prompt("   ", None or "") == out


def test_compose_always_has_web_agent_hint():
    # 第二批通用能力 hint（上网查资料/列清单/拆子任务）恒注入，让大脑知道何时用这四个工具
    out = compose_agent_system_prompt("门店定位：社区店", "记住：老板叫李伟")
    assert "web_search" in out and "web_fetch" in out
    assert "todo_write" in out and "run_subagent" in out


def test_compose_always_has_today_line():
    out = compose_agent_system_prompt("门店定位：社区店", "记住：老板叫李伟")
    assert "【今天】" in out  # 当天日期恒注入


def test_compose_profile_only():
    out = compose_agent_system_prompt("门店定位：高端会所", "")
    assert "高端会所" in out
    assert _AGENT_BASE_PROMPT in out
