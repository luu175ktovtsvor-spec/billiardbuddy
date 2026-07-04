"""V2 编排逻辑补测(回验缺口):plan_to_doc 纯函数 + auto_plan_v2/apply_feedback 编排。

不联网不花钱:全程不设 ARK_API_KEY/VLM_API_KEY/ZHIPU_API_KEY,LLM/VLM 全走无 key 确定性降级分支
(director.caption_shots/plan_style、vlm.classify_content 本就设计成"没 key → 稳妥默认",不用另外 mock)。
apply_feedback 的"听懂反馈"这一步(_interpret 内部调 chat_json)才是真会打网络的地方——
直接 monkeypatch _interpret 本身,只测"分类好的 actions → 真改了 plan"这段确定性编排逻辑。

另附 services.video_edit.projects 里新加的"惰性 GC 清理过期项目目录"测试。
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

from services.video_edit import edit_agent, projects as projects_mod
from services.video_edit.assemble import auto_plan_v2, load_v2_plan, plan_to_doc, save_v2_plan
from services.video_edit.edit_agent import apply_feedback
from services.video_edit.ffbin import ffmpeg_bin

_KEY_ENVS = ("ARK_API_KEY", "VIDEO_LLM_API_KEY", "VLM_API_KEY", "ZHIPU_API_KEY")


@pytest.fixture(autouse=True)
def _no_llm_keys(monkeypatch):
    """全文件默认无 key:确保 LLM/VLM 全走确定性降级分支,不联网不花钱。"""
    for env in _KEY_ENVS:
        monkeypatch.delenv(env, raising=False)


def _synth_clip(path: Path, *, dur: int = 3, size: str = "320x568") -> None:
    """合成一段纯色测试片(不依赖真人素材、无内容变化→镜头切分必是单场景,行为确定)。

    叠了层极轻微的时域噪点(noise=alls=6:allf=t):数学上逐帧像素完全相同的合成色块,会被 E4①
    新加的 freezedetect 素材体检误判成"画面冻结/废素材"(真实摄像头素材因传感器噪声,几乎不会
    出现这种"逐帧位级相同"的极端情况——这纯粹是合成测试片才有的假象)。加点噪点更像真实素材,
    不影响"单场景/无镜头切点"这个测试本来要的确定性(scene_detect 仍判它是单场景)。
    """
    subprocess.run([
        ffmpeg_bin(), "-y",
        "-f", "lavfi", "-i", f"color=c=blue:size={size}:duration={dur}:rate=30,noise=alls=6:allf=t",
        "-f", "lavfi", "-i", f"sine=frequency=440:duration={dur}",
        "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(path),
    ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def _can_make_test_clip(tmp_path: Path) -> str | None:
    """能合成测试片就返回路径,不能(没 ffmpeg/环境异常)则 None,调用方跳过用例。"""
    try:
        p = tmp_path / "_probe_src.mp4"
        _synth_clip(p, dur=3)
        return str(p) if p.exists() else None
    except Exception:  # noqa: BLE001
        return None


# ── plan_to_doc(纯函数) ──────────────────────────────────────────────

def test_plan_to_doc_builds_valid_timeline(tmp_path):
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=3)
    plan = {
        "width": 1080, "height": 1920, "grade": "warm_cinematic",
        "shots": [
            {"src": str(src), "start": 0.0, "end": 1.0},
            {"src": str(src), "start": 1.5, "end": 2.5},
        ],
    }
    doc = plan_to_doc(plan)
    assert doc.width == 1080 and doc.height == 1920
    assert doc.grade == "warm_cinematic"
    clips = doc.video_clips_ordered()
    assert len(clips) == 2
    assert [round(c.src_in, 3) for _, c in clips] == [0.0, 1.5]
    assert [round(c.src_out, 3) for _, c in clips] == [1.0, 2.5]
    assert len(doc.media) == 1               # 同一个 src 只登记一次媒体
    assert doc.validate_doc() == []          # 施加后必须合法


def test_plan_to_doc_default_size_when_missing(tmp_path):
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=2)
    plan = {"shots": [{"src": str(src), "start": 0.0, "end": 1.0}]}   # 没给 width/height/grade
    doc = plan_to_doc(plan)
    assert (doc.width, doc.height) == (1080, 1920)                    # 缺省竖屏
    assert doc.grade is None


def test_plan_to_doc_missing_src_field_raises(tmp_path):
    """坏输入(shot 缺 src 字段):该崩就崩,别悄悄吞掉。"""
    plan = {"shots": [{"start": 0.0, "end": 1.0}]}
    with pytest.raises(KeyError):
        plan_to_doc(plan)


def test_plan_to_doc_invalid_range_raises_runtime_error(tmp_path):
    """坏输入(src_out<=src_in 非法区间):apply_operations 校验会挡,plan_to_doc 包成 RuntimeError。"""
    src = tmp_path / "src.mp4"
    _synth_clip(src, dur=2)
    plan = {"shots": [{"src": str(src), "start": 1.0, "end": 1.0}]}   # 空区间
    with pytest.raises(RuntimeError, match="plan.?doc 失败"):
        plan_to_doc(plan)


# ── auto_plan_v2(编排:氛围 Planner + 导演配文案/风格,全走无 key 降级) ──────

def test_auto_plan_v2_no_key_produces_valid_plan(tmp_path):
    src = _can_make_test_clip(tmp_path)
    if not src:
        pytest.skip("本机合不出 ffmpeg 测试片,跳过(缺 ffmpeg 或环境异常)")

    edit_dir = tmp_path / "edit"
    res = auto_plan_v2([src], str(edit_dir), ratio="9:16", target_duration=4.0)

    assert res["used_vlm"] is False           # 没配 key,老实说没走 VLM
    assert res["captions"] and all(isinstance(c, str) for c in res["captions"])
    assert res["brand"]

    plan = load_v2_plan(str(edit_dir))
    assert plan["shots"], "没挑出任何镜头"
    assert (plan["width"], plan["height"]) == (1080, 1920)
    assert plan["domain"] == "general"        # 纯色测试片肯定不是台球
    for s in plan["shots"]:
        assert s["end"] > s["start"]
        assert "style" in s and s["style"]["motion"]

    # plan 能反过来建出合法的时间轴文档(编排产物真的能渲)
    doc = plan_to_doc(plan)
    assert doc.validate_doc() == []
    assert len(doc.video_clips_ordered()) == len(plan["shots"])


def test_auto_plan_v2_bad_video_path_raises(tmp_path):
    """坏输入(视频路径不存在):探测/切片链路应该报错,不静默产出空方案糊弄人。"""
    edit_dir = tmp_path / "edit"
    with pytest.raises(Exception):
        auto_plan_v2(["/no/such/video.mp4"], str(edit_dir))


# ── apply_feedback(对话编辑:_interpret 分类出的 actions → 真改 plan) ──────

def _seed_plan(edit_dir: Path, **overrides) -> dict:
    plan = {
        "width": 1080, "height": 1920, "grade": "warm_cinematic", "ratio": "9:16",
        "brand": "精彩瞬间", "domain": "general", "scene": "",
        "music": {"mood": "auto", "key": 0},
        "theme": {"accent": "#12E0C8"}, "customCss": "",
        "shots": [
            {"src": "/a.mp4", "start": 0.0, "end": 2.0, "subject": "人物特写", "score": 9, "caption": "开场白"},
            {"src": "/a.mp4", "start": 3.0, "end": 5.0, "subject": "风景", "score": 5, "caption": "第二段"},
            {"src": "/b.mp4", "start": 0.0, "end": 2.0, "subject": "美食", "score": 7, "caption": "第三段"},
        ],
        "pool": [
            {"src": "/a.mp4", "start": 0.0, "end": 2.0, "score": 9, "subject": "人物特写", "usable": True},
            {"src": "/a.mp4", "start": 3.0, "end": 5.0, "score": 5, "subject": "风景", "usable": True},
            {"src": "/b.mp4", "start": 0.0, "end": 2.0, "score": 7, "subject": "美食", "usable": True},
            {"src": "/c.mp4", "start": 1.0, "end": 3.0, "score": 8, "subject": "宠物", "usable": True},  # 池里没被用过的
        ],
    }
    plan.update(overrides)
    Path(edit_dir).mkdir(parents=True, exist_ok=True)   # save_v2_plan 不建目录,真实流程靠 project_dir() 先建好
    save_v2_plan(str(edit_dir), plan)
    return plan


def _mock_interpret(actions: list[dict], reply: str = "改好了", monkeypatch=None):
    def fn(feedback, shots):
        return {"actions": actions, "reply": reply}
    monkeypatch.setattr(edit_agent, "_interpret", fn)


def test_apply_feedback_no_plan_returns_early(tmp_path):
    r = apply_feedback(str(tmp_path / "edit"), "随便说点啥")
    assert r["changed"] is False
    assert r["shots"] == []
    assert "生成方案" in r["reply"]


def test_apply_feedback_no_key_degrades_gracefully(tmp_path):
    """不 mock _interpret:真实链路里没 key 时 chat_json 返回 None,应优雅回退,不崩不联网。"""
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    r = apply_feedback(str(edit_dir), "第2段换掉,配乐嗨一点")
    assert r["changed"] is False
    assert len(r["shots"]) == 3               # 没听懂 → plan 原样
    assert "没太听懂" in r["reply"] or r["reply"]


def test_apply_feedback_remove_shot(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "remove_shot", "index": 2}], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "第2段删掉")
    assert r["changed"] is True
    assert len(r["shots"]) == 2
    assert [s["subject"] for s in r["shots"]] == ["人物特写", "美食"]   # "风景"(第2段)被删
    assert load_v2_plan(str(edit_dir))["shots"] == r["shots"]           # 落盘了


def test_apply_feedback_remove_shot_guards_single_shot(tmp_path, monkeypatch):
    """坏输入护栏:只剩1段时不准删(删完没法出片)。"""
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir, shots=[{"src": "/a.mp4", "start": 0.0, "end": 2.0, "subject": "独苗", "score": 9, "caption": "x"}])
    _mock_interpret([{"action": "remove_shot", "index": 1}], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "删掉")
    assert r["changed"] is False
    assert len(r["shots"]) == 1


def test_apply_feedback_replace_shot_picks_unused_candidate(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "replace_shot", "index": 1}], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "第1段换掉")
    assert r["changed"] is True
    assert r["shots"][0]["src"] == "/c.mp4"          # 候选池里唯一没被用过的
    assert r["shots"][0]["start"] == 1.0
    assert isinstance(r["shots"][0]["caption"], str) and r["shots"][0]["caption"]


def test_apply_feedback_reorder_valid_and_invalid(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "reorder", "order": [3, 1, 2]}], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "把第3段挪到最前面")
    assert r["changed"] is True
    assert [s["subject"] for s in r["shots"]] == ["美食", "人物特写", "风景"]

    # 非法排列(不是 0..n-1 的置换)→ 忽略、不崩、plan 不变
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "reorder", "order": [1, 1, 2]}], monkeypatch=monkeypatch)
    r2 = apply_feedback(str(edit_dir), "乱序")
    assert r2["changed"] is False
    assert [s["subject"] for s in r2["shots"]] == ["人物特写", "风景", "美食"]


def test_apply_feedback_shorten_and_lengthen(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "shorten"}], monkeypatch=monkeypatch)
    r = apply_feedback(str(edit_dir), "整体短一点")
    assert r["changed"] is True
    assert len(r["shots"]) == 2
    assert "风景" not in [s["subject"] for s in r["shots"]]   # 分最低的那段被砍

    _seed_plan(edit_dir)
    _mock_interpret([{"action": "lengthen"}], monkeypatch=monkeypatch)
    r2 = apply_feedback(str(edit_dir), "整体长一点")
    assert r2["changed"] is True
    assert len(r2["shots"]) == 4
    assert r2["shots"][-1]["src"] == "/c.mp4"                 # 从池里补了没用过的那条


def test_apply_feedback_grade_music_ratio_accent_caption_pos(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([
        {"action": "set_grade", "grade": "neutral_punch"},
        {"action": "set_music", "mood": "hype"},
        {"action": "set_ratio", "ratio": "16:9"},
        {"action": "set_accent", "color": "#FF00AA"},
        {"action": "set_caption_pos", "pos": "top"},
    ], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "调色中性、配乐嗨、横屏、主题色改粉、字幕放上面")
    assert r["changed"] is True
    assert r["grade"] == "neutral_punch"
    assert r["music_mood"] == "hype"
    assert r["ratio"] == "16:9"
    plan = load_v2_plan(str(edit_dir))
    assert (plan["width"], plan["height"]) == (1920, 1080)
    assert plan["theme"]["accent"] == "#FF00AA"
    assert all(s["style"]["caption"]["pos"] == "top" for s in plan["shots"])


def test_apply_feedback_invalid_enum_values_ignored(tmp_path, monkeypatch):
    """坏输入:非法枚举值(调色/配乐/比例/强调色都给不合法值)→ 全部忽略,plan 不变。"""
    edit_dir = tmp_path / "edit"
    seeded = _seed_plan(edit_dir)
    _mock_interpret([
        {"action": "set_grade", "grade": "不存在的调色"},
        {"action": "set_music", "mood": "不存在的情绪"},
        {"action": "set_ratio", "ratio": "4:3"},
        {"action": "set_accent", "color": "不是十六进制"},
    ], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "瞎改")
    assert r["changed"] is False
    plan = load_v2_plan(str(edit_dir))
    assert plan["grade"] == seeded["grade"]
    assert plan["music"]["mood"] == seeded["music"]["mood"]
    assert (plan["width"], plan["height"]) == (seeded["width"], seeded["height"])
    assert plan["theme"]["accent"] == seeded["theme"]["accent"]


def test_apply_feedback_restyle_no_key_uses_default_style(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "restyle", "mood": "炫酷快切"}], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "整体炫酷快切一点")
    assert r["changed"] is True
    plan = load_v2_plan(str(edit_dir))
    assert plan["shots"][0]["style"]["transition"] == "none"     # 第一段不入场转场
    assert plan["shots"][1]["style"]["transition"] == "wipe"     # 无 key 默认风格
    assert plan["theme"]["accent"].startswith("#")


def test_apply_feedback_recaption_no_key_uses_fallback_captions(tmp_path, monkeypatch):
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([{"action": "recaption", "tonality": "甜一点、俏皮"}], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "文案甜一点")
    assert r["changed"] is True
    assert len(r["shots"]) == 3
    assert all(isinstance(s["caption"], str) and s["caption"] for s in r["shots"])
    assert r["brand"]


def test_apply_feedback_malformed_action_does_not_crash(tmp_path, monkeypatch):
    """坏输入:action 名不认识 + 缺必填字段,都不该让整条对话链路崩。"""
    edit_dir = tmp_path / "edit"
    _seed_plan(edit_dir)
    _mock_interpret([
        {"action": "replace_shot"},              # 缺 index
        {"action": "reorder"},                   # 缺 order
        {"action": "这是个乱写的action"},
        {},                                       # 空字典
    ], monkeypatch=monkeypatch)

    r = apply_feedback(str(edit_dir), "乱说一通")
    assert r["changed"] is False
    assert len(r["shots"]) == 3   # plan 原样,没被半吊子操作弄坏


# ── projects.py 惰性 GC(mtime 超 7 天的项目目录整个删) ──────────────────

def test_gc_stale_projects_removes_old_untouched_dirs(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    edits_root = tmp_path / "edits"
    old_dir = edits_root / "old_project"
    old_dir.mkdir(parents=True)
    (old_dir / "timeline.json").write_text("{}")
    old_ts = time.time() - 8 * 86400
    os.utime(old_dir, (old_ts, old_ts))

    recent_dir = edits_root / "recent_project"
    recent_dir.mkdir(parents=True)

    projects_mod._gc_last_run = 0.0   # 绕开限频,强制真跑一次
    projects_mod._gc_stale_projects(edits_root)

    assert not old_dir.exists()
    assert recent_dir.exists()


def test_gc_stale_projects_rate_limited_skips_scan(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    edits_root = tmp_path / "edits"
    old_dir = edits_root / "old_project"
    old_dir.mkdir(parents=True)
    old_ts = time.time() - 8 * 86400
    os.utime(old_dir, (old_ts, old_ts))

    projects_mod._gc_last_run = time.time()   # 刚跑过 → 这次该被限频挡住
    projects_mod._gc_stale_projects(edits_root)
    assert old_dir.exists()


def test_gc_stale_projects_missing_root_noop(tmp_path):
    """edits/ 目录还不存在时不该抛异常(新装机器第一次用)。"""
    projects_mod._gc_last_run = 0.0
    projects_mod._gc_stale_projects(tmp_path / "no_such_edits_root")   # 不应抛异常


def test_project_dir_creates_dir_and_gc_does_not_eat_fresh_project(tmp_path, monkeypatch):
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path))
    projects_mod._gc_last_run = 0.0
    d = projects_mod.project_dir("p1")
    assert d.exists() and d.name == "p1"     # 刚建的项目 mtime 是新的,不会被同一次 GC 扫掉
