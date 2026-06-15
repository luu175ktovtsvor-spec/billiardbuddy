# -*- coding: utf-8 -*-
"""海报对话详情对非法 conversation_id 的防御。

非法 UUID（用户手改 URL）必须在碰库前就返回 None → 端点转 404，
而不是 uuid.UUID() 抛 ValueError → 500。非法路径提前返回，故无需真实 DB。
"""
from services.poster_service import get_conversation_detail


async def test_invalid_conversation_id_returns_none():
    assert await get_conversation_detail(None, None, "not-a-uuid") is None


async def test_empty_conversation_id_returns_none():
    assert await get_conversation_detail(None, None, "") is None
