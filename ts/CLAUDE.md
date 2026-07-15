# TypeScript/Bun 内核工程规则

> 📌 状态:✅现行 · 最后核对 2026-07-13

## 当前目标

`ts/` 提供桌面产品的共享契约、Agent 内核、本地服务、React renderer、Electron 主进程和验证入口。具体任务按用户指定直接读取相关本地实现，产品边界以根 `CLAUDE.md` 为准。

## 硬规则

1. **行为对齐**：路径、沙箱、命令、权限、消息配对、压缩和 provider 转换等确定性逻辑，用边界测试证明与参考实现一致。
2. **运行时**：使用 Bun 1.3.13 或更高版本；后端测试执行 `bun test`。
3. **存储**：transcript 使用 JSONL，会话索引、任务和元信息使用 JSON。桌面内核不使用 SQL 数据库。
4. **消息**：内核统一使用 content-block；tool use/result 保持严格配对。
5. **SSE**：设置 `server.timeout(req, 0)`，使用 async generator 持续输出。
6. **共享契约**：跨 renderer、sidecar、IPC 的 Schema 放在 `shared/contracts`，由 Zod 推导类型并在边界解析。
7. **运行时兼容**：Electron main 与 Bun sidecar 共用的代码优先使用 `node:` API。
8. **原生模块**：`.node` 依赖和本地模型运行时使用 Node sidecar，不塞进 Bun 单文件可执行程序。
9. **模块边界**：renderer 依赖 feature API/store，route 依赖应用服务，应用服务依赖领域接口；禁止反向依赖和跨模块内部导入。
10. **产品边界**：保持本地单用户、网关藏密钥、运行时白标、文件可恢复和领域知识按会话挂载；领域知识不得改写通用 Agent 权限与任务规划。
11. **质量门**：不得通过提高体积基线掩盖 `server/index.ts`、`chatStore.ts` 或其他巨型文件增长。

## 常用命令

```bash
bun install
bun run typecheck
bun test
bun run build:sidecar
bun run desktop:dev
bun run e2e:backend
cd .. && bash scripts/quality_gate.sh
```

## 文档

架构或部署边界变化时才更新稳定边界文档和工程 Skill。普通模块实现只更新源码与测试，不维护“当前能力清单”或其它代码镜像。
