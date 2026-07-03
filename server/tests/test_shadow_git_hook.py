# -*- coding: utf-8 -*-
"""F-12 影子 git PostToolUse 钩子接线：只对写改类工具触发、故障安全、正确关联进检查点索引。"""
import asyncio

import pytest

from services import shadow_git as sg
from services.agent import checkpoint_index as ci
from services.agent import local_tools as lt
from services.agent.context import AgentContext
from services.agent.hooks import clear_hooks, run_post_tool_hooks
from services.agent import shadow_git_hook as sgh
from services.agent.shadow_git_hook import install_shadow_git_hook, _shadow_git_post_hook

_CID = "11111111-1111-1111-1111-111111111111"


def _ensure_file_tools_registered():
    """F-12 复审 Important #1 修复后，`_is_write_tool` 动态查 `default_registry` 判
    `approval_class=="file"`——而 write_file/edit_file/edit_excel/delete_file/edit_image 只在
    `DESKTOP_LOCAL=1` 时于**模块导入那一刻**自动注册进这个进程级单例。单独跑本文件（不靠别的
    测试文件恰好先用 `monkeypatch.setenv("DESKTOP_LOCAL","1")` 导入过这两个模块）时，
    `default_registry` 里可能根本没有这几个工具，判据会全部落空。显式补注册一次（两个
    `register_*` 函数本身幂等，可放心重复调用），不赌全局测试收集顺序。"""
    from services.agent.local_tools import register_local_tools
    from services.agent.image_tools import register_image_tools
    register_local_tools()
    register_image_tools()


@pytest.fixture(autouse=True)
def _clean_hooks():
    # install_shadow_git_hook() 是幂等安装（同 goal_hook 写法，靠模块级 _installed 标记防重复注册）——
    # 但 clear_hooks() 会把 hooks.py 的注册表整个清空，若不同步复位 _installed，下一个测试调用
    # install_shadow_git_hook() 会因为"以为已经装过"而直接跳过、实际却没注册进（刚被清空的）表里。
    # 每个用例前后都强制复位，保证 install_shadow_git_hook() 在本文件每个测试里都真正生效。
    clear_hooks()
    sgh.reset_installed_flag_for_tests()
    sg.reset_git_probe_cache_for_tests()
    _ensure_file_tools_registered()
    yield
    clear_hooks()
    sgh.reset_installed_flag_for_tests()
    sg.reset_git_probe_cache_for_tests()


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    # sg.settings 和 transcript.py 的 settings 是同一个单例对象，这一处 monkeypatch 两边同时生效
    # （checkpoint_index.py 的 _transcript_dir 落点因此也自动指到同一个临时 uploads 目录）。
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    # ⚠️ 本文件会真的调用 lt.write_file/edit_file/delete_file——它们内部 `_backup()` 无论
    # working_dir 是什么，都固定写去 `_library_root()/.backups`（真实默认落点是开发机的
    # `~/.billiards-desktop/library`）！不隔离这个会把测试产物写进开发者真实的本机数据目录
    # （这里曾真的踩过一次，见工作报告 self-review 记录），必须连它一起指到临时目录。
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "library"))
    wd = tmp_path / "workdir"
    wd.mkdir()
    return wd


def test_install_is_idempotent():
    install_shadow_git_hook()
    install_shadow_git_hook()
    from services.agent.hooks import _POST_TOOL_HOOKS
    assert _POST_TOOL_HOOKS.count(_shadow_git_post_hook) == 1


def test_write_file_triggers_checkpoint_and_index(workspace):
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)

    async def main():
        args = {"path": "a.txt", "content": "hello"}
        result = await lt.write_file(args, ctx)
        await run_post_tool_hooks("write_file", args, result, ctx)

    asyncio.run(main())

    checkpoints = ci.list_checkpoints(_CID)
    assert len(checkpoints) == 1
    assert checkpoints[0]["tool"] == "write_file"
    assert checkpoints[0]["target"] == "a.txt"
    assert checkpoints[0]["sha"]


def test_read_only_tool_does_not_trigger_checkpoint(workspace):
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)
    (workspace / "a.txt").write_text("x", encoding="utf-8")

    async def main():
        result = await lt.read_file({"path": "a.txt"}, ctx)
        await run_post_tool_hooks("read_file", {"path": "a.txt"}, result, ctx)

    asyncio.run(main())
    assert ci.list_checkpoints(_CID) == []


