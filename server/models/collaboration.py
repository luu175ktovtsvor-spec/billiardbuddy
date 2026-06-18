import uuid
from datetime import datetime

from sqlalchemy import String, Integer, DateTime, ForeignKey, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID, JSONType


class CollabTask(Base):
    """多 Agent 协作任务状态。

    存数据库而非进程内存——否则 2 个 uvicorn worker 下，发起任务的 worker 与
    轮询命中的 worker 不同会返回 404。状态落库后任何 worker 都读同一份。
    岗位 system prompt 不入库（含门店知识，防泄露），只在执行进程内存里传递。
    """
    __tablename__ = "collab_tasks"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    store_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("stores.id"), nullable=False, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    task_type: Mapped[str] = mapped_column(String(50), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="running", index=True)  # running/completed/failed/cancelled
    framework: Mapped[str | None] = mapped_column(Text)  # 共享协作框架（规划阶段产出）
    agents: Mapped[list] = mapped_column(JSONType, default=list)  # [{role, status, content}]
    summary: Mapped[str | None] = mapped_column(Text)
    generation_id: Mapped[uuid.UUID | None] = mapped_column(GUID)
    tokens_used: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now())
