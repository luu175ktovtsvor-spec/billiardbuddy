---
name: analyze-change-impact
description: Analyze a requested change or bug before implementation by tracing producers, transports, consumers, state, persistence, tests, and deployment boundaries. Use when ownership is unclear, a change may affect frontend and backend, a bug crosses layers, or the safe edit scope is uncertain.
---

# 改动影响分析

只做证据驱动的定位；用户仅要求分析或诊断时不要实施修复。

## 分析流程

1. 读取适用的 `AGENTS.md`、`CLAUDE.md` 和当前架构文档。
2. 从用户可观察入口反向搜索：按钮/命令/路由/事件/错误文本/状态字段。
3. 画出链路：`入口 -> 前端状态/API -> HTTP|WS|IPC -> route -> service/domain -> adapter/store -> 返回消费者`。
4. 搜索所有同名字段、事件、路由和类型；同时找测试、迁移、文档和部署配置。
5. 区分真实依赖与文字巧合；读取调用点，不以搜索命中数量代替判断。
6. 判定主责模块和改动类别，套用总路由的 `references/change-brief.md`。

## 必查问题

- 谁生产、谁消费？是否存在第二消费者或兼容接口？
- 类型是共享源还是手写镜像？运行时是否校验？
- 状态的真相源在后端、前端 store、localStorage 还是远程服务？
- 失败、加载、中断、重连、旧数据和缺省字段如何表现？
- Electron IPC 是否同时涉及 main、preload、desktopHost？
- 远程接口是否有旧版桌面客户端仍在使用？

## 输出

给出改动类别、主责模块、完整链路、契约位置、预计修改文件、明确不改范围、验证项和风险。若证据不足，明确列出缺失证据，不猜测。
