"""C.2 导航式取知识：read_knowledge 读整篇 + render_knowledge_bodies 容错/key处理/护栏。"""
import asyncio
from types import SimpleNamespace


def test_render_knowledge_bodies_logic(monkeypatch):
    import services.content_service as cs

    def fake_render(key, store, extra, lenient=False):
        if "bad" in key:
            raise cs.PromptTemplateNotFoundError(key)
        return f"正文-of-{key}"

    monkeypatch.setattr(cs.prompt_engine, "render", fake_render)
    monkeypatch.setattr(cs, "_all_knowledge_keys", lambda: ["knowledge.a", "knowledge.b"])

    out = cs.render_knowledge_bodies(["knowledge.a"], store=None)
    assert "正文-of-knowledge.a" in out and "【knowledge.a】" in out      # 读到整篇正文

    out2 = cs.render_knowledge_bodies(["a"], store=None)
    assert "正文-of-knowledge.a" in out2                                 # 短 key 容错补 knowledge. 前缀

    out3 = cs.render_knowledge_bodies(["knowledge.bad"], store=None)
    assert "没找到" in out3                                              # 坏 key 友好提示、不抛

    assert "look_up_knowledge" in cs.render_knowledge_bodies([], store=None)  # 空 → 指回查目录


def test_read_knowledge_tool_caps_two(monkeypatch):
    import services.agent.tools as t
    captured = {}
    monkeypatch.setattr(t, "render_knowledge_bodies",
                        lambda keys, store: captured.update({"keys": keys}) or "ok")
    asyncio.run(t.read_knowledge({"keys": ["a", "b", "c", "d"]}, ctx=SimpleNamespace(store=None)))
    assert captured["keys"] == ["a", "b"]                                # 一次最多读 2 条(护 token)


def test_read_knowledge_no_keys():
    import services.agent.tools as t
    out = asyncio.run(t.read_knowledge({"keys": []}, ctx=SimpleNamespace(store=None)))
    assert "look_up_knowledge" in out                                    # 没给 key → 指引先查目录


def test_read_knowledge_registered_billiards_only():
    from services.agent.registry import BILLIARDS_TOOL_NAMES, general_registry, billiards_registry
    assert "read_knowledge" in BILLIARDS_TOOL_NAMES
    assert "read_knowledge" not in general_registry().names()           # 通用模式不挂
    assert "read_knowledge" in billiards_registry().names()             # @台球 时才挂
