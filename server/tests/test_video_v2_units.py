"""V2 视频新模块纯函数单测(不联网/不花钱)——补审查点 17"0 测试"缺口。

无 ARK key 时 caption_shots/plan_style/classify_content 走降级分支,正好可测其确定性行为。
"""
from __future__ import annotations

import wave

import pytest

from services.video_edit import bgm, billiards_video_kb
from services.video_edit import director as director_mod
from services.video_edit.director import _fallback, caption_shots, group_narrative, plan_style
from services.video_edit.edit_agent import _domain_ctx, _pick_replacement
from services.video_edit.planners.speech import _pick_by_order, _pick_speech_segments, _score_segments_llm
from services.video_edit.vlm import _norm_score, classify_content, score_frames_grid


def test_bgm_synth_writes_valid_wav(tmp_path):
    out = str(tmp_path / "b.wav")
    bgm.synth_beat_bgm(2.0, out, mood="hype", key=5)
    with wave.open(out) as w:
        assert w.getframerate() == bgm.SR
        assert w.getnframes() > 0


def test_beat_for_mood():
    assert bgm.beat_for_mood("chill") > bgm.beat_for_mood("hype")   # 慢拍长 > 快拍长
    assert bgm.beat_for_mood("不存在") == bgm.beat_for_mood("auto")   # 未知回退 auto


def test_bgm_key_out_of_range_ok(tmp_path):
    # key 会 %12,越界不崩
    bgm.synth_beat_bgm(0.5, str(tmp_path / "k.wav"), key=99)


def test_director_fallback_no_key():
    shots = [{"subject": "人物特写"}, {"subject": "未知"}]
    r = _fallback(shots, 2)
    assert len(r["captions"]) == 2 and r["brand"]


