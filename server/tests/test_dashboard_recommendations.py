"""今日推荐 / 行为信号 的纯逻辑单测（不依赖 DB）。
覆盖：成长阶段判定、节日提醒(含农历)、阶段推荐、补缺口、你常用(含效果好优先)、
动态tips、当日运营重点、店情专属(店脑→推荐)、采纳上浮排序(隐式反馈)。
get_behavior_snapshot 走 DB，属集成测试，不在此覆盖。"""
from collections import Counter
from datetime import datetime
from types import SimpleNamespace

from services.behavior_service import BehaviorSnapshot
from services.memory_service import Memory
from schemas.dashboard import DashboardRecommendation
from services.dashboard_service import (
    _growth_stage,
    _upcoming_festival,
    _festival_recs,
    _stage_recs,
    _gap_recs,
    _frequency_rec,
    _dynamic_tips,
    _daily_focus,
    _memory_recs,
    _rerank_by_adoption,
)


def _store(opening_days="", has_coaching=False, **profile_extra):
    profile = {"basic": {"opening_days": opening_days}}
    profile.update(profile_extra)
    return SimpleNamespace(operation_profile=profile, has_coaching=has_coaching)


def _snap(recent_total=0, type_counts=None, sub_type_counts=None, prompt_key_counts=None, good=None, adopted=None):
    return BehaviorSnapshot(
        type_counts=Counter(type_counts or {}),
        sub_type_counts=Counter(sub_type_counts or {}),
        prompt_key_counts=Counter(prompt_key_counts or {}),
        recent_prompt_keys=list((prompt_key_counts or {}).keys()),
        good_prompt_keys=set(good or []),
        adopted_rec_ids=Counter(adopted or {}),
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


# ─── 店情专属：店脑长期记忆 → 今日推荐（A1）───

def _mem(content):
    return Memory(type="semantic", content=content)


def test_memory_recs_empty_when_no_memory():
    assert _memory_recs([]) == []


def test_memory_recs_student_store():
    # 记得"主打学生客" → 顶一条学生局建议
    recs = _memory_recs([_mem("这家店主打附近大学的学生客群")])
    assert len(recs) == 1
    assert recs[0].id == "store_student" and recs[0].category == "store"
    assert "学生" in recs[0].suggested_payload["user_intent"]


def test_memory_recs_member_store():
    recs = _memory_recs([_mem("老板很看重会员储值，主推一卡通锁客")])
    assert recs[0].id == "store_member"


def test_memory_recs_no_match_returns_empty():
    # 有记忆但不命中任何客群/打法关键词 → 不打扰
    assert _memory_recs([_mem("门店在三楼，周边有写字楼")]) == []


def test_memory_recs_only_one_even_if_multiple_match():
    # 同时命中学生+会员 → 只取最具体的第一条（不刷屏）
    recs = _memory_recs([_mem("主打学生客群，也做会员储值")])
    assert len(recs) == 1 and recs[0].id == "store_student"


# ─── 采纳上浮 / 跳过下沉：隐式反馈排序（A2）───

def _r(rid, priority="medium"):
    return DashboardRecommendation(
        id=rid, title=rid, description=rid, action_url="/x", priority=priority,
    )


def test_rerank_noop_when_no_signal():
    # 没采纳信号且用得少 → 原样不动（早期不瞎排）
    recs = [_r("a"), _r("b"), _r("c")]
    assert _rerank_by_adoption(recs, _snap(recent_total=3)) == recs


def test_rerank_adopted_floats_up_within_priority():
    # 同为 medium：b 被采纳过 → b 上浮到 a 前
    recs = [_r("a"), _r("b"), _r("c")]
    out = _rerank_by_adoption(recs, _snap(recent_total=10, adopted={"b": 3}))
    assert out[0].id == "b"


def test_rerank_keeps_priority_dominance():
    # 高优先 setup 即便从没被点，也不该被一条常被点的 medium 挤到后面
    recs = [_r("setup", "high"), _r("freq", "medium")]
    out = _rerank_by_adoption(recs, _snap(recent_total=20, adopted={"freq": 5}))
    assert out[0].id == "setup"


def test_rerank_long_skipped_sinks_within_priority():
    # 用了很久(>=12)，never_clicked 从没被点、clicked 被点过 → clicked 排前
    recs = [_r("never_clicked"), _r("clicked")]
    out = _rerank_by_adoption(recs, _snap(recent_total=15, adopted={"clicked": 1}))
    assert out[0].id == "clicked"


def test_rerank_stable_for_equal_score():
    # 同优先、都没被点、信号已激活 → 保留原始先后（稳定排序，不打乱既有规则编排）
    recs = [_r("a"), _r("b"), _r("c")]
    out = _rerank_by_adoption(recs, _snap(recent_total=10, adopted={"z": 1}))
    assert [r.id for r in out] == ["a", "b", "c"]


def test_adoption_rank_helper():
    snap = _snap(adopted={"festival": 2})
    assert snap.adoption_rank("festival") == 2
    assert snap.adoption_rank("missing") == 0


# ─── 死 action 管线清理（M13#1）：退役 action_label/action_type + generate_operation ───

def test_recommendation_schema_dropped_dead_action_fields():
    """单窗口化后前端只读 title/description/id，不点 action → action_label/action_type 是死字段，已退役。"""
    fields = set(DashboardRecommendation.model_fields)
    assert "action_label" not in fields
    assert "action_type" not in fields


def test_recommendation_schema_keeps_live_action_url_and_payload():
    """action_url + suggested_payload 不是死字段：主动出击(proactive.py)据此挑海报/喂草稿意图 → 必须保留。"""
    fields = set(DashboardRecommendation.model_fields)
    assert "action_url" in fields
    assert "suggested_payload" in fields


def test_no_retired_generate_operation_referenced():
    """退役的 generate_operation（全 server 零调用的孤儿）不再被 dashboard_service 引用。"""
    import inspect
    import services.dashboard_service as ds
    assert "generate_operation" not in inspect.getsource(ds)


# ─── /today 记忆路径（M13#2）：喂全量记忆给关键词匹配，不再每次开 app 重嵌入 ───

async def test_today_dashboard_feeds_full_memory_without_embedding(monkeypatch):
    """get_today_dashboard 直接喂全量记忆给 _memory_recs（关键词匹配），不再走语义召回：
    ① 关键词"学生"即便只在靠后的记忆里也能命中（证明喂的是全量、没被 cap 挤掉）；
    ② 全程不调嵌入器（证明省掉了每次开 app 的重嵌入）。"""
    import uuid
    import services.dashboard_service as ds
    import services.rag.embedder as emb

    # 20 条记忆，关键词"学生"只落在最后一条（旧逻辑语义 cap=15 时可能被挤掉）
    mems = [ds.Memory("semantic", f"无关杂记{i}") for i in range(19)]
    mems.append(ds.Memory("semantic", "这家店主打附近大学的学生客群"))

    async def fake_load(db, sid):
        return mems

    async def fake_stats(db, sid, a, b):
        return (0, 0, 0, 0, None)

    async def fake_snap(db, sid):
        return BehaviorSnapshot(Counter(), Counter(), Counter(), [], set(), Counter(), 0)

    async def fake_report(db, sid, now):
        return True  # 当作"日报已写"，跳过那条 rec 的 DB 查询

    async def fake_none(db, sid):
        return None

    monkeypatch.setattr(ds, "load_store_memory", fake_load)
    monkeypatch.setattr(ds, "_get_generation_stats", fake_stats)
    monkeypatch.setattr(ds, "get_behavior_snapshot", fake_snap)
    monkeypatch.setattr(ds, "_report_written_today", fake_report)
    monkeypatch.setattr(ds, "_get_last_good_generation", fake_none)
    monkeypatch.setattr(ds, "_days_since_last_activity", fake_none)
    monkeypatch.setattr(ds, "calculate_completeness", lambda store: 100)

    # 间谍：嵌入器一旦被调到就计数——dashboard 记忆路径不该再嵌入
    called = {"n": 0}
    monkeypatch.setattr(emb, "get_embedder", lambda *a, **k: called.__setitem__("n", called["n"] + 1))

    store = SimpleNamespace(id=uuid.uuid4(), operation_profile={},
                            logo_url="l.png", qrcode_url="q.png", has_coaching=False)
    resp = await ds.get_today_dashboard(db=None, store=store)

    assert any(r.category == "store" and r.id == "store_student" for r in resp.recommendations)
    assert called["n"] == 0


# ─── _days_since_last_activity 时区集成测试（不 mock，真走 SQLite 往返）───

def test_days_since_last_activity_survives_sqlite_naive_roundtrip():
    """SQLite 上 DateTime(timezone=True) 往返会丢 tzinfo（读回来是 naive），
    _days_since_last_activity 拿 aware 的 now() 去减就会 TypeError。
    这里真建一张 SQLite 表、插一条 type="activity" 的 Generation，用【新会话】重新查出来
    （确保拿到的是数据库实际吐出的裸值，不是同一 session 里还留着 tzinfo 的 Python 对象），
    再直接调该函数——不 mock，真触发过 SQLite 往返。"""
    import asyncio
    import uuid as _uuid
    from datetime import datetime, timezone
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

    import models  # noqa: F401  触发全模型注册
    from db.base import Base
    from models.user import User
    from models.store import Store
    from models.generation import Generation
    from services.dashboard_service import _days_since_last_activity

    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)

        async with Session() as db:
            u = User(id=_uuid.uuid4(), phone="1", password_hash="x", name="t")
            db.add(u)
            await db.flush()
            s = Store(id=_uuid.uuid4(), owner_id=u.id, name="店")
            db.add(s)
            await db.flush()
            db.add(Generation(
                id=_uuid.uuid4(), store_id=s.id, type="activity", is_deleted=False,
                created_at=datetime.now(timezone.utc),
            ))
            await db.commit()
            store_id = s.id

        # 新会话（新 identity map）→ 逼真触发一次真正从 DB 反序列化，而不是复用内存里还带 tzinfo 的对象。
        async with Session() as db2:
            days = await _days_since_last_activity(db2, store_id)

        assert days == 0  # 刚插入，距今不到一天

    asyncio.run(main())
