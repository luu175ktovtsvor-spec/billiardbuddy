# -*- coding: utf-8 -*-
"""耦合护栏测试：把"改 A 静默坏 B"的几个隐式契约钉成显式断言。

来源：2026-06-14 全项目耦合审查（docs/耦合地图与改动检查清单.md）。
这些测试不验证功能对错，只在**有人破坏跨模块契约时大声失败**。
"""
import models  # noqa: F401  触发所有 ORM 模型注册到 Base.registry
from db.base import Base
from core.tenant import _TENANT_TABLES
from services.ai.prompt_engine import get_prompt_engine


# ── 护栏1：租户隔离表分类不得漂移 ───────────────────────────────
# 有 store_id 列、但**故意不进自动过滤**、靠各处手写 .where(store_id) 隔离的表。
# 不能随便加进 _TENANT_TABLES：admin 等无租户上下文的查询会被 fail-safe 清空。
_MANUAL_FILTER_TABLES = {
    "store_members", "store_memories",
    # usage_events：使用事件分析表，刻意跨店做统计聚合、不参与租户隔离；
    # 需要按店看时显式 .where(store_id)。绝不能进 _TENANT_TABLES(会被 fail-safe 清空)。
    "usage_events",
    # media_jobs：生成工作室异步任务,隔离靠 media_jobs_service 各方法显式 .where(store_id==store.id);
    # 不进自动过滤(后台 runner 无租户上下文,会被 fail-safe 清空 → 任务永远查不到)。
    "media_jobs",
    # scheduled_tasks：定时任务(D-Task-3)，进程内轮询 loop / 启动补跑都无租户上下文(不进自动过滤
    # 会被 fail-safe 清空→到点永远查不到自己)；隔离靠 api/v1/scheduled_tasks.py 与
    # services/agent/scheduled_tasks.py 各处显式 .where(store_id==)。
    "scheduled_tasks",
    # store_doc_libraries：店铺资料库配置(D-Task-5)，隔离靠 api/v1/store_docs.py 各处显式
    # .where(store_id==)；不进自动过滤(那套只覆盖 generations/usage_quotas)。
    "store_doc_libraries",
    # 注：store_invitations/store_subscriptions/collab_tasks 是已删的 SaaS 表名，已从此集合清除。
}


def _tables_with_store_id() -> set[str]:
    out = set()
    for mapper in Base.registry.mappers:
        t = mapper.local_table
        if t is not None and "store_id" in t.columns:
            out.add(t.name)
    return out


def test_every_store_id_table_is_consciously_classified():
    """新增一张带 store_id 的表却没分类 → 失败，逼开发者明确它的隔离方式。"""
    tables = _tables_with_store_id()
    classified = _TENANT_TABLES | _MANUAL_FILTER_TABLES
    unclassified = tables - classified
    assert not unclassified, (
        f"这些表有 store_id 列但未分类：{sorted(unclassified)}。"
        "必须明确归入 _TENANT_TABLES(自动过滤) 或 _MANUAL_FILTER_TABLES(手动 where)，"
        "否则跨店隔离可能静默漏掉。详见 core/tenant.py 注释。"
    )


def test_live_auto_filter_tables_have_store_id():
    """generations/usage_quotas 是真正靠自动过滤保护的，必须有 store_id 列且在集合里。"""
    tables = _tables_with_store_id()
    for live in {"generations", "usage_quotas"}:
        assert live in tables, f"{live} 应有 store_id 列"
        assert live in _TENANT_TABLES, f"{live} 应在 _TENANT_TABLES"


# ── 护栏2：仪表盘推荐硬编码的 promptKey 必须有对应模板 ──────────────
# dashboard_service.py 用字符串字面量硬编码这些 promptKey 生成推荐深链；
# 一旦对应 YAML 被重命名/删除，推荐会生成点进去 render 失败的死链，无静态检查能拦。
_DASHBOARD_HARDCODED_PROMPT_KEYS = [
    "copywriting.moments",
    "copywriting.group_notice",
    "operation.diagnosis_tool",
    "operation.old_customer_recall",
]


def test_dashboard_hardcoded_prompt_keys_resolve():
    pe = get_prompt_engine()
    missing = [k for k in _DASHBOARD_HARDCODED_PROMPT_KEYS if k not in pe._templates]
    assert not missing, (
        f"仪表盘推荐硬编码的 promptKey 找不到模板：{missing}。"
        "重命名/删除 server/prompts 下对应 YAML 会让今日推荐变死链——"
        "改 YAML 的 key 时必须同步 dashboard_service.py 里的字面量。"
    )
