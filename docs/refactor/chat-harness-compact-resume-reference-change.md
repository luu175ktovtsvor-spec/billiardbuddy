# 聊天 Harness compact / resume 参考—改动表

## 施工前证据

| 项目 | 已读证据 | 直接事实 / 推理等级 | BilliardBuddy 当前事实 | 本轮决定 |
|---|---|---|---|---|
| Codex Core | OpenAI Codex `62fd410384cca008446c2d64a4f2b3f915f4906e`，Apache-2.0；`codex-rs/core/src/compact.rs` | 直接源码。compact 作为独立 Turn Item 开始/完成；生成摘要后替换模型历史、重算 token，但保留可恢复的会话记录；手动/回合中 compact 对初始上下文有不同注入边界。 | `ts/src/query.ts` 与 `QueryEngine.ts` 有旧通用自动 compact，但 ProductTask worker 并未把 compact 结果接成 ProductTask 权威快照或 Item/Event。 | 不复制 Codex Rust 实现；采用其“模型上下文替换、权威历史不删除、compact 有 Item 生命周期”的状态合同。 |
| Codex App Server | 同一 commit 的 `codex-rs/app-server/README.md` | 直接协议。`thread/compact/start` 立即接收，随后通过标准 `turn/*`、`item/started`、`item/completed` 流发送唯一 `contextCompaction` Item；resume 可分页读取持久历史。 | Product API 只有通用 lineage `compact_generation + 1`，没有快照、compact Item、执行结果或失败状态；renderer 也无真实 compact 动作。 | compact 必须走 Product Server 命令、持久快照和标准 Item/Event；不能由 renderer 自增 generation。 |
| Codex 本地前端 | `codex-frontend-reference/26.721.41059`；`raw/webview/assets/app-initial-BHB6SClA.js`、`raw/.../local-conversation-thread-Bj5uKwgs.js`、对应 `reverse-readable`、`host-bridge/build/main-DXmJ7M03.js` | 直接分发产物。前端调用 `thread/compact/start`，先注册 pending manual compaction，再把 `contextCompaction` 的 started/completed 映射成“正在压缩上下文 / 上下文已压缩”；自动与手动来源分开。raw 与 reverse 的 thread 文件 SHA-256 均为 `22fcc7387dc015acb57b90b59c72f5d4b3888384bba2e13ec19009c835bda5ad`；host bridge SHA-256 为 `188292515354c5f219b2555d7c08c0f191aa6a3f99565e9aa8256591c18ac090`。 | 当前聊天 UI 只会把旧 Core `compact_boundary/compact_summary` 降成 working 状态，用户看不到可恢复的 compact Item。 | 复用交互原则，不移植 bundle；BilliardBuddy renderer 只消费自己的 ProductTask Item/Event。host bridge 没有承担模型摘要或领域真相，故本项目仍由 Product Server 执行。 |
| Pi | Earendil Works Pi `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`，MIT；`packages/coding-agent/src/core/compaction/compaction.ts`、公开 Compaction 文档 | 直接源码/文档。阈值由 context window 与 reserve 决定；快照保存 `summary`、`firstKeptEntryId`、`tokensBefore`，再次 compact 会读取 previous summary，保留最近上下文。 | `ProductSessionMemoryRepository` 仅保存最多 40 个截断问答并渲染到 40k 字符；没有 first-kept 边界、compact generation 对应快照或累进摘要。 | 采用“持久摘要 + first-kept Item + 最近完整 Item”的最小快照；阈值只来自 provider registry，不另建配置源。 |
| Claude | Claude Managed Agents 公开 Session/Tools 合同；核心 Harness 未公开，不能作为源码复用来源 | 公开合同，只能证明 Session/恢复与工具结果应分离；不能据此推断 compact 内核。 | 当前 worker 的 `session_id` 参数没有用于恢复 QueryEngine 历史，实际恢复依赖私有 `ProductSessionMemory`。 | 不声称复用 Claude compact；恢复以本项目持久快照和 ProductTask Item/Event 为准。 |

## 当前生产调用链与缺口

```text
ProductTask TaskRun
  → nativeCoreFactory
  → createServerPrivateNativeCorePort
  → 从权威 TaskEvent + lineage checkpoint + compact snapshot 重建 session_context
  → provider registry compact_threshold
  → 自动 compact 或 /compact
  → context_compaction started/completed/failed
  → Product Server 原子写 snapshot + Item/Event 后发布

下一 TaskRun
  → snapshot + compact cursor 之后的完整用户/assistant Item
  → 注入下一次模型请求
```

