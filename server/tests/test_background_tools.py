"""后台任务测试：缺参 + 硬门控(完全访问模式) + 危险命令黑名单 + 禁 shell 操作符 + 预览 + 真起一条短命令。

run_background 的安全护栏必须跟 local_tools.run_command 同一套（见 background_tools.py 头部注释），
这里锁住：没开完全访问模式不能跑、危险命令照样拦、shell 操作符照样拒、审批卡预览显示命令原文。
"""
import asyncio
from types import SimpleNamespace

from services.agent import background_tools as bt
from services.agent.registry import ToolRegistry


def _ctx(full_disk_access: bool = True):
    return SimpleNamespace(full_disk_access=full_disk_access)


def test_run_background_missing_command():
    out = asyncio.run(bt._run_background_handler({}, _ctx()))
    assert "[参数缺失]" in out


def test_run_background_missing_command_even_without_ctx():
    # command 缺失的检查在门控之前，None ctx 也不该崩
    out = asyncio.run(bt._run_background_handler({}, None))
    assert "[参数缺失]" in out


# ────────────────────────────── 硬门控：没开完全访问模式不能跑 ──────────────────────────────

def test_run_background_blocked_without_full_disk_access():
    out = asyncio.run(bt._run_background_handler({"command": "echo hi"}, _ctx(full_disk_access=False)))
    assert "完全访问模式" in out


def test_run_background_blocked_when_ctx_none():
    # ctx=None 时 getattr(ctx, "full_disk_access", False) 兜底 False → 一样拦
    out = asyncio.run(bt._run_background_handler({"command": "echo hi"}, None))
    assert "完全访问模式" in out


# ────────────────────────────── 危险命令黑名单 / 禁 shell 操作符 ──────────────────────────────

def test_run_background_blocks_dangerous_command():
    out = asyncio.run(bt._run_background_handler({"command": "rm -rf /"}, _ctx()))
    assert "拒绝执行" in out


def test_run_background_blocks_env_leak():
    # 与 local_tools 同一套黑名单：裸 env 也该被拦（内置模型 key 在进程 env 里）
    out = asyncio.run(bt._run_background_handler({"command": "env"}, _ctx()))
    assert "拒绝执行" in out and "环境变量" in out


def test_run_background_rejects_shell_operators():
    out = asyncio.run(bt._run_background_handler({"command": "echo hi && rm -rf /"}, _ctx()))
    assert "拒绝执行" in out and "shell 操作符" in out


def test_run_background_bad_quotes_friendly():
    out = asyncio.run(bt._run_background_handler({"command": 'echo "unterminated'}, _ctx()))
    assert "命令解析失败" in out


# ────────────────────────────── 审批闸预览：显示命令原文 ──────────────────────────────

def test_run_background_registered_with_approval_and_preview():
    # 用独立 registry 显式注册（不依赖 DESKTOP_LOCAL 在本进程导入时是否已置 1，
    # 同 test_local_tools_full_agent.py 里 register_local_tools(reg) 的写法）。
    reg = ToolRegistry()
    bt.register_background_tools(reg)
    t = reg.get("run_background")
    assert t is not None
    assert t.requires_approval is True
    assert t.force_confirm is True
    assert t.preview is not None


def test_preview_shows_command_verbatim():
    preview = bt._preview_run_background({"command": "python3 build.py"}, _ctx())
    assert "python3 build.py" in preview


# ────────────────────────────── 真起一条短命令（不走 shell，靠 shlex.split + exec）──────────────────────────────

def test_run_background_runs_and_writes(monkeypatch, tmp_path):
    monkeypatch.setattr(bt, "_bg_dir", lambda: tmp_path)
    monkeypatch.setattr(bt, "_notify", lambda *a, **k: None)  # 别真弹通知

    async def _run():
        out = await bt._run_background_handler({"command": "echo hi"}, _ctx())
        assert "后台启动" in out
        await asyncio.sleep(0.8)  # 等 watcher 跑完落盘

    asyncio.run(_run())
    files = list(tmp_path.glob("*.txt"))
    assert len(files) == 1
    content = files[0].read_text(encoding="utf-8")
    assert "echo hi" in content
    assert "hi" in content


def test_run_background_command_not_found_friendly(tmp_path, monkeypatch):
    monkeypatch.setattr(bt, "_bg_dir", lambda: tmp_path)
    out = asyncio.run(bt._run_background_handler({"command": "this-binary-does-not-exist-xyz"}, _ctx()))
    assert "找不到这个命令" in out
