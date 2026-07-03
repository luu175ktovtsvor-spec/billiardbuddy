"""通知中心测试（F1b）：push 入队 + after 游标语义 + 容量截断 + 故障安全。"""
from services import notify_service as ns


def setup_function(_):
    ns.clear()


def test_push_and_list_after_from_start():
    ns.push("标题1", "内容1")
    ns.push("标题2", "内容2")
    items, cursor = ns.list_after(-1)
    assert [n.title for n in items] == ["标题1", "标题2"]
    assert cursor == items[-1].id


def test_list_after_only_returns_new():
    ns.push("a", "1")
    _items1, cursor1 = ns.list_after(-1)
    ns.push("b", "2")
    items2, cursor2 = ns.list_after(cursor1)
    assert [n.title for n in items2] == ["b"]
    assert cursor2 > cursor1


def test_list_after_no_new_keeps_cursor():
    ns.push("a", "1")
    _items, cursor = ns.list_after(-1)
    items2, cursor2 = ns.list_after(cursor)
    assert items2 == []
    assert cursor2 == cursor


def test_list_after_empty_queue_returns_default_cursor():
    items, cursor = ns.list_after(-1)
    assert items == []
    assert cursor == -1


def test_capacity_truncation_keeps_recent_and_cursor_still_correct():
    total = ns._CAP + 50
    for i in range(total):
        ns.push(f"t{i}", f"b{i}")
    items, cursor = ns.list_after(-1)
    assert len(items) == ns._CAP
    assert items[0].title == "t50"  # 最老的 50 条已被队首丢弃
    assert items[-1].title == f"t{total - 1}"
    assert cursor == items[-1].id


def test_push_kind_and_meta_kwargs():
    n = ns.push("标题", "内容", kind="media_job_done", task_id="abc123")
    assert n.kind == "media_job_done"
    assert n.meta == {"task_id": "abc123"}


def test_push_default_kind_is_info():
    n = ns.push("标题", "内容")
    assert n.kind == "info"


def test_push_never_raises_on_odd_input():
    # 故障安全：调用方（agent 工具/定时提醒/后台任务）不该因为通知失败被打断。
    # 注：None 走 `str(None or "") == ""`，根本不抛异常，此用例其实没打到 push() 内部
    # 的 except 分支——真正覆盖 except 见下面 test_push_never_raises_when_title_raises。
    n = ns.push(None, None)  # type: ignore[arg-type]
    assert n is not None


class _RaisesOnTruthOrStr:
    """title/body 传入这种怪对象时，`title or ""` 求真值和兜底 `str(...)` 都会抛异常——
    用来真正命中 push() 内部的 except 兜底分支（None 输入做不到这点）。"""

    def __bool__(self) -> bool:
        raise RuntimeError("boom: __bool__")

    def __str__(self) -> str:
        raise RuntimeError("boom: __str__")


def test_push_never_raises_when_title_raises():
    # 故障安全：即便 title/body 是访问即抛异常的怪对象，push() 也必须吞掉异常、不向
    # 调用方传播，且落回约定的兜底 Notification（id=-1，空标题/内容）。
    n = ns.push(_RaisesOnTruthOrStr(), _RaisesOnTruthOrStr())  # type: ignore[arg-type]
    assert n is not None
    assert n.id == -1
    assert n.title == ""
    assert n.body == ""
