"""#3 控条数："只出一条"指令。生成默认会吐多个方案，执行岗想要精简一条。
TDD：先于实现编写，应先红（concise_directive 尚不存在）。"""
from services.content_service import concise_directive


def test_concise_directive_on_asks_for_single():
    s = concise_directive(True)
    assert "一条" in s
    # 明确不要多个方案/版本
    assert "方案" in s or "版本" in s


def test_concise_directive_off_is_empty():
    assert concise_directive(False) == ""
