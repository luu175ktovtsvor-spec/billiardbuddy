"""配置驱动 Hooks 测试（settings.json command 钩子 · 匹配/阻断/门控）。"""
import asyncio

from services.agent import hooks, hooks_config as hc
from services.agent.hooks import run_pre_tool_hooks


def test_matches():
    assert hc._matches("*", "anything")
    assert hc._matches("", "anything")
    assert hc._matches("run_command", "run_command")
    assert hc._matches("Write|run_command", "run_command")
    assert not hc._matches("Write", "run_command")
    assert hc._matches("computer_*", "computer_control")


def test_run_command_hook_block_exit2():
    blocked, msg = hc._run_command_hook("echo nope >&2; exit 2", {"x": 1})
    assert blocked is True
    assert "nope" in msg


def test_run_command_hook_block_json():
    blocked, msg = hc._run_command_hook("echo '{\"decision\":\"block\",\"reason\":\"挡住\"}'", {})
    assert blocked is True
    assert "挡住" in msg


def test_run_command_hook_allow():
    blocked, _ = hc._run_command_hook("echo ok", {})
    assert blocked is False


def test_install_pre_hook_blocks(monkeypatch):
    hooks.clear_hooks()
    monkeypatch.setattr(hc, "_load_hooks_config", lambda paths=None: {
        "PreToolUse": [{"matcher": "run_command", "hooks": [{"type": "command", "command": "exit 2"}]}]
    })
    n = hc.install_config_hooks(force=True)
    assert n == 1
    assert asyncio.run(run_pre_tool_hooks("run_command", {}, None)) is not None  # 命中→拦
    assert asyncio.run(run_pre_tool_hooks("read_file", {}, None)) is None  # 不命中→放行
    hooks.clear_hooks()


def test_event_command_hook_context():
    block, ctx = hc._run_event_command_hook("echo 注入的上下文", {})
    assert block is None
    assert ctx == "注入的上下文"


def test_event_command_hook_block():
    block, _ = hc._run_event_command_hook("exit 2", {})
    assert block is not None


def test_install_user_prompt_hook(monkeypatch):
    hooks.clear_hooks()
    monkeypatch.setattr(hc, "_load_hooks_config", lambda paths=None: {
        "UserPromptSubmit": [{"matcher": "*", "hooks": [{"type": "command", "command": "echo extra-ctx"}]}]
    })
    assert hc.install_config_hooks(force=True) == 1
    block, ctx = asyncio.run(hooks.run_event_hooks("UserPromptSubmit", {"prompt": "x"}))
    assert block is None and ctx == "extra-ctx"
    hooks.clear_hooks()


def test_install_disabled_without_env(monkeypatch):
    hooks.clear_hooks()
    monkeypatch.setattr(hc, "_load_hooks_config", lambda paths=None: {
        "PreToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": "exit 2"}]}]
    })
    monkeypatch.delenv("DESKTOP_CONFIG_HOOKS", raising=False)
    assert hc.install_config_hooks() == 0  # env 未设 → 不装
    hooks.clear_hooks()
