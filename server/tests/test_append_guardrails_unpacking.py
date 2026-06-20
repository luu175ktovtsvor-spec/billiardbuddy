"""回归：_append_guardrails 返回 (text, names) 元组，调用方必须解包。

真机/eval 暴露的 bug：diagnosis/sop/performance/outreach/games/orchestrator 六处曾误写
`rendered_prompt = _append_guardrails(...)` 把整个元组当 prompt 传 → run_generation 的请求 content 变成
非字符串(元组/列表)→ 被严格模型(如 MiMo)400 拒，整个工具废掉。单测全 mock provider、没真机跑，一直没暴露。

本测试钉死两层防护：
- run_generation 防御性守卫：prompt 非 str 立刻 TypeError（覆盖所有调用方）。
- analyze_diagnosis 端到端：喂给 provider 的 request.prompt 必须是 str（这条直接复现并防住当时的 bug）。
"""
import asyncio
from types import SimpleNamespace

import pytest

import services.content_service as cs
import services.diagnosis_service as ds
from models.store import Store


def test_run_generation_guards_non_str_prompt():
    """守卫：任何调用方把非 str（如 _append_guardrails 的元组）当 prompt 传 → 立刻响亮 TypeError。"""
    with pytest.raises(TypeError):
        asyncio.run(cs.run_generation(db=None, store=None, user=None,
                                      prompt=("护栏后的文本", ["某知识"]), gen_type="x"))


def test_append_guardrails_returns_tuple():
    """前提锁定：_append_guardrails 确实返回 (text, names) 二元组——调用方据此必须解包。"""
    store = Store(name="测试球房", city="成都")
    out = cs._append_guardrails("基础提示", store, role="manager", intent_text="诊断 经营问题")
    assert isinstance(out, tuple) and len(out) == 2
    assert isinstance(out[0], str) and isinstance(out[1], list)


def test_diagnose_passes_str_prompt_to_provider(monkeypatch):
    """端到端：analyze_diagnosis 必须把【字符串】prompt 喂给 provider（复现并防住元组 bug）。"""
    captured = {}

    class _CapProvider:
        async def generate(self, request):
            captured["prompt"] = request.prompt
            return SimpleNamespace(content="诊断结果正文", model="mock", tokens_used=5)

    async def _noop(*a, **k):
        return None

    monkeypatch.setattr(cs, "check_quota", _noop)
    monkeypatch.setattr(cs, "increment_usage", _noop)
    monkeypatch.setattr(cs, "_validate_provider_for_production", lambda: None)
    monkeypatch.setattr(cs, "load_store_memory", _noop)
    monkeypatch.setattr(cs, "with_store_brain", lambda p, m, intent="": p)
    monkeypatch.setattr(cs, "_safe_log_generation", _noop)
    monkeypatch.setattr(cs.ProviderFactory, "get_text_provider_for_store",
                        staticmethod(lambda store: _CapProvider()))

    class _FakeDB:
        def add(self, o):
            pass

        async def commit(self):
            pass

        async def refresh(self, o):
            pass

    store = Store(name="测试球房", city="成都")
    user = SimpleNamespace(id="u1", my_role="manager")
    gen = asyncio.run(ds.analyze_diagnosis(_FakeDB(), store, user,
                                           problem_area="revenue", current_situation="生意冷清，营业额下滑"))
    # ↓ 元组 bug 会让这条直接 TypeError（守卫）或断言失败
    assert isinstance(captured["prompt"], str)
    assert len(captured["prompt"]) > 50  # 是真渲染过的诊断提示，不是空壳
    assert gen.result == "诊断结果正文"
