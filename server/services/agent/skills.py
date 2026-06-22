"""Skills 系统 —— 对标 Claude Code 的 SKILL.md（clean-room：只复刻开放契约，不抄源码）。

技能(Skill) = 一个目录含 `SKILL.md`（YAML frontmatter + markdown 正文）。
- **渐进式披露**：每次只把"名字 + description"清单注入系统提示；正文 body 仅当被调用
  （`skill` 工具 / `/name` slash）时才展开。省 token、可无限扩展。
- **来源**（优先级 低→高，同名后者覆盖）：
    bundled（本仓 `server/skills/`，随 app 分发）→ user（`~/.claude/skills/`，吃 Claude Code 生态）
    → project（`DESKTOP_LIBRARY_DIR/skills`，门店自己的库）。
- **frontmatter 字段照 cc-haha**：name / description / when_to_use / version / user-invocable /
  disable-model-invocation / argument-hint / arguments / context(inline|fork) / agent / model /
  effort / allowed-tools / paths / shell / hooks。本期先用到 name/description/正文/调用，其余字段解析留存。
"""
from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from services.agent.registry import tool

# 解析 "---\n<yaml>\n---\n<body>"。无 frontmatter → ({}, 全文)。
_FM_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n?(.*)$", re.DOTALL)


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """拆 markdown 的 YAML frontmatter 与正文。无 frontmatter 时返回 ({}, 原文)。"""
    text = (text or "").replace("\r\n", "\n").lstrip("﻿")
    m = _FM_RE.match(text)
    if not m:
        return {}, text
    import yaml  # 项目已依赖（PromptEngine 用 YAML）
    try:
        meta = yaml.safe_load(m.group(1)) or {}
    except Exception:
        meta = {}
    if not isinstance(meta, dict):
        meta = {}
    return meta, m.group(2)


def _as_list(v: Any) -> list[str]:
    """归一成字符串列表：None→[]；list→逐项；"a, b"→["a","b"]；"a"→["a"]。"""
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    s = str(v).strip()
    if not s:
        return []
    if "," in s:
        return [x.strip() for x in s.split(",") if x.strip()]
    return [s]


def _as_bool(v: Any, default: bool = False) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return default
    return str(v).strip().lower() in ("1", "true", "yes", "on")


def _get(meta: dict, *keys: str, default: Any = None) -> Any:
    """取 frontmatter 值，兼容连字符/下划线两种写法（when_to_use / when-to-use）。"""
    for k in keys:
        if k in meta and meta[k] is not None:
            return meta[k]
    return default


@dataclass
class Skill:
    name: str
    description: str
    body: str
    source: str            # bundled | user | project
    path: str              # SKILL.md 绝对路径
    when_to_use: str = ""
    user_invocable: bool = True
    disable_model_invocation: bool = False
    argument_hint: str = ""
    context: str = "inline"  # inline | fork
    agent: str = ""          # fork 时的子代理类型
    model: str = ""
    allowed_tools: list[str] = field(default_factory=list)
    paths: list[str] = field(default_factory=list)  # 条件激活 glob（本期解析留存）
    version: str = ""

    def render_invocation(self, args: str = "") -> str:
        """展开技能正文，替换 $ARGUMENTS / ${ARGUMENTS} 占位（对标 cc-haha）。"""
        body = self.body or ""
        args = args or ""
        body = body.replace("${ARGUMENTS}", args).replace("$ARGUMENTS", args)
        return body.strip()


def _bundled_skills_dir() -> Path | None:
    """随 app 分发的内置技能目录：打包后在 sys._MEIPASS/skills，开发期在 server/skills。"""
    base = getattr(sys, "_MEIPASS", None)
    if base:
        p = Path(base) / "skills"
        if p.is_dir():
            return p
    p = Path(__file__).resolve().parent.parent.parent / "skills"  # server/skills
    return p if p.is_dir() else None


def _skill_dirs() -> list[tuple[str, Path]]:
    """技能根目录列表 (source, dir)，按优先级 低→高（后者覆盖同名）。"""
    dirs: list[tuple[str, Path]] = []
    b = _bundled_skills_dir()
    if b:
        dirs.append(("bundled", b))
    # 用户全局技能（~/.claude/skills，Claude Code 生态）——**桌面产品绝不扫**：那是开发者私有配置，
    # 会把无关的个人命令（anysearch/karpathy-coding…）塞进给非技术店主看的面板。桌面只用「内置精选 + 门店自己的库」。
    if os.environ.get("DESKTOP_LOCAL") != "1":
        dirs.append(("user", Path.home() / ".claude" / "skills"))
    # 门店自己的内容库技能（默认 ~/.billiards-desktop/library，与本地文件沙箱同根，店主可往里加）
    lib = os.environ.get("DESKTOP_LIBRARY_DIR") or str(Path.home() / ".billiards-desktop" / "library")
    dirs.append(("project", Path(lib) / "skills"))
    # 启用插件提供的技能（自动并入 → 直接出现在 / 命令面板）
    try:
        from services.agent import plugins as _plugins
        dirs.extend(_plugins.plugin_component_dirs("skills"))
    except Exception:
        pass
    return dirs


