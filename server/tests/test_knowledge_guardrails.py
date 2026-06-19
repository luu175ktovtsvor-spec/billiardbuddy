"""知识库护栏（静态、零成本、不联网）：守住"看着有、实际调不对/渲染崩"这类最易复发的隐患。

- 前端每个 promptKey 都能在引擎里解析（防前端点了卡片后端 400）
- 关键词映射 + 核心知识引用的 key 都真存在（防 _select_knowledge_keys 引不存在的知识）
- 渲染类 YAML 都带 template（防 render() 期 KeyError）
"""
import glob
import re
from pathlib import Path

import pytest
import yaml

from services.ai.prompt_engine import get_prompt_engine
from services.content_service import CORE_KNOWLEDGE_KEYS, KNOWLEDGE_KEYWORDS

_ROOT = Path(__file__).resolve().parents[2]
_FRONTEND_CFG = _ROOT / "web" / "src" / "lib" / "role-workbench-config.ts"
_PROMPTS = Path(__file__).resolve().parents[1] / "prompts"


def test_every_frontend_promptkey_resolves_in_engine():
    """前端 ~70 个 promptKey 与后端引擎是两套独立维护的清单——这里钉死它们必须对得上。"""
    if not _FRONTEND_CFG.exists():
        pytest.skip("前端配置不在（纯后端环境），跳过")
    keys = set(re.findall(r'promptKey:\s*"([^"]+)"', _FRONTEND_CFG.read_text("utf-8")))
    assert keys, "没抽到任何 promptKey，正则或文件结构变了"
    eng = get_prompt_engine()._templates
    missing = sorted(k for k in keys if k not in eng)
    assert not missing, f"前端 promptKey 在引擎里找不到对应模板（用户点到会 400）：{missing}"


def test_knowledge_keyword_map_and_core_keys_all_exist():
    """_select_knowledge_keys 的关键词映射 + 恒注入的核心知识，引用的 key 必须都真存在。"""
    eng = get_prompt_engine()._templates
    miss_kw = sorted(k for k in KNOWLEDGE_KEYWORDS if k not in eng)
    miss_core = sorted(k for k in CORE_KNOWLEDGE_KEYS if k not in eng)
    assert not miss_kw, f"KNOWLEDGE_KEYWORDS 引用了不存在的知识 key：{miss_kw}"
    assert not miss_core, f"CORE_KNOWLEDGE 引用了不存在的知识 key：{miss_core}"


def test_render_class_yaml_have_template_field():
    """渲染类（knowledge/operation/copywriting/activity）缺 template 会在 render() 时 KeyError——静态拦下。"""
    bad = []
    for f in glob.glob(str(_PROMPTS / "**" / "*.yaml"), recursive=True):
        try:
            d = yaml.safe_load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(d, dict):
            continue
        cat = Path(f).parent.name
        if (cat in {"knowledge", "operation", "copywriting", "activity"}
                and "template" not in d and "templates" not in d and "examples" not in d):
            bad.append((f, d.get("key")))
    assert not bad, f"渲染类 YAML 缺 template（render 时 KeyError）：{bad}"
