"""D-Task-7 台球场景方案成品(开业/会员卡/比赛)。

锁住：
- services.scene_plan.manifest：结构化 JSON 解析(容错) / 会员卡硬规则兜底 / 高度估算 / manifest 拼装（纯逻辑，无 I/O）
- services.scene_plan.render：图片版调用 _render_html_frames(monkeypatch，别真拉 Electron)；
  网页版把 manifest 内联进 template.html 存成静态文件（真文件 IO，不用 mock）
- make_scene_plan 工具：登记在 BILLIARDS_TOOL_NAMES、不 requires_approval、deliverable=True；
  LLM 生成(content_service.generate_scene_plan)与渲染均 monkeypatch，三种 plan_type 都能跑通；
  缺关键信息时把 missing_info 转成人话提示；图片版渲染失败时降级为"只给网页版"不崩
- content_service.generate_scene_plan：统一管道守卫(注入检查/配额/店脑)源码回归 + 会员卡兜底调用点回归
"""
import asyncio
import inspect
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

import services.agent.tools as agent_tools
import services.content_service as content_service
import services.scene_plan.render as scene_plan_render
from services.agent.registry import BILLIARDS_TOOL_NAMES, default_registry
from services.scene_plan.manifest import (
    PLAN_TYPE_LABELS,
    build_manifest,
    estimate_height,
    normalize_plan_type,
    parse_plan_json,
    sanitize_recharge_plan,
)
from services.scene_plan.render import TEMPLATE_HTML, render_html, render_image


# ══════════════════════════════ manifest.py（纯逻辑） ══════════════════════════════

def test_normalize_plan_type_aliases():
    assert normalize_plan_type("开业") == "opening"
    assert normalize_plan_type("新店开业") == "opening"
    assert normalize_plan_type("opening") == "opening"
    assert normalize_plan_type("会员卡") == "recharge"
    assert normalize_plan_type("充值") == "recharge"
    assert normalize_plan_type("一卡通") == "recharge"
    assert normalize_plan_type("比赛") == "tournament"
    assert normalize_plan_type("赛事") == "tournament"
    assert normalize_plan_type("  ") is None
    assert normalize_plan_type("装修方案") is None


def test_parse_plan_json_plain():
    raw = json.dumps({
        "title": "暑期开业地推方案", "goal": "开业前7天集中拓客办卡",
        "timeline": [{"time": "开业前7天", "action": "组队扫街拓客"}],
        "materials": ["单页", "办卡二维码台卡"],
        "budget": "【请补充：办卡优惠力度】",
        "notes": ["现场加微引导进群"],
        "missing_info": [],
    }, ensure_ascii=False)
    plan = parse_plan_json(raw)
    assert plan["title"] == "暑期开业地推方案"
    assert plan["timeline"] == [{"time": "开业前7天", "action": "组队扫街拓客"}]
    assert plan["materials"] == ["单页", "办卡二维码台卡"]
    assert plan["notes"] == ["现场加微引导进群"]
    assert plan["missing_info"] == []


def test_parse_plan_json_fenced_code_block():
    raw = "这是给你的方案：\n```json\n" + json.dumps({"title": "T", "goal": "G"}) + "\n```\n希望有帮助"
    plan = parse_plan_json(raw)
    assert plan["title"] == "T" and plan["goal"] == "G"
    # 未提供的字段应收敛成空列表，不是 None/缺键
    assert plan["timeline"] == [] and plan["materials"] == [] and plan["notes"] == [] and plan["missing_info"] == []


def test_parse_plan_json_extracts_from_chatter():
    raw = "好的，方案如下：\n" + json.dumps({"title": "会员卡方案", "budget": "充1000送99"}) + "\n如需调整请告诉我。"
    plan = parse_plan_json(raw)
    assert plan["title"] == "会员卡方案"
    assert plan["budget"] == "充1000送99"


def test_parse_plan_json_timeline_accepts_bare_strings():
    raw = json.dumps({"title": "T", "timeline": ["开业前3天：发朋友圈预热"]})
    plan = parse_plan_json(raw)
    assert plan["timeline"] == [{"time": "", "action": "开业前3天：发朋友圈预热"}]


def test_parse_plan_json_invalid_raises():
    with pytest.raises(ValueError):
        parse_plan_json("这次没有输出任何 JSON，纯聊天。")


def test_parse_plan_json_empty_raises():
    with pytest.raises(ValueError):
        parse_plan_json("")


# ---- 会员卡/充值方案硬规则兜底（recharge_design.yaml：不做大额赠送/赠送只抵台费） ----

