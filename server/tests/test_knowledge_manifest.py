"""知识库可观测 manifest 守门测试（X-3，静态、零成本、不联网）。

把"每条 knowledge 的覆盖状况"做成机器可读 manifest（services/knowledge_manifest.py），
在这里逐项断言，让审计/新会话一键查漏。三条红线钉死：

① 无死料：每个 knowledge.* key 至少被 1 个角色的 required_knowledge 列入
   —— A-4 成果的回归守门。以后谁再加一条没人引用的知识，这里立刻变红。
   例外：L1 域目录页（key 以 _index 结尾）靠 Agent 的 look_up_knowledge 召回、
   故意不进 required_knowledge，is_dead 已豁免它们（见 knowledge_manifest.py）。
② 无孤儿关键词：KNOWLEDGE_KEYWORDS 表里每个 key 都对应真实存在的 knowledge 文件
   —— 防关键词指向已删/改名的知识，选取时静默引空。
③ 渲染类有 description：每个带 template 的 knowledge 都有 description（A-2 成果守门）
   —— description 是 Agent/语义召回挑知识的依据，缺它=这条知识"看不见名片"。

附带钉死：核心知识 key 真存在、角色 required_knowledge 无幽灵引用。
"""
import pytest

from services.knowledge_manifest import build_manifest


@pytest.fixture(scope="module")
def manifest():
    return build_manifest()


def test_manifest_has_knowledge_entries(manifest):
    """manifest 至少登记到知识——空了说明加载链路断了，后面断言才有意义。"""
    assert manifest.entries, "manifest 没登记到任何 knowledge.* 条目（加载链路异常）"
    assert manifest.role_names, "manifest 没登记到任何角色（rules.role.* 加载异常）"


def test_no_dead_knowledge(manifest):
    """① 无死料：每条 knowledge 至少被 1 个角色 required_knowledge 列入。

    这是 A-4（清死料）的回归守门——以后再出死料，这条立刻红。
    """
    dead = manifest.dead_keys
    assert not dead, (
        f"发现死料（没有任何角色把它列进 required_knowledge，永远注不进去）：{dead}。"
        "要么删掉这条知识，要么在对应角色 rules/role/*.yaml 的 required_knowledge 里登记。"
    )


def test_no_orphan_keywords(manifest):
    """② 无孤儿关键词：KNOWLEDGE_KEYWORDS 每个 key 都对应真实存在的 knowledge 文件。"""
    orphan = manifest.orphan_keyword_keys
    assert not orphan, (
        f"KNOWLEDGE_KEYWORDS 里这些 key 没有对应的 knowledge 文件（孤儿关键词，命中也引空）：{orphan}。"
        "要么补上知识文件，要么从 content_service.KNOWLEDGE_KEYWORDS 删掉这些键。"
    )


def test_render_class_knowledge_have_description(manifest):
    """③ 每个渲染类（有 template）knowledge 都有 description——A-2 成果守门。"""
    missing = manifest.render_class_without_description
    assert not missing, (
        f"这些渲染类 knowledge 缺 description（Agent/语义召回挑不到它）：{missing}。"
        "在对应 prompts/knowledge/*.yaml 补 description: 字段。"
    )


def test_core_knowledge_keys_exist(manifest):
    """核心知识（恒注入）引用的 key 必须真存在，否则每轮都引空。"""
    missing = manifest.missing_core_keys
    assert not missing, f"CORE_KNOWLEDGE_KEYS 引用了不存在的知识 key：{missing}"


def test_no_ghost_required_knowledge(manifest):
    """角色 required_knowledge 里不能引用不存在的 knowledge key（幽灵引用）。"""
    ghost = manifest.ghost_required_keys
    assert not ghost, (
        f"角色 required_knowledge 引用了不存在的 knowledge key（幽灵引用，注入时被静默丢弃）：{ghost}"
    )
