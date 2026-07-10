# R1 · rewind 断链修复 + loop 两处接线 · 验证式复核

审核对象:F1(messageId 接线)/ F2(recordCompaction 接线)/ getSessionTurnCheckpointDiff / 集成测试真实性 /
hookAllowBypassesAsk / server/index.test.ts UDS steering firstStepGate。

方法:逐条读源码(loop.ts 全文 1372 行、transcript.ts 全文、fileHistory.ts、Tool.ts、sessionRewindService.ts、
context/compaction.ts、hooks.ts、udsInbox.ts/udsClient.ts)+ 读测试 + 跑测试(loop.test.ts / transcript.test.ts /
sessionRewindService.test.ts / server/index.test.ts 全量跑 4 次 + typecheck)+ 针对声明7 额外写独立探针脚本
(不改任何源文件)实测 UDS half-close 时序 500+300+200 次。

---

## 逐条判定

### 1. loop.ts 预生成 uuid 挂 ctx.messageId,transcript.stamp() 复用 → messageId 恒等 uuid

**CONFIRMED 正确。**
- `src/harness/loop.ts:657-661`:每次进入 tool_calls 分支(每一"批"工具调用,不只每轮一次)都
  `randomUUID()` 生成 `assistantMessageId`,挂在 `messages.push({..., uuid: assistantMessageId})` 上,
  同时 `ctx.messageId = assistantMessageId`。
- `src/memory/transcript.ts:515-519` `stamp()`:`(message as MessageProvenance).uuid ?? randomUUID()` —— 优先复用消息对象上已挂的 uuid。
- 验证"多轮 + 多工具交错":loop.ts 把这行代码放在 `for (const call of step.calls)` **之前**、且每次
  model 产出新一批 tool_calls 都会重新执行(不是只在轮首执行一次),故同一回合内多批工具调用天然拿到互不相同的 uuid,
  各自绑定各自那批的 file-history 记录。`transcript.append()` 的 stampedTail 是顺序 for 循环(见 transcript.ts:361-366),
  parent 链依序正确,不因同一回合多批交错而错位。
- 真机集成测试证实(非假绿):`src/server/services/sessionRewindService.test.ts:273-348` 真跑两轮 `runAgentLoop`
  (每轮各一次 write_file),断言 `records[i].messageId === write{N}Uuid`(uuid 从 transcript 自己读出来,不是手工写死),
  且 `write1Uuid !== write2Uuid`。`src/harness/loop.test.ts:2338-2368`(F1 回归)同款单轮真机验证。均为真实 `Transcript`
  类 + 真实文件系统,不是"传对了就通过"的戏台断言。
- **子代理路径同样成立**:`runAgentLoop` 是子代理(agentTool.ts/taskTools.ts)复用的同一份实现,没有分叉代码路径,
  只要子代理调用时传了 `transcript`(两处都传了:agentTool.ts:512 `transcript: sidechain?.transcript`、
  taskTools.ts:679 `transcript: opts.tasks.transcript(task.id)`),这条 uuid 绑定链路同样生效。
  佐证:`src/agents/agentTool.test.ts` 本轮 diff 把一处原来的 `toEqual` 断言改成 `toMatchObject`
  (注释:"发起工具调用的 assistant 消息额外带 provenance uuid"),说明这条 uuid 挂载逻辑影响面覆盖到了子代理 handoff 消息构造,是同一处代码在起作用,而不是只在主会话路径特判。

### 2. RunAgentLoopOptions.stateRoot 已拷入 ctx.stateRoot —— 但只有主会话路径真正传了它

**部分 CONFIRMED,部分 CONFIRMED gap(实现范围小于声明暗示的"已修好")。**

- 主会话路径(唯一真正暴露 rewind API 的路径):`src/server/index.ts:974` 定义 `stateRoot`,
  同一个变量在 `src/server/index.ts:1074`(`new SessionRewindService(sessions, turns, stateRoot)`)
  和 `src/server/index.ts:1974`(`runAgentLoop({ ..., stateRoot })`)两处都用到 —— **两头对齐,F1 描述的
  "写工作区/读 stateRoot 不对等" 在主会话路径上确认已修复**。另一处审批执行路径 `server/index.ts:2374`
  也正确传了 `stateRoot`。