def _load_skill_dir(skill_dir: Path, source: str) -> Skill | None:
    """从一个技能目录加载 SKILL.md。无 SKILL.md / 读失败 → None。"""
    md = skill_dir / "SKILL.md"
    if not md.is_file():
        return None
    try:
        text = md.read_text(encoding="utf-8")
    except Exception:
        return None
    meta, body = parse_frontmatter(text)
    name = str(_get(meta, "name", default=skill_dir.name) or skill_dir.name).strip()
    desc = str(_get(meta, "description", default="") or "").strip()
    if not desc:
        # 没写 description：取正文首个非空行（去掉 markdown 标题井号）当描述。
        for line in body.splitlines():
            s = line.strip().lstrip("#").strip()
            if s:
                desc = s
                break
    return Skill(
        name=name,
        description=desc,
        body=body,
        source=source,
        path=str(md),
        when_to_use=str(_get(meta, "when_to_use", "when-to-use", default="") or "").strip(),
        user_invocable=_as_bool(_get(meta, "user-invocable", "user_invocable", default=True), True),
        disable_model_invocation=_as_bool(_get(meta, "disable-model-invocation", "disable_model_invocation", default=False), False),
        argument_hint=str(_get(meta, "argument-hint", "argument_hint", default="") or "").strip(),
        context=str(_get(meta, "context", default="inline") or "inline").strip(),
        agent=str(_get(meta, "agent", default="") or "").strip(),
        model=str(_get(meta, "model", default="") or "").strip(),
        allowed_tools=_as_list(_get(meta, "allowed-tools", "allowed_tools")),
        paths=_as_list(_get(meta, "paths")),
        version=str(_get(meta, "version", default="") or "").strip(),
    )


def load_skills(dirs: list[tuple[str, Path]] | None = None) -> list[Skill]:
    """扫所有来源，按 name 去重（后者/高优先覆盖），返回技能列表。

    dirs 可传 (source, Path) 列表用于测试；默认走 `_skill_dirs()`（生产）。
    每次重扫（几次文件读，开销可忽略），保证用户新装的技能立即可见。
    """
    use = dirs if dirs is not None else _skill_dirs()
    found: dict[str, Skill] = {}
    for source, root in use:
        try:
            if not Path(root).is_dir():
                continue
            for child in sorted(Path(root).iterdir()):
                if not child.is_dir():
                    continue
                sk = _load_skill_dir(child, source)
                if sk and sk.name:
                    found[sk.name] = sk
        except Exception:
            continue
    return list(found.values())


def get_skill(name: str, skills: list[Skill] | None = None) -> Skill | None:
    for s in (skills if skills is not None else load_skills()):
        if s.name == name:
            return s
    return None


def expand_skill(name: str, args: str = "", skills: list[Skill] | None = None) -> str | None:
    """按名展开技能正文（替换 $ARGUMENTS）；技能不存在 → None。"""
    s = get_skill(name, skills)
    if not s:
        return None
    return s.render_invocation(args)


_SLASH_RE = re.compile(r"^/([A-Za-z0-9_:.-]+)(?:\s+(.*))?$", re.DOTALL)


def maybe_expand_slash(message: str, skills: list[Skill] | None = None) -> str | None:
    """用户输入 '/name args'：name 是已安装且 user_invocable 的技能 → 返回展开后的正文；否则 None。

    内置 UI 命令（/help、/clear、/model 等）不在此处理（由前端拦截执行），这里只认"技能/提示词命令"。
    """
    if not message or not message.startswith("/"):
        return None
    m = _SLASH_RE.match(message.strip())
    if not m:
        return None
    name = m.group(1)
    args = (m.group(2) or "").strip()
    s = get_skill(name, skills)
    if not s or not s.user_invocable:
        return None
    return s.render_invocation(args)


def render_skills_for_prompt(skills: list[Skill] | None = None, budget_chars: int = 1500) -> str:
    """渐进式披露：把可用技能渲染成"名字 + 描述"清单，注入系统提示（不含正文）。

    - 跳过 disable-model-invocation（这些只允许用户 `/name` 手调，模型不主动调）。
    - 按 name 排序（前缀缓存稳定）；总长封顶 budget_chars。
    """
    skills = skills if skills is not None else load_skills()
    usable = sorted(
        [s for s in skills if not s.disable_model_invocation and s.description],
        key=lambda s: s.name,
    )
    if not usable:
        return ""
    lines = ["【可用技能 Skills】需要时用 skill 工具按名调用（仅在确实匹配该技能场景时调）："]
    for s in usable:
        d = s.description.replace("\n", " ").strip()[:200]
        lines.append(f"- {s.name}: {d}")
    text = "\n".join(lines)
    if len(text) > budget_chars:
        text = text[:budget_chars].rstrip() + "…"
    return text


@tool(
    name="skill",
    description=(
        "调用一个已安装的技能(Skill)：按名展开该技能预设的工作流/提示词来指导后续操作。"
        "仅在系统提示里【可用技能 Skills】清单中有匹配项、且当前任务确实属于该技能场景时才调用。"
    ),
    parameters={
        "type": "object",
        "properties": {
            "skill": {"type": "string", "description": "技能名（取自【可用技能 Skills】清单）"},
            "args": {"type": "string", "description": "传给技能的参数/上下文（可选）"},
        },
        "required": ["skill"],
    },
    read_only=True,
)
async def _skill_tool(args: dict, ctx) -> str:
    name = str(args.get("skill") or args.get("name") or "").strip()
    extra = str(args.get("args") or "").strip()
    out = expand_skill(name, extra)
    if out is None:
        avail = ", ".join(s.name for s in load_skills()) or "(当前没有已安装的技能)"
        return f"[技能不存在] {name}。可用技能：{avail}"
    return out
