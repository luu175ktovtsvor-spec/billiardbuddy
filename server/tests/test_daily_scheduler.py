"""主动出击·进程内每日定时（s14）：opt-in 定时把今日草稿预生成缓存，老板打开秒出。

锁住：opt-in 开关解析、草稿缓存读写、is_due 决策（到点 + 今天没备过才跑）、同天覆盖。
（DB 迭代 _run_due_stores / 周期 loop 是薄壳 + 故障安全，决策与缓存这层在此钉死。）
"""
from services import daily_scheduler as ds


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setenv("DESKTOP_DRAFTS_DIR", str(tmp_path))
    ds.reset_for_test()


def test_target_hour_is_optin(monkeypatch):
    monkeypatch.delenv("DESKTOP_DAILY_DRAFTS_HOUR", raising=False)
    assert ds.target_hour() is None              # 未配 = 关（默认，零行为变化）
    monkeypatch.setenv("DESKTOP_DAILY_DRAFTS_HOUR", "8")
    assert ds.target_hour() == 8
    monkeypatch.setenv("DESKTOP_DAILY_DRAFTS_HOUR", "0")
    assert ds.target_hour() == 0
    monkeypatch.setenv("DESKTOP_DAILY_DRAFTS_HOUR", "25")
    assert ds.target_hour() is None              # 越界 → 关
    monkeypatch.setenv("DESKTOP_DAILY_DRAFTS_HOUR", "abc")
    assert ds.target_hour() is None              # 非法 → 关


def test_cache_roundtrip(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    assert ds.get_cached_drafts("s1", "2026-06-20") is None
    drafts = [{"title": "周末活动", "content": "草稿正文"}]
    ds.save_drafts("s1", "2026-06-20", drafts)
    assert ds.get_cached_drafts("s1", "2026-06-20") == drafts
    assert ds.get_cached_drafts("s1", "2026-06-21") is None   # 另一天没有
    assert ds.get_cached_drafts("s2", "2026-06-20") is None   # 另一店没有


def test_is_due_logic(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    assert ds.is_due("s1", 9, "2026-06-20", None) is False    # 没开 → 永不跑
    assert ds.is_due("s1", 7, "2026-06-20", 8) is False       # 没到点 → 不跑
    assert ds.is_due("s1", 8, "2026-06-20", 8) is True        # 到点 + 没备过 → 跑
    assert ds.is_due("s1", 20, "2026-06-20", 8) is True       # 过了点也算到点
    ds.save_drafts("s1", "2026-06-20", [{"x": 1}])
    assert ds.is_due("s1", 8, "2026-06-20", 8) is False       # 今天已备过 → 不重复花 token
    assert ds.is_due("s1", 8, "2026-06-21", 8) is True        # 新的一天又该跑


def test_save_overwrites_same_day(tmp_path, monkeypatch):
    _fresh(tmp_path, monkeypatch)
    ds.save_drafts("s1", "2026-06-20", [{"v": 1}])
    ds.save_drafts("s1", "2026-06-20", [{"v": 2}])            # 同 (店,天) 覆盖
    assert ds.get_cached_drafts("s1", "2026-06-20") == [{"v": 2}]
