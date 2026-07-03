# -*- coding: utf-8 -*-
"""F-12 检查点回滚 API（GET /checkpoints、POST /checkpoints/restore）。

跟 test_notifications_endpoint.py 同一约定：不用 TestClient，直接 import 端点模块当普通异步
函数调用（Depends(get_current_user) 在本端点逻辑里不参与业务判断，传 None 占位即可）。
真正的权限闸是 HMAC 签名（同 `/agent/execute` 的 verify_approval 机制）。
"""
import asyncio

import pytest
from pydantic import ValidationError

import api.v1.checkpoints as cp_api
from core.exceptions import AIServiceError
from services import shadow_git as sg
from services.agent import checkpoint_index as ci
from services.agent import local_tools as lt
from services.agent import shadow_git_hook as sgh
from services.agent.context import AgentContext
from services.agent.hooks import clear_hooks, run_post_tool_hooks

_CID = "33333333-3333-3333-3333-333333333333"


@pytest.fixture(autouse=True)
def _clean(monkeypatch, tmp_path):
    clear_hooks()
    sgh.reset_installed_flag_for_tests()
    sg.reset_git_probe_cache_for_tests()
    # F-12 复审 Important #1：_is_write_tool 动态查 default_registry 判 approval_class=="file"，
    # write_file 只在 DESKTOP_LOCAL=1 时于模块导入那一刻自动注册进这个进程级单例——单独跑本文件时
    # 不能赌别的测试文件恰好先导入过，显式补注册（幂等，可放心重复调用）。
    from services.agent.local_tools import register_local_tools
    register_local_tools()
    monkeypatch.setattr(sg.settings, "upload_dir", str(tmp_path / "uploads"))
    # ⚠️ 本文件经 _make_checkpoints() 真的调用 lt.write_file——它的 `_backup()` 不看 working_dir，
    # 固定写去 `_library_root()/.backups`（默认是开发机真实的 `~/.billiards-desktop/library`）。
    # 必须隔离，否则测试产物会写进开发者本机真实数据目录（曾真的踩过，见工作报告）。
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(tmp_path / "library"))
    yield
    clear_hooks()
    sgh.reset_installed_flag_for_tests()
    sg.reset_git_probe_cache_for_tests()


@pytest.fixture
def workspace(tmp_path):
    wd = tmp_path / "workdir"
    wd.mkdir()
    return wd


def _make_checkpoints(workspace):
    """真跑 write_file 工具 + hook，产出两条真实检查点（复用同一套 hook 接线，不重造假数据）。"""
    sgh.install_shadow_git_hook()
    ctx = AgentContext(working_dir=str(workspace), conversation_id=_CID)

    async def main():
        a1 = {"path": "note.txt", "content": "第一版"}
        r1 = await lt.write_file(a1, ctx)
        await run_post_tool_hooks("write_file", a1, r1, ctx)

        a2 = {"path": "note.txt", "content": "第二版"}
        r2 = await lt.write_file(a2, ctx)
        await run_post_tool_hooks("write_file", a2, r2, ctx)

    asyncio.run(main())
    return ci.list_checkpoints(_CID)


def test_list_returns_signed_tokens_per_mode(workspace):
    """F-12 复审 Important #2 回归：每条检查点必须一次性签出三种 mode 各自的 token（而不是一个
    只绑 (conversation_id, sha) 的裸 token）——否则任何一个 mode 的 token 都能被改 mode 提交。"""
    _make_checkpoints(workspace)

    async def main():
        return await cp_api.list_checkpoints_route(conversation_id=_CID, user=None)

    resp = asyncio.run(main())
    assert len(resp["checkpoints"]) == 2
    for row in resp["checkpoints"]:
        assert set(row.get("tokens", {}).keys()) == {"files_only", "chat_only", "both"}
        # 三个 token 必须互不相同（各自绑定自己的 mode，不是同一个东西发三份）
        assert len(set(row["tokens"].values())) == 3


def test_restore_files_only_reverts_content(workspace):
    checkpoints = _make_checkpoints(workspace)
    first = checkpoints[0]

    async def main():
        list_resp = await cp_api.list_checkpoints_route(conversation_id=_CID, user=None)
        row = next(r for r in list_resp["checkpoints"] if r["sha"] == first["sha"])
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=first["sha"], mode="files_only", token=row["tokens"]["files_only"],
        )
        return await cp_api.restore_checkpoint(req, user=None)

    resp = asyncio.run(main())
    assert resp["ok"] is True
    assert resp["files"]["ok"] is True
    assert (workspace / "note.txt").read_text(encoding="utf-8") == "第一版"


def test_restore_rejects_tampered_token(workspace):
    checkpoints = _make_checkpoints(workspace)
    first = checkpoints[0]

    async def main():
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=first["sha"], mode="files_only", token="这是伪造的token",
        )
        await cp_api.restore_checkpoint(req, user=None)

    with pytest.raises(AIServiceError):
        asyncio.run(main())
    # 拒绝之后文件应该还是最新内容，完全没动
    assert (workspace / "note.txt").read_text(encoding="utf-8") == "第二版"


