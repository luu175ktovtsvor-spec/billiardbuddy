import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Boolean, Text, DateTime, ForeignKey, func, Index
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID, JSONType


class ScheduledTask(Base):
    """定时任务(Scheduled Tasks)——对标 Claude Code 的 Scheduled Tasks：配好指令 + 定时规则，
    到点自动跑一遍 agent 任务、干完把结果写回本行 + 系统通知播报。

    与 `services/agent/reminders.py` 的一次性提醒（到点只弹一声、不干活）不同：这里到点真的
    会跑一遍受限 agent（见 services/agent/scheduled_tasks.py 的 run_scheduled_task），产出
    写文案/报表汇总这类内容，但**绝不自动对外**（发布/群发/删数据）——无人值守没人点审批卡，
    执行时固定用裁剪过的安全工具集（_scheduled_safe_registry）。

    时区口径：`schedule_spec` 里的 hour/minute/weekday 按北京时间（core.timezone.BUSINESS_TZ）
    理解；`next_run_at`/`last_run_at` 存 UTC-aware datetime。SQLite 读出来会丢 tzinfo（老坑），
    比较前一律经 scheduled_tasks._as_aware_utc() 兜底当 UTC。
    """
    __tablename__ = "scheduled_tasks"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    store_id: Mapped[uuid.UUID] = mapped_column(GUID, ForeignKey("stores.id"), nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    instruction: Mapped[str] = mapped_column(Text, nullable=False)
    # Store 模型没持久化台球开关(前端每次临时传)，定时任务自己存一份——否则每天出的文案默认走
    # 通用模式、台球术语库不生效。
    billiards_mode: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False, server_default="0")

    # daily / weekly / interval
    schedule_kind: Mapped[str] = mapped_column(String(16), nullable=False)
    # daily→{hour,minute}；weekly→{weekday(0=周一..6=周日,同 datetime.weekday()),hour,minute}；
    # interval→{minutes}。hour/minute 按北京时间理解。
    schedule_spec: Mapped[dict] = mapped_column(JSONType, nullable=False)

    # 下次触发(UTC-aware)——补跑/到点判定都靠它；不给 server_default(建行时业务代码总是显式算好写入)
    next_run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, index=True)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_run_status: Mapped[str | None] = mapped_column(String(16), nullable=True)  # success / error
    last_result_summary: Mapped[str | None] = mapped_column(Text, nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True, server_default="1")

    # Python 侧 default(异步 SQLite refresh 会崩,见 media_job.py 注释):flush 即落值
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(), index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
        onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_scheduled_tasks_store_enabled", "store_id", "enabled"),
    )
