"""定时任务(Scheduled Tasks)测试：_compute_next_run 纯函数 / due_tasks 到点判定 /
catch_up_on_startup 补跑 / 无人值守安全工具集锁死 / 执行器故障安全 / 工具入参 / 建表。

D-Task-3：对标 Claude Code Scheduled Tasks——配指令+定时规则,到点自动跑一遍 agent 任务、
干完写结果+播报。安全红线：无人值守没人点审批卡,执行时固定用裁剪过的安全工具集
(_scheduled_safe_registry)——绝不自动发布/群发/删数据/跑命令/操作电脑。
"""
import asyncio
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册(含 ScheduledTask)
from core.timezone import BUSINESS_TZ
from db.base import Base
from models.scheduled_task import ScheduledTask
from models.store import Store
from models.user import User
from services import notify_service
from services.agent import scheduled_tasks as sc


def _local(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=BUSINESS_TZ)


# ══════════════════════════ 1. _compute_next_run 纯函数 ══════════════════════════

class TestComputeNextRunDaily:
    def test_future_time_today_stays_today(self):
        base = _local(2026, 3, 10, 7, 0)
        nxt = sc._compute_next_run("daily", {"hour": 8, "minute": 0}, base).astimezone(BUSINESS_TZ)
        assert (nxt.year, nxt.month, nxt.day, nxt.hour, nxt.minute) == (2026, 3, 10, 8, 0)

    def test_already_passed_rolls_to_tomorrow(self):
        base = _local(2026, 3, 10, 9, 0)
        nxt = sc._compute_next_run("daily", {"hour": 8, "minute": 0}, base).astimezone(BUSINESS_TZ)
        assert (nxt.year, nxt.month, nxt.day, nxt.hour, nxt.minute) == (2026, 3, 11, 8, 0)

    def test_exact_boundary_rolls_to_tomorrow(self):
        """候选时间等于当前时间(已经在跑了)→ 不能原地不动,必须推到下一次。"""
        base = _local(2026, 3, 10, 8, 0)
        nxt = sc._compute_next_run("daily", {"hour": 8, "minute": 0}, base).astimezone(BUSINESS_TZ)
        assert (nxt.year, nxt.month, nxt.day) == (2026, 3, 11)

    def test_month_boundary(self):
        """跨月边界(2026-01-31 -> 02-01)不出错。"""
        base = _local(2026, 1, 31, 20, 0)
        nxt = sc._compute_next_run("daily", {"hour": 8, "minute": 0}, base).astimezone(BUSINESS_TZ)
        assert (nxt.year, nxt.month, nxt.day) == (2026, 2, 1)


class TestComputeNextRunWeekly:
    def test_future_this_week_stays_same_week(self):
        base = _local(2026, 3, 9, 7, 0)
        target_weekday = (base.weekday() + 2) % 7  # 未来某天(2天后那个 weekday)
        nxt = sc._compute_next_run(
            "weekly", {"weekday": target_weekday, "hour": 9, "minute": 30}, base
        ).astimezone(BUSINESS_TZ)
        assert nxt.weekday() == target_weekday
        assert nxt.date() == (base + timedelta(days=2)).date()
        assert (nxt.hour, nxt.minute) == (9, 30)

    def test_same_weekday_time_already_passed_rolls_next_week(self):
        base = _local(2026, 3, 9, 10, 0)
        nxt = sc._compute_next_run(
            "weekly", {"weekday": base.weekday(), "hour": 9, "minute": 0}, base
        ).astimezone(BUSINESS_TZ)
        assert nxt.date() == (base + timedelta(days=7)).date()

    def test_same_weekday_time_not_yet_passed_stays_today(self):
        base = _local(2026, 3, 9, 7, 0)
        nxt = sc._compute_next_run(
            "weekly", {"weekday": base.weekday(), "hour": 9, "minute": 0}, base
        ).astimezone(BUSINESS_TZ)
        assert nxt.date() == base.date()

    def test_cross_week_boundary(self):
        """周日跑，目标周一，要跨到下周一（不是当天算出负偏移）。"""
        # 找一个周日
        base = _local(2026, 3, 8, 7, 0)
        while base.weekday() != 6:
            base += timedelta(days=1)
        nxt = sc._compute_next_run("weekly", {"weekday": 0, "hour": 8, "minute": 0}, base).astimezone(BUSINESS_TZ)
        assert nxt.weekday() == 0
        assert (nxt.date() - base.date()).days == 1


class TestComputeNextRunInterval:
    def test_adds_minutes(self):
        base = datetime(2026, 3, 10, 7, 0, tzinfo=timezone.utc)
        nxt = sc._compute_next_run("interval", {"minutes": 30}, base)
        assert nxt == base + timedelta(minutes=30)

    def test_zero_or_negative_minutes_falls_back_to_60(self):
        base = datetime(2026, 3, 10, 7, 0, tzinfo=timezone.utc)
        assert sc._compute_next_run("interval", {"minutes": 0}, base) == base + timedelta(minutes=60)
        assert sc._compute_next_run("interval", {"minutes": -5}, base) == base + timedelta(minutes=60)


