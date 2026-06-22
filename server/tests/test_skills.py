"""Skills 系统测试（对标 Claude Code SKILL.md 的加载/渐进披露/调用）。"""
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
    assert t.read_only is True


def test_bundled_skills_present():
    # 仓库自带的内置技能（server/skills/）应被默认加载器发现。
    names = {s.name for s in sk.load_skills()}
    assert "commit" in names
    assert "review" in names
