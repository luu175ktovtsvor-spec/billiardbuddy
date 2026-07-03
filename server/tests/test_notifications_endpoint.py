"""GET /api/v1/notifications?after= 端点测试（F1b）。

跟 test_agent_tasks.py 同一约定：不用 TestClient，直接 import 端点模块、当普通异步
函数调用（本端点零 Depends，单用户桌面不分门店/租户，可以这样测）。
"""
import asyncio

from services import notify_service as ns


def setup_function(_):
    ns.clear()


def test_endpoint_returns_new_items_after_cursor():
    async def main():
        import api.v1.notifications as notifications

        ns.push("标题1", "内容1")
        res = await notifications.list_notifications(after=-1)
        assert len(res["items"]) == 1
        assert res["items"][0]["title"] == "标题1"
        assert res["items"][0]["body"] == "内容1"
        cursor = res["cursor"]

        ns.push("标题2", "内容2")
        res2 = await notifications.list_notifications(after=cursor)
        assert len(res2["items"]) == 1
        assert res2["items"][0]["title"] == "标题2"

    asyncio.run(main())


def test_endpoint_empty_queue_returns_empty_list_and_stable_cursor():
    async def main():
        import api.v1.notifications as notifications

        res = await notifications.list_notifications(after=-1)
        assert res["items"] == []
        assert res["cursor"] == -1

    asyncio.run(main())


def test_endpoint_payload_includes_kind_and_meta():
    async def main():
        import api.v1.notifications as notifications

        ns.push("完成了", "你的视频剪好了", kind="media_job_done", job_id="j1")
        res = await notifications.list_notifications(after=-1)
        item = res["items"][0]
        assert item["kind"] == "media_job_done"
        assert item["meta"] == {"job_id": "j1"}

    asyncio.run(main())
