# AGENTS.md — billiards-ts-harness(ts/)

> 开发规则/铁律的**权威版在 `ts/CLAUDE.md`**(Claude Code 自动加载,内容一致);本文件是 Codex/其它读 AGENTS.md 的工具的入口镜像。上级 spec:`docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`;逐窗计划 `docs/plans/TS-W*-…`。

一句话铁律(细节见 CLAUDE.md):
- **抄码口径:效果对齐唯一标准(owner 2026-07-06 松绑)**——能重写就重写、易漏边界的直接照搬进我们文件都行,用「行为对齐」(同输入同输出)证明;别把它整个 .ts 原样当产品发。结构/命名/写法对齐它,注释从简。
- **Bun ≥ 1.3.13**;后端一律 **`bun test`**(用 Bun 全局,vitest 跑 Node 上跑不了),前端(W11/W12)才 vitest。
- **DB = drizzle + `bun:sqlite`**;禁 better-sqlite3(Bun 下 ABI 断裂)。
- **SSE 必 `server.timeout(req, 0)` + async-generator**(Bun 10s 掐空闲流)。
- **原生 `.node`(sharp/onnxruntime-node/whisper)当 sidecar 文件随包发**,别指望塞进 `bun build --compile`;嵌入用 transformers.js(Node build 走原生 onnxruntime-node,见 `ts/docs/W1-native-plugin-findings.md`)。
- **可用 `node:` API**(child_process/net/fs):sidecar/electron plumbing 要 Node+Bun 双运行时,别改成 Bun 专有 API。
- **产品红线不丢**:审批闸只卡对外/不可逆 · 全本地 · 免登录单用户 · 内置 key 走网关藏 key · 改文件前自动备份可回滚 · **白标绝不暴露底层模型** · 台球是可 @挂载领域包。
- **每窗**:writing-plans → 先测后码 → 过验收门 → verification-before-completion。
