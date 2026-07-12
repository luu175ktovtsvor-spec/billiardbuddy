---
name: change-shared-contract
description: Change shared REST, SSE, WebSocket, Electron IPC, event, error, or persistence-boundary contracts without leaving frontend/backend drift. Use when paths, request or response fields, event variants, status codes, IPC payloads, timestamps, enums, or compatibility behavior change.
---

# 共享契约变更

把契约当成独立交付物，不把前后端手工同步当作长期方案。

## 执行流程

1. 列出生产者、所有消费者、传输方式和当前契约文件。
2. 明确兼容策略：新增可选字段、双读单写、旧值适配、版本端点，或同包原子替换。
3. 优先建立单一契约源。桌面跨层契约放 `ts/shared/contracts`；新契约使用 Zod Schema，并由 Schema 推导 TypeScript 类型，禁止新增手写镜像。
4. 在边界运行时解析：后端解析请求，前端 API/WS 入口解析响应。不要用 `as T` 把未知 JSON 当成可信类型；共享 Schema 的合法、非法和兼容样例必须进入测试。
5. 同一次修改完成生产者、消费者、错误/加载状态和契约测试。
6. 删除旧契约前先确认所有消费者和已发布客户端已迁移。

## 各类连接

- WS/SSE：检查事件信封、序号、时间格式、重连回放、`done`/错误收尾和会话上下文完整性。
- REST：检查路径、method、请求/响应 Schema、错误 envelope、空响应和超时。
- Electron IPC：同步 `main.ts` handler、`preload.ts` 白名单和 renderer `desktopHost.ts` 类型；校验 payload。
- 只读数据面：在 store/API 入口归一化 ISO 时间、缺省字段和数组/对象形状，不让原始 JSON 进入组件。
- 持久化：保留旧 JSON/JSONL 可读性，必要时加幂等迁移。

## 兼容边界

- renderer 与 sidecar 随同一安装包：允许同次原子升级，但仍必须共享类型和契约测试。
- gateway/relay/dataeye：默认存在旧客户端；先发布兼容服务器，再发布客户端，最后清理旧协议。

## 验证

至少覆盖一个合法输入、一个非法输入、一个旧格式输入和完整生产者到消费者路径。字段改名不得只靠 typecheck。
