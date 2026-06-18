"""长对话上下文封顶（防撑爆）测试。"""
from api.v1.agent import _cap_history, _HIST_MAX_MSGS, _HIST_MAX_CHARS


def test_caps_message_count():
    hist = [{"role": "user", "content": f"m{i}"} for i in range(40)]
    out = _cap_history(hist)
    assert len(out) == _HIST_MAX_MSGS          # 只留最近 N 条
    assert out[-1]["content"] == "m39"          # 保留最近的
    assert out[0]["content"] == f"m{40 - _HIST_MAX_MSGS}"  # 丢掉最旧的


def test_truncates_long_content():
    out = _cap_history([{"role": "assistant", "content": "x" * 9000}])
    assert len(out[0]["content"]) == _HIST_MAX_CHARS


def test_none_and_empty_unchanged():
    assert _cap_history(None) is None
    assert _cap_history([]) == []


def test_short_history_unchanged():
    hist = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "yo"}]
    assert _cap_history(hist) == hist
