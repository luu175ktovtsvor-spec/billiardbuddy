# AGENTS.md · `ts/` 工程规则

`ts/CLAUDE.md` 是本目录的详细规则；根 `AGENTS.md` 和 `CLAUDE.md` 同时适用。

- coding-agent 内核以 `~/Desktop/cc-haha-ref` 为重要行为参考，复杂边界先写对齐测试。
- 使用 Bun 1.3.13 或更高版本；后端测试统一执行 `bun test`。
- 会话、任务和元信息使用 JSONL/JSON 文件存储，不引入 SQL 数据库。
- SSE 使用 `server.timeout(req, 0)` 和 async generator。
- Electron 与 Bun 共用的 plumbing 可以使用 `node:` API。
- 原生 `.node` 模块和模型运行时通过 Node sidecar 交付。
- 跨 renderer、sidecar、IPC 的契约放 `ts/shared/contracts`，由 Zod 推导类型并在边界解析。
- 产品保持本地单用户、网关藏密钥、运行时白标、文件可回滚和领域包可挂载。
- `server/index.ts`、`chatStore.ts` 不得突破质量门中的体积基线。
- 后端真实链路使用 `bun run e2e:backend`；桌面用户路径使用 Computer Use 和自然语言任务做真机验收。
- 完成、提交或发布前从仓库根运行 `bash scripts/quality_gate.sh`。
- 文档只写当前实现和当前规则，不记录迁移过程或阶段性结论。
