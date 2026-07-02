"""每台装了桌面版的机器一个稳定 machine_id：上行数据按它区分来源机器。

优先级：
1. UPLOAD_DIR/machine_id 文件已存在 → 读它（跨进程重启保持稳定，文件路径优先级最高）。
2. 否则尝试取操作系统级硬件标识（Windows 注册表 MachineGuid / macOS ioreg IOPlatformUUID），
   取不到就退化成随机 UUID4。
3. 落盘到 UPLOAD_DIR/machine_id，下次直接读文件，不用每次都查硬件。

全程 try/except，任何一步失败都不崩——machine_id 拿不到就用随机值，绝不影响主流程启动
（铁律3：上行相关异常绝不冒泡）。
"""

import os
import platform
import subprocess
import uuid
from pathlib import Path


def _upload_dir() -> Path:
    # 直接读环境变量（而非 config.settings 单例）：settings 是进程启动时读一次的，
    # 测试里用 monkeypatch.setenv 动态改 UPLOAD_DIR 要求这里每次调用都能拿到最新值。
    env_dir = os.environ.get("UPLOAD_DIR")
    if env_dir:
        return Path(env_dir)
    from config import settings
    return Path(settings.upload_dir)


def _hardware_id() -> str | None:
    """尽力取操作系统级硬件标识，取不到返回 None（由调用方兜底随机 UUID）。"""
    try:
        system = platform.system()
        if system == "Windows":
            import winreg  # type: ignore

            with winreg.OpenKey(
                winreg.HKEY_LOCAL_MACHINE, r"SOFTWARE\Microsoft\Cryptography"
            ) as key:
                val, _ = winreg.QueryValueEx(key, "MachineGuid")
                return str(val).strip() or None
        if system == "Darwin":
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True, text=True, timeout=5, check=False,
            ).stdout
            for line in out.splitlines():
                if "IOPlatformUUID" in line:
                    # 形如: "IOPlatformUUID" = "XXXXXXXX-XXXX-..."
                    parts = line.split("=", 1)
                    if len(parts) == 2:
                        return parts[1].strip().strip('"') or None
    except Exception:
        return None
    return None


def get_machine_id() -> str:
    """取本机稳定 machine_id；全程故障安全，任何异常都退化成随机 UUID，绝不抛出。"""
    try:
        upload_dir = _upload_dir()
        f = upload_dir / "machine_id"
        if f.exists():
            existing = f.read_text(encoding="utf-8").strip()
            if existing:
                return existing

        mid = _hardware_id() or uuid.uuid4().hex
        try:
            upload_dir.mkdir(parents=True, exist_ok=True)
            f.write_text(mid, encoding="utf-8")
        except Exception:
            pass
        return mid
    except Exception:
        return uuid.uuid4().hex
