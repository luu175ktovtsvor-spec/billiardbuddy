"""数据安全兜底(G4)：SQLite 主库定期备份 + 一键导出。

锁住：sqlite_db_path 对 PG/内存库返回 None(不误跑)；safe_copy 是 WAL 安全的在线备份(WAL
模式下拷出的库数据完整可读)；backup_once 落盘 + 命名规范；轮转只留最近 N 份；
should_backup_today/backup_if_due 的"一天最多一次"决策；backup_loop 启动即备一次。
以及 /backup/export 端点打包 db + uploads 成 zip。
"""
import asyncio
import shutil
import sqlite3
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest

from services import db_backup as db


def _make_sqlite_db(path: Path, value: str = "hello") -> None:
    conn = sqlite3.connect(str(path))
    conn.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
    conn.execute("INSERT INTO t (v) VALUES (?)", (value,))
    conn.commit()
    conn.close()


# ── sqlite_db_path：只在真 SQLite 文件库上跑 ──

def test_sqlite_db_path_none_for_postgres(monkeypatch):
    import config
    monkeypatch.setattr(config.settings, "database_url_override", "", raising=False)
    monkeypatch.setattr(config.settings, "postgres_host", "localhost")
    assert db.sqlite_db_path() is None  # 默认拼出 postgresql+asyncpg://...


def test_sqlite_db_path_none_for_memory(monkeypatch):
    import config
    monkeypatch.setattr(config.settings, "database_url_override", "sqlite+aiosqlite:///:memory:")
    assert db.sqlite_db_path() is None


def test_sqlite_db_path_resolves_file(monkeypatch, tmp_path):
    import config
    target = tmp_path / "billiards.db"
    monkeypatch.setattr(config.settings, "database_url_override", f"sqlite+aiosqlite:///{target}")
    assert db.sqlite_db_path() == target


def test_default_backup_dir_sibling_of_uploads(monkeypatch, tmp_path):
    import config
    uploads = tmp_path / "userData" / "uploads"
    monkeypatch.setattr(config.settings, "upload_dir", str(uploads))
    assert db.default_backup_dir() == tmp_path / "userData" / "backups"


# ── safe_copy：WAL 安全在线备份，不是裸文件拷贝 ──

def test_safe_copy_wal_mode_data_intact(tmp_path):
    src = tmp_path / "src.db"
    _make_sqlite_db(src, "写入的真实数据")
    # 打开 WAL 模式，模拟桌面版真实运行时的 journal_mode(db/session.py 里对 SQLite 强制开 WAL)
    conn = sqlite3.connect(str(src))
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("INSERT INTO t (v) VALUES ('第二条·WAL期间写入')")
    conn.commit()
    conn.close()

    dest = tmp_path / "backups" / "snap.db"
    db.safe_copy(src, dest)

    assert dest.exists()
    out = sqlite3.connect(str(dest))
    rows = out.execute("SELECT v FROM t ORDER BY id").fetchall()
    out.close()
    assert [r[0] for r in rows] == ["写入的真实数据", "第二条·WAL期间写入"]


# ── backup_once + 轮转 ──

def test_backup_once_creates_file(tmp_path):
    src = tmp_path / "billiards.db"
    _make_sqlite_db(src)
    dest_dir = tmp_path / "backups"
    out = db.backup_once(db_path=src, dest_dir=dest_dir, keep=7)
    assert out is not None and out.exists()
    assert out.parent == dest_dir
    assert out.name.startswith("billiards-") and out.suffix == ".db"


def test_backup_once_missing_db_returns_none(tmp_path):
    missing = tmp_path / "nope.db"
    assert db.backup_once(db_path=missing, dest_dir=tmp_path / "backups") is None


def test_rotation_keeps_last_n(tmp_path):
    dest_dir = tmp_path / "backups"
    dest_dir.mkdir()
    # 直接铺 10 份不同时间戳的假备份文件(不用真跑 10 次备份，命名符合正则即可)
    names = [f"billiards-202607{i:02d}-000000.db" for i in range(1, 11)]
    for n in names:
        (dest_dir / n).write_bytes(b"x")
    db._rotate(dest_dir, keep=5)
    remaining = sorted(p.name for p in dest_dir.glob("billiards-*.db"))
    assert remaining == sorted(names)[-5:]  # 只留最近 5 份(按文件名时间戳排序)


