"""P1 关联项：/agent/execute 审批执行路径接入统一护栏管道。

背景（全仓七路审查 2026-07-02 第二节「关联」）：execute 端点此前直调 `tool.handler(args, ctx)`，
绕过了主循环 `_execute_tool` 的 PreToolUse hook / 超时兜底 / 结果封顶三件套——审批过的动作完全没有
这些保护。修法：execute 端补齐同款三件套，但保持「工具自身抛出的业务异常仍正常向上抛」这条既有
返回契约不变（execute 是非流式 JSON 端点，前端要拿到真实 HTTP 状态码，不能像主循环那样把异常吞成
字符串回灌模型）。

本文件直接调用 `agent_execute` 这个协程函数（绕开 FastAPI 的 Depends 注入，用等价的裸参数），
锁住：
- PreToolUse hook 会在 execute 路径触发、且能拦截执行。
- 超时兜底生效：工具跑太久会被掐断，返回友好超时文案，不再无限期挂住请求。
- 正常执行时返回契约（tool/result/continuation/approval 字段）不变。
- 工具自身抛出的 AppException（如配额不足）继续正常向上抛，不被吞成字符串。
"""
import asyncio
import uuid

import pytest

from api.v1.agent import agent_execute, AgentExecuteRequest
from core.exceptions import AIServiceError
from services.agent import hooks as hooks_mod
from services.agent import local_tools as lt
from services.agent.approval import sign_approval
from services.agent.registry import Tool, default_registry


class _FakeUser:
    id = uuid.uuid4()


class _FakeStore:
    id = uuid.uuid4()
    agent_auto_spend_limit = None


def _register_temp_tool(name: str, handler, **kw) -> Tool:
    t = Tool(name=name, description="测试用临时工具", parameters={"type": "object", "properties": {}},
             handler=handler, requires_approval=True, **kw)
    default_registry.register(t)
    return t


def _unregister(name: str) -> None:
    default_registry._tools.pop(name, None)  # noqa: SLF001 测试专用清理，绕不开（无公开 unregister）


def _exec(body: AgentExecuteRequest):
    return asyncio.run(agent_execute(body, user=_FakeUser(), store=_FakeStore(), db=None))


def test_execute_triggers_pre_tool_hook_and_can_deny():
    name = f"__test_exec_hook_{uuid.uuid4().hex[:8]}"
    executed = []

    async def handler(args, ctx):
        executed.append(args)
        return "不该跑到这"

    _register_temp_tool(name, handler)
    seen = []

    async def deny_hook(tool_name, args, ctx):
        seen.append(tool_name)
        if tool_name == name:
            return {"deny": "测试用途拦截"}
        return None

    hooks_mod.register_pre_tool_hook(deny_hook)
    try:
        args = {"x": 1}
        body = AgentExecuteRequest(tool=name, args=args, token=sign_approval(name, args))
        res = _exec(body)
        assert seen == [name], "execute 路径应经过 PreToolUse hook"
        assert executed == [], "被 hook 拦截后 handler 不该被真正执行"
        assert "[已被拦截]" in res["result"] and "测试用途拦截" in res["result"]
    finally:
        hooks_mod._PRE_TOOL_HOOKS.remove(deny_hook)  # noqa: SLF001
        _unregister(name)


def test_execute_pre_tool_hook_allows_when_not_denied():
    """hook 存在但不针对该工具/不拦截 → 正常放行执行（故障安全，不误伤其它工具）。"""
    name = f"__test_exec_hook_ok_{uuid.uuid4().hex[:8]}"
    executed = []

    async def handler(args, ctx):
        executed.append(args)
        return "正常结果"

    _register_temp_tool(name, handler)

    async def noop_hook(tool_name, args, ctx):
        return None

    hooks_mod.register_pre_tool_hook(noop_hook)
    try:
        args = {}
        body = AgentExecuteRequest(tool=name, args=args, token=sign_approval(name, args))
        res = _exec(body)
        assert executed == [{}]
        assert res["result"] == "正常结果"
    finally:
        hooks_mod._PRE_TOOL_HOOKS.remove(noop_hook)  # noqa: SLF001
        _unregister(name)


def test_execute_timeout_cuts_off_hanging_tool():
    name = f"__test_exec_timeout_{uuid.uuid4().hex[:8]}"

    async def handler(args, ctx):
        await asyncio.sleep(10)
        return "不该跑完"

    _register_temp_tool(name, handler, timeout=0.05)
    try:
        args = {}
        body = AgentExecuteRequest(tool=name, args=args, token=sign_approval(name, args))
        res = _exec(body)
        assert "[工具超时]" in res["result"], "挂死的工具应被统一超时兜底掐断，不能无限期挂住请求"
    finally:
        _unregister(name)


def test_execute_normal_result_contract_unchanged():
    name = f"__test_exec_ok_{uuid.uuid4().hex[:8]}"

    async def handler(args, ctx):
        return "执行成功"

    _register_temp_tool(name, handler)
    try:
        args = {}
        body = AgentExecuteRequest(tool=name, args=args, token=sign_approval(name, args))
        res = _exec(body)
        assert res["tool"] == name
        assert res["result"] == "执行成功"
        assert "continuation" in res and "approval" in res
    finally:
        _unregister(name)