- **CONFIRMED gap**:`grep -n "stateRoot" src/tasks/taskTools.ts src/agents/agentTool.ts` **零命中**——
  两个子代理/后台任务发起 `runAgentLoop` 的地方(`src/tasks/taskTools.ts:664-693`、
  `src/agents/agentTool.ts:500-524`)都不传 `stateRoot`,且这两个文件的 `Options` 接口本身
  (`BackgroundAgentTaskOptions`/`AgentTaskToolOptions`)都没有这个字段可传——不是"漏传一次"而是整条链路
  没打通。对照同款字段 `toolResultStoreDir` 的处理(`agentTool.ts:496/518` 用
  `sidechain?.toolResultStoreDir ?? ctx.toolResultStoreDir` 从父 ctx 继承下来),`stateRoot` 本可以照抄同一模式
  从父 `ctx.stateRoot`(主会话路径已经会填好)继承下去,但目前没有做。
  **实际后果**:子代理/后台任务里发生的文件写入,其 file-history 落到 `ctx.stateRoot` 为 `undefined` 时的
  回退位置——`<子代理工作区root>/.agent-file-history/`(见 `tools/fileHistory.ts:55-59` `historyRoot()`),
  这正是 stateRoot 机制想避免的"污染用户工作区"场景,依然发生。
  不过这不会让主会话的 rewind/checkpoint 产生**错误结果**:`SessionRewindService.buildBaseCtx`
  (`sessionRewindService.ts:429-431`)固定用主 sessionId 作 `conversationId`,而子代理走独立的
  `agentId`/`stableAgentId` 作自己的 conversationId,两者的 file-history 索引本来就分区隔离
  (`fileHistory.ts:44-48` `safeConversationId`),故子代理这块 file-history 目前本来就不在主会话
  checkpoint 列表的读取范围内——是产品能力缺口(子代理编辑不产生 rewind 能力 + 继续污染工作区),
  不是"这次修复引入了错误结果"的回归。
- 附:`/agent/hello`(demo 路由,server/index.ts:4602 起)和 `hookConfig.ts:371` 的 agent-hook 验证子循环
  也不传 `stateRoot`,但前者是脚本模型 demo、后者根本不传 `transcript`(只读校验用途),不构成 rewind 相关风险。

### 3. maybeCompact / preCompactMessages 引用有效性 + F2 集成测试真实性

**CONFIRMED 正确。**
- 读 `src/context/compaction.ts:117-140` `microcompactReadOnlyToolResults`:只原地改
  `r.content =` (tool_result 块内容字符串),不重建/不重新赋值 `messages` 数组本身。
  `compactPipeline` 成功分支(`compaction.ts:308-321`)构造的是全新数组
  `[summaryMsg, ...postSummaryMessages, ...split.recent]`,不修改也不复用 `input.messages` 这个数组对象。
  故 `loop.ts:446` 捕获的 `preCompactMessages = messages`(赋值前的引用)在 `messages = out.messages`(loop.ts:484)
  重新绑定局部变量之后,依然完整指向压缩前的原始数组 —— **判定成立**。
- `src/harness/loop.test.ts:2370-2408`(F2 回归)是真实集成测试:用真实 `Transcript` 类(非 mock),
  20 条历史消息通过 `contextWindowChars:120` 强制触发压缩,断言 `transcript.loadFullHistory()`
  在压缩后仍能读到被摘要吃掉的 `old-0`/`old-8`,而 `transcript.load()`(裁窗视图)确认读不到——
  两个视图各自的边界都验证了,不是只测一边。不是假绿(没有手工构造 Transcript 双打桩,是真实文件系统读写)。

### 4. getSessionTurnCheckpointDiff 形状对照 cc

