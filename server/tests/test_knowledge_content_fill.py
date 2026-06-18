"""知识选取"内容补漏"测试（根治"关键词漏配就翻不到知识"）。

- 关键词没命中、但知识【内容】里有相关词 → 仍被补进来（核心修复）。
- 关键词命中照常工作、且占满槽位时不被内容挤掉（不回归）。
"""
import services.content_service as cs


def _patch_kn(monkeypatch, key, keywords, content):
    monkeypatch.setitem(cs.KNOWLEDGE_KEYWORDS, key, keywords)
    monkeypatch.setitem(cs.prompt_engine._templates, key, {"name": "测试", "template": content})
    cs._CONTENT_BIGRAM_CACHE.pop(key, None)


def test_content_fill_catches_keyword_miss(monkeypatch):
    # 关键词只配了无关词，但内容里讲的就是短视频；intent 与内容强重叠（收紧阈值后需如此才补）
    _patch_kn(monkeypatch, "knowledge.tk_video", ["完全无关的暗号"],
              "短视频文案怎么写：前3秒钩子、颜值氛围吸粉、话题标签、拍摄建议")
    out = cs._select_knowledge_keys(["knowledge.tk_video"], "短视频文案吸粉话题标签怎么写")
    assert "knowledge.tk_video" in out  # 关键词没命中，靠内容强相关被补回来


def test_keyword_hit_still_selected(monkeypatch):
    _patch_kn(monkeypatch, "knowledge.tk_kw", ["约客", "邀约"], "约客话术内容……")
    out = cs._select_knowledge_keys(["knowledge.tk_kw"], "帮我写个约客消息")
    assert "knowledge.tk_kw" in out  # 关键词命中照常


def test_irrelevant_not_selected(monkeypatch):
    # 内容跟 intent 八竿子打不着 → 不该被补进来
    _patch_kn(monkeypatch, "knowledge.tk_far", ["薪资"], "助教薪资结构：底薪提成阶梯保底规则")
    out = cs._select_knowledge_keys(["knowledge.tk_far"], "帮我写条周末双人活动的朋友圈")
    assert "knowledge.tk_far" not in out


def test_keyword_fills_slots_blocks_content(monkeypatch):
    # 4 条关键词全命中 → 占满槽位；第 5 条只内容相关的不该挤进来（不回归）
    for i in range(4):
        _patch_kn(monkeypatch, f"knowledge.tk_h{i}", ["活动"], f"活动玩法{i}")
    _patch_kn(monkeypatch, "knowledge.tk_content", ["无关"], "周末双人活动朋友圈写法")
    keys = [f"knowledge.tk_h{i}" for i in range(4)] + ["knowledge.tk_content"]
    out = cs._select_knowledge_keys(keys, "帮我写个活动")
    # 关键词命中的 4 条占满，内容相关的第 5 条不挤掉它们
    assert sum(1 for k in out if k.startswith("knowledge.tk_h")) == 4
