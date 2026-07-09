# billiards-ts-harness · 工程规则（ts/ 目录 · TS/Bun 内核）

> **权威入口**:上级 `docs/当前目标与文档口径-2026-07-07.md` + `docs/plans/TS-cc-haha-v0.4.5-内核迁移矩阵-2026-07-07.md` + `docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`。当前直接在 `main` 上施工;旧 `ts-harness-rewrite` 等分支名只代表历史阶段。本目录目标是把 coding-agent 内核能力做强;CC-Haha 已有许可,可直接复制/抄/移植/改写其可靠机制,并用本仓库测试兜住边界。

## 铁律(违反即破坏产品)
1. **迁移口径:CC-Haha 可直接复制/抄/移植/改写,效果对齐是唯一硬标准(owner 2026-07-07 更新)**:cc-haha 的**内核行为、架构边界、边界测试全量覆盖**；`~/Desktop/cc-haha-ref/LICENSE` 已允许 use/copy/modify/distribute/publish copies,所以可直接复制/抄/移植/改写实现。别为「看起来原创」而牺牲边界质量；复杂逻辑必须先写行为对齐测试，再实现到同输入→同决策。⚠️**行为对齐(唯一验收硬闸 · 全 harness 窗通用)**:路径校验/沙箱/危险命令/proxy 转换等确定性逻辑，验收拿刁钻边界(`../escape`、`\\server\share`、`~root/.ssh`、`rm -rf *` 等)断言判得跟 cc-haha 一模一样,别只测自己想到的用例。
2. **每个 harness 窗先确认行为再写计划**:可从 `~/Desktop/cc-haha-ref` 找对应能力(query/proxy/tools/permissions/skills/hooks/context/desktop plumbing 等),源码/测试/结构都可直接参考和移植。开发文档管路线和产品边界,参考实现用于吃透内核细节并减少重复造轮子。
3. **Bun ≥ 1.3.13**(1.3.12 有 macOS `--compile` 坏签名回归;最新 1.3.14)。
4. **测试**:后端一律 **`bun test`**(用 `Bun.serve`/`bun:sqlite`/`Bun.build` 等 Bun 全局,只能在 Bun 运行时跑;vitest 跑 Node 上跑不了)。前端(W11/W12)才用 vitest。
5. **存储 = 文件式(对齐 cc-haha,无 SQL 数据库)**:会话/transcript 存 `.jsonl`(`<stateRoot>/transcripts/<id>.jsonl`)、索引/任务/元信息存 `.json`(`sessions.json`/`tasks.json`/`*.meta.json`/`task-events`)。cc-haha 本地 coding agent 就是 JSONL transcript + JSON 元信息、不用数据库,我们对齐。~~原"drizzle+bun:sqlite/W5 建表"是老 Python 台球域数据的计划,server/ 已删、内核不用 SQLite,该口径作废。~~
6. **SSE**:必 `server.timeout(req, 0)` 关掉 Bun 10s 空闲掐断 + 用 **async-generator** 流体(每 yield 即 flush,别用 ReadableStream)。
7. **产品红线不因换语言丢**:审批闸只卡对外/不可逆动作 · 全本地 · 免登录单用户 · 内置 key 走网关藏 key · 改文件前自动备份可回滚 · **白标绝不暴露底层模型** · 台球是可 @挂载领域包不是产品边界。
8. **原生插件**:`.node`(sharp/onnx/whisper)大概率**塞不进 `bun build --compile` 单二进制**,当 sidecar 文件随包发;嵌入走 `transformers.js`——⚠️**服务端就是原生 `onnxruntime-node`(不是 WASM,HF 官方证实)**,且在 **Bun+Windows 会段错误**(bun#28008),**放 Node 子进程 sidecar 跑、别在 Bun 进程内**(见主文档 §0.6-2)。
9. **注释从简、责任边界对齐 cc-haha**(主文档 §9)。

## 对上面 Bun 默认建议的**本工程校正**(别被通用建议带偏)
- ✅ **可以用 `node:` API**(`node:child_process`/`node:net`/`node:fs`):sidecar/electron plumbing 要在 **Node(electron 主进程)+ Bun(后端)双运行时**都能跑,故用 `node:` 前缀而非 Bun 专有 API——这是**有意为之**,别改成 `Bun.file`/`Bun.$`。
- ~~Postgres/drizzle 两端~~ 作废:内核纯文件式存储(JSONL/JSON),不接 SQL 数据库(对齐 cc-haha)。
- ✅ **`ws` 按需可用**(cc-haha 也用);内置 `WebSocket` 客户端够用时优先内置。

## 常用命令(cwd = `ts/`)
```bash
bun install
bun run typecheck      # tsc --noEmit
bun test               # 全量(发现 ts/**/*.test.ts)
bun run build:sidecar  # bun build --compile 出本机 sidecar 二进制
bun run desktop:dev    # 最小 Electron 壳拉起 sidecar(需先 build:sidecar)
```
