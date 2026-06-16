"""内置 Agent 工具。

P0 先放一个真实的只读 demo 工具证明链路（不依赖 DB，纯函数）；
P1 把现有十几个能力（写文案/海报/日报/约客/诊断/查画像/查今日推荐/读写店脑等）
逐个登记进来。导入本模块即把工具登记进 default_registry。
"""
from core.timezone import business_today
from services.agent.registry import tool

_WEEKDAYS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"]


@tool(
    name="get_current_date",
    description="获取今天的日期（北京时间）和星期几。当需要判断'今天/今晚/本周末/几号/是工作日还是周末'时调用。",
    parameters={"type": "object", "properties": {}},
)
async def get_current_date(args: dict, ctx) -> str:
    d = business_today()
    return f"今天是 {d.isoformat()}（{_WEEKDAYS[d.weekday()]}）"
