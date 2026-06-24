"""通用 Agent 化 · 系统提示三段验证。

钉死本轮核心反转：
- 默认（未 @ 台球知识库）= 通用 AI 助手，绝不自报台球身份、不注入门店画像（台球档案）。
  （M1 后：店脑记忆=通用助手长期记忆，通用模式也注入；只有门店画像这种台球档案才门控。）
- 安全红线【永远注入】，与 billiards_mode 无关——没 @ 台球也守得住。
- billiards_mode=True 才挂台球人设 + 门店画像 + 店脑。
"""
from api.v1.agent import (
    compose_agent_system_prompt,
    _GENERIC_BASE_PROMPT,
    _SAFETY_REDLINE,
    _BILLIARDS_PERSONA,
)


def test_default_is_general_not_billiards():
    p = compose_agent_system_prompt("门店画像XYZ", "店脑记忆ABC", full_disk=False)
    assert "通用 AI 助手" in p
    assert "你是台球房运营助手" not in p          # 默认不再自报台球身份
    assert "挂载了「台球行业知识库」" not in p     # 默认不挂台球人设
    assert "门店画像XYZ" not in p                  # 默认不注入门店画像（台球档案，守通用定位）
    assert "店脑记忆ABC" in p                       # M1：店脑记忆(长期记忆)通用模式也注入，让助手越用越懂你


def test_safety_redline_always_present_in_both_modes():
    p_general = compose_agent_system_prompt("", "", full_disk=False)
    p_billiards = compose_agent_system_prompt("", "", billiards_mode=True)
    for p in (p_general, p_billiards):
        assert "安全红线" in p
        assert "实际性交易" in p
        assert "组织赌博" in p
        assert "未成年" in p


def test_billiards_mode_mounts_persona_and_store_context():
    p = compose_agent_system_prompt("门店画像XYZ", "店脑记忆ABC", billiards_mode=True)
    assert "台球行业知识库" in p
    assert "门店画像XYZ" in p
    assert "店脑记忆ABC" in p
    # 仍是通用底座 + 红线打底
    assert "通用 AI 助手" in p
    assert "安全红线" in p


def test_three_segments_are_distinct_nonempty():
    assert _GENERIC_BASE_PROMPT and "通用 AI 助手" in _GENERIC_BASE_PROMPT
    assert _SAFETY_REDLINE and "安全红线" in _SAFETY_REDLINE
    assert _BILLIARDS_PERSONA and "台球" in _BILLIARDS_PERSONA
    # 台球术语不该漏进通用底座（通用模式下不谈台球）
    assert "台球" not in _GENERIC_BASE_PROMPT


def test_billiards_mode_injects_l0_core_layer():
    """知识库模块化重构第5步：@台球时注入 L0 核心层三件（运营总则 + 五域模块地图 + 安全红线单一源）。"""
    p = compose_agent_system_prompt("画像", "记忆", billiards_mode=True)
    assert "五域模块地图" in p           # core.module_map：五域任务路由
    assert "运营总则" in p               # core.operating_principles：常驻总则
    assert "唯一可信源" in p             # core.safety_redlines：红线单一源标识
    # 五域名都在地图里（agent 据此路由任务到对应域）
    for dom in ("战略认知", "营销获客", "客户运营", "人才管理", "数据诊断"):
        assert dom in p


def test_general_mode_no_l0_core_layer():
    """通用模式（未 @台球）绝不注入 L0 台球核心层——台球只是可挂载领域。"""
    p = compose_agent_system_prompt("画像", "记忆", billiards_mode=False)
    assert "五域模块地图" not in p
    assert "运营总则" not in p


def test_l0_core_layer_before_today_line_for_cache():
    """前缀缓存纪律：L0 核心层（byte 稳定）必须排在【当天日期】之前，不被每天变的日期顶掉缓存。"""
    p = compose_agent_system_prompt("画像", "记忆", billiards_mode=True)
    if "【今天】" in p:  # _today_line 正常产出时才校验位置
        assert p.index("五域模块地图") < p.index("【今天】")
        # 门店画像/店脑（每店每句变）应在日期之后（动态尾段）
        assert p.index("【今天】") < p.index("画像")


def test_general_registry_excludes_billiards_includes_generic_tools():
    """通用工具集 = 默认表减台球专用；含核心通用工具 + 通用生图；台球集含台球专用工具。"""
    import services.agent.tools  # noqa: F401  确保工具登记进 default_registry
    import services.agent.web_tools  # noqa: F401
    from services.agent.registry import general_registry, billiards_registry, BILLIARDS_TOOL_NAMES

    gen = set(general_registry().names())
    biz = set(billiards_registry().names())
    # 通用集不含任何台球专用工具
    assert not (gen & BILLIARDS_TOOL_NAMES), f"通用集混入了台球工具：{gen & BILLIARDS_TOOL_NAMES}"
    # 通用集含环境无关的核心通用能力 + 新的通用生图
    #（注：本机文件/命令工具 run_command/read_file/write_file… 只在 DESKTOP_LOCAL=1 桌面模式注册，
    #  云端/测试环境本就不在表里；它们不在台球名单里，桌面模式下会正常进通用集。）
    for name in ("web_search", "web_fetch", "todo_write", "run_subagent",
                 "generate_image", "get_current_date", "ask_user_question"):
        assert name in gen, f"通用集缺了通用工具：{name}"
    # 台球集 = 全部，含台球专用工具
    assert "write_operation_content" in biz and "make_poster" in biz
    # 生图是通用能力：两个集都该有
    assert "generate_image" in gen and "generate_image" in biz
    # 台球专用工具确实不在通用集（抽查）
    assert "make_poster" not in gen and "write_operation_content" not in gen
