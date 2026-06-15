# -*- coding: utf-8 -*-
"""安全边界护栏(纯逻辑·无DB)。

锁住几条"以后别的会话容易悄悄改坏、又没人发现"的安全不变量——谁碰谁红：
- 店脑写端点的权限闸 + 注入校验
- RBAC 矩阵:管理类写权限不外溢、LIST⊆CREATE 配对
- 门店更新字段白名单不含归属/身份字段(防经"改资料"夺店)
"""
import inspect

from core.rbac import ROLE_PERMISSIONS, Permission


def test_store_memory_writes_require_permission_and_injection():
    """店脑记忆会注入该店所有后续生成的 prompt → 写端点必须有权限闸 + 注入校验，
    不能退回"任何门店成员都能改"。"""
    import api.v1.store_memory as sm
    src = inspect.getsource(sm)
    assert "require_permission(Permission.STORE_UPDATE)" in src, "店脑写端点缺 STORE_UPDATE 权限闸"
    assert "check_input_injection" in src, "店脑写端点缺注入校验"


def test_rbac_six_roles_and_owner_has_all():
    assert set(ROLE_PERMISSIONS) == {
        "owner", "manager", "assistant_manager", "coach", "frontdesk", "operator",
    }
    assert ROLE_PERMISSIONS["owner"] == set(Permission), "owner 应拥有全部权限"


def test_rbac_management_writes_do_not_leak_to_staff():
    """管理类写权限只能在管理岗，不可外溢到一线岗位(否则横向越权)。"""
    expected_holders = {
        Permission.STORE_UPDATE: {"owner", "manager"},   # 改门店资料/店脑
        Permission.STORE_DELETE: {"owner"},
        Permission.MEMBER_MANAGE: {"owner", "manager"},
    }
    for perm, allowed in expected_holders.items():
        holders = {r for r, ps in ROLE_PERMISSIONS.items() if perm in ps}
        assert holders == allowed, f"{perm} 持有者应为 {allowed}，实为 {holders}"


def test_rbac_list_implies_create():
    """凡有 GENERATION_LIST 的角色必有 GENERATION_CREATE。
    部分写端点历史上用 LIST 权限守护(语义债)，此配对是它们不越权的隐含前提——
    若未来给某角色只给 LIST 不给 CREATE，必须先把那些写端点改回 CREATE。"""
    for role, perms in ROLE_PERMISSIONS.items():
        if Permission.GENERATION_LIST in perms:
            assert Permission.GENERATION_CREATE in perms, f"{role} 有 LIST 却无 CREATE，会让 LIST-守护的写端点失守"


def test_report_submission_feeds_store_brain():
    """日报提交必须把店主手写 note 喂进店脑学习(越用越懂的关键原料)——防被悄悄删回去。"""
    import inspect
    import api.v1.reports as reports
    src = inspect.getsource(reports)
    assert "learn_in_background" in src, "日报提交未把 note 喂店脑(store-brain 学习接线丢失)"


def test_store_update_whitelist_excludes_identity_and_ownership():
    """门店资料更新走字段白名单——不可经此改 owner_id/id 夺取门店归属或篡改身份。"""
    from services.store_service import _UPDATE_ALLOWED_FIELDS
    for forbidden in ("owner_id", "id", "created_at", "updated_at"):
        assert forbidden not in _UPDATE_ALLOWED_FIELDS, f"{forbidden} 不应在门店可更新白名单内"
