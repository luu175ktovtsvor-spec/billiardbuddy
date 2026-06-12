"""业务时区单一来源。

用户全部在中国,所有面向用户的"今天/日期"概念(日报日期、节日推荐、配额月度重置)
一律以北京时间计算,不依赖服务器系统时区——服务器在美国,当前系统时区恰好设为
+0800,但重装/迁移后默认 UTC 会让所有日期静默错 8 小时。
"""

from datetime import date, datetime
from zoneinfo import ZoneInfo

BUSINESS_TZ = ZoneInfo("Asia/Shanghai")


def business_now() -> datetime:
    return datetime.now(BUSINESS_TZ)


def business_today() -> date:
    return business_now().date()
