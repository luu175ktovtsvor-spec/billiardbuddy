"""今日推荐 / 行为信号 的纯逻辑单测（不依赖 DB）。
覆盖：成长阶段判定、节日提醒(含农历)、阶段推荐、补缺口、你常用(含效果好优先)、
动态tips、当日运营重点。get_behavior_snapshot 走 DB，属集成测试，不在此覆盖。"""
from collections import Counter
from datetime import datetime
from types import SimpleNamespace

from services.behavior_service import BehaviorSnapshot
from services.dashboard_service import (
    _growth_stage,
    _upcoming_festival,
    _festival_recs,
    _stage_recs,
    _gap_recs,
    _frequency_rec,
    _dynamic_tips,
    _daily_focus,
)


def _store(opening_days="", has_coaching=False, **profile_extra):
    profile = {"basic": {"opening_days": opening_days}}
    profile.update(profile_extra)
    return SimpleNamespace(operation_profile=profile, has_coaching=has_coaching)


def _snap(recent_total=0, type_counts=None, sub_type_counts=None, prompt_key_counts=None, good=None):
    return BehaviorSnapshot(
        type_counts=Counter(type_counts or {}),
        sub_type_counts=Counter(sub_type_counts or {}),
        prompt_key_counts=Counter(prompt_key_counts or {}),
        recent_prompt_keys=list((prompt_key_counts or {}).keys()),
        good_prompt_keys=set(good or []),
        recent_total=recent_total,
    )


# ─── 成长阶段 ───

def test_growth_stage_from_opening_field():
    assert _growth_stage(_store("not_opened"), 0) == "preopen"
    assert _growth_stage(_store("within_30"), 0) == "newopen"
    assert _growth_stage(_store("30_90"), 0) == "ramp"
    assert _growth_stage(_store("over_90"), 0) == "mature"


def test_growth_stage_fallback_by_usage():
    # 没填开业阶段：用量低→未知(走现状)，用量高→当成熟店
    assert _growth_stage(_store(""), 5) == ""
    assert _growth_stage(_store(""), 40) == "mature"


# ─── 节日提醒（公历 + 农历）───

def test_upcoming_festival_lunar_dragon_boat():
    # 2026 端午=6/19，6/15 距 4 天（lead 10）→ 应命中
    fest = _upcoming_festival(datetime(2026, 6, 15))
    assert fest.name == "端午节" and fest.days == 4


def test_upcoming_festival_solar_still_works():
    # 国庆 10/1 (lead 10)，9/28 距 3 天
    fest = _upcoming_festival(datetime(2026, 9, 28))
    assert fest.name == "国庆节" and fest.days == 3


def test_upcoming_festival_none_when_far():
    assert _upcoming_festival(datetime(2026, 7, 20)) is None


def test_upcoming_festival_carries_poster_theme():
    # 命中节日必须带"海报视觉主题"(深链预填生图用)，且不为空
    fest = _upcoming_festival(datetime(2026, 6, 15))
    assert fest.poster_theme and isinstance(fest.poster_theme, str)


def test_upcoming_festival_lunar_auto_computed_beyond_hardcode():
    # borax 动态算：旧硬编码只到 2027，2028 春节=1/26 仍能命中（1/20 距 6 天，lead 15）
    fest = _upcoming_festival(datetime(2028, 1, 20))
    assert fest is not None and fest.name == "春节" and fest.days == 6


# ─── 节日推荐：文案恒出 + 海报(按 Logo/二维码门控) ───

def test_festival_recs_with_assets_links_to_poster():
    store = _store("over_90")
    store.logo_url, store.qrcode_url = "logo.png", "qr.png"
    recs = _festival_recs(store, datetime(2026, 6, 15))  # 端午窗口
    ids = {r.id for r in recs}
    assert "festival" in ids  # 文案恒出
    poster = next(r for r in recs if r.id == "festival_poster")
    assert "/dashboard/posters/new" in poster.action_url


def test_festival_recs_without_assets_guides_upload():
    store = _store("over_90")
    store.logo_url, store.qrcode_url = None, None
    recs = _festival_recs(store, datetime(2026, 6, 15))
    assert "festival" in {r.id for r in recs}  # 文案仍恒出
    setup = next(r for r in recs if r.id == "festival_poster_setup")
    assert "/dashboard/store-settings" in setup.action_url


