"""子代理专家池：类型解析 + 只读型只拿只读工具（对标 Claude Code AgentDef）。"""
from services.agent import web_tools as wt


def test_resolve_known_types():
    assert wt._resolve_subagent_type("explore")["read_only"] is True
    assert wt._resolve_subagent_type("plan")["read_only"] is True
    assert wt._resolve_subagent_type("general-purpose")["read_only"] is False


def test_resolve_case_insensitive_and_alias():
    assert wt._resolve_subagent_type("Explore")["read_only"] is True
    assert wt._resolve_subagent_type("general")["read_only"] is False


def test_resolve_default_and_fallback():
    assert wt._resolve_subagent_type(None)["read_only"] is False
    assert wt._resolve_subagent_type("nonsense")["read_only"] is False  # 回退 general-purpose


def test_each_type_has_prompt():
    for t in wt._SUBAGENT_TYPES.values():
        assert t["prompt"].strip()