def test_sanitize_recharge_plan_passthrough_when_clean():
    plan = {"title": "一卡通方案", "goal": "锁客", "budget": "充1000送99，赠送只抵台费",
            "timeline": [], "materials": [], "notes": [], "missing_info": []}
    out = sanitize_recharge_plan(plan)
    assert out == plan


def test_sanitize_recharge_plan_blocks_high_ratio_gift():
    plan = {"title": "充值方案", "goal": "冲一波", "budget": "充1000送1000感恩回馈老客",
            "timeline": [], "materials": [], "notes": [], "missing_info": []}
    out = sanitize_recharge_plan(plan)
    assert "充1000送1000" not in out["budget"]
    assert "红线" in "".join(out["notes"]) or "赠送比例" in "".join(out["notes"])
    assert any("确认" in m for m in out["missing_info"])


def test_sanitize_recharge_plan_blocks_cash_redemption_phrase():
    plan = {"title": "充值方案", "goal": "冲一波", "budget": "充值赠送可提现，随时提现到微信",
            "timeline": [], "materials": [], "notes": [], "missing_info": []}
    out = sanitize_recharge_plan(plan)
    assert "可提现" not in out["budget"]


def test_sanitize_recharge_plan_scrubs_violating_timeline_items():
    plan = {
        "title": "充值方案", "goal": "冲一波",
        "timeline": [
            {"time": "第1周", "action": "宣传充1000送1000大促"},
            {"time": "第2周", "action": "正常营业"},
        ],
        "materials": [], "notes": [], "missing_info": [],
        "budget": "见档位表",
    }
    out = sanitize_recharge_plan(plan)
    actions = [t["action"] for t in out["timeline"]]
    assert "宣传充1000送1000大促" not in actions
    assert "正常营业" in actions


# ---- 高度估算 / manifest 拼装 ----

def test_estimate_height_bounds_min_and_max():
    empty_plan = {"timeline": [], "materials": [], "notes": []}
    assert estimate_height(empty_plan) >= 1000

    huge_plan = {"timeline": [{"time": "t", "action": "a"}] * 100, "materials": ["m"] * 50, "notes": ["n"] * 50}
    assert estimate_height(huge_plan) <= 2800


def test_build_manifest_contract():
    plan = {"title": "开业方案", "goal": "打满第一批会员", "timeline": [{"time": "D-7", "action": "扫街"}],
            "materials": ["单页"], "budget": "见活动细则", "notes": ["先培训"], "missing_info": ["开业日期"]}
    manifest = build_manifest(plan, plan_type="opening", store_name="老王的球房", template_path="/x/template.html")
    assert manifest["totalFrames"] == 1
    assert manifest["template"] == "/x/template.html"
    assert isinstance(manifest["width"], int) and isinstance(manifest["height"], int)
    assert manifest["plan"]["plan_type"] == "opening"
    assert manifest["plan"]["plan_type_label"] == "开业方案"
    assert manifest["plan"]["store_name"] == "老王的球房"
    assert manifest["plan"]["title"] == "开业方案"
    assert manifest["plan"]["missing_info"] == ["开业日期"]
    assert "generated_at" in manifest["plan"]
    assert manifest["theme"]["accent"]


def test_build_manifest_unknown_plan_type_raises():
    with pytest.raises(ValueError):
        build_manifest({}, plan_type="装修", store_name="x", template_path="/x/template.html")


def test_build_manifest_height_override_respected():
    manifest = build_manifest({"timeline": [], "materials": [], "notes": []}, plan_type="recharge",
                               store_name="x", template_path="/x/template.html", height=1234)
    assert manifest["height"] == 1234


# ══════════════════════════════ render.py（图片版 monkeypatch，网页版真文件 IO） ══════════════════════════════

def test_render_image_calls_render_html_frames_and_copies_frame(monkeypatch, tmp_path):
    captured = {}

    def fake_render_html_frames(manifest_path, out_frames):
        # 临时目录(含 manifest.json)在 render_image 返回前就会被清理，得在这里读完存下来。
        captured["manifest_written"] = json.loads(Path(manifest_path).read_text(encoding="utf-8"))
        Path(out_frames).mkdir(parents=True, exist_ok=True)
        (Path(out_frames) / "f_00000.jpg").write_bytes(b"fake-jpeg-bytes")

    monkeypatch.setattr(scene_plan_render, "_render_html_frames", fake_render_html_frames)

    manifest = {"width": 1000, "height": 1200, "totalFrames": 1, "template": str(TEMPLATE_HTML), "plan": {}}
    out_path = tmp_path / "out" / "plan.jpg"
    result = render_image(manifest, str(out_path))

    assert result == str(out_path)
    assert out_path.exists()
    assert out_path.read_bytes() == b"fake-jpeg-bytes"
    # manifest 真落过盘（供子进程读），且是我们传入的那份内容
    written = captured["manifest_written"]
    assert written["totalFrames"] == 1
    assert written["template"] == str(TEMPLATE_HTML)


