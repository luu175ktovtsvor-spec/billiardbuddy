"""Agent 运行时上下文：跨工具共享的 db / 门店 / 用户等。

P0 先放最小骨架，字段用 Any 避免与 models/db 的硬耦合；
P1 接真实工具时各 handler 自行按需取用。
"""
from dataclasses import dataclass
from typing import Any


@dataclass
class AgentContext:
    db: Any = None     # AsyncSession
    store: Any = None  # 当前门店 Store
    user: Any = None   # 当前用户 User
