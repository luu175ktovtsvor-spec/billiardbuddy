# -*- coding: utf-8 -*-
"""店脑防膨胀上限的纯逻辑单测（无 API/DB，进主套件）。"""
from services.memory_service import (
    Memory,
    _cap_memories,
    _EPISODIC_CAP,
    _TOTAL_CAP,
    with_store_brain,
    format_memories_for_prompt,
)


def test_durable_all_kept_episodic_capped():
    mems = (
        [Memory("semantic", f"事实{i}") for i in range(8)]
        + [Memory("preference", f"偏好{i}") for i in range(4)]
        + [Memory("episodic", f"事件{i}") for i in range(60)]
    )
    out = _cap_memories(mems)
    # 耐久类(事实/偏好/运营)全留
    assert len([m for m in out if m.type == "semantic"]) == 8
    assert len([m for m in out if m.type == "preference"]) == 4
    # 情景类被限
    assert len([m for m in out if m.type == "episodic"]) <= _EPISODIC_CAP


def test_episodic_keeps_most_recent():
    mems = [Memory("episodic", f"事件{i}") for i in range(40)]
    out = _cap_memories(mems)
    # 保留的是靠后(最近整合)的那批
    assert out[-1].content == "事件39"
    assert len(out) <= _EPISODIC_CAP


def test_total_hard_cap():
    mems = [Memory("preference", f"偏好{i}") for i in range(300)]
    assert len(_cap_memories(mems)) <= _TOTAL_CAP


def test_small_list_unchanged():
    mems = [Memory("semantic", "无包厢"), Memory("preference", "熟人口吻")]
    assert len(_cap_memories(mems)) == 2


# ── with_store_brain：店脑追加到 prompt 末尾（供 run_generation 等非流式路径复用）──

def test_with_store_brain_appends_at_end():
    """有记忆时：店脑文本追加到 prompt 末尾，原 prompt 保持为前缀（保证近因效应）。"""
    base = "你是台球房运营专家，请写一条朋友圈。"
    mems = [Memory("semantic", "本店没有包厢"), Memory("semantic", "台费60元/小时")]
    out = with_store_brain(base, mems)
    assert out.startswith(base), "原 prompt 必须在前，店脑在后（末尾）"
    assert out.endswith(format_memories_for_prompt(mems)), "店脑必须在 prompt 最末尾"
    assert "本店没有包厢" in out and "台费60元/小时" in out


def test_with_store_brain_empty_unchanged():
    """空记忆时：prompt 原样返回，不加任何前后缀（新店无记忆不受影响）。"""
    base = "随便写点啥"
    assert with_store_brain(base, []) == base
