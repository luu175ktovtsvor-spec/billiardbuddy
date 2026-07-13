---
name: verify-backend-e2e
description: Verify the real Bun sidecar end to end with deterministic scripted model responses, HTTP and SSE transport, ReAct tool execution, approvals, file effects, JSONL transcripts, packs, and session isolation. Use for Agent loop, permission, tool, event, persistence, or backend cross-module changes that need more evidence than unit and route tests.
---

# 后端端到端验证

直接在 Bun 测试进程启动真实 `startServer`，经过真实 HTTP/SSE、Agent 循环、权限、工具和文件式存储。只把外部模型替换成确定性的脚本响应，避免网络、费用和模型随机性污染回归。

## 为什么采用这套方案

- 后端依赖 Bun runtime，使用 `bun:test` 与生产运行时一致；不使用 Node/Vitest 代跑。
- 每个用例使用随机端口、临时 state/workspace、假 MCP 配置和假模型出口，测试之间不共享用户数据。
- 脚本模型只控制“模型决定调用什么”，其余 route、ReAct、审批、工具、事件和落盘全部是真实现。

## 默认覆盖

1. `write_file`：tool_call/final 事件、真实文件副作用和 transcript 记录。
2. `billiards` 领域包：系统上下文注入和白标输出。
3. 视频共享 Brief：Agent `plan_video` 与工作台编译器产生同源 Brief，不注入不存在的业务事实。
4. 双会话：不同工作目录、default/bypass 权限、审批前后副作用和会话隔离。

## 运行

```bash
cd ts
bun run e2e:backend
```

该文件命名为 `backend.e2e.test.ts`，因此 `bun test` 和统一质量门也会自动发现。失败由 Bun 标准报告定位，不再维护第二套自写 manifest/退出码。

## 新增测试

在 `ts/e2e/backend/backend.e2e.test.ts` 增加稳定检查点。每项同时断言事件/响应、持久化证据和适用的真实副作用；用 `finally` 停 server、清临时目录。真模型只做手动 live smoke，必须显式开启并报告实际出口、费用和不确定性，不得混进普通 CI。
