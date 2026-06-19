"""SH-8 连续拒绝计数的跨请求存放（按 conversation_id）。

为什么要它：审批是 proposal 模式，「提请确认」发生在 /agent/chat 的循环里，「老板拒绝」由前端调
/agent/reject 上报、「老板确认」走 /agent/execute——三者是【各自独立的 HTTP 请求】，每次都新建一个
AgentContext。要让「同一动作连续拒 N 次就别再提」跨这几次请求生效，拒绝计数必须存在 ctx 之外、
按会话留存。

桌面版是【单用户、单本地进程】，故用一个进程内 dict 按 conversation_id 存最省事也够用——
不落库（重启清零＝重新观察老板态度，可接受）、不跨进程（本地就一个后端）。云端 web 多租户场景
本机制不触发（审批续接同样按会话，但 web 不注册文件工具、对外动作少），key 仍按 conversation 隔离、
互不串。带容量上限防长期泄漏。全模块故障安全：任何异常吞掉、退化成"没有历史拒绝"，绝不拖垮审批。
"""
import logging

logger = logging.getLogger(__name__)

# conversation_id -> {"by_action": {action_key: 连续拒绝次数}, "total": 全局累计拒绝次数}
_STORE: dict[str, dict] = {}
# 进程内最多存这么多会话的拒绝状态（超出淘汰最旧，防长期运行内存泄漏）。
_MAX_CONVERSATIONS = 500


def _bucket(conversation_id: str | None) -> dict | None:
    if not conversation_id:
        return None
    b = _STORE.get(conversation_id)
    if b is None:
        if len(_STORE) >= _MAX_CONVERSATIONS:
            try:
                _STORE.pop(next(iter(_STORE)))  # 淘汰最旧一个（dict 插入序）
            except StopIteration:
                pass
        b = {"by_action": {}, "total": 0}
        _STORE[conversation_id] = b
    return b


def load_into_ctx(ctx, conversation_id: str | None) -> None:
    """把某会话已累积的拒绝计数注入 ctx，供 loop 的 _denial_fallback 判定。故障安全。"""
    try:
        b = _STORE.get(conversation_id) if conversation_id else None
        if b:
            ctx.denials_by_action = dict(b["by_action"])
            ctx.denials_total = b.get("total", 0)
    except Exception:
        logger.warning("拒绝计数注入失败，按无历史拒绝继续", exc_info=True)


def record_denial(conversation_id: str | None, action_key: str) -> None:
    """记一次老板拒绝某动作：该动作连续拒绝 +1、全局累计 +1。故障安全。"""
    try:
        b = _bucket(conversation_id)
        if b is None:
            return
        b["by_action"][action_key] = b["by_action"].get(action_key, 0) + 1
        b["total"] = b.get("total", 0) + 1
    except Exception:
        logger.warning("拒绝计数记录失败", exc_info=True)


def clear_denial(conversation_id: str | None, action_key: str) -> None:
    """老板成功确认执行某动作 → 该动作连续拒绝计数清零，全局累计也归零（他在正常配合、不是"什么都拒"，
    解除全局回退锁——否则一场长会话零散攒够 N 次后审批会被永久吞掉、再也弹不出卡）。故障安全。"""
    try:
        b = _STORE.get(conversation_id) if conversation_id else None
        if b:
            b["by_action"].pop(action_key, None)
            b["total"] = 0
    except Exception:
        logger.warning("拒绝计数清零失败", exc_info=True)
