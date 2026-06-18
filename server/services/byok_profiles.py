"""多供应商配置档（CC Switch 式：存好几套大模型 Key、一键切换）。

借鉴 CC Switch 的真实机制：N 套配置存在一个【独立本地库】里，"激活"某套 = 把它的值写进
门店真正生效的 BYOK 配置(store.byok_*)——factory 不变、照读 store.byok_*，只是被换了内容。

- 独立本地 SQLite（桌面数据目录）→ 与主库解耦、不动 schema、不需迁移（同 RAG 思路）。
- 主键 (store_id, name) → 同名覆盖、不重；is_active 标当前激活的那套。
- key 用主库同一把 BYOK_ENCRYPT_KEY 加密存（密文可直接拷进 store.byok_api_key_enc，无需重新加密）。
- 安全网（CC Switch 三件套思路）：覆盖前自动备份原档、切换是原子写、激活态始终留一套。
"""
import os
import sqlite3
from pathlib import Path

_conn_cache: dict[str, sqlite3.Connection] = {}


def _db_path() -> Path:
    base = Path(os.environ.get("DESKTOP_BYOK_DIR") or (Path.home() / ".billiards-desktop" / "byok"))
    base.mkdir(parents=True, exist_ok=True)
    return base / "profiles.db"


def _conn() -> sqlite3.Connection:
    key = str(_db_path())
    c = _conn_cache.get(key)
    if c is None:
        c = sqlite3.connect(key)
        c.row_factory = sqlite3.Row
        c.execute(
            "CREATE TABLE IF NOT EXISTS profiles ("
            "store_id TEXT, name TEXT, base_url TEXT, model TEXT, api_key_enc TEXT, "
            "is_active INTEGER DEFAULT 0, ts TEXT, "
            "PRIMARY KEY (store_id, name))"
        )
        c.commit()
        _conn_cache[key] = c
    return c


def reset_for_test() -> None:
    _conn_cache.clear()


def list_profiles(store_id: str) -> list[dict]:
    """该店所有配置档（不含密文）：[{name, base_url, model, has_key, is_active}]。"""
    rows = _conn().execute(
        "SELECT name, base_url, model, api_key_enc, is_active FROM profiles WHERE store_id=? ORDER BY name",
        (str(store_id),),
    ).fetchall()
    return [
        {"name": r["name"], "base_url": r["base_url"], "model": r["model"],
         "has_key": bool(r["api_key_enc"]), "is_active": bool(r["is_active"])}
        for r in rows
    ]


def save_profile(store_id: str, name: str, base_url: str | None, model: str | None,
                 api_key_enc: str | None) -> None:
    """新增/更新一套配置。api_key_enc=None 时保留原有 key（仅改 base_url/model）。"""
    c = _conn()
    existing = c.execute(
        "SELECT api_key_enc, is_active FROM profiles WHERE store_id=? AND name=?",
        (str(store_id), name),
    ).fetchone()
    key_enc = api_key_enc if api_key_enc is not None else (existing["api_key_enc"] if existing else None)
    is_active = existing["is_active"] if existing else 0
    c.execute(
        "INSERT OR REPLACE INTO profiles (store_id, name, base_url, model, api_key_enc, is_active, ts) "
        "VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
        (str(store_id), name, base_url, model, key_enc, is_active),
    )
    c.commit()


def get_profile(store_id: str, name: str) -> dict | None:
    """取一套配置全量（含密文 api_key_enc），用于激活时拷进 store.byok_*。"""
    r = _conn().execute(
        "SELECT name, base_url, model, api_key_enc FROM profiles WHERE store_id=? AND name=?",
        (str(store_id), name),
    ).fetchone()
    if not r:
        return None
    return {"name": r["name"], "base_url": r["base_url"], "model": r["model"], "api_key_enc": r["api_key_enc"]}


def set_active(store_id: str, name: str) -> None:
    """把 name 标为当前激活（其余清 0）。原子：单事务内完成。"""
    c = _conn()
    c.execute("UPDATE profiles SET is_active=0 WHERE store_id=?", (str(store_id),))
    c.execute("UPDATE profiles SET is_active=1 WHERE store_id=? AND name=?", (str(store_id), name))
    c.commit()


def delete_profile(store_id: str, name: str) -> None:
    c = _conn()
    c.execute("DELETE FROM profiles WHERE store_id=? AND name=?", (str(store_id), name))
    c.commit()
