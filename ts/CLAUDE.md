# billiards-ts-harness · 新工程规则（ts/ 目录 · TS/Bun 重写）

> **权威入口**:上级 `docs/plans/TS-harness-重构-主开发文档-2026-07-05.md`(主 spec)+ 各窗实现计划 `docs/plans/TS-W*-…`。本目录是「换 TS/Bun、照 cc-haha 重写整个后端、替代 Python」的成品树;施工按主文档 §4.5 一窗一模块走 Superpowers(writing-plans → 先测后码 → 过验收门)。

## 铁律(违反即破坏产品)
1. **抄码口径:效果对齐是唯一硬标准(owner 2026-07-06 松绑 · 别再为此停下问)**:cc-haha 的逻辑——**能顺手重写就重写、重写易漏边界的复杂逻辑直接照搬(逐字复制)进我们自己的文件——都行,功能性代码随便抄**。别为「重写」而重写、翻译时引 bug。唯一保留(省麻烦、非法律约束):放进我们自己的文件、别把它整个 `.ts` 原样当产品发。例外:`@anthropic-ai/sandbox-runtime` 是公开 npm 包可直接装(W3)。⚠️**行为对齐(唯一验收硬闸 · 全 harness 窗通用)**:不管搬还是重写,照 cc-haha 写的确定性逻辑(路径校验/沙箱/危险命令/proxy 转换)必须「同输入→同决策」,验收拿刁钻边界(`../escape`、`\\server\share`、`~root/.ssh`、`rm -rf *` 等)断言判得跟 cc-haha 一模一样,别只测自己想到的用例。
2. **Bun ≥ 1.3.13**(1.3.12 有 macOS `--compile` 坏签名回归;最新 1.3.14)。
3. **测试**:后端一律 **`bun test`**(用 `Bun.serve`/`bun:sqlite`/`Bun.build` 等 Bun 全局,只能在 Bun 运行时跑;vitest 跑 Node 上跑不了)。前端(W11/W12)才用 vitest。
4. **DB**:**drizzle ORM on `bun:sqlite`**(本地)+ drizzle-postgres(服务端);**禁 `better-sqlite3`**(Bun 下 ABI 断裂)。W5 建表。
5. **SSE**:必 `server.timeout(req, 0)` 关掉 Bun 10s 空闲掐断 + 用 **async-generator** 流体(每 yield 即 flush,别用 ReadableStream)。
6. **产品红线不因换语言丢**:审批闸只卡对外/不可逆动作 · 全本地 · 免登录单用户 · 内置 key 走网关藏 key · 改文件前自动备份可回滚 · **白标绝不暴露底层模型** · 台球是可 @挂载领域包不是产品边界。
7. **原生插件**:`.node`(sharp/onnx/whisper)大概率**塞不进 `bun build --compile` 单二进制**,当 sidecar 文件随包发;嵌入走 `transformers.js` WASM,不引原生 `onnxruntime-node`。
8. **注释从简、结构照 cc-haha**(主文档 §9)。

## 对上面 Bun 默认建议的**本工程校正**(别被通用建议带偏)
- ✅ **可以用 `node:` API**(`node:child_process`/`node:net`/`node:fs`):sidecar/electron plumbing 要在 **Node(electron 主进程)+ Bun(后端)双运行时**都能跑,故用 `node:` 前缀而非 Bun 专有 API——这是**有意为之**,别改成 `Bun.file`/`Bun.$`。
- ✅ **Postgres 走 drizzle-postgres**,不是 `Bun.sql`——我们要按方言(SQLite/PG)分支,drizzle 统一两端。
- ✅ **`ws` 按需可用**(cc-haha 也用);内置 `WebSocket` 客户端够用时优先内置。

## 常用命令(cwd = `ts/`)
```bash
bun install
bun run typecheck      # tsc --noEmit
bun test               # 全量(发现 ts/**/*.test.ts)
bun run build:sidecar  # bun build --compile 出本机 sidecar 二进制
bun run desktop:dev    # 最小 Electron 壳拉起 sidecar(需先 build:sidecar)
```
