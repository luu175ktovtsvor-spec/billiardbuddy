import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Integer, Text, DateTime, ForeignKey, func
from sqlalchemy.orm import Mapped, mapped_column

from db.base import Base
from db.types import GUID


class StoreDocLibrary(Base):
    """店铺资料库配置（一店一份）：老板选定的资料文件夹 + 索引状态。

    与「懂行」的台球行业知识库（YAML）、「拼提示结论」的店脑记忆（StoreMemory）不是一回事——
    这是「懂你家」：老板自己的合同/进货单/排班表/价目表等原始文档，分块检索、带出处。

    这张表只存【配置 + 状态】（给前端展示/触发索引用）；真正的分块向量数据存在独立的
    services/rag/index_store.py（~/.billiards-desktop/rag/index.db，source_type="store_doc"），
    不在这张表、也不跟主库 generations 混。

    索引大文件夹可能慢，交给后台任务跑（见 services/rag/store_docs.py::run_folder_reindex_job），
    这张表就是那个后台任务跟前端之间的"状态板"：indexing → ready/error。
    """
    __tablename__ = "store_doc_libraries"

    id: Mapped[uuid.UUID] = mapped_column(GUID, primary_key=True, default=uuid.uuid4)
    store_id: Mapped[uuid.UUID] = mapped_column(
        GUID, ForeignKey("stores.id"), nullable=False, unique=True, index=True
    )
    folder_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    # idle(未设置/已清除) / indexing(后台跑着) / ready(索引好了) / error(上次索引失败)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="idle", server_default="idle")
    indexed_file_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    indexed_chunk_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0, server_default="0")
    last_indexed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Python 侧 default(异步 SQLite refresh 会崩,见 media_job.py 注释):flush 即落值
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), server_default=func.now(),
        onupdate=func.now()
    )
