"""agent 端点：system prompt 拼装规则（通用 Agent 化后）。

锁住 compose_agent_system_prompt 的拼装规则（纯函数、不碰 DB）：
- 通用底座 + 安全红线恒在（默认就是通用助手；红线永远注入、不随 @ 开关）。
- 当天日期行恒在（让大脑懂"今天/这周末"，不必反射性查日期）。
- 门店画像 / 店脑记忆 / 台球人设 只在 billiards_mode=True（用户 @ 了台球知识库）时才注入。
- 顺序铁律（缓存稳定·s10）：静态段(通用底座+红线+通用能力hint+桌面文件hint)在前、字节稳定；
  动态段(当天日期 + 台球人设 + 门店画像 + 店脑记忆)一律排在静态段之后，绝不插进前缀中间。
"""
from api.v1.agent import (
    _GENERIC_BASE_PROMPT,
    _SAFETY_REDLINE,
    _BILLIARDS_PERSONA,
    _DESKTOP_FILE_OPS_HINT,
    _WEB_AGENT_TOOLS_HINT,
    _today_line,
    compose_agent_system_prompt,
)


def test_billiards_mode_includes_profile_and_brain():
    # 门店画像/店脑只在 @台球 时注入
    out = compose_agent_system_prompt(
        "门店定位：社区店，主打散客", "请记住：老板叫李伟，主推一卡通", billiards_mode=True,
    )
    assert _GENERIC_BASE_PROMPT in out
    assert _BILLIARDS_PERSONA in out
    assert "社区店" in out
    assert "李伟" in out


def test_default_general_omits_profile_keeps_brain():
    # M1：默认通用(没 @ 台球)——门店画像(台球档案)不注入；店脑记忆(长期记忆)注入，让通用助手越用越懂你。
    out = compose_agent_system_prompt("门店定位：社区店", "请记住：老板叫李伟")
    assert "社区店" not in out          # 门店画像 → 通用不注入（守通用定位）
    assert "李伟" in out                # 店脑记忆 → 通用也注入（M1 治"通用零长期记忆"）
    assert _BILLIARDS_PERSONA not in out


def test_compose_empty_general_is_base_redline_web_today():
    # 都为空 + 通用模式：通用底座 + 红线 + 通用 web/agent hint（静态段）在前，动态当天日期行在后
    out = compose_agent_system_prompt("", "")
    assert out == (
        _GENERIC_BASE_PROMPT + "\n\n" + _SAFETY_REDLINE + "\n\n"
        + _WEB_AGENT_TOOLS_HINT + "\n\n" + _today_line()
    )
    assert "【这家店的情况】" not in out
    assert compose_agent_system_prompt("   ", None or "") == out


def test_static_hints_precede_dynamic_segments(monkeypatch):
    """缓存稳定铁律：真正每天变的日期 + 每店变的画像/记忆，必须排在所有静态段之后。

    模块化重构第5步后：台球 L0 核心层 + 台球人设也是【会话内 byte 稳定】的静态内容（不随日期/门店/这句话变），
    已前移到日期之前的静态前缀区——所以人设不再属于"动态段"，而和 web/文件 hint 一样算静态前缀。"""
    monkeypatch.setenv("DESKTOP_LOCAL", "1")  # 触发桌面文件能力 hint，验证它也在动态段之前
    out = compose_agent_system_prompt(
        "门店A的画像特征", "请记住：老板叫张三", full_disk=False, billiards_mode=True,
    )
    i_web = out.index(_WEB_AGENT_TOOLS_HINT)
    i_fileops = out.index(_DESKTOP_FILE_OPS_HINT)
    i_persona = out.index(_BILLIARDS_PERSONA)
    i_today = out.index(_today_line())
    i_profile = out.index("门店A的画像特征")
    i_brain = out.index("张三")
    # 静态前缀（web hint / 文件 hint / 台球 L0+人设，都 byte 稳定）全在动态尾段（日期/画像/记忆）之前
    assert max(i_web, i_fileops, i_persona) < min(i_today, i_profile, i_brain)
    # 动态尾段内部：日期 → 画像 → 记忆（越靠后越易变）
    assert i_today < i_profile < i_brain


def test_static_prefix_byte_stable_across_stores(monkeypatch):
    """两家不同店、同一安装/模式下，静态前缀逐字节一致 → 服务端自动前缀缓存可命中。"""
    import os
    monkeypatch.setenv("DESKTOP_LOCAL", "1")
    a = compose_agent_system_prompt("社区散客店", "店A记忆", full_disk=False, billiards_mode=True)
    b = compose_agent_system_prompt("高端会所", "店B完全不同的记忆内容", full_disk=False, billiards_mode=True)
    common = os.path.commonprefix([a, b])
    # 公共前缀必须长到把所有静态段都吃进去（说明分歧只发生在动态尾段）
    assert _GENERIC_BASE_PROMPT in common
    assert _SAFETY_REDLINE in common
    assert _WEB_AGENT_TOOLS_HINT in common
    assert _DESKTOP_FILE_OPS_HINT in common


def test_compose_always_has_web_agent_hint():
    # 通用能力 hint（上网查资料/列清单/拆子任务）恒注入（通用模式也在）
    out = compose_agent_system_prompt("", "")
    assert "web_search" in out and "web_fetch" in out
    assert "todo_write" in out and "run_subagent" in out


def test_compose_always_has_today_line():
    out = compose_agent_system_prompt("", "")
    assert "【今天】" in out  # 当天日期恒注入


def test_safety_redline_always_present_even_in_general():
    # 红线永远注入：没 @ 台球（通用模式）也守得住
    out = compose_agent_system_prompt("", "")
    assert _SAFETY_REDLINE in out
    assert "实际性交易" in out and "组织赌博" in out
