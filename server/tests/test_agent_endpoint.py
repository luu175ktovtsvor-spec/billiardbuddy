"""P1.3 agent 端点：system prompt 注入"懂这家店"。

锁住 compose_agent_system_prompt 的拼装规则（纯函数、不碰 DB）：
- 基底指令恒在
- 有门店画像则带上
- 有店脑记忆则带上
- 当天日期行恒在（让大脑懂"今天/这周末"，不必反射性查日期）
- 顺序铁律（缓存稳定·s10）：静态段(基底+通用能力hint+桌面文件hint)在前、字节稳定；
  动态段(当天日期+门店画像+店脑记忆)一律排在静态段之后，绝不插进前缀中间。
"""
from api.v1.agent import (
    _AGENT_BASE_PROMPT,
    _DESKTOP_FILE_OPS_HINT,
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
    # 都为空：静态段(基底 + 通用 web/agent 工具 hint)在前、动态当天日期行在后，不掺空的画像/店脑块
    out = compose_agent_system_prompt("", "")
    assert out == _AGENT_BASE_PROMPT + "\n\n" + _WEB_AGENT_TOOLS_HINT + "\n\n" + _today_line()
    assert "【这家店的情况】" not in out
    assert compose_agent_system_prompt("   ", None or "") == out


def test_static_hints_precede_dynamic_segments(monkeypatch):
    """缓存稳定铁律：每天变的日期 + 每店变的画像/记忆，必须排在所有静态段之后。
    若动态串卡在静态前缀中间，会顶掉它后面静态内容的服务端自动前缀缓存命中。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")  # 触发桌面文件能力 hint，验证它也在动态段之前
    out = compose_agent_system_prompt("门店A的画像特征", "请记住：老板叫张三", full_disk=False)
    i_web = out.index(_WEB_AGENT_TOOLS_HINT)
    i_fileops = out.index(_DESKTOP_FILE_OPS_HINT)
    i_profile = out.index("门店A的画像特征")
    i_brain = out.index("张三")
    i_today = out.index(_today_line())
    # 所有静态段(web hint / 文件 hint) 都在所有动态段(日期/画像/记忆)之前
    assert max(i_web, i_fileops) < min(i_today, i_profile, i_brain)
    # 动态段内部：日期 → 画像 → 记忆（越靠后越易变）
    assert i_today < i_profile < i_brain


def test_static_prefix_byte_stable_across_stores(monkeypatch):
    """两家不同店、同一安装/模式下，静态前缀逐字节一致 → 服务端自动前缀缓存可命中。"""
    import os
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    a = compose_agent_system_prompt("社区散客店", "店A记忆", full_disk=False)
    b = compose_agent_system_prompt("高端会所", "店B完全不同的记忆内容", full_disk=False)
    common = os.path.commonprefix([a, b])
    # 公共前缀必须长到把所有静态段都吃进去（说明分歧只发生在动态尾段）
    assert _AGENT_BASE_PROMPT in common
    assert _WEB_AGENT_TOOLS_HINT in common
    assert _DESKTOP_FILE_OPS_HINT in common


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
