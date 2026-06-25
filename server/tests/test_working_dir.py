from pathlib import Path
from types import SimpleNamespace

import pytest

from services.agent.context import AgentContext
from services.agent.local_tools import _resolve
from api.v1.agent import AgentChatRequest, AgentExecuteRequest, compose_agent_system_prompt


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
