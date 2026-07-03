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


# ── M4尾巴② 接地校验阈值误杀重度改写 ────────────────────────────

class TestGroundingCheckHeavyRewrite:
    def test_heavy_rewrite_grounded_memory_no_longer_falsely_rejected(self):
        """改好了:重度改写但忠于源文的记忆——原 30% 字面阈值会误杀(实测比例 0.242)，
        降阈值到 20% 后应通过（没编造新信息，只是换了说法）。"""
        m = Memory("operational", "周二给老会员打五折优惠台费")
        source = "我们球房这周二会员日搞活动台费打五折老会员来的可以享受"
        assert _grounding_check(m, source) is True

    def test_fabricated_memory_still_rejected_guardrail_intact(self):
        """护栏还在:凭空脑补、源文完全没提的信息依然被拒——不因为阈值下调就放水。"""
        m = Memory("semantic", "门店给客人私下陪伴服务")
        assert _grounding_check(m, "帮我做一张海报") is False

    def test_hard_signal_number_mismatch_rejected_even_with_high_literal_overlap(self):
        """护栏还在(硬信号判据):记忆里编了一个源文没提过的具体数字，
        哪怕字面短语整体重叠很高，也要判定脑补——数字/长英文串是改写不会变的强证据。"""
        m = Memory("semantic", "门店台费100元每小时")
        source = "门店台费元每小时是我们定的价"  # 源文没提具体数字
        assert _grounding_check(m, source) is False


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


# ── M4尾巴① 一次性任务不再整句跳过(按小句拆,漏混合句里的门店事实) ──────

@pytest.mark.asyncio
async def test_extract_mixed_sentence_not_fully_skipped():
    """改好了:混合句(一次性任务+门店事实)按小句拆——只要有一句不像纯任务就照常送抽取器，
    不再因为整句"像"一次性指令就把尾部的门店事实一起丢掉。"""
    fake_response = {"memories": [
        {"type": "operational", "content": "周二会员日台费五折", "confidence": "high"},
    ]}
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value=fake_response) as mock_call:
        result = await extract_memories("帮我写个海报，对了我们店周二会员日台费五折")
        mock_call.assert_called_once()  # 有一句带门店事实 → 没被整句跳过、照常送 LLM
        contents = [m.content for m in result]
        assert "周二会员日台费五折" in contents


@pytest.mark.asyncio
async def test_extract_pure_one_off_task_still_skipped_guardrail_intact():
    """护栏还在:纯一次性任务(单句)仍整句跳过、不调 LLM、不白烧成本。"""
    with patch.object(ms, "_json_call", new_callable=AsyncMock) as mock_call:
        result = await extract_memories("帮我做一张海报")
        mock_call.assert_not_called()
        assert result == []


@pytest.mark.asyncio
async def test_extract_multi_clause_all_tasks_still_skipped_guardrail_intact():
    """护栏还在:多个小句全都是一次性任务(没夹带事实)时也整句跳过，
    不是"一有逗号就送 LLM"的粗糙判断。"""
    with patch.object(ms, "_json_call", new_callable=AsyncMock) as mock_call:
        result = await extract_memories("帮我做一张海报，写一条朋友圈文案")
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
async def test_consolidate_failure_keeps_new_memories():
    """M4尾巴③修复:整合失败(LLM偶发失败/超时返回空)时不再把新记忆整批丢掉——
    改好了:走【有界兜底】，existing+new 按 content 去重后拼上，新记忆必须还在、旧记忆也不丢。"""
    existing = [Memory("semantic", "台费60元"), Memory("semantic", "有6张台")]
    new = [Memory("semantic", "台费涨到80了")]
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value={}):
        result = await consolidate_memories(existing, new)
        contents = [m.content for m in result]
        assert "台费涨到80了" in contents, "新记忆不该被丢——这正是本次要修的问题"
        assert "台费60元" in contents and "有6张台" in contents, "旧记忆也该保留(是追加不是替换)"
        assert len(result) == 3


@pytest.mark.asyncio
async def test_consolidate_failure_dedupes_duplicate_content():
    """有界兜底不是无脑 union——同一条内容不能重复出现两份。"""
    existing = [Memory("semantic", "台费60元")]
    new = [Memory("semantic", "台费60元")]  # 内容与已有完全相同
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value={}):
        result = await consolidate_memories(existing, new)
        assert len(result) == 1


@pytest.mark.asyncio
async def test_consolidate_failure_still_capped_guardrail_intact():
    """护栏还在:兜底追加后依然必须过 _cap_memories 封顶，不能因为"不丢新记忆"就无限膨胀。
    构造超过 _EPISODIC_CAP(25) 的场景验证:新记忆没丢、总数也没膨胀。"""
    existing = [Memory("episodic", f"旧情景{i}") for i in range(30)]  # 已超情景类上限
    new = [Memory("episodic", "刚发生的新情景")]
    with patch.object(ms, "_json_call", new_callable=AsyncMock, return_value={}):
        result = await consolidate_memories(existing, new)
        assert len(result) <= ms._EPISODIC_CAP, "护栏(情景类上限)必须还在，不能无限膨胀"
        assert any(m.content == "刚发生的新情景" for m in result), "封顶后新记忆依然没丢"


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