def test_render_image_raises_when_no_frame_produced(monkeypatch, tmp_path):
    def fake_render_html_frames(manifest_path, out_frames):
        Path(out_frames).mkdir(parents=True, exist_ok=True)  # 没写出任何帧

    monkeypatch.setattr(scene_plan_render, "_render_html_frames", fake_render_html_frames)

    manifest = {"width": 1000, "height": 1200, "totalFrames": 1, "template": str(TEMPLATE_HTML), "plan": {}}
    with pytest.raises(RuntimeError):
        render_image(manifest, str(tmp_path / "out.jpg"))


def test_render_html_produces_static_self_contained_page(tmp_path):
    manifest = build_manifest(
        {"title": "老王球房开业方案", "goal": "打满第一批会员", "timeline": [], "materials": [],
         "notes": [], "missing_info": []},
        plan_type="opening", store_name="老王的球房", template_path=str(TEMPLATE_HTML),
    )
    out_path = tmp_path / "plan.html"
    result = render_html(manifest, str(out_path))

    assert result == str(out_path)
    text = out_path.read_text(encoding="utf-8")
    assert "window.init(" in text
    assert "window.renderFrame(0)" in text
    assert "老王球房开业方案" in text  # 方案数据真内联进了页面
    assert "老王的球房" in text
    # 静态页自成一体：模板原有的 init/renderFrame 定义 + 我们追加的自举调用都在
    assert "window.init = (m) => {" in text or "window.init=(m)" in text


def test_render_html_escapes_embedded_script_close_tag(tmp_path):
    """方案文本里若恰好出现字面 "</script>"，注入的 <script> 标签不能被提前截断。"""
    manifest = build_manifest(
        {"title": "T", "goal": "G</script><script>alert(1)</script>", "timeline": [], "materials": [],
         "notes": [], "missing_info": []},
        plan_type="opening", store_name="x", template_path=str(TEMPLATE_HTML),
    )
    out_path = tmp_path / "plan.html"
    render_html(manifest, str(out_path))
    text = out_path.read_text(encoding="utf-8")
    assert "<\\/script>" in text
    assert "alert(1)</script>" not in text


# ══════════════════════════════ make_scene_plan 工具 ══════════════════════════════

def _ctx(store_name="老王的球房", role="manager"):
    return SimpleNamespace(
        db=object(),
        store=SimpleNamespace(id="s1", name=store_name),
        user=SimpleNamespace(id="u1", my_role=role),
    )


def test_make_scene_plan_registered_billiards_only_and_no_approval():
    t = default_registry.get("make_scene_plan")
    assert t is not None
    assert "make_scene_plan" in BILLIARDS_TOOL_NAMES  # 台球专属：不挂台球知识库时不暴露给模型
    assert t.requires_approval is False  # 本地成品，不对外/不花外部钱，直接做
    assert t.deliverable is True         # 成品卡：图片版+网页版链接原样展示
    assert t.read_only is False          # 写文件


_PLAN_DATA = {
    "title": "老王球房开业方案", "goal": "开业前7天打满第一批办卡会员",
    "timeline": [{"time": "开业前7天", "action": "组队扫街拓客办卡"}],
    "materials": ["单页", "办卡二维码台卡"],
    "budget": "【请补充：办卡优惠力度】",
    "notes": ["现场加微引导进群"],
    "missing_info": [],
}


def _patch_generation_and_render(monkeypatch, tmp_path, *, plan_data=None, image_ok=True):
    captured = {"render": {}}

    async def fake_generate(db, store, user, *, plan_type, requirements):
        captured["plan_type"] = plan_type
        captured["requirements"] = requirements
        return SimpleNamespace(
            result=json.dumps(plan_data if plan_data is not None else _PLAN_DATA, ensure_ascii=False),
            input_params={"knowledge_used": ["knowledge.opening"]},
        )

    def fake_render_image(manifest, out_path):
        if not image_ok:
            raise RuntimeError("模拟离屏渲染失败")
        captured["render"]["image_manifest"] = manifest
        Path(out_path).write_bytes(b"fake-jpg")
        return out_path

    def fake_render_html(manifest, out_path):
        captured["render"]["html_manifest"] = manifest
        Path(out_path).write_text("<html>fake</html>", encoding="utf-8")
        return out_path

    monkeypatch.setattr(content_service, "generate_scene_plan", fake_generate)
    monkeypatch.setattr(scene_plan_render, "render_image", fake_render_image)
    monkeypatch.setattr(scene_plan_render, "render_html", fake_render_html)

    import config
    monkeypatch.setattr(config.settings, "upload_dir", str(tmp_path))

    return captured


