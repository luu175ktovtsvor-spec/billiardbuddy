"""G.1 P2：循环旋钮可配——max_turns / 交互式 token 刹车 / 编排温度。"""


def test_agent_max_turns_default_and_configurable(monkeypatch):
    from api.v1.agent import _agent_max_turns
    monkeypatch.delenv("DESKTOP_AGENT_MAX_TURNS", raising=False)
    assert _agent_max_turns() == 12                 # 默认从 8 提到 12（多步任务）
    monkeypatch.setenv("DESKTOP_AGENT_MAX_TURNS", "20")
    assert _agent_max_turns() == 20
    monkeypatch.setenv("DESKTOP_AGENT_MAX_TURNS", "999")
    assert _agent_max_turns() == 50                 # 越界钳到上限
    monkeypatch.setenv("DESKTOP_AGENT_MAX_TURNS", "abc")
    assert _agent_max_turns() == 12                 # 非法回落


def test_agent_token_budget(monkeypatch):
    from api.v1.agent import _agent_token_budget
    monkeypatch.delenv("DESKTOP_AGENT_TOKEN_BUDGET", raising=False)
    assert _agent_token_budget() is None            # 默认不限（行为不变）
    monkeypatch.setenv("DESKTOP_AGENT_TOKEN_BUDGET", "200000")
    assert _agent_token_budget() == 200000


def test_orch_temperature_default():
    from services.agent.loop import _ORCH_TEMPERATURE
    assert _ORCH_TEMPERATURE == 0.3                 # 没配 env 时默认 0.3（可经 DESKTOP_ORCH_TEMPERATURE 调）
