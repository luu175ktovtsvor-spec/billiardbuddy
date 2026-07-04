"""U1（E3a）：硬要素结构化收集 + 扩写统一校验层。

owner 2026-07-04 铁律：所有元素全让大模型发挥，我们只提供物料，不做任何程序叠层——
本文件里"程序补回"验证的是【纯文本层面】把丢失的硬文字要素拼回 prompt 字符串（最终仍是这段
文字交给模型自己画），不是 PIL/像素级图片合成，不违反该铁律（_overlay_logo 那类图片叠层依旧
是死代码，本单未复活、未调用——见 test_overlay_logo_still_dead_code）。
"""
import asyncio
import inspect
import types

import pytest


# ────────────────────────── 硬要素结构化收集 ──────────────────────────

def test_format_poster_text_includes_date_and_price():
    from services.poster_service import _format_poster_text
    out = _format_poster_text({
        "title": "抢一大战",
        "date": "7月5日 19:00",
        "price": "88元/局",
        "contact": "找李伟 15984632071",
    })
    assert "抢一大战" in out
    assert "7月5日 19:00" in out
    assert "88元/局" in out
    assert "15984632071" in out


def test_format_poster_text_still_backward_compatible_without_date_price():
    """旧调用只传 title/lines/contact（没有 date/price）→ 不崩、行为不变。"""
    from services.poster_service import _format_poster_text
    out = _format_poster_text({"title": "抢一大战", "lines": ["每天两场", "冠军500"], "contact": "15984632071"})
    assert "抢一大战" in out and "每天两场" in out and "冠军500" in out and "15984632071" in out
    assert _format_poster_text(None) == "" and _format_poster_text({}) == ""


def test_detect_missing_hard_elements_only_flags_declared_but_empty():
    from services.poster_service import detect_missing_hard_elements
    # 没提过的字段(不在 dict key 里)不算缺失——不是每张海报都要日期/价格
    assert detect_missing_hard_elements({"price": "88元"}) == []
    # 字段出现在 key 里但值为空/None → "声明了要用但没填值" → 缺失
    assert detect_missing_hard_elements({"title": "抢一大战", "price": None}) == ["price"]
    assert detect_missing_hard_elements({"price": "   "}) == ["price"]
    # 多个都缺
    assert set(detect_missing_hard_elements({"price": None, "date": ""})) == {"price", "date"}
    # 不传 / 非 dict → 空列表（向后兼容：旧调用不传也不崩、也不强加要求）
    assert detect_missing_hard_elements(None) == []
    assert detect_missing_hard_elements({}) == []
    assert detect_missing_hard_elements("not a dict") == []


def test_collect_hard_text_values_only_non_empty():
    from services.poster_service import collect_hard_text_values
    out = collect_hard_text_values({"title": "抢一大战", "date": "", "price": "88元", "contact": None})
    assert out == {"title": "抢一大战", "price": "88元"}
    assert collect_hard_text_values(None) == {}


# ────────────────────────── string-match 校验 + 兜底补回 ──────────────────────────

def test_verify_hard_elements_preserved_detects_dropped_value():
    from services.poster_service import verify_hard_elements_preserved
    hard = {"title": "抢一大战", "price": "88元/局"}
    text_ok = "一张热闹的台球厅海报，标题「抢一大战」，价格标注「88元/局」"
    text_dropped = "一张热闹的台球厅海报，主打气氛"
    assert verify_hard_elements_preserved(text_ok, hard) == []
    assert set(verify_hard_elements_preserved(text_dropped, hard)) == {"title", "price"}


def test_ensure_hard_elements_preserved_patches_back_missing():
    """程序补回是纯文本拼接（不是图片叠层）：拼回后 string-match 必须能过。"""
    from services.poster_service import ensure_hard_elements_preserved, verify_hard_elements_preserved
    hard = {"contact": "15984632071"}
    dropped = "热闹的台球厅海报"
    patched = ensure_hard_elements_preserved(dropped, hard)
    assert "15984632071" in patched
    assert verify_hard_elements_preserved(patched, hard) == []


def test_ensure_hard_elements_preserved_noop_when_nothing_missing():
    from services.poster_service import ensure_hard_elements_preserved
    hard = {"title": "抢一大战"}
    text = "标题「抢一大战」的海报"
    assert ensure_hard_elements_preserved(text, hard) == text


def test_overlay_logo_still_dead_code():
    """owner 铁律回归：_overlay_logo(PIL 像素叠层)不能被本单复活/调用。"""
    from services import poster_service
    src = inspect.getsource(poster_service.generate_images)
    assert "_overlay_logo(" not in src, "owner 铁律：不做图片程序叠层，_overlay_logo 不能被调用"


# ────────────────────────── 统一扩写层（studio /expand 用）──────────────────────────

class _FakeProvider:
    def __init__(self, content=None, raise_exc=False):
        self.content = content
        self.raise_exc = raise_exc
        self.calls = []

    async def generate(self, req):
        self.calls.append(req)
        if self.raise_exc:
            raise RuntimeError("boom")
        return types.SimpleNamespace(content=self.content)


