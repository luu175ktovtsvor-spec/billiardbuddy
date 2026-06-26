# -*- coding: utf-8 -*-
"""M4 店脑记忆修复测试（#1接地+红线+任务跳过, #2去重不膨胀, #3本次对话优先, #4嵌入缓存）。"""
import json
from unittest.mock import AsyncMock, patch, MagicMock

import pytest

import services.memory_service as ms
from services.memory_service import (
    Memory,
    _grounding_check,
    _redline_filter,
    _is_one_off_task,
    _extract_key_phrases,
    extract_memories,
    consolidate_memories,
    format_memories_for_prompt,
    select_relevant_memories,
    _get_cached_embedding,
    _memories_hash,
)


# ── #1 接地校验 ──────────────────────────────────────────────────

class TestGroundingCheck:
    def test_grounded_memory_passes(self):
        m = Memory("semantic", "门店台费60元每小时")
        assert _grounding_check(m, "我们店台费60元每小时，包厢另算") is True

    def test_fabricated_memory_rejected(self):
        m = Memory("semantic", "门店给高消费客人私下陪伴服务")
        assert _grounding_check(m, "帮我做一张海报") is False

    def test_negation_grounded(self):
        m = Memory("semantic", "门店没有包厢")
        assert _grounding_check(m, "我们店没有包厢") is True

    def test_short_memory_passes(self):
        m = Memory("semantic", "有")
        assert _grounding_check(m, "有酒水") is True

    def test_partial_overlap_accepted(self):
        m = Memory("semantic", "门店位于商场三楼")
        assert _grounding_check(m, "我们店在商场三楼，旁边是电影院") is True


# ── #1 红线过滤 ──────────────────────────────────────────────────

class TestRedlineFilter:
    def test_normal_memory_passes(self):
        assert _redline_filter(Memory("semantic", "台费60元")) is True

    def test_sexual_service_blocked(self):
        assert _redline_filter(Memory("semantic", "提供陪伴服务")) is False

    def test_gambling_blocked(self):
        assert _redline_filter(Memory("operational", "老板在店里坐庄")) is False
        assert _redline_filter(Memory("operational", "赌博抽水")) is False

    def test_prostitution_blocked(self):
        assert _redline_filter(Memory("semantic", "陪侍服务")) is False


# ── #1 一次性任务跳过 ──────────────────────────────────────────

class TestOneOffTaskSkip:
    def test_task_request_detected(self):
        assert _is_one_off_task("帮我做一张海报") is True
        assert _is_one_off_task("做张海报") is True
        assert _is_one_off_task("写一篇朋友圈文案") is True
        assert _is_one_off_task("画一张图") is True
        assert _is_one_off_task("生成一个活动方案") is True

    def test_store_fact_not_task(self):
        assert _is_one_off_task("我们店台费60元") is False
        assert _is_one_off_task("周一到周五下午客人比较少") is False

    def test_long_text_not_task(self):
        assert _is_one_off_task("帮我做一张海报，要包含以下内容：" + "详细描述" * 20) is False


@pytest.mark.asyncio
async def test_extract_skips_task_request():
    """一次性任务诉求不应产生记忆。"""
    with patch.object(ms, "_json_call", new_callable=AsyncMock) as mock_call:
        mock_call.return_value = {"memories": [{"type": "semantic", "content": "门店需要做海报", "confidence": "medium"}]}
        result = await extract_memories("做张海报")
        mock_call.assert_not_called()
        assert result == []


@pytest.mark.asyncio
async def test_extract_applies_grounding_and_redline():
    """抽取后接地校验和红线过滤都生效。"""
    fake_response = {"memories": [
        {"type": "semantic", "content": "门店台费60元", "confidence": "high"},
        {"type": "semantic", "content": "门店给客人私下陪伴服务", "confidence": "medium"},
        {"type": "semantic", "content": "门店有高级洗浴中心配套设施完善", "confidence": "medium"},
    ]}
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value=fake_response):
        result = await extract_memories("我们店台费60元每小时")
        contents = [m.content for m in result]
        assert "门店台费60元" in contents
        assert "门店给客人私下陪伴服务" not in contents


# ── #2 去重不膨胀 ──────────────────────────────────────────────

@pytest.mark.asyncio
async def test_consolidate_no_union_on_failure():
    """整合失败时保留旧集合，不做 union（止膨胀的根源）。"""
    existing = [Memory("semantic", "台费60元"), Memory("semantic", "有6张台")]
    new = [Memory("semantic", "台费涨到80了")]
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value={}):
        result = await consolidate_memories(existing, new)
        assert len(result) == 2
        assert result == existing


@pytest.mark.asyncio
async def test_consolidate_success_uses_merged():
    """整合成功时用合并结果。"""
    existing = [Memory("semantic", "台费60元")]
    new = [Memory("semantic", "台费涨到80了")]
    merged_response = {"memories": [
        {"type": "semantic", "content": "台费80元", "confidence": "high"},
    ]}
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value=merged_response):
        result = await consolidate_memories(existing, new)
        assert len(result) == 1
        assert result[0].content == "台费80元"


@pytest.mark.asyncio
async def test_consolidate_uses_higher_max_tokens():
    """整合调用的 max_tokens 应该足够大（不再是 900）。"""
    existing = [Memory("semantic", f"事实{i}") for i in range(50)]
    new = [Memory("semantic", "新事实")]
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value={"memories": []}) as mock_call:
        await consolidate_memories(existing, new)
        call_args = mock_call.call_args
        assert call_args.kwargs.get("max_tokens", call_args.args[3] if len(call_args.args) > 3 else 900) >= 4096


# ── #3 本次对话优先 ──────────────────────────────────────────────

class TestCurrentConversationPriority:
    def test_injection_mentions_current_conversation_priority(self):
        mems = [Memory("semantic", "台费60元")]
        text = format_memories_for_prompt(mems)
        assert "本次对话" in text
        assert "优先" in text

    def test_injection_has_example(self):
        mems = [Memory("semantic", "台费60元")]
        text = format_memories_for_prompt(mems)
        assert "用户" in text and "为准" in text


# ── #4 嵌入缓存 ──────────────────────────────────────────────────

class TestEmbeddingCache:
    def test_memories_hash_stable(self):
        mems = [Memory("semantic", "台费60元"), Memory("semantic", "有包厢")]
        h1 = _memories_hash(mems)
        h2 = _memories_hash(mems)
        assert h1 == h2

    def test_memories_hash_changes_on_content_change(self):
        mems1 = [Memory("semantic", "台费60元")]
        mems2 = [Memory("semantic", "台费80元")]
        assert _memories_hash(mems1) != _memories_hash(mems2)

    def test_cached_embedding_reuses(self):
        mock_emb = MagicMock()
        mock_emb.embed.return_value = [0.1, 0.2, 0.3]
        ms._embed_cache.clear()
        ms._embed_cache_hash = ""

        key = "test_hash_1"
        r1 = _get_cached_embedding(mock_emb, "台费60元", key)
        r2 = _get_cached_embedding(mock_emb, "台费60元", key)
        assert r1 == r2
        assert mock_emb.embed.call_count == 1

    def test_cache_invalidated_on_new_hash(self):
        mock_emb = MagicMock()
        mock_emb.embed.return_value = [0.1, 0.2, 0.3]
        ms._embed_cache.clear()
        ms._embed_cache_hash = ""

        _get_cached_embedding(mock_emb, "台费60元", "hash_a")
        _get_cached_embedding(mock_emb, "台费60元", "hash_b")
        assert mock_emb.embed.call_count == 2
