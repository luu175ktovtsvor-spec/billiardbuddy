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


# 来源名永不外泄：台球行业知识库的底本 PPT《学球房运营 找台球赋能》属于第三方「台球赋能」，
# 只作项目内部行业知识底料，**绝不能出现在会注入模型的提示词/知识 YAML 或显示给用户的前端里**。
# 注入一律用中性表述"台球行业真实运营逻辑"。这道护栏钉死：未来任何编辑都不能把来源名混回去。
# 含：底本来源方(台球赋能/学球房运营/学球帮) + 桌面资料文件夹里出现的第三方机构/连锁/俱乐部名
# (唐希台球连锁、恺九/YOUME 台球俱乐部、长沙小满满)。这些是第三方机构牌子，不是通用器材产品牌——
# 乔氏/独牙/星牌 这类市场通用器材品牌**保留**，不在此列。
_FORBIDDEN_SOURCE_NAMES = [
    "台球赋能", "学球房运营", "学球帮",  # 知识底本的来源方
    "唐希", "恺九", "YOUME", "小满满",   # 资料文件夹里的第三方门店/连锁/俱乐部
]
_WEB_SRC = _ROOT / "web" / "src"


def test_source_name_never_leaks_into_prompts_or_frontend():
    """来源名只能留在仓库外底本/内部文档；提示词知识 + 前端代码里出现即失败。"""
    hits = []
    # 1) 提示词/知识 YAML（会被渲染、注入进模型上下文）
    for f in glob.glob(str(_PROMPTS / "**" / "*.yaml"), recursive=True) + \
             glob.glob(str(_PROMPTS / "**" / "*.yml"), recursive=True):
        try:
            text = Path(f).read_text("utf-8")
        except Exception:
            continue
        for name in _FORBIDDEN_SOURCE_NAMES:
            if name in text:
                hits.append((f, name))
    # 2) 前端源码（会显示给终端用户）
    if _WEB_SRC.exists():
        for f in glob.glob(str(_WEB_SRC / "**" / "*.ts"), recursive=True) + \
                 glob.glob(str(_WEB_SRC / "**" / "*.tsx"), recursive=True):
            try:
                text = Path(f).read_text("utf-8")
            except Exception:
                continue
            for name in _FORBIDDEN_SOURCE_NAMES:
                if name in text:
                    hits.append((f, name))
    assert not hits, (
        "来源名（PPT 来自第三方「台球赋能」）泄漏进提示词/知识/前端——必须改成中性"
        f"『台球行业真实运营逻辑』，绝不出现来源名：{hits}"
    )
