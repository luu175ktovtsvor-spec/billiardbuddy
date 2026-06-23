# -*- coding: utf-8 -*-
"""安全边界护栏(纯逻辑·无DB)。

锁住几条"以后别的会话容易悄悄改坏、又没人发现"的安全不变量——谁碰谁红：
- 店脑写端点的注入校验（RBAC 多角色权限是 SaaS 团队功能，桌面单用户已删）
- 门店更新字段白名单不含归属/身份字段(防经"改资料"夺店)
"""
import inspect


def test_store_memory_writes_check_injection():
    """店脑记忆会注入该店所有后续生成的 prompt → 写端点必须有注入校验。"""
    import api.v1.store_memory as sm
    src = inspect.getsource(sm)
    assert "check_input_injection" in src, "店脑写端点缺注入校验"


def test_run_generation_logs_usage_events():
    """统一管道必须给生成打使用事件(成功+失败)，喂版本迭代——防被悄悄删回去。"""
    import inspect
    import services.content_service as cs
    src = inspect.getsource(cs)
    assert "_safe_log_generation" in src, "run_generation 丢了使用事件打点(产品迭代数据采集)"
    assert 'outcome="failure"' in src and 'outcome="success"' in src, "使用事件须同时记成功与失败"


def test_store_update_whitelist_excludes_identity_and_ownership():
    """门店资料更新走字段白名单——不可经此改 owner_id/id 夺取门店归属或篡改身份。"""
    from services.store_service import _UPDATE_ALLOWED_FIELDS
    for forbidden in ("owner_id", "id", "created_at", "updated_at"):
        assert forbidden not in _UPDATE_ALLOWED_FIELDS, f"{forbidden} 不应在门店可更新白名单内"