def test_make_scene_plan_opening_end_to_end(monkeypatch, tmp_path):
    captured = _patch_generation_and_render(monkeypatch, tmp_path)

    out = asyncio.run(agent_tools.make_scene_plan(
        {"plan_type": "开业", "requirements": "店名老王的球房，8月1号开业，预算不多"}, _ctx()))

    assert captured["plan_type"] == "opening"
    assert "8月1号开业" in captured["requirements"]
    assert "开业方案做好了" in out
    assert "老王球房开业方案" in out
    assert "![" in out and "/uploads/scene_plans/" in out  # 图片版 markdown
    assert ".html" in out  # 网页版链接
    # 渲染管道真拿到了 plan 数据（不是空壳）
    assert captured["render"]["image_manifest"]["plan"]["title"] == "老王球房开业方案"
    # 成品真落在 UPLOAD_DIR 下
    saved = list((tmp_path / "scene_plans").glob("*"))
    assert len(saved) == 2  # 一张 jpg + 一个 html


def test_make_scene_plan_recharge_alias_maps_to_recharge_type(monkeypatch, tmp_path):
    captured = _patch_generation_and_render(monkeypatch, tmp_path)
    asyncio.run(agent_tools.make_scene_plan({"plan_type": "会员卡", "requirements": "充值方案"}, _ctx()))
    assert captured["plan_type"] == "recharge"


def test_make_scene_plan_tournament_alias_maps_to_tournament_type(monkeypatch, tmp_path):
    captured = _patch_generation_and_render(monkeypatch, tmp_path)
    asyncio.run(agent_tools.make_scene_plan({"plan_type": "赛事", "requirements": "周赛"}, _ctx()))
    assert captured["plan_type"] == "tournament"


def test_make_scene_plan_unknown_type_returns_hint_without_calling_llm(monkeypatch, tmp_path):
    called = {"n": 0}

    async def fake_generate(*a, **k):
        called["n"] += 1
        raise AssertionError("不该调用 —— plan_type 没识别出来就该提前返回")

    monkeypatch.setattr(content_service, "generate_scene_plan", fake_generate)

    out = asyncio.run(agent_tools.make_scene_plan({"plan_type": "装修方案", "requirements": "随便"}, _ctx()))
    assert called["n"] == 0
    assert "装修方案" in out
    assert "开业" in out and "会员卡" in out and "比赛" in out


def test_make_scene_plan_missing_info_hint_surfaced(monkeypatch, tmp_path):
    plan_with_gap = dict(_PLAN_DATA, missing_info=["店名", "具体开业日期"])
    captured = _patch_generation_and_render(monkeypatch, tmp_path, plan_data=plan_with_gap)

    out = asyncio.run(agent_tools.make_scene_plan({"plan_type": "开业", "requirements": "想搞个开业活动"}, _ctx()))
    assert "还差点信息" in out
    assert "店名" in out and "具体开业日期" in out


def test_make_scene_plan_image_render_failure_degrades_to_html_only(monkeypatch, tmp_path):
    _patch_generation_and_render(monkeypatch, tmp_path, image_ok=False)

    out = asyncio.run(agent_tools.make_scene_plan({"plan_type": "开业", "requirements": "开业方案"}, _ctx()))
    assert "图片版这次没渲出来" in out
    assert "网页版" in out
    assert "/uploads/scene_plans/" in out


# ══════════════════════════════ content_service.generate_scene_plan（管道守卫回归） ══════════════════════════════

def test_generate_scene_plan_has_unified_pipeline_guards():
    src = inspect.getsource(content_service.generate_scene_plan)
    for guard in ["check_input_injection", "check_quota", "with_store_brain", "load_store_memory", "db.add"]:
        assert guard in src, f"generate_scene_plan 缺 {guard}"
    # 店脑须在调 AI 前注入、且是最后一次 append（近因效应，与其它手搓管道同款契约）
    assert src.index("with_store_brain") < src.index("provider.generate")


def test_generate_scene_plan_sanitizes_recharge_plans():
    src = inspect.getsource(content_service.generate_scene_plan)
    assert "sanitize_recharge_plan" in src
    assert 'plan_type == "recharge"' in src


def test_plan_type_labels_cover_all_three_scenes():
    assert set(PLAN_TYPE_LABELS) == {"opening", "recharge", "tournament"}
