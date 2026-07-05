# W1 · 原生插件 Bun-下 spike findings(2026-07-06 · macOS arm64 · Bun 1.3.14)

> §2 Phase-0 风险闸:三个原生/运行时依赖 + `bun:sqlite` 在 Bun 下**各真跑一次**。结论:**Bun 1.3.14 能跑我们全部原生依赖**,剩的活集中在 W13 跨平台预编译打包(owner 已放开体积)。复跑:装依赖后 `bun run smoke:native` / `bun run smoke:sqlite`。

## 结果(全绿)
| 依赖 | Bun 下能跑? | 版本 / 实测细节 | 回退 / 决策 |
|---|---|---|---|
| **sharp**(生图·W8) | ✅ | 0.35.3 · libvips 8.18.3 · 8×8 resize→93B PNG | 直接用;`.node` 当 sidecar 文件发 + `asarUnpack` |
| **transformers.js 嵌入**(记忆/RAG·W7) | ✅ | 4.2.0 · `all-MiniLM-L6-v2` `device:"cpu"` → `[1,384]` 向量 | 用它;⚠️见下"重要修正";bge-m3 精确验放 W7 |
| **whisper 绑定**(口播·W9) | ✅ | smart-whisper 0.8.1 · `node-gyp rebuild` 16s 编出 `.node` · Bun 下 `import` 成功(`Whisper`/`WhisperModel`/`TranscribeTask`…) | 绑定可用;但**口播推荐走 whisper.cpp 子进程**更稳(见下) |
| **bun:sqlite**(DB·W5) | ✅ | 内置 · 建表/插/查圆桌通 | 主力;W5 上 drizzle/bun-sqlite;**禁 better-sqlite3**(Bun 下 ABI 断裂) |

## 对开工前研究的两条修正(实测推翻/更新)
1. **transformers.js 在 Bun/Node 下不是走 WASM,是走原生 `onnxruntime-node`。** `@huggingface/transformers` 在 Bun 下加载的是 `transformers.node.mjs`,`device` 只认 `coreml/webgpu/cpu`(WASM 后端只在浏览器 build)。所以它**必带原生 `onnxruntime-node`(1.24.3)的 `.node`**。研究说"onnxruntime-node 在 Bun 下 flaky"——**实测 1.3.14 上 `device:"cpu"` 正常出向量**,flaky 警告对 1.3.14 已过时。
2. **whisper 绑定在 Bun 下实测可编可加载**(研究说"完全未验证")。smart-whisper 的 node-gyp 在本机(有构建工具)16s 编出 `.node` 并被 Bun 成功 import。

## 打包硬约束(记给 W13 / W7 / W8 / W9)
- **native `.node`(sharp / onnxruntime-node / smart-whisper)大概率塞不进 `bun build --compile` 单二进制** → 一律当 **sidecar 文件**随包发 + `asarUnpack`(研究 Q1 定论;W1 的后端二进制本身无原生依赖、已验能编能跑)。
- **onnxruntime-node / whisper 的 `.node` 要各平台预编译**(mac arm64/x64 · win x64 · linux):CI 出 prebuild 打进包;whisper 走 node-gyp,别指望客户机装时现编(要构建工具)。选带 prebuild 的绑定或自建 CI prebuild。
- **口播(whisper)建议架构 = whisper.cpp 子进程**,不在 Bun 进程内跑 N-API 绑定:① 避开 Bun-N-API 长期不确定性;② `.node` 打包不确定;③ whisper.cpp 二进制像 ffmpeg 一样当 bundled asset 发、`spawn` 调用最稳。绑定可用是好消息(留作 W9 备选),但默认走子进程。W9 定夺。
- **sharp 版本去重**:transformers.js 会带自己的 sharp(0.34.5/libvips 8.17.3),与我们的 0.35.3 并存会有 objc duplicate-class 告警(无害)。生产打包时 dedupe sharp 到一份。

## W1 处置
本轮只出结论,不把重依赖留在主 deps。spike 装的 `sharp`/`@huggingface/transformers`(带 onnxruntime-node/protobufjs)/`smart-whisper` **已从 `ts/package.json` 移除**;`smoke/*.ts` 脚本保留(用变量说明符 import,删依赖后仍 typecheck 通),W7/W8/W9 正式挂载时再装、按上面回退决策接。
