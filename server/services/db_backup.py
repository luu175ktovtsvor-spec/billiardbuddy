"""数据安全兜底 · SQLite 主库定期备份(G4)：electron 侧「电脑坏了数据全丢」的产品信任问题。

桌面版全本地 SQLite，没有服务器兜底、没有 Alembic、没有运维团队每天盯——库文件一旦随硬盘损坏/
误删/系统重装就是真丢光(门店资料/对话历史/店脑记忆/生成记录全无法找回)。这里做两件事：

1. `backup_once` / `backup_if_due`：把主库文件在线备份一份到 userData 下的 backups/ 子目录，
   旧的自动轮转删除只保留最近 N 份。
2. `backup_loop`：进程内定时(与 daily_scheduler.py/reminders.py 同款 while+stop_event 轮询)，
   app 开着时启动即备份一次(覆盖"关机前来不及"的场景)、之后每天最多备份一次。

WAL 安全：绝不对着正在写的库文件做操作系统层面的 `shutil.copy`(WAL 模式下主文件可能不含最新
已提交事务，裸拷可能拷到不一致的半截库)。改用 `sqlite3.Connection.backup()`——这是 CPython
sqlite3 模块对 SQLite 官方在线备份 API(`sqlite3_backup_init/step/finish`)的封装，专为"数据库
使用中也能安全整体复制"设计，天然兼容 WAL。

仅 SQLite(桌面)有意义；PostgreSQL(云端)另有运维层面的备份，`sqlite_db_path()` 对非 SQLite
的 `DATABASE_URL` 返回 None，调用方据此跳过。
"""
from __future__ import annotations

import logging
import re
import sqlite3
from datetime import datetime
from pathlib import Path

logger = logging.getLogger(__name__)

_FILE_RE = re.compile(r"^billiards-(\d{8})-\d{6}\.db$")


def sqlite_db_path() -> Path | None:
    """解析当前 `DATABASE_URL` 是否是 SQLite 文件库；是则返回其绝对路径，否则(PG/内存库)返回 None。"""
    from sqlalchemy.engine import make_url
    from config import settings

    try:
        url = make_url(settings.database_url)
    except Exception:
        return None
    if not url.drivername.startswith("sqlite"):
        return None
    db = url.database
    if not db or db == ":memory:":
        return None
    return Path(db)


def default_backup_dir() -> Path:
    """备份落点：`UPLOAD_DIR` 的同级 `backups/`——`UPLOAD_DIR` 桌面上被显式指到 userData 可写目录
    (`uploads/` 的父目录就是 userData 根)，backups/ 与它平级，同样必写、不落在只读的 app 包内。"""
    from config import settings

    return Path(settings.upload_dir).parent / "backups"


def safe_copy(src: Path, dest: Path) -> None:
    """WAL 安全的整库复制：用 SQLite 在线备份 API，而非裸文件拷贝(裸拷在 WAL 模式下可能拷到不一致状态)。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    src_conn = sqlite3.connect(str(src))
    try:
        dest_conn = sqlite3.connect(str(dest))
        try:
            src_conn.backup(dest_conn)
        finally:
            dest_conn.close()
    finally:
        src_conn.close()


def _rotate(dest_dir: Path, keep: int) -> None:
    """按文件名时间戳排序，只留最近 `keep` 份，旧的删掉(单文件删除失败不影响其余)。"""
    files = sorted(p for p in dest_dir.glob("billiards-*.db") if _FILE_RE.match(p.name))
    excess = len(files) - keep
    for p in files[:max(excess, 0)]:
        try:
            p.unlink()
        except OSError:
            logger.warning("旧备份删除失败(忽略): %s", p)


def backup_once(db_path: Path | None = None, dest_dir: Path | None = None, keep: int = 7) -> Path | None:
    """立即备份一次 + 轮转。`db_path`/`dest_dir` 缺省时按当前配置解析；库文件不存在则返回 None。"""
    db_path = db_path if db_path is not None else sqlite_db_path()
    if db_path is None or not db_path.exists():
        return None
    dest_dir = dest_dir if dest_dir is not None else default_backup_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    dest = dest_dir / f"billiards-{ts}.db"
    safe_copy(db_path, dest)
    _rotate(dest_dir, keep)
    return dest


def _last_backup_date(dest_dir: Path) -> str | None:
    files = sorted((p for p in dest_dir.glob("billiards-*.db") if _FILE_RE.match(p.name)), key=lambda p: p.name)
    if not files:
        return None
    m = _FILE_RE.match(files[-1].name)
    return m.group(1) if m else None


def should_backup_today(dest_dir: Path, today: str) -> bool:
    """今天(YYYYMMDD)还没备份过 → True。目录不存在/没有备份文件也算"还没备过"。"""
    return _last_backup_date(dest_dir) != today


def backup_if_due(keep: int = 7) -> Path | None:
    """幂等入口：非 SQLite/库文件不存在 → 跳过；今天已备份过 → 跳过；否则备份一次。"""
    db_path = sqlite_db_path()
    if db_path is None or not db_path.exists():
        return None
    dest_dir = default_backup_dir()
    dest_dir.mkdir(parents=True, exist_ok=True)
    today = datetime.now().strftime("%Y%m%d")
    if not should_backup_today(dest_dir, today):
        return None
    try:
        return backup_once(db_path=db_path, dest_dir=dest_dir, keep=keep)
    except Exception:
        logger.exception("主库定期备份失败")
        return None


_CHECK_INTERVAL_SEC = 3600  # 每小时检查一次；实际是否真备份由 should_backup_today 把关，一天最多一次


async def backup_loop(stop_event) -> None:
    """进程内定时:app 一开就先备一次(覆盖"上次没来得及关机就崩了")，之后每小时检查、一天最多备一次。

    与 daily_scheduler.scheduler_loop 同款结构：`sqlite3.Connection.backup()` 是阻塞 I/O，
    丢进 `asyncio.to_thread` 里跑，不卡事件循环；单次异常吞掉、下个周期再试，不影响其余后台任务。
    """
    import asyncio

    while not stop_event.is_set():
        try:
            await asyncio.to_thread(backup_if_due)
        except Exception:
            logger.exception("主库定期备份检查异常(已吞，下个周期再试)")
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=_CHECK_INTERVAL_SEC)
        except asyncio.TimeoutError:
            pass  # 到点醒来检查下一轮；被 stop_event 唤醒则退出