class TestComputeNextRunEdgeCases:
    def test_unknown_kind_raises(self):
        with pytest.raises(ValueError):
            sc._compute_next_run("monthly", {}, datetime.now(timezone.utc))

    def test_naive_from_time_treated_as_utc(self):
        naive = datetime(2026, 1, 1, 0, 0)  # 无 tzinfo
        nxt = sc._compute_next_run("interval", {"minutes": 10}, naive)
        assert nxt == datetime(2026, 1, 1, 0, 10, tzinfo=timezone.utc)

    def test_defaults_when_spec_missing_or_bad(self):
        # spec 为 None / 字段缺失 / 非法值都不该崩，走兜底
        assert sc._compute_next_run("daily", None) is not None
        assert sc._compute_next_run("daily", {"hour": "x", "minute": "y"}) is not None


class TestAsAwareUtc:
    def test_naive_treated_as_utc(self):
        naive = datetime(2026, 1, 1, 0, 0)
        aware = sc._as_aware_utc(naive)
        assert aware == datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)

    def test_aware_converted_to_utc(self):
        local = datetime(2026, 1, 1, 8, 0, tzinfo=BUSINESS_TZ)  # 北京 8点 = UTC 0点
        aware = sc._as_aware_utc(local)
        assert aware == datetime(2026, 1, 1, 0, 0, tzinfo=timezone.utc)


# ══════════════════════════ 2. DB 相关：due_tasks / catch_up / 执行器 ══════════════════════════

async def _make_db():
    eng = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with eng.begin() as c:
        await c.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(eng, expire_on_commit=False)
    return eng, Session


async def _seed_store(db) -> Store:
    u = User(id=uuid.uuid4(), phone=f"1381234{uuid.uuid4().hex[:4]}", password_hash="x", name="t")
    db.add(u)
    await db.flush()
    store = Store(id=uuid.uuid4(), owner_id=u.id, name="店")
    db.add(store)
    await db.flush()
    return store


def _task(store_id, next_run_at, enabled=True, kind="daily", spec=None, name="任务"):
    return ScheduledTask(
        store_id=store_id, name=name, instruction="写点什么",
        schedule_kind=kind, schedule_spec=spec or {"hour": 8, "minute": 0},
        next_run_at=next_run_at, enabled=enabled,
    )