def test_restore_rejects_token_issued_for_a_different_mode(workspace):
    """F-12 复审 Important #2 核心回归：拿到"只回文件"的合法 token，把 mode 换成 both/chat_only
    再提交——必须被拒绝，不能因为 token 本身是合法签发的就放行成另一个更危险的模式。"""
    checkpoints = _make_checkpoints(workspace)
    first = checkpoints[0]

    async def main():
        list_resp = await cp_api.list_checkpoints_route(conversation_id=_CID, user=None)
        row = next(r for r in list_resp["checkpoints"] if r["sha"] == first["sha"])
        files_only_token = row["tokens"]["files_only"]
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=first["sha"], mode="both", token=files_only_token,
        )
        await cp_api.restore_checkpoint(req, user=None)

    with pytest.raises(AIServiceError):
        asyncio.run(main())
    # 换 mode 被拒之后，聊天记录/文件都不该被 both 模式动过
    assert (workspace / "note.txt").read_text(encoding="utf-8") == "第二版"


def test_restore_rejects_mismatched_sha_in_token():
    """token 是给另一个 sha 签的，拿去恢复一个不同的 sha 应该被拒绝（防篡改参数裸调）。"""
    from services.agent.approval import sign_approval

    token_for_other_sha = sign_approval(
        "checkpoint_restore", {"conversation_id": _CID, "sha": "b" * 40, "mode": "files_only"}
    )

    async def main():
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha="a" * 40, mode="files_only", token=token_for_other_sha,
        )
        await cp_api.restore_checkpoint(req, user=None)

    with pytest.raises(AIServiceError):
        asyncio.run(main())


def test_restore_rejects_unknown_mode(workspace):
    checkpoints = _make_checkpoints(workspace)
    first = checkpoints[0]
    from services.agent.approval import sign_approval

    token = sign_approval(
        "checkpoint_restore",
        {"conversation_id": _CID, "sha": first["sha"], "mode": "delete_everything"},
    )

    async def main():
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=first["sha"], mode="delete_everything", token=token,
        )
        await cp_api.restore_checkpoint(req, user=None)

    with pytest.raises(AIServiceError):
        asyncio.run(main())


def test_restore_request_rejects_working_dir_field(workspace):
    """F-12 复审 Important #2 回归：working_dir 不再是恢复请求体能填的字段——服务端只从检查点
    索引里记的、由 PostToolUse 钩子当时真实的 ctx.working_dir 派生，不接受客户端指定任意目录。
    传了这个字段应该在构造请求体这一步就被拒绝（pydantic 校验不过），而不是被静默接受又不生效、
    更不能是被真的采用。"""
    checkpoints = _make_checkpoints(workspace)
    first = checkpoints[0]

    with pytest.raises(ValidationError):
        cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=first["sha"], mode="files_only", token="随便",
            working_dir="/etc",
        )


def test_restore_chat_only_truncates_transcript(workspace):
    from services.agent.transcript import load_transcript, save_transcript
    from services.agent.approval import sign_approval

    checkpoints = _make_checkpoints(workspace)
    second = checkpoints[1]
    save_transcript(_CID, [
        {"role": "user", "content": "轮1"}, {"role": "assistant", "content": "回复1"},
        {"role": "user", "content": "轮2"}, {"role": "assistant", "content": "回复2"},
    ])
    token = sign_approval(
        "checkpoint_restore", {"conversation_id": _CID, "sha": second["sha"], "mode": "chat_only"}
    )

    async def main():
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=second["sha"], mode="chat_only", token=token,
        )
        return await cp_api.restore_checkpoint(req, user=None)

    resp = asyncio.run(main())
    assert resp["ok"] is True
    assert resp["chat"]["ok"] is True
    # 两条检查点都发生在 hook 触发时（transcript 还没落过盘，len=0），回退到"这一轮开始前"即清空
    # （截断到 0 条后文件"空但存在"，而不是 None——Important #3 回归，见 test_agent_history_transcript.py）
    assert load_transcript(_CID) == []
    # 文件完全没被 chat_only 模式动过
    assert (workspace / "note.txt").read_text(encoding="utf-8") == "第二版"


def test_restore_both_mode_touches_files_and_chat(workspace):
    from services.agent.transcript import load_transcript, save_transcript
    from services.agent.approval import sign_approval

    checkpoints = _make_checkpoints(workspace)
    first = checkpoints[0]
    save_transcript(_CID, [{"role": "user", "content": "轮1"}, {"role": "assistant", "content": "回复1"}])
    token = sign_approval(
        "checkpoint_restore", {"conversation_id": _CID, "sha": first["sha"], "mode": "both"}
    )

    async def main():
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha=first["sha"], mode="both", token=token,
        )
        return await cp_api.restore_checkpoint(req, user=None)

    resp = asyncio.run(main())
    assert resp["ok"] is True
    assert resp["files"]["ok"] is True and resp["chat"]["ok"] is True
    assert (workspace / "note.txt").read_text(encoding="utf-8") == "第一版"
    assert load_transcript(_CID) == []


def test_restore_unknown_checkpoint_rejected():
    from services.agent.approval import sign_approval

    token = sign_approval(
        "checkpoint_restore", {"conversation_id": _CID, "sha": "a" * 40, "mode": "files_only"}
    )

    async def main():
        req = cp_api.CheckpointRestoreRequest(
            conversation_id=_CID, sha="a" * 40, mode="files_only", token=token,
        )
        await cp_api.restore_checkpoint(req, user=None)

    with pytest.raises(AIServiceError):
        asyncio.run(main())