- `ProductTask/TaskRun/Item/Event` 是权威历史；它们目前不会被旧 Query compact 删除，这是可保留部分。
- `ProductSessionMemory` 是模型上下文投影，不是领域真相，但目前会静默丢弃更老回合，且没有对应 compact 快照、边界、状态或失败事件。
- 同一 Turn 通过 steer 消费的后续用户 Item 已持久化到 ProductTask，但完成时只把最初的 `text` 写进 `ProductSessionMemory`，下一 Turn 会丢失 steer 内容。
- 现有 lineage `compact` mutation 只增加数字，既未生成摘要也未改变下一 Turn 上下文；继续暴露它会形成假能力。

## 最小改动合同

1. Product Server 保存 lineage-bound compact snapshot；至少包含 generation、覆盖到的最后 Item/entry、摘要、最近保留 Item 边界、来源、创建时间和输入/输出规模。私有 resume binding 只参与绑定校验，不出现在公共事件。
2. compact 只替换下一次模型请求的上下文投影；ProductTask 的全部用户、assistant、tool、授权与终态 Item/Event 不删除、不改序，历史继续按 cursor 读取。
3. 自动 compact 阈值只读取 provider registry 的 `verified_context_window` 与 `compact_threshold`；配置缺失或摘要失败时显式写失败 Item/Event，不能静默丢旧历史。
4. 手动 compact 作为独立受控命令，仅在没有可写 Turn 时启动；接受回执与执行终态分开，重复 `client_operation_id` 返回同一结果。
5. 当前 Turn 内已消费的 steer/follow-up 用户 Item 必须进入该 Turn 的持久模型记忆；下一 Turn 从 snapshot + 最近完整 Item 重建上下文。
6. stop/cancel 不能提交半成品摘要；崩溃发生在快照原子提交前则保留旧 snapshot，发生在提交后则恢复新 generation。临时摘要输出不得覆盖权威 Item/Event。
7. renderer 展示 `context_compaction` started/completed/failed Item；刷新和重连从 Task event cursor 恢复，不保存第二份 compact 状态。

## 验证要求

- 单元：阈值边界、first-kept 边界、累进 compact、steer Item 进入下一 Turn、摘要失败不丢历史、幂等/CAS。
- 故障注入：快照写入前失败、写入后回执丢失、worker 重启、停止与 compact 竞争。
- 集成：公共 API 不泄露 resume binding/摘要私有输入；Item/Event 在 publish 前持久化；cursor 重连重放 compact 状态。
- 用户旅程：长任务自动 compact 后继续；手动 compact 显示进度；桌面重开后历史完整且模型能继续最近工作。

## 施工状态

- 权威文件升级到 rev6，新增 lineage-bound `context_snapshots`；摘要、token 规模和覆盖 cursor 保持 server-private，公共事件只公开 compact Item 的 id、来源、generation 与阶段。
- 每个新 TaskRun 在 `core_binding.context_event_sequence` 冻结本轮用户输入之前的上下文边界；旧运行从第一条 durable user Item 反推边界。
- `readTaskRunDispatchIdentity` 现在从 lineage checkpoint、权威用户/assistant Item、最近 snapshot 重建 `session_context`；同 Turn 已消费的 steer Item 会自然进入下一 Turn。生产 Core 不再读取或写入 `ProductSessionMemory`。
- `createServerPrivateNativeCorePort` 从 provider registry 读取唯一 compact 阈值；超过阈值时先分块压缩，成功后再执行正常 Turn。`/compact` 走同一真实链路并作为手动来源；空历史显式返回“当前没有可压缩的上下文”。
- `ProductTaskWorkerMessageSink` 在发布前调用 `recordTaskRunContextCompaction`；completed 在同一 authority transaction 内更新 snapshot、lineage generation 和 durable Item/Event，failed 不替换旧 snapshot。
- WebSocket cursor 重放和桌面严格解析器已支持 `context_compaction`；右侧“运行检查器”统一展示 activity、compact、待处理输入、授权卡和停止入口，在等待授权、存在队列或正在 compact 时自动打开，不接收摘要或 Core 私有字段。
- 删除了只自增 `compact_generation` 的 HTTP lineage 假能力；手动 compact 统一走聊天 `/compact` Turn。
- 针对性验证已通过：原生 Core 自动/手动 compact、分支 checkpoint 重建、compact 后 resume、摘要不进入公共事件、durable-before-publish、桌面协议与状态归并。完整 server/desktop gate 仍需在本轮其余合同项完成后统一执行。
