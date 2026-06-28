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
    _BILLIARDS_P0A_BOUNDARY,
    _DESKTOP_FILE_OPS_HINT,
    _WEB_AGENT_TOOLS_HINT,
    _today_line,
    compose_agent_system_prompt,
    _recent_artifact_item,
)
from services.memory_service import Memory, filter_memories_for_mode, format_memories_for_prompt


def test_billiards_mode_includes_profile_and_brain():
    # 门店画像/店脑只在 @台球 时注入
    out = compose_agent_system_prompt(
        "门店定位：社区店，主打散客", "请记住：老板叫李伟，主推一卡通", billiards_mode=True,
    )
    assert _GENERIC_BASE_PROMPT in out
    assert _BILLIARDS_PERSONA in out
    assert "社区店" in out
    assert "李伟" in out


def test_default_general_omits_profile_keeps_general_memory_only():
    # 默认通用(没 @ 台球)——门店画像不注入；台球门店事实也不应污染普通任务。
    out = compose_agent_system_prompt("门店定位：社区店", "请记住：老板叫李伟，说话喜欢简洁")
    assert "社区店" not in out          # 门店画像 → 通用不注入（守通用定位）
    assert "李伟" in out                # 非台球领域的长期用户偏好/事实仍可注入
    assert _BILLIARDS_PERSONA not in out


def test_general_memory_filter_drops_billiards_store_facts():
    memories = [
        Memory("semantic", "我店在杭州，26 张台，主做竞技客户", source="manual"),
        Memory("preference", "老板喜欢回答短一点", source="manual"),
        Memory("operational", "周赛一般放周五晚上", source="auto"),
    ]
    general = filter_memories_for_mode(memories, billiards_mode=False)
    billiards = filter_memories_for_mode(memories, billiards_mode=True)

    assert [m.content for m in general] == ["老板喜欢回答短一点"]
    assert [m.content for m in billiards] == [m.content for m in memories]

    general_prompt = compose_agent_system_prompt(
        "",
        format_memories_for_prompt(general, intent="帮我整理下载文件夹"),
        billiards_mode=False,
    )
    assert "老板喜欢回答短一点" in general_prompt
    assert "26 张台" not in general_prompt
    assert "周赛" not in general_prompt


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


def test_billiards_p0a_boundary_frontloads_risk_and_store_name_rules():
    out = compose_agent_system_prompt("", "", billiards_mode=True)
    assert _BILLIARDS_P0A_BOUNDARY in out
    for word in ("追分", "玩大", "彩头", "抽水", "坐庄"):
        assert word in out
    for alternative in ("正规周赛", "技术挑战", "台费优惠", "会员积分"):
        assert alternative in out
    assert "[门店名]" in out
    assert "鑫和台球" in out and "测试球城" in out


def test_billiards_mode_enforces_operational_answer_shape():
    out = compose_agent_system_prompt("", "", billiards_mode=True)
    assert "先给一句判断" in out
    assert "3 条以内今晚/明天能做的动作" in out
    assert "可复制话术" in out
    assert "最后给下一步" in out
    assert "不要输出课程式长文" in out


def test_general_mode_does_not_inject_billiards_p0a_boundary():
    out = compose_agent_system_prompt("", "", billiards_mode=False)
    assert _BILLIARDS_P0A_BOUNDARY not in out
    assert "追分、玩大、彩头" not in out
    assert "3 条以内今晚/明天能做的动作" not in out


def test_recent_artifact_video_keeps_ratio_duration_and_url():
    from types import SimpleNamespace
    from uuid import uuid4
    from datetime import datetime, timezone

    g = SimpleNamespace(
        id=uuid4(),
        type="video",
        title=None,
        result="/uploads/videos/demo.mp4",
        input_params={"prompt": "周赛海报做成同城视频", "ratio": "9:16", "duration": 5},
        sub_type="9:16",
        conversation_id=uuid4(),
        created_at=datetime(2026, 6, 27, tzinfo=timezone.utc),
    )
    item = _recent_artifact_item(g)

    assert item["kind"] == "video"
    assert item["url"] == "/uploads/videos/demo.mp4"
    assert item["ratio"] == "9:16"
    assert item["duration"] == 5
    assert item["subtitle"] == "视频任务"


async def test_stream_agent_done_carries_memory_refs(monkeypatch):
    import api.v1.agent as agent_mod
    from types import SimpleNamespace

    seen = {}

    async def fake_load_memory(db, store_id, working_dir=None):
        seen["working_dir"] = working_dir
        return [Memory("semantic", "我店在杭州，26 张台", source="manual")]

    async def fake_loop(**kwargs):
        yield {"type": "final", "content": "按你店情况给建议"}
        yield {"type": "done", "turns": 1, "stopped_reason": "stop", "tokens_used": 0}

    async def noop(*args, **kwargs):
        return None

    monkeypatch.setattr(agent_mod, "check_quota", noop)
    monkeypatch.setattr(agent_mod, "load_scoped_store_memory", fake_load_memory)
    monkeypatch.setattr(agent_mod, "render_operation_profile_context", lambda store: "")
    monkeypatch.setattr(agent_mod, "run_agent_loop_stream", fake_loop)
    monkeypatch.setattr(agent_mod, "_persist_agent_chat", noop)
    monkeypatch.setattr(agent_mod.denial_tracker, "load_into_ctx", lambda ctx, cid: None)
    monkeypatch.setattr(agent_mod, "build_resilient_text_provider", lambda store: object())

    body = agent_mod.AgentChatRequest(message="帮我写活动文案", working_dir="/tmp/六月报表")
    events = [
        e async for e in agent_mod._stream_agent_events(
            body,
            SimpleNamespace(id="u1"),
            SimpleNamespace(id="s1", agent_auto_spend_limit=None),
            SimpleNamespace(),
        )
    ]
    done = [e for e in events if e["type"] == "done"][0]
    assert done["memory_refs"] == ["我店在杭州，26 张台"]
    assert seen["working_dir"] == "/tmp/六月报表"


def test_stale_test_store_names_are_sanitized_from_brain_context():
    out = compose_agent_system_prompt(
        "",
        "请记住：鑫和台球在泉州，测试球城常做周赛",
        billiards_mode=True,
    )
    assert "请记住：[门店名]在泉州，[门店名]常做周赛" in out
    assert "鑫和台球在泉州" not in out
    assert "测试球城常做周赛" not in out
