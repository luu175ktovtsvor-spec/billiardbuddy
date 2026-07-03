"""通知中心 —— 统一跨平台通知层的后端归一入口（F1b）。

修的问题：过去 3 处系统通知各自直接 `subprocess` 调 `osascript display notification`——
mac-only，Windows 装机包上静默失败（用户什么都看不到）：
- `services/agent/computer_tools.py` 的 `notify` 工具（agent 可调）
- `services/agent/reminders.py` 的 `_fire`（定时提醒到点触发）
- `services/agent/background_tools.py` 的 `_notify`（后台命令跑完通知）

新设计：三源统一改调这里的 `push()`，进程内内存队列攒着；Electron 侧渲染进程持久轮询
`GET /api/v1/notifications?after=<cursor>`，拿到新条目后调 preload 暴露的
`window.electron.notification.show()` 弹一条真·系统原生通知（mac 通知中心 / Windows
Toast，两边都能落地——跟旧的 osascript 方案是"只有 mac 能弹"完全不同）。

单用户桌面：不做持久化（DB/Redis 都是 over-engineering），进程内 list + 单调递增 id
就够——通知是"尽力而为的叫一声"，不是需要保真送达/审计的业务数据，重启即丢可接受。

给 F-10（长任务后台化"完成播报"）的接口约定：
    from services import notify_service
    notify_service.push(
        title="视频剪好了",
        body="口播稿·3分钟版已生成，点开看看。",
        kind="media_job_done",
        task_id="xxx",          # 任意 kwargs 落进 meta，供以后"点击通知跳转"用
    )
`push()` 是同步函数、故障安全（内部吞异常，绝不向调用方抛出）——调用方（agent 工具/
定时提醒/后台任务/未来的媒体作业)不该因为"通知没弹成功"这种旁路小事被打断主流程。
"""
from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Notification:
    id: int
    title: str
    body: str
    kind: str = "info"
    meta: dict[str, Any] = field(default_factory=dict)


_QUEUE: list[Notification] = []
_CAP = 200  # 最多留最近 200 条，多的从队首丢——纯"叫一声"旁路用途，不需要更长历史
_id_seq = itertools.count()


def push(title: str, body: str, kind: str = "info", **meta: Any) -> Notification:
    """入队一条通知。尽力而为：绝不向调用方抛异常。返回值一般用不上（供测试断言）。"""
    try:
        n = Notification(
            id=next(_id_seq),
            title=str(title or ""),
            body=str(body or ""),
            kind=str(kind or "info"),
            meta=dict(meta),
        )
        _QUEUE.append(n)
        if len(_QUEUE) > _CAP:
            del _QUEUE[: len(_QUEUE) - _CAP]
        return n
    except Exception:  # noqa: BLE001 — 故障安全：通知失败不能拖垮调用方主流程
        return Notification(id=-1, title="", body="")


def list_after(after: int) -> tuple[list[Notification], int]:
    """取出 id > after 的通知，返回 (通知列表, 建议下次轮询用的游标)。

    队列是有界 FIFO（超 `_CAP` 丢队首）、id 单调递增且从不复用——不需要像
    `api/v1/agent.py` 的任务事件那样做 offset/dropped 下标映射，直接按 id 过滤
    即可：已被丢弃的旧通知天然不会出现在结果里，游标语义依然正确、不会重复/漏发。
    没有新通知时游标原样返回，客户端下次带同一个值再问即可。
    """
    items = [n for n in _QUEUE if n.id > after]
    cursor = items[-1].id if items else after
    return items, cursor


def clear() -> None:
    """清空队列 + 重置 id 计数器（测试用）。"""
    global _id_seq
    _QUEUE.clear()
    _id_seq = itertools.count()
