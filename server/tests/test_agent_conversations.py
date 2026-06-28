"""agent 会话/最近作品列表分组逻辑。"""
import types
import uuid
from datetime import datetime, timezone

from api.v1.agent import _group_agent_conversations, _recent_artifact_item


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
