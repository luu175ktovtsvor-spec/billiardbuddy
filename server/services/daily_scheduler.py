"""主动出击·进程内每日定时（借鉴 learn-claude-code s14 Cron）。

app 开着时，到点自动把"今日草稿"预生成好、缓存起来；老板打开聊天页要"今天的"就秒出，不用现等模型。

边界（严守项目红线）：
- 只产【文字草稿】、绝不自动发布/群发——沿用 generate_daily_drafts 的红线（海报/生图不碰）。
- **opt-in**：仅当配了环境变量 DESKTOP_DAILY_DRAFTS_HOUR（0-23，如 "8"）才启用；不配 = 关（默认，对现有行为零影响）。
  这同时是"自动花 BYOK token"的同意点——老板开了这个开关，即同意每早花自己的 key 备草稿。
- **进程内**：只在 app 开着时跑。"关了 app 也跑"需 OS 级定时（launchd / 任务计划）+ 后台解密 BYOK key，
  是更大的独立工程（见 docs），本模块先覆盖"老板每天开店、app 开着"这个绝大多数场景。
- 缓存走独立 sqlite（桌面数据目录），与主库解耦、不迁移（同 byok_profiles 思路）。
"""
import asyncio
import json
import logging
import os
import sqlite3
from pathlib import Path

logger = logging.getLogger(__name__)

_conn_cache: dict[str, sqlite3.Connection] = {}
_CHECK_INTERVAL_SEC = 1800  # 每 30 分钟检查一次是否到点


def _db_path() -> Path:
    base = Path(os.environ.get("DESKTOP_DRAFTS_DIR") or (Path.home() / ".billiards-desktop" / "drafts"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "daily_drafts.db"


def _conn() -> sqlite3.Connection:
    key = str(_db_path())
    c = _conn_cache.get(key)
    if c is None:
        c = sqlite3.connect(key)
        c.row_factory = sqlite3.Row
        c.execute(
            "CREATE TABLE IF NOT EXISTS daily_drafts ("
            "store_id TEXT, day TEXT, drafts_json TEXT, ts TEXT, PRIMARY KEY (store_id, day))"
        )
        c.commit()
        _conn_cache[key] = c
    return c


def reset_for_test() -> None:
    _conn_cache.clear()


def target_hour() -> int | None:
    """opt-in 开关：配了 DESKTOP_DAILY_DRAFTS_HOUR（0-23）才启用；未配/非法 → None（关）。"""
    v = os.environ.get("DESKTOP_DAILY_DRAFTS_HOUR", "")
    if v == "":
        return None
    try:
        h = int(v)
    except (TypeError, ValueError):
        return None
    return h if 0 <= h <= 23 else None


def get_cached_drafts(store_id: str, day: str) -> list[dict] | None:
    """取某店某天已缓存的草稿；没有/坏掉 → None。"""
    r = _conn().execute(
        "SELECT drafts_json FROM daily_drafts WHERE store_id=? AND day=?",
        (str(store_id), str(day)),
    ).fetchone()
    if not r:
        return None
    try:
        return json.loads(r["drafts_json"])
    except Exception:
        return None


def save_drafts(store_id: str, day: str, drafts: list[dict]) -> None:
    c = _conn()
    c.execute(
        "INSERT OR REPLACE INTO daily_drafts (store_id, day, drafts_json, ts) VALUES (?,?,?,datetime('now'))",
        (str(store_id), str(day), json.dumps(drafts, ensure_ascii=False)),
    )
    c.commit()


def is_due(store_id: str, now_hour: int, today: str, t_hour: int | None) -> bool:
    """到点了（now_hour >= 目标点）、且今天还没备过 → 该跑。纯函数，便于测。t_hour=None（没开）→ 永远不跑。"""
    if t_hour is None or now_hour < t_hour:
        return False
    return get_cached_drafts(store_id, today) is None


async def _run_due_stores(now_hour: int, today: str) -> int:
    """一次定时检查：对每个门店，若到点且今天没备过 → 生成并缓存。
    故障安全：单店失败不影响其余；整体异常被上层 loop 吞掉。返回本次备好的门店数。"""
    t = target_hour()
    if t is None or now_hour < t:
        return 0
    from sqlalchemy import select
    from db.session import async_session
    from models.store import Store
    from models.user import User
    from services.agent.proactive import generate_daily_drafts

    done = 0
    async with async_session() as db:
        stmt = select(Store)
        # 桌面版全内置 key、不走 BYOK：按 byok_enabled 过滤会让每日草稿这个功能在桌面上永远
        # 服务不到任何店（死锁）。只有云端 SaaS（店主自带 key、自担 token 成本）才需要这道门槛——
        # 桌面用户没配也没关系，本来就是内置 key 生成、不该被这条云端专属护栏挡住。
        if os.environ.get("DESKTOP_LOCAL") != "1":
            stmt = stmt.where(Store.byok_enabled.is_(True))
        stores = (await db.execute(stmt)).scalars().all()
        for store in stores:
            if get_cached_drafts(str(store.id), today) is not None:
                continue  # 今天已备过（定时或老板手点过）→ 跳过，不重复花 token
            try:
                user = await db.get(User, store.owner_id)
                if user is None:
                    continue
                drafts = await generate_daily_drafts(db, store, user, max_drafts=3)
                save_drafts(str(store.id), today, drafts)
                done += 1
                logger.info("每日草稿已自动备好 store_id=%s 条数=%d", store.id, len(drafts))
            except Exception:
                logger.exception("自动备每日草稿失败，跳过该店 store_id=%s", store.id)
    return done


async def scheduler_loop(stop_event: asyncio.Event) -> None:
    """进程内每日定时主循环：每 30 分钟检查一次是否到点。opt-in 未开则直接退出（不占资源）。"""
    if target_hour() is None:
        logger.info("每日草稿定时未开启（未配 DESKTOP_DAILY_DRAFTS_HOUR），跳过")
        return
    logger.info("每日草稿定时已启用，目标时段 %d 点", target_hour())
    while not stop_event.is_set():
        try:
            from core.timezone import business_now, business_today
            now = business_now()
            await _run_due_stores(now.hour, str(business_today()))
        except Exception:
            logger.exception("每日草稿定时检查异常（已吞，下个周期再试）")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=_CHECK_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass  # 到点醒来跑下一轮；被 stop_event 唤醒则退出