def test_caption_shots_no_key_uses_fallback(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_LLM_API_KEY", raising=False)
    monkeypatch.delenv("VLM_API_KEY", raising=False)
    r = caption_shots([{"subject": "美食"}, {"subject": "风景"}])
    assert len(r["captions"]) == 2


def test_plan_style_no_key_defaults(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("VIDEO_LLM_API_KEY", raising=False)
    monkeypatch.delenv("VLM_API_KEY", raising=False)
    r = plan_style([{"subject": "x"}, {"subject": "y"}])
    assert len(r["shots_style"]) == 2
    assert r["shots_style"][0]["transition"] == "none"     # 第一段不入场转场
    assert r["theme"]["accent"].startswith("#")
    assert r["music"]["mood"] in ("chill", "hype", "auto", "none")


def test_classify_content_no_key(monkeypatch):
    monkeypatch.delenv("ARK_API_KEY", raising=False)
    monkeypatch.delenv("VLM_API_KEY", raising=False)
    monkeypatch.delenv("ZHIPU_API_KEY", raising=False)
    r = classify_content(["/nonexistent.jpg"])
    assert r == {"is_billiards": False, "scene": "通用"}


def test_billiards_kb_guidance():
    for scene in ("门店环境", "助教展示", "人气氛围", "口播讲解"):
        assert "台球" in billiards_video_kb.caption_guidance(scene) or "球房" in billiards_video_kb.caption_guidance(scene)
        assert billiards_video_kb.style_guidance(scene)
        assert billiards_video_kb.music_hint(scene)["mood"] in ("chill", "hype", "auto", "none")
    # 无来源名铁律:不出现机构/来源名
    for scene in billiards_video_kb.scene_list():
        blob = billiards_video_kb.caption_guidance(scene) + billiards_video_kb.style_guidance(scene)
        assert "付能" not in blob and "学球" not in blob


def test_edit_agent_pick_replacement():
    plan = {"pool": [
        {"src": "/a.mp4", "start": 0.0, "end": 2.0, "score": 9, "usable": True},
        {"src": "/a.mp4", "start": 5.0, "end": 7.0, "score": 3, "usable": True},
    ]}
    used = {("/a.mp4", 0.0)}
    rep = _pick_replacement(plan, used)
    assert rep["start"] == 5.0                              # 已用的0.0排除,挑没用过的


def test_edit_agent_domain_ctx():
    assert _domain_ctx({"domain": "general"}, "caption") is None
    ctx = _domain_ctx({"domain": "billiards", "scene": "助教展示"}, "caption")
    assert ctx and ("助教" in ctx or "台球" in ctx)


@pytest.mark.parametrize("mood", ["chill", "hype", "auto"])
def test_bgm_all_moods(tmp_path, mood):
    bgm.synth_beat_bgm(1.0, str(tmp_path / f"{mood}.wav"), mood=mood)


# ── E5③ VLM 理解层元数据升级:_norm_score 透传景别/运镜/情绪,缺失给安全默认 ──

def test_norm_score_passes_through_new_narrative_fields():
    data = {"subject": "人物特写", "quality": 8, "usable": True, "reason": "清晰",
            "shot_size": "特写", "camera_move": "推", "mood": "欢快"}
    r = _norm_score(data)
    assert r["shot_size"] == "特写"
    assert r["camera_move"] == "推"
    assert r["mood"] == "欢快"


def test_norm_score_defaults_when_narrative_fields_missing():
    """VLM 没答 shot_size/camera_move/mood(旧回复/漏答)→ 安全默认,不报错不缺键。"""
    r = _norm_score({"subject": "风景", "quality": 6, "usable": True, "reason": "还行"})
    assert r["shot_size"] == "未知"
    assert r["camera_move"] == "固定"
    assert r["mood"] == "平静"


def test_norm_score_defaults_when_narrative_fields_blank():
    r = _norm_score({"subject": "风景", "shot_size": "", "camera_move": None, "mood": "  "})
    assert r["shot_size"] == "未知"
    assert r["camera_move"] == "固定"
    assert r["mood"] == "平静"


def test_score_frames_grid_fallback_item_carries_narrative_defaults(tmp_path, monkeypatch):
    """网格打分里某一张漏评(VLM 数组少给了几项)→ 兜底项也要带 shot_size/camera_move/mood 默认值,
    不能让 E5②分组消费时缺键 KeyError。"""
    from PIL import Image

    import services.video_edit.vlm as vlm_mod
    # _GATEWAY_URL/_GATEWAY_TOKEN 是模块导入时就算好的常量,setenv 不会回填——直接顶掉解析函数。
    monkeypatch.setattr(vlm_mod, "_resolve_endpoint", lambda: ("http://fake-gw/gw/v1", "faketoken"))

    imgs = []
    for name in ("a.jpg", "b.jpg"):
        p = tmp_path / name
        Image.new("RGB", (16, 16), (10, 20, 30)).save(p)
        imgs.append(str(p))

    # 只回第 1 张的评分,第 2 张漏评 → 走 by_idx.get(2) 落空的兜底分支
    monkeypatch.setattr(vlm_mod, "_post_with_retry",
                         lambda *a, **k: '[{"index":1,"subject":"人物","quality":7,"usable":true,"reason":"好",'
                                         '"shot_size":"近景","camera_move":"移","mood":"温馨"}]')
    out = score_frames_grid(imgs)
    assert out is not None and len(out) == 2
    assert out[0]["shot_size"] == "近景"
    assert out[1]["shot_size"] == "未知" and out[1]["camera_move"] == "固定" and out[1]["mood"] == "平静"


# ── E5① 口播线内容化挑段:LLM 打分挑段(钩子/价值/完整性)+ 确定性兜底 ──

_SEGS = [
    ("m1", 0.0, 3.0, "废话开场白"),
    ("m1", 3.0, 5.0, "全场五折优惠今天最后一天"),
    ("m1", 5.0, 8.0, "谢谢观看拜拜"),
]


def test_score_segments_llm_returns_none_on_malformed_reply(monkeypatch):
    monkeypatch.setattr(director_mod, "chat_json", lambda *a, **k: {"not_scores": []})
    assert _score_segments_llm(_SEGS) is None


def test_score_segments_llm_returns_none_when_chat_json_unavailable(monkeypatch):
    monkeypatch.setattr(director_mod, "chat_json", lambda *a, **k: None)
    assert _score_segments_llm(_SEGS) is None


def test_pick_speech_segments_falls_back_to_order_when_llm_unavailable(monkeypatch):
    """chat_json 挂了(网关不可用等)→ 必须回退到升级前的"顺序取够时长就停",不能崩不能返空。"""
    monkeypatch.setattr(director_mod, "chat_json", lambda *a, **k: None)
    assert _pick_speech_segments(_SEGS, 3.0) == _pick_by_order(_SEGS, 3.0)
    assert _pick_by_order(_SEGS, 3.0) == [_SEGS[0]]   # 旧算法在 target=3.0 时只够选中第0段


def test_pick_speech_segments_prefers_high_scored_segment_over_chronological_order(monkeypatch):
    """target=3.0 时,"顺序取"旧算法只会选中第0段(废话开场白)——第1段(真正值钱的优惠信息)
    根本轮不到。内容化挑段应该按钩子/价值/完整性打分挑出第1段,证明真的按内容选,不是纯顺序。"""
    def fake_chat_json(prompt, **kw):
        return {"scores": [
            {"index": 0, "hook": 2, "value": 2, "completeness": 2},
            {"index": 1, "hook": 9, "value": 9, "completeness": 9},
            {"index": 2, "hook": 1, "value": 1, "completeness": 3},
        ]}
    monkeypatch.setattr(director_mod, "chat_json", fake_chat_json)

    picked = _pick_speech_segments(_SEGS, target_duration=3.0)
    picked_texts = [t for (_m, _a, _b, t) in picked]

    assert "全场五折优惠今天最后一天" in picked_texts          # 高分段被挑中
    # 整句不切:挑中的每句话必须跟原句完全一致(不是被截断的子串)
    all_texts = {t for (_m, _a, _b, t) in _SEGS}
    assert all(t in all_texts for t in picked_texts)
    # 开头优先强钩子段:hook 分最高的(第1段)排在最前面
    assert picked[0][3] == "全场五折优惠今天最后一天"


def test_pick_speech_segments_falls_back_when_llm_picks_nothing(monkeypatch):
    """LLM 把所有段都打 0 分(挑空)——保底至少留一段,不能让口播线出空片。"""
    monkeypatch.setattr(director_mod, "chat_json", lambda *a, **k: {"scores": [
        {"index": 0, "hook": 0, "value": 0, "completeness": 0},
        {"index": 1, "hook": 0, "value": 0, "completeness": 0},
        {"index": 2, "hook": 0, "value": 0, "completeness": 0},
    ]})
    picked = _pick_speech_segments(_SEGS, target_duration=3.0)
    assert len(picked) >= 1


# ── E5② 氛围线叙事分组:director.group_narrative(hook→core→vibe→end,禁 A→B→A 横跳) ──

_SHOTS = [
    {"media": "m1", "subject": "门店招牌", "shot_size": "远景", "camera_move": "固定", "mood": "平静"},
    {"media": "m2", "subject": "助教特写", "shot_size": "特写", "camera_move": "推", "mood": "欢快"},
    {"media": "m1", "subject": "球台氛围", "shot_size": "中景", "camera_move": "摇", "mood": "温馨"},
]


def test_group_narrative_none_when_no_endpoint(monkeypatch):
    """没配网关/dev key → 直接 None,不发请求(跟 plan_style 同款"没 key 就别折腾"逻辑)。"""
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: None)
    assert group_narrative(_SHOTS) is None


def test_group_narrative_none_for_fewer_than_two_shots(monkeypatch):
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    assert group_narrative([_SHOTS[0]]) is None
    assert group_narrative([]) is None


def test_group_narrative_returns_order_and_roles_on_valid_reply(monkeypatch):
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    monkeypatch.setattr(director_mod, "chat_json",
                         lambda *a, **k: {"order": [1, 0, 2], "roles": ["hook", "core", "end"]})
    r = group_narrative(_SHOTS)
    assert r == {"order": [1, 0, 2], "roles": ["hook", "core", "end"]}


def test_group_narrative_falls_back_to_none_when_llm_unavailable(monkeypatch):
    """chat_json 失败(网关挂了)返回 None → group_narrative 也是 None,调用方保持原时序。"""
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    monkeypatch.setattr(director_mod, "chat_json", lambda *a, **k: None)
    assert group_narrative(_SHOTS) is None


def test_group_narrative_rejects_invalid_permutation(monkeypatch):
    """order 不是合法全排列(重复/越界)→ 拒绝,回退 None(别把乱序的方案当真)。"""
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    monkeypatch.setattr(director_mod, "chat_json",
                         lambda *a, **k: {"order": [0, 0, 2], "roles": ["hook", "core", "end"]})
    assert group_narrative(_SHOTS) is None


def test_group_narrative_rejects_aba_zigzag(monkeypatch):
    """同来源镜头(m1)被 m2 隔开又切回来(m1→m2→m1)= A→B→A 场景横跳,应该被拒绝回退 None。"""
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    # _SHOTS 顺序是 [m1, m2, m1];order=[0,1,2] 原样保留就是 m1→m2→m1 的横跳
    monkeypatch.setattr(director_mod, "chat_json",
                         lambda *a, **k: {"order": [0, 1, 2], "roles": ["hook", "core", "end"]})
    assert group_narrative(_SHOTS) is None


def test_group_narrative_accepts_reorder_that_avoids_zigzag(monkeypatch):
    """把同来源(m1)的两个镜头排到一起(不被 m2 隔开又切回)就不算横跳,应该正常返回。"""
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    # order=[0,2,1]:m1→m1→m2,同来源相邻,没有"切走又切回"的横跳
    monkeypatch.setattr(director_mod, "chat_json",
                         lambda *a, **k: {"order": [0, 2, 1], "roles": ["hook", "vibe", "end"]})
    r = group_narrative(_SHOTS)
    assert r == {"order": [0, 2, 1], "roles": ["hook", "vibe", "end"]}


def test_group_narrative_unknown_role_value_normalizes_to_core(monkeypatch):
    """LLM 给了词表外的角色词 → 归一成 core,不让脏数据流下去(order 用不横跳的排列,单独验证角色归一)。"""
    monkeypatch.setattr(director_mod, "_resolve_endpoint", lambda: ("http://fake", "tok"))
    monkeypatch.setattr(director_mod, "chat_json",
                         lambda *a, **k: {"order": [0, 2, 1], "roles": ["hook", "不认识的角色", "end"]})
    r = group_narrative(_SHOTS)
    assert r["roles"] == ["hook", "core", "end"]
