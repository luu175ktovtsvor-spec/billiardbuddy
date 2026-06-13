"""#1 日期注入：生成上下文必须带"今天/星期/本周末"，AI 才不靠猜算日期。
TDD：本测试先于实现编写，应先红（build_date_context 尚不存在）。"""
import re
from datetime import datetime

from models.store import Store
from services.ai.prompt_engine import build_date_context, get_prompt_engine


def test_date_context_includes_today_weekday_and_weekend():
    # 2026-06-13 是周六
    ctx = build_date_context(datetime(2026, 6, 13))
    assert ctx["today_date"] == "2026-06-13"
    assert ctx["weekday_cn"] == "周六"
    # "本周末"应同时覆盖本周六(6/13)和周日(6/14)，治"周末两天排成周日+周一"的滑
    assert "6月13日" in ctx["this_weekend"]
    assert "6月14日" in ctx["this_weekend"]


def test_date_context_weekend_from_a_weekday():
    # 2026-06-17 是周三，本周末仍应指向 6/20(六) 与 6/21(日)
    ctx = build_date_context(datetime(2026, 6, 17))
    assert ctx["weekday_cn"] == "周三"
    assert "6月20日" in ctx["this_weekend"]
    assert "6月21日" in ctx["this_weekend"]


def test_render_injects_date_header_for_generation_template():
    # 生成类模板（如朋友圈）渲染时应带上"今天/星期"锚点，AI 才不瞎算日期
    out = get_prompt_engine().render("copywriting.moments", Store(), {}, lenient=True)
    assert "【当前时间】" in out
    assert re.search(r"20\d\d-\d\d-\d\d", out)
    assert any(w in out for w in ["周一", "周二", "周三", "周四", "周五", "周六", "周日"])


def test_render_does_not_inject_date_into_knowledge_template():
    # 知识库类模板不该被塞日期头（只生成类需要）
    out = get_prompt_engine().render("knowledge.core_operations", Store(), {}, lenient=True)
    assert "【当前时间】" not in out
