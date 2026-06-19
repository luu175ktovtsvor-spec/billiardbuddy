"""SH-3 · 工具结果落盘（persisted-output，给路径而非硬截断）。

锁住：
- 小结果（<=阈值）不落盘、原样回灌
- 大查询结果（非 deliverable、非 read_only）落盘 + 回灌含 <persisted-output> 路径 + 预览
- deliverable 大结果不落盘不截断（成品给老板的，原样全量）
- read_only（自读类）大结果不落盘，退回硬截断（落了还得再 read 一遍，无意义）
- tool.max_result_chars 覆盖全局默认阈值
- 落盘走 UPLOAD_DIR（不是 app 包内只读区）
- read_file 能读回落盘文件（沙箱白名单放行 tool-results/）
"""
import os

import pytest

from config import settings
from services.agent.context import AgentContext
from services.agent.loop import _cap_tool_result, _MAX_TOOL_RESULT_CHARS
from services.agent.registry import Tool
from services.agent import tool_result_store as trs


class _FakeStore:
    id = "store-abc-123"


@pytest.fixture
def upload(tmp_path, monkeypatch):
    """把 UPLOAD_DIR 指向临时目录，隔离真实 uploads。"""
    up = tmp_path / "uploads"
    up.mkdir()
    monkeypatch.setattr(settings, "upload_dir", str(up))
    return up


def _tool(**kw):
    base = dict(name="big_query", description="x", parameters={"type": "object", "properties": {}},
                handler=lambda a, c: None)
    base.update(kw)
    return Tool(**base)


def test_small_result_not_persisted(upload):
    tool = _tool()
    ctx = AgentContext(store=_FakeStore())
    out = _cap_tool_result(tool, "短结果", ctx)
    assert out == "短结果"
    assert not (upload / trs.TOOL_RESULTS_DIRNAME).exists()


def test_large_non_deliverable_persisted(upload):
    tool = _tool(read_only=False)
    ctx = AgentContext(store=_FakeStore())
    big = "数" * (_MAX_TOOL_RESULT_CHARS + 5000)
    out = _cap_tool_result(tool, big, ctx)
    assert "<persisted-output>" in out and "</persisted-output>" in out
    assert "read_file" in out  # 提示用 read 读全
    assert "开头预览" in out
    # 真落盘了，且在 UPLOAD_DIR/tool-results 下
    files = list((upload / trs.TOOL_RESULTS_DIRNAME).rglob("*.txt"))
    assert len(files) == 1
    assert files[0].read_text(encoding="utf-8") == big  # 全量落盘、不丢信息


def test_deliverable_large_not_capped(upload):
    tool = _tool(deliverable=True)
    ctx = AgentContext(store=_FakeStore())
    big = "成" * (_MAX_TOOL_RESULT_CHARS + 5000)
    out = _cap_tool_result(tool, big, ctx)
    assert out == big  # 成品原样全量，不截不落盘
    assert not (upload / trs.TOOL_RESULTS_DIRNAME).exists()


def test_read_only_large_truncated_not_persisted(upload):
    """自读类（read_only）大结果落盘没意义 → 退回硬截断。"""
    tool = _tool(read_only=True)
    ctx = AgentContext(store=_FakeStore())
    big = "查" * (_MAX_TOOL_RESULT_CHARS + 5000)
    out = _cap_tool_result(tool, big, ctx)
    assert "已截断" in out
    assert "<persisted-output>" not in out
    assert not (upload / trs.TOOL_RESULTS_DIRNAME).exists()


def test_max_result_chars_override(upload):
    """tool.max_result_chars 设很小 → 提前落盘。"""
    tool = _tool(read_only=False, max_result_chars=100)
    ctx = AgentContext(store=_FakeStore())
    text = "字" * 500  # 远低于全局默认，但超过 tool 自设的 100
    out = _cap_tool_result(tool, text, ctx)
    assert "<persisted-output>" in out


def test_persist_lands_under_upload_dir(upload):
    path, preview = trs.persist("diag", "x" * 1000, AgentContext(store=_FakeStore()))
    assert str(upload) in path
    assert trs.TOOL_RESULTS_DIRNAME in path
    assert preview == ("x" * 1000)[:600]


@pytest.mark.asyncio
async def test_read_file_can_read_back_persisted(upload, tmp_path, monkeypatch):
    """落盘文件能被 read_file 读回（沙箱白名单放行 tool-results/）——否则模型读不回自己的结果。"""
    # 内容库指别处，确认放行靠的是 tool-results 白名单而非内容库
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "lib"))
    from services.agent import local_tools as lt

    ctx = AgentContext(store=_FakeStore())
    big = "完整诊断报告内容" * 2000
    path, _ = trs.persist("diag", big, ctx)

    # _resolve 放行（不抛越界）
    resolved = lt._resolve(path, ctx)
    assert str(resolved) == str(resolved)  # 没抛即放行
    # read_file 真读得回全量
    content = await lt.read_file({"path": path}, ctx)
    assert content == big


def test_resolve_denies_outside_still(upload, tmp_path, monkeypatch):
    """加了 tool-results 白名单后，库外未授权文件仍然拒绝（白名单没放宽别的）。"""
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "lib"))
    from services.agent import local_tools as lt
    outside = tmp_path / "secret.txt"
    outside.write_text("s")
    with pytest.raises(ValueError):
        lt._resolve(str(outside), AgentContext())
