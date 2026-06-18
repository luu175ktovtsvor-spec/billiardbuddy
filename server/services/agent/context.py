"""Agent 运行时上下文：跨工具共享的 db / 门店 / 用户等。

P0 先放最小骨架，字段用 Any 避免与 models/db 的硬耦合；
P1 接真实工具时各 handler 自行按需取用。
"""
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentContext:
    db: Any = None     # AsyncSession
    store: Any = None  # 当前门店 Store
    user: Any = None   # 当前用户 User
    # 用户本次经【OS 文件选择器】当场选定、显式授权 Agent 可读/改的文件或目录绝对路径。
    # 本地文件工具的沙箱 = 内容库 + 这些路径；空 = 只能动内容库（桌面默认）。云端 web 版恒为空。
    allowed_paths: list[str] = field(default_factory=list)
    # 审批/自主级别（老板在桌面设的"权限"）：
    #   "ask"        每次写/改/花钱都弹确认（默认，最稳）；
    #   "auto_files" 信任模式：本机文件读改免确认直接动手（仍自动备份），花钱/对外仍弹确认；
    #   "full"       最高权限：所有动作（含花钱/对外）都免确认自动执行。
    permission_mode: str = "ask"
    # 范围越界开关：True = 文件工具不再限于"内容库+选定文件"，可碰任意路径（高级·带风险）。
    full_disk_access: bool = False
