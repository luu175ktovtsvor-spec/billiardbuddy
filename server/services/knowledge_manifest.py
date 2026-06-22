"""知识库可观测 manifest（X-3）：把"哪条知识被谁列入 / 有无 description / 有无关键词"
编成一份机器可读的清单，给守门测试断言、给审计/新会话一眼看出覆盖与死角。

单一事实源：从 PromptEngine 已登记的模板（dev 读明文 YAML、桌面运行时读 prompts.enc，
两者结构一致）+ content_service 的 KNOWLEDGE_KEYWORDS/CORE_KNOWLEDGE_KEYS 计算。
不重复读盘、不维护第二份清单，避免漂移。

被两处消费：
- tests/test_knowledge_manifest.py：断言无死料 / 无孤儿关键词 / 渲染类都有 description。
- scripts/gen_knowledge_manifest.py：渲染成 docs/知识manifest.md。
"""
from __future__ import annotations

from dataclasses import dataclass, field

from services.ai.prompt_engine import get_prompt_engine
from services.content_service import CORE_KNOWLEDGE_KEYS, KNOWLEDGE_KEYWORDS

_ROLE_PREFIX = "rules.role."
_KNOWLEDGE_PREFIX = "knowledge."


@dataclass
class KnowledgeEntry:
    """一条 knowledge.* 在 manifest 里的全貌。"""

    key: str
    name: str
    # 这条知识被哪些角色的 required_knowledge 列入（角色 key，如 rules.role.boss）
    required_by_roles: list[str] = field(default_factory=list)
    has_description: bool = False
    # 是否有渲染模板（template 字段）——渲染类知识的判定依据
    is_render_class: bool = False
    # 命中关键词（KNOWLEDGE_KEYWORDS 里配的词），空列表=没配关键词
    keywords: list[str] = field(default_factory=list)
    is_core: bool = False  # 恒注入的核心知识（CORE_KNOWLEDGE_KEYS 或 daily_workflow*）
    # L1 域目录页（key 以 _index 结尾）：模块化重构的"域导航页"，靠 Agent 的 look_up_knowledge
    # 召回（rank_knowledge_for_topic 排全部 category=knowledge），**故意不进任何角色 required_knowledge**——
    # 它是给编排脑导航用的，不是塞进生成管道的内容。故不按 required_knowledge 判死料。
    is_index: bool = False

    @property
    def is_dead(self) -> bool:
        """死料：没有任何角色把它列进 required_knowledge、且不是靠 look_up_knowledge 召回的 L1 域目录页。

        L1 域目录页（is_index）走 look_up_knowledge 这条独立召回路径（rank_knowledge_for_topic
        排全部 category=knowledge），本就不进 required_knowledge——它可达、不是死料。
        """
        return not self.required_by_roles and not self.is_index

    @property
    def has_keywords(self) -> bool:
        return bool(self.keywords)


@dataclass
class KnowledgeManifest:
    entries: list[KnowledgeEntry]
    # KNOWLEDGE_KEYWORDS 里引用了、但没有对应 knowledge 文件的 key（孤儿关键词）
    orphan_keyword_keys: list[str]
    # CORE_KNOWLEDGE_KEYS 里引用了、但不存在的 key
    missing_core_keys: list[str]
    # 角色 required_knowledge 里引用了、但不存在的 knowledge key（幽灵引用）
    ghost_required_keys: list[str]
    # 角色 key -> 角色显示名
    role_names: dict[str, str]

    @property
    def dead_keys(self) -> list[str]:
        return [e.key for e in self.entries if e.is_dead]

    @property
    def render_class_without_description(self) -> list[str]:
        return [e.key for e in self.entries if e.is_render_class and not e.has_description]


def _is_core(key: str) -> bool:
    return key in CORE_KNOWLEDGE_KEYS or key.startswith("knowledge.daily_workflow")


def build_manifest() -> KnowledgeManifest:
    templates = get_prompt_engine()._templates

    # 1. 所有 knowledge.* key + 元信息
    knowledge_keys = sorted(k for k in templates if k.startswith(_KNOWLEDGE_PREFIX))

    # 2. 角色 -> required_knowledge
    role_required: dict[str, list[str]] = {}
    role_names: dict[str, str] = {}
    for key, data in templates.items():
        if not key.startswith(_ROLE_PREFIX):
            continue
        role_required[key] = list(data.get("required_knowledge") or [])
        role_names[key] = data.get("name") or key

    # 反向索引：knowledge key -> 列入它的角色（按角色 key 排序，稳定输出）
    required_by: dict[str, list[str]] = {k: [] for k in knowledge_keys}
    ghost: set[str] = set()
    for role_key in sorted(role_required):
        for kk in role_required[role_key]:
            if kk in required_by:
                required_by[kk].append(role_key)
            else:
                ghost.add(kk)

    entries: list[KnowledgeEntry] = []
    for kk in knowledge_keys:
        data = templates.get(kk) or {}
        entries.append(
            KnowledgeEntry(
                key=kk,
                name=data.get("name") or "",
                required_by_roles=required_by.get(kk, []),
                has_description=bool(data.get("description")),
                is_render_class="template" in data,
                keywords=list(KNOWLEDGE_KEYWORDS.get(kk, [])),
                is_core=_is_core(kk),
                is_index=kk.endswith("_index"),
            )
        )

    orphan_kw = sorted(k for k in KNOWLEDGE_KEYWORDS if k not in templates)
    missing_core = sorted(k for k in CORE_KNOWLEDGE_KEYS if k not in templates)

    return KnowledgeManifest(
        entries=entries,
        orphan_keyword_keys=orphan_kw,
        missing_core_keys=missing_core,
        ghost_required_keys=sorted(ghost),
        role_names=role_names,
    )
