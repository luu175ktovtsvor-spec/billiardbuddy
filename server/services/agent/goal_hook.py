"""/goal 目标驱动 —— 对标 Claude Code 的 /goal：设一个目标，Agent 收尾前对照目标自检，没完成就继续。

v1：注册一个常驻 Stop hook，读 `ctx.goal`；设了目标就在收尾前回灌一句"对照目标自检"，让它再确认/继续
（loop 每轮最多被阻断一次、受 max_turns 兜底 → 不会无限循环）。没设 goal → no-op，零影响。
"""
from services.agent.hooks import register_stop_hook

_GOAL_NUDGE = (
    "【目标检查】本次目标：{goal}。请对照目标自检是否**真正**完成："
    "未完成就继续把它做完；已完成就明确说明「已达成目标」再结束。"
)


async def _goal_stop_hook(messages, ctx) -> dict | None:
    goal = (getattr(ctx, "goal", "") or "").strip()
    if not goal:
        return None
    return {"continue": _GOAL_NUDGE.format(goal=goal)}


_installed = False


def install_goal_hook() -> None:
    global _installed
    if _installed:
        return
    register_stop_hook(_goal_stop_hook)
    _installed = True
