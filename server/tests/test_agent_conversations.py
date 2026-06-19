"""agent 会话列表分组逻辑：按 conversation_id 分组，标题=会话第一句，最新会话在前。"""
import types
from datetime import datetime

from api.v1.agent import _group_agent_conversations


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