def test_delete_edit_edit_excel_all_trigger_checkpoint(workspace):
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)

    async def main():
        a1 = {"path": "a.txt", "content": "v1"}
        r1 = await lt.write_file(a1, ctx)
        await run_post_tool_hooks("write_file", a1, r1, ctx)

        a2 = {"path": "a.txt", "old_text": "v1", "new_text": "v2"}
        r2 = await lt.edit_file(a2, ctx)
        await run_post_tool_hooks("edit_file", a2, r2, ctx)

        a3 = {"path": "a.txt"}
        r3 = await lt.delete_file(a3, ctx)
        await run_post_tool_hooks("delete_file", a3, r3, ctx)

    asyncio.run(main())
    checkpoints = ci.list_checkpoints(_CID)
    assert [c["tool"] for c in checkpoints] == ["write_file", "edit_file", "delete_file"]


def test_edit_image_triggers_checkpoint(workspace):
    """F-12 复审 Important #1 回归：edit_image 跟 write_file/edit_file/edit_excel/delete_file 一样，
    都是 `approval_class == "file"` 的写改类工具（image_tools.py 里登记），漏了它会导致"把海报裁个
    方形"这类高频操作进不了影子 git 历史。硬编码名单必须换成动态查 registry 的 approval_class 判据，
    这样以后任何新增的 file 类工具也自动被覆盖，不用再手改这份名单。"""
    from PIL import Image
    install_shadow_git_hook()  # edit_image 的注册由 autouse 的 _ensure_file_tools_registered() 保证
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)
    img_path = workspace / "poster.png"
    Image.new("RGB", (20, 10), color="red").save(img_path)

    async def main():
        from services.agent.image_tools import edit_image
        args = {"path": "poster.png", "operation": "resize", "scale": 0.5}
        result = await edit_image(args, ctx)
        await run_post_tool_hooks("edit_image", args, result, ctx)

    asyncio.run(main())

    checkpoints = ci.list_checkpoints(_CID)
    assert len(checkpoints) == 1
    assert checkpoints[0]["tool"] == "edit_image"
    assert checkpoints[0]["target"] == "poster.png"


def test_unknown_tool_name_does_not_trigger_checkpoint(workspace):
    """动态判据的反面：查不到的工具名（比如打错字/还没注册）应该保守当只读处理，不触发检查点、
    也不该因为 registry 查不到而抛异常。"""
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)

    async def main():
        await run_post_tool_hooks("这个工具名根本不存在", {"path": "a.txt"}, "随便", ctx)

    asyncio.run(main())
    assert ci.list_checkpoints(_CID) == []


def test_no_conversation_id_still_commits_but_skips_index(workspace):
    """新会话第一轮 ctx.conversation_id 还是 None——影子 git 快照仍应正常打上，只是不建索引。"""
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=None)

    async def main():
        args = {"path": "a.txt", "content": "hello"}
        result = await lt.write_file(args, ctx)
        await run_post_tool_hooks("write_file", args, result, ctx)

    asyncio.run(main())

    # 没建索引（没法按会话查）
    assert ci.list_checkpoints("") == []
    # 但影子库真的提交了
    shadow_dir = sg._shadow_repo_dir(workspace.resolve())
    assert (shadow_dir / "HEAD").exists()
    git = sg.git_binary_path()
    log = sg._run_git(git, ["log", "--oneline"], shadow_dir, workspace)
    assert log.stdout.strip() != ""


def test_hook_failure_is_swallowed_and_does_not_break_tool_result(workspace, monkeypatch):
    """检查点功能本身出岔子，绝不能连累主工具的执行结果。"""
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)

    def _boom(*a, **kw):
        raise RuntimeError("影子库炸了")

    monkeypatch.setattr(sg, "commit_checkpoint", _boom)

    async def main():
        args = {"path": "a.txt", "content": "hello"}
        result = await lt.write_file(args, ctx)
        # 不应该抛异常
        await run_post_tool_hooks("write_file", args, result, ctx)
        return result

    result = asyncio.run(main())
    assert "已写入" in result  # 工具本身的结果完全不受影响


def test_no_git_available_hook_is_noop(workspace, monkeypatch):
    install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)
    monkeypatch.setattr(sg, "_bundled_git_candidate", lambda: None)
    monkeypatch.setattr(sg, "_find_system_git", lambda: None)
    sg.reset_git_probe_cache_for_tests()

    async def main():
        args = {"path": "a.txt", "content": "hello"}
        result = await lt.write_file(args, ctx)
        await run_post_tool_hooks("write_file", args, result, ctx)
        return result

    result = asyncio.run(main())
    assert "已写入" in result  # 写文件本身仍然成功（单文件备份兜底）
    assert ci.list_checkpoints(_CID) == []  # 没有 git，自然没有检查点