def test_rotation_noop_when_under_limit(tmp_path):
    dest_dir = tmp_path / "backups"
    dest_dir.mkdir()
    (dest_dir / "billiards-20260701-000000.db").write_bytes(b"x")
    db._rotate(dest_dir, keep=7)
    assert len(list(dest_dir.glob("billiards-*.db"))) == 1


# ── should_backup_today / backup_if_due：一天最多一次 ──

def test_should_backup_today_empty_dir(tmp_path):
    dest_dir = tmp_path / "backups"
    dest_dir.mkdir()
    assert db.should_backup_today(dest_dir, "20260704") is True


def test_should_backup_today_already_done(tmp_path):
    dest_dir = tmp_path / "backups"
    dest_dir.mkdir()
    (dest_dir / "billiards-20260704-081500.db").write_bytes(b"x")
    assert db.should_backup_today(dest_dir, "20260704") is False
    assert db.should_backup_today(dest_dir, "20260705") is True  # 新的一天又该跑


def test_backup_if_due_skips_non_sqlite(monkeypatch):
    monkeypatch.setattr(db, "sqlite_db_path", lambda: None)
    assert db.backup_if_due() is None


def test_backup_if_due_runs_once_per_day(monkeypatch, tmp_path):
    src = tmp_path / "billiards.db"
    _make_sqlite_db(src)
    dest_dir = tmp_path / "backups"
    monkeypatch.setattr(db, "sqlite_db_path", lambda: src)
    monkeypatch.setattr(db, "default_backup_dir", lambda: dest_dir)

    first = db.backup_if_due()
    assert first is not None and first.exists()
    second = db.backup_if_due()  # 同一天再跑一次 → 跳过，不重复写
    assert second is None
    assert len(list(dest_dir.glob("billiards-*.db"))) == 1


# ── backup_loop：app 一开就先备一次 ──

def test_backup_loop_runs_backup_on_start(monkeypatch):
    calls = []
    monkeypatch.setattr(db, "backup_if_due", lambda: calls.append(1))
    stop = asyncio.Event()

    async def _drive():
        task = asyncio.create_task(db.backup_loop(stop))
        await asyncio.sleep(0.05)
        stop.set()
        await asyncio.wait_for(task, timeout=2)

    asyncio.run(_drive())
    assert calls == [1]


# ── /backup/export 端点：打包 db + uploads 成 zip ──

def test_export_store_data_zip_contains_db_and_uploads(monkeypatch, tmp_path):
    import api.v1.backup as bk

    src = tmp_path / "billiards.db"
    _make_sqlite_db(src)
    uploads_dir = tmp_path / "uploads"
    (uploads_dir / "posters").mkdir(parents=True)
    (uploads_dir / "posters" / "a.png").write_bytes(b"fake-image-bytes")

    monkeypatch.setattr(bk.db_backup, "sqlite_db_path", lambda: src)
    monkeypatch.setattr(bk.settings, "upload_dir", str(uploads_dir))

    resp = asyncio.run(bk.export_store_data(user=SimpleNamespace(id="local-owner")))
    zpath = Path(resp.path)
    try:
        assert zpath.exists()
        assert resp.media_type == "application/zip"
        with zipfile.ZipFile(zpath) as zf:
            names = zf.namelist()
            assert "billiards.db" in names
            assert "uploads/posters/a.png" in names
    finally:
        shutil.rmtree(zpath.parent, ignore_errors=True)


def test_export_store_data_rejects_non_sqlite(monkeypatch):
    import api.v1.backup as bk
    from fastapi import HTTPException

    monkeypatch.setattr(bk.db_backup, "sqlite_db_path", lambda: None)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(bk.export_store_data(user=SimpleNamespace(id="local-owner")))
    assert exc.value.status_code == 400
