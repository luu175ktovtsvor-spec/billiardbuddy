"""
自动租户隔离模块。

通过 contextvars + SQLAlchemy do_orm_execute 事件实现：
- SELECT 自动追加 store_id 过滤
- INSERT 自动填充 store_id
- fail-safe：无租户上下文时返回空结果
"""

import contextvars
import uuid

from sqlalchemy import event, inspect as sa_inspect
from sqlalchemy.orm import Session, ORMExecuteState

_current_store_id: contextvars.ContextVar[uuid.UUID | None] = contextvars.ContextVar(
    "current_store_id", default=None
)

# 有 store_id 列的表（租户隔离范围）
_TENANT_TABLES = {"stores", "generations", "usage_quotas", "conversations"}


def set_tenant(store_id: uuid.UUID | None) -> contextvars.Token:
    """设置当前请求的租户 ID。"""
    return _current_store_id.set(store_id)


def get_tenant() -> uuid.UUID | None:
    """获取当前请求的租户 ID。"""
    return _current_store_id.get()


def _has_store_id_filter(statement) -> bool:
    """检查 WHERE 子句是否已包含 store_id 条件。"""
    where_clause = statement.whereclause
    if where_clause is None:
        return False
    clause_str = str(where_clause)
    return "store_id" in clause_str


def _get_tenant_column(statement):
    """从语句的 FROM 子句中找租户表的 store_id 列。"""
    try:
        froms = statement.columns_clause_froms
    except AttributeError:
        return None
    for from_clause in froms:
        try:
            inspector = sa_inspect(from_clause)
            if hasattr(inspector, "columns"):
                for col in inspector.columns:
                    if col.name == "store_id" and from_clause.name in _TENANT_TABLES:
                        return col
        except Exception:
            continue
    return None


@event.listens_for(Session, "do_orm_execute")
def _auto_filter_tenant(orm_execute_state: ORMExecuteState):
    """拦截 SELECT 查询，自动追加租户过滤。"""
    if not orm_execute_state.is_select:
        return

    statement = orm_execute_state.statement
    if statement is None:
        return

    # 已有 store_id 过滤 → 跳过（不重复添加）
    if _has_store_id_filter(statement):
        return

    # 找租户表的 store_id 列
    tenant_col = _get_tenant_column(statement)
    if tenant_col is None:
        return

    store_id = get_tenant()

    if store_id is None:
        # 无租户上下文 → fail-safe：返回空结果
        orm_execute_state.statement = statement.where(tenant_col.is_(None))
    else:
        # 有租户上下文 → 追加过滤
        orm_execute_state.statement = statement.where(tenant_col == store_id)


@event.listens_for(Session, "before_flush")
def _auto_fill_tenant(session, flush_context, instances):
    """INSERT 时自动为新对象填充 store_id。"""
    store_id = get_tenant()
    if store_id is None:
        return
    for obj in session.new:
        if hasattr(obj, "store_id") and obj.store_id is None:
            obj.store_id = store_id
