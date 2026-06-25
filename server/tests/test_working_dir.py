from pathlib import Path
from types import SimpleNamespace

import pytest

from services.agent.context import AgentContext
from services.agent.local_tools import _resolve, path_in_workspace
from api.v1.agent import AgentChatRequest, AgentExecuteRequest, compose_agent_system_prompt
from services.agent.loop import _auto_approve
from services.agent.registry import Tool


def test_agent_context_working_dir_default_none():
    assert AgentContext().working_dir is None
    assert AgentContext(working_dir="/Users/me/proj").working_dir == "/Users/me/proj"


def test_chat_and_execute_request_accept_working_dir():
    assert AgentChatRequest(message="hi", working_dir="/tmp/x").working_dir == "/tmp/x"
    assert AgentExecuteRequest(tool="write_file", working_dir="/tmp/x").working_dir == "/tmp/x"


def test_working_dir_injected_into_system_prompt():
    p = compose_agent_system_prompt("", "", working_dir="/Users/me/proj")
    assert "当前工作目录" in p and "/Users/me/proj" in p


def test_no_working_dir_no_injection():
    assert "当前工作目录" not in compose_agent_system_prompt("", "")
    assert "当前工作目录" not in compose_agent_system_prompt("", "", working_dir="")
    assert "当前工作目录" not in compose_agent_system_prompt("", "", working_dir="   ")  # 纯空白也不注入(strip 守卫)


def test_resolve_relative_base_is_working_dir(tmp_path):
    wd = tmp_path / "proj"; wd.mkdir()
    ctx = SimpleNamespace(working_dir=str(wd), allowed_paths=[], full_disk_access=False)
    assert _resolve("note.md", ctx) == (wd / "note.md").resolve()


def test_resolve_allows_inside_working_dir(tmp_path):
    wd = tmp_path / "proj"; (wd / "sub").mkdir(parents=True)
    ctx = SimpleNamespace(working_dir=str(wd), allowed_paths=[], full_disk_access=False)
    assert _resolve(str(wd / "sub" / "a.txt"), ctx) == (wd / "sub" / "a.txt").resolve()


def test_resolve_rejects_outside_when_sandboxed(tmp_path):
    wd = tmp_path / "proj"; wd.mkdir()
    outside = tmp_path / "other" / "x.txt"
    ctx = SimpleNamespace(working_dir=str(wd), allowed_paths=[], full_disk_access=False)
    with pytest.raises(ValueError):
        _resolve(str(outside), ctx)


def test_path_in_workspace(tmp_path):
    wd = tmp_path / "proj"; wd.mkdir()
    sel = tmp_path / "picked.txt"; sel.write_text("x")
    ctx = SimpleNamespace(working_dir=str(wd), allowed_paths=[str(sel)], full_disk_access=False)
    assert path_in_workspace(str(wd / "a.md"), ctx) is True      # 工作目录内
    assert path_in_workspace("a.md", ctx) is True                # 相对→落工作目录
    assert path_in_workspace(str(sel), ctx) is True              # 选定文件
    assert path_in_workspace(str(tmp_path / "nope.txt"), ctx) is False  # 区外
    assert path_in_workspace("", ctx) is False                   # 空→安全 False


def _file_tool():
    return Tool(name="edit_file", description="", parameters={}, handler=lambda a, c: "",
                requires_approval=True, approval_class="file")


def test_auto_approve_scopes_to_workspace(tmp_path):
    wd = tmp_path / "proj"; wd.mkdir()
    ctx = SimpleNamespace(permission_mode="auto_files", working_dir=str(wd),
                          allowed_paths=[], full_disk_access=False)
    t = _file_tool()
    assert _auto_approve(t, {"path": str(wd / "a.md")}, ctx) is True       # 区内→免确认
    assert _auto_approve(t, {"path": str(tmp_path / "out.md")}, ctx) is False  # 区外→弹卡
    assert _auto_approve(t, {}, ctx) is True                               # 无path的文件类→保守兼容(防回归)


def test_auto_approve_ask_mode_unchanged(tmp_path):
    ctx = SimpleNamespace(permission_mode="ask", working_dir=None, allowed_paths=[], full_disk_access=False)
    assert _auto_approve(_file_tool(), {"path": "a.md"}, ctx) is False
