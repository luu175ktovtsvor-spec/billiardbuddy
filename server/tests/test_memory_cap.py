# -*- coding: utf-8 -*-
"""店脑防膨胀上限的纯逻辑单测（无 API/DB，进主套件）。"""
from services.memory_service import Memory, _cap_memories, _EPISODIC_CAP, _TOTAL_CAP


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
