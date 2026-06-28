"""记忆分层：通用偏好可进通用模式；台球门店事实仍只在 @台球时给。"""


def test_store_brain_general_preference_but_profile_billiards_only():
    from api.v1.agent import compose_agent_system_prompt
    brain = "【请记住】老板姓张，说话喜欢简洁直接"
    profile = "本店台数20张、定价30元/小时、会员卡满500送50"

    g = compose_agent_system_prompt(profile, brain, billiards_mode=False)
    assert "老板姓张" in g          # 通用偏好/用户事实 → 通用模式也注入
    assert "台数20" not in g        # 门店画像（台球档案）→ 通用模式不注入（守通用定位）

    b = compose_agent_system_prompt(profile, brain, billiards_mode=True)
    assert "老板姓张" in b           # 台球模式：店脑记忆在
    assert "台数20" in b            # 台球模式：门店画像也在


def test_billiards_store_memory_filtered_before_general_prompt():
    from api.v1.agent import compose_agent_system_prompt
    from services.memory_service import Memory, filter_memories_for_mode, format_memories_for_prompt

    memories = filter_memories_for_mode([
        Memory("semantic", "本店有20张球台，台费60元/小时", source="manual"),
        Memory("preference", "老板姓张，说话喜欢简洁直接", source="manual"),
    ], billiards_mode=False)
    g = compose_agent_system_prompt("", format_memories_for_prompt(memories), billiards_mode=False)

    assert "老板姓张" in g
    assert "20张球台" not in g
    assert "台费60" not in g


def test_store_brain_empty_safe():
    from api.v1.agent import compose_agent_system_prompt
    g = compose_agent_system_prompt("", "", billiards_mode=False)
    assert isinstance(g, str) and len(g) > 0   # 空记忆不崩、正常出通用系统提示


def test_recall_tool_ungated_to_general():
    from services.agent.registry import BILLIARDS_TOOL_NAMES
    assert "recall_my_content" not in BILLIARDS_TOOL_NAMES   # M1：移出台球专属 → 通用也能回看过往产出
