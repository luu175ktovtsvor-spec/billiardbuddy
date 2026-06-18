# Agent 决策测试报告 — datefix-verify

- 用例总数：**4**
- 🟢 GREEN：**4**　🟡 YELLOW：**0**　🔴 RED：**0**　⚠️ ERROR：0
- **GREEN 率（占有效判定 4）：100.0%**

## 分类别
| 类别 | 🟢 | 🟡 | 🔴 | ⚠️ |
|---|---|---|---|---|
| advice | 1 | 0 | 0 | 0 |
| orchestration | 1 | 0 | 0 | 0 |
| tool_selection | 2 | 0 | 0 | 0 |

## 🔴 RED 明细（决策错误，优先修）

## 🟡 YELLOW 明细（轻微偏离/浪费）

## ⚠️ ERROR

## 全部明细
- [AG-SEL-01] GREEN 写朋友圈：执行=['write_operation_content'] 提审批=[] turns=2
- [AG-SEL-05] GREEN 发抖音：执行=['make_platform_content'] 提审批=[] turns=2
- [AG-ADV-01] GREEN 开口问该干啥：执行=['get_today_recommendation'] 提审批=[] turns=2
- [AG-ORC-01] GREEN 周末活动一条龙(含海报)：执行=['write_operation_content'] 提审批=['make_poster'] turns=2