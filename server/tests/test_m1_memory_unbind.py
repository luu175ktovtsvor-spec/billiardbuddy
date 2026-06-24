"""M1 记忆解绑：店脑记忆(AI 学到的关于你的事)通用模式也注入;门店画像(台球档案)仍只台球时给。"""


def test_store_brain_general_but_profile_billiards_only():
    from api.v1.agent import compose_agent_system_prompt
    brain = "【请记住】老板姓张，说话喜欢简洁直接"
    profile = "本店台数20张、定价30元/小时、会员卡满500送50"

    g = compose_agent_system_prompt(profile, brain, billiards_mode=False)
    assert "老板姓张" in g          # 店脑记忆 → 通用模式也注入（治"通用零长期记忆"）
    assert "台数20" not in g        # 门店画像（台球档案）→ 通用模式不注入（守通用定位）

    b = compose_agent_system_prompt(profile, brain, billiards_mode=True)
    assert "老板姓张" in b           # 台球模式：店脑记忆在
    assert "台数20" in b            # 台球模式：门店画像也在


def test_store_brain_empty_safe():
    from api.v1.agent import compose_agent_system_prompt
    g = compose_agent_system_prompt("", "", billiards_mode=False)
    assert isinstance(g, str) and len(g) > 0   # 空记忆不崩、正常出通用系统提示


def test_recall_tool_ungated_to_general():
    from services.agent.registry import BILLIARDS_TOOL_NAMES
    assert "recall_my_content" not in BILLIARDS_TOOL_NAMES   # M1：移出台球专属 → 通用也能回看过往产出
