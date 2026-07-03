"""后台任务 —— 对标 Claude Code 的 background task：长命令丢后台跑、立即返回，完成弹系统通知。

桌面专属 DESKTOP_LOCAL=1。asyncio 子进程在【服务进程的事件循环】里跑完（SSE 关了也不影响）；
完成后经 `services.notify_service.push()` 通知（F1b 统一通知中心，跨平台）+ 输出落盘
`UPLOAD_DIR/background/<id>.txt`（agent 可后续 read_file 拿回）。

安全护栏（与 local_tools.run_command 同一套，不是两条平行的规矩）：
- 硬门控：必须先开「完全访问模式」(full_disk_access) 才能跑后台命令——普通模式下不给跑。
- 危险命令黑名单：复用 local_tools._check_command_safety（禁 shell 操作符拼接/重定向/管道 +
  删根/提权/外传/格式化等黑名单），不是本文件另起一套判断逻辑，两处命令执行口径必须一致。
- 不再用 create_subprocess_shell（shell 操作符全放行、等于绕开上面的黑名单）——改 shlex.split
  非 shell 执行；需要 shell 语义（管道/重定向/拼接）的命令一律在安全检查那一步就被直接拒绝并说明原因。
- 审批闸带 preview：确认卡上会显示【命令原文】，不是干巴巴的"要不要跑个后台命令"。
"""
import asyncio
import logging
import os
import shlex
import uuid
from pathlib import Path

from services import notify_service
from services.agent.local_tools import _check_command_safety
from services.agent.registry import Tool, default_registry

logger = logging.getLogger(__name__)


def _bg_dir() -> Path:
    base = os.environ.get("UPLOAD_DIR") or str(Path.home() / ".billiards-desktop" / "uploads")
    d = Path(base) / "background"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _notify(title: str, message: str):
    # F1b：归一到通知中心（跨平台），不再直连 osascript（mac-only）。push() 故障安全，不需要再包 try/except。
    notify_service.push(title, (message or "")[:120], kind="background_task")


async def _watch(task_id: str, command: str, proc, out_path: Path):
    try:
        stdout, stderr = await proc.communicate()
        rc = proc.returncode
        text = (stdout or b"").decode("utf-8", "replace")
        err = (stderr or b"").decode("utf-8", "replace")
        body = f"命令：{command}\n返回码：{rc}\n\n【标准输出】\n{text}\n【错误输出】\n{err}"
        try:
            out_path.write_text(body, encoding="utf-8")
        except Exception:
            pass
        _notify("后台任务" + ("完成" if rc == 0 else f"失败(码{rc})"), command)
    except Exception:
        _notify("后台任务出错", command)


def _preview_run_background(args: dict, ctx) -> str:
    """跑后台命令前给老板看的预览：把【将执行的命令原文】清楚展示，看清原文再确认（同 run_command 的做法）。"""
    command = (args.get("command") or "").strip() or "（空）"
    return "将在【后台】启动执行以下命令（看清原文再确认）：\n" + f"  $ {command}"


async def _run_background_handler(args: dict, ctx) -> str:
    command = str(args.get("command") or "").strip()
    if not command:
        return "[参数缺失] run_background 需要 command"
    # 硬门控：跟 run_command 一致——没开「完全访问模式」不能跑后台命令（风险最高的工具之一，
    # 不能因为"丢后台跑"就绕开跟 run_command 同一道闸）。
    if not getattr(ctx, "full_disk_access", False):
        return "跑后台命令需要先开启「完全访问模式」。普通模式下我不能在后台执行命令。"
    reason = _check_command_safety(command)
    if reason:
        return f"拒绝执行：{reason}"
    try:
        parts = shlex.split(command)
    except ValueError as e:
        return f"命令解析失败（引号没配对？）：{e}"
    if not parts:
        return "命令是空的，没东西可跑。"

    task_id = uuid.uuid4().hex[:8]
    out_path = _bg_dir() / f"{task_id}.txt"
    try:
        # shell=False：命令按 shlex 拆好的参数数组直接执行，不经过 shell 解释——
        # 拼接/重定向/管道这类 shell 语义在上面 _check_command_safety 那一步已经被禁止，
        # 这里不用 create_subprocess_shell 也就没有"黑名单被 shell 特性绕过"的空间。
        # 密钥类环境变量不给子进程(同 run_command)：防 `bash -c "env"` 类套壳把内置 key 打进对话。
        from services.agent.local_tools import sanitized_child_env
        proc = await asyncio.create_subprocess_exec(
            *parts, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env=sanitized_child_env())
    except FileNotFoundError:
        return f"找不到这个命令（没装或不在 PATH 里）：{parts[0]}"
    except OSError as e:
        return f"[后台启动失败] {e}"
    asyncio.create_task(_watch(task_id, command, proc, out_path))
    return (f"已在后台启动（task {task_id}）：{command}\n"
            f"跑完会弹系统通知；输出会落到：{out_path}（需要时我可以 read_file 它）。")


_BACKGROUND_TOOLS = [
    Tool(
        name="run_background",
        description="把一条耗时的命令丢到【后台】跑、立即返回不干等（适合编译/批量处理/长脚本）。"
                    "跑完会弹系统通知、输出落盘可后续读取。只有开了「完全访问模式」才能用；"
                    "审批卡会显示命令原文，会先弹确认再起；跟 run_command 同一套安全护栏"
                    "（禁 shell 拼接/重定向/管道、危险命令黑名单永远拦死）。",
        parameters={"type": "object", "properties": {
            "command": {"type": "string", "description": "要在后台执行的单条命令原文（不要用 && | ; 等拼接）"},
        }, "required": ["command"]},
        handler=_run_background_handler,
        requires_approval=True,
        force_confirm=True,
        approval_class="spend",
        preview=_preview_run_background,
    ),
]


def register_background_tools(registry=None) -> int:
    """把后台任务工具注册进注册表。仅桌面本地模式调用。返回新注册的数量（幂等，重复调用不重复注册）。"""
    reg = registry or default_registry
    n = 0
    for t in _BACKGROUND_TOOLS:
        if reg.get(t.name) is None:
            reg.register(t)
            n += 1
    return n


if os.environ.get("DESKTOP_LOCAL") == "1":
    register_background_tools()
