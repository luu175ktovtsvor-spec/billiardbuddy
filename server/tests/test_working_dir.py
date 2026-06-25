from services.agent.context import AgentContext
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
