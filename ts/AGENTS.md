# AGENTS.md — billiards-ts-harness(ts/)

> 开发规则/铁律的**权威版在 `ts/CLAUDE.md`**(Claude Code 自动加载,内容一致);本文件是 Codex/其它读 AGENTS.md 的工具的入口镜像。当前目标先读 `docs/当前目标与文档口径-2026-07-07.md`;施工矩阵看 `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md`;当前对齐波次看 `docs/plans/内核A线对齐-差异总清单-波次-2026-07-10.md`。

一句话铁律(细节见 CLAUDE.md):
- **迁移口径:CC-Haha 可直接复制/抄/移植/改写,行为对齐唯一标准(owner 2026-07-07 口径)**——`~/Desktop/cc-haha-ref` 许可允许 use/copy/modify/distribute/publish copies;复杂边界先写行为对齐测试,实现可直接移植/改写,结构/命名可贴近,注释从简。
- **Bun ≥ 1.3.13**;后端一律 **`bun test`**(用 Bun 全局,vitest 跑 Node 上跑不了),前端(W11/W12)才 vitest。
- **存储 = 文件式(对齐 cc-haha):JSONL transcript + JSON 元信息,无 SQL 数据库**(原 drizzle+bun:sqlite 是老 Python 域数据计划,已作废)。
- **SSE 必 `server.timeout(req, 0)` + async-generator**(Bun 10s 掐空闲流)。
- **原生 `.node`(sharp/onnxruntime-node/whisper)当 sidecar 文件随包发**,别指望塞进 `bun build --compile`;嵌入用 transformers.js(Node build 走原生 onnxruntime-node)。
- **可用 `node:` API**(child_process/net/fs):sidecar/electron plumbing 要 Node+Bun 双运行时,别改成 Bun 专有 API。
- **产品红线不丢**:审批闸只卡对外/不可逆 · 全本地 · 免登录单用户 · 内置 key 走网关藏 key · 改文件前自动备份可回滚 · **白标绝不暴露底层模型** · 台球是可 @挂载领域包。
- **每批**:先写行为规格/失败测试 → 可直接移植/改写实现 → 过验收门 → 类型检查/相关测试 → 回写当前施工矩阵。
- **跨层契约唯一源**:`ts/shared/contracts` 的 Zod Schema + 推导类型；renderer/sidecar/IPC 不再手写两份。
- **完成硬闸**:根目录运行 `bash scripts/quality_gate.sh`；`server/index.ts`、`chatStore.ts` 不得突破治理基线继续膨胀。
- **两个 E2E 分工**:`bun run e2e:backend` 验 sidecar/ReAct/权限/工具/落盘；`bun run e2e:desktop` 验 Electron/React/preload/IPC/sidecar 用户路径，不互相替代。