class TestDueTasks:
    def test_future_next_run_not_due(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                now = datetime.now(timezone.utc)
                db.add(_task(store.id, now + timedelta(hours=1)))
                await db.commit()
                due = await sc.due_tasks(db, now)
                assert due == []
            await eng.dispose()
        asyncio.run(main())

    def test_past_next_run_is_due(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                now = datetime.now(timezone.utc)
                db.add(_task(store.id, now - timedelta(minutes=1), name="到点了"))
                await db.commit()
                due = await sc.due_tasks(db, now)
                assert len(due) == 1 and due[0].name == "到点了"
            await eng.dispose()
        asyncio.run(main())

    def test_disabled_task_never_due(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                now = datetime.now(timezone.utc)
                db.add(_task(store.id, now - timedelta(minutes=1), enabled=False))
                await db.commit()
                due = await sc.due_tasks(db, now)
                assert due == []
            await eng.dispose()
        asyncio.run(main())

    def test_naive_stored_next_run_at_still_compares_correctly(self):
        """模拟 SQLite 丢 tzinfo 场景：直接落一个"裸" datetime，due_tasks 仍要按 UTC 兜底判对。"""
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                now_naive = datetime.now(timezone.utc).replace(tzinfo=None)
                db.add(_task(store.id, now_naive - timedelta(minutes=5)))
                await db.commit()
                due = await sc.due_tasks(db, datetime.now(timezone.utc))
                assert len(due) == 1
            await eng.dispose()
        asyncio.run(main())


class TestRunScheduledTaskFaultSafety:
    def test_run_agent_loop_raises_marks_error_and_advances_next_run(self, monkeypatch):
        async def _boom(**kwargs):
            raise RuntimeError("模型挂了")

        pushed = {}
        monkeypatch.setattr(sc, "run_agent_loop", _boom)
        monkeypatch.setattr(sc, "build_resilient_text_provider", lambda store: object())
        monkeypatch.setattr(sc.notify_service, "push", lambda title, body, kind="info", **m: pushed.update(
            title=title, body=body, kind=kind, meta=m))

        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                old_next_run = datetime.now(timezone.utc) - timedelta(minutes=1)
                task = _task(store.id, old_next_run)
                db.add(task)
                await db.commit()

                await sc.run_scheduled_task(task, db)

                assert task.last_run_status == "error"
                assert "模型挂了" in (task.last_result_summary or "")
                # 别卡死：next_run_at 必须推进到"未来"(相对旧的 next_run_at)
                assert sc._as_aware_utc(task.next_run_at) > old_next_run
                assert task.last_run_at is not None
            await eng.dispose()
        asyncio.run(main())

        assert pushed["title"] == "定时任务没跑成"
        assert pushed["kind"] == "task_done"
        assert pushed["meta"]["status"] == "error"

    def test_success_path_writes_summary_and_notifies(self, monkeypatch):
        class _FakeResult:
            final_text = "今日文案：欢迎周末来打球！"

        async def _fake_loop(**kwargs):
            return _FakeResult()

        pushed = {}
        monkeypatch.setattr(sc, "run_agent_loop", _fake_loop)
        monkeypatch.setattr(sc, "build_resilient_text_provider", lambda store: object())
        monkeypatch.setattr(sc.notify_service, "push", lambda title, body, kind="info", **m: pushed.update(
            title=title, body=body, kind=kind, meta=m))

        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                task = _task(store.id, datetime.now(timezone.utc) - timedelta(minutes=1))
                db.add(task)
                await db.commit()

                await sc.run_scheduled_task(task, db)

                assert task.last_run_status == "success"
                assert "欢迎周末来打球" in task.last_result_summary
            await eng.dispose()
        asyncio.run(main())

        assert pushed["title"] == "定时任务完成"
        assert pushed["meta"]["status"] == "success"
        assert "欢迎周末来打球" in pushed["meta"]["result_text"]

    def test_missing_store_is_fault_safe(self, monkeypatch):
        """门店被删了(理论边界)——不该崩,记成失败、仍推进 next_run_at。"""
        monkeypatch.setattr(sc.notify_service, "push", lambda *a, **k: None)

        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                ghost_store_id = uuid.uuid4()
                old_next_run = datetime.now(timezone.utc) - timedelta(minutes=1)
                task = _task(ghost_store_id, old_next_run)
                db.add(task)
                await db.commit()

                await sc.run_scheduled_task(task, db)
                assert task.last_run_status == "error"
                assert sc._as_aware_utc(task.next_run_at) > old_next_run
            await eng.dispose()
        asyncio.run(main())


class TestCatchUpOnStartup:
    def test_only_runs_missed_task_once_and_advances_next_run(self, monkeypatch):
        calls = []

        async def _fake_run(task, db):
            calls.append(task.id)
            task.last_run_status = "success"
            task.last_run_at = datetime.now(timezone.utc)
            task.next_run_at = sc._compute_next_run(task.schedule_kind, task.schedule_spec, task.last_run_at)

        monkeypatch.setattr(sc, "run_scheduled_task", _fake_run)

        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                slept_through = datetime.now(timezone.utc) - timedelta(days=1)  # app 关了睡过点
                future_task = _task(store.id, datetime.now(timezone.utc) + timedelta(hours=2), name="没到点")
                overdue_task = _task(store.id, slept_through, name="睡过点的")
                db.add_all([future_task, overdue_task])
                await db.commit()

                count = await sc.catch_up_on_startup(db)

                assert count == 1
                assert calls == [overdue_task.id]  # 只补跑那条真正睡过点的，没到点的不动
                assert sc._as_aware_utc(overdue_task.next_run_at) > datetime.now(timezone.utc)
            await eng.dispose()
        asyncio.run(main())


# ══════════════════════════ 3. 无人值守安全工具集锁死（安全红线回归） ══════════════════════════

class TestScheduledSafeRegistryHermetic:
    """用手搭的合成工具表测过滤规则本身，不依赖 DESKTOP_LOCAL 是否在导入期被设置过
    （那些工具是否登记进全局 default_registry 跟进程导入顺序有关，不该影响这条安全红线判定）。"""

    def test_filters_exactly_by_rule(self, monkeypatch):
        from services.agent.registry import Tool, ToolRegistry

        async def _h(args, ctx):
            return "ok"

        synth = ToolRegistry()
        synth.register(Tool(name="write_a_report", description="d", parameters={}, handler=_h))
        synth.register(Tool(name="generate_image", description="d", parameters={}, handler=_h))
        synth.register(Tool(name="publish_post", description="d", parameters={}, handler=_h, requires_approval=True))
        synth.register(Tool(name="delete_all_data", description="d", parameters={}, handler=_h, force_confirm=True))
        synth.register(Tool(name="run_command", description="d", parameters={}, handler=_h))
        synth.register(Tool(name="run_background", description="d", parameters={}, handler=_h))
        synth.register(Tool(name="computer_control", description="d", parameters={}, handler=_h))
        synth.register(Tool(name="computer_view", description="d", parameters={}, handler=_h))

        import api.v1.agent as agent_mod
        monkeypatch.setattr(agent_mod, "_build_agent_registry", lambda billiards_mode: synth)

        reg = sc._scheduled_safe_registry(False)
        assert set(reg.names()) == {"write_a_report", "generate_image"}


class TestScheduledSafeRegistryAgainstRealRegistry:
    """对真实全局工具表跑一遍，兜底证实过滤在真实工具集上也生效（web_fetch 无论 DESKTOP_LOCAL
    与否都无条件注册，是个可靠的"requires_approval 必须被踢出去"活样本）。"""

    def test_web_fetch_excluded_generation_tools_kept(self):
        import services.agent.tools  # noqa: F401
        import services.agent.web_tools  # noqa: F401

        reg = sc._scheduled_safe_registry(False)
        names = set(reg.names())
        assert "web_fetch" not in names, "web_fetch 是 requires_approval 工具，无人值守绝不能自动对外抓取"
        assert "web_search" in names
        assert "generate_image" in names
        for t in reg.all():
            assert not getattr(t, "requires_approval", False)
            assert not getattr(t, "force_confirm", False)
            assert t.name not in ("run_command", "run_background")
            assert not t.name.startswith("computer_")

    def test_billiards_mode_includes_billiards_generation_tools(self):
        import services.agent.tools  # noqa: F401

        reg = sc._scheduled_safe_registry(True)
        names = set(reg.names())
        assert "write_operation_content" in names
        assert "make_poster" in names


# ══════════════════════════ 4. 工具入参（schedule_task / list / cancel） ══════════════════════════

class TestToolHandlers:
    def test_schedule_list_cancel_roundtrip(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                ctx = SimpleNamespace(db=db, store=store)

                out = await sc._schedule_task_handler({
                    "name": "每日文案", "instruction": "写今日文案",
                    "schedule_kind": "daily", "schedule_spec": {"hour": 8, "minute": 0},
                }, ctx)
                assert "已建好定时任务" in out and "每日文案" in out

                listed = await sc._list_scheduled_tasks_handler({}, ctx)
                assert "每日文案" in listed

                rows = (await db.execute(select(ScheduledTask))).scalars().all()
                assert len(rows) == 1
                tid = str(rows[0].id)

                cancelled = await sc._cancel_scheduled_task_handler({"id": tid}, ctx)
                assert "已取消" in cancelled

                remaining = (await db.execute(select(ScheduledTask))).scalars().all()
                assert remaining == []
            await eng.dispose()
        asyncio.run(main())

    def test_schedule_task_missing_params(self):
        async def main():
            ctx = SimpleNamespace(db=None, store=None)
            out = await sc._schedule_task_handler({"name": "", "instruction": ""}, ctx)
            assert "[参数缺失]" in out
        asyncio.run(main())

    def test_schedule_task_bad_kind(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                ctx = SimpleNamespace(db=db, store=store)
                out = await sc._schedule_task_handler({
                    "name": "x", "instruction": "y", "schedule_kind": "monthly", "schedule_spec": {},
                }, ctx)
                assert "[参数错误]" in out
            await eng.dispose()
        asyncio.run(main())

    def test_schedule_task_over_limit_rejected(self):
        async def main():
            eng, Session = await _make_db()
            async with Session() as db:
                store = await _seed_store(db)
                for i in range(sc._MAX_TASKS_PER_STORE):
                    db.add(_task(store.id, datetime.now(timezone.utc) + timedelta(hours=i + 1), name=f"任务{i}"))
                await db.commit()
                ctx = SimpleNamespace(db=db, store=store)
                out = await sc._schedule_task_handler({
                    "name": "超限的", "instruction": "z",
                    "schedule_kind": "daily", "schedule_spec": {"hour": 8, "minute": 0},
                }, ctx)
                assert "[超出上限]" in out
                rows = (await db.execute(select(ScheduledTask))).scalars().all()
                assert len(rows) == sc._MAX_TASKS_PER_STORE  # 没多建出来
            await eng.dispose()
        asyncio.run(main())

    def test_cancel_missing_id(self):
        async def main():
            ctx = SimpleNamespace(db=None, store=None)
            out = await sc._cancel_scheduled_task_handler({}, ctx)
            assert "[参数缺失]" in out
        asyncio.run(main())


# ══════════════════════════ 5. 建表 ══════════════════════════

def test_scheduled_task_table_created_by_metadata():
    assert "scheduled_tasks" in Base.metadata.tables

    async def main():
        eng, Session = await _make_db()
        async with Session() as db:
            store = await _seed_store(db)
            db.add(_task(store.id, datetime.now(timezone.utc)))
            await db.commit()
            rows = (await db.execute(select(ScheduledTask))).scalars().all()
            assert len(rows) == 1
        await eng.dispose()
    asyncio.run(main())
