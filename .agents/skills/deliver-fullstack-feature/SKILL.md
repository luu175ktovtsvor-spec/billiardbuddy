---
name: deliver-fullstack-feature
description: Deliver one user-visible vertical feature across contract, backend, frontend, persistence, and verification without leaving half-connected work. Use when a new workflow needs both UI and backend capability, a button needs a real implementation, or acceptance depends on an end-to-end path.
---

# 全栈功能交付

以用户可完成的一件事为切片，不以“先做前端、以后再接后端”为切片。

## 执行顺序

1. 写清验收行为、主责功能域和非目标。
2. 选择连接模式：A 线 WS、B 线 REST/job、Electron IPC、只读数据面或纯前端。
3. 先定义共享契约、错误语义、进度/取消状态和兼容策略。
4. 实现后端最小纵向路径：route -> service/domain -> adapter/store。
5. 实现前端最小纵向路径：feature api -> store/reducer -> components/page。
6. 覆盖成功、失败、空数据、处理中、重试/取消以及重启恢复等适用状态。
7. 用契约测试、后端测试、前端状态测试和真实用户路径共同验收。

## 完整性硬闸

- UI 不得使用 mock 数据冒充能力完成。
- 后端新增能力必须有可发现的真实消费入口，除非需求明确只建底座。
- 慢任务不得占用跨境或本地 HTTP 长连接；使用 job submit/poll。
- 涉及工作目录、权限档、领域包、会话 id 时，前后端都要保留完整上下文并由后端兜底校验。
- 一个任务只选一个主责模块；共享代码只承载真正跨域的稳定概念。
