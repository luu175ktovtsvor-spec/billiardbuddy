# Agent 决策测试报告 — batch-diag-check

- 用例总数：**2**
- 🟢 GREEN：**1**　🟡 YELLOW：**0**　🔴 RED：**1**　⚠️ ERROR：0
- **GREEN 率（占有效判定 2）：50.0%**

## 分类别
| 类别 | 🟢 | 🟡 | 🔴 | ⚠️ |
|---|---|---|---|---|
| local_ops | 0 | 0 | 1 | 0 |
| tool_selection | 1 | 0 | 0 | 0 |

## 🔴 RED 明细（决策错误，优先修）
- **[LOCAL-11]** 照选定报表做POS真诊断（读真实数字，非口述诊断）（local_ops）：漏调应调工具: diagnose_from_pos
    - 老板说：「照我选的这份报表，基于里面的真实数字帮我诊断一下经营」　执行=['list_files'] 提审批=[] turns=2

## 🟡 YELLOW 明细（轻微偏离/浪费）

## ⚠️ ERROR

## 全部明细
- [AG-SEL-14] GREEN 批量写一周朋友圈（该走 write_batch，不是一条条 write）：执行=['write_batch'] 提审批=[] turns=2
- [LOCAL-11] RED 照选定报表做POS真诊断（读真实数字，非口述诊断）：执行=['list_files'] 提审批=[] turns=2