def test_festival_recs_empty_when_no_festival():
    store = _store("over_90")
    store.logo_url, store.qrcode_url = "logo.png", "qr.png"
    assert _festival_recs(store, datetime(2026, 7, 20)) == []


# ─── 阶段推荐 ───

def test_stage_recs():
    pre = _stage_recs("preopen")
    assert {r.id for r in pre} == {"stage_preopen_invite", "stage_preopen_warmup"}
    assert all(r.category == "stage" for r in pre)
    assert [r.id for r in _stage_recs("mature")] == ["stage_mature_recall"]
    assert _stage_recs("ramp") == []
    assert _stage_recs("") == []


# ─── 补缺口 / 深度 ───

def test_gap_recs_skipped_when_too_few():
    assert _gap_recs(_snap(recent_total=2, sub_type_counts={"moments": 2})) == []


def test_gap_recs_single_use_triggers_variety():
    # 只发朋友圈：应提示补群公告 + 配海报（cap 2）
    recs = _gap_recs(_snap(recent_total=4, sub_type_counts={"moments": 4}))
    ids = {r.id for r in recs}
    assert "gap_group" in ids and "gap_poster" in ids
    assert len(recs) <= 2
    assert all(r.category == "gap" for r in recs)


def test_gap_recs_saturated_stops_nagging_variety():
    # 用了 20 次还从没发群公告 → 判定有意不做，不再唠叨群公告
    recs = _gap_recs(_snap(recent_total=20, sub_type_counts={"moments": 20}))
    assert "gap_group" not in {r.id for r in recs}


def test_gap_recs_depth_activity_for_active_store():
    # 活跃(>=5)但从没做活动 → 推深度"该做活动"
    recs = _gap_recs(_snap(recent_total=8, sub_type_counts={"moments": 1},
                           prompt_key_counts={"copywriting.group_notice": 1}, type_counts={}))
    assert "gap_activity" in {r.id for r in recs}


# ─── 你常用（含效果好优先）───

def test_frequency_rec_none_when_below_threshold():
    assert _frequency_rec(_snap(prompt_key_counts={"copywriting.moments": 1})) is None


def test_frequency_rec_picks_top():
    rec = _frequency_rec(_snap(recent_total=5, prompt_key_counts={"copywriting.moments": 4, "operation.tournament": 2}))
    assert rec is not None
    assert rec.id == "frequent" and rec.category == "frequent"
    assert rec.suggested_payload["prompt_key"] == "copywriting.moments"


def test_frequency_rec_prefers_good_rated():
    # 次数：tournament(5) > moments(2)，但 moments 标过效果好 → 优先 moments
    snap = _snap(recent_total=7,
                 prompt_key_counts={"operation.tournament": 5, "copywriting.moments": 2},
                 good=["copywriting.moments"])
    rec = _frequency_rec(snap)
    assert rec.suggested_payload["prompt_key"] == "copywriting.moments"
    assert "效果好" in rec.title


# ─── 动态 tips ───

def test_dynamic_tips_empty_when_no_usage():
    assert _dynamic_tips(_snap(recent_total=0)) == []


def test_dynamic_tips_activity_gap_and_good_feedback():
    snap = _snap(recent_total=5, sub_type_counts={"moments": 4}, type_counts={},
                 prompt_key_counts={"copywriting.moments": 4}, good=["copywriting.moments"])
    tips = _dynamic_tips(snap)
    joined = " ".join(tips)
    assert "活动" in joined          # 发了朋友圈没做活动
    assert "效果好" in joined        # AI 在学你的风格


# ─── 当日运营重点（按星期 + 画像）───

def test_daily_focus_tuesday_gates_on_assistant():
    # 周二：有助教→推助教；没助教→撮合散客组局
    has = _daily_focus(_store(has_coaching=True), "Tuesday")
    assert "助教" in has[0]
    no = _daily_focus(_store(has_coaching=False), "Tuesday")
    assert "散客" in no[0] or "搭子" in no[2]


def test_daily_focus_monday():
    title, _desc, _intent = _daily_focus(_store(), "Monday")
    assert "老客" in title
