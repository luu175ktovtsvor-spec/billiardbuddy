# W4c · 上下文韧性 findings（2026-07-06 · macOS arm64 · Bun 1.3.14）

> 压缩 / 轨迹 JSONL / 打转检测的 TS harness 地基已落地到 `ts-harness-rewrite` 分支。全量 `bun test` = **205 pass / 0 fail / 410 expect**；`bun run typecheck` clean。

## 建了什么

| 层 | 文件 | 职责 |
|---|---|---|
| 压缩 | `src/context/compaction.ts` | 只读工具结果 microcompact、切分 old/recent 时保护 tool_use/tool_result 配对、超阈值/强制 autocompact、context overflow 识别 |
| 轨迹 | `src/memory/transcript.ts` | `{root}/transcripts/{conversationId}.jsonl` 原始 Anthropic Message 逐行保存、坏行跳过、conversationId 路径护栏、`savePreservingExternalTail` 保留 mid-turn 外部追加尾巴 |
| 打转 | `src/harness/stuckDetector.ts` | 稳定 `tool|args` key、连续重复/连续错误/只说不做/40 次工具未进展软推、同参第 5 次硬拦文案 |
| 接线 | `src/harness/loop.ts` | `initialMessages`/`transcript`/`contextWindowChars` 可选入口；每轮顶部压缩；模型 context overflow 强制压缩后重试一次；收尾保存 transcript；同一工具同参连续第 5 次拒执行；软推走 `context_note` + `<system-reminder>` |
| 测试 | `src/context/compaction.test.ts`、`src/memory/transcript.test.ts`、`src/harness/stuckDetector.test.ts`、`src/harness/loop.test.ts` | 15 条新增/扩展用例，覆盖压缩、溢出、轨迹、打转、loop 回归 |

## 关键决策

1. **默认不改变现有 loop 行为**：`contextWindowChars` 不传时不会主动 autocompact；只保留 microcompact 能力给后续显式开启。旧 W4a/W4b 测试事件顺序保持。
2. **内核格式保持 Anthropic content-block**：transcript 保存的是 `Message` 原样 JSONL，没有 OpenAI `role:'tool'` 形态。
3. **autocompact 用同一个 `Model` 接口**：摘要调用 `tools: []`，失败只增加失败计数，不崩当前任务。连续失败熔断常量已在 `compaction.ts`。
4. **context overflow 是反应式兜底**：`model.step` 抛出常见 overflow 码/文案时，loop 强制 compact 一次并重试一次；无法切分时继续抛出原错误。
5. **重复调用硬拦在执行前**：同一 `tool|args` 连续第 5 次不再执行工具，而是回灌普通 `tool_result`，让模型换策略。
6. **transcript 写入全故障安全**：load/save 失败不拖垮任务；保存时用 baseline 行数保留外部追加尾巴，对齐 Python F-10 竞态修复思路。

## 明确没做

- **大工具结果落盘 / artifact store**：本窗只压旧只读工具结果的一行占位，还没有把超大结果写文件再回传引用。交 W7/W14。
- **9 节 cc-haha 结构化摘要 prompt**：本窗先用短摘要 prompt 打通机制；W7 可替换为更完整的结构化摘要模板。
- **真实 token 计量 / prompt-cache hit/miss**：当前用字符估算，真实 usage 和 cache 标记归 W10 模型出口。
- **HTTP 会话恢复与 transcript 装配**：loop 接口已支持 `transcript`/`initialMessages`，服务器路由尚未落地。交 W5/server。
- **W4d/W4e**：skills/slash/output-styles/plugins/hooks/goal/subagents 未做。

## 复跑

```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH"
bun test
bun run typecheck
```
