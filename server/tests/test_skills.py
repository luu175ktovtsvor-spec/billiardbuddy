"""Skills 系统测试（对标 Claude Code SKILL.md 的加载/渐进披露/调用）。"""
import asyncio
from pathlib import Path

from services.agent import skills as sk


def _make_skill(root: Path, name: str, body: str = "做某事：先 A 后 B。", **fm) -> Path:
    d = root / name
    d.mkdir(parents=True, exist_ok=True)
    lines = ["---", f"name: {name}"]
    for k, v in fm.items():
        lines.append(f"{k.replace('_', '-')}: {v}")
    lines.append("---")
    lines.append(body)
    (d / "SKILL.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return d


def test_parse_frontmatter_basic():
    meta, body = sk.parse_frontmatter("---\nname: foo\ndescription: bar\n---\nhello body\n")
    assert meta["name"] == "foo"
    assert meta["description"] == "bar"
    assert body.strip() == "hello body"


def test_parse_frontmatter_none():
    meta, body = sk.parse_frontmatter("no front matter here")
    assert meta == {}
    assert "no front matter" in body


def test_parse_frontmatter_crlf():
    meta, body = sk.parse_frontmatter("---\r\nname: x\r\n---\r\nbody here\r\n")
    assert meta["name"] == "x"
    assert "body here" in body


def test_load_skill_from_dir(tmp_path):
    _make_skill(tmp_path, "weekly-post", description="写一周朋友圈", body="步骤一二三")
    skills = sk.load_skills(dirs=[("user", tmp_path)])
    assert len(skills) == 1
    s = skills[0]
    assert s.name == "weekly-post"
    assert "一周朋友圈" in s.description
    assert s.source == "user"
    assert "步骤一二三" in s.body


def test_description_falls_back_to_first_body_line(tmp_path):
    # 没写 description → 取正文首个非空行（去标题井号）
    d = tmp_path / "noseed"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: noseed\n---\n# 标题行\n正文\n", encoding="utf-8")
    skills = sk.load_skills(dirs=[("user", tmp_path)])
    assert skills[0].description == "标题行"


def test_load_skills_dedup_priority(tmp_path):
    u = tmp_path / "user"
    p = tmp_path / "proj"
    _make_skill(u, "dup", description="用户版")
    _make_skill(p, "dup", description="项目版")
    skills = sk.load_skills(dirs=[("user", u), ("project", p)])
    assert len(skills) == 1
    assert skills[0].description == "项目版"
    assert skills[0].source == "project"


def test_load_skills_skips_missing_dir(tmp_path):
    skills = sk.load_skills(dirs=[("user", tmp_path / "does-not-exist")])
    assert skills == []


def test_frontmatter_fields_parsed(tmp_path):
    _make_skill(
        tmp_path, "rich",
        description="d",
        when_to_use="当需要 X 时",
        **{"user-invocable": "false", "disable-model-invocation": "true",
           "allowed-tools": "read_file, write_file", "context": "fork", "agent": "Explore"},
    )
    s = sk.load_skills(dirs=[("user", tmp_path)])[0]
    assert s.when_to_use == "当需要 X 时"
    assert s.user_invocable is False
    assert s.disable_model_invocation is True
    assert s.allowed_tools == ["read_file", "write_file"]
    assert s.context == "fork"
    assert s.agent == "Explore"


def test_render_skills_for_prompt_lists_name_and_desc():
    skills = [
        sk.Skill(name="a", description="做A", body="x", source="user", path="/x"),
        sk.Skill(name="b", description="做B", body="y", source="user", path="/y",
                 disable_model_invocation=True),
    ]
    out = sk.render_skills_for_prompt(skills)
    assert "a: 做A" in out
    assert "可用技能" in out
    # disable-model-invocation 的技能不进模型可见清单
    assert "b: 做B" not in out


def test_render_skills_for_prompt_empty():
    assert sk.render_skills_for_prompt([]) == ""


def test_render_skills_sorted_for_cache_stability():
    skills = [
        sk.Skill(name="zeta", description="z", body="", source="user", path="/z"),
        sk.Skill(name="alpha", description="a", body="", source="user", path="/a"),
    ]
    out = sk.render_skills_for_prompt(skills)
    assert out.index("alpha") < out.index("zeta")


def test_render_skills_for_prompt_keeps_all_names_when_over_budget():
    """技能一多、总长超预算：老逻辑从尾部一刀切会让排序靠后的技能整条消失（模型永远不知道它存在）。
    应改成先压缩每条描述，保证所有技能的名字都留在清单里，只是简介变短。"""
    skills = [
        sk.Skill(name=f"skill-{i:02d}", description="这是一段比较长的技能简介文字用来撑爆预算" * 3,
                 body="", source="user", path=f"/x{i}")
        for i in range(40)
    ]
    out = sk.render_skills_for_prompt(skills, budget_chars=1500)
    for s in skills:
        assert s.name in out, f"{s.name} 应该露出名字，不能因超预算被整条丢弃"


def test_render_skills_for_prompt_extreme_overflow_falls_back_to_hard_truncate():
    """就算技能多到连"每个只留个名字"都装不下的极端情况，也要有兜底（不抛异常、总长不超预算太多）。"""
    skills = [
        sk.Skill(name=f"very-long-skill-name-that-eats-budget-{i:03d}", description="d",
                 body="", source="user", path=f"/x{i}")
        for i in range(200)
    ]
    out = sk.render_skills_for_prompt(skills, budget_chars=1500)
    assert out.endswith("…")
    assert len(out) <= 1501


def test_expand_skill_substitutes_arguments():
    skills = [sk.Skill(name="greet", description="d", body="对 $ARGUMENTS 说你好", source="user", path="/x")]
    assert sk.expand_skill("greet", "老王", skills) == "对 老王 说你好"
    assert sk.expand_skill("greet", "老王", skills) != "对 $ARGUMENTS 说你好"


def test_expand_skill_braces():
    skills = [sk.Skill(name="g", description="d", body="目标=${ARGUMENTS}。", source="user", path="/x")]
    assert sk.expand_skill("g", "拉新", skills) == "目标=拉新。"


def test_expand_skill_not_found_returns_none():
    skills = [sk.Skill(name="x", description="d", body="b", source="user", path="/x")]
    assert sk.expand_skill("nope", "", skills) is None


def test_maybe_expand_slash():
    skills = [sk.Skill(name="weekly-post", description="d", body="写一周朋友圈：$ARGUMENTS", source="user", path="/x")]
    assert sk.maybe_expand_slash("/weekly-post 周末活动", skills) == "写一周朋友圈：周末活动"
    assert sk.maybe_expand_slash("/unknown x", skills) is None
    assert sk.maybe_expand_slash("普通消息不是命令", skills) is None


def test_maybe_expand_slash_respects_user_invocable():
    skills = [sk.Skill(name="hidden", description="d", body="x", source="user", path="/x", user_invocable=False)]
    assert sk.maybe_expand_slash("/hidden", skills) is None


def test_skill_tool_registered_in_default_registry():
    from services.agent.registry import default_registry
    t = default_registry.get("skill")
    assert t is not None
    # 缺口 G：技能结果是【要照做的指令】，故意 NOT read_only——
    #   ① 不被 microcompact 当"旧只读结果"清掉(指令要在执行期间一直留在上下文)；
    #   ② 超长时走 _cap_tool_result 的落盘路径而非 read_only 的硬截断(长技能正文给得全)。
    assert t.read_only is False


# ──────────────── G: 技能正经注入(指令框 + 非可截断只读) ────────────────

def test_skill_tool_frames_body_as_instructions(monkeypatch):
    """技能正文要套'照做的工作流指令'框注入，让模型清楚这是【要执行的指令】而非资料(裸 dump)。"""
    monkeypatch.setattr(sk, "expand_skill",
                        lambda name, extra="", skills=None: "步骤一：先 A。步骤二：再 B。" if name == "demo" else None)
    out = asyncio.run(sk._skill_tool({"skill": "demo"}, ctx=None))
    assert "步骤一：先 A" in out                       # 正文完整在
    assert "指令" in out                                # 有指令框
    assert out.strip() != "步骤一：先 A。步骤二：再 B。"   # 不是裸 dump
    assert out.index("指令") < out.index("步骤一")       # 框在正文前面、领着模型照做


def test_skill_tool_passes_args_through(monkeypatch):
    """args 仍照常替换进正文(框不破坏 $ARGUMENTS 展开)。"""
    captured = {}

    def _fake_expand(name, extra="", skills=None):
        captured["extra"] = extra
        return f"对 {extra} 做事"

    monkeypatch.setattr(sk, "expand_skill", _fake_expand)
    out = asyncio.run(sk._skill_tool({"skill": "demo", "args": "老王"}, ctx=None))
    assert captured["extra"] == "老王"
    assert "对 老王 做事" in out


def test_skill_tool_unknown_still_reports_missing(monkeypatch):
    """技能不存在：原样报'[技能不存在]'+可用清单，不套指令框(那不是指令)。"""
    monkeypatch.setattr(sk, "expand_skill", lambda name, extra="", skills=None: None)
    monkeypatch.setattr(sk, "load_skills", lambda *a, **k: [])
    out = asyncio.run(sk._skill_tool({"skill": "nope"}, ctx=None))
    assert "[技能不存在]" in out
    assert "指令" not in out  # 缺失提示不该被当成"要照做的指令"


def test_long_skill_result_persisted_not_hard_truncated(tmp_path, monkeypatch):
    """超长技能正文经 _cap_tool_result 必须【落盘(完整)】而非【硬截断(砍掉后半段)】。
    去掉 read_only=True 后，超长结果走 persist(给路径+预览)，read_only 的硬截断分支不再吞掉技能指令。"""
    from config import settings
    from services.agent.context import AgentContext
    from services.agent.loop import _cap_tool_result, _MAX_TOOL_RESULT_CHARS
    from services.agent.registry import default_registry
    from services.agent import tool_result_store as trs

    up = tmp_path / "uploads"
    up.mkdir()
    monkeypatch.setattr(settings, "upload_dir", str(up))

    skill_tool = default_registry.get("skill")
    long_text = "以下是要照做的工作流指令：\n" + ("照做步骤。" * (_MAX_TOOL_RESULT_CHARS + 3000))
    out = _cap_tool_result(skill_tool, long_text, AgentContext())
    assert "结果较长已截断" not in out      # 不是硬截断
    assert "<persisted-output>" in out       # 走落盘
    files = list((up / trs.TOOL_RESULTS_DIRNAME).rglob("*.txt"))
    assert files and files[0].read_text(encoding="utf-8") == long_text  # 技能正文全量落盘、一字不丢


def test_bundled_skills_present():
    # 仓库自带的内置技能（server/skills/）应被默认加载器发现。
    # 通用（非台球灰色）技能：research/spreadsheet 目录的 frontmatter name 为中文。
    names = {s.name for s in sk.load_skills()}
    assert "网络调研" in names  # server/skills/research/SKILL.md
    assert "表格分析" in names  # server/skills/spreadsheet/SKILL.md