**CONFIRMED 形状对齐。**
cc-haha `src/server/services/sessionRewindService.ts:64-71` 的
`SessionTurnCheckpointDiffResult = { target, workDir, path, state: 'ok'|'missing'|'error', diff?, error? }`
与我们 `ts/src/server/services/sessionRewindService.ts:40-47` 的同名类型逐字段一致。核心区别(非缺陷,已知
intentional-delta):cc 额外有 `findTranscriptTurnDiff` 兜底(从 transcript 内嵌结构化 diff 读取,我们没有这条数据源,
因为 checkpoint 数据源本身两边就形状不同,背景审计已定性为 aligned 的 intentional-delta,不重复展开)。
路由:确认没有新增 HTTP 路由(`server/index.ts` 的 `rewindMatch` 正则只有 `turn-checkpoints|rewind` 两个分支,
没有 `diff`),但这是实现者自己在代码注释里明确标注的"本轮只补服务层,HTTP 路由不在本次改动范围"
(`sessionRewindService.ts:281`),不是遗漏。

### 5. 新集成测试是否假绿

**CONFIRMED 不是假绿(重点抽查的"真跑 loop→checkpoint 非空→真恢复文件"那条尤其扎实)。**
见第 1 条列出的两处测试(`sessionRewindService.test.ts:273-348`、`loop.test.ts:2338-2368`)。两者都：
- 用真实 `runAgentLoop` + 真实 `Transcript`(挂到临时目录真文件),不 mock model.step 之外的任何东西;
- messageId 断言的期望值是从 `transcript.loadFullHistoryStamped()` 读回来的真实 uuid(反查 `call.id` 找到对应
  assistant 消息的 uuid),不是测试里手写的字符串;
- `sessionRewindService.test.ts` 那条还继续往下跑 `listTurnCheckpoints` + `executeRewind`,断言执行后
  `note.txt` 磁盘内容真的变回 `v1`——不仅测中间态,测到最终可观察副作用。
- 唯一仍手工塞 `messageId: 'msg-a1'` 的测试(`sessionRewindService.test.ts:44-59` 等,66-271 行区间)是
  **单独测 SessionRewindService 自身聚合/diff 逻辑**的单元测试,不冒充集成测试,且旁边就有前述真集成测试兜底,
  两者分工清楚、不构成假绿。

### 6. hookAllowBypassesAsk 反例验证

**CONFIRMED 正确,且已有等价单测覆盖。**
`src/hooks/hooks.ts:336-344` 实现:
```
if (!hookResult.allowRequested) return false
if (hookResult.askRequested) return false // ask 赢
if (decision.behavior !== 'ask') return false
return decision.reason?.type === 'mode'
```
反例逐条核实(`src/permissions/resolve.ts`):
- forceConfirm → `ask(..., { type: 'forceConfirm' })`(resolve.ts:183)→ reason.type≠'mode' → 不被绕过。
- requiresUserInteraction → `{ type: 'requiresUserInteraction' }`(resolve.ts:184-185)→ 不被绕过。
- 显式 ask 规则 → `{ type: 'rule', rule: askRule }`(resolve.ts:189)→ 不被绕过。
- acceptEdits safetyCheck → `{ type: 'safetyCheck', ... }`(resolve.ts:208)→ 不被绕过。
- hook 同时给 allow 和 ask(`askRequested:true`)→ 函数第二行直接 return false,ask 赢。
- 唯一放行:纯默认档位无规则参与的 ask(`{ type: 'mode', mode }`,resolve.ts:213)。
`src/hooks/hooks.test.ts:127-147` 已把上述全部反例写成断言且当场跑通(`bun test` 通过),与源码判定完全吻合。

### 7. server/index.test.ts UDS steering `firstStepGate` 加固

**PLAUSIBLE → 判定为"缩小竞态窗口的时序型 workaround,不是结构性消除竞态",但代码本身没有变化,只是测试加固,风险仅限于测试自身偶发 flaky,不影响生产代码正确性。**