def test_expand_keeps_llm_output_when_all_hard_elements_present():
    from services.poster_service import expand_poster_text_with_llm
    provider = _FakeProvider(content="热闹的台球厅海报，标题「抢一大战」，联系「15984632071」")
    out = asyncio.run(expand_poster_text_with_llm(provider, "做张海报", {"title": "抢一大战", "contact": "15984632071"}))
    assert "标题「抢一大战」" in out
    assert len(provider.calls) == 1


def test_expand_patches_back_when_llm_drops_hard_element():
    from services.poster_service import expand_poster_text_with_llm
    provider = _FakeProvider(content="热闹的台球厅海报，主打气氛")   # 扩写把价格丢了
    out = asyncio.run(expand_poster_text_with_llm(provider, "做张海报", {"price": "88元/局"}))
    assert "88元/局" in out
    assert len(provider.calls) == 1   # 程序补回即通过校验，不需要重扩


def test_expand_falls_back_to_raw_prompt_when_llm_raises():
    from services.poster_service import expand_poster_text_with_llm
    provider = _FakeProvider(raise_exc=True)
    out = asyncio.run(expand_poster_text_with_llm(provider, "做张海报", {"price": "88元"}))
    assert out == "做张海报"


def test_expand_falls_back_to_raw_prompt_when_llm_returns_empty():
    from services.poster_service import expand_poster_text_with_llm
    provider = _FakeProvider(content="   ")
    out = asyncio.run(expand_poster_text_with_llm(provider, "做张海报"))
    assert out == "做张海报"


def test_expand_without_poster_text_is_backward_compatible():
    """不传 poster_text(旧调用) → 不校验任何硬要素，原样返回扩写结果。"""
    from services.poster_service import expand_poster_text_with_llm
    provider = _FakeProvider(content="随便扩写的一段描述")
    out = asyncio.run(expand_poster_text_with_llm(provider, "做张海报"))
    assert out == "随便扩写的一段描述"


def test_expand_system_prompt_forbids_fabrication():
    from services.poster_service import POSTER_EXPAND_SYSTEM_PROMPT
    assert "杜撰" in POSTER_EXPAND_SYSTEM_PROMPT
    assert "原样保留" in POSTER_EXPAND_SYSTEM_PROMPT


# ────────────────────────── generate_images 单一 choke point(白盒:不起真实生图)──────────────────────────

def test_generate_images_wires_hard_element_guard():
    """两条路径(studio /generate、ReAct make_poster/generate_image)都调 generate_images，
    校验必须在这里做才能保证"两条路径都受益"，不能只在某一条路径单独查。"""
    from services import poster_service
    src = inspect.getsource(poster_service.generate_images)
    assert "ensure_hard_elements_preserved" in src, "扩写路径缺硬要素兜底校验，扩写可能悄悄丢字"
    assert "detect_missing_hard_elements" in src, "缺 missing_elements 信号回传"


# ────────────────────────── ReAct 路径：poster_text 结构化收集 + 缺就问 ──────────────────────────

def _ctx(**overrides):
    base = dict(db=None, store=types.SimpleNamespace(id="s1"), user=types.SimpleNamespace(id="u1"), allowed_paths=[])
    base.update(overrides)
    return types.SimpleNamespace(**base)


def test_make_poster_bails_when_poster_text_declares_missing_value(monkeypatch):
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    called = []

    async def fake_gen(**kwargs):
        called.append(kwargs)
        return {"images": []}

    monkeypatch.setattr(ps, "generate_images", fake_gen)
    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({
        "description": "周末活动海报", "poster_text": {"title": "老王台球", "price": None},
    }, ctx))
    assert called == [], "缺价格就该先问老板，不该直接花钱生图"
    assert "价格" in out


def test_make_poster_proceeds_when_poster_text_complete(monkeypatch):
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_gen(**kwargs):
        captured.update(kwargs)
        return {"images": [{"poster_url": "/uploads/posters/x.png"}], "count": 1}

    monkeypatch.setattr(ps, "generate_images", fake_gen)
    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({
        "description": "周末活动海报", "poster_text": {"title": "老王台球", "price": "88元/局"},
    }, ctx))
    assert "做好啦" in out
    assert captured.get("poster_text") == {"title": "老王台球", "price": "88元/局"}


def test_generate_image_poster_text_same_bail_behavior(monkeypatch):
    """generate_image 与 make_poster 行为一致：两条工具都不瞎编硬要素。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    called = []

    async def fake_gen(**kwargs):
        called.append(kwargs)
        return {"images": []}

    monkeypatch.setattr(ps, "generate_images", fake_gen)
    ctx = _ctx()
    out = asyncio.run(agent_tools.generate_image({
        "description": "画一张图", "poster_text": {"contact": ""},
    }, ctx))
    assert called == []
    assert "联系方式" in out


def test_make_poster_without_poster_text_unaffected(monkeypatch):
    """不传 poster_text(现状绝大多数调用) → 完全不受影响，行为与改动前一致。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    async def fake_gen(**kwargs):
        return {"images": [{"poster_url": "/uploads/posters/x.png"}], "count": 1}

    monkeypatch.setattr(ps, "generate_images", fake_gen)
    ctx = _ctx()
    out = asyncio.run(agent_tools.make_poster({"description": "海报"}, ctx))
    assert "做好啦" in out