def test_execute_non_string_result_still_json_encoded():
    """三件套接入前就有的行为：handler 返回非字符串(如 dict) → 序列化成 JSON 字符串，不该被改坏。"""
    name = f"__test_exec_dict_{uuid.uuid4().hex[:8]}"

    async def handler(args, ctx):
        return {"ok": True, "n": 1}

    _register_temp_tool(name, handler)
    try:
        args = {}
        body = AgentExecuteRequest(tool=name, args=args, token=sign_approval(name, args))
        res = _exec(body)
        assert res["result"] == '{"ok": true, "n": 1}'
    finally:
        _unregister(name)


def test_execute_business_exception_still_propagates():
    """工具自身抛的 AppException（如配额不足）要继续正常向上抛，不能像主循环那样被吞成字符串结果
    ——execute 是非流式 JSON 端点，前端靠 HTTP 状态码判断（如 need_byok），返回契约不能破。"""
    name = f"__test_exec_raise_{uuid.uuid4().hex[:8]}"

    async def handler(args, ctx):
        raise AIServiceError("本月使用量已达上限", status_code=429)

    _register_temp_tool(name, handler)
    try:
        args = {}
        body = AgentExecuteRequest(tool=name, args=args, token=sign_approval(name, args))
        with pytest.raises(AIServiceError) as ei:
            _exec(body)
        assert ei.value.status_code == 429
        assert ei.value.message == "本月使用量已达上限"
    finally:
        _unregister(name)


# ══════════════════ 审批闸 2.0 复审修复 · Critical #1：批后重跑要真的跑通 ══════════════════
#
# 背景：越界文件写会被 loop 转成审批卡（`_file_target_oob`）；老板点"允许"后，前端带着
# 当初提案的 tool/args/token 回调 /agent/execute。这里重建的 ctx 若只信 body.selected_files
# 拼 allowed_paths（不含刚被批准的越界路径），write_file/edit_image 里的 `_resolve` 会照样
# 抛 ValueError——而这条端点跟主循环不同、没有把工具异常吞成字符串回灌的机制，未捕获的
# ValueError 会一路冒到全局异常处理变成一句不知所云的 500。对 full 档是行为倒退：原来至少
# 静默失败还能给老板回灌人话，现在弹卡点了确认反而收到"服务器内部错误"。
#
# 修法：签名验证（HMAC 绑定 (tool, 完整 args)，含 path/output_path）通过后，才把这组 args 里
# 的 path/output_path 一次性并入本次请求的 ctx.allowed_paths——这是兑现闸已经放行的授权，
# 不做跨请求持久化。下面三条测试锁：① path 越界，签名对得上就能真写成功；② output_path
# 越界（edit_image 这类另存场景）同样被一并授权；③ 签名对不上/缺失，绝不能白拿到这份
# 一次性授权（防止这个修复本身变成绕过闸的后门）。

def test_execute_authorizes_signed_oob_path_write(tmp_path, monkeypatch):
    lib = tmp_path / "library"
    lib.mkdir()
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(lib))
    outside = tmp_path / "外部报表.txt"

    name = f"__test_exec_oob_write_{uuid.uuid4().hex[:8]}"
    _register_temp_tool(name, lt.write_file, approval_class="file")
    try:
        args = {"path": str(outside), "content": "老板批准写这份"}
        token = sign_approval(name, args)
        body = AgentExecuteRequest(tool=name, args=args, token=token, full_disk_access=False)
        res = _exec(body)
        assert "已写入" in res["result"], f"越界写在签名批准后应真正执行成功，而不是 500/异常：{res}"
        assert outside.exists()
        assert outside.read_text(encoding="utf-8") == "老板批准写这份"
    finally:
        _unregister(name)


def test_execute_authorizes_signed_oob_output_path(tmp_path, monkeypatch):
    """edit_image 一类工具目标另存路径叫 output_path（不是 path）——同样要被一并授权。
    用一个直接调用真实 `lt._resolve` 的临时 handler 验证：不依赖真跑图像处理，只验证
    execute 端确实把 output_path 塞进了 ctx.allowed_paths、沙箱判定因此真的放行。"""
    lib = tmp_path / "library"
    lib.mkdir()
    monkeypatch.setenv("DESKTOP_LIBRARY_DIR", str(lib))
    outside = tmp_path / "另存.txt"

    async def handler(args, ctx):
        path = lt._resolve(args["output_path"], ctx)  # noqa: SLF001 —— 直接复用真实沙箱判定
        path.write_text(args["content"], encoding="utf-8")
        return "已另存"

    name = f"__test_exec_oob_output_{uuid.uuid4().hex[:8]}"
    _register_temp_tool(name, handler, approval_class="file")
    try:
        args = {"output_path": str(outside), "content": "另存内容"}
        token = sign_approval(name, args)
        body = AgentExecuteRequest(tool=name, args=args, token=token, full_disk_access=False)
        res = _exec(body)
        assert res["result"] == "已另存"
        assert outside.read_text(encoding="utf-8") == "另存内容"
    finally:
        _unregister(name)


def test_execute_does_not_authorize_oob_path_without_valid_signature():
    """反向对照：签名对不上（老板没点这个/参数被篡改）不能白拿到这份"一次性授权"——
    验签失败在授权逻辑之前就该拦下，文件不该被写、也不该绕过签名闸。"""
    name = f"__test_exec_oob_reject_{uuid.uuid4().hex[:8]}"
    _register_temp_tool(name, lt.write_file, approval_class="file")
    try:
        args = {"path": "/tmp/不该被写的越界路径.txt", "content": "不该落盘"}
        body = AgentExecuteRequest(tool=name, args=args, token="wrong-token-not-matching", full_disk_access=False)
        with pytest.raises(AIServiceError):
            _exec(body)
    finally:
        _unregister(name)