- 这不是 loop.ts/index.ts 生产代码的改动,是 `src/server/index.test.ts:1061-1113` 纯测试侧的时序加固:
  `fetchImpl` 对第一次模型调用 `await firstStepGate` 阻塞到 `sendToUdsSocket()` 之后 `setTimeout 25ms` 才放行。
- 独立探针实测(不改任何源文件,写在 scratchpad 里跑,500+300+200 次迭代,针对 `udsClient.ts`/`udsInbox.ts`
  的真实 half-close 语义):
  - `await sendToUdsSocket()` **resolve 那一刻,服务端 inbox 尚未写入的概率是 100%(500/500)**——
    即客户端 socket `'close'` 先于服务端 `'end'` 处理器执行 `inbox.push()`,`sendToUdsSocket()` 本身
    **不构成 happens-before 保证**,必须额外等待。
  - 额外 `setTimeout(25ms)` 之后再检查:300/300 都已经写入 inbox——`25ms` 在本机环境下是非常宽裕的安全垫
    (实测服务端从"客户端观测到 close"到"inbox 真正写入"的实际延迟 p50 ≈ 0.017ms、p95 ≈ 0.045ms、
    200 次里最大值 ≈ 0.215ms,`25ms` 相当于约 100~1000 倍安全边际)。
  - **结论**:这确实是"缩小竞态窗口"而非"结构性消除"——没有改成"等一个显式回调/事件通知 inbox 已写入"这种
    确定性同步,而是靠经验值的固定延时。在本机测得的边际极宽(~100x+),日常 CI 下基本不会闪烁,但严格意义上
    在极端负载/GC 停顿场景下仍有理论上的失败可能,不能称为"已彻底消除竞态"。
- 实测运行结果(均在本仓库环境跑,非引用外部数据):`bun test src/server/index.test.ts -t "starts a UDS inbox
  and injects cross-session steering"` 连续 5 次全绿;`bun test src/server/index.test.ts` 全量跑 4 次
  (112 tests),其中第 1 次有 1 个**无关测试**('legacy studio generate overlays uploaded logo and qrcode with
  ffmpeg for print mode',ffmpeg 子进程超时,与 UDS/rewind 改动无关)偶发失败,其余 3 次 + 目标 UDS 测试的全部
  5 次单独重跑均 0 fail。UDS steering 测试本身在本次复核过程中从未失败。

---

## 补充观察(非声明范围,但验证附带发现)

- F1/F2 修复引入的 `ToolContext.messageId` / `ToolContext.stateRoot` 字段(`Tool.ts` diff)与
  `RunAgentLoopOptions.stateRoot`(`loop.ts` diff)在这份 diff 里都是**新增字段**(`git diff` 显示为 `+` 新行),
  而不是背景审计报告 F1 里描述的"字段已声明、只是没接线"。这只是叙事口径上的细节出入(审计报告写作时基于的
  快照可能早于/不同于这份具体 diff),不影响本次复核对当前代码正确性的判定。
- `bun run typecheck` 全量通过(0 error)。

---

## 裁决建议

**合入。** 声明 1、3、4、5、6 均 CONFIRMED 正确,且有真实集成测试兜底(非假绿)。声明 2 在其明确覆盖的范围
(主会话路径)内 CONFIRMED 正确;子代理/后台任务路径的 `stateRoot` 透传缺口是真实存在的产品能力缺口
(建议后续单独任务补上,参照 `toolResultStoreDir` 的继承写法即可,改动量很小),但不构成这次要打回的回归——
它不产生"读到错误 checkpoint"的后果,只是子代理编辑继续污染工作区 + 子代理编辑不可 rewind,双方都是"新功能没有
覆盖到全部调用方"而非"新引入的 bug"。声明 7 的测试加固本身没问题(能跑绿、有巨大安全边际),但如实记录:
它是时序 workaround 不是结构性修复,若要更严谨可考虑给 `startUdsInbox` 加一个"消息已入队"的显式回调供测试
awaited,而非固定 sleep——不阻塞本次合入,留作测试基础设施的后续加固项。
