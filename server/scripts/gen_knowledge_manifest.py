"""生成知识库可观测 manifest 文档（X-3）。

读 services.knowledge_manifest.build_manifest()，渲染成
docs/台球行业真实性分支/知识manifest.md：每条 knowledge → 被哪些角色列入 →
有无 description → 有无关键词，让审计/新会话一眼看出覆盖与死角。

用法（在 server/ 下）：
    uv run python scripts/gen_knowledge_manifest.py
机器可读断言由 tests/test_knowledge_manifest.py 守门；本脚本只负责"给人看"。
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.knowledge_manifest import build_manifest  # noqa: E402

_OUT = (
    Path(__file__).resolve().parents[2]
    / "docs"
    / "台球行业真实性分支"
    / "知识manifest.md"
)


def _role_short(role_key: str) -> str:
    """rules.role.boss -> boss，给表格里挤角色用。"""
    return role_key.replace("rules.role.", "")


def render_markdown() -> str:
    m = build_manifest()
    entries = m.entries
    total = len(entries)
    dead = m.dead_keys
    orphan = m.orphan_keyword_keys
    no_desc = m.render_class_without_description

    no_kw = [e.key for e in entries if not e.has_keywords and not e.is_core]
    core_keys = [e.key for e in entries if e.is_core]

    lines: list[str] = []
    lines.append("# 知识库可观测 manifest（X-3 · 自动生成）")
    lines.append("")
    lines.append(
        "> 本文件由 `server/scripts/gen_knowledge_manifest.py` 生成，**勿手改**——"
        "改了下次重跑会被覆盖。机器可读断言由 `server/tests/test_knowledge_manifest.py` 守门（那条绿=这份表健康）。"
    )
    lines.append(f">")
    lines.append(f"> 生成日期：{date.today().isoformat()}　|　数据源：`PromptEngine` 已登记模板 + `content_service.KNOWLEDGE_KEYWORDS`。")
    lines.append("")

    # 健康汇总
    lines.append("## 一眼看健康")
    lines.append("")
    lines.append(f"- 知识总条数：**{total}**")
    lines.append(
        f"- ① 死料（没角色列入 required_knowledge）：**{len(dead)}** "
        + ("✅ 无死料" if not dead else f"❌ {dead}")
    )
    lines.append(
        f"- ② 孤儿关键词（KNOWLEDGE_KEYWORDS 指向不存在的知识）：**{len(orphan)}** "
        + ("✅ 无孤儿" if not orphan else f"❌ {orphan}")
    )
    lines.append(
        f"- ③ 渲染类缺 description：**{len(no_desc)}** "
        + ("✅ 全有 description" if not no_desc else f"❌ {no_desc}")
    )
    lines.append(
        f"- 幽灵引用（角色 required_knowledge 指向不存在的知识）：**{len(m.ghost_required_keys)}** "
        + ("✅ 无" if not m.ghost_required_keys else f"❌ {m.ghost_required_keys}")
    )
    lines.append(
        f"- 核心知识（恒注入，CORE + daily_workflow*）：**{len(core_keys)}** 条"
    )
    lines.append(
        f"- 无关键词条目（非核心，靠语义/内容召回，不算缺陷，仅供留意）：**{len(no_kw)}** 条"
    )
    lines.append("")

    # 角色清单
    lines.append("## 角色（required_knowledge 来源）")
    lines.append("")
    lines.append("| 角色 key | 显示名 | 列入知识条数 |")
    lines.append("|---|---|---|")
    role_count: dict[str, int] = {rk: 0 for rk in m.role_names}
    for e in entries:
        for rk in e.required_by_roles:
            role_count[rk] = role_count.get(rk, 0) + 1
    for rk in sorted(m.role_names):
        lines.append(f"| `{_role_short(rk)}` | {m.role_names[rk]} | {role_count.get(rk, 0)} |")
    lines.append("")

    # 主表
    lines.append("## 每条知识 → 覆盖矩阵")
    lines.append("")
    lines.append(
        "列含义：**被哪些角色列入**（required_knowledge，空=死料）｜"
        "**desc** 有无 description｜**关键词** 有无 KNOWLEDGE_KEYWORDS 命中词（核心知识标 🔒，恒注入不靠关键词）。"
    )
    lines.append("")
    lines.append("| knowledge key | 名称 | 被哪些角色列入 | desc | 关键词 |")
    lines.append("|---|---|---|---|---|")
    for e in sorted(entries, key=lambda x: x.key):
        roles = "、".join(_role_short(r) for r in e.required_by_roles) or "**❌ 无（死料）**"
        desc = "✅" if e.has_description else "❌"
        if e.is_core:
            kw = "🔒 核心恒注入"
        elif e.has_keywords:
            kw = f"✅（{len(e.keywords)} 词）"
        else:
            kw = "—（靠语义/内容）"
        name = e.name.replace("|", "丨")
        lines.append(f"| `{e.key}` | {name} | {roles} | {desc} | {kw} |")
    lines.append("")

    lines.append("## 怎么读这份表")
    lines.append("")
    lines.append("- **某条「被哪些角色列入」为空** → 死料，这条知识永远注不进任何对话。要么删、要么在角色 YAML 的 `required_knowledge` 登记。")
    lines.append("- **desc 为 ❌** → 缺 description，Agent/语义召回挑不到它（A-2 守门，渲染类必须有）。去 `prompts/knowledge/<file>.yaml` 补 `description:`。")
    lines.append("- **关键词为「—」** → 没配 KNOWLEDGE_KEYWORDS（非缺陷）。它靠语义/内容 bigram 召回；若该知识很想被精确关键词命中，可在 `content_service.KNOWLEDGE_KEYWORDS` 补词。")
    lines.append("- **🔒 核心恒注入** → CORE_KNOWLEDGE_KEYS 或 `daily_workflow*`，每轮都注，不依赖关键词。")
    lines.append("")
    return "\n".join(lines)


def main() -> None:
    md = render_markdown()
    _OUT.parent.mkdir(parents=True, exist_ok=True)
    _OUT.write_text(md, encoding="utf-8")
    print(f"written: {_OUT}")


if __name__ == "__main__":
    main()
