"""agent 会话/最近作品列表分组逻辑。"""
import asyncio
import types
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker

import models  # noqa: F401  触发全模型注册
from api.v1.agent import _group_agent_conversations, _recent_artifact_item
from core.tenant import set_tenant
from db.base import Base
from models.generation import Generation
from models.store import Store
from models.user import User


def _row(cid, msg, day, title=None):
    return types.SimpleNamespace(
        conversation_id=cid,
        input_params={"message": msg},
        title=title,
        created_at=datetime(2026, 6, day, 10, 0, 0),
    )


def test_group_by_conversation_title_is_first_message():
    # 端点按 created_at 倒序传入
    rows = [
        _row("c2", "续问：再来一张", 19),   # c2 最新
        _row("c2", "做张海报", 18),         # c2 最早 → 标题取这句
        _row("c1", "这个月经营怎么样", 17),
    ]
    out = _group_agent_conversations(rows)
    assert len(out) == 2
    assert out[0]["conversation_id"] == "c2"      # 最新会话在前
    assert out[0]["title"] == "做张海报"          # 标题=会话第一句
    assert out[1]["title"] == "这个月经营怎么样"


def test_title_truncated_and_title_field_wins():
    long_msg = "这是一句非常非常长的需求描述" * 5
    rows = [_row("c1", long_msg, 19, title="店主自己起的名")]
    out = _group_agent_conversations(rows)
    assert out[0]["title"] == "店主自己起的名"     # Generation.title 优先于 message
    # 没 title 时截断到 30
    rows2 = [_row("c2", long_msg, 19)]
    assert len(_group_agent_conversations(rows2)[0]["title"]) == 30


def test_recent_artifact_poster_includes_size_and_ratio():
    cid = uuid.uuid4()
    g = types.SimpleNamespace(
        id=uuid.uuid4(),
        type="poster",
        title=None,
        sub_type="9:16",
        result="/uploads/posters/p.jpg",
        conversation_id=cid,
        created_at=datetime(2026, 6, 28, tzinfo=timezone.utc),
        input_params={"prompt": "周赛海报", "ratio": "9:16", "width": 1152, "height": 2048},
    )
    item = _recent_artifact_item(g)
    assert item["kind"] == "poster"
    assert item["title"] == "周赛海报"
    assert item["url"] == "/uploads/posters/p.jpg"
    assert item["ratio"] == "9:16"
    assert item["width"] == 1152 and item["height"] == 2048
    assert item["conversation_id"] == str(cid)


def test_recent_artifact_agent_is_task_with_content_preview():
    g = types.SimpleNamespace(
        id=uuid.uuid4(),
        type="agent",
        title=None,
        sub_type="chat",
        result="我已经整理好了文件清单",
        conversation_id=uuid.uuid4(),
        created_at=datetime(2026, 6, 28, tzinfo=timezone.utc),
        input_params={"message": "整理这个文件夹"},
    )
    item = _recent_artifact_item(g)
    assert item["kind"] == "task"
    assert item["title"] == "整理这个文件夹"
    assert item["subtitle"] == "最近任务"
    assert item["content"] == "我已经整理好了文件清单"


def test_saved_artifact_is_content_item():
    g = types.SimpleNamespace(
        id=uuid.uuid4(),
        type="workbench",
        title="今晚拉客清单",
        sub_type="saved_text",
        result="1. 前厅今晚 7 点前发客户群",
        conversation_id=uuid.uuid4(),
        created_at=datetime(2026, 6, 28, tzinfo=timezone.utc),
        input_params={"source": "assistant_action"},
    )
    item = _recent_artifact_item(g)
    assert item["kind"] == "content"
    assert item["title"] == "今晚拉客清单"
    assert item["subtitle"] == "文案作品"
    assert item["content"] == "1. 前厅今晚 7 点前发客户群"


def test_get_agent_conversation_roundtrips_display_text():
    """C2 历史回放半：input_params.display_text 落库后，GET /conversations/{id} 要把它当
    display_content 带出来；没落 display_text 的老 Generation 回放时不带该字段（向后兼容）。"""
    async def main():
        eng = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with eng.begin() as c:
            await c.run_sync(Base.metadata.create_all)
        Session = async_sessionmaker(eng, expire_on_commit=False)
        store_id, conv_id = uuid.uuid4(), uuid.uuid4()
        set_tenant(store_id)
        try:
            async with Session() as db:
                u = User(id=uuid.uuid4(), phone="13800000001", password_hash="x", name="tester")
                db.add(u)
                await db.flush()
                db.add(Store(id=store_id, owner_id=u.id, name="本店"))
                await db.flush()
                # 显式给两个不同的 created_at，避免同一批 flush 时间戳相同导致 order_by 排序不稳（测试抖动）。
                db.add(Generation(
                    id=uuid.uuid4(), store_id=store_id, type="agent", sub_type="chat",
                    conversation_id=conv_id,
                    input_params={"message": "帮我把当前屏幕的情况分析一下，写份简要诊断报告给我", "display_text": "看当前屏幕"},
                    result="诊断已完成",
                    model_used="agent",
                    created_at=datetime(2026, 6, 30, 10, 0, 0, tzinfo=timezone.utc),
                ))
                db.add(Generation(
                    id=uuid.uuid4(), store_id=store_id, type="agent", sub_type="chat",
                    conversation_id=conv_id,
                    input_params={"message": "这个月经营怎么样"},  # 老会话：没有 display_text
                    result="本月流水……",
                    model_used="agent",
                    created_at=datetime(2026, 6, 30, 10, 1, 0, tzinfo=timezone.utc),
                ))
                await db.commit()

                from api.v1.agent import get_agent_conversation
                res = await get_agent_conversation(str(conv_id), user=None,
                                                   store=SimpleNamespace(id=store_id), db=db)
                user_msgs = [m for m in res["messages"] if m["role"] == "user"]
                assert len(user_msgs) == 2
                # 带 display_text 的那条：回放要带 display_content，且等于落库时的短标签
                first = user_msgs[0]
                assert first["content"] == "帮我把当前屏幕的情况分析一下，写份简要诊断报告给我"
                assert first["display_content"] == "看当前屏幕"
                # 没 display_text 的老会话：不带 display_content 字段（向后兼容，前端据此落回 content 全文）
                second = user_msgs[1]
                assert second["content"] == "这个月经营怎么样"
                assert "display_content" not in second
        finally:
            set_tenant(None)

    asyncio.run(main())
