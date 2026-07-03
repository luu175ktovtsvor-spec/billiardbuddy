"""通知中心只读端点 —— 渲染进程轮询这里，把新通知转发给 Electron 弹系统原生通知（F1b）。

单用户桌面：不分门店/租户，直接读进程内内存队列（`services.notify_service`），零 Depends；
跟 `api/v1/agent.py` 的 `GET /agent/tasks/{id}/events?after=` 一个路子——`after` 是客户端
已经拿到的最后一条通知 id，返回 id 更大的新通知 + 下次轮询要用的游标。
"""
from fastapi import APIRouter

from services import notify_service

router = APIRouter()


@router.get("")
async def list_notifications(after: int = -1):
    items, cursor = notify_service.list_after(after)
    return {
        "items": [
            {"id": n.id, "title": n.title, "body": n.body, "kind": n.kind, "meta": n.meta}
            for n in items
        ],
        "cursor": cursor,
    }
