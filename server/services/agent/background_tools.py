"""后台任务 —— 对标 Claude Code 的 background task：长命令丢后台跑、立即返回，完成弹系统通知。

桌面专属 DESKTOP_LOCAL=1。asyncio 子进程在【服务进程的事件循环】里跑完（SSE 关了也不影响）；
完成后 notify(osascript) + 输出落盘 `UPLOAD_DIR/background/<id>.txt`（agent 可后续 read_file 拿回）。
安全：跑 shell → requires_approval + force_confirm（人确认确切命令后才起）；进程重启则丢，v1 不持久。
"""
import asyncio
import os
import subprocess
import uuid
from pathlib import Path

from services.agent.registry import tool


def _bg_dir() -> Path:
    base = os.environ.get("UPLOAD_DIR") or str(Path.home() / ".billiards-desktop" / "uploads")
    d = Path(base) / "background"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _notify(title: str, message: str):
    try:
        t = title.replace('"', "'")
        m = message.replace('"', "'")[:120]
        subprocess.run(["osascript", "-e", f'display notification "{m}" with title "{t}"'],
                       capture_output=True, timeout=8)
    except Exception:
        pass


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


async def _run_background_handler(args: dict, ctx) -> str:
    command = str(args.get("command") or "").strip()
    if not command:
        return "[参数缺失] run_background 需要 command"
    task_id = uuid.uuid4().hex[:8]
    out_path = _bg_dir() / f"{task_id}.txt"
    try:
        proc = await asyncio.create_subprocess_shell(
            command, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    except Exception as e:  # noqa: BLE001
        return f"[后台启动失败] {e}"
    asyncio.create_task(_watch(task_id, command, proc, out_path))
    return (f"已在后台启动（task {task_id}）：{command}\n"
            f"跑完会弹系统通知；输出会落到：{out_path}（需要时我可以 read_file 它）。")


if os.environ.get("DESKTOP_LOCAL") == "1":
    tool(
        name="run_background",
        description="把一条耗时的命令丢到【后台】跑、立即返回不干等（适合编译/批量处理/长脚本）。"
                    "跑完会弹系统通知、输出落盘可后续读取。会先弹确认再起。",
        parameters={"type": "object", "properties": {
            "command": {"type": "string", "description": "要在后台执行的 shell 命令"},
        }, "required": ["command"]},
        requires_approval=True,
        force_confirm=True,
        approval_class="spend",
    )(_run_background_handler)
