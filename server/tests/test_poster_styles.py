"""海报风格预设链路：风格 → 丰富提示词片段 → **真的拼进喂给模型的提示词**（证明不是死模板库）。

这条链路是用户最担心的点：前端点了风格，后端模型到底收没收到。这里用 mock 钉死：
make_poster(style=...) 时，传给 poster_service.generate_images 的 prompt/image_prompt 必须含该风格的片段。
"""
import asyncio
import types


def test_resolve_style_prompt():
    from services.agent.poster_styles import resolve_style_prompt, POSTER_STYLES
    assert resolve_style_prompt("warm") == POSTER_STYLES[0]["prompt"]      # 按 key
    assert resolve_style_prompt("温馨有爱")                                  # 按中文 label（大白话）
    assert "霓虹" in (resolve_style_prompt("年轻潮酷") or "")
    assert resolve_style_prompt("温馨有爱风") == POSTER_STYLES[0]["prompt"]  # 容错：带后缀也能认
    assert resolve_style_prompt("老板自己想的奇怪风格xyz") is None          # 认不出 → None（调用方原样拼）
    assert resolve_style_prompt("") is None


def test_make_poster_injects_style_into_model_prompt(monkeypatch):
    from services.agent import tools as agent_tools
    from services.agent.poster_styles import resolve_style_prompt
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return {"images": [{"poster_url": "http://x/p.png"}]}

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)

    ctx = types.SimpleNamespace(db=None, store=types.SimpleNamespace(id="s1"),
                                user=types.SimpleNamespace(id="u-test-1"))
    out = asyncio.run(agent_tools.make_poster(
        {"description": "周末双人优惠海报", "style": "温馨有爱"}, ctx))

    frag = resolve_style_prompt("温馨有爱")
    assert frag  # 风格片段存在
    assert frag in captured["prompt"]        # ★ 链路核心：风格片段真的拼进了喂给模型的提示词
    assert frag in captured["image_prompt"]  # image_prompt 同样带上
    assert "周末双人优惠海报" in captured["prompt"]
    assert "做好啦" in out  # 返回 markdown 图片给老板


def test_make_poster_custom_style_appended_raw(monkeypatch):
    """老板"自己说"一个不在预设里的风格 → 原样拼进提示词（不丢）。"""
    from services.agent import tools as agent_tools
    import services.poster_service as ps

    captured = {}

    async def fake_generate_images(**kwargs):
        captured.update(kwargs)
        return {"images": [{"poster_url": "http://x/p.png"}]}

    monkeypatch.setattr(ps, "generate_images", fake_generate_images)
    ctx = types.SimpleNamespace(db=None, store=types.SimpleNamespace(id="s1"),
                                user=types.SimpleNamespace(id="u-test-2"))
    asyncio.run(agent_tools.make_poster(
        {"description": "拉新海报", "style": "梵高星空那种感觉"}, ctx))

    assert "梵高星空那种感觉" in captured["prompt"]
